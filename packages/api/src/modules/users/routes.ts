// HTTP layer of the users module: declares the routes, validates the request,
// builds the RequestContext and serializes what the service returns. No SQL
// and no Keycloak calls live here — that is the point of the split.
import { requestContext } from '../../http/auth.js'
import { errorResponses } from '../../http/openapi.js'
import type { ModuleDef } from '../../http/route.js'
import { IdParams, type IdParamsInput } from '../shared/params.js'
import {
  CreateUserBody,
  type CreateUserInput,
  InviteSchema,
  type ListQueryInput,
  ListUsersQuery,
  UpdateUserBody,
  type UpdateUserInput,
  UserSchema,
  UsersResponse,
  serializeUser,
} from './schemas.js'
import { type UsersServiceDeps, createUsersService } from './service.js'

export function usersModule(deps: UsersServiceDeps): ModuleDef {
  const service = createUsersService(deps)

  return {
    tag: { name: 'users', description: 'System users: created here, authenticated by Keycloak' },
    routes: [
      {
        method: 'get',
        path: '/users',
        summary: 'List system users',
        permissions: ['users:read'],
        schema: { query: ListUsersQuery },
        responses: { 200: UsersResponse, ...errorResponses(401, 403) },
        handler: async (req, res) => {
          const query = req.query as ListQueryInput
          const rows = await service.list(query.limit ?? 100)
          res.json({ items: rows.map(serializeUser) })
        },
      },

      {
        method: 'post',
        path: '/users',
        summary: 'Create a system user',
        description:
          'Registers the user in Keycloak first (which assigns the id and owns the credentials), ' +
          'then sets the temporary password and stores the application user and their roles. ' +
          'If any of those fails the Keycloak user is deleted again, so the two systems cannot ' +
          'drift on creation. A non-empty `roles` additionally requires `access:manage`.',
        permissions: ['users:create'],
        schema: { body: CreateUserBody },
        responses: {
          201: {
            type: 'object',
            properties: { user: UserSchema, invite: InviteSchema },
            required: ['user', 'invite'],
          },
          ...errorResponses(400, 401, 403, 409),
        },
        handler: async (req, res) => {
          const { user, invite } = await service.create(requestContext(req), req.body as CreateUserInput)
          res.status(201).json({ user: serializeUser(user), invite })
        },
      },

      {
        method: 'patch',
        path: '/users/:id',
        summary: 'Update a user: profile, status or roles',
        description:
          'Disabling a user also disables them in Keycloak. The root user cannot be edited here. ' +
          'Changing `roles` additionally requires `access:manage`, and nobody may change their ' +
          'own roles or status.',
        permissions: ['users:update'],
        schema: { params: IdParams, body: UpdateUserBody },
        responses: {
          200: { type: 'object', properties: { user: UserSchema }, required: ['user'] },
          ...errorResponses(400, 401, 403, 404, 409),
        },
        handler: async (req, res) => {
          const params = req.params as unknown as IdParamsInput
          const updated = await service.update(requestContext(req), params.id, req.body as UpdateUserInput)
          res.json({ user: serializeUser(updated) })
        },
      },

      {
        method: 'delete',
        path: '/users/:id',
        summary: 'Delete a user',
        description:
          'Removes the user from Keycloak and from the application; role assignments and ' +
          'overrides cascade away, the audit trail keeps its rows. Root cannot be deleted, ' +
          'and nobody can delete themselves.',
        permissions: ['users:delete'],
        schema: { params: IdParams },
        responses: {
          204: { type: 'null' },
          ...errorResponses(400, 401, 403, 404),
        },
        handler: async (req, res) => {
          const params = req.params as unknown as IdParamsInput
          await service.remove(requestContext(req), params.id)
          res.status(204).end()
        },
      },

      {
        method: 'post',
        path: '/users/:id/resend-invite',
        summary: 'Resend the set-your-password invitation email',
        permissions: ['users:update'],
        schema: { params: IdParams },
        responses: {
          200: {
            type: 'object',
            properties: { invite: InviteSchema },
            required: ['invite'],
          },
          ...errorResponses(400, 401, 403, 404),
        },
        handler: async (req, res) => {
          const params = req.params as unknown as IdParamsInput
          const invite = await service.resendInvite(requestContext(req), params.id)
          res.json({ invite })
        },
      },
    ],
  }
}
