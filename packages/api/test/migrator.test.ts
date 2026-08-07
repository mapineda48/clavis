import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type MigrationFile, type MigrationLogger, assertNoDrift } from '../src/lib/migrator.js'

function file(version: string): MigrationFile {
  return { version, fileName: `${version}.sql`, sql: '-- x', checksum: 'x' }
}

/** Records what the migrator logged, so "warn and continue" can be asserted. */
function recordingLogger(): MigrationLogger & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    info: () => undefined,
    warn: (_obj, msg) => {
      warnings.push(msg)
    },
  }
}

describe('assertNoDrift', () => {
  it('accepts a database that is behind the files on disk', () => {
    // The pending ones are what the migrator is about to apply.
    const files = [file('0001_init'), file('20260807194105_users_updated_at')]
    assert.doesNotThrow(() => assertNoDrift(files, new Map([['0001_init', 'x']]), recordingLogger()))
  })

  it('accepts a database that matches the files exactly', () => {
    const files = [file('0001_init')]
    assert.doesNotThrow(() => assertNoDrift(files, new Map([['0001_init', 'x']]), recordingLogger()))
  })

  it('aborts on a recorded version that sits between the files on disk', () => {
    // Interleaved: the file used to be there and is not any more, which is a
    // rename or a deletion. Nothing about the schema can be assumed.
    const applied = new Map([
      ['0001_init', 'x'],
      ['20260101000000_deleted_by_mistake', 'x'],
      ['20260301000000_later', 'x'],
    ])
    assert.throws(
      () => assertNoDrift([file('0001_init'), file('20260301000000_later')], applied, recordingLogger()),
      /20260101000000_deleted_by_mistake/,
    )
  })

  it('warns and continues when the database is simply ahead of this build', () => {
    // A rollback: deploying the previous image after shipping a migration. The
    // schema is a superset of what this code expects, so it runs — and aborting
    // would put the container in a restart loop with no way out.
    const logger = recordingLogger()
    const applied = new Map([
      ['0001_init', 'x'],
      ['20260901000000_shipped_by_the_newer_image', 'x'],
    ])
    assert.doesNotThrow(() => assertNoDrift([file('0001_init')], applied, logger))
    assert.equal(logger.warnings.length, 1)
    assert.match(logger.warnings[0] ?? '', /ahead of this build/i)
  })

  it('aborts on the interleaved orphan even when a newer one is only a rollback', () => {
    const logger = recordingLogger()
    const applied = new Map([
      ['0001_init', 'x'],
      ['20260101000000_gone', 'x'],
      ['20260301000000_later', 'x'],
      ['20260901000000_ahead', 'x'],
    ])
    assert.throws(
      () =>
        assertNoDrift([file('0001_init'), file('20260301000000_later')], applied, logger),
      (error: Error) => {
        assert.match(error.message, /20260101000000_gone/)
        // The rollback half is not the failure and must not be named as one.
        assert.doesNotMatch(error.message, /20260901000000_ahead/)
        return true
      },
    )
  })

  it('names every orphan it aborts on, in a stable order', () => {
    const applied = new Map([
      ['20260201000000_b', 'x'],
      ['20260101000000_a', 'x'],
    ])
    try {
      assertNoDrift([file('20260301000000_c')], applied, recordingLogger())
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
    assert.throws(
      () => assertNoDrift([file('0001_init_renamed')], new Map([['0001_init', 'x']]), recordingLogger()),
      /renam/i,
    )
  })

  it('aborts when the build carries no migrations at all', () => {
    // Not a rollback: there is no newest file to be ahead of, so this is a
    // build that lost its migrations folder.
    assert.throws(() => assertNoDrift([], new Map([['0001_init', 'x']]), recordingLogger()), /0001_init/)
  })
})
