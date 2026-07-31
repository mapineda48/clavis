import { z } from 'zod'

/**
 * Configuración de la API leída de `process.env` y validada con zod.
 *
 * Los valores por defecto son los de **desarrollo local** (infraestructura de
 * docker compose publicada en localhost) para que `pnpm dev` funcione sin
 * exportar nada a mano. En los contenedores, docker compose inyecta los valores
 * reales derivados del `.env` de la raíz.
 */

/** Convierte cadenas vacías en `undefined` para poder tratarlas como ausentes. */
const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
)

/** Interpreta booleanos escritos como texto ("true", "1", "yes", "on"). */
const booleanFromText = z.preprocess((value) => {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return value
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', ''].includes(normalized)) return false
  return value
}, z.boolean())

const envSchema = z.object({
  // --- proceso
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // --- CORS: lista separada por comas -> array de orígenes
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:8081')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  // --- postgres
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgres://erp:erp_dev_password@localhost:5432/erp'),

  // --- keycloak
  // Issuer público: el que viaja dentro del token (`iss`).
  KEYCLOAK_ISSUER: z.string().min(1).default('http://localhost:8080/realms/erp'),
  // Issuer interno: desde donde la API descarga el JWKS (red de docker).
  KEYCLOAK_INTERNAL_ISSUER: z.string().min(1).default('http://localhost:8080/realms/erp'),
  KEYCLOAK_AUDIENCE: z.string().min(1).default('erp-api'),

  // --- valkey
  VALKEY_URL: z.string().min(1).default('redis://localhost:6379'),

  // --- azure blob storage (Azurite en desarrollo)
  AZURE_STORAGE_CONNECTION_STRING: z
    .string()
    .min(1)
    .default(
      'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://localhost:10000/devstoreaccount1;QueueEndpoint=http://localhost:10001/devstoreaccount1;TableEndpoint=http://localhost:10002/devstoreaccount1;',
    ),
  AZURE_STORAGE_CONTAINER: z.string().min(1).default('erp-attachments'),

  // --- caché y subidas
  CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(86400).default(60),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(10485760),

  // --- correo (Resend)
  RESEND_API_KEY: optionalText,
  MAIL_FROM: z.string().min(1).default('ERP Demo <onboarding@resend.dev>'),
  MAIL_REPLY_TO: optionalText,
  MAIL_ENABLED: booleanFromText.default(true),
})

export type Env = z.infer<typeof envSchema>

/**
 * Fuente de datos para el esquema.
 *
 * - Las variables vacías se descartan: docker compose sustituye por cadena
 *   vacía cualquier variable no definida en el `.env`, y eso debe equivaler a
 *   "no configurada" para que se apliquen los valores por defecto.
 * - `PORT` tiene prioridad sobre `API_PORT`; el contrato define `API_PORT` en
 *   el `.env` de la raíz, pero muchos entornos inyectan `PORT`.
 */
function buildRawEnv(): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && value.trim() === '') continue
    raw[key] = value
  }
  const port = raw['PORT'] ?? raw['API_PORT']
  if (port !== undefined) raw['PORT'] = port
  return raw
}

const rawEnv = buildRawEnv()

const parsed = envSchema.safeParse(rawEnv)

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(raíz)'
      return `  - ${path}: ${issue.message}`
    })
    .join('\n')

  console.error(
    ['', '[@erp/api] Configuración de entorno inválida:', details, ''].join('\n'),
  )
  process.exit(1)
}

/** Configuración validada y tipada de la API. */
export const env: Env = parsed.data

/** `true` cuando la API se ejecuta en modo desarrollo (logs con pino-pretty). */
export const isDevelopment: boolean = env.NODE_ENV === 'development'
