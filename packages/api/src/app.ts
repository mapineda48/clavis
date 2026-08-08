import cors from 'cors'
import express from 'express'
import { pinoHttp } from 'pino-http'
import type { AppConfig } from './config/env.js'
import { createAuth } from './http/auth.js'
import { errorHandler, notFoundHandler } from './http/error-handler.js'
import { DOCS_PATH, buildOpenApiDocument, createDocsRouter } from './http/openapi.js'
import { type ModuleDef, createModuleRouter } from './http/route.js'
import type { Services } from './infra/services.js'
import { accessModule } from './modules/access/routes.js'
import { auditModule } from './modules/audit/routes.js'
import { healthModule } from './modules/health/routes.js'
import { meModule } from './modules/me/routes.js'
import { usersModule } from './modules/users/routes.js'

/**
 * Builds the Express application: middleware, documentation and every module
 * router. It receives the configuration and the already-created services and
 * holds no state of its own — `main.ts` owns the process, this owns the app.
 *
 * The configuration arrives as an argument and reaches each piece as its
 * factory options; nothing imports it. Every factory declares the slice it
 * reads (`Pick<AppConfig, …>`), so what each one is allowed to look at is
 * checked at compile time even though the whole object is handed over.
 */
export function buildApp(config: AppConfig, services: Services): express.Express {
  const { log, db, cache, storage, mailer, keycloakAdmin } = services

  /**
   * The modules this service exposes: one entry each, read for the routers
   * AND for the OpenAPI document (tags, paths). Two lists kept in sync by
   * hand meant a module registered without its tag grew an undocumented
   * section and a tag without its module documented routes nobody serves —
   * neither fails anything, so both survive review. One array read twice
   * cannot drift.
   *
   * The order is the order the tags appear in `/api/docs`.
   */
  const modules: ModuleDef[] = [
    healthModule({ db, cache, storage, mailer }),
    meModule(),
    usersModule({ db, cache, keycloakAdmin }),
    accessModule({ db, cache }),
    auditModule({ db }),
  ]

  const app = express()

  // Behind the reverse proxy the client address arrives in X-Forwarded-For.
  app.set('trust proxy', true)
  // The version header is advertising, not information.
  app.disable('x-powered-by')
  // Pinned rather than inherited: the flat parser is all a query like
  // `?limit=100` needs, and the schemas validate flat objects. Whatever a
  // future Express changes its default to, this API's parsing stays the same.
  app.set('query parser', 'simple')
  // Express matches case-insensitively and ignores trailing slashes by
  // default; the previous server did neither, so '/API/users' and
  // '/api/users/' were 404s, not aliases. These settings cover the app router
  // (the '/api' mounts below); each module router carries the same flags
  // itself (http/route.ts), because sub-routers do not inherit them.
  app.set('strict routing', true)
  app.set('case sensitive routing', true)

  // Request logging first, so even a CORS refusal leaves a line.
  //
  // The serializers are not optional tidiness: pino-http's DEFAULT `req`
  // serializer logs every request header, and on this API every authenticated
  // request carries `Authorization: Bearer <live access token>` — the default
  // writes a replayable credential into the logs on every request. What is
  // kept is what Fastify's default serializer logged: enough to trace a
  // request, nothing a caller has to keep secret.
  app.use(
    pinoHttp({
      logger: log,
      serializers: {
        req(req: { id?: unknown; method?: string; url?: string; remoteAddress?: string; remotePort?: number }) {
          return {
            id: req.id,
            method: req.method,
            url: req.url,
            remoteAddress: req.remoteAddress,
            remotePort: req.remotePort,
          }
        },
        res(res: { statusCode?: number }) {
          return { statusCode: res.statusCode }
        },
      },
    }),
  )

  // --- CORS: frontend origins only; X-Cache must be readable by the browser.
  app.use(
    cors({
      origin: config.CORS_ORIGINS,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      exposedHeaders: ['X-Cache'],
    }),
  )

  // JSON bodies only. The ceiling is the same one uploads will get: a body
  // nobody can parse into anything useful should not be buffered either.
  app.use(express.json({ limit: config.MAX_UPLOAD_BYTES }))

  const auth = createAuth(config, { db, cache, log })

  // --- Routes
  // Every path this service answers lives under /api, health checks included.
  // That is what lets the edge route on a single prefix with no exceptions: a
  // probe against /health would otherwise reach the SPA, which answers any
  // unknown path with index.html and HTTP 200 — a readiness check that can
  // never fail.
  app.use(DOCS_PATH, createDocsRouter(buildOpenApiDocument(config, modules)))
  for (const module of modules) {
    app.use('/api', createModuleRouter(module, auth))
  }

  // Uniform envelope for everything that falls through: unknown routes and
  // every error any layer above produced.
  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
