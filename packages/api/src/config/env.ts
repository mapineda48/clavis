import { z } from 'zod'

/**
 * API configuration: the environment read once, validated with zod and handed
 * to everything that needs it.
 *
 * `loadConfig` is a **pure function of the environment it is given**: it returns
 * a config or throws, and it never touches `process.env` and never exits. That
 * is deliberate. This module used to parse `process.env` at import time and call
 * `process.exit(1)` on a bad value, which meant any file that imported a plugin
 * imported the exit too — a single missing variable killed the process before a
 * caller could react, and nothing that reached a plugin could be exercised in
 * isolation. `src/main.ts` is now the only file that reads `process.env` and the
 * only one allowed to exit.
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

const configSchema = z.object({
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
    .default('postgres://clavis:clavis_dev_password@localhost:5432/clavis'),
  // Applied to every connection of the application pool (never to the
  // migrator's, which runs DDL that may legitimately take minutes).
  // `0` disables the timeout, which is PostgreSQL's own meaning for it.
  //
  // No request of this API does anything a Postgres statement should need
  // 15 seconds for, and a transaction left open with nothing running pins
  // `backend_xmin`, which stops vacuum from cleaning any row version newer
  // than it — database-wide, not just in the tables the transaction touched.
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).max(600000).default(15000),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(0).max(600000).default(10000),

  // --- keycloak
  // Public issuer: the one carried inside the token (`iss`).
  KEYCLOAK_ISSUER: z.string().min(1).default('http://localhost:8080/realms/clavis'),
  // Internal issuer: where the API downloads the JWKS from (docker network).
  KEYCLOAK_INTERNAL_ISSUER: z.string().min(1).default('http://localhost:8080/realms/clavis'),
  KEYCLOAK_AUDIENCE: z.string().min(1).default('clavis-api'),
  // Secret of the confidential client; its service account calls the Admin
  // REST API (manage-users) to create and maintain realm users.
  KEYCLOAK_API_CLIENT_SECRET: z.string().min(1).default('clavis_api_dev_secret'),
  // Public client of the SPA: execute-actions emails link back through it.
  KEYCLOAK_APP_CLIENT_ID: z.string().min(1).default('clavis-app'),

  // --- root user (seeded at boot; the only account not created from the app)
  ROOT_USERNAME: z.string().min(1).default('root'),
  ROOT_EMAIL: z.string().min(3).default('root@clavis.local'),
  ROOT_PASSWORD: z.string().min(8).default('Root123!'),
  ROOT_DISPLAY_NAME: z.string().min(1).default('Root'),

  // --- public URL of the SPA (redirect target of Keycloak action emails)
  PUBLIC_APP_URL: z.string().min(1).default('http://localhost:5173'),

  // --- valkey
  VALKEY_URL: z.string().min(1).default('redis://localhost:6379'),

  // --- azure blob storage (Azurite in development)
  AZURE_STORAGE_CONNECTION_STRING: z
    .string()
    .min(1)
    .default(
      'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://localhost:10000/devstoreaccount1;QueueEndpoint=http://localhost:10001/devstoreaccount1;TableEndpoint=http://localhost:10002/devstoreaccount1;',
    ),
  AZURE_STORAGE_CONTAINER: z.string().min(1).default('clavis-attachments'),

  // --- cache and uploads
  CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(86400).default(60),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(10485760),

  // --- email (Resend)
  RESEND_API_KEY: optionalText,
  MAIL_FROM: z.string().min(1).default('Clavis <onboarding@resend.dev>'),
  MAIL_REPLY_TO: optionalText,
  MAIL_ENABLED: booleanFromText.default(true),
})

/** Validated and typed API configuration. */
export type AppConfig = z.infer<typeof configSchema>

/**
 * An environment that does not describe a runnable API.
 *
 * It carries the individual problems so the caller decides what to do with
 * them: `main.ts` prints `report()` and exits, a test asserts on `issues`.
 */
export class ConfigError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.join('\n')}`)
    this.name = 'ConfigError'
    this.issues = issues
    Error.captureStackTrace?.(this, ConfigError)
  }

  /** The block `main.ts` prints on stderr before exiting. */
  report(): string {
    return ['', '[@clavis/api] Invalid environment configuration:', ...this.issues, ''].join('\n')
  }
}

/**
 * Input data for the schema.
 *
 * - Empty variables are dropped: docker compose replaces any variable missing
 *   from the `.env` with an empty string, and that must mean "not configured"
 *   so the defaults kick in.
 * - `PORT` wins over `API_PORT`; the contract defines `API_PORT` in the root
 *   `.env`, but many environments inject `PORT` instead.
 */
function normalize(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() === '') continue
    raw[key] = value
  }
  const port = raw['PORT'] ?? raw['API_PORT']
  if (port !== undefined) raw['PORT'] = port
  return raw
}

/**
 * Validates an environment and returns the configuration.
 * Throws `ConfigError` when it does not describe a runnable API. It never
 * reads `process.env` and never exits: both belong to `main.ts`.
 */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = configSchema.safeParse(normalize(env))

  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
        return `  - ${path}: ${issue.message}`
      }),
    )
  }

  return parsed.data
}
