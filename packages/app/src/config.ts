// SPA configuration, resolved in this order:
//   1. window.__ERP_CONFIG__  (injected by nginx in the `full` profile)
//   2. import.meta.env.VITE_* (injected by Vite from the .env at the root)
//   3. development defaults

export interface ErpConfig {
  /** Public Keycloak URL, the one the browser sees. */
  keycloakUrl: string
  /** Realm that owns the users, roles and clients. */
  keycloakRealm: string
  /** Public client of the SPA. */
  keycloakClientId: string
  /** API client: its roles are the permissions read from `resource_access`. */
  apiClientId: string
  /** Base URL of the REST API. */
  apiUrl: string
}

declare global {
  interface Window {
    __ERP_CONFIG__?: Record<string, string | undefined>
  }
}

const DEFAULTS: ErpConfig = {
  keycloakUrl: 'http://localhost:8080',
  keycloakRealm: 'erp',
  keycloakClientId: 'erp-app',
  apiClientId: 'erp-api',
  apiUrl: 'http://localhost:3000',
}

/**
 * Looks a value up in the runtime configuration. Several key aliases are
 * accepted so we do not depend on how the nginx script spells the global object.
 */
function fromRuntime(...keys: readonly string[]): string | undefined {
  const source = window.__ERP_CONFIG__
  if (source === undefined) return undefined
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function fromEnv(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Drops the trailing slash so paths can be concatenated without doubling it. */
function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.replace(/\/+$/, '') : value
}

export const config: ErpConfig = {
  keycloakUrl: stripTrailingSlash(
    fromRuntime('keycloakUrl', 'KEYCLOAK_URL', 'VITE_KEYCLOAK_URL') ??
      fromEnv(import.meta.env.VITE_KEYCLOAK_URL) ??
      DEFAULTS.keycloakUrl,
  ),
  keycloakRealm:
    fromRuntime('keycloakRealm', 'KEYCLOAK_REALM', 'VITE_KEYCLOAK_REALM') ??
    fromEnv(import.meta.env.VITE_KEYCLOAK_REALM) ??
    DEFAULTS.keycloakRealm,
  keycloakClientId:
    fromRuntime('keycloakClientId', 'KEYCLOAK_CLIENT_ID', 'VITE_KEYCLOAK_CLIENT_ID') ??
    fromEnv(import.meta.env.VITE_KEYCLOAK_CLIENT_ID) ??
    DEFAULTS.keycloakClientId,
  apiClientId:
    fromRuntime('apiClientId', 'KEYCLOAK_API_CLIENT_ID', 'VITE_KEYCLOAK_API_CLIENT_ID') ??
    fromEnv(import.meta.env.VITE_KEYCLOAK_API_CLIENT_ID) ??
    DEFAULTS.apiClientId,
  apiUrl: stripTrailingSlash(
    fromRuntime('apiUrl', 'API_URL', 'VITE_API_URL') ??
      fromEnv(import.meta.env.VITE_API_URL) ??
      DEFAULTS.apiUrl,
  ),
}
