// Task routes (`/api/todos`): listing cached in Valkey, CRUD, sample data and
// email notification.
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
// Pulls in the @fastify/swagger type augmentation (tags, summary, security inside `schema`).
import type {} from '@fastify/swagger'
import { badRequest } from '../../lib/errors.js'
import { assertCanTouchTodo, buildScopeFilter, type TodoScope } from '../shared/scope.js'
import { recordAudit } from '../shared/audit.js'
import * as repository from './repository.js'
import type { TodoDto, TodoStatus } from './repository.js'
import {
  CreateTodoBody,
  DeleteTodoResponse,
  ErrorResponse,
  IdParams,
  ListTodosQuery,
  NotifyTodoBody,
  NotifyTodoResponse,
  SeedDemoResponse,
  TodoListResponse,
  TodoSchema,
  UpdateTodoBody,
} from './schemas.js'

/** Cache version namespace shared by every todo listing. */
const CACHE_NAMESPACE = 'todos'

/** Fallback TTL when `CACHE_TTL_SECONDS` is not usable. */
const DEFAULT_CACHE_TTL_SECONDS = 60

/** Human-readable status labels, for the emails. */
const STATUS_LABELS: Record<TodoStatus, string> = {
  todo: 'Pending',
  in_progress: 'In progress',
  done: 'Completed',
}

/** Human-readable priority labels, for the emails. */
const PRIORITY_LABELS: Record<number, string> = {
  1: 'Critical',
  2: 'High',
  3: 'Normal',
  4: 'Low',
}

interface ListTodosQueryInput {
  status?: TodoStatus
  q?: string
  scope?: TodoScope
  page?: number
  pageSize?: number
}

interface IdParamsInput {
  id: string
}

interface CreateTodoBodyInput {
  title: string
  description?: string | null
  status?: TodoStatus
  priority?: number
  dueDate?: string | null
  assigneeId?: string | null
}

interface UpdateTodoBodyInput {
  title?: string
  description?: string | null
  status?: TodoStatus
  priority?: number
  dueDate?: string | null
  assigneeId?: string | null
}

interface NotifyTodoBodyInput {
  to?: string
}

/** Payload stored in the cache (pagination travels in the key itself). */
interface CachedList {
  items: TodoDto[]
  total: number
}

