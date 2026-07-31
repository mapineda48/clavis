import { config } from '../config'
import { getAccessToken } from '../auth/keycloak'
import { isRecord, readRecord, readString } from '../lib/types'

/** Valor de la cabecera `X-Cache` que devuelve la API en los listados. */
export type CacheStatus = 'HIT' | 'MISS' | null

/** Error de la API con el sobre `{ error: { code, message } }` ya interpretado. */
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

/** Lee la cabecera `X-Cache`; devuelve `null` si la API no la expone via CORS. */
export function readCacheHeader(response: Response): CacheStatus {
  const raw = response.headers.get('X-Cache')
  if (raw === null) return null
  const value = raw.trim().toUpperCase()
  if (value === 'HIT') return 'HIT'
  if (value === 'MISS') return 'MISS'
  return null
}

/** Traduce una respuesta de error en un `ApiError`. */
async function toApiError(response: Response): Promise<ApiError> {
  let code = 'http_error'
  let message = `La API ha respondido con un error ${response.status}.`
  try {
    const payload: unknown = await response.json()
    if (isRecord(payload)) {
      // Sobre estandar `{ error: { code, message } }`, con respaldo por si la
      // respuesta trae los campos en la raiz.
      const envelope = readRecord(payload, 'error') ?? payload
      code = readString(envelope, 'code') ?? code
      message = readString(envelope, 'message') ?? message
    }
  } catch {
    // La respuesta no era JSON: nos quedamos con el mensaje generico.
  }
  return new ApiError(response.status, code, message)
}

/**
 * Peticion autenticada que devuelve la `Response` sin interpretar.
 * Es la que usan las descargas de adjuntos.
 */
export async function apiFetchRaw(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken()
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)

  // Con FormData el navegador debe poner el `boundary`: no tocamos Content-Type.
  const body = init.body
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData
  if (body !== undefined && body !== null && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  let response: Response
  try {
    response = await fetch(buildUrl(path), { ...init, headers })
  } catch {
    throw new ApiError(
      0,
      'network_error',
      'No se ha podido contactar con la API. Comprueba que el servicio esta levantado.',
    )
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

/** Peticion autenticada que devuelve el cuerpo JSON ya interpretado. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetchRaw(path, init)
  return parseBody<T>(response)
}

export interface ApiResult<T> {
  data: T
  /** Cabecera `X-Cache` de la respuesta (`null` si no viene). */
  cache: CacheStatus
}

/** Igual que `apiFetch` pero exponiendo la cabecera `X-Cache`. */
export async function apiFetchWithCache<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const response = await apiFetchRaw(path, init)
  const cache = readCacheHeader(response)
  const data = await parseBody<T>(response)
  return { data, cache }
}

/**
 * Mensaje legible para el usuario. El 403 es el caso interesante de la demo:
 * la API rechaza la operacion porque al token le falta un client role.
 */
export function describeApiError(error: unknown, fallback = 'Se ha producido un error inesperado.'): string {
  if (error instanceof ApiError) {
    if (error.isForbidden) {
      return `Permiso insuficiente: ${error.message}`
    }
    if (error.isUnauthorized) {
      return 'Tu sesion no es valida o ha caducado. Vuelve a iniciar sesion.'
    }
    return error.message
  }
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return fallback
}
