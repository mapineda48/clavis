// Configuracion de la SPA resuelta en este orden:
//   1. window.__ERP_CONFIG__  (lo inyecta nginx en el perfil `full`)
//   2. import.meta.env.VITE_* (lo inyecta Vite desde el .env de la raiz)
//   3. valores por defecto de desarrollo

export interface ErpConfig {
  /** URL publica de Keycloak, la que ve el navegador. */
  keycloakUrl: string
  /** Realm donde viven usuarios, roles y clientes. */
  keycloakRealm: string
  /** Cliente publico de la SPA. */
  keycloakClientId: string
  /** Cliente de la API: de el se leen los permisos en `resource_access`. */
  apiClientId: string
  /** URL base de la API REST. */
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
 * Busca un valor en la configuracion de runtime. Se aceptan varios alias de
 * clave para no depender de como escriba el script de nginx el objeto global.
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

/** Quita la barra final para poder concatenar rutas sin duplicar separadores. */
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
