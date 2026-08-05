// Native Fastify JSON Schemas for the todos module.
// They are used both to validate the input (ajv) and to serialize the output
// (fast-json-stringify): a field that is not declared under `response` is dropped.

/** UUID v4/v5 pattern (avoids depending on external ajv formats). */
export const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

/** Plain `YYYY-MM-DD` date pattern. */
export const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$'

/** Email pattern, strict enough for a demo. */
export const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

/** Statuses accepted by `clavis.todos.status`. */
export const TODO_STATUSES = ['todo', 'in_progress', 'done']

/** Global API error envelope: `{ error: { code, message, statusCode } }`. */
export const ErrorResponse = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Stable error code' },
        message: { type: 'string', description: 'Human-readable message' },
        statusCode: { type: 'integer', description: 'HTTP status code' },
      },
    },
  },
}

/** Route parameter `:id` in UUID format. */
export const IdParams = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN, description: 'UUID identifier' },
  },
}

/** Public representation of a todo (camelCase DTO). */
export const TodoSchema = {
  type: 'object',
  description: 'Clavis task',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    status: { type: 'string', enum: TODO_STATUSES },
    priority: { type: 'integer', minimum: 1, maximum: 4 },
    dueDate: { type: ['string', 'null'], description: 'Due date in YYYY-MM-DD format' },
    ownerId: { type: 'string' },
    assigneeId: { type: ['string', 'null'] },
    createdAt: { type: 'string', description: 'ISO 8601 instant' },
    updatedAt: { type: 'string', description: 'ISO 8601 instant' },
    completedAt: { type: ['string', 'null'], description: 'ISO 8601 instant' },
    attachmentsCount: { type: 'integer', description: 'Number of attachments' },
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

/** Query string of the `GET /api/todos` listing. */
export const ListTodosQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: TODO_STATUSES,
      description: 'Filter by status',
    },
    q: {
      type: 'string',
      maxLength: 120,
      description: 'Search in title or description',
    },
    scope: {
      type: 'string',
      enum: ['mine', 'all'],
      default: 'mine',
      description: 'Scope: "mine" (owned or assigned) or "all" (requires todos:read:all)',
    },
    page: { type: 'integer', minimum: 1, default: 1, description: 'Page number, starting at 1' },
    pageSize: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 20,
      description: 'Items per page (1..100)',
    },
  },
}

/** Paginated response of the todo listing. */
export const TodoListResponse = {
  type: 'object',
  properties: {
    items: { type: 'array', items: TodoSchema },
    page: { type: 'integer' },
    pageSize: { type: 'integer' },
    total: { type: 'integer' },
    cached: { type: 'boolean', description: 'true if the response came from Valkey' },
  },
  required: ['items', 'page', 'pageSize', 'total', 'cached'],
}

/** Body of `POST /api/todos`. */
export const CreateTodoBody = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200, description: 'Task title' },
    description: { type: ['string', 'null'], maxLength: 4000 },
    status: { type: 'string', enum: TODO_STATUSES, default: 'todo' },
    priority: {
      type: 'integer',
      minimum: 1,
      maximum: 4,
      default: 3,
      description: '1 = highest priority, 4 = lowest',
    },
    dueDate: { type: ['string', 'null'], pattern: DATE_PATTERN, description: 'Due date YYYY-MM-DD' },
    assigneeId: { type: ['string', 'null'], pattern: UUID_PATTERN, description: 'Assigned user' },
  },
}

/** Body of the partial update `PATCH /api/todos/:id`. */
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

/** Response of `POST /api/todos/seed-demo`. */
export const SeedDemoResponse = {
  type: 'object',
  properties: {
    created: { type: 'integer', description: 'Todos created (0 if they already existed)' },
    items: { type: 'array', items: TodoSchema },
  },
  required: ['created', 'items'],
}

/** Body of `POST /api/todos/:id/notify`. */
export const NotifyTodoBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    to: {
      type: 'string',
      pattern: EMAIL_PATTERN,
      description: 'Recipient; if omitted, the assignee or the caller is used',
    },
  },
}

/** Response of the email notification. */
export const NotifyTodoResponse = {
  type: 'object',
  properties: {
    todoId: { type: 'string' },
    to: { type: 'string' },
    subject: { type: 'string' },
    delivered: { type: 'boolean', description: 'true if the provider accepted the message' },
    provider: { type: 'string', enum: ['resend', 'dry-run'] },
    id: { type: ['string', 'null'], description: 'Message identifier at the provider' },
    reason: { type: 'string', description: 'Why the message was not delivered or was simulated' },
  },
  required: ['todoId', 'to', 'subject', 'delivered', 'provider', 'id'],
}

/** Response of the todo deletion. */
export const DeleteTodoResponse = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    deleted: { type: 'boolean' },
    removedAttachments: { type: 'integer', description: 'Attachments removed by cascade' },
  },
  required: ['id', 'deleted', 'removedAttachments'],
}
