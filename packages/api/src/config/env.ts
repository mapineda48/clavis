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
 * real values derived from the root `.env`. Under `NODE_ENV=production` those
 * same defaults are refused instead of filled in — see
 * `PRODUCTION_REFUSED_DEFAULTS` below.
 */

/**
 * Azurite's published development account key. It appears in Microsoft's own
 * documentation, which is the point: it is not a secret, so a deployment still
 * carrying it is either talking to the emulator or to a storage account whose
 * credentials anyone can look up.
 */
const AZURITE_ACCOUNT_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=='

/**
 * The development database password, factored out for the same reason as the
 * Azurite key: the production check matches on the credential, not on the whole
 * URL. The `.env`-derived connection string differs from the default in its
 * host (`postgres` inside compose, anything at all elsewhere), and an exact
 * match would wave through the one part of the string that must never reach
 * production.
 */
const DEV_DB_PASSWORD = 'clavis_dev_password'

/**
 * The development defaults a production process must not inherit, written once
 * so the schema and the production check below read the same string. Declared
 * in two places they drift on the first edit, and the half that drifts is the
 * check — which then guards a value nothing sets any more and passes
 * everything.
 */
const DEV_DEFAULTS = {
  CORS_ORIGINS: 'http://localhost:5173,http://localhost:8081',
  DATABASE_URL: `postgres://clavis:${DEV_DB_PASSWORD}@localhost:5432/clavis`,
  KEYCLOAK_API_CLIENT_SECRET: 'clavis_api_dev_secret',
  ROOT_PASSWORD: 'Root123!',
  AZURE_STORAGE_CONNECTION_STRING: `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${AZURITE_ACCOUNT_KEY};BlobEndpoint=http://localhost:10000/devstoreaccount1;QueueEndpoint=http://localhost:10001/devstoreaccount1;TableEndpoint=http://localhost:10002/devstoreaccount1;`,
} as const

/**
 * Splits the comma-separated origin list. Shared between the schema transform
 * and the production check so the latter compares against exactly what the
 * former would have produced from the default.
 */
function splitOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}

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
  CORS_ORIGINS: z.string().default(DEV_DEFAULTS.CORS_ORIGINS).transform(splitOrigins),

  // --- postgres
  DATABASE_URL: z.string().min(1).default(DEV_DEFAULTS.DATABASE_URL),
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
  // How long a request waits for a connection from the pool before giving up.
  // Without it `pool.connect()` has no timer at all: once every client is
  // checked out, callers queue forever and the symptom is requests that never
  // answer, with nothing logged and no failing statement to point at. Five
  // seconds is longer than any healthy checkout and short enough that a
  // saturated pool sheds load — a 500 the client can retry beats a socket that
  // is still open in ten minutes. `0` disables it, which is pg's own meaning.
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(0).max(600000).default(5000),

  // --- keycloak
  // Public issuer: the one carried inside the token (`iss`).
  KEYCLOAK_ISSUER: z.string().min(1).default('http://localhost:8080/realms/clavis'),
  // Internal issuer: where the API downloads the JWKS from (docker network).
  KEYCLOAK_INTERNAL_ISSUER: z.string().min(1).default('http://localhost:8080/realms/clavis'),
  KEYCLOAK_AUDIENCE: z.string().min(1).default('clavis-api'),
  // Secret of the confidential client; its service account calls the Admin
  // REST API (manage-users) to create and maintain realm users.
  KEYCLOAK_API_CLIENT_SECRET: z.string().min(1).default(DEV_DEFAULTS.KEYCLOAK_API_CLIENT_SECRET),
  // Public client of the SPA: execute-actions emails link back through it.
  KEYCLOAK_APP_CLIENT_ID: z.string().min(1).default('clavis-app'),

  // --- root user (seeded at boot; the only account not created from the app)
  ROOT_USERNAME: z.string().min(1).default('root'),
  ROOT_EMAIL: z.string().min(3).default('root@clavis.local'),
  ROOT_PASSWORD: z.string().min(8).default(DEV_DEFAULTS.ROOT_PASSWORD),
  ROOT_DISPLAY_NAME: z.string().min(1).default('Root'),

  // --- public URL of the SPA (redirect target of Keycloak action emails)
  PUBLIC_APP_URL: z.string().min(1).default('http://localhost:5173'),

  // --- valkey
  VALKEY_URL: z.string().min(1).default('redis://localhost:6379'),

  // --- azure blob storage (Azurite in development)
  AZURE_STORAGE_CONNECTION_STRING: z
    .string()
    .min(1)
    .default(DEV_DEFAULTS.AZURE_STORAGE_CONNECTION_STRING),
  AZURE_STORAGE_CONTAINER: z.string().min(1).default('clavis-attachments'),

  // --- cache, request bodies and uploads
  CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(86400).default(60),
  // Ceiling on a JSON request body, deliberately far below the upload one:
  // `express.json` buffers the body whole and parses it on the event loop, so
  // this number is how much work a single request can hand the process before
  // anything has authenticated it. The largest legitimate body this API accepts
  // is about a kilobyte; 128 KiB leaves room to grow without volunteering
  // megabytes of parsing.
  JSON_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(10485760).default(131072),
  // The file-upload ceiling: part of the deployment contract (docker compose and
  // the deploy bundle both pass it) and what a streaming upload route will cut
  // at. It does NOT bound JSON bodies — `JSON_BODY_LIMIT_BYTES` does.
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
 * Variables whose development default must never reach a production process,
 * each paired with the test that recognises that default in the parsed config.
 *
 * `ROOT_PASSWORD` is the one that turns a forgotten variable into a live
 * incident rather than a weak start: `bootstrap/seed.ts` re-applies it to the
 * root Keycloak account on **every** boot, so a production deploy that never
 * set it silently RESETS root's password to the published default on every
 * restart, undoing whatever the operator changed it to — and nothing in the
 * logs says so. The rest are the same class of mistake without the reset: a
 * client secret that is in this repository, a database nobody meant to point
 * at, a storage key from Microsoft's documentation, and a CORS list that trusts
 * localhost.
 *
 * The test is on the VALUE, not on the variable being absent, because the way
 * this actually happens is `.env.example` copied into a real environment: every
 * variable is then set, and every one of them is set to the default.
 * `AZURE_STORAGE_CONNECTION_STRING` is matched on Azurite's account key instead
 * of on the whole string for exactly that reason — the `.env.example` copy
 * differs from the default here only in the host it points at, and the
 * credential is the part that matters.
 */
