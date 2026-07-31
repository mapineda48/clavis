// Reglas de visibilidad de los todos.
// Traduce el AuthContext y el alcance pedido a un fragmento SQL parametrizado,
// y centraliza las comprobaciones de acceso sobre una fila concreta.
import { canSeeAllTodos, type AuthContext } from '../../lib/permissions.js'
import { forbidden, notFound } from '../../lib/errors.js'

/** Alcances admitidos por el listado de todos. */
export type TodoScope = 'mine' | 'all'

/** Valores validos de `scope` (util para esquemas y validaciones). */
export const TODO_SCOPES: readonly TodoScope[] = ['mine', 'all']

/** Accion que se quiere ejecutar sobre un todo concreto. */
export type TodoAction = 'read' | 'write' | 'delete'

/** Fragmento SQL de filtrado ya parametrizado. */
export interface ScopeFilter {
  /** Condicion lista para insertar en un `WHERE` (usa $n). */
  clause: string
  /** Parametros del fragmento, en el mismo orden que los $n. */
  params: unknown[]
  /** Alcance realmente aplicado tras evaluar los permisos. */
  effectiveScope: TodoScope
  /** Primer indice de parametro libre para seguir componiendo la consulta. */
  nextIndex: number
}

/** Opciones de composicion del fragmento SQL. */
export interface BuildScopeOptions {
  /** Alias de la tabla `erp.todos` en la consulta (por defecto `t`). */
  alias?: string
  /** Indice del primer parametro ($n) que puede usar el fragmento. */
  startIndex?: number
}

/** Datos minimos de propiedad de un todo necesarios para decidir el acceso. */
export interface TodoOwnership {
  ownerId: string
  assigneeId: string | null
}

/**
 * Construye el filtro de visibilidad del listado.
 *
 * - `scope=mine` (por defecto): solo todos donde el usuario es propietario o asignado.
 * - `scope=all`: requiere el permiso `todos:read:all`; sin el se responde 403.
 */
export function buildScopeFilter(
  auth: AuthContext,
  requestedScope: TodoScope | string | undefined,
  options: BuildScopeOptions = {},
): ScopeFilter {
  const alias = options.alias ?? 't'
  const startIndex = options.startIndex ?? 1

  if (requestedScope === 'all') {
    if (!canSeeAllTodos(auth)) {
      throw forbidden('Necesitas el permiso todos:read:all para consultar el alcance "all"')
    }
    return { clause: 'TRUE', params: [], effectiveScope: 'all', nextIndex: startIndex }
  }

  // Alcance "mine": propietario o asignado. El mismo $n se reutiliza dos veces.
  return {
    clause: `(${alias}.owner_id = $${startIndex} OR ${alias}.assignee_id = $${startIndex})`,
    params: [auth.sub],
    effectiveScope: 'mine',
    nextIndex: startIndex + 1,
  }
}

/**
 * Comprueba que el usuario puede operar sobre un todo concreto.
 *
 * Devuelve 404 (y no 403) cuando el todo existe pero el usuario no deberia ni
 * saber de su existencia: asi no se filtra informacion por el codigo de estado.
 * Solo se responde 403 cuando el usuario si ve el todo pero la accion concreta
 * no le corresponde (borrar un todo del que solo es asignado).
 */
export function assertCanTouchTodo<T extends TodoOwnership>(
  auth: AuthContext,
  todo: T | null | undefined,
  action: TodoAction = 'read',
): T {
  if (!todo) {
    throw notFound('El todo indicado no existe')
  }

  const seesAll = canSeeAllTodos(auth)
  const isOwner = todo.ownerId === auth.sub
  const isAssignee = todo.assigneeId !== null && todo.assigneeId === auth.sub

  if (!seesAll && !isOwner && !isAssignee) {
    // Existe, pero es invisible para este usuario: 404 deliberado.
    throw notFound('El todo indicado no existe')
  }

  if (action === 'delete' && !seesAll && !isOwner) {
    throw forbidden('Solo el propietario puede eliminar este todo')
  }

  return todo
}
