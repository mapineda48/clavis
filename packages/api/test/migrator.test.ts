import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type MigrationFile, assertNoDrift } from '../src/lib/migrator.js'

function file(version: string): MigrationFile {
  return { version, fileName: `${version}.sql`, sql: '-- x', checksum: 'x' }
}

describe('assertNoDrift', () => {
  it('accepts a database that is behind the files on disk', () => {
    // The pending ones are what the migrator is about to apply.
    const files = [file('0001_init'), file('20260807194105_users_updated_at')]
    assert.doesNotThrow(() => assertNoDrift(files, new Map([['0001_init', 'x']])))
  })

  it('accepts a database that matches the files exactly', () => {
    const files = [file('0001_init')]
    assert.doesNotThrow(() => assertNoDrift(files, new Map([['0001_init', 'x']])))
  })

  it('aborts on a recorded version whose file is gone', () => {
    const applied = new Map([
      ['0001_init', 'x'],
      ['20260101000000_deleted_by_mistake', 'x'],
    ])
    assert.throws(
      () => assertNoDrift([file('0001_init')], applied),
      /20260101000000_deleted_by_mistake/,
    )
  })

  it('names every orphan, in a stable order', () => {
    const applied = new Map([
      ['20260201000000_b', 'x'],
      ['20260101000000_a', 'x'],
    ])
    try {
      assertNoDrift([], applied)
      assert.fail('expected an abort')
    } catch (error) {
      const message = (error as Error).message
      assert.ok(message.includes('20260101000000_a'))
      assert.ok(message.includes('20260201000000_b'))
      assert.ok(
        message.indexOf('20260101000000_a') < message.indexOf('20260201000000_b'),
        'orphans should be listed sorted',
      )
    }
  })

  it('explains that a rename looks exactly like a deletion', () => {
    // Migrations are keyed by filename and there is no reverse check inside the
    // file, so renaming an applied one makes it run again from scratch.
    assert.throws(() => assertNoDrift([], new Map([['0001_init', 'x']])), /renam/i)
  })
})
