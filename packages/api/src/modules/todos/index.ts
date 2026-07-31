// Rutas de tareas (`/api/todos`): listado con cache en Valkey, CRUD, datos de
// ejemplo y notificacion por correo.
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
// Carga la ampliacion de tipos de @fastify/swagger (tags, summary, security en `schema`).
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

/** Namespace de version de cache compartido por todas las listas de todos. */
const CACHE_NAMESPACE = 'todos'

/** TTL por defecto si `CACHE_TTL_SECONDS` no es utilizable. */
const DEFAULT_CACHE_TTL_SECONDS = 60

/** Etiquetas legibles del estado, para los correos. */
const STATUS_LABELS: Record<TodoStatus, string> = {
  todo: 'Pendiente',
  in_progress: 'En curso',
  done: 'Completada',
}

/** Etiquetas legibles de la prioridad, para los correos. */
const PRIORITY_LABELS: Record<number, string> = {
  1: 'Critica',
  2: 'Alta',
  3: 'Normal',
  4: 'Baja',
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

/** Cuerpo que se guarda en cache (la paginacion viaja en la propia clave). */
interface CachedList {
  items: TodoDto[]
  total: number
}

/** Lee el TTL de cache del entorno con un valor por defecto seguro. */
function resolveCacheTtlSeconds(): number {
  const parsed = Number.parseInt(process.env.CACHE_TTL_SECONDS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CACHE_TTL_SECONDS
}

/** Escapa texto de usuario antes de incrustarlo en el HTML del correo. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Compone el HTML de la notificacion de una tarea. */
function buildNotificationHtml(todo: TodoDto, actorName: string): string {
  const rows: Array<[string, string]> = [
    ['Estado', STATUS_LABELS[todo.status] ?? todo.status],
    ['Prioridad', PRIORITY_LABELS[todo.priority] ?? String(todo.priority)],
    ['Fecha limite', todo.dueDate ?? 'sin fecha'],
    ['Adjuntos', String(todo.attachmentsCount)],
    ['Identificador', todo.id],
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
    : '<p style="margin:16px 0;color:#777;">Esta tarea no tiene descripcion.</p>'

  return `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px;">
      <tr>
        <td>
          <p style="margin:0 0 8px;color:#777;font-size:13px;">ERP Demo &middot; notificacion de tarea</p>
          <h1 style="margin:0 0 4px;font-size:20px;color:#111;">${escapeHtml(todo.title)}</h1>
          <p style="margin:0;color:#777;font-size:13px;">Enviada por ${escapeHtml(actorName)}</p>
          ${description}
          <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;">
            ${rowsHtml}
          </table>
          <p style="margin:24px 0 0;color:#999;font-size:12px;">
            Mensaje automatico de la demo de ERP con Keycloak. No respondas a este correo.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

/** Version en texto plano del correo, como alternativa al HTML. */
function buildNotificationText(todo: TodoDto, actorName: string): string {
  return [
    `Tarea: ${todo.title}`,
    `Estado: ${STATUS_LABELS[todo.status] ?? todo.status}`,
    `Prioridad: ${PRIORITY_LABELS[todo.priority] ?? todo.priority}`,
    `Fecha limite: ${todo.dueDate ?? 'sin fecha'}`,
    `Adjuntos: ${todo.attachmentsCount}`,
    todo.description ? `Descripcion: ${todo.description}` : 'Sin descripcion.',
    `Enviada por: ${actorName}`,
    `Identificador: ${todo.id}`,
  ].join('\n')
}

/** Invalida todas las listas cacheadas. Nunca interrumpe la peticion. */
async function invalidateListCache(app: FastifyInstance): Promise<void> {
  try {
    await app.cache.bumpVersion(CACHE_NAMESPACE)
  } catch (err) {
    app.log.warn({ err }, 'No se pudo invalidar la cache de todos')
  }
}

/** Comprueba que el usuario asignado existe antes de tocar la clave foranea. */
async function assertAssigneeExists(app: FastifyInstance, assigneeId: string | null | undefined): Promise<void> {
  if (!assigneeId) return
  const user = await repository.findUserById(app.db, assigneeId)
  if (!user) {
    throw badRequest('El usuario asignado no existe en el ERP')
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
        summary: 'Lista las tareas visibles',
        description:
          'Devuelve las tareas paginadas. El alcance "all" exige el permiso todos:read:all. ' +
          'La respuesta se cachea en Valkey e incluye la cabecera X-Cache con HIT o MISS.',
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

      // Clave versionada: al hacer bumpVersion("todos") todas las claves antiguas
      // quedan huerfanas y expiran solas por TTL.
      let cacheKey: string | null = null
      try {
        const version = await app.cache.version(CACHE_NAMESPACE)
        cacheKey = `erp:v${version}:todos:${auth.sub}:${scope.effectiveScope}:${status ?? '_'}:${
          q ? encodeURIComponent(q) : '_'
        }:${page}:${pageSize}`
      } catch (err) {
        app.log.warn({ err }, 'Cache no disponible: se sirve directamente desde la base de datos')
      }

      if (cacheKey) {
        try {
          const hit = await app.cache.get<CachedList>(cacheKey)
          if (hit) {
            reply.header('X-Cache', 'HIT')
            return { items: hit.items, page, pageSize, total: hit.total, cached: true }
          }
        } catch (err) {
          app.log.warn({ err }, 'No se pudo leer la cache de todos')
        }
      }

      const result = await repository.listTodos(app.db, { scope, status, q, page, pageSize })

      if (cacheKey) {
        try {
          await app.cache.set(cacheKey, { items: result.items, total: result.total }, cacheTtlSeconds)
        } catch (err) {
          app.log.warn({ err }, 'No se pudo escribir la cache de todos')
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
        summary: 'Crea una tarea',
        description: 'Crea una tarea cuyo propietario es el usuario autenticado.',
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
        summary: 'Obtiene una tarea',
        description: 'Devuelve una tarea concreta si el usuario puede verla.',
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
        summary: 'Actualiza parcialmente una tarea',
        description:
          'Modifica los campos enviados. Al pasar a "done" se rellena la fecha de finalizacion ' +
          'y al salir de ese estado se limpia.',
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
        summary: 'Elimina una tarea',
        description: 'Borra la tarea, sus adjuntos en base de datos y los blobs asociados.',
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

      // Los blobs se borran despues de la fila: si falla el borrado remoto no
      // se pierde consistencia, solo queda basura en el almacenamiento.
      for (const blobName of result.blobNames) {
        try {
          await app.storage.remove(blobName)
        } catch (err) {
          app.log.warn({ err, blobName }, 'No se pudo borrar el blob del adjunto')
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
        summary: 'Crea tareas de ejemplo',
        description:
          'Genera seis tareas realistas de un ERP para el usuario autenticado. ' +
          'Es idempotente: si el usuario ya tiene tareas propias devuelve created = 0.',
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
        summary: 'Envia la tarea por correo',
        description:
          'Compone un correo con los datos de la tarea y lo envia con el proveedor configurado. ' +
          'Sin clave de Resend el envio se simula (provider "dry-run") y delivered es false.',
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

      // Prioridad del destinatario: body > correo del asignado > correo del solicitante.
      let recipient = request.body?.to ?? null
      if (!recipient && todo.assigneeId) {
        const assignee = await repository.findUserById(app.db, todo.assigneeId)
        recipient = assignee?.email ?? null
      }
      if (!recipient) {
        recipient = auth.email
      }
      if (!recipient) {
        throw badRequest('No hay destinatario: indica "to" o configura un correo en tu usuario')
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
