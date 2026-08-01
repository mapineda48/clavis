import Keycloak from 'keycloak-js'
import type { KeycloakInitOptions } from 'keycloak-js'
import { config } from '../config'
import { translateActive } from '../i18n'

/**
 * Single Keycloak instance for the whole application.
 * It is created at module level so it survives React remounts.
 */
export const keycloak = new Keycloak({
  url: config.keycloakUrl,
  realm: config.keycloakRealm,
  clientId: config.keycloakClientId,
})

const INIT_OPTIONS: KeycloakInitOptions = {
  // `check-sso` does not redirect: it checks the session in a hidden iframe and
  // leaves the user on the SPA login screen if they are not authenticated yet.
  onLoad: 'check-sso',
  pkceMethod: 'S256',
  checkLoginIframe: false,
  silentCheckSsoRedirectUri: `${window.location.origin}/silent-check-sso.html`,
  enableLogging: import.meta.env.DEV,
}

/**
 * Memoised `init` promise.
 * React 19 runs effects twice in StrictMode and `keycloak.init()` throws when
 * called more than once, so the first call wins and everybody else reuses its
 * result.
 */
let initPromise: Promise<boolean> | null = null

export function initKeycloak(): Promise<boolean> {
  if (initPromise === null) {
    initPromise = keycloak.init(INIT_OPTIONS).catch((error: unknown) => {
      // If Keycloak is unreachable we would rather start in "no session" mode
      // than break the React tree with a rejected promise.
      console.error('[auth] could not initialise Keycloak', error)
      return false
    })
  }
  return initPromise
}

/**
 * Returns a valid access token, refreshing it when it has less than
 * `minValiditySeconds` seconds of life left.
 */
export async function getAccessToken(minValiditySeconds = 30): Promise<string> {
  if (keycloak.authenticated !== true) {
    throw new Error(translateActive('error.noSession'))
  }
  try {
    await keycloak.updateToken(minValiditySeconds)
  } catch {
    throw new Error(translateActive('error.sessionExpired'))
  }
  const token = keycloak.token
  if (token === undefined || token === '') {
    throw new Error(translateActive('error.noAccessToken'))
  }
  return token
}
