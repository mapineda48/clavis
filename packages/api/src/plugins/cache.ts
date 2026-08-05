import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
// ioredis is CommonJS: under ESM + NodeNext the default export is not
// constructible, so the named export is the one to use.
import { Redis } from 'ioredis'
import { env } from '../config/env.js'

/** Prefix of the keys that hold the version of each namespace. */
const VERSION_PREFIX = 'clavis:ver:'

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
 */
export const cachePlugin = fp(
  async (app: FastifyInstance) => {
    const client = new Redis(env.VALKEY_URL, {
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
      app.log.info({ url: env.VALKEY_URL }, 'Connected to Valkey')
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
        const ttl = ttlSeconds ?? env.CACHE_TTL_SECONDS
        try {
          await client.set(key, JSON.stringify(value), 'EX', ttl)
        } catch (error) {
          app.log.warn({ err: error, key }, 'Could not write to the cache')
        }
      },

      async version(namespace) {
        const key = versionKey(namespace)
        try {
          const current = await client.get(key)
          if (current !== null) {
            const parsed = Number.parseInt(current, 10)
            return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
          }
          // Only created when missing: two concurrent instances do not clobber each other.
          await client.set(key, '1', 'NX')
          const created = await client.get(key)
          const parsed = created === null ? 1 : Number.parseInt(created, 10)
          return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
        } catch (error) {
          app.log.warn({ err: error, namespace }, 'Could not read the cache version')
          return 1
        }
      },

      async bumpVersion(namespace) {
        const key = versionKey(namespace)
        try {
          // INCR creates the key at 1 when it did not exist.
          return await client.incr(key)
        } catch (error) {
          app.log.warn({ err: error, namespace }, 'Could not invalidate the cache')
          return 1
        }
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
