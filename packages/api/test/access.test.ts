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
  effectivePermissions,
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

describe('effectivePermissions', () => {
  /** Order-independent comparison: the set is what matters, not the order. */
  function sameSet(actual: readonly string[], expected: readonly string[]): void {
    assert.deepEqual([...actual].sort(), [...expected].sort())
  }

  it('is roles plus grants minus revokes', () => {
    sameSet(effectivePermissions(['a', 'b'], ['c'], ['b']), ['a', 'c'])
  })

  it('lets a revoke beat the role that grants the same key', () => {
    sameSet(effectivePermissions(['a', 'b'], [], ['a']), ['b'])
  })

  it('lets a revoke beat a grant of the same key: the subtraction is last', () => {
    sameSet(effectivePermissions([], ['a'], ['a']), [])
  })

  it('deduplicates a key carried by a role and granted again', () => {
    sameSet(effectivePermissions(['a'], ['a'], []), ['a'])
  })

  // The three behaviours the overrides guard depends on, at the helper level:
  // the whole point is that the delta is stated over THIS set, not the body.
  it('makes dropping a revoke that masks a role read as an addition', () => {
    // A full-catalog role fully masked -> empty; drop every revoke -> the
    // catalog. `addedMembers` over the two is the whole catalog, which is
    // exactly what the guard must vet — no `grant` row is submitted at all.
    const catalog = [...PERMISSION_KEYS]
    const before = effectivePermissions(catalog, [], catalog)
    const after = effectivePermissions(catalog, [], [])
    assert.deepEqual(before, [])
    sameSet(addedMembers(before, after), catalog)
  })

  it('makes a revoke->grant flip read as an addition', () => {
    // `k` comes from a role but is revoked (masked); flipping it to a grant
    // drops the revoke, so it becomes effective — an addition, though the grant
    // key was never "new" to the body in isolation.
    const before = effectivePermissions(['k'], [], ['k'])
    const after = effectivePermissions(['k'], ['k'], [])
    assert.deepEqual(before, [])
    assert.deepEqual(addedMembers(before, after), ['k'])
  })

  it('makes preserving a grant contribute nothing to the delta', () => {
    // Re-sending an existing grant while adding an unrelated held one: the
    // preserved key is in both sides, so only the genuinely new key is added.
    const before = effectivePermissions([], ['held-by-target'], [])
    const after = effectivePermissions([], ['held-by-target', 'new'], [])
    assert.deepEqual(addedMembers(before, after), ['new'])
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
      assertNotSelf(
        '00000000-0000-0000-0000-000000000002' as CanonicalUserId,
        target,
        'delete your own account',
      ),
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
