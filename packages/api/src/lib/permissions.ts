/**
 * Catálogo de permisos del ERP. Coinciden uno a uno con los *client roles* del
 * cliente `erp-api` en Keycloak y llegan en el token dentro de
 * `resource_access["erp-api"].roles`.
 */
export const PERMISSIONS = [
  'todos:read',
  'todos:read:all',
  'todos:write',
  'todos:delete',
  'users:read',
  'admin:manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]

/** Contexto de autenticación que se cuelga de `request.auth`. */
export interface AuthContext {
  sub: string
  username: string
  email: string | null
  name: string | null
  realmRoles: string[]
  permissions: Permission[]
  token: string
}

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS)

/** Indica si una cadena cualquiera es un permiso conocido del catálogo. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value)
}

/** Comprueba que el usuario autenticado tenga un permiso concreto. */
export function hasPermission(auth: AuthContext, perm: Permission): boolean {
  return auth.permissions.includes(perm)
}

/** `true` si el usuario puede ver las tareas de todo el mundo. */
export function canSeeAllTodos(auth: AuthContext): boolean {
  return hasPermission(auth, 'todos:read:all')
}

/**
 * Extrae los permisos del payload del access token.
 * Lee `resource_access[audience].roles` y descarta cualquier rol que no
 * pertenezca al catálogo `PERMISSIONS`.
 */
export function extractPermissions(tokenPayload: unknown, audience: string): Permission[] {
  if (typeof tokenPayload !== 'object' || tokenPayload === null) return []

  const resourceAccess = (tokenPayload as Record<string, unknown>)['resource_access']
  if (typeof resourceAccess !== 'object' || resourceAccess === null) return []

  const client = (resourceAccess as Record<string, unknown>)[audience]
  if (typeof client !== 'object' || client === null) return []

  const roles = (client as Record<string, unknown>)['roles']
  if (!Array.isArray(roles)) return []

  const found: Permission[] = []
  for (const role of roles) {
    if (isPermission(role) && !found.includes(role)) found.push(role)
  }
  return found
}

/** Extrae los roles de realm (`realm_access.roles`) del payload del token. */
export function extractRealmRoles(tokenPayload: unknown): string[] {
  if (typeof tokenPayload !== 'object' || tokenPayload === null) return []

  const realmAccess = (tokenPayload as Record<string, unknown>)['realm_access']
  if (typeof realmAccess !== 'object' || realmAccess === null) return []

  const roles = (realmAccess as Record<string, unknown>)['roles']
  if (!Array.isArray(roles)) return []

  return roles.filter((role): role is string => typeof role === 'string')
}
