// Business layer of the access module: the catalog and its assignments —
// roles, permissions and per-user exceptions. Permission KEYS come from
// @clavis/shared (synced at boot); this module only ever edits ASSIGNMENTS.
import type { Cache } from '../../infra/cache.js'
import type { Db } from '../../infra/db.js'
import { ACCESS_NAMESPACE, assertNotSelf, loadAccessContext } from '../../lib/access.js'
import type { RequestContext } from '../../lib/context.js'
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js'
import { mutate } from '../../lib/mutate.js'
import {
  deleteRole,
  findRole,
  insertRole,
  insertRolePermissions,
  isRootUser,
  listOverrides,
  listPermissions,
  listRoles,
  replaceOverrides,
  replaceRolePermissions,
  unknownPermissions,
  type PermissionRow,
} from './repository.js'
import { type CreateRoleInput, type OverrideInput, type RoleView, serializeRole } from './schemas.js'

/** Roles, overrides and effective permissions of one user, fully resolved. */
export interface UserAccessView {
  userId: string
  username: string
  isRoot: boolean
  roles: string[]
  overrides: OverrideInput[]
  effectivePermissions: string[]
}

export interface AccessServiceDeps {
  db: Db
  cache: Cache
}

export interface AccessService {
  catalog(): Promise<{ permissions: PermissionRow[]; roles: RoleView[] }>
  userAccess(userId: string): Promise<UserAccessView>
  replaceUserOverrides(ctx: RequestContext, userId: string, overrides: OverrideInput[]): Promise<UserAccessView>
  createRole(ctx: RequestContext, input: CreateRoleInput): Promise<RoleView>
  replaceRolePermissions(ctx: RequestContext, slug: string, permissions: string[]): Promise<RoleView>
  deleteRole(ctx: RequestContext, slug: string): Promise<void>
}

export function createAccessService(deps: AccessServiceDeps): AccessService {
  const { db } = deps

  /** 400 when any of `keys` is not in the catalog. */
  async function assertKnownPermissions(keys: string[]): Promise<void> {
    const unknown = await unknownPermissions(db, keys)
    if (unknown.length > 0) {
      throw badRequest(`Unknown permissions: ${unknown.join(', ')}.`, 'UNKNOWN_PERMISSIONS')
    }
  }

  async function userAccess(userId: string): Promise<UserAccessView> {
    const context = await loadAccessContext(db, userId)
    if (!context) throw notFound('User not found.')

    const overrides = await listOverrides(db, userId)
    return {
      userId: context.user.id,
      username: context.user.username,
      isRoot: context.user.isRoot,
      roles: context.roles,
      overrides: overrides.map((row) => ({ permissionKey: row.permission_key, effect: row.effect })),
      effectivePermissions: context.permissions,
    }
  }

  return {
    async catalog() {
      const permissions = await listPermissions(db)
      const roles = await listRoles(db)
      return { permissions, roles: roles.map(serializeRole) }
    },

    userAccess,

    async replaceUserOverrides(ctx, userId, overrides) {
      const isRoot = await isRootUser(db, userId)
      if (isRoot === null) throw notFound('User not found.')
      if (isRoot) {
        throw forbidden('Root bypasses the permission system; overrides do not apply.', 'ROOT_IMMUTABLE')
      }
      // The same rule the users service applies to `roles`, on the route that
      // reaches further: an override grant hands out an individual permission
      // key directly, so without this a holder of `access:manage` could write
      // themselves the entire catalog in one request — and the revoke
      // direction is the matching self-lockout.
      assertNotSelf(ctx.actorId, userId, 'change your own permission overrides')

      const keys = overrides.map((override) => override.permissionKey)
      if (new Set(keys).size !== keys.length) {
        throw badRequest('Each permission can appear in at most one override.')
      }
      await assertKnownPermissions(keys)

      await mutate(deps, {
        run: (client) => replaceOverrides(client, userId, ctx.actorId, overrides),
        audit: () => ({
          actorId: ctx.actorId,
          action: 'access.overrides_replaced',
          entity: 'user',
          entityId: userId,
          payload: { overrides },
        }),
        invalidate: ACCESS_NAMESPACE,
      })

      // Answer with the resolved state so the editor never guesses.
      return userAccess(userId)
    },

    async createRole(ctx, input) {
      const { slug, name, description } = input
      const permissions = [...new Set(input.permissions ?? [])]

      await assertKnownPermissions(permissions)

      const existing = await findRole(db, slug)
      if (existing !== null) {
        throw conflict(`A role with slug "${slug}" already exists.`, 'ROLE_EXISTS')
      }

      await mutate(deps, {
        run: async (client) => {
          await insertRole(client, { slug, name, description: description ?? null })
          await insertRolePermissions(client, slug, permissions)
        },
        audit: () => ({
          actorId: ctx.actorId,
          action: 'role.created',
          entity: 'role',
          entityId: slug,
          payload: { name, permissions },
        }),
        invalidate: ACCESS_NAMESPACE,
      })

      return { slug, name, description: description ?? null, isSystem: false, permissions }
    },

    async replaceRolePermissions(ctx, slug, permissionInput) {
      const role = await findRole(db, slug)
      if (!role) throw notFound('Role not found.')
      if (role.is_system) throw forbidden('System roles are managed at boot.', 'SYSTEM_ROLE')

      const permissions = [...new Set(permissionInput)]
      await assertKnownPermissions(permissions)

      await mutate(deps, {
        run: (client) => replaceRolePermissions(client, slug, permissions),
        audit: () => ({
          actorId: ctx.actorId,
          action: 'role.permissions_replaced',
          entity: 'role',
          entityId: slug,
          payload: { permissions },
        }),
        invalidate: ACCESS_NAMESPACE,
      })

      return {
        slug,
        name: role.name,
        description: role.description,
        isSystem: false,
        permissions,
      }
    },

    async deleteRole(ctx, slug) {
      const role = await findRole(db, slug)
      if (!role) throw notFound('Role not found.')
      if (role.is_system) throw forbidden('System roles are managed at boot.', 'SYSTEM_ROLE')

      await mutate(deps, {
        run: (client) => deleteRole(client, slug),
        audit: () => ({
          actorId: ctx.actorId,
          action: 'role.deleted',
          entity: 'role',
          entityId: slug,
        }),
        invalidate: ACCESS_NAMESPACE,
      })
    },
  }
}
