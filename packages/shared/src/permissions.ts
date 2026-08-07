/**
 * The permission catalog — the single source of truth for authorization keys.
 *
 * Adding a permission to the system starts (and mostly ends) here:
 *
 *   1. Add its definition to `PERMISSION_DEFS`.
 *   2. The API boot sync upserts it into `clavis.permissions` (and deletes
 *      keys that no longer exist here, cascading their role/override rows).
 *   3. Gate the route with `app.requirePermissions('<key>')`.
 *   4. Reference it from the SPA (route guard, `NAV_ITEMS`, labels).
 *
 * Keys are `module:action` by convention, one module per API routes file.
 * The database stores ASSIGNMENTS (roles, overrides); it never invents keys.
 */

/** One catalog entry. `module` groups keys for display and for future modules. */
export interface PermissionDef {
  readonly key: string
  readonly module: string
  readonly description: string
}

export const PERMISSION_DEFS = [
  { key: 'users:read', module: 'users', description: 'List and view system users' },
  { key: 'users:create', module: 'users', description: 'Create system users' },
  { key: 'users:update', module: 'users', description: 'Edit users: status, roles and profile' },
  { key: 'access:read', module: 'access', description: 'View roles, permissions and assignments' },
  {
    key: 'access:manage',
    module: 'access',
    description: 'Manage roles and per-user permission overrides',
  },
  { key: 'audit:read', module: 'audit', description: 'Read the audit trail' },
] as const satisfies readonly PermissionDef[]

/** Union of every valid permission key, derived from the catalog. */
export type PermissionKey = (typeof PERMISSION_DEFS)[number]['key']

/** Every key, in catalog order. */
export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_DEFS.map(
  (def) => def.key,
)

const KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS)

/** Narrows an arbitrary value to a `PermissionKey`. */
export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === 'string' && KEY_SET.has(value)
}

/** Catalog modules, deduplicated, in catalog order. */
export const PERMISSION_MODULES: readonly string[] = [
  ...new Set(PERMISSION_DEFS.map((def) => def.module)),
]
