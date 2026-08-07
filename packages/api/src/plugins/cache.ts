import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
// ioredis is CommonJS: under ESM + NodeNext the default export is not
// constructible, so the named export is the one to use.
import { Redis } from 'ioredis'
import type { AppConfig } from '../config/env.js'

/** The slice of the configuration this plugin reads. */
export type CachePluginOptions = Pick<AppConfig, 'VALKEY_URL' | 'CACHE_TTL_SECONDS'>

/** Prefix of the keys that hold the version of each namespace. */
const VERSION_PREFIX = 'clavis:ver:'

/** Attempts and pause of `bumpVersion`: a lost invalidation is worth one retry. */
const BUMP_ATTEMPTS = 2
const BUMP_RETRY_MS = 100

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Reads a version string; `null` when it is not a usable positive integer. */
function parseVersion(raw: string | null): number | null {
  if (raw === null) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Cache plugin backed by Valkey (Redis protocol).
 *
 * Invalidation works by *namespace version*: list keys embed the version
 * number, so a `bumpVersion` makes every derived entry stale without having to
 * delete anything.
 *
 * The cache is an accelerator, never a single point of failure: if Valkey does
 * not answer, operations degrade (they behave like a cache miss) instead of
 * propagating the error to the request. `ping()` still reports the real state
 * for `/api/health/ready`.
 *
 * Degrading is not the same as guessing. `version()` and `bumpVersion()` return
 * `null` when they could not do their job, because the version is the whole
 * invalidation mechanism: a version invented after a failed read composes a key
 * that may still hold an entry from before several bumps, and that entry can
 * carry permissions somebody has already been stripped of. Callers treat `null`
 * as "the cache cannot be trusted right now" and go to the database instead.
 */
export const cachePlugin = fp<CachePluginOptions>(
  async (app: FastifyInstance, options) => {
    const client = new Redis(options.VALKEY_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      connectionName: 'clavis-api',
      enableReadyCheck: true,
      // Retry with growing backoff, capped at 3 seconds.
      retryStrategy: (times: number) => Math.min(times * 200, 3000),
    })

    client.on('error', (error: Error) => {
      app.log.warn({ err: error }, 'Valkey connection error')
    })
    client.on('ready', () => {
      app.log.info({ url: options.VALKEY_URL }, 'Connected to Valkey')
    })

    const versionKey = (namespace: string): string => `${VERSION_PREFIX}${namespace}`

    const cache: FastifyInstance['cache'] = {
      client,

      async get(key) {
        try {
          const raw = await client.get(key)
          if (raw === null) return null
          return JSON.parse(raw)
        } catch (error) {
          app.log.warn({ err: error, key }, 'Could not read from the cache')
          return null
        }
      },

      async set(key, value, ttlSeconds) {
        const ttl = ttlSeconds ?? options.CACHE_TTL_SECONDS
        try {
          await client.set(key, JSON.stringify(value), 'EX', ttl)
        } catch (error) {
          app.log.warn({ err: error, key }, 'Could not write to the cache')
        }
      },

      async version(namespace) {
        const key = versionKey(namespace)
        try {
          const current = parseVersion(await client.get(key))
          if (current !== null) return current
          // Only created when missing: two concurrent instances do not clobber each other.
          await client.set(key, '1', 'NX')
          const created = parseVersion(await client.get(key))
          if (created !== null) return created
          app.log.warn({ namespace, key }, 'The cache version holds no usable value')
          return null
        } catch (error) {
          app.log.warn({ err: error, namespace }, 'Could not read the cache version')
          return null
        }
      },

      async bumpVersion(namespace) {
        const key = versionKey(namespace)
        for (let attempt = 1; attempt <= BUMP_ATTEMPTS; attempt += 1) {
          try {
            // INCR creates the key at 1 when it did not exist.
            return await client.incr(key)
          } catch (error) {
            if (attempt < BUMP_ATTEMPTS) {
              app.log.warn({ err: error, namespace, attempt }, 'Could not invalidate the cache; retrying')
              await delay(BUMP_RETRY_MS)
              continue
            }
            // Not a nuisance: every entry derived from this namespace stays
            // readable until its TTL runs out, so a permission just revoked can
            // keep working. That is a security event, and it is logged as one.
            app.log.error(
              { err: error, namespace, attempts: BUMP_ATTEMPTS },
              'Cache invalidation failed: revoked access may survive until the entries expire',
            )
          }
        }
        return null
      },

      async ping() {
        try {
          const pong = await client.ping()
          return pong === 'PONG'
        } catch (error) {
          app.log.warn({ err: error }, 'Valkey is not responding')
          return false
        }
      },
    }

    app.decorate('cache', cache)

    app.addHook('onClose', async () => {
      try {
        await client.quit()
      } catch {
        client.disconnect()
      }
      app.log.info('Valkey connection closed')
    })
  },
  { name: 'clavis-cache' },
)

export default cachePlugin
