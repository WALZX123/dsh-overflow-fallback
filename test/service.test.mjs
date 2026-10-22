import assert from 'node:assert/strict'
import test from 'node:test'

import { CONTRACT_VERSION, SERVICE_NAME, createService } from '../lib/service.js'

const service = createService()

test('declares a stable service name and contract version', () => {
  assert.equal(SERVICE_NAME, 'overflowFallback')
  assert.equal(CONTRACT_VERSION, 1)
  assert.equal(service.contractVersion, 1)
})

test('identifies overflow failures only', () => {
  assert.equal(service.isOverflowFailure({ code: 'CONTEXT_WINDOW_EXCEEDED' }), true)
  assert.equal(service.isOverflowFailure({ error: { code: 'CONTEXT_WINDOW_EXCEEDED' } }), true)
  assert.equal(service.isOverflowFailure({ code: 'RATE_LIMITED' }), false)
  assert.equal(service.isOverflowFailure(undefined), false)
})

test('renders a handoff for a live session', () => {
  const session = {
    id: 'sess-1',
    header: { title: '登录改造' },
    snapshotEvents: () => [
      { type: 'user/message', seq: 3, time: 0, data: { turn: 1, message: '改成 JWT' } },
      { type: 'assistant/message', seq: 8, time: 0, data: { message: '已完成' } },
    ],
  }
  const { markdown, stats } = service.handoffFor(session, { reason: '溢出' })
  assert.match(markdown, /sess-1/)
  assert.match(markdown, /登录改造/)
  assert.match(markdown, /改成 JWT/)
  assert.equal(stats.turns, 1)
})

test('handoffFor tolerates a session without snapshotEvents', () => {
  const { markdown } = service.handoffFor({ id: 'bare' })
  assert.match(markdown, /没有任何记录|没有记录到人工提问/)
})

test('handoffFor rejects a missing session', () => {
  assert.throws(() => service.handoffFor(undefined), /session is required/)
})

test('buildHandoff rejects a malformed input', () => {
  assert.throws(() => service.buildHandoff(null), /input object is required/)
})

test('anchors round-trip', () => {
  assert.equal(service.anchor(3, 42), 'T3@seq42')
  assert.deepEqual(service.parseAnchor('见 T3@seq42 那一段'), { turn: 3, seq: 42 })
  assert.equal(service.parseAnchor('没有锚点'), undefined)
  assert.equal(service.parseAnchor(undefined), undefined)
  assert.throws(() => service.anchor(1.5, 2), /safe integers/)
})

test('two calls never share state', () => {
  const a = createService()
  const b = createService()
  assert.notEqual(a, b)
  assert.equal(a.contractVersion, b.contractVersion)
})

test('recall reads a log slice by sequence', () => {
  const session = {
    snapshotEvents: () => [
      { type: 'user/message', seq: 1, time: 0, data: { message: 'one' } },
      { type: 'assistant/message', seq: 5, time: 0, data: { message: 'two' } },
      { type: 'tool/call', seq: 9, time: 0, data: { name: 'read', arguments: '{"path":"a.ts"}' } },
    ],
  }
  const slice = service.recall(session, { from: 2, to: 9 })
  assert.deepEqual(slice.events.map(e => e.seq), [5, 9])
  assert.match(slice.events[0].text, /two/)
  assert.equal(slice.truncated, false)
})

test('recall rejects a missing session', () => {
  assert.throws(() => service.recall(undefined), /session is required/)
})

test('reviveFor delegates to the configured runner', async () => {
  const runner = async (session, options) => ({ sessionId: 'new', handoff: { markdown: options.reason }, session })
  const withRunner = createService({ reviveRunner: runner })
  const result = await withRunner.reviveFor({ id: 'old' }, { reason: 'r' })
  assert.equal(result.sessionId, 'new')
})

test('reviveFor explains when no runner is configured', async () => {
  await assert.rejects(() => service.reviveFor({ id: 'old' }), /no revival runner configured/)
})
