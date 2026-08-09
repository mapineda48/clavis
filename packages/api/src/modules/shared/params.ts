// Path-parameter schemas more than one module declares. Kept tiny on purpose:
// anything module-specific belongs in that module's `schemas.ts`.

/**
 * `/:id` — a user id, which is a uuid (the id Keycloak assigned).
 *
 * The format narrows the parameter to what the column can actually hold, but it
 * does NOT reject a case-varied uuid — the format is case-insensitive, as uuids
 * are — which is why the self check takes a `CanonicalUserId` and not a
 * parameter (see `lib/access.ts`).
 */
export const IdParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
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
