// The access catalog and its assignments: roles, permissions and per-user
// exceptions. Permission KEYS come from @clavis/shared (synced at boot); this
// module only ever edits ASSIGNMENTS.
import type { FastifyPluginAsync } from 'fastify'
// Pulls in the @fastify/swagger type augmentation (tags, summary, security inside `schema`).
import type {} from '@fastify/swagger'
import { ACCESS_NAMESPACE, loadAccessContext } from '../../lib/access.js'
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js'
import { recordAudit } from '../shared/audit.js'
import { ErrorResponse } from '../shared/schemas.js'

interface IdParamsInput {
  id: string
}

interface SlugParamsInput {
  slug: string
}

interface OverrideInput {
  permissionKey: string
  effect: 'grant' | 'revoke'
}

interface ReplaceOverridesInput {
  overrides: OverrideInput[]
}

interface CreateRoleInput {
  slug: string
  name: string
  description?: string
  permissions?: string[]
}

interface ReplacePermissionsInput {
  permissions: string[]
}

const PermissionSchema = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    module: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['key', 'module', 'description'],
}

const RoleSchema = {
  type: 'object',
  properties: {
    slug: { type: 'string' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    isSystem: { type: 'boolean' },
    permissions: { type: 'array', items: { type: 'string' } },
  },
  required: ['slug', 'name', 'description', 'isSystem', 'permissions'],
}

const CatalogResponse = {
  type: 'object',
  properties: {
    permissions: { type: 'array', items: PermissionSchema },
    roles: { type: 'array', items: RoleSchema },
  },
  required: ['permissions', 'roles'],
}

const OverrideSchema = {
  type: 'object',
  properties: {
    permissionKey: { type: 'string' },
    effect: { type: 'string', enum: ['grant', 'revoke'] },
  },
  required: ['permissionKey', 'effect'],
}

const UserAccessResponse = {
  type: 'object',
  properties: {
    userId: { type: 'string' },
    username: { type: 'string' },
    isRoot: { type: 'boolean' },
    roles: { type: 'array', items: { type: 'string' } },
    overrides: { type: 'array', items: OverrideSchema },
    effectivePermissions: { type: 'array', items: { type: 'string' } },
  },
  required: ['userId', 'username', 'isRoot', 'roles', 'overrides', 'effectivePermissions'],
}

const IdParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
}

const SlugParams = {
  type: 'object',
  required: ['slug'],
  properties: { slug: { type: 'string', minLength: 1 } },
}

interface RoleRow {
  slug: string
  name: string
  description: string | null
  is_system: boolean
  permissions: string[]
}

async function listRoles(db: Parameters<typeof loadAccessContext>[0]): Promise<RoleRow[]> {
  const result = await db.query<RoleRow>(
    `SELECT r.slug,
            r.name,
            r.description,
            r.is_system,
            COALESCE(
              (SELECT array_agg(rp.permission_key ORDER BY rp.permission_key)
                 FROM clavis.role_permissions rp
                WHERE rp.role_slug = r.slug),
              '{}'
            ) AS permissions
       FROM clavis.roles r
      ORDER BY r.is_system DESC, r.slug ASC`,
  )
  return result.rows
}

function serializeRole(row: RoleRow) {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    isSystem: row.is_system,
    permissions: row.permissions,
  }
}

