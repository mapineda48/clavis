import type { Logger } from '../infra/logger.js'
import type { AccessContext } from './access.js'

/**
 * Everything a service method needs to know about the request it runs for.
 *
 * Services never see Express: the HTTP layer builds this from the
 * authenticated request (`requestContext` in `http/auth.ts`) and hands it
 * down. The actor id feeds the audit trail and the self-modification checks,
 * the resolved access feeds the rules a static permission gate cannot express
 * (role assignment inside a `users:*` route, for instance), and the logger is
 * the request-scoped one, so whatever a service reports still carries the
 * request id it happened under.
 */
export interface RequestContext {
  /** `sub` of the verified token: who is acting. */
  actorId: string
  /** What the actor may do, resolved from the database. */
  access: AccessContext
  /** Request-scoped logger. */
  log: Logger
}
