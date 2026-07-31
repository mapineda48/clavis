// Adjuntos de tareas: subida multipart a Azurite, listado, descarga y borrado.
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
// Carga la ampliacion de tipos de @fastify/swagger (tags, summary, security en `schema`).
import type {} from '@fastify/swagger'
// Carga la ampliacion de tipos de @fastify/multipart (request.file()).
import type {} from '@fastify/multipart'
import { badRequest, notFound } from '../../lib/errors.js'
import { assertCanTouchTodo } from '../shared/scope.js'
import { recordAudit } from '../shared/audit.js'
import { ErrorResponse, IdParams } from '../todos/schemas.js'
import * as todosRepository from '../todos/repository.js'

/** Namespace de version de cache de las listas de todos (el conteo de adjuntos viaja en ellas). */
const CACHE_NAMESPACE = 'todos'

/** Limite por defecto si `MAX_UPLOAD_BYTES` no es utilizable: 10 MiB. */
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Tipo MIME por defecto cuando el cliente no lo indica. */
const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

interface IdParamsInput {
  id: string
}

/** DTO publico de un adjunto (el nombre del blob es interno). */
interface AttachmentDto {
  id: string
  todoId: string
  fileName: string
  contentType: string
  sizeBytes: number
  uploadedBy: string
  createdAt: string
}

type AttachmentRow = {
  id: string
  todo_id: string
  file_name: string
  content_type: string
  size_bytes: string | number
  uploaded_by: string
  created_at: Date | string
}

type AttachmentWithTodoRow = AttachmentRow & {
  blob_name: string
  owner_id: string
  assignee_id: string | null
}

const AttachmentSchema = {
  type: 'object',
  description: 'Fichero adjunto a una tarea',
  properties: {
    id: { type: 'string' },
    todoId: { type: 'string' },
    fileName: { type: 'string' },
    contentType: { type: 'string' },
    sizeBytes: { type: 'integer' },
    uploadedBy: { type: 'string' },
    createdAt: { type: 'string', description: 'Instante ISO 8601' },
  },
  required: ['id', 'todoId', 'fileName', 'contentType', 'sizeBytes', 'uploadedBy', 'createdAt'],
}

const AttachmentListResponse = {
  type: 'object',
  properties: {
    items: { type: 'array', items: AttachmentSchema },
    total: { type: 'integer' },
  },
  required: ['items', 'total'],
}

const DeleteAttachmentResponse = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    deleted: { type: 'boolean' },
  },
  required: ['id', 'deleted'],
}

/** Lee el tamano maximo de subida del entorno con un valor por defecto seguro. */
function resolveMaxUploadBytes(): number {
  const parsed = Number.parseInt(process.env.MAX_UPLOAD_BYTES ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_BYTES
}

/**
 * Sanea el nombre de fichero recibido: elimina cualquier ruta y deja solo
 * caracteres seguros para usarlo dentro del nombre del blob.
 */
export function sanitizeFileName(rawName: string | undefined | null): string {
  const withoutPath = (rawName ?? '').split(/[\\/]/).pop() ?? ''
  const normalized = withoutPath
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 120)
  return normalized.length > 0 ? normalized : 'archivo'
}

/** Convierte un timestamptz de pg a ISO 8601. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** Mapea una fila de `erp.todo_attachments` al DTO publico. */
function mapAttachment(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    todoId: row.todo_id,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    uploadedBy: row.uploaded_by,
    createdAt: toIso(row.created_at),
  }
}

/** Invalida las listas cacheadas de todos (cambia `attachmentsCount`). */
async function invalidateListCache(app: FastifyInstance): Promise<void> {
  try {
    await app.cache.bumpVersion(CACHE_NAMESPACE)
  } catch (err) {
    app.log.warn({ err }, 'No se pudo invalidar la cache de todos')
  }
}

