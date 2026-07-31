import Keycloak from 'keycloak-js'
import type { KeycloakInitOptions } from 'keycloak-js'
import { config } from '../config'

/**
 * Instancia unica de Keycloak para toda la aplicacion.
 * Se crea a nivel de modulo para que sobreviva a los remontajes de React.
 */
export const keycloak = new Keycloak({
  url: config.keycloakUrl,
  realm: config.keycloakRealm,
  clientId: config.keycloakClientId,
})

const INIT_OPTIONS: KeycloakInitOptions = {
  // `check-sso` no redirige: comprueba la sesion en un iframe oculto y deja al
  // usuario en la pantalla de login de la SPA si aun no se ha autenticado.
  onLoad: 'check-sso',
  pkceMethod: 'S256',
  checkLoginIframe: false,
  silentCheckSsoRedirectUri: `${window.location.origin}/silent-check-sso.html`,
  enableLogging: import.meta.env.DEV,
}

/**
 * Promesa memorizada del `init`.
 * React 19 en StrictMode ejecuta los efectos dos veces y `keycloak.init()`
 * lanza un error si se invoca mas de una vez, asi que la primera llamada gana
 * y el resto reutiliza su resultado.
 */
let initPromise: Promise<boolean> | null = null

export function initKeycloak(): Promise<boolean> {
  if (initPromise === null) {
    initPromise = keycloak.init(INIT_OPTIONS).catch((error: unknown) => {
      // Si Keycloak no responde preferimos arrancar en modo "sin sesion" antes
      // que romper el arbol de React con una promesa rechazada.
      console.error('[auth] no se ha podido inicializar Keycloak', error)
      return false
    })
  }
  return initPromise
}

/**
 * Devuelve un access token valido, refrescandolo si le quedan menos de
 * `minValiditySeconds` segundos de vida.
 */
export async function getAccessToken(minValiditySeconds = 30): Promise<string> {
  if (keycloak.authenticated !== true) {
    throw new Error('No hay una sesion activa en Keycloak.')
  }
  try {
    await keycloak.updateToken(minValiditySeconds)
  } catch {
    throw new Error('La sesion ha caducado. Vuelve a iniciar sesion.')
  }
  const token = keycloak.token
  if (token === undefined || token === '') {
    throw new Error('Keycloak no ha devuelto un token de acceso.')
  }
  return token
}
