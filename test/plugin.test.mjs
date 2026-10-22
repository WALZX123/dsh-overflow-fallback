import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/index.js'

/** Build a fake plugin context that captures the request-error listener. */
function harness(options = {}) {
  let handler
  const calls = { compact: 0 }
  const compaction = options.compaction === false
    ? undefined
    : options.compaction ?? {
        async compactIfNeeded(agent, trigger, signal) {
          calls.compact += 1
          calls.trigger = trigger
          calls.agent = agent
          calls.signal = signal
          return 'compacted' in options ? options.compacted : { replaced: true }
        },
      }
  const ctx = {
    logger() {
      return { warn() {} }
    },
    on(event, listener) {
      assert.equal(event, 'agent/request-error')
      handler = listener
      return () => {}
    },
    get(service) {
      if (service === 'compaction') return compaction
      if (service === 'agents') return options.agents
      return undefined
    },
  }
  apply(ctx, options.config)
  return {
    calls,
    dispatch: (payload, next = async () => undefined) => handler(payload, next),
  }
}

const overflow = (agent = {}) => ({ agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: { aborted: false } })

test('retries after a forced compaction produced a result', async () => {
  const h = harness()
  const result = await h.dispatch(overflow())
  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(h.calls.compact, 1)
  assert.equal(h.calls.trigger, 'context-overflow')
})

test('does not retry when compaction had no safe range', async () => {
  const h = harness({ compacted: null })
  assert.equal(await h.dispatch(overflow()), undefined)
  assert.equal(h.calls.compact, 1)
})

test('leaves every other failure to the built-in layers', async () => {
  const h = harness()
  assert.equal(await h.dispatch({ agent: {}, failure: { code: 'RATE_LIMITED' }, signal: { aborted: false } }), undefined)
  assert.equal(h.calls.compact, 0)
})

test('a downstream decision wins and is not retried twice', async () => {
  const h = harness()
  const downstream = { kind: 'retry' }
  assert.deepEqual(await h.dispatch(overflow(), async () => downstream), downstream)
  assert.equal(h.calls.compact, 0)
})

test('honours maxAttempts', async () => {
  const h = harness({ config: { maxAttempts: 1 } })
  const agent = {}
  assert.deepEqual(await h.dispatch(overflow(agent)), { kind: 'retry' })
  assert.equal(await h.dispatch(overflow(agent)), undefined)
  assert.equal(h.calls.compact, 1)
})

test('does nothing when no compaction backend is loaded', async () => {
  const h = harness({ compaction: false })
  assert.equal(await h.dispatch(overflow()), undefined)
  assert.equal(h.calls.compact, 0)
})

test('an aborted signal is never retried', async () => {
  const h = harness()
  assert.equal(await h.dispatch({ agent: {}, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: { aborted: true } }), undefined)
  assert.equal(h.calls.compact, 0)
})

test('a payload without a usable agent or signal is left alone', async () => {
  const h = harness()
  assert.equal(await h.dispatch({ failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: { aborted: false } }), undefined)
  assert.equal(await h.dispatch({ agent: {}, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } }), undefined)
  assert.equal(await h.dispatch(undefined), undefined)
  assert.equal(h.calls.compact, 0)
})

test('a compaction failure surfaces as a warning, not a crash', async () => {
  const h = harness({
    compaction: {
      async compactIfNeeded() {
        throw new Error('summary failed')
      },
    },
  })
  assert.equal(await h.dispatch(overflow()), undefined)
})

test('disabled means no listener at all', async () => {
  let registered = false
  apply({
    logger: () => ({ warn() {} }),
    on() {
      registered = true
    },
    get() {
      return undefined
    },
  }, { enabled: false })
  assert.equal(registered, false)
})

test('auto mode continues in a new session once retries are exhausted', async () => {
  let created
  const h = harness({
    config: { revive: 'auto', maxAttempts: 1 },
    agents: {
      async create(options) {
        created = options
        return { agent: { inject() {} }, dispose: async () => {} }
      },
    },
  })
  const session = {
    id: 's1',
    header: { title: 't', meta: { cwd: '/w' } },
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    snapshotEvents: () => [],
  }
  const agent = { session }
  assert.deepEqual(await h.dispatch(overflow(agent)), { kind: 'retry' })
  assert.equal(await h.dispatch(overflow(agent)), undefined)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(created.meta.parentSession, 's1')
  assert.equal(created.meta.cwd, '/w')
  assert.equal(created.agentOptions.provider, 'p')
})

