import assert from 'node:assert/strict'
import test from 'node:test'

import { decideRecovery, failureCode, recoveryAction } from '../lib/decide.js'
import { narrowConfig } from '../lib/index.js'

test('failureCode reads a direct code', () => {
  assert.equal(failureCode({ code: 'CONTEXT_WINDOW_EXCEEDED' }), 'CONTEXT_WINDOW_EXCEEDED')
})

test('failureCode reads a nested error code', () => {
  assert.equal(failureCode({ error: { code: 'CONTEXT_WINDOW_EXCEEDED' } }), 'CONTEXT_WINDOW_EXCEEDED')
})

test('failureCode refuses values it cannot identify', () => {
  assert.equal(failureCode(undefined), undefined)
  assert.equal(failureCode(null), undefined)
  assert.equal(failureCode('CONTEXT_WINDOW_EXCEEDED'), undefined)
  assert.equal(failureCode({ code: '' }), undefined)
  assert.equal(failureCode({ code: 42 }), undefined)
  assert.equal(failureCode({ code: 'RATE_LIMITED' }), 'RATE_LIMITED')
})

test('decideRecovery ignores every other failure', () => {
  assert.deepEqual(
    decideRecovery({ failure: { code: 'RATE_LIMITED' }, attempts: 0, maxAttempts: 2, compactionAvailable: true }),
    { attempt: false, reason: 'not-overflow' },
  )
})

test('decideRecovery respects the attempt ceiling', () => {
  const overflow = { code: 'CONTEXT_WINDOW_EXCEEDED' }
  assert.deepEqual(
    decideRecovery({ failure: overflow, attempts: 2, maxAttempts: 2, compactionAvailable: true }),
    { attempt: false, reason: 'exhausted' },
  )
  assert.deepEqual(
    decideRecovery({ failure: overflow, attempts: 0, maxAttempts: 0, compactionAvailable: true }),
    { attempt: false, reason: 'exhausted' },
  )
  assert.deepEqual(
    decideRecovery({ failure: overflow, attempts: 1, maxAttempts: 2, compactionAvailable: true }),
    { attempt: true },
  )
})

test('decideRecovery needs a compaction backend', () => {
  assert.deepEqual(
    decideRecovery({ failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, attempts: 0, maxAttempts: 2, compactionAvailable: false }),
    { attempt: false, reason: 'no-compaction' },
  )
})

test('recoveryAction retries only after compaction made progress', () => {
  assert.deepEqual(recoveryAction({ replaced: true }), { kind: 'retry' })
  assert.equal(recoveryAction(null), undefined)
  assert.equal(recoveryAction(undefined), undefined)
})

test('narrowConfig defaults', () => {
  assert.deepEqual(narrowConfig(undefined), { enabled: true, maxAttempts: 2, revive: 'manual', kickoff: true })
})

test('narrowConfig accepts valid overrides', () => {
  assert.deepEqual(
    narrowConfig({ enabled: false, maxAttempts: 0, revive: 'auto', kickoff: false }),
    { enabled: false, maxAttempts: 0, revive: 'auto', kickoff: false },
  )
})

test('narrowConfig rejects a non-boolean kickoff', () => {
  assert.throws(() => narrowConfig({ kickoff: 'yes' }), /config\.kickoff must be a boolean/)
})

test('narrowConfig rejects an unknown revive mode', () => {
  assert.throws(() => narrowConfig({ revive: 'always' }), /config\.revive must be one of off, manual, auto/)
})

test('narrowConfig fails loud on unknown fields', () => {
  assert.throws(() => narrowConfig({ threshold: 0.8 }), /unsupported config field "threshold"/)
})

test('narrowConfig fails loud on wrong types', () => {
  assert.throws(() => narrowConfig([]), /config must be an object/)
  assert.throws(() => narrowConfig({ enabled: 'yes' }), /config\.enabled must be a boolean/)
  assert.throws(() => narrowConfig({ maxAttempts: -1 }), /config\.maxAttempts must be a non-negative safe integer/)
  assert.throws(() => narrowConfig({ maxAttempts: 1.5 }), /config\.maxAttempts must be a non-negative safe integer/)
})
