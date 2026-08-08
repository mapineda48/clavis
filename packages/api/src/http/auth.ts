import type { PermissionKey } from '@clavis/shared'
import type { Request, RequestHandler } from 'express'
import { type JWTPayload, createRemoteJWKSet, jwtVerify } from 'jose'
import type { AppConfig } from '../config/env.js'
import type { Cache } from '../infra/cache.js'
import type { Db } from '../infra/db.js'
import type { Logger } from '../infra/logger.js'
import {
  ACCESS_NAMESPACE,
  type AccessContext,
  accessCacheKey,
  contextHasPermission,
  loadAccessContext,
} from '../lib/access.js'
import type { RequestContext } from '../lib/context.js'
import { forbidden, unauthorized } from '../lib/errors.js'

/** The slice of the configuration the middleware reads. */
export type AuthOptions = Pick<
  AppConfig,
  'KEYCLOAK_ISSUER' | 'KEYCLOAK_INTERNAL_ISSUER' | 'KEYCLOAK_AUDIENCE' | 'CACHE_TTL_SECONDS'
>

/** What the middleware needs from the infrastructure. */
export interface AuthDeps {
  db: Pick<Db, 'query'>
  cache: Pick<Cache, 'get' | 'set' | 'version'>
  log: Logger
}

/**
 * Identity carried by the verified token. Authorization does NOT live here:
 * Keycloak proves who the caller is, the database decides what they may do
 * (see `lib/access.ts`).
 */
export interface AuthContext {
  sub: string
  username: string
  email: string | null
  name: string | null
  token: string
}

/**
 * Everything `authenticate` resolved for a request.
 *
 * It lives on `req.authState`, which is simply absent until the middleware
 * ran — there is no way to decorate every request up front in Express, and
 * pretending the value exists before it does is the bug the accessors below
 * refuse to allow. Handlers never read the property raw: they go through
 * `authOf` or `requestContext`, which fail loudly, naming the route wiring
 * that is missing, instead of somewhere downstream on `undefined`.
 */
export interface AuthState {
  auth: AuthContext
  access: AccessContext
}

/** The two middlewares the route registry wires from `RouteDef.permissions`. */
export interface Auth {
  /** Verifies the Bearer token, resolves the access context and fills `req.authState`. */
  authenticate: RequestHandler
  /** Demands every listed permission (logical AND); answers 403 if any is missing. Root bypasses. */
  requirePermissions(...perms: PermissionKey[]): RequestHandler
}

/** The state, or a loud failure naming the route wiring that is missing. */
export function authOf(req: Request): AuthState {
  const state = req.authState
  if (state === undefined) {
    throw new Error(
      'req.authState was read before `authenticate` ran. ' +
        'Declare `permissions` (an array, not null) on this route so the registry wires it.',
    )
  }
  return state
}

/** The request context handed down to the service layer. */
export function requestContext(req: Request): RequestContext {
  const { auth, access } = authOf(req)
  return { actorId: auth.sub, access, log: req.log }
}

/**
 * How stale `last_seen_at` is allowed to get before it is written again.
 *
 * The mark used to be an unconditional UPDATE on every authenticated request,
 * which made `clavis.users` — the table every single request already reads —
 * take a write per request, with the row version churn and vacuum load that
 * implies. Five minutes is far finer than any question "when did this person
 * last use the system?" is ever asked at, and it collapses that into at most
 * one write per user per five minutes.
 */
const LAST_SEEN_MAX_AGE = '5 minutes'

