// Profile of the authenticated user: the database truth, not the token.
import type { FastifyPluginAsync } from 'fastify'
// Pulls in the @fastify/swagger type augmentation (tags, summary, security inside `schema`).
import type {} from '@fastify/swagger'
import { errorResponses } from '../shared/schemas.js'

/** Response schema of /api/me. */
const MeResponse = {
  type: 'object',
  properties: {
    user: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'User id (the id Keycloak assigned on creation)' },
        username: { type: 'string' },
        email: { type: 'string' },
        displayName: { type: ['string', 'null'] },
        isRoot: { type: 'boolean' },
        status: { type: 'string', enum: ['active', 'disabled'] },
      },
      required: ['id', 'username', 'email', 'displayName', 'isRoot', 'status'],
    },
    roles: {
      type: 'array',
      items: { type: 'string' },
      description: 'Assigned role slugs',
    },
    permissions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Effective permissions: union(roles) plus grants minus revokes; root gets the full catalog',
    },
    requestedAt: { type: 'string', description: 'ISO 8601 instant when the request was served' },
  },
  required: ['user', 'roles', 'permissions', 'requestedAt'],
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
          'Returns the application user linked to the verified identity together with their ' +
          'roles and effective permissions, so the frontend can decide what it is allowed to show.',
        security: [{ bearerAuth: [] }],
        response: {
          200: MeResponse,
          ...errorResponses(401, 403),
        },
      },
    },
    async (request) => {
      const { user, roles, permissions } = request.access
      return {
        user,
        roles,
        permissions,
        requestedAt: new Date().toISOString(),
      }
    },
  )
}
