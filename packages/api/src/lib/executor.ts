import type { FastifyInstance } from 'fastify'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'

/**
 * Anything that can run one parameterised statement.
 *
 * This is the convention for every function that touches the database:
 * repositories, `loadAccessContext` and `recordAudit` all take an `Executor`
 * first and **never open a transaction of their own**. Whether the statement
 * runs on its own connection or inside a transaction somebody else started is
 * then the caller's decision, expressed by which executor it passes:
 *
 *   `app.db`  — one statement, its own implicit transaction
 *   `client`  — inside the `app.db.tx()` the caller already opened
 *
 * A function that opened its own transaction could never be composed into a
 * larger unit of work, which is exactly what kept the audit row outside the
 * transaction it was supposed to describe.
 *
 * `app.db.tx()` stays the unit of work; there is no abstraction on top of it.
 *
 * **No network I/O inside `tx()`.** An open transaction across a Keycloak REST
 * round trip pins `backend_xmin`, stops vacuum from cleaning anything newer
 * database-wide and holds every row lock it has taken for the length of an
 * HTTP call to another system. Keycloak calls go before or after the `tx`,
 * never inside it.
 */
export interface Executor {
  query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>
}

/** Fails to compile if `T` does not satisfy `Executor`. */
type AssertExecutor<T extends Executor> = T

/**
 * Compile-time proof rather than an assumption: the three things ever passed as
 * an executor really do satisfy the shape structurally. If one of them stops
 * doing so, this declaration is what breaks the build.
 */
export type KnownExecutor =
  | AssertExecutor<Pool>
  | AssertExecutor<PoolClient>
  | AssertExecutor<FastifyInstance['db']>
