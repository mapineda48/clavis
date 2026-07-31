-- =============================================================================
-- 0001_init.sql — Esquema inicial del ERP demo.
-- Se aplica una única vez (el migrador registra el checksum en
-- erp.schema_migrations), pero está escrito de forma idempotente para que
-- reejecutarlo a mano sobre una base ya inicializada no rompa nada.
-- gen_random_uuid() es nativo en PostgreSQL 17: no se instala ninguna extensión.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS erp;

COMMENT ON SCHEMA erp IS
  'Esquema principal del ERP demo: usuarios, tareas, adjuntos y auditoría.';

-- -----------------------------------------------------------------------------
-- Usuarios
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.users (
  id            uuid PRIMARY KEY,                -- 'sub' de Keycloak
  username      text NOT NULL UNIQUE,
  email         text,
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);

COMMENT ON TABLE erp.users IS
  'Usuarios del ERP. Se crean y actualizan "just in time" al validar el access token de Keycloak.';
COMMENT ON COLUMN erp.users.id IS
  'Identificador del usuario: claim "sub" del access token de Keycloak.';
COMMENT ON COLUMN erp.users.username IS
  'Claim "preferred_username" del token; único dentro del realm.';
COMMENT ON COLUMN erp.users.last_seen_at IS
  'Última vez que el usuario presentó un token válido contra la API.';

-- -----------------------------------------------------------------------------
-- Tareas (todos)
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
  'Tareas del ERP. Visibilidad: sin el permiso todos:read:all solo se ven las propias o las asignadas.';
COMMENT ON COLUMN erp.todos.status IS
  'Estado de la tarea: todo | in_progress | done.';
COMMENT ON COLUMN erp.todos.priority IS
  'Prioridad de 1 (máxima) a 4 (mínima); 3 por defecto.';
COMMENT ON COLUMN erp.todos.owner_id IS
  'Usuario que creó la tarea.';
COMMENT ON COLUMN erp.todos.assignee_id IS
  'Usuario asignado; si se borra el usuario la tarea queda sin asignar.';
COMMENT ON COLUMN erp.todos.completed_at IS
  'Momento en que la tarea pasó a estado done.';

-- -----------------------------------------------------------------------------
-- Adjuntos (los binarios viven en Azure Blob Storage / Azurite)
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
  'Metadatos de los ficheros adjuntos a una tarea; el contenido se guarda en Azure Blob Storage.';
COMMENT ON COLUMN erp.todo_attachments.blob_name IS
  'Nombre del blob dentro del contenedor configurado en AZURE_STORAGE_CONTAINER.';

-- -----------------------------------------------------------------------------
-- Auditoría
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
  'Registro de auditoría: una fila por cada escritura de dominio (crear, editar, borrar, adjuntar, notificar).';
COMMENT ON COLUMN erp.audit_log.action IS
  'Acción en formato entidad.verbo, por ejemplo todo.created.';
COMMENT ON COLUMN erp.audit_log.actor_id IS
  'Usuario que ejecutó la acción; sin clave foránea para conservar la traza aunque se borre el usuario.';

-- -----------------------------------------------------------------------------
-- Índices
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
-- Mantenimiento automático de updated_at
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
  'Trigger BEFORE UPDATE: refresca la columna updated_at con la hora actual.';

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
