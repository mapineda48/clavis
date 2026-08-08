// HTTP layer of the access module: routes, validation and serialization only.
import { requestContext } from '../../http/auth.js'
import { errorResponses } from '../../http/openapi.js'
import type { ModuleDef } from '../../http/route.js'
import { IdParams, type IdParamsInput, SlugParams, type SlugParamsInput } from '../shared/params.js'
import {
  CatalogResponse,
  CreateRoleBody,
  type CreateRoleInput,
  ReplaceOverridesBody,
  type ReplaceOverridesInput,
  ReplacePermissionsBody,
  type ReplacePermissionsInput,
  RoleSchema,
  UserAccessResponse,
} from './schemas.js'
import { type AccessServiceDeps, createAccessService } from './service.js'

export function accessModule(deps: AccessServiceDeps): ModuleDef {
  const service = createAccessService(deps)

  return {
    tag: { name: 'access', description: 'Roles, permissions and per-user exceptions' },
    routes: [
      {
        method: 'get',
        path: '/access/catalog',
        summary: 'Permission catalog and role definitions',
        description:
          'Permission keys are declared in code and synced at boot; roles and their permission ' +
          'sets live in the database and are managed here.',
        permissions: ['access:read'],
        responses: { 200: CatalogResponse, ...errorResponses(401, 403) },
        handler: async (_req, res) => {
          res.json(await service.catalog())
        },
      },

      {
        method: 'get',
        path: '/access/users/:id',
        summary: 'Roles, overrides and effective permissions of one user',
        permissions: ['access:read'],
        schema: { params: IdParams },
        responses: {
          200: UserAccessResponse,
          ...errorResponses(400, 401, 403, 404),
        },
        handler: async (req, res) => {
          const params = req.params as unknown as IdParamsInput
          res.json(await service.userAccess(params.id))
        },
      },

      {
        method: 'put',
        path: '/access/users/:id/overrides',
        summary: 'Replace the permission exceptions of one user',
        description:
          'The full set is replaced in one write: grants add permissions the roles do not give, ' +
          'revokes remove permissions they do. Root accepts no overrides, and nobody may edit ' +
          'their own.',
        permissions: ['access:manage'],
        schema: { params: IdParams, body: ReplaceOverridesBody },
        responses: {
          200: UserAccessResponse,
          ...errorResponses(400, 401, 403, 404),
        },
        handler: async (req, res) => {
          const params = req.params as unknown as IdParamsInput
          const body = req.body as ReplaceOverridesInput
          res.json(await service.replaceUserOverrides(requestContext(req), params.id, body.overrides))
        },
      },

      {
        method: 'post',
        path: '/access/roles',
        summary: 'Create a role',
        permissions: ['access:manage'],
        schema: { body: CreateRoleBody },
        responses: {
          201: { type: 'object', properties: { role: RoleSchema }, required: ['role'] },
          ...errorResponses(400, 401, 403, 409),
        },
        handler: async (req, res) => {
          const role = await service.createRole(requestContext(req), req.body as CreateRoleInput)
          res.status(201).json({ role })
        },
      },

      {
        method: 'put',
        path: '/access/roles/:slug/permissions',
        summary: 'Replace the permission set of a role',
        description: 'System roles are seeded at boot and cannot be edited.',
        permissions: ['access:manage'],
        schema: { params: SlugParams, body: ReplacePermissionsBody },
        responses: {
          200: { type: 'object', properties: { role: RoleSchema }, required: ['role'] },
          ...errorResponses(400, 401, 403, 404),
        },
        handler: async (req, res) => {
          const params = req.params as unknown as SlugParamsInput
          const body = req.body as ReplacePermissionsInput
          const role = await service.replaceRolePermissions(requestContext(req), params.slug, body.permissions)
          res.json({ role })
        },
      },

      {
        method: 'delete',
        path: '/access/roles/:slug',
        summary: 'Delete a role',
        description: 'Assignments cascade away with it. System roles cannot be deleted.',
        permissions: ['access:manage'],
        schema: { params: SlugParams },
        responses: {
          204: { type: 'null' },
          ...errorResponses(401, 403, 404),
        },
        handler: async (req, res) => {
          const params = req.params as unknown as SlugParamsInput
          await service.deleteRole(requestContext(req), params.slug)
          res.status(204).end()
        },
      },
    ],
  }
}