const PRODUCTION_REFUSED_DEFAULTS: readonly {
  readonly variable: string
  readonly stillDefault: (config: AppConfig) => boolean
}[] = [
  {
    variable: 'ROOT_PASSWORD',
    stillDefault: (config) => config.ROOT_PASSWORD === DEV_DEFAULTS.ROOT_PASSWORD,
  },
  {
    variable: 'KEYCLOAK_API_CLIENT_SECRET',
    stillDefault: (config) =>
      config.KEYCLOAK_API_CLIENT_SECRET === DEV_DEFAULTS.KEYCLOAK_API_CLIENT_SECRET,
  },
  {
    variable: 'DATABASE_URL',
    // On the credential, like the Azure entry: compose derives this URL with
    // host `postgres` instead of `localhost`, so an exact match would let the
    // development password through on any host but the one nobody deploys.
    stillDefault: (config) => config.DATABASE_URL.includes(DEV_DB_PASSWORD),
  },
  {
    variable: 'AZURE_STORAGE_CONNECTION_STRING',
    stillDefault: (config) => config.AZURE_STORAGE_CONNECTION_STRING.includes(AZURITE_ACCOUNT_KEY),
  },
  {
    variable: 'CORS_ORIGINS',
    stillDefault: (config) => {
      const devOrigins = splitOrigins(DEV_DEFAULTS.CORS_ORIGINS)
      return (
        config.CORS_ORIGINS.length === devOrigins.length &&
        config.CORS_ORIGINS.every((origin, index) => origin === devOrigins[index])
      )
    },
  },
]

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

  const config = parsed.data

  if (config.NODE_ENV === 'production') {
    // Every offending variable at once, like the schema errors above: an
    // operator fixing a production deployment one refusal per restart learns
    // the list one line at a time.
    const issues = PRODUCTION_REFUSED_DEFAULTS.filter(({ stillDefault }) =>
      stillDefault(config),
    ).map(
      ({ variable }) =>
        `  - ${variable}: must be set explicitly in production; the development default is refused`,
    )
    if (issues.length > 0) throw new ConfigError(issues)
  }

  return config
}