test('auto mode never revives a subagent session', async () => {
  let created = false
  const h = harness({
    config: { revive: 'auto', maxAttempts: 0 },
    agents: { async create() { created = true } },
  })
  const session = { id: 's2', header: { meta: { origin: 'subagent' } }, snapshotEvents: () => [] }
  await h.dispatch(overflow({ session }))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(created, false)
})

function toolHarness(config, options = {}) {
  const registered = []
  const ctx = {
    logger: () => ({ warn() {} }),
    on() {},
    // The plugin waits for services through ctx.inject; the fake resolves them inline.
    inject(services, callback) {
      const scope = { tools: ctx.tools }
      if (services.includes('hmr')) {
        if (ctx.hmr === undefined) return
        scope.hmr = ctx.hmr
      }
      if (services.includes('commands')) {
        if (ctx.commands === undefined) return
        scope.commands = ctx.commands
      }
      if (services.includes('sessions')) {
        if (ctx.sessions === undefined) return
        scope.sessions = ctx.sessions
      }
      callback(scope)
    },
    get(service) {
      if (service === 'workspaceRegistry') return options.workspaceRegistry
      if (service === 'sessionQuery') return options.sessionQuery
      if (service !== 'agents') return undefined
      return {
        async create(options) {
          ctx.created = options
          return { agent: { inject(message) { ctx.injected = message } }, dispose: async () => {} }
        },
      }
    },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    ...(options.hmr === undefined ? {} : { hmr: options.hmr }),
    ...(options.commands === undefined ? {} : { commands: options.commands }),
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
  }
  apply(ctx, config)
  return { ctx, registered }
}

test('revive off registers no tool', () => {
  const { registered } = toolHarness({ revive: 'off' })
  assert.equal(registered.length, 0)
})

test('manual mode registers the revive_session tool', () => {
  const { registered } = toolHarness({ revive: 'manual' })
  assert.equal(registered.length, 1)
  const tool = registered[0]
  assert.equal(tool.name, 'revive_session')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
})

test('the revive_session tool refuses to continue one session twice', async () => {
  const { ctx, registered } = toolHarness({ revive: 'manual' })
  const tool = registered[0]
  const session = { id: 'once', header: { cwd: '/w' }, snapshotEvents: () => [] }
  await tool.execute({}, { agent: { session } })
  await assert.rejects(() => tool.execute({}, { agent: { session } }), /already continued/)
  assert.equal(typeof ctx.created.meta.parentSession, 'string')
})

test('falls back to the workspace whose path is the session cwd', async () => {
  const attached = []
  const workspaceRegistry = {
    list: () => [
      { path: '/other', sessionIds: [], attachSession: async () => {} },
      { path: '/w', sessionIds: [], attachSession: async (id) => { attached.push(id) } },
    ],
  }
  const { registered } = toolHarness({ revive: 'manual' }, { workspaceRegistry })
  const tool = registered[0]
  const session = { id: 'no-owner', header: { cwd: '/w' }, snapshotEvents: () => [] }
  const value = await tool.execute({}, { agent: { session } })
  assert.deepEqual(attached, [value.sessionId])
})

test('the revive_session tool creates a session and reports stats', async () => {
  const { ctx, registered } = toolHarness({ revive: 'manual' })
  const tool = registered[0]
  const session = {
    id: 'live-1',
    header: { meta: { cwd: '/w' } },
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    snapshotEvents: () => [
      { type: 'user/message', seq: 1, time: 0, data: { turn: 1, message: '继续' } },
    ],
  }
  const value = await tool.execute({ reason: 'test' }, { agent: { session } })
  assert.equal(typeof value.sessionId, 'string')
  assert.equal(value.requests, 1)
  assert.equal(ctx.created.meta.parentSession, 'live-1')
  assert.equal(ctx.created.meta.cwd, '/w')
  assert.equal(ctx.injected.source.kind, 'overflow-fallback')
  const blocks = tool.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /Continued in session/)
})

test('no reload tool when HMR is absent', () => {
  const { registered } = toolHarness({ revive: 'manual' })
  assert.equal(registered.find(tool => tool.name === 'reload_plugins'), undefined)
})

