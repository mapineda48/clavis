// Rutas publicas de salud. No requieren autenticacion y se excluyen del
// esquema de seguridad de OpenAPI (`security: []`).
import type { FastifyPluginAsync } from 'fastify'
// Carga la ampliacion de tipos de @fastify/swagger (tags, summary, security en `schema`).
import type {} from '@fastify/swagger'

/** Nombre del servicio publicado en /health. */
const SERVICE_NAME = 'erp-api'

/** Esquema de la respuesta de /health. */
const HealthResponse = {
  type: 'object',
  properties: {
    status: { type: 'string', description: 'Siempre "ok" si el proceso responde' },
    service: { type: 'string' },
    uptimeSeconds: { type: 'number', description: 'Segundos desde el arranque del proceso' },
  },
  required: ['status', 'service', 'uptimeSeconds'],
}

/** Esquema de la respuesta de /health/ready (identico para 200 y 503). */
const ReadyResponse = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded'] },
    checks: {
      type: 'object',
      properties: {
        database: { type: 'string', description: '"ok" o "error"' },
        cache: { type: 'string', description: '"ok" o "error"' },
        storage: { type: 'string', description: '"ok" o "error"' },
        mailer: { type: 'string', description: '"resend", "dry-run" o "disabled"' },
      },
      required: ['database', 'cache', 'storage', 'mailer'],
    },
  },
  required: ['status', 'checks'],
}

/** Ejecuta un ping tolerante a fallos: cualquier error se traduce a false. */
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
        tags: ['salud'],
        summary: 'Comprobacion de vida',
        description: 'Responde siempre 200 mientras el proceso este vivo. Ruta publica.',
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
        tags: ['salud'],
        summary: 'Comprobacion de disponibilidad',
        description:
          'Verifica base de datos, cache y almacenamiento, e informa del estado del correo. ' +
          'Responde 503 si falla alguna dependencia critica; el correo no es critico. Ruta publica.',
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
