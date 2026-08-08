import type { PermissionKey } from '@clavis/shared'
import express from 'express'
import type { RequestHandler, Router } from 'express'
import type { Auth } from './auth.js'
import { type RouteValidation, validate } from './validate.js'

/**
 * The route registry: one declaration per endpoint, read three times.
 *
 * A `RouteDef` is the single source for (1) the middleware stack the route
 * actually runs, (2) the validation applied to the request and (3) the
 * OpenAPI operation published for it. With Fastify those lived in one
 * `schema` object plus a separate `security` annotation that nothing
 * enforced; here `permissions` drives BOTH the wired middleware and the
 * documented security requirement, so the docs cannot claim a guard the
 * route does not have.
 */

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'

export interface RouteDef {
  method: HttpMethod
  /** Express-style path relative to the /api prefix, e.g. `/users/:id`. */
  path: string
  summary: string
  description?: string
  /**
   * The access rule, and what the middleware stack is derived from:
   *
   *   `null` — public route: no token is looked at.
   *   `[]`   — any authenticated user.
   *   keys   — authenticated AND holding every key.
   */
  permissions: PermissionKey[] | null
  /** Request validation, compiled with ajv at registration. */
  schema?: RouteValidation
  /**
   * Response shapes by status code, for the OpenAPI document ONLY. Unlike the
   * Fastify predecessor nothing serialises against these schemas or drops
   * undeclared fields: the serializers in each module are the response
   * contract, and the unit tests hold them to the schema field for field.
   */
  responses: Record<number, unknown>
  handler: RequestHandler
}

/** One API module: the OpenAPI tag and the routes published under it. */
export interface ModuleDef {
  tag: { name: string; description: string }
  routes: RouteDef[]
}

/**
 * Wires a module's routes onto a fresh Router.
 *
 * The stack per route, in order: `authenticate` (unless public), then
 * `requirePermissions` (when keys are demanded), then validation, then the
 * handler. Authentication deliberately runs BEFORE validation — a caller
 * without a valid token learns nothing about what a route considers a
 * well-formed body.
 */
export function createModuleRouter(module: ModuleDef, auth: Auth): Router {
  // Not inherited from the app settings — an Express Router carries its own
  // matching flags. Without these, '/users/' and '/USERS' match '/users' and
  // the API answers URL spellings the previous server refused.
  const router = express.Router({ caseSensitive: true, strict: true })

  for (const def of module.routes) {
    const stack: RequestHandler[] = []
    if (def.permissions !== null) {
      stack.push(auth.authenticate)
      if (def.permissions.length > 0) {
        stack.push(auth.requirePermissions(...def.permissions))
      }
    }
    if (def.schema !== undefined) {
      stack.push(validate(def.schema))
    }
    stack.push(def.handler)

    router[def.method](def.path, ...stack)
  }

  return router
}
