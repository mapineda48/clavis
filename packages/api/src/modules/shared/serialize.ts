// Conversions between what pg hands back and what the API publishes.

/**
 * Converts a pg timestamptz to ISO 8601.
 *
 * `pg` returns a `Date` for `timestamptz` under the default type parsers, but
 * a driver setting or an explicit cast to text can produce a string, so both
 * are accepted. Every timestamp the API returns goes through here: a response
 * schema declares those fields as `string`, and a `Date` left in place would be
 * serialized by whatever `JSON.stringify` happens to do with it.
 */
export function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
