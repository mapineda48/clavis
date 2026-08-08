// Path-parameter schemas more than one module declares. Kept tiny on purpose:
// anything module-specific belongs in that module's `schemas.ts`.

/** `/:id` — an opaque identifier (Keycloak uuids, audit row ids). */
export const IdParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
}

export interface IdParamsInput {
  id: string
}

/** `/:slug` — a role slug. */
export const SlugParams = {
  type: 'object',
  required: ['slug'],
  properties: { slug: { type: 'string', minLength: 1 } },
}

export interface SlugParamsInput {
  slug: string
}
