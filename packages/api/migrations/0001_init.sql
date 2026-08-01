-- =============================================================================
-- 0001_init.sql — Initial schema of the demo ERP.
-- It is applied exactly once (the migrator stores the checksum in
-- erp.schema_migrations), but it is written idempotently so that re-running it
-- by hand against an already initialized database breaks nothing.
-- gen_random_uuid() is built into PostgreSQL 17: no extension is installed.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS erp;

COMMENT ON SCHEMA erp IS
  'Main schema of the demo ERP: users, tasks, attachments and audit trail.';

-- -----------------------------------------------------------------------------
-- Users
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.users (
  id            uuid PRIMARY KEY,                -- Keycloak 'sub'
  username      text NOT NULL UNIQUE,
  email         text,
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);

COMMENT ON TABLE erp.users IS
  'ERP users. They are created and refreshed just in time while validating the Keycloak access token.';
COMMENT ON COLUMN erp.users.id IS
  'User identifier: the "sub" claim of the Keycloak access token.';
COMMENT ON COLUMN erp.users.username IS
  'The "preferred_username" claim of the token; unique within the realm.';
COMMENT ON COLUMN erp.users.last_seen_at IS
  'Last time the user presented a valid token to the API.';

-- -----------------------------------------------------------------------------
-- Tasks (todos)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.todos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL CHECK (length(btrim(title)) > 0),
  description  text,
  status       text NOT NULL DEFAULT 'todo'
               CHECK (status IN ('todo','in_progress','done')),
  priority     smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  due_date     date,
  owner_id     uuid NOT NULL REFERENCES erp.users(id) ON DELETE CASCADE,
  assignee_id  uuid REFERENCES erp.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

COMMENT ON TABLE erp.todos IS
  'ERP tasks. Visibility: without the todos:read:all permission a user only sees their own or assigned tasks.';
COMMENT ON COLUMN erp.todos.status IS
  'Task status: todo | in_progress | done.';
COMMENT ON COLUMN erp.todos.priority IS
  'Priority from 1 (highest) to 4 (lowest); 3 by default.';
COMMENT ON COLUMN erp.todos.owner_id IS
  'User who created the task.';
COMMENT ON COLUMN erp.todos.assignee_id IS
  'Assigned user; if that user is deleted the task is left unassigned.';
COMMENT ON COLUMN erp.todos.completed_at IS
  'Moment the task moved to the done status.';

-- -----------------------------------------------------------------------------
-- Attachments (the binaries live in Azure Blob Storage / Azurite)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.todo_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  todo_id      uuid NOT NULL REFERENCES erp.todos(id) ON DELETE CASCADE,
  blob_name    text NOT NULL UNIQUE,
  file_name    text NOT NULL,
  content_type text NOT NULL,
  size_bytes   bigint NOT NULL,
  uploaded_by  uuid NOT NULL REFERENCES erp.users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE erp.todo_attachments IS
  'Metadata of the files attached to a task; the content itself is stored in Azure Blob Storage.';
COMMENT ON COLUMN erp.todo_attachments.blob_name IS
  'Name of the blob inside the container configured in AZURE_STORAGE_CONTAINER.';

-- -----------------------------------------------------------------------------
-- Audit trail
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id   uuid,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE erp.audit_log IS
  'Audit trail: one row per domain write (create, edit, delete, attach, notify).';
COMMENT ON COLUMN erp.audit_log.action IS
  'Action in entity.verb form, for example todo.created.';
COMMENT ON COLUMN erp.audit_log.actor_id IS
  'User who performed the action; no foreign key, so the trail survives the deletion of the user.';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_todos_owner_id
  ON erp.todos (owner_id);
CREATE INDEX IF NOT EXISTS idx_todos_assignee_id
  ON erp.todos (assignee_id);
CREATE INDEX IF NOT EXISTS idx_todos_status
  ON erp.todos (status);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
  ON erp.audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_todo_attachments_todo_id
  ON erp.todo_attachments (todo_id);

-- -----------------------------------------------------------------------------
-- Automatic maintenance of updated_at
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION erp.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION erp.set_updated_at() IS
  'BEFORE UPDATE trigger: refreshes the updated_at column with the current time.';

DROP TRIGGER IF EXISTS trg_users_set_updated_at ON erp.users;
CREATE TRIGGER trg_users_set_updated_at
  BEFORE UPDATE ON erp.users
  FOR EACH ROW
  EXECUTE FUNCTION erp.set_updated_at();

DROP TRIGGER IF EXISTS trg_todos_set_updated_at ON erp.todos;
CREATE TRIGGER trg_todos_set_updated_at
  BEFORE UPDATE ON erp.todos
  FOR EACH ROW
  EXECUTE FUNCTION erp.set_updated_at();
