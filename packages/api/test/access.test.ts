import { PERMISSION_KEYS } from '@clavis/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type AccessContext,
  type CanonicalUserId,
  accessCacheKey,
  addedMembers,
  assertMayGrant,
  assertNotSelf,
  contextHasPermission,
} from '../src/lib/access.js'
import { AppError } from '../src/lib/errors.js'

function context(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    user: {
      id: '00000000-0000-0000-0000-000000000001' as CanonicalUserId,
      username: 'someone',
      email: 'someone@clavis.local',
      displayName: null,
      isRoot: false,
      status: 'active',
      ...overrides.user,
    },
    roles: overrides.roles ?? [],
    permissions: overrides.permissions ?? [],
  }
}

describe('contextHasPermission', () => {
  it('grants what the effective set contains', () => {
    const access = context({ permissions: ['users:read', 'audit:read'] })
    assert.equal(contextHasPermission(access, 'users:read'), true)
    assert.equal(contextHasPermission(access, 'audit:read'), true)
  })

  it('refuses what it does not', () => {
    const access = context({ permissions: ['users:read'] })
    assert.equal(contextHasPermission(access, 'users:delete'), false)
    assert.equal(contextHasPermission(access, 'access:manage'), false)
  })

  it('refuses everything for an empty set', () => {
    const access = context()
    for (const key of PERMISSION_KEYS) {
      assert.equal(contextHasPermission(access, key), false, key)
    }
  })

  it('lets root through even with no permissions resolved', () => {
    // is_root is a column, not a role: break-glass access must not depend on
    // anything the roles UI can take away.
    const access = context({ user: { ...context().user, isRoot: true } })
    for (const key of PERMISSION_KEYS) {
      assert.equal(contextHasPermission(access, key), true, key)
    }
  })
})

describe('assertMayGrant', () => {
  /** Runs the guard and returns the refusal, failing the test if there is none. */
  function refusal(actor: AccessContext, keys: readonly string[]): AppError {
    try {
      assertMayGrant(actor, keys)
    } catch (error) {
      assert.ok(error instanceof AppError)
      return error
    }
    assert.fail('expected a 403 PRIVILEGE_ESCALATION')
  }

  it('lets an actor hand out exactly what they hold', () => {
    const actor = context({ permissions: ['users:read', 'audit:read'] })
    assert.doesNotThrow(() => assertMayGrant(actor, ['users:read']))
    assert.doesNotThrow(() => assertMayGrant(actor, ['users:read', 'audit:read']))
  })

  it('refuses the keys the actor lacks, and names them', () => {
    const actor = context({ permissions: ['access:manage'] })
    const error = refusal(actor, ['access:manage', 'users:delete', 'audit:read'])
    assert.equal(error.statusCode, 403)
    assert.equal(error.code, 'PRIVILEGE_ESCALATION')
    assert.deepEqual(error.details, { missing: ['users:delete', 'audit:read'] })
    // The message has to name them too: this refusal reaches an operator who
    // can only fix it by knowing which key was the problem.
    assert.match(error.message, /users:delete, audit:read/)
  })

  it('refuses a key that is not in the catalog at all', () => {
    // The fail-closed direction. Nobody holds an unrecognised key, so it is
    // refused rather than filtered away on the road to the guard.
    const actor = context({ permissions: [...PERMISSION_KEYS] })
    assert.deepEqual(refusal(actor, ['users:read', 'billing:refund']).details, {
      missing: ['billing:refund'],
    })
  })

  it('reports each missing key once however often it was asked for', () => {
    assert.deepEqual(refusal(context(), ['audit:read', 'audit:read']).details, {
      missing: ['audit:read'],
    })
  })

  it('passes on an empty delta, so an edit that adds nothing is never blocked', () => {
    assert.doesNotThrow(() => assertMayGrant(context(), []))
  })

  it('lets root through: root holds the catalog by definition', () => {
    const root = context({ user: { ...context().user, isRoot: true }, permissions: [] })
    assert.doesNotThrow(() => assertMayGrant(root, [...PERMISSION_KEYS]))
  })

  it('refuses an actor with nothing, whatever they ask for', () => {
    for (const key of PERMISSION_KEYS) {
      assert.throws(() => assertMayGrant(context(), [key]), AppError, key)
    }
  })
})

describe('addedMembers', () => {
  it('returns only what the replacement introduces', () => {
    assert.deepEqual(addedMembers(['a', 'b'], ['b', 'c']), ['c'])
  })

  it('returns nothing for a pure reduction, which is what makes the rule usable', () => {
    // Sets are replaced whole, so without the delta an administrator could not
    // even trim a role down to a subset of what they themselves hold.
    assert.deepEqual(addedMembers(['a', 'b', 'c'], ['a']), [])
    assert.deepEqual(addedMembers(['a'], []), [])
  })

  it('treats an empty current set as everything being added', () => {
    assert.deepEqual(addedMembers([], ['a', 'b']), ['a', 'b'])
  })

  it('keeps the order of the incoming set, so messages read as the caller wrote them', () => {
    assert.deepEqual(addedMembers(['b'], ['z', 'b', 'a']), ['z', 'a'])
  })
})

describe('assertNotSelf', () => {
  // Hex letters on purpose: they are what a case variation can move.
  const target = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' as CanonicalUserId

  it('refuses when the actor is the target', () => {
    try {
      assertNotSelf(target, target, 'delete your own account')
      assert.fail('expected a 403')
    } catch (error) {
      assert.ok(error instanceof AppError)
      assert.equal(error.statusCode, 403)
      assert.equal(error.code, 'SELF_MODIFICATION')
      assert.match(error.message, /delete your own account/)
    }
  })

  it('lets anybody else through', () => {
    assert.doesNotThrow(() =>
      assertNotSelf('00000000-0000-0000-0000-000000000002', target, 'delete your own account'),
    )
  })

  it('does NOT recognise a case-varied uuid — which is why the type demands a canonical id', () => {
    // Documenting the limit rather than pretending it is not there. PostgreSQL
    // resolves both spellings to the same row; this comparison does not. The
    // defence is `CanonicalUserId`, which makes an unresolved id unpassable,
    // plus `assertMayGrant`, which does not depend on identity at all.
    const varied = target.toUpperCase() as CanonicalUserId
    assert.doesNotThrow(() => assertNotSelf(target, varied, 'delete your own account'))
  })
})

describe('accessCacheKey', () => {
  it('embeds the namespace version, which is what invalidation moves', () => {
    const key = accessCacheKey(7, 'abc')
    assert.equal(key, 'clavis:v7:access:user:abc')
    assert.notEqual(key, accessCacheKey(8, 'abc'))
  })
})
