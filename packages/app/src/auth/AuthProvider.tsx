import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PermissionKey } from '@clavis/shared'
import { getAccessToken, initKeycloak, keycloak } from './keycloak'
import { useMe } from '../api/me'
import type { Me } from '../api/me'
import type { ApiError } from '../api/client'
import type { Locale } from '../i18n'
import { useI18n } from '../i18n/I18nProvider'

/**
 * Session model after the authorization swap:
 *
 *   - keycloak-js answers WHO the user is (authenticated or not, tokens).
 *   - /api/me answers WHAT they may do: the application user row, the roles
 *     and the effective permissions resolved from the database.
 *
 * The token carries no permissions any more, so nothing here parses claims.
 */

export interface AuthContextValue {
  /** `false` while keycloak-js resolves the silent session check. */
  ready: boolean
  authenticated: boolean
  /** Result of /api/me. `null` until it loads (or when it is refused). */
  me: Me | null
  /** The /api/me request state the App gate renders from. */
  meStatus: 'idle' | 'loading' | 'ready' | 'blocked' | 'error'
  /** The error behind a `blocked`/`error` status, if any. */
  meError: ApiError | null
  roles: string[]
  permissions: PermissionKey[]
  isRoot: boolean
  /** Checks one or several permissions (logical AND). Root always passes. */
  has: (perm: PermissionKey | PermissionKey[]) => boolean
  login: () => void
  logout: () => void
  /** Returns a live JWT, refreshing it when it is about to expire. */
  token: () => Promise<string>
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
  const [authenticated, setAuthenticated] = useState(false)

  useEffect(() => {
    let active = true
    const sync = (): void => {
      if (active) setAuthenticated(keycloak.authenticated === true)
    }

    keycloak.onTokenExpired = () => {
      void keycloak
        .updateToken(30)
        .then(sync)
        .catch(() => {
          if (active) setAuthenticated(false)
        })
    }
    keycloak.onAuthSuccess = sync
    keycloak.onAuthRefreshSuccess = sync
    keycloak.onAuthLogout = () => {
      if (active) setAuthenticated(false)
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

  const meQuery = useMe(ready && authenticated)

  const me = meQuery.data ?? null
  const meError = meQuery.error ?? null

  const meStatus = useMemo<AuthContextValue['meStatus']>(() => {
    if (!authenticated) return 'idle'
    if (me !== null) return 'ready'
    if (meQuery.isPending) return 'loading'
    // A 403 is a decision, not a failure: disabled account or an identity the
    // application has no user for.
    if (meError !== null && meError.isForbidden) return 'blocked'
    return 'error'
  }, [authenticated, me, meQuery.isPending, meError])

  const permissions = me?.permissions ?? []
  const isRoot = me?.user.isRoot === true

  const has = useCallback(
    (perm: PermissionKey | PermissionKey[]): boolean => {
      if (isRoot) return true
      const required = Array.isArray(perm) ? perm : [perm]
      return required.every((item) => permissions.includes(item))
    },
    [isRoot, permissions],
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
    () => ({
      ready,
      authenticated,
      me,
      meStatus,
      meError,
      roles: me?.roles ?? [],
      permissions,
      isRoot,
      has,
      login,
      logout,
      token,
    }),
    [ready, authenticated, me, meStatus, meError, permissions, isRoot, has, login, logout, token],
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
