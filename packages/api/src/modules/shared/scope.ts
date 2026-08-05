// Visibility rules for todos.
// Turns the AuthContext and the requested scope into a parameterized SQL
// fragment, and centralizes the access checks against a single row.
import { canSeeAllTodos, type AuthContext } from '../../lib/permissions.js'
import { forbidden, notFound } from '../../lib/errors.js'

/** Scopes accepted by the todo listing. */
export type TodoScope = 'mine' | 'all'

/** Valid `scope` values (handy for schemas and validations). */
export const TODO_SCOPES: readonly TodoScope[] = ['mine', 'all']

/** Action the caller wants to perform on a given todo. */
export type TodoAction = 'read' | 'write' | 'delete'

/** Parameterized SQL filtering fragment. */
export interface ScopeFilter {
  /** Condition ready to drop into a `WHERE` (uses $n). */
  clause: string
  /** Parameters of the fragment, in the same order as the $n placeholders. */
  params: unknown[]
  /** Scope actually applied after evaluating the permissions. */
  effectiveScope: TodoScope
  /** First free parameter index, so the caller can keep building the query. */
  nextIndex: number
}

/** Options to build the SQL fragment. */
export interface BuildScopeOptions {
  /** Alias of the `clavis.todos` table in the query (`t` by default). */
  alias?: string
  /** Index of the first parameter ($n) the fragment may use. */
  startIndex?: number
}

/** Minimal ownership data of a todo needed to decide access. */
export interface TodoOwnership {
  ownerId: string
  assigneeId: string | null
}

/**
 * Builds the visibility filter of the listing.
 *
 * - `scope=mine` (default): only todos where the user is the owner or the assignee.
 * - `scope=all`: requires the `todos:read:all` permission; without it the answer is 403.
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
      throw forbidden('You need the todos:read:all permission to use the "all" scope')
    }
    return { clause: 'TRUE', params: [], effectiveScope: 'all', nextIndex: startIndex }
  }

  // Scope "mine": owner or assignee. The same $n is reused twice.
  return {
    clause: `(${alias}.owner_id = $${startIndex} OR ${alias}.assignee_id = $${startIndex})`,
    params: [auth.sub],
    effectiveScope: 'mine',
    nextIndex: startIndex + 1,
  }
}

/**
 * Checks that the user is allowed to operate on a given todo.
 *
 * Answers 404 (and not 403) when the todo exists but the user should not even
 * know about it: that way no information leaks through the status code.
 * A 403 is only returned when the user can indeed see the todo but the specific
 * action is not theirs to take (deleting a todo they are merely assigned to).
 */
export function assertCanTouchTodo<T extends TodoOwnership>(
  auth: AuthContext,
  todo: T | null | undefined,
  action: TodoAction = 'read',
): T {
  if (!todo) {
    throw notFound('The requested todo does not exist')
  }

  const seesAll = canSeeAllTodos(auth)
  const isOwner = todo.ownerId === auth.sub
  const isAssignee = todo.assigneeId !== null && todo.assigneeId === auth.sub

  if (!seesAll && !isOwner && !isAssignee) {
    // It exists, but it is invisible to this user: 404 on purpose.
    throw notFound('The requested todo does not exist')
  }

  if (action === 'delete' && !seesAll && !isOwner) {
    throw forbidden('Only the owner can delete this todo')
  }

  return todo
}
