import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, apiFetchRaw, apiFetchWithCache } from './client'
import type { ApiError, CacheStatus } from './client'
import {
  isRecord,
  isTodoStatus,
  readBoolean,
  readItems,
  readNumber,
  readRecord,
  readString,
  toPriority,
} from '../lib/types'
import type { Priority, TodoStatus, UnknownRecord } from '../lib/types'

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

export interface Todo {
  id: string
  title: string
  description: string | null
  status: TodoStatus
  priority: Priority
  dueDate: string | null
  ownerId: string
  ownerUsername: string | null
  assigneeId: string | null
  assigneeUsername: string | null
  createdAt: string | null
  updatedAt: string | null
  completedAt: string | null
}

export interface Attachment {
  id: string
  todoId: string
  fileName: string
  contentType: string
  sizeBytes: number
  createdAt: string | null
  uploadedBy: string | null
}

export interface NotifyResult {
  delivered: boolean
  provider: string
  to: string | null
  reason: string | null
}

export type ScopeFilter = 'mine' | 'all'
export type StatusFilter = TodoStatus | 'all'

export interface TodoListParams {
  status: StatusFilter
  q: string
  scope: ScopeFilter
  page: number
  pageSize: number
}

export interface TodoListResult {
  items: Todo[]
  page: number
  pageSize: number
  total: number
  /** Lo que dice el cuerpo de la respuesta. */
  cached: boolean
  /** Lo que dice la cabecera `X-Cache`. */
  cache: CacheStatus
}

export interface CreateTodoInput {
  title: string
  description: string
  status: TodoStatus
  priority: Priority
  dueDate: string
}

export type TodoChanges = Partial<{
  title: string
  description: string | null
  status: TodoStatus
  priority: Priority
  dueDate: string | null
}>

/* ------------------------------------------------------------------ */
/* Normalizacion de las respuestas                                     */
/* ------------------------------------------------------------------ */

export function normalizeTodo(raw: unknown): Todo {
  const record: UnknownRecord = isRecord(raw) ? raw : {}
  const status = readString(record, 'status') ?? 'todo'
  return {
    id: readString(record, 'id') ?? '',
    title: readString(record, 'title') ?? '(sin titulo)',
    description: readString(record, 'description'),
    status: isTodoStatus(status) ? status : 'todo',
    priority: toPriority(readNumber(record, 'priority')),
    dueDate: readString(record, 'dueDate', 'due_date'),
    ownerId: readString(record, 'ownerId', 'owner_id') ?? '',
    ownerUsername: readString(record, 'ownerUsername', 'owner_username', 'owner'),
    assigneeId: readString(record, 'assigneeId', 'assignee_id'),
    assigneeUsername: readString(record, 'assigneeUsername', 'assignee_username', 'assignee'),
    createdAt: readString(record, 'createdAt', 'created_at'),
    updatedAt: readString(record, 'updatedAt', 'updated_at'),
    completedAt: readString(record, 'completedAt', 'completed_at'),
  }
}

export function normalizeAttachment(raw: unknown): Attachment {
  const record: UnknownRecord = isRecord(raw) ? raw : {}
  return {
    id: readString(record, 'id') ?? '',
    todoId: readString(record, 'todoId', 'todo_id') ?? '',
    fileName: readString(record, 'fileName', 'file_name', 'name') ?? 'adjunto',
    contentType: readString(record, 'contentType', 'content_type') ?? 'application/octet-stream',
    sizeBytes: readNumber(record, 'sizeBytes', 'size_bytes', 'size') ?? 0,
    createdAt: readString(record, 'createdAt', 'created_at'),
    uploadedBy: readString(record, 'uploadedBy', 'uploaded_by'),
  }
}

function normalizeNotifyResult(raw: unknown): NotifyResult {
  const outer: UnknownRecord = isRecord(raw) ? raw : {}
  const inner = readRecord(outer, 'mail') ?? readRecord(outer, 'result') ?? outer
  return {
    delivered: readBoolean(inner, 'delivered', 'sent'),
    provider: readString(inner, 'provider') ?? 'desconocido',
    to: readString(inner, 'to') ?? readString(outer, 'to'),
    reason: readString(inner, 'reason') ?? readString(outer, 'reason'),
  }
}

/* ------------------------------------------------------------------ */
/* Claves de React Query                                               */
/* ------------------------------------------------------------------ */

export const todosKeys = {
  /** Raiz: invalidarla refresca listados, detalles y adjuntos. */
  all: ['todos'] as const,
  list: (params: TodoListParams) => ['todos', 'list', params] as const,
  detail: (id: string) => ['todos', 'detail', id] as const,
  attachments: (todoId: string) => ['todos', 'attachments', todoId] as const,
}

/* ------------------------------------------------------------------ */
/* Peticiones                                                          */
/* ------------------------------------------------------------------ */

function buildTodoBody(changes: TodoChanges): UnknownRecord {
  const body: UnknownRecord = {}
  if (changes.title !== undefined) body.title = changes.title.trim()
  if (changes.description !== undefined) body.description = changes.description
  if (changes.status !== undefined) body.status = changes.status
  if (changes.priority !== undefined) body.priority = changes.priority
  if (changes.dueDate !== undefined) body.dueDate = changes.dueDate
  return body
}

