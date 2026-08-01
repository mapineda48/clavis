import { z } from 'zod'

/**
 * API configuration, read from `process.env` and validated with zod.
 *
 * The defaults are the **local development** ones (the docker compose
 * infrastructure published on localhost) so that `pnpm dev` works without
 * exporting anything by hand. Inside the containers, docker compose injects the
 * real values derived from the root `.env`.
 */

/** Turns empty strings into `undefined` so they can be treated as absent. */
const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
)

/** Reads booleans written as text ("true", "1", "yes", "on"). */
const booleanFromText = z.preprocess((value) => {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return value
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', ''].includes(normalized)) return false
  return value
}, z.boolean())

const envSchema = z.object({
  // --- process
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // --- CORS: comma-separated list -> array of origins
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
  // Public issuer: the one carried inside the token (`iss`).
  KEYCLOAK_ISSUER: z.string().min(1).default('http://localhost:8080/realms/erp'),
  // Internal issuer: where the API downloads the JWKS from (docker network).
  KEYCLOAK_INTERNAL_ISSUER: z.string().min(1).default('http://localhost:8080/realms/erp'),
  KEYCLOAK_AUDIENCE: z.string().min(1).default('erp-api'),

  // --- valkey
  VALKEY_URL: z.string().min(1).default('redis://localhost:6379'),

  // --- azure blob storage (Azurite in development)
  AZURE_STORAGE_CONNECTION_STRING: z
    .string()
    .min(1)
    .default(
      'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://localhost:10000/devstoreaccount1;QueueEndpoint=http://localhost:10001/devstoreaccount1;TableEndpoint=http://localhost:10002/devstoreaccount1;',
    ),
  AZURE_STORAGE_CONTAINER: z.string().min(1).default('erp-attachments'),

  // --- cache and uploads
  CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(86400).default(60),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(10485760),

  // --- email (Resend)
  RESEND_API_KEY: optionalText,
  MAIL_FROM: z.string().min(1).default('ERP Demo <onboarding@resend.dev>'),
  MAIL_REPLY_TO: optionalText,
  MAIL_ENABLED: booleanFromText.default(true),
})

export type Env = z.infer<typeof envSchema>

/**
 * Input data for the schema.
 *
 * - Empty variables are dropped: docker compose replaces any variable missing
 *   from the `.env` with an empty string, and that must mean "not configured"
 *   so the defaults kick in.
 * - `PORT` wins over `API_PORT`; the contract defines `API_PORT` in the root
 *   `.env`, but many environments inject `PORT` instead.
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
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      return `  - ${path}: ${issue.message}`
    })
    .join('\n')

  console.error(
    ['', '[@erp/api] Invalid environment configuration:', details, ''].join('\n'),
  )
  process.exit(1)
}

/** Validated and typed API configuration. */
export const env: Env = parsed.data

/** `true` when the API runs in development mode (pino-pretty logs). */
export const isDevelopment: boolean = env.NODE_ENV === 'development'
