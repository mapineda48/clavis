import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify'
import type { AppConfig } from './config/env.js'
import { registerErrorHandler } from './lib/errors.js'
import { accessRoutes } from './modules/access/index.js'
import { auditRoutes } from './modules/audit/index.js'
import { healthRoutes } from './modules/health/index.js'
import { meRoutes } from './modules/me/index.js'
import { registerSharedSchemas } from './modules/shared/schemas.js'
import { usersRoutes } from './modules/users/index.js'
import { authPlugin } from './plugins/auth.js'
import { bootstrapPlugin } from './plugins/bootstrap.js'
import { cachePlugin } from './plugins/cache.js'
import { dbPlugin } from './plugins/db.js'
import { keycloakAdminPlugin } from './plugins/keycloak-admin.js'
import { mailerPlugin } from './plugins/mailer.js'
import { storagePlugin } from './plugins/storage.js'

/**
 * The modules this service exposes: one OpenAPI tag and one route plugin each.
 *
 * The tag list and the registration list were two blocks kept in sync by hand.
 * A module registered without its tag grows an undocumented section, and a tag
 * declared without its module documents routes nobody serves — neither fails
 * anything, so both survive review. One array read twice cannot drift.
 *
 * The order is the order the tags appear in `/api/docs`.
 */
const MODULES: ReadonlyArray<{
  tag: { name: string; description: string }
  routes: FastifyPluginAsync
}> = [
  {
    tag: { name: 'health', description: 'Status of the service and its dependencies' },
    routes: healthRoutes,
  },
  {
    tag: { name: 'profile', description: 'Data about the authenticated user' },
    routes: meRoutes,
  },
  {
    tag: { name: 'users', description: 'System users: created here, authenticated by Keycloak' },
    routes: usersRoutes,
  },
  {
    tag: { name: 'access', description: 'Roles, permissions and per-user exceptions' },
    routes: accessRoutes,
  },
  {
    tag: { name: 'audit', description: 'Audit trail' },
    routes: auditRoutes,
  },
]

/**
 * Builds the Fastify instance with every plugin and route.
 *
 * Order matters: infrastructure first (CORS, multipart, OpenAPI, error
 * handler), then the plugins that decorate the instance (`db`, `cache`,
 * `storage`, `mailer`, `auth`), and finally the routes, which can already rely
 * on those decorators.
 *
 * The configuration arrives as an argument and reaches each plugin as its
 * registration options; no plugin imports it. Every plugin declares the slice
 * it reads (`Pick<AppConfig, …>`), so what a plugin is allowed to look at is
 * checked at compile time even though the whole object is handed over — one
 * source of truth, and adding a variable to a plugin is one edit rather than
 * two. The keys are SCREAMING_SNAKE_CASE, so none of them collides with
 * Fastify's own registration options (`prefix`, `logLevel`, `logSerializers`).
 */
export async function buildServer(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.NODE_ENV === 'development'
      ? {
          level: config.LOG_LEVEL,
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
        }
      : { level: config.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: config.MAX_UPLOAD_BYTES,
  })

  // --- CORS: frontend origins only; X-Cache must be readable by the browser.
  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Cache'],
  })

  // --- File uploads: the per-file ceiling matches the body limit above.
  await app.register(multipart, {
    limits: {
      fileSize: config.MAX_UPLOAD_BYTES,
      files: 1,
    },
  })

  // --- OpenAPI documentation
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Clavis API',
        description:
          'Access-control API: it validates the Keycloak token on every request and ' +
          'resolves what the caller is allowed to do.',
        version: '1.0.0',
      },
      servers: [{ url: `http://localhost:${config.PORT}`, description: 'Local environment' }],
      tags: MODULES.map((module) => module.tag),
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Access token issued by Keycloak for the clavis-api audience.',
          },
        },
      },
    },
    // Without this, a schema registered with `addSchema` is published under a
    // generated name (`def-0`) that changes as soon as another shared schema is
    // added before it. Its `$id` is a name somebody chose; use that.
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, index) =>
        typeof json['$id'] === 'string' ? json['$id'] : `def-${index}`,
    },
  })

  await app.register(swaggerUi, {
    // Under /api like everything else the API serves: in production a single
    // reverse-proxy rule sends /api to this service and everything else to the
    // SPA, so a path outside /api would be answered by the SPA instead.
    routePrefix: '/api/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
    },
  })

  // --- Uniform error envelope for the whole API: the handler that produces it
  // and the schema the routes refer to. Both before any route is registered.
  registerErrorHandler(app)
  registerSharedSchemas(app)

  // --- Infrastructure (all wrapped in fastify-plugin: they decorate the root scope)
  await app.register(dbPlugin, config)
  await app.register(cachePlugin, config)
  await app.register(storagePlugin, config)
  await app.register(mailerPlugin, config)
  await app.register(keycloakAdminPlugin, config)
  // Seeds the permission catalog, the system role and root before any request.
  await app.register(bootstrapPlugin, config)
  await app.register(authPlugin, config)

  // --- Routes
  // Every path this service answers lives under /api, health checks included.
  // That is what lets the edge route on a single prefix with no exceptions: a
  // probe against /health would otherwise reach the SPA, which answers any
  // unknown path with index.html and HTTP 200 — a readiness check that can
  // never fail.
  for (const module of MODULES) {
    await app.register(module.routes, { prefix: '/api' })
  }

  return app
}
