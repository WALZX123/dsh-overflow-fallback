/**
 * dsh-overflow-fallback — host half.
 *
 * A last-resort recovery for the failure mode where a session can no longer
 * send any request: the provider reports `CONTEXT_WINDOW_EXCEEDED` and the
 * built-in policy could not shrink the surface, so every later message fails
 * the same way and the conversation is effectively dead.
 *
 * The plugin registers one `agent/request-error` waterfall listener. When the
 * built-in layers decline the failure, it asks the loaded compaction backend
 * for one forced reduction and retries the request exactly once per attempt.
 *
 * It adds no model-visible text, writes no files, opens no sockets, spawns no
 * processes, and never edits the session log directly: the only mutation is
 * the compaction call the harness itself exposes.
 *
 * @module dsh-overflow-fallback
 */

import { decideRecovery, recoveryAction } from './decide.js'
import { createReviveRunner, normalizeReviveMode } from './revive.js'
import { SERVICE_NAME, createService, sliceEvents } from './service.js'

/** Plugin name used by the Cordis loader. */
export const name = 'dsh-overflow-fallback'

/** No required services: compaction is an optional capability read through `ctx.get`. */
export const inject = []

/** Defaults for every configurable choice (see `DEFAULT_CONFIG`). */
const DEFAULTS = Object.freeze({
  enabled: true,
  maxAttempts: 2,
  // Manual by default: the revive tool is available, but nothing is created
  // unless a caller asks for it. Automatic revival stays opt-in.
  revive: 'manual',
  // Start the first turn in the revived session so the handoff is persisted and
  // the session becomes a visible conversation instead of an empty shell.
  kickoff: true,
})

/** Fields accepted from the loader entry's `config` block. */
const CONFIG_KEYS = new Set(['enabled', 'maxAttempts', 'revive', 'kickoff'])

/**
 * Validate the loader entry's `config` block.
 *
 * Misconfiguration fails at load instead of degrading silently: unknown keys
 * and wrong types throw a `TypeError` naming the offending field.
 *
 * @param {unknown} raw - the `config` value handed to the plugin.
 * @returns {{ enabled: boolean, maxAttempts: number, revive: 'off' | 'manual' | 'auto' }} the resolved configuration.
 */
export function narrowConfig(raw) {
  if (raw === undefined || raw === null) return /** @type {any} */ ({ ...DEFAULTS })
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('dsh-overflow-fallback: config must be an object')
  }
  const value = /** @type {Record<string, unknown>} */ (raw)
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new TypeError(`dsh-overflow-fallback: unsupported config field "${key}" (allowed: ${[...CONFIG_KEYS].join(', ')})`)
    }
  }
  const enabled = value.enabled ?? DEFAULTS.enabled
  if (typeof enabled !== 'boolean') {
    throw new TypeError('dsh-overflow-fallback: config.enabled must be a boolean')
  }
  const maxAttempts = value.maxAttempts ?? DEFAULTS.maxAttempts
  if (!Number.isSafeInteger(maxAttempts) || /** @type {number} */ (maxAttempts) < 0) {
    throw new TypeError('dsh-overflow-fallback: config.maxAttempts must be a non-negative safe integer')
  }
  const revive = normalizeReviveMode(value.revive)
  const kickoff = value.kickoff ?? DEFAULTS.kickoff
  if (typeof kickoff !== 'boolean') {
    throw new TypeError('dsh-overflow-fallback: config.kickoff must be a boolean')
  }
  return { enabled, maxAttempts: /** @type {number} */ (maxAttempts), revive, kickoff }
}

/**
 * Emit one line without depending on a specific logger service.
 *
 * @param {object} ctx - the plugin context.
 * @param {'warn' | 'info'} level - severity.
 * @param {string} message - human-readable diagnostic.
 */
function log(ctx, level, message) {
  const logger = /** @type {{ logger?: unknown }} */ (ctx).logger
  if (typeof logger === 'function') {
    try {
      logger.call(ctx, 'dsh-overflow-fallback').warn?.(message)
      return
    } catch {
      // The logger service is optional here; fall through to console.
    }
  }
  if (level === 'warn') console.warn(`[dsh-overflow-fallback] ${message}`)
}

/**
 * Register the recovery listener.
 *
 * @param {object} ctx - Cordis plugin context.
 * @param {unknown} [rawConfig] - loader entry `config`.
 */
