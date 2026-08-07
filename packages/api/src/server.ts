import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import Fastify, { type FastifyInstance } from 'fastify'
import { env, isDevelopment } from './config/env.js'
import { registerErrorHandler } from './lib/errors.js'
import { adminRoutes } from './modules/admin/index.js'
import { healthRoutes } from './modules/health/index.js'
import { meRoutes } from './modules/me/index.js'
import { authPlugin } from './plugins/auth.js'
import { bootstrapPlugin } from './plugins/bootstrap.js'
import { cachePlugin } from './plugins/cache.js'
import { dbPlugin } from './plugins/db.js'
import { keycloakAdminPlugin } from './plugins/keycloak-admin.js'
import { mailerPlugin } from './plugins/mailer.js'
import { storagePlugin } from './plugins/storage.js'

/**
 * Builds the Fastify instance with every plugin and route.
 *
 * Order matters: infrastructure first (CORS, multipart, OpenAPI, error
 * handler), then the plugins that decorate the instance (`db`, `cache`,
 * `storage`, `mailer`, `auth`), and finally the routes, which can already rely
 * on those decorators.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: isDevelopment
      ? {
          level: env.LOG_LEVEL,
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
        }
      : { level: env.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: env.MAX_UPLOAD_BYTES,
  })

  // --- CORS: frontend origins only; X-Cache must be readable by the browser.
  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Cache'],
  })

  // --- File uploads: the per-file ceiling matches the body limit above.
  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_UPLOAD_BYTES,
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
      servers: [{ url: `http://localhost:${env.PORT}`, description: 'Local environment' }],
      tags: [
        { name: 'health', description: 'Status of the service and its dependencies' },
        { name: 'profile', description: 'Data about the authenticated user' },
        { name: 'administration', description: 'Users and audit trail' },
      ],
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

  // --- Uniform error envelope for the whole API
  registerErrorHandler(app)

  // --- Infrastructure (all wrapped in fastify-plugin: they decorate the root scope)
  await app.register(dbPlugin)
  await app.register(cachePlugin)
  await app.register(storagePlugin)
  await app.register(mailerPlugin)
  await app.register(keycloakAdminPlugin)
  // Seeds the permission catalog, the system role and root before any request.
  await app.register(bootstrapPlugin)
  await app.register(authPlugin)

  // --- Routes
  // Every path this service answers lives under /api, health checks included.
  // That is what lets the edge route on a single prefix with no exceptions: a
  // probe against /health would otherwise reach the SPA, which answers any
  // unknown path with index.html and HTTP 200 — a readiness check that can
  // never fail.
  await app.register(healthRoutes, { prefix: '/api' })
  await app.register(meRoutes, { prefix: '/api' })
  await app.register(adminRoutes, { prefix: '/api' })

  return app
}
