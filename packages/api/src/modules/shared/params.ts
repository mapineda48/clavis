// Path-parameter schemas more than one module declares, and the type every
// module's `schemas.ts` binds a request schema to its DTO with. Kept tiny on
// purpose: anything module-specific belongs in that module's `schemas.ts`.
import type { JSONSchemaType } from 'ajv'

/** The keys of `T` a schema may legitimately list in `required`. */
type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T]

/**
 * A request schema tied to the DTO its handler reads.
 *
 * Every field the interface declares must appear in `properties` with a
 * matching type, nothing may appear there that the interface does not declare,
 * and `required` may only name fields the interface really marks mandatory —
 * so the schema and the type it is cast to can no longer drift apart in
 * silence.
 *
 * The binding is taken over `Required<T>` rather than over `T` directly
 * because ajv's `JSONSchemaType<T>` demands `nullable: true` on every OPTIONAL
 * property, and `nullable` is not an annotation here: under
 * `coerceTypes: 'array'` (`http/validate.ts`) it makes an explicit `null` pass
 * straight through instead of being coerced, which hands the handler a `null`
 * its interface says cannot happen. Typing must not change what ajv accepts.
 *
 * What that costs: `required` becomes a mandatory KEY of the schema object, so
 * a schema where nothing is mandatory has to say `required: []`.
 *
 * The two restated members are not decoration. `JSONSchemaType<T>` is a UNION
 * (a schema may be `anyOf`, `oneOf`, a type array or a plain type), and an
 * object literal assigned to a union loses excess-property checking on its
 * NESTED literals — so on its own it never notices a `properties` entry the
 * interface does not declare. Restating both keys against a plain mapped type
 * puts that check back, in both directions.
 */
export type RequestSchema<T> = JSONSchemaType<Required<T>> & {
  required: readonly RequiredKeys<T>[]
  properties: { [K in keyof T]-?: unknown }
}

/**
 * `/:id` — a user id, which is a uuid (the id Keycloak assigned).
 *
 * The format narrows the parameter to what the column can actually hold, but it
 * does NOT reject a case-varied uuid — the format is case-insensitive, as uuids
 * are — which is why the self check takes a `CanonicalUserId` and not a
 * parameter (see `lib/access.ts`).
 */
export const IdParams: RequestSchema<IdParamsInput> = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
}

export interface IdParamsInput {
  id: string
}

/** `/:slug` — a role slug. The ceiling matches the pattern `CreateRoleBody` caps slugs with. */
export const SlugParams: RequestSchema<SlugParamsInput> = {
  type: 'object',
  required: ['slug'],
  properties: { slug: { type: 'string', minLength: 1, maxLength: 64 } },
}

export interface SlugParamsInput {
  slug: string
}
