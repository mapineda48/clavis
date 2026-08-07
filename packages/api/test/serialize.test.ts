import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { toIso } from '../src/modules/shared/serialize.js'

describe('toIso', () => {
  it('formats a Date the way the response schemas declare', () => {
    assert.equal(toIso(new Date('2026-01-02T03:04:05.678Z')), '2026-01-02T03:04:05.678Z')
  })

  it('accepts the string form a text cast or a driver setting can produce', () => {
    assert.equal(toIso('2026-01-02T03:04:05.678Z'), '2026-01-02T03:04:05.678Z')
  })

  it('normalises an offset to UTC rather than passing it through', () => {
    assert.equal(toIso('2026-01-02T03:04:05.000+02:00'), '2026-01-02T01:04:05.000Z')
  })

  it('gives the same answer for both representations of one instant', () => {
    const iso = '2026-06-15T12:00:00.000Z'
    assert.equal(toIso(new Date(iso)), toIso(iso))
  })
})
