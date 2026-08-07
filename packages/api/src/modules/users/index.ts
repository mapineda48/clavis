// System users: created FROM the application. The API registers the user in
// Keycloak (which owns credentials and sessions) and stores the id Keycloak
// assigned, the minimal profile and the role assignments.
import type { FastifyPluginAsync } from 'fastify'
// Pulls in the @fastify/swagger type augmentation (tags, summary, security inside `schema`).
import type {} from '@fastify/swagger'
import { ACCESS_NAMESPACE, contextHasPermission } from '../../lib/access.js'
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js'
import { mutate } from '../../lib/mutate.js'
import { KeycloakAdminError } from '../../plugins/keycloak-admin.js'
import { recordAudit } from '../shared/audit.js'
import { errorResponses } from '../shared/schemas.js'
import {
  findUser,
  insertUser,
  listUsers,
  missingRoles,
  replaceRoles,
  takenField,
  type UserRecord,
} from './repository.js'

interface ListQueryInput {
  limit?: number
}

interface CreateUserInput {
  email: string
  displayName: string
  username?: string
  roles?: string[]
  credentialMode: 'temporary_password' | 'invite'
  temporaryPassword?: string
}

interface UpdateUserInput {
  displayName?: string
  status?: 'active' | 'disabled'
  roles?: string[]
}

interface IdParamsInput {
  id: string
}

const UserSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    username: { type: 'string' },
    email: { type: 'string' },
    displayName: { type: ['string', 'null'] },
    isRoot: { type: 'boolean' },
    status: { type: 'string', enum: ['active', 'disabled'] },
    roles: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string' },
    lastSeenAt: { type: ['string', 'null'] },
  },
  required: [
    'id',
    'username',
    'email',
    'displayName',
    'isRoot',
    'status',
    'roles',
    'createdAt',
    'lastSeenAt',
  ],
}

// No `total`: it used to be `items.length` after a LIMIT, which reports the
// page size as the collection size. A real total needs its own COUNT, and the
// listing needs a pagination policy before it needs one of those.
const UsersResponse = {
  type: 'object',
  properties: {
    items: { type: 'array', items: UserSchema },
  },
  required: ['items'],
}

const InviteSchema = {
  type: 'object',
  properties: {
    sent: { type: 'boolean' },
    reason: { type: ['string', 'null'], description: 'Why the invitation email did not go out' },
  },
  required: ['sent', 'reason'],
}

const CreateUserBody = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'displayName', 'credentialMode'],
  properties: {
    email: { type: 'string', format: 'email', maxLength: 255 },
    displayName: { type: 'string', minLength: 1, maxLength: 255 },
    username: {
      type: 'string',
      minLength: 3,
      maxLength: 255,
      pattern: '^[a-z0-9._-]+$',
      description: 'Defaults to the local part of the email',
    },
    roles: { type: 'array', items: { type: 'string' }, default: [] },
    credentialMode: {
      type: 'string',
      enum: ['temporary_password', 'invite'],
      description:
        'temporary_password: the admin sets a first password the user must change at first login. ' +
        'invite: Keycloak emails the user a link to set their own password.',
    },
    temporaryPassword: { type: 'string', minLength: 8, maxLength: 255 },
  },
}

const UpdateUserBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 255 },
    status: { type: 'string', enum: ['active', 'disabled'] },
    roles: { type: 'array', items: { type: 'string' } },
  },
}

const IdParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
}

/** Converts a pg timestamptz to ISO 8601. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function serializeUser(row: UserRecord) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    isRoot: row.is_root,
    status: row.status,
    roles: row.roles,
    createdAt: toIso(row.created_at),
    lastSeenAt: row.last_seen_at === null ? null : toIso(row.last_seen_at),
  }
}

/**
 * Which fields of an update nobody may apply to their own account.
 *
 * Editing one's own `displayName` stays allowed: it carries no privilege.
 * `roles` and `status` do — self-granting a role is escalation and
 * self-disabling is a lockout — so they need a second pair of hands.
 */
function selfBlockedFields(body: UpdateUserInput): string[] {
  const blocked: string[] = []
  if (body.roles !== undefined) blocked.push('roles')
  if (body.status !== undefined) blocked.push('status')
  return blocked
}

