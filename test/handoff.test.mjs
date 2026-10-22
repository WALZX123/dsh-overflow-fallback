import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_HANDOFF_CHARS, buildHandoff, excerpt, messageText } from '../lib/handoff.js'

/** Build one session event with a payload. */
function event(type, data) {
  return { type, seq: 0, time: 0, data }
}

test('messageText reads strings, block lists and objects', () => {
  assert.equal(messageText('hi'), 'hi')
  assert.equal(messageText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(messageText({ text: 'c' }), 'c')
  assert.equal(messageText(undefined), '')
  assert.equal(messageText([null, 42]), '')
})

test('excerpt collapses whitespace and clips', () => {
  assert.equal(excerpt('a \n  b'), 'a b')
  assert.equal(excerpt('abcdef', 4), 'abc…')
})

test('builds a handoff from a typical session', () => {
  const { markdown, stats } = buildHandoff({
    events: [
      event('user/message', { message: '把登录改成 JWT' }),
      event('assistant/message', { message: '好的，先看现有实现' }),
      event('tool/call', { name: 'read', arguments: '{"path":"src/auth.ts"}' }),
      event('tool/call', { name: 'read', arguments: '{"path":"src/auth.ts"}' }),
      event('tool/call', { name: 'edit', arguments: '{"file_path":"src/auth.ts","old":"a","new":"b"}' }),
      event('user/message', { message: '另外记得加测试' }),
      event('assistant/message', { message: '已完成 JWT 改造，测试通过' }),
    ],
    title: '登录改造',
    reason: '上下文溢出，已为你开新会话',
  })

  assert.match(markdown, /^# 会话续命 · 交接包/)
  assert.match(markdown, /原会话：登录改造/)
  assert.match(markdown, /把登录改成 JWT/)
  assert.match(markdown, /另外记得加测试/)
  assert.match(markdown, /已完成 JWT 改造/)
  assert.match(markdown, /src\/auth\.ts/)
  assert.match(markdown, /read ×2/)
  assert.deepEqual(stats, { requests: 2, conclusions: 2, files: 1, tools: 2, turns: 2 })
})

test('skips injected context that is not a human prompt', () => {
  const { markdown, stats } = buildHandoff({
    events: [
      event('user/message', { message: 'human', source: { kind: 'user' } }),
      event('user/message', { message: 'injected skill text', source: { kind: 'skill' } }),
    ],
  })
  assert.match(markdown, /human/)
  assert.doesNotMatch(markdown, /injected skill text/)
  assert.equal(stats.requests, 1)
})

test('never copies reasoning blocks into a handoff', () => {
  const { markdown } = buildHandoff({
    events: [
      {
        type: 'assistant/message',
        seq: 1,
        time: 0,
        data: { message: { content: [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text: '对外结论' }] } },
      },
    ],
  })
  assert.match(markdown, /对外结论/)
  assert.doesNotMatch(markdown, /内部推理/)
})

test('reads the real assistant/message payload shape', () => {
  const { markdown, stats } = buildHandoff({
    events: [
      { type: 'user/message', seq: 1, time: 0, data: { content: [{ type: 'text', text: 'q' }] } },
      { type: 'assistant/message', seq: 4, time: 0, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '已完成改造' }] } } },
    ],
  })
  assert.match(markdown, /已完成改造/)
  assert.equal(stats.conclusions, 1)
})

test('reads the real user/message payload shape', () => {
  const { markdown, stats } = buildHandoff({
    events: [
      { type: 'user/message', seq: 7, time: 0, data: { content: [{ type: 'text', text: '真实形状' }], source: { kind: 'user' } } },
    ],
  })
  assert.match(markdown, /真实形状/)
  assert.match(markdown, /T1@seq7/)
  assert.equal(stats.requests, 1)
})

test('keeps only the newest requests and conclusions', () => {
  const events = []
  for (let i = 0; i < 20; i += 1) events.push(event('user/message', { message: `q${i}` }))
  for (let i = 0; i < 10; i += 1) events.push(event('assistant/message', { message: `a${i}` }))
  const { markdown } = buildHandoff({ events })
  assert.match(markdown, /q19/)
  assert.doesNotMatch(markdown, /- q0\n/)
  assert.match(markdown, /a9/)
  assert.doesNotMatch(markdown, /- a0\n/)
})

test('bounds the document length', () => {
  const events = []
  for (let i = 0; i < 40; i += 1) {
    events.push(event('tool/call', { name: 'read', arguments: JSON.stringify({ path: `f${i}-${'y'.repeat(500)}` }) }))
  }
  const { markdown } = buildHandoff({ events })
  assert.ok(markdown.length <= MAX_HANDOFF_CHARS)
  assert.match(markdown, /交接包已截断/)
})

test('survives malformed events and arguments', () => {
  const { markdown, stats } = buildHandoff({
    events: [
      null,
      42,
      event('user/message', {}),
      event('tool/call', { name: 'x', arguments: 'not json' }),
      event('tool/call', { name: 7 }),
      { type: 'assistant/message' },
    ],
  })
  assert.match(markdown, /没有记录到人工提问/)
  assert.equal(stats.tools, 1)
  assert.equal(stats.files, 0)
})

test('points back to the original session with turn anchors', () => {
  const { markdown, stats } = buildHandoff({
    sessionId: 'sess-123',
    events: [
      { type: 'user/message', seq: 4, time: 0, data: { turn: 1, message: 'first ask' } },
      { type: 'user/message', seq: 9, time: 0, data: { turn: 2, message: 'second ask' } },
    ],
  })
  assert.match(markdown, /sess-123/)
  assert.match(markdown, /T1@seq4/)
  assert.match(markdown, /T2@seq9/)
  assert.match(markdown, /摘录，不是全文/)
  assert.equal(stats.turns, 2)
})

test('an empty session still yields a usable document', () => {
  const { markdown } = buildHandoff({ events: [] })
  assert.match(markdown, /会话续命/)
  assert.match(markdown, /接着做/)
})
