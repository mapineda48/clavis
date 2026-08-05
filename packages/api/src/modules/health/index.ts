// Public health routes. They need no authentication and are excluded from the
// OpenAPI security scheme (`security: []`).
import type { FastifyPluginAsync } from 'fastify'
// Pulls in the @fastify/swagger type augmentation (tags, summary, security inside `schema`).
import type {} from '@fastify/swagger'

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

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/health',
    {
      config: {},
      schema: {
        tags: ['health'],
        summary: 'Liveness check',
        description: 'Always answers 200 while the process is alive. Public route.',
        security: [],
        response: { 200: HealthResponse },
      },
    },
    async () => ({
      status: 'ok',
      service: SERVICE_NAME,
      uptimeSeconds: Math.round(process.uptime()),
    }),
  )

  app.get(
    '/health/ready',
    {
      config: {},
      schema: {
        tags: ['health'],
        summary: 'Readiness check',
        description:
          'Checks database, cache and storage, and reports the state of the mailer. ' +
          'Answers 503 if any critical dependency fails; the mailer is not critical. Public route.',
        security: [],
        response: { 200: ReadyResponse, 503: ReadyResponse },
      },
    },
    async (_request, reply) => {
      const [database, cache, storage] = await Promise.all([
        safePing(() => app.db.ping()),
        safePing(() => app.cache.ping()),
        safePing(() => app.storage.ping()),
      ])

      const mailer = app.mailer.enabled ? app.mailer.provider : 'disabled'
      const critical = database && cache && storage

      reply.code(critical ? 200 : 503)
      return {
        status: critical ? 'ok' : 'degraded',
        checks: {
          database: database ? 'ok' : 'error',
          cache: cache ? 'ok' : 'error',
          storage: storage ? 'ok' : 'error',
          mailer,
        },
      }
    },
  )
}
