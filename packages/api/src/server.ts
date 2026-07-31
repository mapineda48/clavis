import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import Fastify, { type FastifyInstance } from 'fastify'
import { env, isDevelopment } from './config/env.js'
import { registerErrorHandler } from './lib/errors.js'
import { adminRoutes } from './modules/admin/index.js'
import { attachmentsRoutes } from './modules/attachments/index.js'
import { healthRoutes } from './modules/health/index.js'
import { meRoutes } from './modules/me/index.js'
import { todosRoutes } from './modules/todos/index.js'
import { authPlugin } from './plugins/auth.js'
import { cachePlugin } from './plugins/cache.js'
import { dbPlugin } from './plugins/db.js'
import { mailerPlugin } from './plugins/mailer.js'
import { storagePlugin } from './plugins/storage.js'

/**
 * Construye la instancia de Fastify con todos los plugins y rutas.
 *
 * Orden importante: primero la infraestructura (CORS, multipart, OpenAPI,
 * manejador de errores), después los plugins que decoran la instancia
 * (`db`, `cache`, `storage`, `mailer`, `auth`) y por último las rutas, que ya
 * pueden usar esos decoradores.
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

  // --- CORS: sólo los orígenes del frontend; X-Cache debe ser legible por el navegador.
  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Cache'],
  })

  // --- Subida de adjuntos
  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_UPLOAD_BYTES,
      files: 1,
    },
  })

  // --- Documentación OpenAPI
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'API del ERP demo',
        description:
          'API de tareas con autenticación y permisos de Keycloak, caché en Valkey, ' +
          'adjuntos en Azure Blob Storage y notificaciones por correo.',
        version: '1.0.0',
      },
      servers: [{ url: `http://localhost:${env.PORT}`, description: 'Entorno local' }],
      tags: [
        { name: 'salud', description: 'Estado del servicio y de sus dependencias' },
        { name: 'perfil', description: 'Datos del usuario autenticado' },
        { name: 'todos', description: 'Gestión de tareas' },
        { name: 'adjuntos', description: 'Ficheros asociados a las tareas' },
        { name: 'administracion', description: 'Estadísticas, usuarios y auditoría' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Access token emitido por Keycloak para la audiencia erp-api.',
          },
        },
      },
    },
  })

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
    },
  })

  // --- Sobre de error homogéneo para toda la API
  registerErrorHandler(app)

  // --- Infraestructura (todos envueltos en fastify-plugin: decoran el scope raíz)
  await app.register(dbPlugin)
  await app.register(cachePlugin)
  await app.register(storagePlugin)
  await app.register(mailerPlugin)
  await app.register(authPlugin)

  // --- Rutas
  await app.register(healthRoutes)
  await app.register(meRoutes, { prefix: '/api' })
  await app.register(todosRoutes, { prefix: '/api' })
  await app.register(attachmentsRoutes, { prefix: '/api' })
  await app.register(adminRoutes, { prefix: '/api' })

  return app
}