/** Strips trailing slashes from a URL so paths can be appended safely. */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/** Reads a string claim from the payload; returns `null` when absent. */
function readStringClaim(payload: JWTPayload, claim: string): string | null {
  const value = (payload as Record<string, unknown>)[claim]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Extracts the token from the `Authorization: Bearer <jwt>` header. */
function readBearerToken(req: Request): string {
  const header = req.headers.authorization
  if (typeof header !== 'string' || header.trim().length === 0) {
    throw unauthorized('Missing Authorization header with the Bearer token.')
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  const token = match?.[1]
  if (!token) {
    throw unauthorized('The Authorization header must use the "Bearer <token>" format.')
  }
  return token
}

/**
 * Authentication and authorization middleware.
 *
 * The JWKS is downloaded from the **internal** issuer
 * (`http://keycloak:8080/...`, the docker network), while the `iss` check uses
 * the **public** issuer (`http://localhost:8080/...`), which is the one carried
 * inside the token.
 *
 * `authenticate` resolves the caller's access context from the database (with
 * a Valkey cache keyed by the `access` namespace version), so a permission
 * change takes effect as soon as the namespace is bumped — no token refresh
 * involved.
 *
 * Express 5 forwards a rejected promise from an async middleware to the error
 * handler on its own, which is what lets both middlewares simply `throw` the
 * 401/403 they mean.
 */
export function createAuth(options: AuthOptions, deps: AuthDeps): Auth {
  const jwksUrl = new URL(
    `${trimTrailingSlash(options.KEYCLOAK_INTERNAL_ISSUER)}/protocol/openid-connect/certs`,
  )
  deps.log.info(
    { jwksUrl: jwksUrl.toString(), issuer: options.KEYCLOAK_ISSUER, audience: options.KEYCLOAK_AUDIENCE },
    'Token verification configured',
  )

  const jwks = createRemoteJWKSet(jwksUrl, {
    timeoutDuration: 5000,
    cooldownDuration: 30000,
    cacheMaxAge: 600000,
  })

  const authenticate: RequestHandler = async function authenticate(req, _res, next) {
    const token = readBearerToken(req)

    let payload: JWTPayload
    try {
      const verified = await jwtVerify(token, jwks, {
        issuer: options.KEYCLOAK_ISSUER,
        audience: options.KEYCLOAK_AUDIENCE,
        clockTolerance: 5,
      })
      payload = verified.payload
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'verification failed'
      req.log.warn({ err: error }, 'Token rejected')
      throw unauthorized(`Invalid token: ${detail}`)
    }

    const sub = payload.sub
    if (!sub) {
      throw unauthorized('The token does not contain the "sub" claim.')
    }

    const auth: AuthContext = {
      sub,
      username: readStringClaim(payload, 'preferred_username') ?? sub,
      email: readStringClaim(payload, 'email'),
      name: readStringClaim(payload, 'name'),
      token,
    }

    // Cache first: the key embeds the namespace version, so bumping the
    // namespace after any role/override mutation makes every entry stale.
    //
    // A `null` version means the version could not be read, and without it
    // there is no way to tell a fresh entry from one that predates several
    // invalidations. The request is then resolved from Postgres and nothing
    // is written back: slower, but never with permissions that were revoked.
    const version = await deps.cache.version(ACCESS_NAMESPACE)
    let access: AccessContext | null
    if (version === null) {
      access = await loadAccessContext(deps.db, sub)
    } else {
      const cacheKey = accessCacheKey(version, sub)
      access = await deps.cache.get<AccessContext>(cacheKey)
      if (access === null) {
        access = await loadAccessContext(deps.db, sub)
        if (access !== null) {
          await deps.cache.set(cacheKey, access, options.CACHE_TTL_SECONDS)
        }
      }
    }

    if (access === null) {
      // A valid Keycloak identity without an application user: authentication
      // succeeded, authorization has nothing to grant.
      throw forbidden(
        'This identity has no user in the application.',
        'USER_NOT_PROVISIONED',
      )
    }
    if (access.user.status === 'disabled') {
      throw forbidden('This account is disabled.', 'ACCOUNT_DISABLED')
    }

    // Best-effort presence mark; never worth failing the request over.
    // The WHERE clause is what keeps it cheap: without it this is a write on
    // the hottest table in the schema for every authenticated request.
    deps.db
      .query(
        `UPDATE clavis.users
            SET last_seen_at = now()
          WHERE id = $1
            AND (last_seen_at IS NULL OR last_seen_at < now() - $2::interval)`,
        [sub, LAST_SEEN_MAX_AGE],
      )
      .catch((error) => req.log.warn({ err: error }, 'Could not update last_seen_at'))

    req.authState = { auth, access }
    next()
  }

  /** Returns a middleware that demands every listed permission (logical AND). */
  const requirePermissions = (...perms: PermissionKey[]): RequestHandler => {
    return function requirePermissionsHandler(req, _res, next) {
      // Read the raw property, not `authOf`: a route that reached here without
      // `authenticate` must answer 401, not the programming error the accessor
      // raises. The registry always wires both, so this is defence in depth.
      const state = req.authState
      if (state === undefined) {
        throw unauthorized('This operation requires authentication.')
      }
      const missing = perms.filter((perm) => !contextHasPermission(state.access, perm))
      if (missing.length > 0) {
        throw forbidden(
          `You do not have enough permissions. Missing: ${missing.join(', ')}.`,
          'FORBIDDEN',
          { missing },
        )
      }
      next()
    }
  }

  return { authenticate, requirePermissions }
}
