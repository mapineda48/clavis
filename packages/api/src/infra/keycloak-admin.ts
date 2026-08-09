import type { AppConfig } from '../config/env.js'
import type { Logger } from './logger.js'

/** The slice of the configuration this factory reads. */
export type KeycloakAdminOptions = Pick<
  AppConfig,
  | 'KEYCLOAK_INTERNAL_ISSUER'
  | 'KEYCLOAK_AUDIENCE'
  | 'KEYCLOAK_API_CLIENT_SECRET'
  | 'KEYCLOAK_APP_CLIENT_ID'
  | 'PUBLIC_APP_URL'
>

/**
 * Keycloak Admin REST client.
 *
 * The confidential client's service account (realm-management: manage-users,
 * view-users) authenticates with `client_credentials` against the INTERNAL
 * issuer — the same host the JWKS is fetched from — and the admin base URL is
 * derived from it: `/realms/<realm>` → `/admin/realms/<realm>`.
 *
 * Plain `fetch`, no SDK: the surface the application needs is five endpoints.
 */

/** Fields Keycloak accepts when the application registers a user. */
export interface KeycloakCreateUser {
  username: string
  email: string
  firstName?: string
  emailVerified: boolean
  enabled: boolean
  requiredActions?: string[]
}

/** The subset of the Keycloak user representation the application reads. */
export interface KeycloakUser {
  id: string
  username: string
  email: string | null
  enabled: boolean
}

/** Keycloak Admin REST client (service account of the confidential client). */
export interface KeycloakAdmin {
  /** Bounded wait until the service account can authenticate. */
  ready(attempts?: number, retryMs?: number): Promise<void>
  /** Creates a realm user and returns the id Keycloak assigned. */
  createUser(user: KeycloakCreateUser): Promise<string>
  findUserByUsername(username: string): Promise<KeycloakUser | null>
  getUser(id: string): Promise<KeycloakUser>
  setPassword(id: string, value: string, temporary: boolean): Promise<void>
  /** Sends the required-actions email (e.g. UPDATE_PASSWORD) for the user. */
  sendExecuteActionsEmail(id: string, actions: string[]): Promise<void>
  setEnabled(id: string, enabled: boolean): Promise<void>
  deleteUser(id: string): Promise<void>
}

/** Error raised by any admin call that Keycloak refused. */
export class KeycloakAdminError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'KeycloakAdminError'
    this.status = status
  }
}

interface CachedToken {
  value: string
  /** Epoch millis after which the token must not be reused. */
  staleAt: number
}

/** Derives `http(s)://host/admin/realms/<realm>` from an issuer URL. */
function adminBaseFromIssuer(issuer: string): string {
  const url = new URL(issuer)
  const match = /^(.*)\/realms\/([^/]+)\/?$/.exec(url.pathname)
  if (!match) {
    throw new Error(`The Keycloak issuer does not look like a realm URL: ${issuer}`)
  }
  return `${url.origin}${match[1]}/admin/realms/${match[2]}`
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as Record<string, unknown>
    const message = body['errorMessage'] ?? body['error_description'] ?? body['error']
    if (typeof message === 'string' && message.length > 0) return message
  } catch {
    // Non-JSON body: fall through to the status line.
  }
  return `Keycloak answered HTTP ${response.status}`
}