/**
 * Role assignment is an `access:*` operation reached through a `users:*` route.
 *
 * `requirePermissions` is a static preHandler and cannot look at the body, so
 * the rule lives in the handler. Without it `users:update` alone would be
 * enough to hand any account the `admin` role — which boot seeding fills with
 * the whole catalog — and the catalog's split between `users:*` and `access:*`
 * would exist only on paper.
 */
function assertMayAssignRoles(access: Parameters<typeof contextHasPermission>[0]): void {
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

export const usersRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: ListQueryInput }>(
    '/users',
    {
      preHandler: [app.authenticate, app.requirePermissions('users:read')],
      schema: {
        tags: ['users'],
        summary: 'List system users',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          },
        },
        response: { 200: UsersResponse, ...errorResponses(401, 403) },
      },
    },
    async (request) => {
      const rows = await listUsers(app.db, request.query.limit ?? 100)
      return { items: rows.map(serializeUser) }
    },
  )

  app.post<{ Body: CreateUserInput }>(
    '/users',
    {
      preHandler: [app.authenticate, app.requirePermissions('users:create')],
      schema: {
        tags: ['users'],
        summary: 'Create a system user',
        description:
          'Registers the user in Keycloak first (which assigns the id and owns the credentials), ' +
          'then stores the application user and their roles. If the database write fails the ' +
          'Keycloak user is deleted again, so the two systems cannot drift on creation. ' +
          'A non-empty `roles` additionally requires `access:manage`.',
        security: [{ bearerAuth: [] }],
        body: CreateUserBody,
        response: {
          201: {
            type: 'object',
            properties: { user: UserSchema, invite: InviteSchema },
            required: ['user', 'invite'],
          },
          ...errorResponses(400, 401, 403, 409),
        },
      },
    },
    async (request, reply) => {
      const body = request.body
      const email = body.email.trim().toLowerCase()
      const username = (body.username ?? email.split('@')[0] ?? '').trim().toLowerCase()
      const roles = [...new Set(body.roles ?? [])]

      if (username.length < 3) {
        throw badRequest('The username must be at least 3 characters long.')
      }
      if (body.credentialMode === 'temporary_password' && !body.temporaryPassword) {
        throw badRequest('temporaryPassword is required when credentialMode is temporary_password.')
      }
      // Same rule as PATCH: creating an account already holding `admin` and
      // knowing its temporary password is the escalation PATCH no longer allows.
      if (roles.length > 0) {
        assertMayAssignRoles(request.access)
      }

      const unknownRoles = await missingRoles(app.db, roles)
      if (unknownRoles.length > 0) {
        throw badRequest(`Unknown roles: ${unknownRoles.join(', ')}.`, 'UNKNOWN_ROLES')
      }
      const taken = await takenField(app.db, email, username)
      if (taken !== null) {
        throw conflict(`A user with that ${taken} already exists.`, 'USER_EXISTS')
      }

      // Keycloak first: it owns the id. UPDATE_PASSWORD arrives either as an
      // explicit required action (invite) or implicitly with the temporary
      // password Keycloak itself flags.
      let keycloakId: string
      try {
        keycloakId = await app.keycloakAdmin.createUser({
          username,
          email,
          firstName: body.displayName,
          emailVerified: true,
          enabled: true,
          requiredActions: body.credentialMode === 'invite' ? ['UPDATE_PASSWORD'] : [],
        })
        if (body.credentialMode === 'temporary_password') {
          await app.keycloakAdmin.setPassword(keycloakId, body.temporaryPassword as string, true)
        }
      } catch (error) {
        mapKeycloakError(error)
      }

      try {
        // The row, its roles and the audit entry share one transaction. The
        // Keycloak calls are deliberately outside it: no network I/O to another
        // system while a transaction is open.
        await mutate(app, {
          run: (client) =>
            insertUser(client, {
              id: keycloakId,
              username,
              email,
              displayName: body.displayName,
              roles,
            }),
          audit: () => ({
            actorId: request.auth.sub,
            action: 'user.created',
            entity: 'user',
            entityId: keycloakId,
            payload: { username, email, roles, credentialMode: body.credentialMode },
          }),
          invalidate: ACCESS_NAMESPACE,
        })
      } catch (error) {
        // Compensation: without the application row the Keycloak user is an
        // orphan that would block the username forever.
        await app.keycloakAdmin.deleteUser(keycloakId).catch((cleanupError) => {
          request.log.error({ err: cleanupError, keycloakId }, 'Could not clean up the Keycloak user')
        })
        throw error
      }

      // The invitation email must not undo the creation: report instead.
      const invite = { sent: false, reason: null as string | null }
      if (body.credentialMode === 'invite') {
        try {
          await app.keycloakAdmin.sendExecuteActionsEmail(keycloakId, ['UPDATE_PASSWORD'])
          invite.sent = true
        } catch (error) {
          invite.reason = error instanceof Error ? error.message : 'unknown error'
          request.log.warn({ err: error, keycloakId }, 'The invitation email could not be sent')
        }
      }

      const created = await findUser(app.db, keycloakId)
      if (!created) throw new AppError(500, 'INTERNAL_ERROR', 'The user vanished after creation.')
      return reply.code(201).send({ user: serializeUser(created), invite })
    },
  )

  app.patch<{ Params: IdParamsInput; Body: UpdateUserInput }>(
    '/users/:id',
    {
      preHandler: [app.authenticate, app.requirePermissions('users:update')],
      schema: {
        tags: ['users'],
        summary: 'Update a user: profile, status or roles',
        description:
          'Disabling a user also disables them in Keycloak. The root user cannot be edited here. ' +
          'Changing `roles` additionally requires `access:manage`, and nobody may change their ' +
          'own roles or status.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: UpdateUserBody,
        response: {
          200: { type: 'object', properties: { user: UserSchema }, required: ['user'] },
          ...errorResponses(400, 401, 403, 404, 409),
        },
      },
    },
    async (request) => {
      const existing = await findUser(app.db, request.params.id)
      if (!existing) throw notFound('User not found.')
      if (existing.is_root) {
        throw forbidden('The root user is managed by the deployment, not by the API.', 'ROOT_IMMUTABLE')
      }

      const body = request.body
      if (existing.id === request.auth.sub) {
        const blocked = selfBlockedFields(body)
        if (blocked.length > 0) {
          throw forbidden(
            `You cannot change your own ${blocked.join(' or ')}; another administrator has to.`,
            'SELF_MODIFICATION',
          )
        }
      }
      if (body.roles !== undefined) {
        assertMayAssignRoles(request.access)
        const unknownRoles = await missingRoles(app.db, body.roles)
        if (unknownRoles.length > 0) {
          throw badRequest(`Unknown roles: ${unknownRoles.join(', ')}.`, 'UNKNOWN_ROLES')
        }
      }

      // Keycloak first, so a refusal leaves the database untouched. Outside the
      // transaction on purpose: no network I/O to another system while one is
      // open. The flag is remembered so the write below can undo it.
      const statusChanged = body.status !== undefined && body.status !== existing.status
      if (statusChanged) {
        try {
          await app.keycloakAdmin.setEnabled(existing.id, body.status === 'active')
        } catch (error) {
          mapKeycloakError(error)
        }
      }

      try {
        await mutate(app, {
          run: async (client) => {
            if (body.displayName !== undefined || body.status !== undefined) {
              await client.query(
                `UPDATE clavis.users
                    SET display_name = COALESCE($2, display_name),
                        status = COALESCE($3, status)
                  WHERE id = $1`,
                [existing.id, body.displayName ?? null, body.status ?? null],
              )
            }
            if (body.roles !== undefined) {
              await replaceRoles(client, existing.id, [...new Set(body.roles)])
            }
          },
          audit: () => ({
            actorId: request.auth.sub,
            action: 'user.updated',
            entity: 'user',
            entityId: existing.id,
            payload: { changes: body },
          }),
          invalidate: ACCESS_NAMESPACE,
        })
      } catch (error) {
        // Compensation, the mirror of the one on creation: Keycloak has already
        // been flipped and the database has not, so without this the two
        // systems disagree permanently — Keycloak refusing to authenticate
        // somebody the application still lists as active, or the reverse.
        if (statusChanged) {
          await app.keycloakAdmin
            .setEnabled(existing.id, existing.status === 'active')
            .catch((cleanupError) => {
              request.log.error(
                { err: cleanupError, userId: existing.id, restoreTo: existing.status },
                'RECONCILE: could not restore the Keycloak enabled flag; ' +
                  'Keycloak and the application now disagree about this user',
              )
            })
        }
        throw error
      }

      const updated = await findUser(app.db, existing.id)
      if (!updated) throw notFound('User not found.')
      return { user: serializeUser(updated) }
    },
  )

  app.delete<{ Params: IdParamsInput }>(
    '/users/:id',
    {
      preHandler: [app.authenticate, app.requirePermissions('users:delete')],
      schema: {
        tags: ['users'],
        summary: 'Delete a user',
        description:
          'Removes the user from Keycloak and from the application; role assignments and ' +
          'overrides cascade away, the audit trail keeps its rows. Root cannot be deleted, ' +
          'and nobody can delete themselves.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          204: { type: 'null' },
          ...errorResponses(400, 401, 403, 404),
        },
      },
    },
    async (request, reply) => {
      const existing = await findUser(app.db, request.params.id)
      if (!existing) throw notFound('User not found.')
      if (existing.is_root) {
        throw forbidden('The root user is managed by the deployment, not by the API.', 'ROOT_IMMUTABLE')
      }
      if (existing.id === request.auth.sub) {
        throw forbidden(
          'You cannot delete your own account; another administrator has to.',
          'SELF_MODIFICATION',
        )
      }

      // Keycloak first, and DO NOT reorder this. An identity that can still log
      // in but has no application row is the state authenticate() already
      // refuses (403 USER_NOT_PROVISIONED), so the intermediate state is safe;
      // the reverse order leaves an account that can still authenticate.
      //
      // It is also why this needs no compensation: the Keycloak 404 below is
      // tolerated, so the whole handler is idempotent and simply calling
      // DELETE again finishes the job.
      try {
        await app.keycloakAdmin.deleteUser(existing.id)
      } catch (error) {
        if (!(error instanceof KeycloakAdminError && error.status === 404)) {
          mapKeycloakError(error)
        }
      }

      try {
        await mutate(app, {
          run: (client) => client.query(`DELETE FROM clavis.users WHERE id = $1`, [existing.id]),
          audit: () => ({
            actorId: request.auth.sub,
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
        request.log.error(
          { err: error, userId: existing.id, username: existing.username },
          'RECONCILE: the Keycloak identity was deleted but the application row was not; ' +
            'retry DELETE /api/users/:id to finish',
        )
        throw error
      }

      return reply.code(204).send()
    },
  )

  app.post<{ Params: IdParamsInput }>(
    '/users/:id/resend-invite',
    {
      preHandler: [app.authenticate, app.requirePermissions('users:update')],
      schema: {
        tags: ['users'],
        summary: 'Resend the set-your-password invitation email',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          200: {
            type: 'object',
            properties: { invite: InviteSchema },
            required: ['invite'],
          },
          ...errorResponses(400, 401, 403, 404),
        },
      },
    },
    async (request) => {
      const existing = await findUser(app.db, request.params.id)
      if (!existing) throw notFound('User not found.')
      if (existing.is_root) {
        throw forbidden('The root user is managed by the deployment, not by the API.', 'ROOT_IMMUTABLE')
      }

      const invite = { sent: false, reason: null as string | null }
      try {
        await app.keycloakAdmin.sendExecuteActionsEmail(existing.id, ['UPDATE_PASSWORD'])
        invite.sent = true
      } catch (error) {
        invite.reason = error instanceof Error ? error.message : 'unknown error'
        request.log.warn({ err: error, userId: existing.id }, 'The invitation email could not be sent')
      }

      // Not a `mutate`: nothing is written but the audit row itself, and
      // nothing derives from it, so there is no transaction and no namespace
      // to invalidate.
      await recordAudit(app.db, {
        actorId: request.auth.sub,
        action: 'user.invite_resent',
        entity: 'user',
        entityId: existing.id,
        payload: { sent: invite.sent },
      })

      return { invite }
    },
  )
}
