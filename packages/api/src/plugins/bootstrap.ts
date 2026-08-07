import { PERMISSION_DEFS, PERMISSION_KEYS } from '@clavis/shared'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import type { AppConfig } from '../config/env.js'
import { ACCESS_NAMESPACE } from '../lib/access.js'

/** The slice of the configuration this plugin reads. */
export type BootstrapPluginOptions = Pick<
  AppConfig,
  'ROOT_USERNAME' | 'ROOT_EMAIL' | 'ROOT_PASSWORD' | 'ROOT_DISPLAY_NAME'
>

/**
 * Boot seeding, in order:
 *
 *   1. Permission catalog: `clavis.permissions` mirrors PERMISSION_DEFS —
 *      upsert every entry, delete keys the code no longer declares (their
 *      role/override rows cascade; no back-compat by design).
 *   2. System role `admin`: an assignable, full-catalog role for day-to-day
 *      administration. Its permission set is resynced on every boot.
 *   3. Root: the one account that is not created from the application. It is
 *      looked up (and created if missing) in Keycloak by ROOT_USERNAME, its
 *      password is re-applied from the environment so the deployment variables
 *      stay authoritative, and its `clavis.users` row is re-linked by id —
 *      a realm re-import may have minted a new Keycloak id for the same
 *      username, in which case the stale row is replaced (root carries no
 *      roles or overrides, so nothing is lost).
 *
 * Root is a COLUMN (`is_root`), not a role: break-glass access must not be
 * grantable or revocable through the roles UI.
 */
export const bootstrapPlugin = fp<BootstrapPluginOptions>(
  async (app: FastifyInstance, options) => {
    // --- 1. permission catalog -------------------------------------------------
    const keys = PERMISSION_DEFS.map((def) => def.key)
    const modules = PERMISSION_DEFS.map((def) => def.module)
    const descriptions = PERMISSION_DEFS.map((def) => def.description)

    await app.db.tx(async (client) => {
      await client.query(
        `INSERT INTO clavis.permissions (key, module, description)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
         ON CONFLICT (key) DO UPDATE
           SET module = EXCLUDED.module, description = EXCLUDED.description`,
        [keys, modules, descriptions],
      )
      await client.query(`DELETE FROM clavis.permissions WHERE key <> ALL($1::text[])`, [keys])
    })
    app.log.info({ permissions: keys.length }, 'Permission catalog synced')

    // --- 2. system role `admin` ------------------------------------------------
    await app.db.tx(async (client) => {
      await client.query(
        `INSERT INTO clavis.roles (slug, name, description, is_system)
         VALUES ('admin', 'Administrator', 'Every permission in the catalog', true)
         ON CONFLICT (slug) DO UPDATE
           SET name = EXCLUDED.name, description = EXCLUDED.description, is_system = true`,
      )
      await client.query(
        `DELETE FROM clavis.role_permissions
          WHERE role_slug = 'admin' AND permission_key <> ALL($1::text[])`,
        [keys],
      )
      await client.query(
        `INSERT INTO clavis.role_permissions (role_slug, permission_key)
         SELECT 'admin', unnest($1::text[])
         ON CONFLICT DO NOTHING`,
        [keys],
      )
    })
    app.log.info('System role "admin" seeded with the full catalog')

    // --- 3. root ---------------------------------------------------------------
    await app.keycloakAdmin.ready()

    const existing = await app.keycloakAdmin.findUserByUsername(options.ROOT_USERNAME)
    let rootId: string
    if (existing === null) {
      rootId = await app.keycloakAdmin.createUser({
        username: options.ROOT_USERNAME,
        email: options.ROOT_EMAIL,
        firstName: options.ROOT_DISPLAY_NAME,
        emailVerified: true,
        enabled: true,
      })
      app.log.info({ rootId }, 'Root user created in Keycloak')
    } else {
      rootId = existing.id
      if (!existing.enabled) await app.keycloakAdmin.setEnabled(rootId, true)
    }

    // Always re-applied: the environment is the source of truth for root.
    await app.keycloakAdmin.setPassword(rootId, options.ROOT_PASSWORD, false)

    await app.db.tx(async (client) => {
      // A realm re-import may have assigned a new id to the same username or
      // email; the unique constraints demand the stale row goes first.
      await client.query(
        `DELETE FROM clavis.users WHERE (username = $1 OR email = $2) AND id <> $3`,
        [options.ROOT_USERNAME, options.ROOT_EMAIL, rootId],
      )
      await client.query(
        `INSERT INTO clavis.users (id, username, email, display_name, is_root, status)
         VALUES ($1, $2, $3, $4, true, 'active')
         ON CONFLICT (id) DO UPDATE
           SET username = EXCLUDED.username,
               email = EXCLUDED.email,
               display_name = EXCLUDED.display_name,
               is_root = true,
               status = 'active'`,
        [rootId, options.ROOT_USERNAME, options.ROOT_EMAIL, options.ROOT_DISPLAY_NAME],
      )
    })

    await app.cache.bumpVersion(ACCESS_NAMESPACE)
    app.log.info(
      { rootId, username: options.ROOT_USERNAME, catalog: PERMISSION_KEYS.length },
      'Access-control base ready: catalog synced, admin role seeded, root linked',
    )
  },
  {
    name: 'clavis-bootstrap',
    dependencies: ['clavis-db', 'clavis-cache', 'clavis-keycloak-admin'],
  },
)

export default bootstrapPlugin
