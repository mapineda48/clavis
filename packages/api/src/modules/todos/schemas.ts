// Esquemas JSON Schema nativos de Fastify para el modulo de todos.
// Se usan tanto para validar la entrada (ajv) como para serializar la salida
// (fast-json-stringify): si un campo no esta declarado en `response`, se descarta.

/** Patron de UUID v4/v5 (evita depender de formatos externos de ajv). */
export const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

/** Patron de fecha simple `YYYY-MM-DD`. */
export const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$'

/** Patron de correo suficientemente estricto para una demo. */
export const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

/** Estados admitidos por `erp.todos.status`. */
export const TODO_STATUSES = ['todo', 'in_progress', 'done']

/** Sobre de error global de la API: `{ error: { code, message, statusCode } }`. */
export const ErrorResponse = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo estable del error' },
        message: { type: 'string', description: 'Mensaje legible' },
        statusCode: { type: 'integer', description: 'Codigo HTTP' },
      },
    },
  },
}

/** Parametro de ruta `:id` con formato UUID. */
export const IdParams = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN, description: 'Identificador UUID' },
  },
}

/** Representacion publica de un todo (DTO en camelCase). */
export const TodoSchema = {
  type: 'object',
  description: 'Tarea del ERP',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    status: { type: 'string', enum: TODO_STATUSES },
    priority: { type: 'integer', minimum: 1, maximum: 4 },
    dueDate: { type: ['string', 'null'], description: 'Fecha limite en formato YYYY-MM-DD' },
    ownerId: { type: 'string' },
    assigneeId: { type: ['string', 'null'] },
    createdAt: { type: 'string', description: 'Instante ISO 8601' },
    updatedAt: { type: 'string', description: 'Instante ISO 8601' },
    completedAt: { type: ['string', 'null'], description: 'Instante ISO 8601' },
    attachmentsCount: { type: 'integer', description: 'Numero de adjuntos' },
  },
  required: [
    'id',
    'title',
    'description',
    'status',
    'priority',
    'dueDate',
    'ownerId',
    'assigneeId',
    'createdAt',
    'updatedAt',
    'completedAt',
    'attachmentsCount',
  ],
}

/** Query del listado `GET /api/todos`. */
export const ListTodosQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: TODO_STATUSES,
      description: 'Filtra por estado',
    },
    q: {
      type: 'string',
      maxLength: 120,
      description: 'Busqueda por titulo o descripcion',
    },
    scope: {
      type: 'string',
      enum: ['mine', 'all'],
      default: 'mine',
      description: 'Alcance: "mine" (propios o asignados) o "all" (requiere todos:read:all)',
    },
    page: { type: 'integer', minimum: 1, default: 1, description: 'Pagina, empezando en 1' },
    pageSize: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 20,
      description: 'Elementos por pagina (1..100)',
    },
  },
}

/** Respuesta paginada del listado de todos. */
export const TodoListResponse = {
  type: 'object',
  properties: {
    items: { type: 'array', items: TodoSchema },
    page: { type: 'integer' },
    pageSize: { type: 'integer' },
    total: { type: 'integer' },
    cached: { type: 'boolean', description: 'true si la respuesta vino de Valkey' },
  },
  required: ['items', 'page', 'pageSize', 'total', 'cached'],
}

/** Cuerpo de creacion `POST /api/todos`. */
export const CreateTodoBody = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200, description: 'Titulo de la tarea' },
    description: { type: ['string', 'null'], maxLength: 4000 },
    status: { type: 'string', enum: TODO_STATUSES, default: 'todo' },
    priority: {
      type: 'integer',
      minimum: 1,
      maximum: 4,
      default: 3,
      description: '1 = maxima prioridad, 4 = minima',
    },
    dueDate: { type: ['string', 'null'], pattern: DATE_PATTERN, description: 'Fecha limite YYYY-MM-DD' },
    assigneeId: { type: ['string', 'null'], pattern: UUID_PATTERN, description: 'Usuario asignado' },
  },
}

/** Cuerpo de actualizacion parcial `PATCH /api/todos/:id`. */
export const UpdateTodoBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: ['string', 'null'], maxLength: 4000 },
    status: { type: 'string', enum: TODO_STATUSES },
    priority: { type: 'integer', minimum: 1, maximum: 4 },
    dueDate: { type: ['string', 'null'], pattern: DATE_PATTERN },
    assigneeId: { type: ['string', 'null'], pattern: UUID_PATTERN },
  },
}

/** Respuesta de `POST /api/todos/seed-demo`. */
export const SeedDemoResponse = {
  type: 'object',
  properties: {
    created: { type: 'integer', description: 'Todos creados (0 si ya existian)' },
    items: { type: 'array', items: TodoSchema },
  },
  required: ['created', 'items'],
}

/** Cuerpo de `POST /api/todos/:id/notify`. */
export const NotifyTodoBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    to: {
      type: 'string',
      pattern: EMAIL_PATTERN,
      description: 'Destinatario; si se omite se usa el asignado o el solicitante',
    },
  },
}

/** Respuesta de la notificacion por correo. */
export const NotifyTodoResponse = {
  type: 'object',
  properties: {
    todoId: { type: 'string' },
    to: { type: 'string' },
    subject: { type: 'string' },
    delivered: { type: 'boolean', description: 'true si el proveedor acepto el envio' },
    provider: { type: 'string', enum: ['resend', 'dry-run'] },
    id: { type: ['string', 'null'], description: 'Identificador del mensaje en el proveedor' },
    reason: { type: 'string', description: 'Motivo cuando no se entrego o se simulo' },
  },
  required: ['todoId', 'to', 'subject', 'delivered', 'provider', 'id'],
}

/** Respuesta del borrado de un todo. */
export const DeleteTodoResponse = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    deleted: { type: 'boolean' },
    removedAttachments: { type: 'integer', description: 'Adjuntos eliminados en cascada' },
  },
  required: ['id', 'deleted', 'removedAttachments'],
}
