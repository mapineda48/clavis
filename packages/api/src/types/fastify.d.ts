import type { preHandlerHookHandler } from 'fastify'
import type { Redis } from 'ioredis'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import type { AuthContext, Permission } from '../lib/permissions.js'

/**
 * Declaration merging de Fastify: aquí viven los tipos de todos los
 * decoradores que instalan los plugins de `src/plugins`.
 */
declare module 'fastify' {
  interface FastifyInstance {
    /** Verifica el Bearer token y rellena `request.auth`. */
    authenticate: preHandlerHookHandler

    /** Exige todos los permisos indicados (AND lógico); responde 403 si falta alguno. */
    requirePermissions(...perms: Permission[]): preHandlerHookHandler

    /** Acceso a PostgreSQL. */
    db: {
      pool: Pool
      query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>
      tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>
      ping(): Promise<boolean>
    }

    /** Caché en Valkey (protocolo Redis). */
    cache: {
      client: Redis
      get<T>(key: string): Promise<T | null>
      set(key: string, value: unknown, ttlSeconds?: number): Promise<void>
      /** Versión actual del namespace (se crea en 1 si no existe). */
      version(namespace: string): Promise<number>
      /** INCR de la versión: invalida todas las claves derivadas. */
      bumpVersion(namespace: string): Promise<number>
      ping(): Promise<boolean>
    }

    /** Almacenamiento de adjuntos en Azure Blob Storage / Azurite. */
    storage: {
      upload(blobName: string, data: Buffer, contentType: string): Promise<{ blobName: string; size: number }>
      download(blobName: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string; size: number }>
      remove(blobName: string): Promise<void>
      ping(): Promise<boolean>
    }

    /** Envío de correo (Resend o modo dry-run). */
    mailer: {
      enabled: boolean
      provider: 'resend' | 'dry-run'
      from: string
      send(msg: {
        to: string | string[]
        subject: string
        html: string
        text?: string
      }): Promise<{ id: string | null; delivered: boolean; provider: 'resend' | 'dry-run'; reason?: string }>
    }
  }

  interface FastifyRequest {
    /** Contexto del usuario autenticado; disponible tras `fastify.authenticate`. */
    auth: AuthContext
  }
}
