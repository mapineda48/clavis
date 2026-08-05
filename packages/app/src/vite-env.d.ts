/// <reference types="vite/client" />

// Build-time variables exposed by Vite. All of them are optional: in the `full`
// profile the real configuration arrives at runtime via window.__CLAVIS_CONFIG__.
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
