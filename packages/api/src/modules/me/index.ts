// Perfil del usuario autenticado: datos del token mas roles y permisos efectivos.
import type { FastifyPluginAsync } from 'fastify'
// Carga la ampliacion de tipos de @fastify/swagger (tags, summary, security en `schema`).
import type {} from '@fastify/swagger'
import { ErrorResponse } from '../todos/schemas.js'

/** Esquema de la respuesta de /api/me. */
const MeResponse = {
  type: 'object',
  properties: {
    sub: { type: 'string', description: 'Identificador del usuario en Keycloak' },
    username: { type: 'string' },
    email: { type: ['string', 'null'] },
    name: { type: ['string', 'null'] },
    realmRoles: {
      type: 'array',
      items: { type: 'string' },
      description: 'Roles de realm (erp-user, erp-manager, erp-admin)',
    },
    permissions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Client roles de erp-api concedidos al usuario',
    },
    requestedAt: { type: 'string', description: 'Instante ISO 8601 en el que se atendio la peticion' },
  },
  required: ['sub', 'username', 'email', 'name', 'realmRoles', 'permissions', 'requestedAt'],
}

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/me',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['perfil'],
        summary: 'Perfil del usuario autenticado',
        description:
          'Devuelve los datos del token verificado junto con los roles de realm y los permisos ' +
          'de la aplicacion, para que el frontend decida que puede mostrar.',
        security: [{ bearerAuth: [] }],
        response: {
          200: MeResponse,
          401: ErrorResponse,
        },
      },
    },
    async (request) => {
      const auth = request.auth
      return {
        sub: auth.sub,
        username: auth.username,
        email: auth.email,
        name: auth.name,
        realmRoles: auth.realmRoles,
        permissions: auth.permissions,
        requestedAt: new Date().toISOString(),
      }
    },
  )
}
