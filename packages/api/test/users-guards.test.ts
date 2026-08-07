import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AppError } from '../src/lib/errors.js'
import type { AccessContext, CanonicalUserId } from '../src/lib/access.js'
import {
  UserSchema,
  assertMayAssignRoles,
  selfBlockedFields,
  serializeUser,
} from '../src/modules/users/index.js'
import type { UserRecord } from '../src/modules/users/repository.js'

function access(permissions: AccessContext['permissions'], isRoot = false): AccessContext {
  return {
    user: {
      id: '00000000-0000-0000-0000-000000000001' as CanonicalUserId,
      username: 'someone',
      email: 'someone@clavis.local',
      displayName: null,
      isRoot,
      status: 'active',
    },
    roles: [],
    permissions,
  }
}

describe('selfBlockedFields', () => {
  it('blocks nothing for an update that carries no privilege', () => {
    assert.deepEqual(selfBlockedFields({}), [])
    assert.deepEqual(selfBlockedFields({ displayName: 'New Name' }), [])
  })

  it('blocks the two fields that are self-escalation or self-lockout', () => {
    assert.deepEqual(selfBlockedFields({ roles: ['admin'] }), ['roles'])
    assert.deepEqual(selfBlockedFields({ status: 'disabled' }), ['status'])
    assert.deepEqual(selfBlockedFields({ roles: [], status: 'active' }), ['roles', 'status'])
  })

  it('blocks an empty roles array too, since clearing roles is still a change', () => {
    assert.deepEqual(selfBlockedFields({ roles: [] }), ['roles'])
  })

  it('blocks the privileged fields even alongside an allowed one', () => {
    assert.deepEqual(selfBlockedFields({ displayName: 'New Name', roles: ['admin'] }), ['roles'])
  })
})

describe('assertMayAssignRoles', () => {
  it('lets a caller holding access:manage through', () => {
    assert.doesNotThrow(() => assertMayAssignRoles(access(['users:update', 'access:manage'])))
  })

  it('refuses a caller holding only users:update', () => {
    // The whole point: the `admin` role is seeded with the full catalog, so
    // granting a role through a users:* route would be a way around access:*.
    try {
      assertMayAssignRoles(access(['users:update']))
      assert.fail('expected a 403')
    } catch (error) {
      assert.ok(error instanceof AppError)
      assert.equal(error.statusCode, 403)
      assert.equal(error.code, 'ROLE_ASSIGNMENT_DENIED')
    }
  })

  it('refuses a caller with no permissions at all', () => {
    assert.throws(() => assertMayAssignRoles(access([])), AppError)
  })

  it('lets root through', () => {
    assert.doesNotThrow(() => assertMayAssignRoles(access([], true)))
  })
})

describe('serializeUser', () => {
  const row: UserRecord = {
    id: '00000000-0000-0000-0000-000000000002' as CanonicalUserId,
    username: 'someone',
    email: 'someone@clavis.local',
    display_name: 'Some One',
    is_root: false,
    status: 'active',
    created_at: new Date('2026-01-02T03:04:05.000Z'),
    last_seen_at: null,
    roles: ['auditors'],
  }

  it('renames the columns to the names the response schema declares', () => {
    assert.deepEqual(serializeUser(row), {
      id: row.id,
      username: 'someone',
      email: 'someone@clavis.local',
      displayName: 'Some One',
      isRoot: false,
      status: 'active',
      roles: ['auditors'],
      createdAt: '2026-01-02T03:04:05.000Z',
      lastSeenAt: null,
    })
  })

  it('keeps a null last_seen_at null instead of turning it into an epoch', () => {
    assert.equal(serializeUser({ ...row, last_seen_at: null }).lastSeenAt, null)
    assert.equal(
      serializeUser({ ...row, last_seen_at: new Date('2026-02-03T00:00:00.000Z') }).lastSeenAt,
      '2026-02-03T00:00:00.000Z',
    )
  })

  it('agrees field for field with the response schema that serialises it', () => {
    // Compared against the real schema, not a copy of its field list. Fastify
    // serialises against the declared schema and drops anything that is not
    // there, so a field added to the serializer alone vanishes from every
    // response without a word — and a field removed from the schema has to
    // fail here rather than keep a hard-coded list green.
    assert.deepEqual(
      Object.keys(serializeUser(row)).sort(),
      Object.keys(UserSchema.properties).sort(),
    )
  })

  it('declares every one of those fields required, so none is optional by accident', () => {
    assert.deepEqual([...UserSchema.required].sort(), Object.keys(UserSchema.properties).sort())
  })
})
