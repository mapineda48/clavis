// Profile of the authenticated user: the database truth, not the token.
import { authOf } from '../../http/auth.js'
import { errorResponses } from '../../http/openapi.js'
import type { ModuleDef } from '../../http/route.js'

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

export function meModule(): ModuleDef {
  return {
    tag: { name: 'profile', description: 'Data about the authenticated user' },
    routes: [
      {
        method: 'get',
        path: '/me',
        summary: 'Authenticated user profile',
        description:
          'Returns the application user linked to the verified identity together with their ' +
          'roles and effective permissions, so the frontend can decide what it is allowed to show.',
        permissions: [],
        responses: {
          200: MeResponse,
          ...errorResponses(401, 403),
        },
        handler: async (req, res) => {
          const { user, roles, permissions } = authOf(req).access
          res.json({
            user,
            roles,
            permissions,
            requestedAt: new Date().toISOString(),
          })
        },
      },
    ],
  }
}
