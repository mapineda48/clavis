/// <reference types="vite/client" />

// Variables de compilacion que expone Vite. Todas son opcionales porque en el
// perfil `full` la configuracion real llega en runtime via window.__ERP_CONFIG__.
interface ImportMetaEnv {
  readonly VITE_KEYCLOAK_URL?: string
  readonly VITE_KEYCLOAK_REALM?: string
  readonly VITE_KEYCLOAK_CLIENT_ID?: string
  readonly VITE_KEYCLOAK_API_CLIENT_ID?: string
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
