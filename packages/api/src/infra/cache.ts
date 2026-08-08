// ioredis is CommonJS: under ESM + NodeNext the default export is not
// constructible, so the named export is the one to use.
import { Redis } from 'ioredis'
import type { AppConfig } from '../config/env.js'
import type { Logger } from './logger.js'

/** The slice of the configuration this factory reads. */
export type CacheOptions = Pick<AppConfig, 'VALKEY_URL' | 'CACHE_TTL_SECONDS'>

/** Cache on Valkey (Redis protocol). */
export interface Cache {
  client: Redis
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>
  /**
   * Current version of the namespace (created at 1 when missing).
   * `null` when it could not be read, **and** while a lost `bumpVersion`
   * has this namespace marked untrusted: fail closed and bypass the cache
   * rather than compose a key from a guessed or superseded version.
   */
  version(namespace: string): Promise<number | null>
  /**
   * INCR of the version: invalidates every derived key.
   * `null` when the invalidation was lost even after a retry. That also
   * marks the namespace untrusted in this process, so `version()` answers
   * `null` and every request resolves from PostgreSQL until a bump lands —
   * callers cannot undo a committed write, so the cache degrades instead.
   */
  bumpVersion(namespace: string): Promise<number | null>
  ping(): Promise<boolean>
  /** Quits the connection (falls back to a hard disconnect). */
  close(): Promise<void>
}

/** Prefix of the keys that hold the version of each namespace. */
const VERSION_PREFIX = 'clavis:ver:'

/** Attempts and pause of `bumpVersion`: a lost invalidation is worth one retry. */
const BUMP_ATTEMPTS = 2
const BUMP_RETRY_MS = 100

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Key holding the version counter of a namespace. */
const versionKey = (namespace: string): string => `${VERSION_PREFIX}${namespace}`