export function createKeycloakAdmin(options: KeycloakAdminOptions, log: Logger): KeycloakAdmin {
  const tokenUrl = `${options.KEYCLOAK_INTERNAL_ISSUER.replace(/\/+$/, '')}/protocol/openid-connect/token`
  const adminBase = adminBaseFromIssuer(options.KEYCLOAK_INTERNAL_ISSUER)

  log.info({ adminBase }, 'Keycloak Admin client configured')

  let cached: CachedToken | null = null
  let refreshing: Promise<string> | null = null

  async function requestToken(): Promise<string> {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: options.KEYCLOAK_AUDIENCE,
        client_secret: options.KEYCLOAK_API_CLIENT_SECRET,
      }),
    })
    if (!response.ok) {
      throw new KeycloakAdminError(response.status, await readErrorMessage(response))
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number }
    if (!body.access_token) {
      throw new KeycloakAdminError(500, 'The token response carried no access_token.')
    }
    // Refresh 30 s before expiry so no admin call ever rides a dying token.
    const lifetimeMs = Math.max((body.expires_in ?? 60) - 30, 10) * 1000
    cached = { value: body.access_token, staleAt: Date.now() + lifetimeMs }
    return body.access_token
  }

  /**
   * The service-account token, and whether it came from the cache.
   *
   * `fromCache` is what tells a 401 apart afterwards: a token this call just
   * minted is authoritative, a cached one may have been invalidated behind
   * our back.
   */
  async function token(): Promise<{ value: string; fromCache: boolean }> {
    if (cached && cached.staleAt > Date.now()) return { value: cached.value, fromCache: true }
    // Single flight: concurrent callers share one refresh.
    refreshing ??= requestToken().finally(() => {
      refreshing = null
    })
    return { value: await refreshing, fromCache: false }
  }

  /**
   * Drops the token that just failed and returns a usable one.
   *
   * The entry is cleared only if it is still the one that failed: a
   * concurrent 401 may already have replaced it, and discarding that fresh
   * token would send every other in-flight retry back to the token endpoint
   * for nothing. `token()` then either hands back that replacement or joins
   * the single refresh in flight, so a burst of 401s costs one grant.
   */
  async function replaceToken(used: string): Promise<string> {
    if (cached?.value === used) cached = null
    return (await token()).value
  }

  async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${adminBase}${path}`
    const send = (bearer: string): Promise<Response> =>
      fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
          ...init.headers,
        },
      })

    const { value, fromCache } = await token()
    let response = await send(value)

    // Keycloak can stop honouring a token before `staleAt` — a realm restart,
    // a revoked session — and the cache has no way to hear about it: without
    // this, every admin call answers 502 until the timer runs out on its own.
    // A 401 on a CACHED token is that signal, so the token is dropped and the
    // request replayed once. A token we minted for this very call answering
    // 401 is a real authorization failure (the service account lost a role),
    // which a retry would only double; and no other status is retried,
    // because a 409 or a 500 means Keycloak read the request. Replaying is
    // safe here because every body this client sends is a string.
    if (response.status === 401 && fromCache) {
      // Release the discarded response: an undici body left unread holds its
      // socket out of the connection pool.
      await response.body?.cancel().catch(() => undefined)
      log.warn(
        { path },
        'Keycloak rejected the cached service-account token; retrying with a new one',
      )
      response = await send(await replaceToken(value))
    }

    if (!response.ok) {
      throw new KeycloakAdminError(response.status, await readErrorMessage(response))
    }
    return response
  }

  return {
    /**
     * Bounded wait for the service account to authenticate. The compose
     * healthcheck already orders keycloak before the API, but `pnpm dev`
     * outside docker has no such guarantee.
     */
    async ready(attempts = 10, retryMs = 1500) {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          await token()
          return
        } catch (error) {
          if (attempt === attempts) throw error
          log.warn(
            { attempt, attempts, err: error },
            'Keycloak is not issuing service-account tokens yet; retrying',
          )
          await new Promise((resolve) => setTimeout(resolve, retryMs))
        }
      }
    },

    async createUser(user) {
      const response = await adminFetch('/users', {
        method: 'POST',
        body: JSON.stringify(user),
      })
      // Keycloak answers 201 with the new resource in the Location header.
      const location = response.headers.get('location') ?? ''
      const id = location.split('/').filter(Boolean).at(-1)
      if (!id) {
        throw new KeycloakAdminError(500, 'User created but no id came back in Location.')
      }
      return id
    },

    async findUserByUsername(username) {
      const query = new URLSearchParams({ username, exact: 'true' })
      const response = await adminFetch(`/users?${query}`)
      const users = (await response.json()) as KeycloakUser[]
      return users[0] ?? null
    },

    async getUser(id) {
      const response = await adminFetch(`/users/${encodeURIComponent(id)}`)
      return (await response.json()) as KeycloakUser
    },

    async setPassword(id, value, temporary) {
      await adminFetch(`/users/${encodeURIComponent(id)}/reset-password`, {
        method: 'PUT',
        body: JSON.stringify({ type: 'password', value, temporary }),
      })
    },

    async sendExecuteActionsEmail(id, actions) {
      const query = new URLSearchParams({
        client_id: options.KEYCLOAK_APP_CLIENT_ID,
        redirect_uri: options.PUBLIC_APP_URL,
      })
      await adminFetch(`/users/${encodeURIComponent(id)}/execute-actions-email?${query}`, {
        method: 'PUT',
        body: JSON.stringify(actions),
      })
    },

    async setEnabled(id, enabled) {
      // PUT replaces the fields it carries; fetching first keeps the rest intact.
      const current = await this.getUser(id)
      await adminFetch(`/users/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ ...current, enabled }),
      })
    },

    async deleteUser(id) {
      await adminFetch(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
  }
}
