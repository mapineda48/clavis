// Business layer of the users module: the API registers the user in Keycloak
// (which owns credentials and sessions) and stores the id Keycloak assigned,
// the minimal profile and the role assignments. Everything here is
// transport-free — it takes a RequestContext and returns records or throws
// AppErrors, and the routes decide how that maps onto HTTP.
import type { Cache } from '../../infra/cache.js'
import type { Db } from '../../infra/db.js'
import { type KeycloakAdmin, KeycloakAdminError } from '../../infra/keycloak-admin.js'
import {
  ACCESS_NAMESPACE,
  type AccessContext,
  addedMembers,
  assertMayGrant,
  assertNotSelf,
  contextHasPermission,
} from '../../lib/access.js'
import type { RequestContext } from '../../lib/context.js'
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js'
import { mutate } from '../../lib/mutate.js'
import { permissionsForRoles } from '../access/repository.js'
import { recordAuditBestEffort } from '../shared/audit.js'
import {
  deleteUser as deleteUserRow,
  findUser,
  insertUser,
  listUsers,
  missingRoles,
  replaceRoles,
  takenField,
  updateUserFields,
  type UserRecord,
} from './repository.js'
import type { CreateUserInput, UpdateUserInput } from './schemas.js'

/** Whether the invitation email went out, and why not when it did not. */
export interface InviteResult {
  sent: boolean
  reason: string | null
}

/**
 * Which fields of an update nobody may apply to their own account.
 *
 * Editing one's own `displayName` stays allowed: it carries no privilege.
 * `roles` and `status` do — self-granting a role is escalation and
 * self-disabling is a lockout — so they need a second pair of hands.
 */
export function selfBlockedFields(body: UpdateUserInput): string[] {
  const blocked: string[] = []
  if (body.roles !== undefined) blocked.push('roles')
  if (body.status !== undefined) blocked.push('status')
  return blocked
}

/**
 * Role assignment is an `access:*` operation reached through a `users:*` route.
 *
 * `requirePermissions` is a static gate and cannot look at the body, so the
 * rule lives in the service. Without it `users:update` alone would be enough
 * to hand any account the `admin` role — which boot seeding fills with the
 * whole catalog — and the catalog's split between `users:*` and `access:*`
 * would exist only on paper.
 */
export function assertMayAssignRoles(access: AccessContext): void {
  if (!contextHasPermission(access, 'access:manage')) {
    throw forbidden(
      'Assigning roles requires the access:manage permission.',
      'ROLE_ASSIGNMENT_DENIED',
    )
  }
}

/** Maps a Keycloak Admin failure to the API's error envelope. */
function mapKeycloakError(error: unknown): never {
  if (error instanceof KeycloakAdminError) {
    if (error.status === 409) {
      throw conflict('Keycloak already has a user with that username or email.', 'USER_EXISTS')
    }
    throw new AppError(502, 'KEYCLOAK_ERROR', `Keycloak refused the operation: ${error.message}`)
  }
  throw error
}

export interface UsersServiceDeps {
  db: Db
  cache: Cache
  keycloakAdmin: KeycloakAdmin
}

export interface UsersService {
  list(limit: number): Promise<UserRecord[]>
  create(ctx: RequestContext, input: CreateUserInput): Promise<{ user: UserRecord; invite: InviteResult }>
  update(ctx: RequestContext, id: string, input: UpdateUserInput): Promise<UserRecord>
  remove(ctx: RequestContext, id: string): Promise<void>
  resendInvite(ctx: RequestContext, id: string): Promise<InviteResult>
}

