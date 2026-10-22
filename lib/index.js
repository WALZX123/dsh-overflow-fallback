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
import { SERVICE_NAME, createService } from './service.js'
import {
  registerRecallTool,
  registerReloadCommand,
  registerReloadTool,
  registerReviveTool,
} from './tools.js'

/** Plugin name used by the Cordis loader. */
export const name = 'dsh-overflow-fallback'


/**
 * Minimal Cordis context surface this plugin uses.
 *
 * @typedef {object} PluginContext
 * @property {(event: string, listener: (...args: any[]) => unknown, options?: object) => () => void} on
 * @property {(name: string) => any} get
 * @property {(name: string, value: unknown) => (() => void)} [provide]
 * @property {(deps: readonly string[], callback: (scoped: any) => void) => void} [inject]
 * @property {(...args: any[]) => any} [logger]
 */
/** No required services: compaction is an optional capability read through ctx.get. */
export const inject = /** @type {readonly string[]} */ ([])

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
  // Default number of events one recall call returns.
  recallLimit: 50,
})

/** Fields accepted from the loader entry's `config` block. */
const CONFIG_KEYS = new Set(['enabled', 'maxAttempts', 'revive', 'kickoff', 'recallLimit'])

/**
 * Validate the loader entry's `config` block.
 *
 * Misconfiguration fails at load instead of degrading silently: unknown keys
 * and wrong types throw a `TypeError` naming the offending field.
 *
 * @param {unknown} raw - the `config` value handed to the plugin.
  * @returns {{ enabled: boolean, maxAttempts: number, revive: 'off' | 'manual' | 'auto', kickoff: boolean, recallLimit: number }} the resolved configuration.
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
  const recallLimit = value.recallLimit ?? DEFAULTS.recallLimit
  if (!Number.isSafeInteger(recallLimit) || /** @type {number} */ (recallLimit) < 1 || /** @type {number} */ (recallLimit) > 200) {
    throw new TypeError('dsh-overflow-fallback: config.recallLimit must be an integer between 1 and 200')
  }
  return { enabled, maxAttempts: /** @type {number} */ (maxAttempts), revive, kickoff, recallLimit: /** @type {number} */ (recallLimit) }
}

/**
 * Emit one line without depending on a specific logger service.
 *
 * @param {PluginContext} ctx - the plugin context.
  * @param {string} level - severity.
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
 * @param {PluginContext} ctx - Cordis plugin context.
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
      const ownsSource = (/** @type {any} */ workspace) => {
        const ids = workspace?.sessionIds
        return Array.isArray(ids) && ids.includes(sourceSessionId)
      }
      // Prefer the workspace that owns the source session; fall back to the one
      // whose path is the revived session's cwd, since a session created outside
      // the UI may predate the list it should join.
      const owner = workspaces.find(ownsSource)
        ?? (cwd === undefined ? undefined : workspaces.find((/** @type {any} */ workspace) => workspace?.path === cwd))
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
   * @param {{ session?: { header?: { meta?: { origin?: string } } } }} agent - the agent whose request failed.
   */
  const scheduleRevive = (agent) => {
    const session = /** @type {any} */ (agent?.session)
    if (session === null || typeof session !== 'object') return
    if (revived.has(session)) return
    if (session.header?.meta?.origin === 'subagent') return
    revived.add(session)
    void revive(session, { reason: '上下文超限，已在新会话继续；原会话保留可查', kickoff: config.kickoff }).catch((error) => {
      log(ctx, 'warn', `revival failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  if (config.revive !== 'off') {
    ctx.inject?.(['tools'], (scoped) => registerReviveTool({
      tools: scoped.tools,
      revive,
      revived,
      config,
      log: (level, message) => log(ctx, level, message),
    }))
  }

  ctx.inject?.(['tools', 'sessions'], (scoped) => registerRecallTool({
    tools: scoped.tools,
    sessions: scoped.sessions,
    config,
    // After a restart the parent session is cold; the query service reads its
    // durable log without mounting it as a live session.
    coldReader: async (id) => {
      const query = ctx.get('sessionQuery')
      if (query === undefined || typeof query.observeSession !== 'function') return undefined
      const observation = await query.observeSession(id, { projectionMode: 'none' })
      try {
        return [...observation.events]
      } finally {
        try {
          observation.dispose?.()
        } catch (error) {
          log(ctx, 'warn', `recall_original: observation dispose failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    },
  }))

  ctx.inject?.(['commands', 'hmr'], (scoped) => registerReloadCommand({
    commands: scoped.commands,
    hmr: scoped.hmr,
    log: (level, message) => log(ctx, level, message),
  }))

  ctx.inject?.(['tools', 'hmr'], (scoped) => registerReloadTool({
    tools: scoped.tools,
    hmr: scoped.hmr,
    log: (level, message) => log(ctx, level, message),
  }))

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
