// Data access for the todos module.
// Pure functions on top of `fastify.db`: they take the db object as their first
// argument, always use parameterized SQL and return camelCase DTOs with ISO 8601 dates.
import type { FastifyInstance } from 'fastify'
import type { ScopeFilter } from '../shared/scope.js'

/** Database access decorated on the Fastify instance. */
type Database = FastifyInstance['db']

/** Statuses accepted by `clavis.todos.status`. */
export type TodoStatus = 'todo' | 'in_progress' | 'done'

/** Public representation of a todo. */
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

/** Minimal data of a Clavis user. */
export interface UserDto {
  id: string
  username: string
  email: string | null
  displayName: string | null
  lastSeenAt: string | null
}

/** Input data to create a todo. */
export interface CreateTodoInput {
  title: string
  description?: string | null
  status?: TodoStatus
  priority?: number
  dueDate?: string | null
  ownerId: string
  assigneeId?: string | null
}

/** Input data to partially update a todo. */
export interface UpdateTodoInput {
  title?: string
  description?: string | null
  status?: TodoStatus
  priority?: number
  dueDate?: string | null
  assigneeId?: string | null
}

/** Options of the paginated listing. */
export interface ListTodosOptions {
  scope: ScopeFilter
  status?: TodoStatus | null
  q?: string | null
  page: number
  pageSize: number
}

/** Result of the paginated listing. */
export interface ListTodosResult {
  items: TodoDto[]
  total: number
}

// --- Row types (type aliases, not interfaces: pg requires an implicit index signature) ---

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
 * Public columns of a todo. Requires the table (or the CTE) to be aliased as
 * `t`. `due_date` is formatted in SQL so that converting the `date` type does
 * not depend on the client time zone.
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
  (SELECT count(*)::int FROM clavis.todo_attachments a WHERE a.todo_id = t.id) AS attachments_count