export function apply(ctx, rawConfig) {
  const config = narrowConfig(rawConfig)
  if (!config.enabled) return

  // Escalation: when retrying cannot help, offer to continue in a fresh session.
  const revive = createReviveRunner({
    agents: () => ctx.get('agents'),
    log: (level, message) => log(ctx, level, message),
    // Creating an agent does not register it with a workspace; without this the
    // revived session stays on disk but never appears in the sidebar list.
    attach: async (sourceSessionId, newSessionId, cwd) => {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.list !== 'function') return
      const workspaces = registry.list()
      const ownsSource = (workspace) => {
        const ids = workspace?.sessionIds
        return Array.isArray(ids) && ids.includes(sourceSessionId)
      }
      // Prefer the workspace that owns the source session; fall back to the one
      // whose path is the revived session's cwd, since a session created outside
      // the UI may predate the list it should join.
      const owner = workspaces.find(ownsSource)
        ?? (cwd === undefined ? undefined : workspaces.find(workspace => workspace?.path === cwd))
      if (owner === undefined) return
      if (typeof owner.attachSession !== 'function') return
      await owner.attachSession(newSessionId)
    },
  })

  // Publish the integration contract so other plugins can build handoffs and
  // read overflow decisions without depending on this package's internals.
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide(SERVICE_NAME, createService({ reviveRunner: revive }))
    } catch (error) {
      log(ctx, 'warn', `could not publish service "${SERVICE_NAME}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Attempts made per agent; a WeakMap keeps agents collectable. */
  const attempts = new WeakMap()
  /** Sessions already revived by this plugin instance. */
  const revived = new WeakSet()

  /**
   * Continue one dead session in a fresh one, without blocking the failed turn.
   * @param {object} agent - the agent whose request failed.
   */
  const scheduleRevive = (agent) => {
    const session = agent?.session
    if (session === null || typeof session !== 'object') return
    if (revived.has(session)) return
    if (session.header?.meta?.origin === 'subagent') return
    revived.add(session)
    void revive(session, { reason: '上下文超限，已在新会话继续；原会话保留可查', kickoff: config.kickoff }).catch((error) => {
      log(ctx, 'warn', `revival failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // Manual trigger. Registered only when revival is enabled, so `off` really
  // means the plugin never creates a session.
  const installReviveTool = (tools) => {
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      log(ctx, 'warn', 'tools service is unavailable; revive_session was not registered')
      return
    }
    tools.register({
      name: 'revive_session',
      description:
        'Continue a session that can no longer send requests (context window exceeded) in a fresh session. '
        + 'Builds a handoff from the current session log, creates a new session in the same workspace, '
        + 'and sends that handoff as the new session\'s first message so it becomes a visible conversation. '
        + 'The original session is never modified. Each session can be continued once.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Short note explaining why the session is being continued.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            requests: { type: 'number' },
            conclusions: { type: 'number' },
          },
          required: ['sessionId', 'requests', 'conclusions'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{
            type: 'text',
            text: `Continued in session ${value.sessionId} (${value.requests} requests, ${value.conclusions} conclusions carried over).`,
          }]
        },
      },
      async execute(args, exec) {
        const session = exec?.agent?.session
        if (session === null || typeof session !== 'object') {
          throw new Error('revive_session: no current session to revive')
        }
        if (revived.has(session)) {
          throw new Error('revive_session: this session was already continued in a new one')
        }
        revived.add(session)
        let result
        try {
          result = await revive(session, { reason: args?.reason, kickoff: config.kickoff })
        } catch (error) {
          // A failed attempt must not consume the session's only continuation.
          revived.delete(session)
          throw error
        }
        return {
          sessionId: result.sessionId,
          requests: result.handoff.stats.requests,
          conclusions: result.handoff.stats.conclusions,
        }
      },
    })
  }

  if (config.revive !== 'off') {
    if (typeof ctx.inject === 'function') {
      // Waits for the tools service instead of reading a topology-sensitive
      // property proxy that is undefined without a declared injection.
      ctx.inject(['tools'], (scoped) => installReviveTool(scoped.tools))
    } else {
      installReviveTool(ctx.get('tools'))
    }
  }

  // Follow the handoff's anchors back into the session this one was continued
  // from. A handoff is a lossy excerpt; this is the retrieval half, and it only
  // reads the parent log.
  ctx.inject?.(['tools', 'sessions'], (scoped) => {
    if (typeof scoped.tools?.register !== 'function') return
    scoped.tools.register({
      name: 'recall_original',
      description:
        'Read part of the session this session was continued from, by log position. '
        + 'Use it to recover details a handoff excerpt left out. Only the parent session log is read; '
        + 'nothing is modified. Omit from/to to read from the start.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'number', description: 'First sequence number to include (inclusive).' },
          to: { type: 'number', description: 'Last sequence number to include (inclusive).' },
          anchor: { type: 'string', description: 'A handoff anchor such as "T3@seq42"; selects that one event when from/to are absent.' },
          limit: { type: 'number', description: 'Maximum events to return (1-200, default 50).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            parentSessionId: { type: 'string' },
            truncated: { type: 'boolean' },
            events: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  seq: { type: 'number' },
                  type: { type: 'string' },
                  text: { type: 'string' },
                },
                required: ['seq', 'type', 'text'],
                additionalProperties: false,
              },
            },
          },
          required: ['parentSessionId', 'truncated', 'events'],
          additionalProperties: false,
        },
        render(_args, value) {
          const head = `Recalled ${value.events.length} event(s) from ${value.parentSessionId}`
          const lines = value.events.map(event => `[seq ${event.seq}] ${event.type}: ${event.text}`)
          return [{ type: 'text', text: [head, ...lines].join('\n') }]
        },
      },
      async execute(args, exec) {
        const session = exec?.agent?.session
        const parentId = session?.header?.parentSession
        if (parentId === undefined || parentId === null || `${parentId}`.length === 0) {
          throw new Error('recall_original: this session was not continued from another session')
        }
        const parent = scoped.sessions?.get?.(parentId)
        if (parent === undefined || parent === null) {
          throw new Error(`recall_original: parent session ${String(parentId)} is not loaded in this process`)
        }
        const range = {
          from: Number.isSafeInteger(args?.from) ? args.from : undefined,
          to: Number.isSafeInteger(args?.to) ? args.to : undefined,
          limit: Number.isSafeInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 200) : 50,
        }
        if (typeof args?.anchor === 'string' && range.from === undefined && range.to === undefined) {
          const parsed = createService().parseAnchor(args.anchor)
          if (parsed !== undefined) {
            range.from = parsed.seq
            range.to = parsed.seq
          }
        }
        const slice = sliceEvents(
          typeof parent.snapshotEvents === 'function' ? parent.snapshotEvents() : [],
          range,
        )
        return { parentSessionId: String(parentId), truncated: slice.truncated, events: slice.events }
      },
    })
  })

  // Same reload, as a human entry: a `/reload` command lives in the composer's
  // slash menu, so it takes no layout space and cannot collide with any theme
  // or third-party UI. Commands are host-side; no client bundle is needed.
  ctx.inject?.(['commands', 'hmr'], (scoped) => {
    if (typeof scoped.commands?.register !== 'function') return
    if (typeof scoped.hmr?.runExclusive !== 'function') return
    scoped.commands.register({
      name: 'reload',
      description: '重载磁盘上改动过的插件（原地热更新，不重启 desktop）',
      handler: () => {
        setTimeout(() => {
          void scoped.hmr
            .runExclusive(() => scoped.hmr.reconcileProfile([]))
            .catch((error) => {
              log(ctx, 'warn', `plugin reload failed: ${error instanceof Error ? error.message : String(error)}`)
            })
        }, 100)
        return { kind: 'success', text: '已触发插件重载，稍等片刻生效。' }
      },
    })
  })

  // Development convenience: apply edited plugin code without restarting DSH.
  // This uses the official HMR reconciliation the plugin manager itself calls;
  // it never spawns, kills, or restarts the host process. The reload runs after
  // this call settles, because reconciling the profile disposes this very fiber.
  ctx.inject?.(['tools', 'hmr'], (scoped) => {
    if (typeof scoped.tools?.register !== 'function') return
    if (typeof scoped.hmr?.runExclusive !== 'function') return
    scoped.tools.register({
      name: 'reload_plugins',
      description:
        'Reload changed plugins in the current profile in place, using the harness plugin engine (HMR). '
        + 'Use this after editing plugin source so the change takes effect without restarting the application. '
        + 'Returns immediately; the reload runs just after this call settles.',
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Entry ids that must end up active; empty reloads every changed entry.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            scheduled: { type: 'boolean' },
            ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['scheduled', 'ids'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{
            type: 'text',
            text: value.ids.length === 0
              ? 'Reload scheduled for every changed plugin entry.'
              : `Reload scheduled for ${value.ids.join(', ')}.`,
          }]
        },
      },
      execute(args) {
        const ids = Array.isArray(args?.ids) ? args.ids.filter(id => typeof id === 'string') : []
        setTimeout(() => {
          void scoped.hmr
            .runExclusive(() => scoped.hmr.reconcileProfile(ids))
            .catch((error) => {
              log(ctx, 'warn', `plugin reload failed: ${error instanceof Error ? error.message : String(error)}`)
            })
        }, 100)
        return { scheduled: true, ids }
      },
    })
  })

  ctx.on('agent/request-error', async (payload, next) => {
    // Delegate first: earlier and later policy layers keep their say, and a
    // failure someone else already recovered is not retried twice.
    const downstream = await next()
    if (downstream !== undefined) return downstream

    const { agent, failure, signal } = /** @type {any} */ (payload ?? {})
    // Agents are WeakMap keys and compaction requires a cancellation signal;
    // a payload missing either is not something this plugin can act on.
    if (agent === null || typeof agent !== 'object') return undefined
    if (signal === undefined || signal === null) return undefined
    if (signal.aborted === true) return undefined

    const used = attempts.get(agent) ?? 0
    const decision = decideRecovery({
      failure,
      attempts: used,
      maxAttempts: config.maxAttempts,
      compactionAvailable: typeof ctx.get('compaction') !== 'undefined',
    })
    if (decision.attempt === false) {
      if (decision.reason === 'no-compaction' && used === 0) {
        log(ctx, 'warn', 'context overflow detected but no compaction backend is loaded')
      }
      // Retrying cannot help this turn; in auto mode, continue elsewhere.
      if (config.revive === 'auto' && decision.reason !== 'not-overflow' && used > 0) {
        scheduleRevive(agent)
      }
      return undefined
    }

    const compaction = ctx.get('compaction')
    if (compaction === undefined) return undefined

    attempts.set(agent, used + 1)
    try {
      const compacted = await compaction.compactIfNeeded(agent, 'context-overflow', signal)
      return recoveryAction(compacted)
    } catch (error) {
      log(ctx, 'warn', `forced compaction failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  })
}
