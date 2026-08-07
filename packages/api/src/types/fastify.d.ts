import type { PermissionKey } from '@clavis/shared'
import type { preHandlerHookHandler } from 'fastify'
import type { Redis } from 'ioredis'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import type { AccessContext } from '../lib/access.js'
import type { AuthContext } from '../plugins/auth.js'
import type { KeycloakCreateUser, KeycloakUser } from '../plugins/keycloak-admin.js'

/**
 * Fastify declaration merging: this is where the types of every decorator
 * installed by the plugins in `src/plugins` live.
 */
declare module 'fastify' {
  interface FastifyInstance {
    /** Verifies the Bearer token, resolves the access context and fills `request.auth`/`request.access`. */
    authenticate: preHandlerHookHandler

    /** Demands every listed permission (logical AND); answers 403 if any is missing. Root bypasses. */
    requirePermissions(...perms: PermissionKey[]): preHandlerHookHandler

    /** Access to PostgreSQL. */
    db: {
      pool: Pool
      query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>
      tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>
      ping(): Promise<boolean>
    }

    /** Cache on Valkey (Redis protocol). */
    cache: {
      client: Redis
      get<T>(key: string): Promise<T | null>
      set(key: string, value: unknown, ttlSeconds?: number): Promise<void>
      /** Current version of the namespace (created at 1 when missing). */
      version(namespace: string): Promise<number>
      /** INCR of the version: invalidates every derived key. */
      bumpVersion(namespace: string): Promise<number>
      ping(): Promise<boolean>
    }

    /** Attachment storage on Azure Blob Storage / Azurite. */
    storage: {
      upload(blobName: string, data: Buffer, contentType: string): Promise<{ blobName: string; size: number }>
      download(blobName: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string; size: number }>
      remove(blobName: string): Promise<void>
      ping(): Promise<boolean>
    }

    /** Keycloak Admin REST client (service account of the confidential client). */
    keycloakAdmin: {
      /** Bounded wait until the service account can authenticate. */
      ready(attempts?: number, retryMs?: number): Promise<void>
      /** Creates a realm user and returns the id Keycloak assigned. */
      createUser(user: KeycloakCreateUser): Promise<string>
      findUserByUsername(username: string): Promise<KeycloakUser | null>
      getUser(id: string): Promise<KeycloakUser>
      setPassword(id: string, value: string, temporary: boolean): Promise<void>
      /** Sends the required-actions email (e.g. UPDATE_PASSWORD) for the user. */
      sendExecuteActionsEmail(id: string, actions: string[]): Promise<void>
      setEnabled(id: string, enabled: boolean): Promise<void>
      deleteUser(id: string): Promise<void>
    }

    /** Email delivery (Resend or dry-run mode). */
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
    /** Token identity of the caller; available after `fastify.authenticate`. */
    auth: AuthContext

    /** What the caller may do, resolved from the database; available after `fastify.authenticate`. */
    access: AccessContext
  }
}