`

/** Stable ordering: open tasks first, then priority, due date and age. */
const TODO_ORDER = `ORDER BY (t.status = 'done'), t.priority ASC, t.due_date ASC NULLS LAST, t.created_at DESC`

/** Converts a pg timestamptz (Date or text) to ISO 8601. */
function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** Same as `toIso` but for NOT NULL columns. */
function requireIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** Escapes LIKE/ILIKE wildcards so the search stays literal. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

/** Maps a row of `clavis.todos` to the public DTO. */
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

/** Maps a row of `clavis.users` to the public DTO. */
function mapUser(row: UserRow): UserDto {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    lastSeenAt: toIso(row.last_seen_at),
  }
}

/** Paginated list of todos applying the visibility filter and the query filters. */
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
    `SELECT count(*)::int AS total FROM clavis.todos t WHERE ${where}`,
    params,
  )
  const total = totals.rows[0]?.total ?? 0

  const offset = (options.page - 1) * options.pageSize
  const rows = await db.query<TodoRow>(
    `SELECT ${TODO_COLUMNS}
     FROM clavis.todos t
     WHERE ${where}
     ${TODO_ORDER}
     LIMIT $${index} OFFSET $${index + 1}`,
    [...params, options.pageSize, offset],
  )

  return { items: rows.rows.map(mapTodo), total }
}

/** Returns a todo by its id, or null when it does not exist. */
export async function getTodoById(db: Database, id: string): Promise<TodoDto | null> {
  const result = await db.query<TodoRow>(
    `SELECT ${TODO_COLUMNS} FROM clavis.todos t WHERE t.id = $1`,
    [id],
  )
  const row = result.rows[0]
  return row ? mapTodo(row) : null
}

/** Creates a todo and returns the resulting DTO. */
export async function createTodo(db: Database, input: CreateTodoInput): Promise<TodoDto> {
  const status: TodoStatus = input.status ?? 'todo'
  const result = await db.query<TodoRow>(
    `WITH inserted AS (
       INSERT INTO clavis.todos (title, description, status, priority, due_date, owner_id, assignee_id, completed_at)
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
 * Partially updates a todo. Returns null when it does not exist.
 * `completed_at` is kept in sync with the status; `updated_at` is the trigger's job.
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
       UPDATE clavis.todos
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
 * Deletes a todo. Returns the blobs of its attachments so the caller can remove
 * them from storage (the rows themselves are deleted by cascade).
 */
export async function deleteTodo(
  db: Database,
  id: string,
): Promise<{ deleted: boolean; blobNames: string[] }> {
  return db.tx(async (client) => {
    const attachments = await client.query<{ blob_name: string }>(
      'SELECT blob_name FROM clavis.todo_attachments WHERE todo_id = $1',
      [id],
    )
    const removed = await client.query('DELETE FROM clavis.todos WHERE id = $1', [id])
    return {
      deleted: (removed.rowCount ?? 0) > 0,
      blobNames: attachments.rows.map((row) => row.blob_name),
    }
  })
}

/** Catalogue of sample tasks from a real ERP. `days` is the due-date offset. */
const DEMO_TODOS: ReadonlyArray<{
  title: string
  description: string
  status: TodoStatus
  priority: number
  days: number
}> = [
  {
    title: 'Reconcile supplier invoices',
    description: 'Match the invoices received against delivery notes and the payments of the current month.',
    status: 'in_progress',
    priority: 1,
    days: 3,
  },
  {
    title: 'Run stock count at the central warehouse',
    description: 'Cycle count of the fastest-moving SKUs and adjustment of the on-hand quantities.',
    status: 'todo',
    priority: 2,
    days: 7,
  },
  {
    title: 'Approve pending purchase orders',
    description: 'Validate the orders above EUR 5,000 that are waiting for the purchasing sign-off.',
    status: 'todo',
    priority: 1,
    days: 1,
  },
  {
    title: 'Close the accounting period',
    description: 'Closing entries, depreciation and bank reconciliation for the period.',
    status: 'todo',
    priority: 2,
    days: 12,
  },
  {
    title: 'Audit critical suppliers',
    description: 'Review certifications, lead times and incidents of the key suppliers.',
    status: 'done',
    priority: 3,
    days: -4,
  },
  {
    title: 'Update the product catalogue',
    description: 'New items, removal of discontinued references and a price list review.',
    status: 'in_progress',
    priority: 4,
    days: 21,
  },
]

/**
 * Creates the sample tasks of a user. It is idempotent: if the user already owns
 * todos it returns `created: 0` without inserting anything.
 */
export async function seedDemoTodos(
  db: Database,
  ownerId: string,
): Promise<{ created: number; items: TodoDto[] }> {
  const existing = await db.query<{ total: number }>(
    'SELECT count(*)::int AS total FROM clavis.todos WHERE owner_id = $1',
    [ownerId],
  )
  if ((existing.rows[0]?.total ?? 0) > 0) {
    return { created: 0, items: [] }
  }

  const result = await db.query<TodoRow>(
    `WITH inserted AS (
       INSERT INTO clavis.todos (title, description, status, priority, due_date, owner_id, assignee_id, completed_at)
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

/** Todo counts per status; passing `scope` limits the count to what is visible. */
export async function countByStatus(
  db: Database,
  scope?: ScopeFilter,
): Promise<Record<TodoStatus, number>> {
  const where = scope ? `WHERE ${scope.clause}` : ''
  const result = await db.query<{ status: string; total: number }>(
    `SELECT t.status, count(*)::int AS total FROM clavis.todos t ${where} GROUP BY t.status`,
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

/** Looks up a Clavis user by its id (Keycloak `sub`). */
export async function findUserById(db: Database, id: string): Promise<UserDto | null> {
  const result = await db.query<UserRow>(
    'SELECT id, username, email, display_name, last_seen_at FROM clavis.users WHERE id = $1',
    [id],
  )
  const row = result.rows[0]
  return row ? mapUser(row) : null
}