/** Reads the cache TTL from the environment with a safe default. */
function resolveCacheTtlSeconds(): number {
  const parsed = Number.parseInt(process.env.CACHE_TTL_SECONDS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CACHE_TTL_SECONDS
}

/** Escapes user text before embedding it in the HTML of the email. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Builds the HTML body of a task notification. */
function buildNotificationHtml(todo: TodoDto, actorName: string): string {
  const rows: Array<[string, string]> = [
    ['Status', STATUS_LABELS[todo.status] ?? todo.status],
    ['Priority', PRIORITY_LABELS[todo.priority] ?? String(todo.priority)],
    ['Due date', todo.dueDate ?? 'no due date'],
    ['Attachments', String(todo.attachmentsCount)],
    ['Identifier', todo.id],
  ]

  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 12px;color:#555;">${escapeHtml(label)}</td>` +
        `<td style="padding:6px 12px;font-weight:600;">${escapeHtml(value)}</td></tr>`,
    )
    .join('')

  const description = todo.description
    ? `<p style="margin:16px 0;color:#333;line-height:1.5;">${escapeHtml(todo.description)}</p>`
    : '<p style="margin:16px 0;color:#777;">This task has no description.</p>'

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px;">
      <tr>
        <td>
          <p style="margin:0 0 8px;color:#777;font-size:13px;">ERP Demo &middot; task notification</p>
          <h1 style="margin:0 0 4px;font-size:20px;color:#111;">${escapeHtml(todo.title)}</h1>
          <p style="margin:0;color:#777;font-size:13px;">Sent by ${escapeHtml(actorName)}</p>
          ${description}
          <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;">
            ${rowsHtml}
          </table>
          <p style="margin:24px 0 0;color:#999;font-size:12px;">
            Automated message from the ERP with Keycloak demo. Do not reply to this email.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

/** Plain-text version of the email, as an alternative to the HTML one. */
function buildNotificationText(todo: TodoDto, actorName: string): string {
  return [
    `Task: ${todo.title}`,
    `Status: ${STATUS_LABELS[todo.status] ?? todo.status}`,
    `Priority: ${PRIORITY_LABELS[todo.priority] ?? todo.priority}`,
    `Due date: ${todo.dueDate ?? 'no due date'}`,
    `Attachments: ${todo.attachmentsCount}`,
    todo.description ? `Description: ${todo.description}` : 'No description.',
    `Sent by: ${actorName}`,
    `Identifier: ${todo.id}`,
  ].join('\n')
}

/** Invalidates every cached listing. It never interrupts the request. */
async function invalidateListCache(app: FastifyInstance): Promise<void> {
  try {
    await app.cache.bumpVersion(CACHE_NAMESPACE)
  } catch (err) {
    app.log.warn({ err }, 'Could not invalidate the todos cache')
  }
}

/** Checks that the assigned user exists before touching the foreign key. */
async function assertAssigneeExists(app: FastifyInstance, assigneeId: string | null | undefined): Promise<void> {
  if (!assigneeId) return
  const user = await repository.findUserById(app.db, assigneeId)
  if (!user) {
    throw badRequest('The assigned user does not exist in the ERP')
  }
}

export const todosRoutes: FastifyPluginAsync = async (app) => {
  const cacheTtlSeconds = resolveCacheTtlSeconds()

  app.get<{ Querystring: ListTodosQueryInput }>(
    '/todos',
    {
      preHandler: [app.authenticate, app.requirePermissions('todos:read')],
      schema: {
        tags: ['todos'],
        summary: 'List the visible tasks',
        description:
          'Returns the tasks with pagination. The "all" scope requires the todos:read:all permission. ' +
          'The response is cached in Valkey and carries the X-Cache header with HIT or MISS.',
        security: [{ bearerAuth: [] }],
        querystring: ListTodosQuery,
        response: {
          200: TodoListResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const auth = request.auth
      const page = request.query.page ?? 1
      const pageSize = request.query.pageSize ?? 20
      const status = request.query.status ?? null
      const rawQuery = (request.query.q ?? '').trim()
      const q = rawQuery.length > 0 ? rawQuery : null
      const scope = buildScopeFilter(auth, request.query.scope)

      // Versioned key: calling bumpVersion("todos") orphans every old key, and
      // they expire on their own through the TTL.
      let cacheKey: string | null = null
      try {
        const version = await app.cache.version(CACHE_NAMESPACE)
        cacheKey = `erp:v${version}:todos:${auth.sub}:${scope.effectiveScope}:${status ?? '_'}:${
          q ? encodeURIComponent(q) : '_'
        }:${page}:${pageSize}`
      } catch (err) {
        app.log.warn({ err }, 'Cache unavailable: serving straight from the database')
      }

      if (cacheKey) {
        try {
          const hit = await app.cache.get<CachedList>(cacheKey)
          if (hit) {
            reply.header('X-Cache', 'HIT')
            return { items: hit.items, page, pageSize, total: hit.total, cached: true }
          }
        } catch (err) {
          app.log.warn({ err }, 'Could not read the todos cache')
        }
      }

      const result = await repository.listTodos(app.db, { scope, status, q, page, pageSize })

      if (cacheKey) {
        try {
          await app.cache.set(cacheKey, { items: result.items, total: result.total }, cacheTtlSeconds)
        } catch (err) {
          app.log.warn({ err }, 'Could not write the todos cache')
        }
      }

      reply.header('X-Cache', 'MISS')
      return { items: result.items, page, pageSize, total: result.total, cached: false }
    },
  )

  app.post<{ Body: CreateTodoBodyInput }>(
    '/todos',
    {
      preHandler: [app.authenticate, app.requirePermissions('todos:write')],
      schema: {
        tags: ['todos'],
        summary: 'Create a task',
        description: 'Creates a task owned by the authenticated user.',
        security: [{ bearerAuth: [] }],
        body: CreateTodoBody,
        response: {
          201: TodoSchema,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const auth = request.auth
      await assertAssigneeExists(app, request.body.assigneeId)

      const todo = await repository.createTodo(app.db, {
        title: request.body.title,
        description: request.body.description ?? null,
        status: request.body.status ?? 'todo',
        priority: request.body.priority ?? 3,
        dueDate: request.body.dueDate ?? null,
        ownerId: auth.sub,
        assigneeId: request.body.assigneeId ?? null,
      })

      await invalidateListCache(app)
      await recordAudit(
        app.db,
        {
          actorId: auth.sub,
          action: 'todo.created',
          entity: 'todo',
          entityId: todo.id,
          payload: { title: todo.title, status: todo.status, priority: todo.priority },
        },
        app.log,
      )

      reply.code(201)
      return todo
    },
  )

  app.get<{ Params: IdParamsInput }>(
    '/todos/:id',
    {
      preHandler: [app.authenticate, app.requirePermissions('todos:read')],
      schema: {
        tags: ['todos'],
        summary: 'Get a task',
        description: 'Returns a single task when the user is allowed to see it.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          200: TodoSchema,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request) => {
      const todo = await repository.getTodoById(app.db, request.params.id)
      return assertCanTouchTodo(request.auth, todo, 'read')
    },
  )

  app.patch<{ Params: IdParamsInput; Body: UpdateTodoBodyInput }>(
    '/todos/:id',
    {
      preHandler: [app.authenticate, app.requirePermissions('todos:write')],
      schema: {
        tags: ['todos'],
        summary: 'Partially update a task',
        description:
          'Changes only the fields sent. Moving to "done" fills in the completion date, and ' +
          'leaving that status clears it again.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: UpdateTodoBody,
        response: {
          200: TodoSchema,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request) => {
      const auth = request.auth
      const current = await repository.getTodoById(app.db, request.params.id)
      assertCanTouchTodo(auth, current, 'write')
      await assertAssigneeExists(app, request.body.assigneeId)

      const updated = await repository.updateTodo(app.db, request.params.id, request.body)
      const todo = assertCanTouchTodo(auth, updated, 'write')

      await invalidateListCache(app)
      await recordAudit(
        app.db,
        {
          actorId: auth.sub,
          action: 'todo.updated',
          entity: 'todo',
          entityId: todo.id,
          payload: { changes: Object.keys(request.body) },
        },
        app.log,
      )

      return todo
    },
  )

  app.delete<{ Params: IdParamsInput }>(
    '/todos/:id',
    {
      preHandler: [app.authenticate, app.requirePermissions('todos:delete')],
      schema: {
        tags: ['todos'],
        summary: 'Delete a task',
        description: 'Removes the task, its attachment rows and the blobs behind them.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          200: DeleteTodoResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request) => {
      const auth = request.auth
      const current = await repository.getTodoById(app.db, request.params.id)
      const todo = assertCanTouchTodo(auth, current, 'delete')

      const result = await repository.deleteTodo(app.db, todo.id)

      // The blobs are removed after the row: if the remote delete fails there is
      // no loss of consistency, only leftover garbage in the storage account.
      for (const blobName of result.blobNames) {
        try {
          await app.storage.remove(blobName)
        } catch (err) {
          app.log.warn({ err, blobName }, 'Could not delete the attachment blob')
        }
      }

      await invalidateListCache(app)
      await recordAudit(
        app.db,
        {
          actorId: auth.sub,
          action: 'todo.deleted',
          entity: 'todo',
          entityId: todo.id,
          payload: { title: todo.title, attachments: result.blobNames.length },
        },
        app.log,
      )

      return { id: todo.id, deleted: result.deleted, removedAttachments: result.blobNames.length }
    },
  )

  app.post(
    '/todos/seed-demo',
    {
      preHandler: [app.authenticate, app.requirePermissions('todos:write')],
      schema: {
        tags: ['todos'],
        summary: 'Create sample tasks',
        description:
          'Generates six realistic ERP tasks for the authenticated user. ' +
          'It is idempotent: if the user already owns tasks it returns created = 0.',
        security: [{ bearerAuth: [] }],
        response: {
          200: SeedDemoResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request) => {
      const auth = request.auth
      const result = await repository.seedDemoTodos(app.db, auth.sub)

      if (result.created > 0) {
        await invalidateListCache(app)
        await recordAudit(
          app.db,
          {
            actorId: auth.sub,
            action: 'todo.seeded',
            entity: 'todo',
            entityId: null,
            payload: { created: result.created },
          },
          app.log,
        )
      }

      return result
    },
  )

  app.post<{ Params: IdParamsInput; Body: NotifyTodoBodyInput }>(
    '/todos/:id/notify',
    {
      preHandler: [app.authenticate, app.requirePermissions('todos:write')],
      schema: {
        tags: ['todos'],
        summary: 'Send the task by email',
        description:
          'Builds an email with the task details and sends it through the configured provider. ' +
          'Without a Resend key the send is simulated (provider "dry-run") and delivered is false.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: NotifyTodoBody,
        response: {
          200: NotifyTodoResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request) => {
      const auth = request.auth
      const current = await repository.getTodoById(app.db, request.params.id)
      const todo = assertCanTouchTodo(auth, current, 'write')

      // Recipient precedence: body > assignee email > caller email.
      let recipient = request.body?.to ?? null
      if (!recipient && todo.assigneeId) {
        const assignee = await repository.findUserById(app.db, todo.assigneeId)
        recipient = assignee?.email ?? null
      }
      if (!recipient) {
        recipient = auth.email
      }
      if (!recipient) {
        throw badRequest('No recipient available: send "to" or set an email address on your user')
      }

      const actorName = auth.name ?? auth.username
      const subject = `[ERP] ${todo.title}`
      const sent = await app.mailer.send({
        to: recipient,
        subject,
        html: buildNotificationHtml(todo, actorName),
        text: buildNotificationText(todo, actorName),
      })

      await recordAudit(
        app.db,
        {
          actorId: auth.sub,
          action: 'todo.notified',
          entity: 'todo',
          entityId: todo.id,
          payload: {
            to: recipient,
            provider: sent.provider,
            delivered: sent.delivered,
            messageId: sent.id,
          },
        },
        app.log,
      )

      return {
        todoId: todo.id,
        to: recipient,
        subject,
        delivered: sent.delivered,
        provider: sent.provider,
        id: sent.id,
        reason: sent.reason,
      }
    },
  )
}