async function fetchTodos(params: TodoListParams): Promise<TodoListResult> {
  const search = new URLSearchParams()
  if (params.status !== 'all') search.set('status', params.status)
  const q = params.q.trim()
  if (q !== '') search.set('q', q)
  search.set('scope', params.scope)
  search.set('page', String(params.page))
  search.set('pageSize', String(params.pageSize))

  const { data, cache } = await apiFetchWithCache<unknown>(`/api/todos?${search.toString()}`)
  const record: UnknownRecord = isRecord(data) ? data : {}
  const items = readItems(data).map(normalizeTodo)
  return {
    items,
    page: readNumber(record, 'page') ?? params.page,
    pageSize: readNumber(record, 'pageSize', 'page_size') ?? params.pageSize,
    total: readNumber(record, 'total') ?? items.length,
    cached: readBoolean(record, 'cached'),
    cache,
  }
}

/** Descarga un adjunto usando un blob temporal y revoca la URL despues. */
export async function downloadAttachment(attachment: Attachment): Promise<void> {
  const response = await apiFetchRaw(`/api/attachments/${attachment.id}`)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = attachment.fileName
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    // El navegador necesita la URL viva un instante para iniciar la descarga.
    window.setTimeout(() => {
      URL.revokeObjectURL(url)
    }, 5000)
  }
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

export function useTodos(params: TodoListParams, enabled: boolean) {
  return useQuery<TodoListResult, ApiError>({
    queryKey: todosKeys.list(params),
    queryFn: () => fetchTodos(params),
    enabled,
    // Mantiene la pagina anterior mientras llega la nueva: sin parpadeos.
    placeholderData: keepPreviousData,
  })
}

export function useCreateTodo() {
  const queryClient = useQueryClient()
  return useMutation<Todo, ApiError, CreateTodoInput>({
    mutationFn: async (input) => {
      const body = buildTodoBody({
        title: input.title,
        description: input.description.trim() === '' ? null : input.description.trim(),
        status: input.status,
        priority: input.priority,
        dueDate: input.dueDate === '' ? null : input.dueDate,
      })
      const raw = await apiFetch<unknown>('/api/todos', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return normalizeTodo(raw)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: todosKeys.all })
    },
  })
}

export function useUpdateTodo() {
  const queryClient = useQueryClient()
  return useMutation<Todo, ApiError, { id: string; changes: TodoChanges }>({
    mutationFn: async ({ id, changes }) => {
      const raw = await apiFetch<unknown>(`/api/todos/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(buildTodoBody(changes)),
      })
      return normalizeTodo(raw)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: todosKeys.all })
    },
  })
}

export function useDeleteTodo() {
  const queryClient = useQueryClient()
  return useMutation<void, ApiError, string>({
    mutationFn: async (id) => {
      await apiFetch<unknown>(`/api/todos/${id}`, { method: 'DELETE' })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: todosKeys.all })
    },
  })
}

export function useSeedDemo() {
  const queryClient = useQueryClient()
  return useMutation<number, ApiError, void>({
    mutationFn: async () => {
      const raw = await apiFetch<unknown>('/api/todos/seed-demo', { method: 'POST' })
      return isRecord(raw) ? (readNumber(raw, 'created') ?? 0) : 0
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: todosKeys.all })
    },
  })
}

export function useNotifyTodo() {
  return useMutation<NotifyResult, ApiError, { id: string; to: string | null }>({
    mutationFn: async ({ id, to }) => {
      const body: UnknownRecord = {}
      if (to !== null && to.trim() !== '') body.to = to.trim()
      const raw = await apiFetch<unknown>(`/api/todos/${id}/notify`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return normalizeNotifyResult(raw)
    },
  })
}

export function useAttachments(todoId: string, enabled: boolean) {
  return useQuery<Attachment[], ApiError>({
    queryKey: todosKeys.attachments(todoId),
    queryFn: async () => {
      const raw = await apiFetch<unknown>(`/api/todos/${todoId}/attachments`)
      return readItems(raw).map(normalizeAttachment)
    },
    enabled,
  })
}

export function useUploadAttachment() {
  const queryClient = useQueryClient()
  return useMutation<Attachment, ApiError, { todoId: string; file: File }>({
    mutationFn: async ({ todoId, file }) => {
      const form = new FormData()
      form.append('file', file, file.name)
      const raw = await apiFetch<unknown>(`/api/todos/${todoId}/attachments`, {
        method: 'POST',
        body: form,
      })
      return normalizeAttachment(raw)
    },
    onSuccess: (_attachment, variables) => {
      void queryClient.invalidateQueries({ queryKey: todosKeys.attachments(variables.todoId) })
      void queryClient.invalidateQueries({ queryKey: todosKeys.all })
    },
  })
}

export function useDeleteAttachment() {
  const queryClient = useQueryClient()
  return useMutation<void, ApiError, { todoId: string; attachmentId: string }>({
    mutationFn: async ({ attachmentId }) => {
      await apiFetch<unknown>(`/api/attachments/${attachmentId}`, { method: 'DELETE' })
    },
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: todosKeys.attachments(variables.todoId) })
    },
  })
}
