import assert from 'node:assert/strict'
import test from 'node:test'

import { createReviveRunner, normalizeReviveMode, planRevive } from '../lib/revive.js'

/** Build a Session-like fixture. */
function session(options = {}) {
  const {
    events = [],
    id = 'old-session',
    title = '登录改造',
    cwd = '/workspace',
    provider = 'deepseek',
    model = 'deepseek-chat',
    origin,
  } = options
  return {
    id,
    header: { title, meta: { ...(cwd === undefined ? {} : { cwd }), ...(origin === undefined ? {} : { origin }) } },
    requestHeader: () => ({ config: { provider, model } }),
    snapshotEvents: () => events,
  }
}

test('normalizeReviveMode defaults to off and rejects unknown modes', () => {
  assert.equal(normalizeReviveMode(undefined), 'off')
  assert.equal(normalizeReviveMode('auto'), 'auto')
  assert.equal(normalizeReviveMode('manual'), 'manual')
  assert.throws(() => normalizeReviveMode('yes'), /must be one of off, manual, auto/)
})

test('planRevive carries cwd, lineage and routed model', () => {
  const s = session({
    events: [{ type: 'user/message', seq: 1, time: 0, data: { content: [{ type: 'text', text: '改成 JWT' }] } }],
  })
  const plan = planRevive({ session: s, reason: '溢出' })
  assert.match(plan.handoff.markdown, /old-session/)
  assert.equal(plan.create.meta.cwd, '/workspace')
  assert.equal(plan.create.meta.parentSession, 'old-session')
  assert.deepEqual(plan.create.agentOptions, { provider: 'deepseek', model: 'deepseek-chat' })
})

test('planRevive reads a flattened header cwd', () => {
  const s = session()
  s.header = { cwd: 'E:\\DeepSeek工作区', title: 't' }
  const plan = planRevive({ session: s })
  assert.equal(plan.create.meta.cwd, 'E:\\DeepSeek工作区')
})

test('planRevive omits unknown routing and cwd', () => {
  const s = session()
  delete s.header.meta.cwd
  s.requestHeader = () => undefined
  const plan = planRevive({ session: s })
  assert.equal(plan.create.meta.cwd, undefined)
  assert.equal(plan.create.agentOptions, undefined)
})

test('runner creates an agent and injects the handoff', async () => {
  const calls = { create: 0, inject: 0 }
  let created
  const runner = createReviveRunner({
    agents: {
      async create(options) {
        calls.create += 1
        created = options
        return {
          agent: { inject(message) { calls.inject += 1; created.injected = message } },
          dispose: async () => {},
        }
      },
    },
    newId: () => 'new-session',
  })

  const result = await runner(session({ events: [{ type: 'user/message', seq: 1, time: 0, data: { turn: 1, message: 'hi' } }] }))
  assert.equal(result.sessionId, 'new-session')
  assert.equal(calls.create, 1)
  assert.equal(calls.inject, 1)
  assert.equal(created.sessionId, 'new-session')
  assert.equal(created.meta.parentSession, 'old-session')
  assert.match(created.injected.content, /会话续命/)
  assert.deepEqual(created.injected.source, { kind: 'overflow-fallback' })
})

test('kickoff starts the first turn so the session is visible', async () => {
  const seen = { followup: 0, inject: 0 }
  const runner = createReviveRunner({
    agents: {
      async create() {
        return { agent: { followup() { seen.followup += 1 }, inject() { seen.inject += 1 } }, dispose: async () => {} }
      },
    },
    newId: () => 'k',
  })
  await runner(session(), { kickoff: true })
  assert.equal(seen.followup, 1)
  assert.equal(seen.inject, 0)
})

test('kickoff falls back to inject when followup is rejected', async () => {
  const seen = { inject: 0 }
  const runner = createReviveRunner({
    agents: {
      async create() {
        return { agent: { followup() { throw new Error('no turn') }, inject() { seen.inject += 1 } }, dispose: async () => {} } }
      },
    },
    newId: () => 'k',
  })
  const result = await runner(session(), { kickoff: true })
  assert.equal(seen.inject, 1)
  assert.equal(result.sessionId, 'k')
})

test('runner accepts a lazy agents getter', async () => {
  const runner = createReviveRunner({
    agents: () => ({ async create() { return { agent: { inject() {} }, dispose: async () => {} } } }),
    newId: () => 'x',
  })
  const result = await runner(session())
  assert.equal(result.sessionId, 'x')
})

test('runner attaches the new session so the UI can list it', async () => {
  const attached = []
  const runner = createReviveRunner({
    agents: { async create() { return { agent: { inject() {} }, dispose: async () => {} } } },
    newId: () => 'new-id',
    attach: async (source, created) => { attached.push([source, created]) },
  })
  await runner(session())
  assert.deepEqual(attached, [['old-session', 'new-id']])
})

test('a failed attachment does not lose the revived session', async () => {
  const runner = createReviveRunner({
    agents: { async create() { return { agent: { inject() {} }, dispose: async () => {} } } },
    newId: () => 'new-id',
    attach: async () => { throw new Error('no workspace') },
  })
  const result = await runner(session())
  assert.equal(result.sessionId, 'new-id')
})

test('runner fails loudly without an agents service', async () => {
  const runner = createReviveRunner({ agents: () => undefined })
  await assert.rejects(() => runner(session()), /agents service is not available/)
})

test('runner disposes the handle when injection fails', async () => {
  let disposed = false
  const runner = createReviveRunner({
    agents: {
      async create() {
        return {
          agent: { inject() { throw new Error('inject failed') } },
          dispose: async () => { disposed = true },
        }
      },
    },
    newId: () => 'y',
  })
  await assert.rejects(() => runner(session()), /inject failed/)
  assert.equal(disposed, true)
})

test('runner rejects a missing session', async () => {
  const runner = createReviveRunner({ agents: { async create() {} } })
  await assert.rejects(() => runner(undefined), /session is required/)
})