test('reload tool schedules an HMR reconciliation', async () => {
  const calls = []
  const hmr = {
    runExclusive(operation) { calls.push('exclusive'); return operation() },
    async reconcileProfile(ids) { calls.push(ids); return {} },
  }
  const { registered } = toolHarness({ revive: 'manual' }, { hmr })
  const reload = registered.find(tool => tool.name === 'reload_plugins')
  assert.ok(reload, 'reload_plugins is registered')
  const value = reload.execute({ ids: ['dsh-overflow-fallback'] })
  assert.equal(value.scheduled, true)
  assert.deepEqual(value.ids, ['dsh-overflow-fallback'])
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.deepEqual(calls.at(-1), ['dsh-overflow-fallback'])
})

test('registers a /reload command that triggers HMR', async () => {
  const calls = []
  const hmr = {
    runExclusive(operation) { calls.push('exclusive'); return operation() },
    async reconcileProfile(ids) { calls.push(ids); return {} },
  }
  const definitions = []
  const commands = {
    register(definition) { definitions.push(definition); return () => {} },
  }
  toolHarness({ revive: 'manual' }, { hmr, commands })
  assert.equal(definitions.length, 1)
  assert.equal(definitions[0].name, 'reload')
  assert.match(definitions[0].description, /Reload/)
  const outcome = definitions[0].handler()
  assert.equal(outcome.kind, 'success')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.deepEqual(calls.at(-1), [])
})

test('recall_original is registered when sessions are available', () => {
  const { registered } = toolHarness({ revive: 'manual' }, { sessions: { get: () => undefined } })
  assert.ok(registered.some(tool => tool.name === 'recall_original'))
})

test('recall_original reads the parent log slice', async () => {
  const parent = {
    snapshotEvents: () => [
      { type: 'user/message', seq: 5, time: 0, data: { content: [{ type: 'text', text: '原始提问' }] } },
      { type: 'assistant/message', seq: 9, time: 0, data: { message: { content: [{ type: 'text', text: '原始结论' }] } } },
    ],
  }
  const sessions = { get: id => (id === 'parent-1' ? parent : undefined) }
  const { registered } = toolHarness({ revive: 'manual' }, { sessions })
  const tool = registered.find(item => item.name === 'recall_original')
  const value = await tool.execute({ from: 1, to: 9 }, { agent: { session: { header: { parentSession: 'parent-1' } } } })
  assert.equal(value.parentSessionId, 'parent-1')
  assert.equal(value.events.length, 2)
  assert.match(value.events[0].text, /原始提问/)
  const rendered = tool.output.render({}, value)
  assert.match(rendered[0].text, /seq 5/)
  assert.match(rendered[0].text, /原始结论/)
})

test('recall_original resolves an anchor to one event', async () => {
  const parent = {
    snapshotEvents: () => [
      { type: 'user/message', seq: 7, time: 0, data: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'user/message', seq: 8, time: 0, data: { content: [{ type: 'text', text: 'b' }] } },
    ],
  }
  const { registered } = toolHarness({ revive: 'manual' }, { sessions: { get: () => parent } })
  const tool = registered.find(item => item.name === 'recall_original')
  const value = await tool.execute({ anchor: 'T2@seq8' }, { agent: { session: { header: { parentSession: 'p' } } } })
  assert.deepEqual(value.events.map(event => event.seq), [8])
})

test('recall_original explains a session with no parent', async () => {
  const { registered } = toolHarness({ revive: 'manual' }, { sessions: { get: () => undefined } })
  const tool = registered.find(item => item.name === 'recall_original')
  await assert.rejects(
    () => tool.execute({}, { agent: { session: { header: {} } } }),
    /not continued from another session/,
  )
})

test('recall_original explains an unloaded parent', async () => {
  const { registered } = toolHarness({ revive: 'manual' }, { sessions: { get: () => undefined } })
  const tool = registered.find(item => item.name === 'recall_original')
  await assert.rejects(
    () => tool.execute({}, { agent: { session: { header: { parentSession: 'gone' } } } }),
    /is not loaded/,
  )
})

test('recall_original reads a cold parent through the query service', async () => {
  let disposed = 0
  const sessionQuery = {
    async observeSession() {
      return {
        events: [{ type: 'user/message', seq: 3, time: 0, data: { content: [{ type: 'text', text: '冷会话内容' }] } }],
        dispose() { disposed += 1 },
      }
    },
  }
  const { registered } = toolHarness({ revive: 'manual' }, { sessions: { get: () => undefined }, sessionQuery })
  const tool = registered.find(item => item.name === 'recall_original')
  const value = await tool.execute({}, { agent: { session: { header: { parentSession: 'cold-1' } } } })
  assert.equal(value.parentSessionId, 'cold-1')
  assert.match(value.events[0].text, /冷会话内容/)
  assert.equal(disposed, 1)
})
