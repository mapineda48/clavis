// Profile of the authenticated user: token data plus effective roles and permissions.
import type { FastifyPluginAsync } from 'fastify'
// Pulls in the @fastify/swagger type augmentation (tags, summary, security inside `schema`).
import type {} from '@fastify/swagger'
import { ErrorResponse } from '../todos/schemas.js'

/** Response schema of /api/me. */
const MeResponse = {
  type: 'object',
  properties: {
    sub: { type: 'string', description: 'User identifier in Keycloak' },
    username: { type: 'string' },
    email: { type: ['string', 'null'] },
    name: { type: ['string', 'null'] },
    realmRoles: {
      type: 'array',
      items: { type: 'string' },
      description: 'Realm roles (erp-user, erp-manager, erp-admin)',
    },
    permissions: {
      type: 'array',
      items: { type: 'string' },
      description: 'erp-api client roles granted to the user',
    },
    requestedAt: { type: 'string', description: 'ISO 8601 instant when the request was served' },
  },
  required: ['sub', 'username', 'email', 'name', 'realmRoles', 'permissions', 'requestedAt'],
}

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/me',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['profile'],
        summary: 'Authenticated user profile',
        description:
          'Returns the data carried by the verified token together with the realm roles and the ' +
          'application permissions, so the frontend can decide what it is allowed to show.',
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
