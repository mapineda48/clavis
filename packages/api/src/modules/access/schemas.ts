// Request/response schemas of the access module and the role serializer.
// Same contract as the users module: schemas document, serializers produce,
// and nothing at runtime filters one against the other.
import type { RoleRow } from './repository.js'

export interface OverrideInput {
  permissionKey: string
  effect: 'grant' | 'revoke'
}

export interface ReplaceOverridesInput {
  overrides: OverrideInput[]
}

export interface CreateRoleInput {
  slug: string
  name: string
  description?: string
  permissions?: string[]
}

export interface ReplacePermissionsInput {
  permissions: string[]
}

export const PermissionSchema = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    module: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['key', 'module', 'description'],
}

export const RoleSchema = {
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

export const CatalogResponse = {
  type: 'object',
  properties: {
    permissions: { type: 'array', items: PermissionSchema },
    roles: { type: 'array', items: RoleSchema },
  },
  required: ['permissions', 'roles'],
}

export const OverrideSchema = {
  type: 'object',
  properties: {
    permissionKey: { type: 'string' },
    effect: { type: 'string', enum: ['grant', 'revoke'] },
  },
  required: ['permissionKey', 'effect'],
}

export const UserAccessResponse = {
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

export const ReplaceOverridesBody = {
  type: 'object',
  additionalProperties: false,
  required: ['overrides'],
  properties: {
    overrides: { type: 'array', items: OverrideSchema },
  },
}

export const CreateRoleBody = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'name'],
  properties: {
    slug: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$' },
    name: { type: 'string', minLength: 1, maxLength: 255 },
    description: { type: 'string', maxLength: 1000 },
    permissions: { type: 'array', items: { type: 'string' }, default: [] },
  },
}

export const ReplacePermissionsBody = {
  type: 'object',
  additionalProperties: false,
  required: ['permissions'],
  properties: {
    permissions: { type: 'array', items: { type: 'string' } },
  },
}

/** The role shape the API publishes. */
export interface RoleView {
  slug: string
  name: string
  description: string | null
  isSystem: boolean
  permissions: string[]
}

export function serializeRole(row: RoleRow): RoleView {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    isSystem: row.is_system,
    permissions: row.permissions,
  }
}
