import type { FastifyInstance } from 'fastify'
import { ConfigError, loadConfig } from './config/env.js'
import { buildServer } from './server.js'

/**
 * Process entry point.
 *
 * This is the only file that reads `process.env` and the only one that calls
 * `process.exit`. Everything below it takes its configuration as an argument,
 * which is what makes `buildServer` parameterisable and `loadConfig` testable.
 */

/** Signals that trigger a graceful shutdown. */
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']

/** Human-friendly host for the log links (0.0.0.0 is not browsable). */
function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? 'localhost' : host
}

/** Wires the graceful shutdown of the server on SIGINT/SIGTERM. */
function registerShutdownHooks(app: FastifyInstance): void {
  let shuttingDown = false

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      if (shuttingDown) return
      shuttingDown = true
      app.log.info({ signal }, 'Shutting the API down...')

      app
        .close()
        .then(() => {
          app.log.info('API stopped cleanly')
          process.exit(0)
        })
        .catch((error: unknown) => {
          app.log.error({ err: error }, 'Error during shutdown')
          process.exit(1)
        })
    })
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const app = await buildServer(config)
  registerShutdownHooks(app)

  try {
    await app.listen({ host: config.HOST, port: config.PORT })
    const baseUrl = `http://${displayHost(config.HOST)}:${config.PORT}`
    app.log.info(
      { url: baseUrl, docs: `${baseUrl}/api/docs` },
      `API ready — documentation at ${baseUrl}/api/docs`,
    )
  } catch (error) {
    app.log.error({ err: error }, 'Could not start the server')
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  // Failure before a logger is available (configuration, migrations, plugins).
  // A bad environment gets its own report: the list of offending variables is
  // the whole answer, and a stack trace would only bury it.
  if (error instanceof ConfigError) {
    console.error(error.report())
    process.exit(1)
  }
  console.error('[@clavis/api] Fatal failure during startup:', error)
  process.exit(1)
})
