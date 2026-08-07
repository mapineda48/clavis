-- =============================================================================
-- 0001_init.sql — Access-control base of Clavis.
-- It is applied exactly once (the migrator stores the checksum in
-- clavis.schema_migrations), but it is written idempotently so that re-running
-- it by hand against an already initialized database breaks nothing.
--
-- Authorization model: Keycloak authenticates; this schema decides. Permission
-- KEYS are declared in code (@clavis/shared) and synced into `permissions` at
-- boot; the database owns the ASSIGNMENTS: roles, role_permissions, user_roles
-- and per-user overrides. Effective permissions =
--   union(role permissions) ∪ grants − revokes,
-- with is_root short-circuiting to the full catalog.
--
-- gen_random_uuid() is built into PostgreSQL 17: no extension is installed.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS clavis;

COMMENT ON SCHEMA clavis IS
  'Main schema of Clavis: users, roles, permissions, overrides and audit trail.';

-- -----------------------------------------------------------------------------
-- Users
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clavis.users (
  id            uuid PRIMARY KEY,                -- Keycloak 'sub'
  username      text NOT NULL UNIQUE,
  email         text NOT NULL UNIQUE,
  display_name  text,
  is_root       boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);

COMMENT ON TABLE clavis.users IS
  'System users. Created from the application (which registers them in Keycloak first); the root user is seeded at boot from the deployment variables.';
COMMENT ON COLUMN clavis.users.id IS
  'User identifier: the id Keycloak assigned on creation (the "sub" claim of its tokens).';
COMMENT ON COLUMN clavis.users.is_root IS
  'Break-glass flag: root bypasses the permission system entirely and cannot be disabled or edited through the access UI.';
COMMENT ON COLUMN clavis.users.status IS
  'active | disabled. A disabled user authenticates in Keycloak but every API request is refused.';
COMMENT ON COLUMN clavis.users.last_seen_at IS
  'Last time the user presented a valid token to the API.';

-- -----------------------------------------------------------------------------
-- Permission catalog (synced from code at boot; never edited by hand)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clavis.permissions (
  key         text PRIMARY KEY,
  module      text NOT NULL,
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clavis.permissions IS
  'Permission catalog. The source of truth is PERMISSION_DEFS in @clavis/shared: the API upserts it at boot and deletes keys that no longer exist there.';
COMMENT ON COLUMN clavis.permissions.key IS
  'Permission key in module:action form, for example users:create.';

-- -----------------------------------------------------------------------------
-- Roles and their permissions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clavis.roles (
  slug        text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clavis.roles IS
  'Assignable roles. System roles (is_system) are seeded at boot and cannot be edited or deleted through the API.';

CREATE TABLE IF NOT EXISTS clavis.role_permissions (
  role_slug      text NOT NULL REFERENCES clavis.roles(slug) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES clavis.permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_slug, permission_key)
);

CREATE TABLE IF NOT EXISTS clavis.user_roles (
  user_id   uuid NOT NULL REFERENCES clavis.users(id) ON DELETE CASCADE,
  role_slug text NOT NULL REFERENCES clavis.roles(slug) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_slug)
);

-- -----------------------------------------------------------------------------
-- Per-user exceptions on top of the roles
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clavis.user_permission_overrides (
  user_id        uuid NOT NULL REFERENCES clavis.users(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES clavis.permissions(key) ON DELETE CASCADE,
  effect         text NOT NULL CHECK (effect IN ('grant','revoke')),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_key)
);

COMMENT ON TABLE clavis.user_permission_overrides IS
  'Per-user exceptions: grant adds a permission the roles do not give; revoke removes one they do. Revoke wins over any role.';
COMMENT ON COLUMN clavis.user_permission_overrides.created_by IS
  'User who recorded the exception; no foreign key so the row survives the author''s deletion.';

-- -----------------------------------------------------------------------------
-- Audit trail
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clavis.audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id   uuid,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clavis.audit_log IS
  'Audit trail: one row per domain write (user created, role changed, override recorded, ...).';
COMMENT ON COLUMN clavis.audit_log.action IS
  'Action in entity.verb form, for example user.created.';
COMMENT ON COLUMN clavis.audit_log.actor_id IS
  'User who performed the action; no foreign key, so the trail survives the deletion of the user.';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_user_roles_role_slug
  ON clavis.user_roles (role_slug);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission_key
  ON clavis.role_permissions (permission_key);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
  ON clavis.audit_log (created_at DESC);

-- -----------------------------------------------------------------------------
-- Automatic maintenance of updated_at
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION clavis.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION clavis.set_updated_at() IS
  'BEFORE UPDATE trigger: refreshes the updated_at column with the current time.';

DROP TRIGGER IF EXISTS trg_users_set_updated_at ON clavis.users;
CREATE TRIGGER trg_users_set_updated_at
  BEFORE UPDATE ON clavis.users
  FOR EACH ROW
  EXECUTE FUNCTION clavis.set_updated_at();

DROP TRIGGER IF EXISTS trg_roles_set_updated_at ON clavis.roles;
CREATE TRIGGER trg_roles_set_updated_at
  BEFORE UPDATE ON clavis.roles
  FOR EACH ROW
  EXECUTE FUNCTION clavis.set_updated_at();
