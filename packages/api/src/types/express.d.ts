import type { AuthState } from '../http/auth.js'

/**
 * Express declaration merging: the one request-scoped property this API adds.
 *
 * `req.log` needs no entry here — `pino-http` already augments
 * `http.IncomingMessage`, which Express requests extend.
 */
declare module 'express-serve-static-core' {
  interface Request {
    /**
     * What `authenticate` resolved; absent until it has run. Handlers read it
     * through `authOf` / `requestContext` (`http/auth.ts`), which turn an
     * early read into a loud error instead of an `undefined` downstream.
     */
    authState?: AuthState
  }
}
