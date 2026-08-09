import { once } from 'node:events'
import type { Server } from 'node:http'
import { buildApp } from './app.js'
import { seedAccessControl } from './bootstrap/seed.js'
import { ConfigError, loadConfig } from './config/env.js'
import { type Logger, createLogger } from './infra/logger.js'
import { type Services, createServices } from './infra/services.js'

/**
 * Process entry point, and the composition root.
 *
 * This is the only file that reads `process.env` and the only one that calls
 * `process.exit`. Everything below it takes its configuration and its services
 * as arguments, which is what makes `buildApp` parameterisable and every layer
 * under it testable in isolation.
 *
 * Startup order matters: configuration, logger, infrastructure (the database
 * factory runs the migrations), boot seeding, and only then the listener —
 * no request can observe a half-seeded permission catalog.
 */

/** Signals that trigger a graceful shutdown. */
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']

/**
 * How long the shutdown waits for in-flight requests before it stops asking.
 *
 * `server.close` calls back only once the LAST connection is gone, so a single
 * request stuck on a slow dependency holds the whole shutdown open until the
 * orchestrator loses patience and sends SIGKILL — and SIGKILL skips
 * `services.close()`, so the pool and Valkey never close, only the kernel does.
 * Cutting the stragglers here is worse for that one request and better for
 * everything else, because it is what lets the normal cleanup path run at all.
 */
const FORCE_CLOSE_TIMEOUT_MS = 10_000

/** Human-friendly host for the log links (0.0.0.0 is not browsable). */
function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? 'localhost' : host
}

/** Wires the graceful shutdown of the server on SIGINT/SIGTERM. */
function registerShutdownHooks(server: Server, services: Services, log: Logger): void {
  let shuttingDown = false

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      if (shuttingDown) return
      shuttingDown = true
      log.info({ signal }, 'Shutting the API down...')

      // `close` waits for in-flight requests but not for idle keep-alive
      // sockets, which would hold the callback forever; closing those
      // explicitly is what lets a busy browser tab not block the shutdown.
      server.close((error?: Error) => {
        const finish = error
          ? Promise.reject(error)
          : services.close().then(() => log.info('API stopped cleanly'))
        finish
          .then(() => process.exit(0))
          .catch((shutdownError: unknown) => {
            log.error({ err: shutdownError }, 'Error during shutdown')
            process.exit(1)
          })
      })
      server.closeIdleConnections()

      // `unref` is what makes this safe to schedule unconditionally: a shutdown
      // that finishes in 50 ms must not sit here for ten seconds waiting for a
      // timer, and an unref'd one cannot be the last handle keeping the event
      // loop alive.
      setTimeout(() => {
        log.warn(
          { timeoutMs: FORCE_CLOSE_TIMEOUT_MS },
          'Requests still in flight after the grace period; closing the remaining connections',
        )
        server.closeAllConnections()
      }, FORCE_CLOSE_TIMEOUT_MS).unref()
    })
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const log = createLogger(config)

  const services = await createServices(config, log)
  // Seeds the permission catalog, the system role and root before any request.
  await seedAccessControl(services, config)

  const app = buildApp(config, services)
  const server = app.listen(config.PORT, config.HOST)
  // Node's own keep-alive default is 5 seconds; the reverse proxy in front
  // keeps idle upstream sockets for ~90. An upstream that closes first turns
  // every reused connection into an intermittent 502/ECONNRESET under real
  // traffic — which is why Fastify shipped 72 s, restored here. The headers
  // timeout sits just above it so a request that starts on the connection's
  // last keep-alive second is not cut off mid-headers.
  server.keepAliveTimeout = 72_000
  server.headersTimeout = 73_000
  // `once` rejects if the server emits `error` first (port in use, bad host),
  // which lands in the catch below like any other startup failure.
  await once(server, 'listening')
  registerShutdownHooks(server, services, log)

  const baseUrl = `http://${displayHost(config.HOST)}:${config.PORT}`
  log.info(
    { url: baseUrl, docs: `${baseUrl}/api/docs` },
    `API ready — documentation at ${baseUrl}/api/docs`,
  )
}

main().catch((error: unknown) => {
  // Failure before a logger is available (configuration, migrations, services).
  // A bad environment gets its own report: the list of offending variables is
  // the whole answer, and a stack trace would only bury it.
  if (error instanceof ConfigError) {
    console.error(error.report())
    process.exit(1)
  }
  console.error('[@clavis/api] Fatal failure during startup:', error)
  process.exit(1)
})
