import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { config } from '../config'
import { getAccessToken, initKeycloak, keycloak } from './keycloak'
import { isPermission, isRecord, readRecord, readString, readStringArray } from '../lib/types'
import type { Permission } from '../lib/types'

/* ------------------------------------------------------------------ */
/* Lectura del access token                                            */
/* ------------------------------------------------------------------ */

/** Reclamaciones del access token que necesita la SPA. */
interface ParsedAccessToken {
  sub: string | null
  username: string | null
  email: string | null
  name: string | null
  realmRoles: string[]
  /** Roles de cliente indexados por `clientId` (el `resource_access` del token). */
  clientRoles: Record<string, string[]>
}

/** Convierte el `tokenParsed` de keycloak-js en una estructura tipada. */
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
/* Contexto                                                            */
/* ------------------------------------------------------------------ */

export interface UserProfile {
  /** `sub` del token: es tambien el id en `erp.users`. */
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
  /** `false` mientras keycloak-js resuelve la comprobacion silenciosa de sesion. */
  ready: boolean
  /** Comprueba uno o varios permisos (AND logico). */
  has: (perm: Permission | Permission[]) => boolean
  login: () => void
  logout: () => void
  /** Devuelve un JWT vigente, refrescandolo si esta a punto de caducar. */
  token: () => Promise<string>
}

const ANONYMOUS: SessionState = {
  authenticated: false,
  profile: null,
  realmRoles: [],
  permissions: [],
}

/** Lee el estado de sesion directamente de la instancia de Keycloak. */
function readSession(): SessionState {
  if (keycloak.authenticated !== true) return ANONYMOUS
  const claims = parseAccessToken(keycloak.tokenParsed)
  const username = claims.username ?? 'desconocido'
  // Los permisos son los client roles del cliente de la API (`erp-api`).
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

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [session, setSession] = useState<SessionState>(ANONYMOUS)

  useEffect(() => {
    let active = true
    const sync = (): void => {
      if (active) setSession(readSession())
    }

    // Keycloak avisa justo antes de que caduque el token: lo refrescamos y
    // volvemos a leer las reclamaciones (los roles pueden haber cambiado).
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

    // `initKeycloak` esta memorizada: en StrictMode el segundo efecto reutiliza
    // la misma promesa en lugar de volver a llamar a `init()`.
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
    void keycloak.login({ redirectUri: window.location.origin })
  }, [])

  const logout = useCallback(() => {
    void keycloak.logout({ redirectUri: window.location.origin })
  }, [])

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
    throw new Error('useAuth() debe usarse dentro de <AuthProvider>.')
  }
  return value
}