export const accessRoutes: FastifyPluginAsync = async (app) => {
  /** Which of `keys` are not in the permission catalog. */
  async function unknownPermissions(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return []
    const result = await app.db.query<{ key: string }>(
      `SELECT key FROM clavis.permissions WHERE key = ANY($1::text[])`,
      [keys],
    )
    const existing = new Set(result.rows.map((row) => row.key))
    return keys.filter((key) => !existing.has(key))
  }

  app.get(
    '/access/catalog',
    {
      preHandler: [app.authenticate, app.requirePermissions('access:read')],
      schema: {
        tags: ['access'],
        summary: 'Permission catalog and role definitions',
        description:
          'Permission keys are declared in code and synced at boot; roles and their permission ' +
          'sets live in the database and are managed here.',
        security: [{ bearerAuth: [] }],
        response: { 200: CatalogResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async () => {
      const permissions = await app.db.query<{ key: string; module: string; description: string }>(
        `SELECT key, module, description FROM clavis.permissions ORDER BY module, key`,
      )
      const roles = await listRoles(app.db)
      return {
        permissions: permissions.rows,
        roles: roles.map(serializeRole),
      }
    },
  )

  app.get<{ Params: IdParamsInput }>(
    '/access/users/:id',
    {
      preHandler: [app.authenticate, app.requirePermissions('access:read')],
      schema: {
        tags: ['access'],
        summary: 'Roles, overrides and effective permissions of one user',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          200: UserAccessResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request) => {
      const context = await loadAccessContext(app.db, request.params.id)
      if (!context) throw notFound('User not found.')

      const overrides = await app.db.query<{ permission_key: string; effect: 'grant' | 'revoke' }>(
        `SELECT permission_key, effect
           FROM clavis.user_permission_overrides
          WHERE user_id = $1
          ORDER BY permission_key`,
        [request.params.id],
      )

      return {
        userId: context.user.id,
        username: context.user.username,
        isRoot: context.user.isRoot,
        roles: context.roles,
        overrides: overrides.rows.map((row) => ({
          permissionKey: row.permission_key,
          effect: row.effect,
        })),
        effectivePermissions: context.permissions,
      }
    },
  )

  app.put<{ Params: IdParamsInput; Body: ReplaceOverridesInput }>(
    '/access/users/:id/overrides',
    {
      preHandler: [app.authenticate, app.requirePermissions('access:manage')],
      schema: {
        tags: ['access'],
        summary: 'Replace the permission exceptions of one user',
        description:
          'The full set is replaced in one write: grants add permissions the roles do not give, ' +
          'revokes remove permissions they do. Root accepts no overrides.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['overrides'],
          properties: {
            overrides: { type: 'array', items: OverrideSchema },
          },
        },
        response: {
          200: UserAccessResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request) => {
      const target = await app.db.query<{ is_root: boolean }>(
        `SELECT is_root FROM clavis.users WHERE id = $1`,
        [request.params.id],
      )
      const row = target.rows[0]
      if (!row) throw notFound('User not found.')
      if (row.is_root) {
        throw forbidden('Root bypasses the permission system; overrides do not apply.', 'ROOT_IMMUTABLE')
      }

      const overrides = request.body.overrides
      const keys = overrides.map((override) => override.permissionKey)
      if (new Set(keys).size !== keys.length) {
        throw badRequest('Each permission can appear in at most one override.')
      }
      const unknown = await unknownPermissions(keys)
      if (unknown.length > 0) {
        throw badRequest(`Unknown permissions: ${unknown.join(', ')}.`, 'UNKNOWN_PERMISSIONS')
      }

      await app.db.tx(async (client) => {
        await client.query(`DELETE FROM clavis.user_permission_overrides WHERE user_id = $1`, [
          request.params.id,
        ])
        if (overrides.length > 0) {
          await client.query(
            `INSERT INTO clavis.user_permission_overrides (user_id, permission_key, effect, created_by)
             SELECT $1, o.key, o.effect, $2
               FROM unnest($3::text[], $4::text[]) AS o(key, effect)`,
            [
              request.params.id,
              request.auth.sub,
              keys,
              overrides.map((override) => override.effect),
            ],
          )
        }
      })

      await recordAudit(
        app.db,
        {
          actorId: request.auth.sub,
          action: 'access.overrides_replaced',
          entity: 'user',
          entityId: request.params.id,
          payload: { overrides },
        },
        request.log,
      )
      await app.cache.bumpVersion(ACCESS_NAMESPACE)

      // Answer with the resolved state so the editor never guesses.
      const context = await loadAccessContext(app.db, request.params.id)
      if (!context) throw notFound('User not found.')
      return {
        userId: context.user.id,
        username: context.user.username,
        isRoot: context.user.isRoot,
        roles: context.roles,
        overrides,
        effectivePermissions: context.permissions,
      }
    },
  )

  app.post<{ Body: CreateRoleInput }>(
    '/access/roles',
    {
      preHandler: [app.authenticate, app.requirePermissions('access:manage')],
      schema: {
        tags: ['access'],
        summary: 'Create a role',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['slug', 'name'],
          properties: {
            slug: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$' },
            name: { type: 'string', minLength: 1, maxLength: 255 },
            description: { type: 'string', maxLength: 1000 },
            permissions: { type: 'array', items: { type: 'string' }, default: [] },
          },
        },
        response: {
          201: { type: 'object', properties: { role: RoleSchema }, required: ['role'] },
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const { slug, name, description } = request.body
      const permissions = [...new Set(request.body.permissions ?? [])]

      const unknown = await unknownPermissions(permissions)
      if (unknown.length > 0) {
        throw badRequest(`Unknown permissions: ${unknown.join(', ')}.`, 'UNKNOWN_PERMISSIONS')
      }

      const existing = await app.db.query(`SELECT 1 FROM clavis.roles WHERE slug = $1`, [slug])
      if (existing.rows.length > 0) {
        throw conflict(`A role with slug "${slug}" already exists.`, 'ROLE_EXISTS')
      }

      await app.db.tx(async (client) => {
        await client.query(
          `INSERT INTO clavis.roles (slug, name, description) VALUES ($1, $2, $3)`,
          [slug, name, description ?? null],
        )
        if (permissions.length > 0) {
          await client.query(
            `INSERT INTO clavis.role_permissions (role_slug, permission_key)
             SELECT $1, unnest($2::text[])`,
            [slug, permissions],
          )
        }
      })

      await recordAudit(
        app.db,
        {
          actorId: request.auth.sub,
          action: 'role.created',
          entity: 'role',
          entityId: slug,
          payload: { name, permissions },
        },
        request.log,
      )
      await app.cache.bumpVersion(ACCESS_NAMESPACE)

      return reply.code(201).send({
        role: { slug, name, description: description ?? null, isSystem: false, permissions },
      })
    },
  )

  app.put<{ Params: SlugParamsInput; Body: ReplacePermissionsInput }>(
    '/access/roles/:slug/permissions',
    {
      preHandler: [app.authenticate, app.requirePermissions('access:manage')],
      schema: {
        tags: ['access'],
        summary: 'Replace the permission set of a role',
        description: 'System roles are seeded at boot and cannot be edited.',
        security: [{ bearerAuth: [] }],
        params: SlugParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['permissions'],
          properties: {
            permissions: { type: 'array', items: { type: 'string' } },
          },
        },
        response: {
          200: { type: 'object', properties: { role: RoleSchema }, required: ['role'] },
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request) => {
      const slug = request.params.slug
      const role = await app.db.query<{ name: string; description: string | null; is_system: boolean }>(
        `SELECT name, description, is_system FROM clavis.roles WHERE slug = $1`,
        [slug],
      )
      const row = role.rows[0]
      if (!row) throw notFound('Role not found.')
      if (row.is_system) throw forbidden('System roles are managed at boot.', 'SYSTEM_ROLE')

      const permissions = [...new Set(request.body.permissions)]
      const unknown = await unknownPermissions(permissions)
      if (unknown.length > 0) {
        throw badRequest(`Unknown permissions: ${unknown.join(', ')}.`, 'UNKNOWN_PERMISSIONS')
      }

      await app.db.tx(async (client) => {
        await client.query(`DELETE FROM clavis.role_permissions WHERE role_slug = $1`, [slug])
        if (permissions.length > 0) {
          await client.query(
            `INSERT INTO clavis.role_permissions (role_slug, permission_key)
             SELECT $1, unnest($2::text[])`,
            [slug, permissions],
          )
        }
      })

      await recordAudit(
        app.db,
        {
          actorId: request.auth.sub,
          action: 'role.permissions_replaced',
          entity: 'role',
          entityId: slug,
          payload: { permissions },
        },
        request.log,
      )
      await app.cache.bumpVersion(ACCESS_NAMESPACE)

      return {
        role: {
          slug,
          name: row.name,
          description: row.description,
          isSystem: false,
          permissions,
        },
      }
    },
  )

  app.delete<{ Params: SlugParamsInput }>(
    '/access/roles/:slug',
    {
      preHandler: [app.authenticate, app.requirePermissions('access:manage')],
      schema: {
        tags: ['access'],
        summary: 'Delete a role',
        description: 'Assignments cascade away with it. System roles cannot be deleted.',
        security: [{ bearerAuth: [] }],
        params: SlugParams,
        response: {
          204: { type: 'null' },
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const role = await app.db.query<{ is_system: boolean }>(
        `SELECT is_system FROM clavis.roles WHERE slug = $1`,
        [request.params.slug],
      )
      const row = role.rows[0]
      if (!row) throw notFound('Role not found.')
      if (row.is_system) throw forbidden('System roles are managed at boot.', 'SYSTEM_ROLE')

      await app.db.query(`DELETE FROM clavis.roles WHERE slug = $1`, [request.params.slug])

      await recordAudit(
        app.db,
        {
          actorId: request.auth.sub,
          action: 'role.deleted',
          entity: 'role',
          entityId: request.params.slug,
        },
        request.log,
      )
      await app.cache.bumpVersion(ACCESS_NAMESPACE)

      return reply.code(204).send()
    },
  )
}
