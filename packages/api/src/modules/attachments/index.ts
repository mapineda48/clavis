// Task attachments: multipart upload to Azurite, listing, download and deletion.
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
// Pulls in the @fastify/swagger type augmentation (tags, summary, security inside `schema`).
import type {} from '@fastify/swagger'
// Pulls in the @fastify/multipart type augmentation (request.file()).
import type {} from '@fastify/multipart'
import { badRequest, notFound } from '../../lib/errors.js'
import { assertCanTouchTodo } from '../shared/scope.js'
import { recordAudit } from '../shared/audit.js'
import { ErrorResponse, IdParams } from '../todos/schemas.js'
import * as todosRepository from '../todos/repository.js'

/** Cache version namespace of the todo listings (the attachment count travels in them). */
const CACHE_NAMESPACE = 'todos'

/** Fallback limit when `MAX_UPLOAD_BYTES` is not usable: 10 MiB. */
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** MIME type used when the client does not send one. */
const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

interface IdParamsInput {
  id: string
}

/** Public DTO of an attachment (the blob name stays internal). */
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
  description: 'File attached to a task',
  properties: {
    id: { type: 'string' },
    todoId: { type: 'string' },
    fileName: { type: 'string' },
    contentType: { type: 'string' },
    sizeBytes: { type: 'integer' },
    uploadedBy: { type: 'string' },
    createdAt: { type: 'string', description: 'ISO 8601 instant' },
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

/** Reads the maximum upload size from the environment with a safe default. */
function resolveMaxUploadBytes(): number {
  const parsed = Number.parseInt(process.env.MAX_UPLOAD_BYTES ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_BYTES
}

/**
 * Sanitizes the incoming file name: strips any path and keeps only characters
 * that are safe to embed in the blob name.
 */
export function sanitizeFileName(rawName: string | undefined | null): string {
  const withoutPath = (rawName ?? '').split(/[\\/]/).pop() ?? ''
  const normalized = withoutPath
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 120)
  return normalized.length > 0 ? normalized : 'file'
}

/** Converts a pg timestamptz to ISO 8601. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** Maps a row of `clavis.todo_attachments` to the public DTO. */
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

/** Invalidates the cached todo listings (`attachmentsCount` changes). */
async function invalidateListCache(app: FastifyInstance): Promise<void> {
  try {
    await app.cache.bumpVersion(CACHE_NAMESPACE)
  } catch (err) {
    app.log.warn({ err }, 'Could not invalidate the todos cache')
  }
}

/** Fetches the attachment together with the ownership of its task, to decide access. */
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
     FROM clavis.todo_attachments a
     JOIN clavis.todos t ON t.id = a.todo_id
     WHERE a.id = $1`,
    [id],
  )
  return result.rows[0] ?? null
}

/** Content-Disposition header with an ASCII fallback name and the UTF-8 name. */
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
        tags: ['attachments'],
        summary: 'Upload an attachment to a task',
        description:
          'multipart/form-data request carrying the file in the "file" field. The blob is stored ' +
          `in Azure Blob Storage and the size limit is ${maxUploadBytes} bytes.`,
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
        throw badRequest('You must send a file in the "file" field')
      }
      if (part.fieldname !== 'file') {
        throw badRequest(`The file field must be named "file" (received "${part.fieldname}")`)
      }

      let buffer: Buffer
      try {
        buffer = await part.toBuffer()
      } catch (err) {
        const code = typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined
        if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
          throw badRequest(`The file exceeds the limit of ${maxUploadBytes} bytes`)
        }
        throw err
      }
      if (part.file.truncated || buffer.byteLength > maxUploadBytes) {
        throw badRequest(`The file exceeds the limit of ${maxUploadBytes} bytes`)
      }
      if (buffer.byteLength === 0) {
        throw badRequest('The file is empty')
      }

      const fileName = sanitizeFileName(part.filename)
      const contentType = part.mimetype || DEFAULT_CONTENT_TYPE
      // Deterministic and unique name: groups by task and avoids collisions.
      const blobName = `todos/${todo.id}/${randomUUID()}-${fileName}`

      const uploaded = await app.storage.upload(blobName, buffer, contentType)

      let attachment: AttachmentDto
      try {
        const inserted = await app.db.query<AttachmentRow>(
          `INSERT INTO clavis.todo_attachments (todo_id, blob_name, file_name, content_type, size_bytes, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, todo_id, file_name, content_type, size_bytes, uploaded_by, created_at`,
          [todo.id, uploaded.blobName, fileName, contentType, buffer.byteLength, auth.sub],
        )
        attachment = mapAttachment(inserted.rows[0] as AttachmentRow)
      } catch (err) {
        // If the metadata could not be stored, the blob would be left orphaned.
        try {
          await app.storage.remove(uploaded.blobName)
        } catch (removeErr) {
          app.log.warn({ err: removeErr, blobName }, 'Could not clean up the orphaned blob')
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
        tags: ['attachments'],
        summary: 'List the attachments of a task',
        description: 'Returns the metadata of the files linked to the given task.',
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
         FROM clavis.todo_attachments
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
        tags: ['attachments'],
        summary: 'Download an attachment',
        description:
          'Returns the binary content of the file with its original MIME type. ' +
          'It is only reachable when the task it belongs to is visible to the user.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        produces: ['application/octet-stream'],
      },
    },
    async (request, reply) => {
      const auth = request.auth
      const row = await findAttachmentWithTodo(app, request.params.id)
      if (!row) {
        throw notFound('The requested attachment does not exist')
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
        tags: ['attachments'],
        summary: 'Delete an attachment',
        description: 'Removes the blob from storage and its metadata row.',
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
        throw notFound('The requested attachment does not exist')
      }
      assertCanTouchTodo(auth, { ownerId: row.owner_id, assigneeId: row.assignee_id }, 'delete')

      try {
        await app.storage.remove(row.blob_name)
      } catch (err) {
        // The metadata is deleted anyway: leaving garbage in storage is better
        // than keeping a row that points at an unreachable blob.
        app.log.warn({ err, blobName: row.blob_name }, 'Could not delete the attachment blob')
      }

      const removed = await app.db.query('DELETE FROM clavis.todo_attachments WHERE id = $1', [row.id])

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
