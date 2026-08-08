// Public health routes. They need no authentication (`permissions: null`),
// which also excludes them from the OpenAPI security scheme.
import type { ModuleDef } from '../../http/route.js'
import type { Cache } from '../../infra/cache.js'
import type { Db } from '../../infra/db.js'
import type { Mailer } from '../../infra/mailer.js'
import type { Storage } from '../../infra/storage.js'

/** Service name published by /api/health. */
const SERVICE_NAME = 'clavis-api'

/** Response schema of /api/health. */
const HealthResponse = {
  type: 'object',
  properties: {
    status: { type: 'string', description: 'Always "ok" while the process answers' },
    service: { type: 'string' },
    uptimeSeconds: { type: 'number', description: 'Seconds since the process started' },
  },
  required: ['status', 'service', 'uptimeSeconds'],
}

/** Response schema of /api/health/ready (identical for 200 and 503). */
const ReadyResponse = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded'] },
    checks: {
      type: 'object',
      properties: {
        database: { type: 'string', description: '"ok" or "error"' },
        cache: { type: 'string', description: '"ok" or "error"' },
        storage: { type: 'string', description: '"ok" or "error"' },
        mailer: { type: 'string', description: '"resend", "dry-run" or "disabled"' },
      },
      required: ['database', 'cache', 'storage', 'mailer'],
    },
  },
  required: ['status', 'checks'],
}

/** Runs a fault-tolerant ping: any error is turned into false. */
async function safePing(ping: () => Promise<boolean>): Promise<boolean> {
  try {
    return await ping()
  } catch {
    return false
  }
}

export interface HealthModuleDeps {
  db: Pick<Db, 'ping'>
  cache: Pick<Cache, 'ping'>
  storage: Pick<Storage, 'ping'>
  mailer: Pick<Mailer, 'enabled' | 'provider'>
}

export function healthModule(deps: HealthModuleDeps): ModuleDef {
  return {
    tag: { name: 'health', description: 'Status of the service and its dependencies' },
    routes: [
      {
        method: 'get',
        path: '/health',
        summary: 'Liveness check',
        description: 'Always answers 200 while the process is alive. Public route.',
        permissions: null,
        responses: { 200: HealthResponse },
        handler: async (_req, res) => {
          res.json({
            status: 'ok',
            service: SERVICE_NAME,
            uptimeSeconds: Math.round(process.uptime()),
          })
        },
      },

      {
        method: 'get',
        path: '/health/ready',
        summary: 'Readiness check',
        description:
          'Checks database, cache and storage, and reports the state of the mailer. ' +
          'Answers 503 if any critical dependency fails; the mailer is not critical. Public route.',
        permissions: null,
        responses: { 200: ReadyResponse, 503: ReadyResponse },
        handler: async (_req, res) => {
          const [database, cache, storage] = await Promise.all([
            safePing(() => deps.db.ping()),
            safePing(() => deps.cache.ping()),
            safePing(() => deps.storage.ping()),
          ])

          const mailer = deps.mailer.enabled ? deps.mailer.provider : 'disabled'
          const critical = database && cache && storage

          res.status(critical ? 200 : 503).json({
            status: critical ? 'ok' : 'degraded',
            checks: {
              database: database ? 'ok' : 'error',
              cache: cache ? 'ok' : 'error',
              storage: storage ? 'ok' : 'error',
              mailer,
            },
          })
        },
      },
    ],
  }
}
