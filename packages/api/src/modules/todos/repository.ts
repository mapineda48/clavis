// Acceso a datos del modulo de todos.
// Funciones puras contra `fastify.db`: reciben el objeto db como primer argumento,
// usan SQL siempre parametrizado y devuelven DTOs en camelCase con fechas ISO 8601.
import type { FastifyInstance } from 'fastify'
import type { ScopeFilter } from '../shared/scope.js'

/** Acceso a base de datos decorado en la instancia Fastify. */
type Database = FastifyInstance['db']

/** Estados admitidos por `erp.todos.status`. */
export type TodoStatus = 'todo' | 'in_progress' | 'done'

/** Representacion publica de un todo. */
export interface TodoDto {
  id: string
  title: string
  description: string | null
  status: TodoStatus
  priority: number
  dueDate: string | null
  ownerId: string
  assigneeId: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  attachmentsCount: number
}

/** Datos minimos de un usuario del ERP. */
export interface UserDto {
  id: string
  username: string
  email: string | null
  displayName: string | null
  lastSeenAt: string | null
}

/** Datos de creacion de un todo. */
export interface CreateTodoInput {
  title: string
  description?: string | null
  status?: TodoStatus
  priority?: number
  dueDate?: string | null
  ownerId: string
  assigneeId?: string | null
}

/** Datos de actualizacion parcial de un todo. */
export interface UpdateTodoInput {
  title?: string
  description?: string | null
  status?: TodoStatus
  priority?: number
  dueDate?: string | null
  assigneeId?: string | null
}

/** Opciones del listado paginado. */
export interface ListTodosOptions {
  scope: ScopeFilter
  status?: TodoStatus | null
  q?: string | null
  page: number
  pageSize: number
}

/** Resultado del listado paginado. */
export interface ListTodosResult {
  items: TodoDto[]
  total: number
}

// --- Tipos de fila (alias de tipo, no interfaces: pg exige indice implicito) ---

type TodoRow = {
  id: string
  title: string
  description: string | null
  status: string
  priority: number
  due_date: string | null
  owner_id: string
  assignee_id: string | null
  created_at: Date | string
  updated_at: Date | string
  completed_at: Date | string | null
  attachments_count: number | string
}

type UserRow = {
  id: string
  username: string
  email: string | null
  display_name: string | null
  last_seen_at: Date | string | null
}

/**
 * Columnas publicas de un todo. Requiere que la tabla (o la CTE) este aliada
 * como `t`. `due_date` se formatea en SQL para no depender del huso horario
 * del cliente al convertir el tipo `date`.
 */
const TODO_COLUMNS = `
  t.id,
  t.title,
  t.description,
  t.status,
  t.priority,
  to_char(t.due_date, 'YYYY-MM-DD') AS due_date,
  t.owner_id,
  t.assignee_id,
  t.created_at,
  t.updated_at,
  t.completed_at,
  (SELECT count(*)::int FROM erp.todo_attachments a WHERE a.todo_id = t.id) AS attachments_count
`

/** Orden estable: pendientes primero, luego prioridad, vencimiento y antiguedad. */
const TODO_ORDER = `ORDER BY (t.status = 'done'), t.priority ASC, t.due_date ASC NULLS LAST, t.created_at DESC`

/** Convierte un timestamptz de pg (Date o texto) a ISO 8601. */
function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** Igual que `toIso` pero para columnas NOT NULL. */
function requireIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** Escapa los comodines de LIKE/ILIKE para que la busqueda sea literal. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

/** Mapea una fila de `erp.todos` al DTO publico. */
function mapTodo(row: TodoRow): TodoDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as TodoStatus,
    priority: Number(row.priority),
    dueDate: row.due_date,
    ownerId: row.owner_id,
    assigneeId: row.assignee_id,
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
    completedAt: toIso(row.completed_at),
    attachmentsCount: Number(row.attachments_count ?? 0),
  }
}

/** Mapea una fila de `erp.users` al DTO publico. */
function mapUser(row: UserRow): UserDto {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    lastSeenAt: toIso(row.last_seen_at),
  }
}

