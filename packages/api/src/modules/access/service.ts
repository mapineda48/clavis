// Business layer of the access module: the catalog and its assignments —
// roles, permissions and per-user exceptions. Permission KEYS come from
// @clavis/shared (synced at boot); this module only ever edits ASSIGNMENTS.
import type { Cache } from '../../infra/cache.js'
import type { Db } from '../../infra/db.js'
import {
  ACCESS_NAMESPACE,
  addedMembers,
  assertMayGrant,
  assertNotSelf,
  effectivePermissions,
  loadAccessContext,
} from '../../lib/access.js'
import type { RequestContext } from '../../lib/context.js'
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js'
import { mutate } from '../../lib/mutate.js'
import {
  currentOverrides,
  deleteRole,
  findOverrideTarget,
  findRole,
  insertRole,
  insertRolePermissions,
  listOverrides,
  listPermissions,
  listRoles,
  lockUserRow,
  permissionsForRoles,
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

    async replaceUserOverrides(ctx, userIdParam, overrides) {
      // Everything below addresses the user by `target.id`, never by the
      // parameter: the parameter is what the caller typed, `target.id` is what
      // the row holds. The two differ whenever the caller wants them to.
      const target = await findOverrideTarget(db, userIdParam)
      if (!target) throw notFound('User not found.')
      if (target.isRoot) {
        throw forbidden('Root bypasses the permission system; overrides do not apply.', 'ROOT_IMMUTABLE')
      }

      const keys = overrides.map((override) => override.permissionKey)
      if (new Set(keys).size !== keys.length) {
        throw badRequest('Each permission can appear in at most one override.')
      }
      await assertKnownPermissions(keys)

      // The two halves of the submitted body — the grants and the revokes of
      // the state this write would leave behind. Pure, so they are split here;
      // the effective sets they feed are built inside the transaction below.
      const nextGrants = overrides
        .filter((override) => override.effect === 'grant')
        .map((override) => override.permissionKey)
      const nextRevokes = overrides
        .filter((override) => override.effect === 'revoke')
        .map((override) => override.permissionKey)

      await mutate(deps, {
        run: async (client) => {
          // The guard is stated over the change to the target's EFFECTIVE set,
          // not the submitted rows. A rule that only inspected the grant rows
          // missed the shortest escalation of all: a target holding a
          // full-catalog role masked by revokes jumps to the whole catalog when
          // an actor merely empties the overrides — a dropped revoke is an
          // omission, never a submitted grant, so the body-shaped rule never saw
          // it. `before` and `after` are the effective set before and after this
          // write, built from the SAME `rolePerms` through one helper so the two
          // are comparable, and every input is read on `client` (Postgres, this
          // transaction) — NEVER the actor-facing cache, whose staleness could
          // make `before` too large, the delta too small, and the check fail
          // open under cache warmth. `addedMembers` is then exactly the newly
          // effective permissions; a preserved grant is in both sides and
          // contributes nothing, so the over-restriction is gone. Escalation is
          // judged before the self-lockout, so a self-directed escalation still
          // reports PRIVILEGE_ESCALATION and not SELF_MODIFICATION. Both throw
          // before any row is touched — clean ROLLBACK, no audit row, no bump.
          //
          // The row lock serialises two administrators editing THIS user's
          // overrides at once and pins the target's own grants/revokes for the
          // reads below. It does NOT make the whole `before` snapshot-consistent:
          // `rolePerms` reads `role_permissions`, which the role-permissions
          // writer locks instead of this user row, so the role contribution can
          // still straddle a concurrent role edit. That residue stays covered by
          // the set-algebra bound — a role only carries keys some authorised
          // author granted, so `before` can never exceed the target's real state
          // and the delta can never come out too small.
          await lockUserRow(client, target.id)

          const targetContext = await loadAccessContext(client, target.id)
          if (!targetContext) throw notFound('User not found.')
          const rolePerms = await permissionsForRoles(client, targetContext.roles)
          const current = await currentOverrides(client, target.id)
          const before = effectivePermissions(rolePerms, current.grants, current.revokes)
          const after = effectivePermissions(rolePerms, nextGrants, nextRevokes)
          assertMayGrant(ctx.access, addedMembers(before, after))
          assertNotSelf(ctx.access.user.id, target.id, 'change your own permission overrides')

          await replaceOverrides(client, target.id, ctx.actorId, overrides)
        },
        audit: () => ({
          actorId: ctx.actorId,
          action: 'access.overrides_replaced',
          entity: 'user',
          entityId: target.id,
          payload: { overrides },
        }),
        invalidate: ACCESS_NAMESPACE,
      })

      // Answer with the resolved state so the editor never guesses.
      return userAccess(target.id)
    },

    async createRole(ctx, input) {
      const { slug, name, description } = input
      const permissions = [...new Set(input.permissions ?? [])]

      await assertKnownPermissions(permissions)

      const existing = await findRole(db, slug)
      if (existing !== null) {
        throw conflict(`A role with slug "${slug}" already exists.`, 'ROLE_EXISTS')
      }

      // A new role starts empty, so its whole initial set is added. Nobody
      // holds the role yet, but minting one that carries more than the author
      // does is the first half of an escalation whose second half is a single
      // assignment, and the assignment writers cannot see how the role was born.
      assertMayGrant(ctx.access, permissions)

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
        run: async (client) => {
          // `role_permissions` is the first branch of the effective union, so
          // raising a role raises every one of its holders — the caller
          // included, which is how this write escalated with no self-id anywhere
          // in the request. The delta keeps it usable: only the keys this edit
          // ADDS have to be held, so reducing a role, or resaving one you hold in
          // part, still goes through. The current set is read on the SAME
          // connection as the replace and vetted here, so the check and the
          // write commit or roll back as one — a concurrent edit cannot change
          // what "already there" means between the read and the write. A refusal
          // throws before any row is touched: clean ROLLBACK, no audit, no bump.
          const added = addedMembers(await permissionsForRoles(client, [slug]), permissions)
          assertMayGrant(ctx.access, added)

          await replaceRolePermissions(client, slug, permissions)
        },
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