export function createUsersService(deps: UsersServiceDeps): UsersService {
  const { db, cache, keycloakAdmin } = deps

  /** The user, or 404; root additionally answers 403 on any mutation. */
  async function findEditableUser(id: string): Promise<UserRecord> {
    const existing = await findUser(db, id)
    if (!existing) throw notFound('User not found.')
    if (existing.is_root) {
      throw forbidden('The root user is managed by the deployment, not by the API.', 'ROOT_IMMUTABLE')
    }
    return existing
  }

  /** Sends the set-your-password email; a failure is reported, never thrown. */
  async function sendInvite(ctx: RequestContext, keycloakId: string): Promise<InviteResult> {
    try {
      await keycloakAdmin.sendExecuteActionsEmail(keycloakId, ['UPDATE_PASSWORD'])
      return { sent: true, reason: null }
    } catch (error) {
      ctx.log.warn({ err: error, keycloakId }, 'The invitation email could not be sent')
      return { sent: false, reason: error instanceof Error ? error.message : 'unknown error' }
    }
  }

  return {
    async list(limit) {
      return listUsers(db, limit)
    },

    async create(ctx, input) {
      const email = input.email.trim().toLowerCase()
      const username = (input.username ?? email.split('@')[0] ?? '').trim().toLowerCase()
      const roles = [...new Set(input.roles ?? [])]

      if (username.length < 3) {
        throw badRequest('The username must be at least 3 characters long.')
      }
      if (input.credentialMode === 'temporary_password' && !input.temporaryPassword) {
        throw badRequest('temporaryPassword is required when credentialMode is temporary_password.')
      }
      // Same rule as update(): creating an account already holding `admin` and
      // knowing its temporary password is the escalation update() no longer
      // allows.
      if (roles.length > 0) {
        assertMayAssignRoles(ctx.access)
      }

      const unknownRoles = await missingRoles(db, roles)
      if (unknownRoles.length > 0) {
        throw badRequest(`Unknown roles: ${unknownRoles.join(', ')}.`, 'UNKNOWN_ROLES')
      }
      // The account starts with nothing, so every role listed is added. This is
      // what stops `users:create` + `access:manage` from minting an `admin`
      // account and signing in as it: `admin` carries the whole catalog, and an
      // actor holding those two keys does not.
      //
      // Unlike the two pure-database writers (overrides, role permissions) this
      // check reads on `db`, NOT inside the write transaction, and it must: it
      // has to run before Keycloak is touched, so an authorization refusal
      // never creates then compensates an external identity — and the row write
      // cannot enclose that Keycloak call (no network I/O in `tx`). The check
      // and the write are therefore necessarily separated by the Keycloak round
      // trip and cannot share a transaction. The resulting read-then-write
      // window is bounded by the model: a role can only carry a key some
      // authorised author already gave it.
      if (roles.length > 0) {
        assertMayGrant(ctx.access, await permissionsForRoles(db, roles))
      }

      const taken = await takenField(db, email, username)
      if (taken !== null) {
        throw conflict(`A user with that ${taken} already exists.`, 'USER_EXISTS')
      }

      // Keycloak first: it owns the id. UPDATE_PASSWORD arrives either as an
      // explicit required action (invite) or implicitly with the temporary
      // password Keycloak itself flags.
      //
      // This call is alone in its own try on purpose. It is the line that
      // creates the thing every step below has to be able to undo, and until it
      // returns there is nothing to undo.
      let keycloakId: string
      try {
        keycloakId = await keycloakAdmin.createUser({
          username,
          email,
          firstName: input.displayName,
          emailVerified: true,
          enabled: true,
          requiredActions: input.credentialMode === 'invite' ? ['UPDATE_PASSWORD'] : [],
        })
      } catch (error) {
        mapKeycloakError(error)
      }

      // Everything from here to the COMMIT is compensated, not just the
      // database write. `setPassword` used to sit in the try above, whose catch
      // only rethrows: a password that Keycloak refused left a user nobody
      // could reach and nobody could remove — the username and email are taken
      // forever, a retry answers 409, and DELETE /api/users/:id answers 404
      // because there is no application row to delete. Only Keycloak's own
      // console could clear it.
      try {
        if (input.credentialMode === 'temporary_password') {
          try {
            await keycloakAdmin.setPassword(keycloakId, input.temporaryPassword as string, true)
          } catch (error) {
            mapKeycloakError(error)
          }
        }

        // The row, its roles and the audit entry share one transaction. The
        // Keycloak calls are deliberately outside it: no network I/O to another
        // system while a transaction is open.
        await mutate(deps, {
          run: (client) =>
            insertUser(client, {
              id: keycloakId,
              username,
              email,
              displayName: input.displayName,
              roles,
            }),
          audit: () => ({
            actorId: ctx.actorId,
            action: 'user.created',
            entity: 'user',
            entityId: keycloakId,
            payload: { username, email, roles, credentialMode: input.credentialMode },
          }),
          invalidate: ACCESS_NAMESPACE,
        })
      } catch (error) {
        // Compensation: without the application row the Keycloak user is an
        // orphan that would block the username forever.
        await keycloakAdmin.deleteUser(keycloakId).catch((cleanupError) => {
          ctx.log.error(
            { err: cleanupError, keycloakId, username },
            'RECONCILE: could not clean up the Keycloak user after a failed creation; ' +
              'the username and email stay taken until it is removed by hand',
          )
        })
        throw error
      }

      // The invitation email must not undo the creation: report instead.
      const invite: InviteResult =
        input.credentialMode === 'invite' ? await sendInvite(ctx, keycloakId) : { sent: false, reason: null }

      const created = await findUser(db, keycloakId)
      if (!created) throw new AppError(500, 'INTERNAL_ERROR', 'The user vanished after creation.')
      return { user: created, invite }
    },

    async update(ctx, id, input) {
      const existing = await findEditableUser(id)

      const blocked = selfBlockedFields(input)
      if (blocked.length > 0) {
        assertNotSelf(ctx.access.user.id, existing.id, `change your own ${blocked.join(' or ')}`)
      }
      const nextRoles = input.roles === undefined ? undefined : [...new Set(input.roles)]
      if (nextRoles !== undefined) {
        assertMayAssignRoles(ctx.access)
        const unknownRoles = await missingRoles(db, nextRoles)
        if (unknownRoles.length > 0) {
          throw badRequest(`Unknown roles: ${unknownRoles.join(', ')}.`, 'UNKNOWN_ROLES')
        }
        // `roles` is sent whole, so the delta is what makes the rule usable:
        // only the roles this edit ADDS are an indirect grant, and stripping a
        // role the actor does not hold the permissions of stays possible. The
        // delta runs after the slugs are known to exist, because resolving them
        // to permissions is a query against those very rows.
        //
        // Like create() and unlike the two pure-database writers, this reads on
        // `db` rather than inside the write transaction, and must: the check
        // has to precede the Keycloak status flip below (an authorization
        // refusal must not flip then compensate an external system), and the
        // write cannot enclose that Keycloak call (no network I/O in `tx`).
        // The read-then-write window is inherent and bounded by the model — a
        // role can only carry a key some authorised author gave it.
        const added = addedMembers(existing.roles, nextRoles)
        assertMayGrant(ctx.access, await permissionsForRoles(db, added))
      }

      // Keycloak first, so a refusal leaves the database untouched. Outside the
      // transaction on purpose: no network I/O to another system while one is
      // open. The flag is remembered so the write below can undo it.
      const statusChanged = input.status !== undefined && input.status !== existing.status
      if (statusChanged) {
        try {
          await keycloakAdmin.setEnabled(existing.id, input.status === 'active')
        } catch (error) {
          mapKeycloakError(error)
        }
      }

      try {
        await mutate(deps, {
          run: async (client) => {
            if (input.displayName !== undefined || input.status !== undefined) {
              await updateUserFields(client, existing.id, {
                ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
                ...(input.status !== undefined ? { status: input.status } : {}),
              })
            }
            if (nextRoles !== undefined) {
              await replaceRoles(client, existing.id, nextRoles)
            }
          },
          audit: () => ({
            actorId: ctx.actorId,
            action: 'user.updated',
            entity: 'user',
            entityId: existing.id,
            payload: { changes: input },
          }),
          invalidate: ACCESS_NAMESPACE,
        })
      } catch (error) {
        // Compensation, the mirror of the one on creation: Keycloak has already
        // been flipped and the database has not, so without this the two
        // systems disagree permanently — Keycloak refusing to authenticate
        // somebody the application still lists as active, or the reverse.
        if (statusChanged) {
          await keycloakAdmin
            .setEnabled(existing.id, existing.status === 'active')
            .catch((cleanupError) => {
              ctx.log.error(
                { err: cleanupError, userId: existing.id, restoreTo: existing.status },
                'RECONCILE: could not restore the Keycloak enabled flag; ' +
                  'Keycloak and the application now disagree about this user',
              )
            })
        }
        throw error
      }

      const updated = await findUser(db, existing.id)
      if (!updated) throw notFound('User not found.')
      return updated
    },

    async remove(ctx, id) {
      const existing = await findEditableUser(id)
      assertNotSelf(ctx.access.user.id, existing.id, 'delete your own account')

      // Keycloak first, and DO NOT reorder this. An identity that can still log
      // in but has no application row is the state authenticate() already
      // refuses (403 USER_NOT_PROVISIONED), so the intermediate state is safe;
      // the reverse order leaves an account that can still authenticate.
      //
      // It is also why this needs no compensation: the Keycloak 404 below is
      // tolerated, so the whole operation is idempotent and simply calling
      // DELETE again finishes the job.
      try {
        await keycloakAdmin.deleteUser(existing.id)
      } catch (error) {
        if (!(error instanceof KeycloakAdminError && error.status === 404)) {
          mapKeycloakError(error)
        }
      }

      try {
        await mutate(deps, {
          run: (client) => deleteUserRow(client, existing.id),
          audit: () => ({
            actorId: ctx.actorId,
            action: 'user.deleted',
            entity: 'user',
            entityId: existing.id,
            payload: { username: existing.username },
          }),
          invalidate: ACCESS_NAMESPACE,
        })
      } catch (error) {
        // Retryable, but nobody retries what nobody noticed: the identity is
        // already gone from Keycloak and the row is still here, so say so
        // loudly enough to be found in the logs.
        ctx.log.error(
          { err: error, userId: existing.id, username: existing.username },
          'RECONCILE: the Keycloak identity was deleted but the application row was not; ' +
            'retry DELETE /api/users/:id to finish',
        )
        throw error
      }
    },

    async resendInvite(ctx, id) {
      const existing = await findEditableUser(id)

      const invite = await sendInvite(ctx, existing.id)

      // Not a `mutate`: nothing is written but the audit row itself, and
      // nothing derives from it, so there is no transaction and no namespace
      // to invalidate.
      //
      // And the ONLY site that audits best-effort. Everywhere else an audit
      // failure has to fail the write, because the write can still be rolled
      // back; here the email is already gone and there is nothing to roll back
      // into. Propagating would answer 500 for an invitation that was
      // delivered, and the natural response to that 500 is to press the button
      // again and send a second one.
      await recordAuditBestEffort(
        db,
        {
          actorId: ctx.actorId,
          action: 'user.invite_resent',
          entity: 'user',
          entityId: existing.id,
          payload: { sent: invite.sent },
        },
        ctx.log,
      )

      return invite
    },
  }
}
