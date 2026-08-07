import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type VersionLogger, createNamespaceVersions } from '../src/plugins/cache.js'

// The security-relevant half of the cache is the invalidation, and its failure
// mode is silent by construction: Valkey is up, the version is readable, and
// the entries derived from it keep answering with permissions that were just
// revoked. Nothing about that is visible from a test against a live Valkey
// either, which is why the mechanism is a function over three operations.

/** Valkey stand-in: an in-memory map that can be told to fail. */
function fakeOps() {
  const store = new Map<string, string>()
  let failing = false
  let increments = 0

  const guard = (): void => {
    if (failing) throw new Error('Valkey is not reachable')
  }

  return {
    store,
    setFailing: (value: boolean): void => {
      failing = value
    },
    incrementCount: (): number => increments,
    ops: {
      read: async (key: string): Promise<string | null> => {
        guard()
        return store.get(key) ?? null
      },
      createIfAbsent: async (key: string, value: string): Promise<void> => {
        guard()
        if (!store.has(key)) store.set(key, value)
      },
      increment: async (key: string): Promise<number> => {
        increments += 1
        guard()
        const next = Number.parseInt(store.get(key) ?? '0', 10) + 1
        store.set(key, String(next))
        return next
      },
    },
  }
}

/** Silent logger: what is asserted here is behaviour, not wording. */
const silent: VersionLogger = { info: () => undefined, warn: () => undefined, error: () => undefined }

describe('createNamespaceVersions', () => {
  it('creates the version at 1 the first time it is read', async () => {
    const fake = fakeOps()
    const versions = createNamespaceVersions(fake.ops, silent)
    assert.equal(await versions.version('access'), 1)
  })

  it('a bump makes the next read return the new version', async () => {
    const fake = fakeOps()
    const versions = createNamespaceVersions(fake.ops, silent)
    await versions.version('access')
    assert.equal(await versions.bumpVersion('access'), 2)
    assert.equal(await versions.version('access'), 2)
  })

  it('retries a failed bump before giving up', async () => {
    const fake = fakeOps()
    const versions = createNamespaceVersions(fake.ops, silent)
    fake.setFailing(true)
    assert.equal(await versions.bumpVersion('access'), null)
    // A lost invalidation is worth exactly one retry: more would hold the
    // request open, fewer would give up on a single dropped packet.
    assert.equal(fake.incrementCount(), 2)
  })

  it('a lost bump keeps version() null even once Valkey answers again', async () => {
    // The whole point. Valkey being back does not make the entries written
    // under the old version safe: that version was never incremented, so they
    // are still the ones the revoked grant is sitting in.
    const fake = fakeOps()
    const versions = createNamespaceVersions(fake.ops, silent)
    await versions.version('access')

    fake.setFailing(true)
    assert.equal(await versions.bumpVersion('access'), null)

    fake.setFailing(false)
    assert.equal(await versions.version('access'), null)
  })

  it('a later successful bump makes the namespace readable again', async () => {
    const fake = fakeOps()
    const versions = createNamespaceVersions(fake.ops, silent)
    fake.setFailing(true)
    await versions.bumpVersion('access')
    fake.setFailing(false)

    const bumped = await versions.bumpVersion('access')
    assert.equal(typeof bumped, 'number')
    assert.equal(await versions.version('access'), bumped)
  })

  it('marks only the namespace whose bump was lost', async () => {
    const fake = fakeOps()
    const versions = createNamespaceVersions(fake.ops, silent)
    fake.setFailing(true)
    await versions.bumpVersion('access')
    fake.setFailing(false)

    assert.equal(await versions.version('access'), null)
    assert.equal(await versions.version('something-else'), 1)
  })

  it('a failed READ degrades without sticking', async () => {
    // Reading is not invalidating: a read that failed says nothing about
    // whether the entries are current, so the request goes to PostgreSQL and
    // the next read is free to succeed.
    const fake = fakeOps()
    const versions = createNamespaceVersions(fake.ops, silent)
    fake.setFailing(true)
    assert.equal(await versions.version('access'), null)

    fake.setFailing(false)
    assert.equal(await versions.version('access'), 1)
  })

  it('refuses a version the store holds as something unusable', async () => {
    const fake = fakeOps()
    const versions = createNamespaceVersions(fake.ops, silent)
    fake.store.set('clavis:ver:access', 'not-a-number')
    // Answering 1 here would compose a key that may still hold an entry from
    // before several bumps.
    assert.equal(await versions.version('access'), null)
  })
})
