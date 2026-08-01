import { config } from '../config'
import { getAccessToken } from '../auth/keycloak'
import { translateActive } from '../i18n'
import { isRecord, readRecord, readString } from '../lib/types'

/** Value of the `X-Cache` header the API returns on list endpoints. */
export type CacheStatus = 'HIT' | 'MISS' | null

/** API error with the `{ error: { code, message } }` envelope already read. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }

  get isForbidden(): boolean {
    return this.status === 403
  }

  get isUnauthorized(): boolean {
    return this.status === 401
  }
}

function buildUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${config.apiUrl}${path.startsWith('/') ? path : `/${path}`}`
}

/** Reads the `X-Cache` header; `null` when the API does not expose it over CORS. */
export function readCacheHeader(response: Response): CacheStatus {
  const raw = response.headers.get('X-Cache')
  if (raw === null) return null
  const value = raw.trim().toUpperCase()
  if (value === 'HIT') return 'HIT'
  if (value === 'MISS') return 'MISS'
  return null
}

/** Turns an error response into an `ApiError`. */
async function toApiError(response: Response): Promise<ApiError> {
  let code = 'http_error'
  let message = translateActive('error.httpStatus', { status: response.status })
  try {
    const payload: unknown = await response.json()
    if (isRecord(payload)) {
      // Standard `{ error: { code, message } }` envelope, with a fallback for
      // responses that put the fields at the root.
      const envelope = readRecord(payload, 'error') ?? payload
      code = readString(envelope, 'code') ?? code
      message = readString(envelope, 'message') ?? message
    }
  } catch {
    // The response was not JSON: keep the generic message.
  }
  return new ApiError(response.status, code, message)
}

/**
 * Authenticated request that returns the raw `Response`.
 * This is the one attachment downloads use.
 */
export async function apiFetchRaw(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken()
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)

  // With FormData the browser has to set the `boundary`: leave Content-Type alone.
  const body = init.body
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData
  if (body !== undefined && body !== null && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  let response: Response
  try {
    response = await fetch(buildUrl(path), { ...init, headers })
  } catch {
    throw new ApiError(0, 'network_error', translateActive('error.network'))
  }

  if (!response.ok) throw await toApiError(response)
  return response
}

async function parseBody<T>(response: Response): Promise<T> {
  if (response.status === 204 || response.status === 205) return undefined as T
  const text = await response.text()
  if (text.trim() === '') return undefined as T
  return JSON.parse(text) as T
}

/** Authenticated request that returns the parsed JSON body. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetchRaw(path, init)
  return parseBody<T>(response)
}

export interface ApiResult<T> {
  data: T
  /** `X-Cache` header of the response (`null` when it is not there). */
  cache: CacheStatus
}

/** Same as `apiFetch` but exposing the `X-Cache` header. */
export async function apiFetchWithCache<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const response = await apiFetchRaw(path, init)
  const cache = readCacheHeader(response)
  const data = await parseBody<T>(response)
  return { data, cache }
}

/**
 * Message the user can act on. The 403 is the interesting case of the demo: the
 * API rejects the operation because the token is missing a client role.
 *
 * The default fallback is resolved on every call, so it always speaks the
 * language that is active right now.
 */
export function describeApiError(
  error: unknown,
  fallback = translateActive('error.unexpected'),
): string {
  if (error instanceof ApiError) {
    if (error.isForbidden) {
      return translateActive('error.forbidden', { message: error.message })
    }
    if (error.isUnauthorized) {
      return translateActive('error.unauthorized')
    }
    return error.message
  }
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return fallback
}