/** Recupera el adjunto junto con la propiedad de su tarea, para decidir el acceso. */
async function findAttachmentWithTodo(
  app: FastifyInstance,
  id: string,
): Promise<AttachmentWithTodoRow | null> {
  const result = await app.db.query<AttachmentWithTodoRow>(
    `SELECT a.id,
            a.todo_id,
            a.blob_name,
            a.file_name,
            a.content_type,
            a.size_bytes,
            a.uploaded_by,
            a.created_at,
            t.owner_id,
            t.assignee_id
     FROM erp.todo_attachments a
     JOIN erp.todos t ON t.id = a.todo_id
     WHERE a.id = $1`,
    [id],
  )
  return result.rows[0] ?? null
}

/** Cabecera Content-Disposition con nombre ASCII de reserva y nombre UTF-8. */
function buildContentDisposition(fileName: string): string {
  const asciiName = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

export const attachmentsRoutes: FastifyPluginAsync = async (app) => {
  const maxUploadBytes = resolveMaxUploadBytes()

  app.post<{ Params: IdParamsInput }>(
    '/todos/:id/attachments',
    {
      preHandler: [app.authenticate, app.requirePermissions('todos:write')],
      schema: {
        tags: ['adjuntos'],
        summary: 'Sube un adjunto a una tarea',
        description:
          'Peticion multipart/form-data con el fichero en el campo "file". El blob se guarda ' +
          `en Azure Blob Storage y el limite de tamano es de ${maxUploadBytes} bytes.`,
        security: [{ bearerAuth: [] }],
        consumes: ['multipart/form-data'],
        params: IdParams,
        response: {
          201: AttachmentSchema,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const auth = request.auth
      const todo = assertCanTouchTodo(
        auth,
        await todosRepository.getTodoById(app.db, request.params.id),
        'write',
      )

      const part = await request.file({ limits: { fileSize: maxUploadBytes, files: 1 } })
      if (!part) {
        throw badRequest('Debes enviar un fichero en el campo "file"')
      }
      if (part.fieldname !== 'file') {
        throw badRequest(`El campo del fichero debe llamarse "file" (recibido "${part.fieldname}")`)
      }

      let buffer: Buffer
      try {
        buffer = await part.toBuffer()
      } catch (err) {
        const code = typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined
        if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
          throw badRequest(`El fichero supera el limite de ${maxUploadBytes} bytes`)
        }
        throw err
      }
      if (part.file.truncated || buffer.byteLength > maxUploadBytes) {
        throw badRequest(`El fichero supera el limite de ${maxUploadBytes} bytes`)
      }
      if (buffer.byteLength === 0) {
        throw badRequest('El fichero esta vacio')
      }

      const fileName = sanitizeFileName(part.filename)
      const contentType = part.mimetype || DEFAULT_CONTENT_TYPE
      // Nombre determinista y unico: agrupa por tarea y evita colisiones.
      const blobName = `todos/${todo.id}/${randomUUID()}-${fileName}`

      const uploaded = await app.storage.upload(blobName, buffer, contentType)

      let attachment: AttachmentDto
      try {
        const inserted = await app.db.query<AttachmentRow>(
          `INSERT INTO erp.todo_attachments (todo_id, blob_name, file_name, content_type, size_bytes, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, todo_id, file_name, content_type, size_bytes, uploaded_by, created_at`,
          [todo.id, uploaded.blobName, fileName, contentType, buffer.byteLength, auth.sub],
        )
        attachment = mapAttachment(inserted.rows[0] as AttachmentRow)
      } catch (err) {
        // Si no se pudo guardar el metadato, el blob quedaria huerfano.
        try {
          await app.storage.remove(uploaded.blobName)
        } catch (removeErr) {
          app.log.warn({ err: removeErr, blobName }, 'No se pudo limpiar el blob huerfano')
        }
        throw err
      }

      await invalidateListCache(app)
      await recordAudit(
        app.db,
        {
          actorId: auth.sub,
          action: 'attachment.uploaded',
          entity: 'attachment',
          entityId: attachment.id,
          payload: {
            todoId: todo.id,
            fileName: attachment.fileName,
            sizeBytes: attachment.sizeBytes,
            contentType: attachment.contentType,
          },
        },
        app.log,
      )

      reply.code(201)
      return attachment
    },
  )

  app.get<{ Params: IdParamsInput }>(
    '/todos/:id/attachments',
    {
      preHandler: [app.authenticate, app.requirePermissions('todos:read')],
      schema: {
        tags: ['adjuntos'],
        summary: 'Lista los adjuntos de una tarea',
        description: 'Devuelve los metadatos de los ficheros asociados a la tarea indicada.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          200: AttachmentListResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request) => {
      const auth = request.auth
      const todo = assertCanTouchTodo(
        auth,
        await todosRepository.getTodoById(app.db, request.params.id),
        'read',
      )

      const result = await app.db.query<AttachmentRow>(
        `SELECT id, todo_id, file_name, content_type, size_bytes, uploaded_by, created_at
         FROM erp.todo_attachments
         WHERE todo_id = $1
         ORDER BY created_at DESC`,
        [todo.id],
      )

      const items = result.rows.map(mapAttachment)
      return { items, total: items.length }
    },
  )

  app.get<{ Params: IdParamsInput }>(
    '/attachments/:id',
    {
      preHandler: [app.authenticate, app.requirePermissions('todos:read')],
      schema: {
        tags: ['adjuntos'],
        summary: 'Descarga un adjunto',
        description:
          'Devuelve el contenido binario del fichero con su tipo MIME original. ' +
          'Solo es accesible si la tarea asociada es visible para el usuario.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        produces: ['application/octet-stream'],
      },
    },
    async (request, reply) => {
      const auth = request.auth
      const row = await findAttachmentWithTodo(app, request.params.id)
      if (!row) {
        throw notFound('El adjunto indicado no existe')
      }
      assertCanTouchTodo(auth, { ownerId: row.owner_id, assigneeId: row.assignee_id }, 'read')

      const file = await app.storage.download(row.blob_name)

      reply.header('Content-Type', row.content_type || file.contentType || DEFAULT_CONTENT_TYPE)
      reply.header('Content-Disposition', buildContentDisposition(row.file_name))
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Cache-Control', 'private, max-age=60')
      return reply.send(file.stream)
    },
  )

  app.delete<{ Params: IdParamsInput }>(
    '/attachments/:id',
    {
      preHandler: [app.authenticate, app.requirePermissions('todos:delete')],
      schema: {
        tags: ['adjuntos'],
        summary: 'Elimina un adjunto',
        description: 'Borra el blob del almacenamiento y su fila de metadatos.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          200: DeleteAttachmentResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request) => {
      const auth = request.auth
      const row = await findAttachmentWithTodo(app, request.params.id)
      if (!row) {
        throw notFound('El adjunto indicado no existe')
      }
      assertCanTouchTodo(auth, { ownerId: row.owner_id, assigneeId: row.assignee_id }, 'delete')

      try {
        await app.storage.remove(row.blob_name)
      } catch (err) {
        // El metadato se borra igualmente: es preferible dejar basura en el
        // almacenamiento a dejar una fila que apunta a un blob inaccesible.
        app.log.warn({ err, blobName: row.blob_name }, 'No se pudo borrar el blob del adjunto')
      }

      const removed = await app.db.query('DELETE FROM erp.todo_attachments WHERE id = $1', [row.id])

      await invalidateListCache(app)
      await recordAudit(
        app.db,
        {
          actorId: auth.sub,
          action: 'attachment.deleted',
          entity: 'attachment',
          entityId: row.id,
          payload: { todoId: row.todo_id, fileName: row.file_name },
        },
        app.log,
      )

      return { id: row.id, deleted: (removed.rowCount ?? 0) > 0 }
    },
  )
}
