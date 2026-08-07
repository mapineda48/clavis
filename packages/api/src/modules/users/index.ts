// System users: created FROM the application. The API registers the user in
// Keycloak (which owns credentials and sessions) and stores the id Keycloak
// assigned, the minimal profile and the role assignments.
import type { FastifyPluginAsync } from 'fastify'
// Pulls in the @fastify/swagger type augmentation (tags, summary, security inside `schema`).
import type {} from '@fastify/swagger'
import { ACCESS_NAMESPACE } from '../../lib/access.js'
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js'
import { KeycloakAdminError } from '../../plugins/keycloak-admin.js'
import { recordAudit } from '../shared/audit.js'
import { ErrorResponse } from '../shared/schemas.js'
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

const UsersResponse = {
  type: 'object',
  properties: {
    items: { type: 'array', items: UserSchema },
    total: { type: 'integer' },
  },
  required: ['items', 'total'],
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
        response: { 200: UsersResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request) => {
      const rows = await listUsers(app.db, request.query.limit ?? 100)
      return { items: rows.map(serializeUser), total: rows.length }
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
          'Keycloak user is deleted again, so the two systems cannot drift on creation.',
        security: [{ bearerAuth: [] }],
        body: CreateUserBody,
        response: {
          201: {
            type: 'object',
            properties: { user: UserSchema, invite: InviteSchema },
            required: ['user', 'invite'],
          },
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
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
        await insertUser(app.db, { id: keycloakId, username, email, displayName: body.displayName, roles })
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

      await recordAudit(
        app.db,
        {
          actorId: request.auth.sub,
          action: 'user.created',
          entity: 'user',
          entityId: keycloakId,
          payload: { username, email, roles, credentialMode: body.credentialMode },
        },
        request.log,
      )
      await app.cache.bumpVersion(ACCESS_NAMESPACE)

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
          'Disabling a user also disables them in Keycloak. The root user cannot be edited here.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: UpdateUserBody,
        response: {
          200: { type: 'object', properties: { user: UserSchema }, required: ['user'] },
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
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
      if (body.roles !== undefined) {
        const unknownRoles = await missingRoles(app.db, body.roles)
        if (unknownRoles.length > 0) {
          throw badRequest(`Unknown roles: ${unknownRoles.join(', ')}.`, 'UNKNOWN_ROLES')
        }
      }

      // Keycloak first, so a refusal leaves the database untouched.
      if (body.status !== undefined && body.status !== existing.status) {
        try {
          await app.keycloakAdmin.setEnabled(existing.id, body.status === 'active')
        } catch (error) {
          mapKeycloakError(error)
        }
      }

      await app.db.tx(async (client) => {
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
      })

      await recordAudit(
        app.db,
        {
          actorId: request.auth.sub,
          action: 'user.updated',
          entity: 'user',
          entityId: existing.id,
          payload: { changes: body },
        },
        request.log,
      )
      await app.cache.bumpVersion(ACCESS_NAMESPACE)

      const updated = await findUser(app.db, existing.id)
      if (!updated) throw notFound('User not found.')
      return { user: serializeUser(updated) }
    },
  )

  app.delete<{ Params: IdParamsInput }>(
    '/users/:id',
    {
      preHandler: [app.authenticate, app.requirePermissions('users:update')],
      schema: {
        tags: ['users'],
        summary: 'Delete a user',
        description:
          'Removes the user from Keycloak and from the application; role assignments and ' +
          'overrides cascade away, the audit trail keeps its rows. Root cannot be deleted.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          204: { type: 'null' },
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const existing = await findUser(app.db, request.params.id)
      if (!existing) throw notFound('User not found.')
      if (existing.is_root) {
        throw forbidden('The root user is managed by the deployment, not by the API.', 'ROOT_IMMUTABLE')
      }

      // Keycloak first: an identity that can still log in but has no
      // application row is the state authenticate() already refuses.
      try {
        await app.keycloakAdmin.deleteUser(existing.id)
      } catch (error) {
        if (!(error instanceof KeycloakAdminError && error.status === 404)) {
          mapKeycloakError(error)
        }
      }
      await app.db.query(`DELETE FROM clavis.users WHERE id = $1`, [existing.id])

      await recordAudit(
        app.db,
        {
          actorId: request.auth.sub,
          action: 'user.deleted',
          entity: 'user',
          entityId: existing.id,
          payload: { username: existing.username },
        },
        request.log,
      )
      await app.cache.bumpVersion(ACCESS_NAMESPACE)

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
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
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

      await recordAudit(
        app.db,
        {
          actorId: request.auth.sub,
          action: 'user.invite_resent',
          entity: 'user',
          entityId: existing.id,
          payload: { sent: invite.sent },
        },
        request.log,
      )

      return { invite }
    },
  )
}
