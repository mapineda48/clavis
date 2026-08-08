import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PoolClient } from 'pg'
import { type MutateDeps, mutate } from '../src/lib/mutate.js'

// The two properties `mutate` exists to guarantee are properties of ORDER, and
// order is invisible to a typechecker: the audit row has to go on the
// transaction client (not on the pool, where it would commit on its own), and
// the cache bump has to happen after COMMIT (before it, a concurrent request
// repopulates the new version with the pre-commit state). Both are cheap to
// assert against a fake that records what happened and in what sequence.

interface Fake {
  deps: MutateDeps
  /** Every step, in the order it happened. */
  calls: string[]
  /** Every statement, and which executor it ran on. */
  queries: { on: 'pool' | 'tx'; sql: string }[]
}

/** Short tag for a statement, enough to recognise it in the call list. */
function tag(sql: string): string {
  if (sql.includes('clavis.audit_log')) return 'audit'
  return (sql.trim().split(/\s+/)[0] ?? '').toLowerCase()
}

function fakeDeps(behaviour: { failAudit?: boolean } = {}): Fake {
  const calls: string[] = []
  const queries: { on: 'pool' | 'tx'; sql: string }[] = []

  const record = (on: 'pool' | 'tx', sql: string): void => {
    queries.push({ on, sql })
    calls.push(`${on}:${tag(sql)}`)
  }

  const client = {
    query: async (text: string) => {
      record('tx', text)
      if (behaviour.failAudit === true && text.includes('clavis.audit_log')) {
        throw new Error('audit_log is unavailable')
      }
      return { rows: [] }
    },
  } as unknown as PoolClient

  // Deliberately wider than MutateDeps: the pool-level `query` exists so a
  // statement that escaped the transaction would be caught (recorded as
  // 'pool'), which is exactly what the first test asserts never happens.
  const deps = {
    db: {
      query: async (text: string) => {
        record('pool', text)
        return { rows: [] }
      },
      async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
        calls.push('BEGIN')
        try {
          const value = await fn(client)
          calls.push('COMMIT')
          return value
        } catch (error) {
          calls.push('ROLLBACK')
          throw error
        }
      },
    },
    cache: {
      bumpVersion: async (namespace: string) => {
        calls.push(`bump:${namespace}`)
        return 2
      },
    },
  }

  return { deps, calls, queries }
}

describe('mutate', () => {
  it('writes the audit row on the transaction client, never on the pool', async () => {
    const { deps, queries } = fakeDeps()
    await mutate(deps, {
      run: (client) => client.query('UPDATE clavis.users SET status = $1', ['disabled']),
      audit: () => ({ actorId: 'a', action: 'user.updated', entity: 'user', entityId: 'b' }),
      invalidate: 'access',
    })

    const audits = queries.filter((query) => query.sql.includes('clavis.audit_log'))
    assert.equal(audits.length, 1)
    // On the pool it would commit by itself, and survive a write that rolled
    // back — an audit trail claiming something that never happened.
    assert.equal(audits[0]?.on, 'tx')
  })

  it('bumps the namespace after COMMIT, and never before', async () => {
    const { deps, calls } = fakeDeps()
    await mutate(deps, {
      run: (client) => client.query('DELETE FROM clavis.users WHERE id = $1', ['b']),
      audit: () => ({ actorId: 'a', action: 'user.deleted', entity: 'user', entityId: 'b' }),
      invalidate: 'access',
    })

    assert.deepEqual(calls, ['BEGIN', 'tx:delete', 'tx:audit', 'COMMIT', 'bump:access'])
    assert.ok(calls.indexOf('bump:access') > calls.indexOf('COMMIT'))
  })

  it('does not bump when the write itself failed', async () => {
    const { deps, calls } = fakeDeps()
    await assert.rejects(
      mutate(deps, {
        run: () => Promise.reject(new Error('constraint violation')),
        audit: () => ({ actorId: 'a', action: 'user.updated', entity: 'user' }),
        invalidate: 'access',
      }),
      /constraint violation/,
    )
    assert.ok(calls.includes('ROLLBACK'))
    assert.ok(!calls.some((call) => call.startsWith('bump:')))
  })

  it('fails the write when the audit row cannot be inserted', async () => {
    // The deliberate trade: in an access-control system an unaudited
    // privileged write is worse than a failed one.
    const { deps, calls } = fakeDeps({ failAudit: true })
    await assert.rejects(
      mutate(deps, {
        run: (client) => client.query('UPDATE clavis.users SET status = $1', ['disabled']),
        audit: () => ({ actorId: 'a', action: 'user.updated', entity: 'user' }),
        invalidate: 'access',
      }),
      /audit_log is unavailable/,
    )
    assert.ok(calls.includes('ROLLBACK'))
    assert.ok(!calls.includes('COMMIT'))
    assert.ok(!calls.some((call) => call.startsWith('bump:')))
  })

  it('skips the bump when the mutation derives nothing', async () => {
    const { deps, calls } = fakeDeps()
    await mutate(deps, {
      run: (client) => client.query('INSERT INTO clavis.roles (slug) VALUES ($1)', ['x']),
      audit: () => ({ actorId: 'a', action: 'role.created', entity: 'role' }),
      invalidate: null,
    })
    assert.ok(!calls.some((call) => call.startsWith('bump:')))
  })

  it('builds the audit entry from what the write returned', async () => {
    const { deps } = fakeDeps()
    let seen: unknown
    const result = await mutate(deps, {
      run: async () => ({ id: 'generated-id' }),
      audit: (value) => {
        seen = value
        return { actorId: 'a', action: 'user.created', entity: 'user', entityId: value.id }
      },
      invalidate: 'access',
    })
    assert.deepEqual(seen, { id: 'generated-id' })
    assert.deepEqual(result, { id: 'generated-id' })
  })
})
