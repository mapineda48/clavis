import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { config } from '../config'
import { getAccessToken, initKeycloak, keycloak } from './keycloak'
import { translateActive } from '../i18n'
import type { Locale } from '../i18n'
import { useI18n } from '../i18n/I18nProvider'
import { isPermission, isRecord, readRecord, readString, readStringArray } from '../lib/types'
import type { Permission } from '../lib/types'

/* ------------------------------------------------------------------ */
/* Reading the access token                                            */
/* ------------------------------------------------------------------ */

/** The access token claims the SPA cares about. */
interface ParsedAccessToken {
  sub: string | null
  username: string | null
  email: string | null
  name: string | null
  realmRoles: string[]
  /** Client roles indexed by `clientId` (the `resource_access` of the token). */
  clientRoles: Record<string, string[]>
}

/** Turns the `tokenParsed` of keycloak-js into a typed structure. */
function parseAccessToken(raw: unknown): ParsedAccessToken {
  const claims = isRecord(raw) ? raw : {}
  const resourceAccess = readRecord(claims, 'resource_access')
  const clientRoles: Record<string, string[]> = {}
  if (resourceAccess !== null) {
    for (const [clientId, value] of Object.entries(resourceAccess)) {
      if (!isRecord(value)) continue
      clientRoles[clientId] = readStringArray(value, 'roles')
    }
  }
  return {
    sub: readString(claims, 'sub'),
    username: readString(claims, 'preferred_username'),
    email: readString(claims, 'email'),
    name: readString(claims, 'name'),
    realmRoles: readStringArray(readRecord(claims, 'realm_access'), 'roles'),
    clientRoles,
  }
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

export interface UserProfile {
  /** The `sub` of the token, which is also the id in `clavis.users`. */
  id: string
  username: string
  email: string | null
  displayName: string
}

interface SessionState {
  authenticated: boolean
  profile: UserProfile | null
  realmRoles: string[]
  permissions: Permission[]
}

export interface AuthContextValue extends SessionState {
  /** `false` while keycloak-js resolves the silent session check. */
  ready: boolean
  /** Checks one or several permissions (logical AND). */
  has: (perm: Permission | Permission[]) => boolean
  login: () => void
  logout: () => void
  /** Returns a live JWT, refreshing it when it is about to expire. */
  token: () => Promise<string>
}

const ANONYMOUS: SessionState = {
  authenticated: false,
  profile: null,
  realmRoles: [],
  permissions: [],
}

/** Reads the session state straight from the Keycloak instance. */
function readSession(): SessionState {
  if (keycloak.authenticated !== true) return ANONYMOUS
  const claims = parseAccessToken(keycloak.tokenParsed)
  // This runs outside React, so the label comes from the active locale.
  const username = claims.username ?? translateActive('common.unknown')
  // The permissions are the client roles of the API client (`clavis-api`).
  const permissions = (claims.clientRoles[config.apiClientId] ?? []).filter(isPermission)
  return {
    authenticated: true,
    profile: {
      id: claims.sub ?? '',
      username,
      email: claims.email,
      displayName: claims.name ?? username,
    },
    realmRoles: claims.realmRoles,
    permissions,
  }
}

/**
 * Return URL that carries the chosen language back into the SPA.
 *
 * `localStorage` already remembers it, but it can be unavailable (private
 * browsing) and the sign-out endpoint has no `ui_locales` equivalent, so the
 * `?lang=` parameter is what guarantees the app comes back speaking the same
 * language the user left with.
 */
function returnUrlFor(locale: Locale): string {
  const url = new URL(window.location.origin)
  url.searchParams.set('lang', locale)
  return url.toString()
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const { locale } = useI18n()
  const [ready, setReady] = useState(false)
  const [session, setSession] = useState<SessionState>(ANONYMOUS)

  useEffect(() => {
    let active = true
    const sync = (): void => {
      if (active) setSession(readSession())
    }

    // Keycloak warns just before the token expires: we refresh it and read the
    // claims again (the roles may have changed in the meantime).
    keycloak.onTokenExpired = () => {
      void keycloak
        .updateToken(30)
        .then(sync)
        .catch(() => {
          if (active) setSession(ANONYMOUS)
        })
    }
    keycloak.onAuthSuccess = sync
    keycloak.onAuthRefreshSuccess = sync
    keycloak.onAuthLogout = () => {
      if (active) setSession(ANONYMOUS)
    }

    // `initKeycloak` is memoised: in StrictMode the second effect reuses the
    // same promise instead of calling `init()` again.
    void initKeycloak().then(() => {
      sync()
      if (active) setReady(true)
    })

    return () => {
      active = false
    }
  }, [])

  const permissions = session.permissions

  const has = useCallback(
    (perm: Permission | Permission[]): boolean => {
      const required = Array.isArray(perm) ? perm : [perm]
      return required.every((item) => permissions.includes(item))
    },
    [permissions],
  )

  const login = useCallback(() => {
    // keycloak-js maps `locale` to the OIDC `ui_locales` parameter, so the
    // Keycloak login page opens in the language the SPA is showing.
    void keycloak.login({ redirectUri: returnUrlFor(locale), locale })
  }, [locale])

  const logout = useCallback(() => {
    void keycloak.logout({ redirectUri: returnUrlFor(locale) })
  }, [locale])

  const token = useCallback((): Promise<string> => getAccessToken(30), [])

  const value = useMemo<AuthContextValue>(
    () => ({ ready, ...session, has, login, logout, token }),
    [ready, session, has, login, logout, token],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (value === null) {
    throw new Error('useAuth() must be used inside <AuthProvider>.')
  }
  return value
}
