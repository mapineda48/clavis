import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import fp from 'fastify-plugin'
import { type JWTPayload, createRemoteJWKSet, jwtVerify } from 'jose'
import { env } from '../config/env.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import {
  type AuthContext,
  type Permission,
  extractPermissions,
  extractRealmRoles,
  hasPermission,
} from '../lib/permissions.js'

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
 * Authentication plugin.
 *
 * The JWKS is downloaded from the **internal** issuer
 * (`http://keycloak:8080/...`, the docker network), while the `iss` check uses
 * the **public** issuer (`http://localhost:8080/...`), which is the one carried
 * inside the token.
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

    // `auth` is declared as a request property so that it always exists;
    // routes must only read it after going through `authenticate`.
    app.decorateRequest('auth', null as unknown as AuthContext)

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
     * preHandler: verifies the token, provisions the user in `erp.users`
     * (just in time) and leaves the context in `request.auth`.
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

      const auth: AuthContext = {
        sub,
        username: readStringClaim(payload, 'preferred_username') ?? sub,
        email: readStringClaim(payload, 'email'),
        name: readStringClaim(payload, 'name'),
        realmRoles: extractRealmRoles(payload),
        permissions: extractPermissions(payload, env.KEYCLOAK_AUDIENCE),
        token,
      }

      // JIT provisioning: the user exists in the database as soon as they use the API.
      await app.db.query(
        `INSERT INTO erp.users (id, username, email, display_name, last_seen_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE
           SET username     = EXCLUDED.username,
               email        = EXCLUDED.email,
               display_name = EXCLUDED.display_name,
               last_seen_at = now()`,
        [auth.sub, auth.username, auth.email, auth.name],
      )

      request.auth = auth
    }

    /** Returns a preHandler that demands every listed permission (logical AND). */
    const requirePermissions = (...perms: Permission[]): preHandlerHookHandler => {
      return async function requirePermissionsHandler(request) {
        const auth: AuthContext | null = request.auth ?? null
        if (auth === null) {
          throw unauthorized('This operation requires authentication.')
        }
        const missing = perms.filter((perm) => !hasPermission(auth, perm))
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
  { name: 'erp-auth', dependencies: ['erp-db'] },
)

export default authPlugin
