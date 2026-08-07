import { PERMISSION_KEYS } from '@clavis/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type AccessContext,
  type CanonicalUserId,
  accessCacheKey,
  contextHasPermission,
} from '../src/lib/access.js'

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

describe('accessCacheKey', () => {
  it('embeds the namespace version, which is what invalidation moves', () => {
    const key = accessCacheKey(7, 'abc')
    assert.equal(key, 'clavis:v7:access:user:abc')
    assert.notEqual(key, accessCacheKey(8, 'abc'))
  })
})
