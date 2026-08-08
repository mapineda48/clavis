import type { AppConfig } from '../config/env.js'
import { type Cache, createCache } from './cache.js'
import { type Db, createDb } from './db.js'
import { type KeycloakAdmin, createKeycloakAdmin } from './keycloak-admin.js'
import type { Logger } from './logger.js'
import { type Mailer, createMailer } from './mailer.js'
import { type Storage, createStorage } from './storage.js'

/**
 * Every stateful service the API is built on, created once at startup.
 *
 * This is the composition root's toolbox: `main.ts` creates it, the boot
 * seeding and `buildApp` consume it, and nothing below this layer ever
 * constructs its own connection. Each factory declares the slice of the
 * configuration it reads (`Pick<AppConfig, …>`), so what a service is allowed
 * to look at is checked at compile time even though the whole object is handed
 * over — one source of truth, and adding a variable to a service is one edit
 * rather than two.
 */
export interface Services {
  log: Logger
  db: Db
  cache: Cache
  storage: Storage
  mailer: Mailer
  keycloakAdmin: KeycloakAdmin
  /** Closes every connection-holding service, newest first. */
  close(): Promise<void>
}

/**
 * Builds the infrastructure in dependency order: the database first (its
 * factory also runs the pending migrations, so nothing can query a schema that
 * is not there yet), then the cache, storage, mailer and the Keycloak Admin
 * client, which hold no ordering constraints among themselves.
 */
export async function createServices(config: AppConfig, log: Logger): Promise<Services> {
  const db = await createDb(config, log)
  const cache = createCache(config, log)
  const storage = await createStorage(config, log)
  const mailer = createMailer(config, log)
  const keycloakAdmin = createKeycloakAdmin(config, log)

  return {
    log,
    db,
    cache,
    storage,
    mailer,
    keycloakAdmin,

    async close() {
      // Reverse creation order; each close swallows its own failure so one
      // stuck connection cannot keep the others open.
      await cache.close().catch((error: unknown) => {
        log.warn({ err: error }, 'Could not close the Valkey connection cleanly')
      })
      await db.close().catch((error: unknown) => {
        log.warn({ err: error }, 'Could not close the PostgreSQL pool cleanly')
      })
    },
  }
}
