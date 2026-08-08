// Request/response schemas of the users module, and the serializer that
// produces the published shape. They live side by side because they are two
// halves of one contract: the schema is what the OpenAPI document promises,
// the serializer is what actually leaves the process, and the unit tests
// assert they agree field for field — nothing at runtime filters a response
// against its schema any more, so the test is the guarantee.
import { toIso } from '../shared/serialize.js'
import type { UserRecord } from './repository.js'

export interface ListQueryInput {
  limit?: number
}

export interface CreateUserInput {
  email: string
  displayName: string
  username?: string
  roles?: string[]
  credentialMode: 'temporary_password' | 'invite'
  temporaryPassword?: string
}

export interface UpdateUserInput {
  displayName?: string
  status?: 'active' | 'disabled'
  roles?: string[]
}

/**
 * The user shape every response declares.
 *
 * Exported so a test can compare it against `serializeUser` rather than
 * against a copy of the field list: a field added to one alone either
 * vanishes from the documentation or ships undocumented, and the test is
 * what makes either drift fail loudly.
 */
export const UserSchema = {
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
export const UsersResponse = {
  type: 'object',
  properties: {
    items: { type: 'array', items: UserSchema },
  },
  required: ['items'],
}

export const InviteSchema = {
  type: 'object',
  properties: {
    sent: { type: 'boolean' },
    reason: { type: ['string', 'null'], description: 'Why the invitation email did not go out' },
  },
  required: ['sent', 'reason'],
}

export const CreateUserBody = {
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

export const UpdateUserBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 255 },
    status: { type: 'string', enum: ['active', 'disabled'] },
    roles: { type: 'array', items: { type: 'string' } },
  },
}

export const ListUsersQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
  },
}

export function serializeUser(row: UserRecord) {
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
