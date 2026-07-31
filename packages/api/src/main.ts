import type { FastifyInstance } from 'fastify'
import { env } from './config/env.js'
import { buildServer } from './server.js'

/** Señales que provocan un apagado ordenado. */
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']

/** Host legible para los enlaces del log (0.0.0.0 no es navegable). */
function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? 'localhost' : host
}

/** Registra el cierre ordenado del servidor ante SIGINT/SIGTERM. */
function registerShutdownHooks(app: FastifyInstance): void {
  let shuttingDown = false

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      if (shuttingDown) return
      shuttingDown = true
      app.log.info({ signal }, 'Apagando la API...')

      app
        .close()
        .then(() => {
          app.log.info('API detenida correctamente')
          process.exit(0)
        })
        .catch((error: unknown) => {
          app.log.error({ err: error }, 'Error durante el apagado')
          process.exit(1)
        })
    })
  }
}

async function main(): Promise<void> {
  const app = await buildServer()
  registerShutdownHooks(app)

  try {
    await app.listen({ host: env.HOST, port: env.PORT })
    const baseUrl = `http://${displayHost(env.HOST)}:${env.PORT}`
    app.log.info({ url: baseUrl, docs: `${baseUrl}/docs` }, `API lista — documentación en ${baseUrl}/docs`)
  } catch (error) {
    app.log.error({ err: error }, 'No se pudo iniciar el servidor')
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  // Fallo antes de tener logger disponible (configuración, migraciones, plugins).
  console.error('[@erp/api] Fallo fatal durante el arranque:', error)
  process.exit(1)
})