/** Reads a version string; `null` when it is not a usable positive integer. */
function parseVersion(raw: string | null): number | null {
  if (raw === null) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/** The Valkey operations namespace versioning needs, and nothing else. */
export interface VersionOps {
  /** GET of the version key. */
  read(key: string): Promise<string | null>
  /** SET … NX: writes the key only when it is missing. */
  createIfAbsent(key: string, value: string): Promise<void>
  /** INCR of the version key; creates it at 1 when it did not exist. */
  increment(key: string): Promise<number>
}

/** The logger methods namespace versioning reports through. */
export interface VersionLogger {
  info(obj: Record<string, unknown>, msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

/** The two halves of the invalidation mechanism. */
export interface NamespaceVersions {
  version(namespace: string): Promise<number | null>
  bumpVersion(namespace: string): Promise<number | null>
}

/**
 * Namespace versioning, and the one piece of state that makes it fail closed.
 *
 * `version()` failing closed is only half the guarantee, and it is the half
 * that matters least: a version that cannot be READ makes the request skip the
 * cache, which is safe by itself. The dangerous failure is an invalidation
 * that is LOST — an administrator disables a compromised account, the
 * transaction commits, the `INCR` does not land, and Valkey is still up and
 * still serving the old version, so the entries built from it keep answering
 * with the permissions that were just taken away, for up to
 * `CACHE_TTL_SECONDS`. Returning `null` from `bumpVersion` did nothing about
 * that on its own: neither caller can act on it, and the write has already
 * committed.
 *
 * So the failure is remembered here instead. A namespace whose bump was lost
 * goes into `lost`, `version()` answers `null` for it — the signal callers
 * already treat as "the cache cannot be trusted, go to PostgreSQL" — and a
 * later successful bump takes it back out. Recording it in memory is not a
 * limitation, it is the requirement: the only thing that could record it
 * anywhere else is the Valkey call that just failed.
 *
 * It is per process. Another instance that bumped successfully keeps using its
 * cache, which is correct — its `INCR` did land, so its keys are the new ones.
 */
export function createNamespaceVersions(ops: VersionOps, log: VersionLogger): NamespaceVersions {
  /** Namespaces whose invalidation was lost; served from PostgreSQL until it is not. */
  const lost = new Set<string>()

  return {
    async version(namespace) {
      // Checked before any I/O: this branch cannot itself fail, which is the
      // whole reason the degradation is trustworthy.
      if (lost.has(namespace)) return null

      const key = versionKey(namespace)
      try {
        const current = parseVersion(await ops.read(key))
        if (current !== null) return current
        // Only created when missing: two concurrent instances do not clobber each other.
        await ops.createIfAbsent(key, '1')
        const created = parseVersion(await ops.read(key))
        if (created !== null) return created
        log.warn({ namespace, key }, 'The cache version holds no usable value')
        return null
      } catch (error) {
        log.warn({ err: error, namespace }, 'Could not read the cache version')
        return null
      }
    },

    async bumpVersion(namespace) {
      const key = versionKey(namespace)
      let lastError: unknown
      for (let attempt = 1; attempt <= BUMP_ATTEMPTS; attempt += 1) {
        try {
          const next = await ops.increment(key)
          // Whatever invalidation was lost before is covered by this bump:
          // every key derived from the namespace now carries a version nobody
          // has ever written an entry under.
          if (lost.delete(namespace)) {
            log.info(
              { namespace, version: next },
              'Cache invalidation recovered: this namespace is served from the cache again',
            )
          }
          return next
        } catch (error) {
          lastError = error
          if (attempt < BUMP_ATTEMPTS) {
            log.warn({ err: error, namespace, attempt }, 'Could not invalidate the cache; retrying')
            await delay(BUMP_RETRY_MS)
          }
        }
      }

      lost.add(namespace)
      log.error(
        { err: lastError, namespace, attempts: BUMP_ATTEMPTS },
        'Cache invalidation failed: this namespace is now resolved from PostgreSQL on every ' +
          'request until a bump succeeds, so that revoked access cannot survive on a stale entry',
      )
      return null
    },
  }
}

/**
 * Cache backed by Valkey (Redis protocol).
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
 *
 * A lost `bumpVersion` is remembered rather than merely reported, so that the
 * namespace stops being read from the cache at all — see
 * `createNamespaceVersions` above for why the callers cannot do that themselves.
 */
export function createCache(options: CacheOptions, log: Logger): Cache {
  const client = new Redis(options.VALKEY_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    connectionName: 'clavis-api',
    enableReadyCheck: true,
    // Retry with growing backoff, capped at 3 seconds.
    retryStrategy: (times: number) => Math.min(times * 200, 3000),
  })

  client.on('error', (error: Error) => {
    log.warn({ err: error }, 'Valkey connection error')
  })
  client.on('ready', () => {
    log.info({ url: options.VALKEY_URL }, 'Connected to Valkey')
  })

  const versions = createNamespaceVersions(
    {
      read: (key) => client.get(key),
      createIfAbsent: async (key, value) => {
        await client.set(key, value, 'NX')
      },
      increment: (key) => client.incr(key),
    },
    log,
  )

  return {
    client,

    async get(key) {
      try {
        const raw = await client.get(key)
        if (raw === null) return null
        return JSON.parse(raw)
      } catch (error) {
        log.warn({ err: error, key }, 'Could not read from the cache')
        return null
      }
    },

    async set(key, value, ttlSeconds) {
      const ttl = ttlSeconds ?? options.CACHE_TTL_SECONDS
      try {
        await client.set(key, JSON.stringify(value), 'EX', ttl)
      } catch (error) {
        log.warn({ err: error, key }, 'Could not write to the cache')
      }
    },

    version: versions.version,

    bumpVersion: versions.bumpVersion,

    async ping() {
      try {
        const pong = await client.ping()
        return pong === 'PONG'
      } catch (error) {
        log.warn({ err: error }, 'Valkey is not responding')
        return false
      }
    },

    async close() {
      try {
        await client.quit()
      } catch {
        client.disconnect()
      }
      log.info('Valkey connection closed')
    },
  }
}
