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

/** Quita las barras finales de una URL para poder concatenar rutas. */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/** Lee un claim de texto del payload; devuelve `null` si no existe. */
function readStringClaim(payload: JWTPayload, claim: string): string | null {
  const value = (payload as Record<string, unknown>)[claim]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Plugin de autenticación.
 *
 * El JWKS se descarga del issuer **interno** (`http://keycloak:8080/...`, la red
 * de docker), mientras que la validación de `iss` usa el issuer **público**
 * (`http://localhost:8080/...`), que es el que viaja dentro del token.
 */
export const authPlugin = fp(
  async (app: FastifyInstance) => {
    const jwksUrl = new URL(
      `${trimTrailingSlash(env.KEYCLOAK_INTERNAL_ISSUER)}/protocol/openid-connect/certs`,
    )
    app.log.info(
      { jwksUrl: jwksUrl.toString(), issuer: env.KEYCLOAK_ISSUER, audience: env.KEYCLOAK_AUDIENCE },
      'Verificación de tokens configurada',
    )

    const jwks = createRemoteJWKSet(jwksUrl, {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
      cacheMaxAge: 600000,
    })

    // `auth` se declara como propiedad de la petición para que exista siempre;
    // las rutas sólo deben leerla después de pasar por `authenticate`.
    app.decorateRequest('auth', null as unknown as AuthContext)

    /** Extrae el token del encabezado `Authorization: Bearer <jwt>`. */
    const readBearerToken = (request: FastifyRequest): string => {
      const header = request.headers.authorization
      if (typeof header !== 'string' || header.trim().length === 0) {
        throw unauthorized('Falta la cabecera Authorization con el token Bearer.')
      }
      const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
      const token = match?.[1]
      if (!token) {
        throw unauthorized('La cabecera Authorization debe tener el formato "Bearer <token>".')
      }
      return token
    }

    /**
     * preHandler: verifica el token, provisiona al usuario en `erp.users`
     * (just in time) y deja el contexto en `request.auth`.
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
        const detail = error instanceof Error ? error.message : 'no se pudo verificar'
        request.log.warn({ err: error }, 'Token rechazado')
        throw unauthorized(`Token inválido: ${detail}`)
      }

      const sub = payload.sub
      if (!sub) {
        throw unauthorized('El token no contiene el claim "sub".')
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

      // Provisión JIT: el usuario existe en la base en cuanto usa la API.
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

    /** Devuelve un preHandler que exige todos los permisos indicados (AND lógico). */
    const requirePermissions = (...perms: Permission[]): preHandlerHookHandler => {
      return async function requirePermissionsHandler(request) {
        const auth: AuthContext | null = request.auth ?? null
        if (auth === null) {
          throw unauthorized('Esta operación requiere autenticación.')
        }
        const missing = perms.filter((perm) => !hasPermission(auth, perm))
        if (missing.length > 0) {
          throw forbidden(
            `No tienes permisos suficientes. Faltan: ${missing.join(', ')}.`,
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