/** Lista paginada de todos aplicando el filtro de visibilidad y los filtros de la query. */
export async function listTodos(db: Database, options: ListTodosOptions): Promise<ListTodosResult> {
  const conditions: string[] = [options.scope.clause]
  const params: unknown[] = [...options.scope.params]
  let index = options.scope.nextIndex

  if (options.status) {
    conditions.push(`t.status = $${index}`)
    params.push(options.status)
    index += 1
  }

  if (options.q) {
    conditions.push(`(t.title ILIKE $${index} OR coalesce(t.description, '') ILIKE $${index})`)
    params.push(`%${escapeLike(options.q)}%`)
    index += 1
  }

  const where = conditions.join(' AND ')

  const totals = await db.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM erp.todos t WHERE ${where}`,
    params,
  )
  const total = totals.rows[0]?.total ?? 0

  const offset = (options.page - 1) * options.pageSize
  const rows = await db.query<TodoRow>(
    `SELECT ${TODO_COLUMNS}
     FROM erp.todos t
     WHERE ${where}
     ${TODO_ORDER}
     LIMIT $${index} OFFSET $${index + 1}`,
    [...params, options.pageSize, offset],
  )

  return { items: rows.rows.map(mapTodo), total }
}

/** Devuelve un todo por su id, o null si no existe. */
export async function getTodoById(db: Database, id: string): Promise<TodoDto | null> {
  const result = await db.query<TodoRow>(
    `SELECT ${TODO_COLUMNS} FROM erp.todos t WHERE t.id = $1`,
    [id],
  )
  const row = result.rows[0]
  return row ? mapTodo(row) : null
}

/** Crea un todo y devuelve el DTO resultante. */
export async function createTodo(db: Database, input: CreateTodoInput): Promise<TodoDto> {
  const status: TodoStatus = input.status ?? 'todo'
  const result = await db.query<TodoRow>(
    `WITH inserted AS (
       INSERT INTO erp.todos (title, description, status, priority, due_date, owner_id, assignee_id, completed_at)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, CASE WHEN $3 = 'done' THEN now() ELSE NULL END)
       RETURNING *
     )
     SELECT ${TODO_COLUMNS} FROM inserted t`,
    [
      input.title.trim(),
      input.description ?? null,
      status,
      input.priority ?? 3,
      input.dueDate ?? null,
      input.ownerId,
      input.assigneeId ?? null,
    ],
  )
  return mapTodo(result.rows[0] as TodoRow)
}

/**
 * Actualiza parcialmente un todo. Devuelve null si no existe.
 * `completed_at` se sincroniza con el estado; `updated_at` lo mantiene el trigger.
 */
export async function updateTodo(
  db: Database,
  id: string,
  patch: UpdateTodoInput,
): Promise<TodoDto | null> {
  const assignments: string[] = []
  const params: unknown[] = []
  let index = 1

  if (patch.title !== undefined) {
    assignments.push(`title = $${index}`)
    params.push(patch.title.trim())
    index += 1
  }
  if (patch.description !== undefined) {
    assignments.push(`description = $${index}`)
    params.push(patch.description)
    index += 1
  }
  if (patch.priority !== undefined) {
    assignments.push(`priority = $${index}`)
    params.push(patch.priority)
    index += 1
  }
  if (patch.dueDate !== undefined) {
    assignments.push(`due_date = $${index}::date`)
    params.push(patch.dueDate)
    index += 1
  }
  if (patch.assigneeId !== undefined) {
    assignments.push(`assignee_id = $${index}`)
    params.push(patch.assigneeId)
    index += 1
  }
  if (patch.status !== undefined) {
    assignments.push(`status = $${index}`)
    params.push(patch.status)
    index += 1
    assignments.push(
      patch.status === 'done' ? 'completed_at = coalesce(completed_at, now())' : 'completed_at = NULL',
    )
  }

  if (assignments.length === 0) {
    return getTodoById(db, id)
  }

  params.push(id)
  const result = await db.query<TodoRow>(
    `WITH updated AS (
       UPDATE erp.todos
       SET ${assignments.join(', ')}
       WHERE id = $${index}
       RETURNING *
     )
     SELECT ${TODO_COLUMNS} FROM updated t`,
    params,
  )
  const row = result.rows[0]
  return row ? mapTodo(row) : null
}

/**
 * Borra un todo. Devuelve los blobs de sus adjuntos para que el llamante los
 * elimine del almacenamiento (la fila se borra en cascada).
 */
export async function deleteTodo(
  db: Database,
  id: string,
): Promise<{ deleted: boolean; blobNames: string[] }> {
  return db.tx(async (client) => {
    const attachments = await client.query<{ blob_name: string }>(
      'SELECT blob_name FROM erp.todo_attachments WHERE todo_id = $1',
      [id],
    )
    const removed = await client.query('DELETE FROM erp.todos WHERE id = $1', [id])
    return {
      deleted: (removed.rowCount ?? 0) > 0,
      blobNames: attachments.rows.map((row) => row.blob_name),
    }
  })
}

/** Catalogo de tareas de ejemplo de un ERP real. `days` es el desfase de vencimiento. */
const DEMO_TODOS: ReadonlyArray<{
  title: string
  description: string
  status: TodoStatus
  priority: number
  days: number
}> = [
  {
    title: 'Conciliar facturas de proveedores',
    description: 'Cuadrar las facturas recibidas con los albaranes y los pagos del mes en curso.',
    status: 'in_progress',
    priority: 1,
    days: 3,
  },
  {
    title: 'Revisar inventario del almacen central',
    description: 'Recuento ciclico de las referencias de mayor rotacion y ajuste de existencias.',
    status: 'todo',
    priority: 2,
    days: 7,
  },
  {
    title: 'Aprobar ordenes de compra pendientes',
    description: 'Validar las ordenes por encima de 5.000 EUR que esperan la firma de compras.',
    status: 'todo',
    priority: 1,
    days: 1,
  },
  {
    title: 'Cerrar el periodo contable',
    description: 'Asientos de cierre, amortizaciones y conciliacion bancaria del periodo.',
    status: 'todo',
    priority: 2,
    days: 12,
  },
  {
    title: 'Auditar proveedores criticos',
    description: 'Revisar certificaciones, plazos de entrega e incidencias de los proveedores clave.',
    status: 'done',
    priority: 3,
    days: -4,
  },
  {
    title: 'Actualizar el catalogo de articulos',
    description: 'Nuevas altas, bajas de referencias descatalogadas y revision de tarifas.',
    status: 'in_progress',
    priority: 4,
    days: 21,
  },
]

/**
 * Crea las tareas de ejemplo del usuario. Es idempotente: si ya tiene todos
 * propios devuelve `created: 0` sin insertar nada.
 */
export async function seedDemoTodos(
  db: Database,
  ownerId: string,
): Promise<{ created: number; items: TodoDto[] }> {
  const existing = await db.query<{ total: number }>(
    'SELECT count(*)::int AS total FROM erp.todos WHERE owner_id = $1',
    [ownerId],
  )
  if ((existing.rows[0]?.total ?? 0) > 0) {
    return { created: 0, items: [] }
  }

  const result = await db.query<TodoRow>(
    `WITH inserted AS (
       INSERT INTO erp.todos (title, description, status, priority, due_date, owner_id, assignee_id, completed_at)
       SELECT s.title,
              s.description,
              s.status,
              s.priority,
              (now() + (s.days * interval '1 day'))::date,
              $6,
              $6,
              CASE WHEN s.status = 'done' THEN now() - interval '1 day' ELSE NULL END
       FROM unnest($1::text[], $2::text[], $3::text[], $4::smallint[], $5::int[])
            AS s(title, description, status, priority, days)
       RETURNING *
     )
     SELECT ${TODO_COLUMNS} FROM inserted t ${TODO_ORDER}`,
    [
      DEMO_TODOS.map((todo) => todo.title),
      DEMO_TODOS.map((todo) => todo.description),
      DEMO_TODOS.map((todo) => todo.status),
      DEMO_TODOS.map((todo) => todo.priority),
      DEMO_TODOS.map((todo) => todo.days),
      ownerId,
    ],
  )

  const items = result.rows.map(mapTodo)
  return { created: items.length, items }
}

/** Conteo de todos por estado; con `scope` limita el conteo a lo visible. */
export async function countByStatus(
  db: Database,
  scope?: ScopeFilter,
): Promise<Record<TodoStatus, number>> {
  const where = scope ? `WHERE ${scope.clause}` : ''
  const result = await db.query<{ status: string; total: number }>(
    `SELECT t.status, count(*)::int AS total FROM erp.todos t ${where} GROUP BY t.status`,
    scope ? scope.params : [],
  )

  const counts: Record<TodoStatus, number> = { todo: 0, in_progress: 0, done: 0 }
  for (const row of result.rows) {
    if (row.status === 'todo' || row.status === 'in_progress' || row.status === 'done') {
      counts[row.status] = Number(row.total)
    }
  }
  return counts
}

/** Busca un usuario del ERP por su id (`sub` de Keycloak). */
export async function findUserById(db: Database, id: string): Promise<UserDto | null> {
  const result = await db.query<UserRow>(
    'SELECT id, username, email, display_name, last_seen_at FROM erp.users WHERE id = $1',
    [id],
  )
  const row = result.rows[0]
  return row ? mapUser(row) : null
}
