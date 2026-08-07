import type { PermissionKey } from '@clavis/shared'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import fp from 'fastify-plugin'
import { type JWTPayload, createRemoteJWKSet, jwtVerify } from 'jose'
import { env } from '../config/env.js'
import {
  ACCESS_NAMESPACE,
  type AccessContext,
  accessCacheKey,
  contextHasPermission,
  loadAccessContext,
} from '../lib/access.js'
import { forbidden, unauthorized } from '../lib/errors.js'

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

/**
 * Authentication and authorization plugin.
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
 */
export const authPlugin = fp(
  async (app: FastifyInstance) => {
    const jwksUrl = new URL(
      `${trimTrailingSlash(env.KEYCLOAK_INTERNAL_ISSUER)}/protocol/openid-connect/certs`,
    )
    app.log.info(
      { jwksUrl: jwksUrl.toString(), issuer: env.KEYCLOAK_ISSUER, audience: env.KEYCLOAK_AUDIENCE },
      'Token verification configured',
    )

    const jwks = createRemoteJWKSet(jwksUrl, {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
      cacheMaxAge: 600000,
    })

    // Declared as request properties so they always exist; routes must only
    // read them after going through `authenticate`.
    app.decorateRequest('auth', null as unknown as AuthContext)
    app.decorateRequest('access', null as unknown as AccessContext)

    /** Extracts the token from the `Authorization: Bearer <jwt>` header. */
    const readBearerToken = (request: FastifyRequest): string => {
      const header = request.headers.authorization
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
     * preHandler: verifies the token, resolves the access context from the
     * database (cache first) and leaves both on the request.
     */
    const authenticate: preHandlerHookHandler = async function authenticate(request) {
      const token = readBearerToken(request)

      let payload: JWTPayload
      try {
        const verified = await jwtVerify(token, jwks, {
          issuer: env.KEYCLOAK_ISSUER,
          audience: env.KEYCLOAK_AUDIENCE,
          clockTolerance: 5,
        })
        payload = verified.payload
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'verification failed'
        request.log.warn({ err: error }, 'Token rejected')
        throw unauthorized(`Invalid token: ${detail}`)
      }

      const sub = payload.sub
      if (!sub) {
        throw unauthorized('The token does not contain the "sub" claim.')
      }

      request.auth = {
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
      const version = await app.cache.version(ACCESS_NAMESPACE)
      let access: AccessContext | null
      if (version === null) {
        access = await loadAccessContext(app.db, sub)
      } else {
        const cacheKey = accessCacheKey(version, sub)
        access = await app.cache.get<AccessContext>(cacheKey)
        if (access === null) {
          access = await loadAccessContext(app.db, sub)
          if (access !== null) {
            await app.cache.set(cacheKey, access, env.CACHE_TTL_SECONDS)
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
      app.db
        .query(
          `UPDATE clavis.users
              SET last_seen_at = now()
            WHERE id = $1
              AND (last_seen_at IS NULL OR last_seen_at < now() - $2::interval)`,
          [sub, LAST_SEEN_MAX_AGE],
        )
        .catch((error) => request.log.warn({ err: error }, 'Could not update last_seen_at'))

      request.access = access
    }

    /** Returns a preHandler that demands every listed permission (logical AND). */
    const requirePermissions = (...perms: PermissionKey[]): preHandlerHookHandler => {
      return async function requirePermissionsHandler(request) {
        const access: AccessContext | null = request.access ?? null
        if (access === null) {
          throw unauthorized('This operation requires authentication.')
        }
        const missing = perms.filter((perm) => !contextHasPermission(access, perm))
        if (missing.length > 0) {
          throw forbidden(
            `You do not have enough permissions. Missing: ${missing.join(', ')}.`,
            'FORBIDDEN',
            { missing },
          )
        }
      }
    }

    app.decorate('authenticate', authenticate)
    app.decorate('requirePermissions', requirePermissions)
  },
  { name: 'clavis-auth', dependencies: ['clavis-db', 'clavis-cache'] },
)

export default authPlugin
