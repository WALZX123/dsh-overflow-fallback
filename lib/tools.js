/**
 * Model-facing tools and the human `/reload` command.
 *
 * Each registration function takes only the services it uses, so the plugin's
 * `apply` stays a thin assembly layer and these definitions can be reviewed
 * independently of the request-error policy.
 *
 * @module dsh-overflow-fallback/tools
 */

import { createService, sliceEvents } from './service.js'

/** Upper bound accepted from a model for one recall call. */
const RECALL_HARD_LIMIT = 200

/**
 * Build an Error carrying a stable machine-readable code.
 *
 * @param {string} code - stable failure identifier consumers may switch on.
 * @param {string} message - human-readable diagnostic.
 * @returns {Error & { code: string }} the error.
 */
export function toolError(code, message) {
  const error = /** @type {Error & { code: string }} */ (new Error(message))
  error.code = code
  return error
}

/**
 * Register `revive_session`.
 *
 * @param {object} deps - registration dependencies.
 * @param {{ register: (definition: object) => unknown }} [deps.tools] - the tools service.
 * @param {(session: import('./revive.js').SessionLike, options?: object) => Promise<import('./revive.js').ReviveResult>} deps.revive - revival runner.
 * @param {WeakSet<object>} deps.revived - sessions already continued by this instance.
 * @param {{ kickoff: boolean }} deps.config - resolved configuration.
 * @param {(level: string, message: string) => void} [deps.log] - diagnostic sink.
 */
export function registerReviveTool({ tools, revive, revived, config, log }) {
  if (tools === undefined || tools === null || typeof tools.register !== 'function') {
    log?.('warn', 'tools service is unavailable; revive_session was not registered')
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
      render(/** @type {unknown} */ _args, /** @type {any} */ value) {
        return [{
          type: 'text',
          text: `Continued in session ${value.sessionId} (${value.requests} requests, ${value.conclusions} conclusions carried over).`,
        }]
      },
    },
    async execute(/** @type {any} */ args, /** @type {any} */ exec) {
      const session = exec?.agent?.session
      if (session === null || typeof session !== 'object') {
        throw toolError('no-session', 'revive_session: no current session to revive')
      }
      if (revived.has(session)) {
        throw toolError('already-revived', 'revive_session: this session was already continued in a new one')
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

/**
 * Register `recall_original`.
 *
 * @param {object} deps - registration dependencies.
 * @param {{ register: (definition: object) => unknown }} [deps.tools] - the tools service.
 * @param {{ get: (id: unknown) => { snapshotEvents?: () => readonly unknown[] } | undefined }} [deps.sessions] - session store.
 * @param {{ recallLimit: number }} deps.config - resolved configuration.
 * @param {(id: unknown) => Promise<readonly unknown[] | undefined>} [deps.coldReader] - reads a session that is not loaded.
 */
export function registerRecallTool({ tools, sessions, config, coldReader }) {
  if (typeof tools?.register !== 'function') return
  tools.register({
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
        limit: { type: 'number', description: `Maximum events to return (1-${RECALL_HARD_LIMIT}, default ${config.recallLimit}).` },
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
      render(/** @type {unknown} */ _args, /** @type {any} */ value) {
        const head = `Recalled ${value.events.length} event(s) from ${value.parentSessionId}`
        const lines = value.events.map((/** @type {any} */ event) => `[seq ${event.seq}] ${event.type}: ${event.text}`)
        return [{ type: 'text', text: [head, ...lines].join('\n') }]
      },
    },
    async execute(/** @type {any} */ args, /** @type {any} */ exec) {
      const session = exec?.agent?.session
      const parentId = session?.header?.parentSession
      if (parentId === undefined || parentId === null || `${parentId}`.length === 0) {
        throw toolError('no-parent', 'recall_original: this session was not continued from another session')
      }
      const parent = /** @type {{ snapshotEvents?: () => readonly unknown[] } | undefined} */ (sessions?.get?.(parentId))
      // A parent that is still loaded reads from memory; after a restart it is
      // cold, so fall back to the query service's durable reader.
      let events
      if (parent !== undefined && parent !== null && typeof parent.snapshotEvents === 'function') {
        events = parent.snapshotEvents()
      } else if (typeof coldReader === 'function') {
        events = await coldReader(parentId)
      }
      if (events === undefined || events === null) {
        throw toolError(
          'parent-not-loaded',
          `recall_original: parent session ${String(parentId)} is not loaded and could not be read from storage`,
        )
      }
      const range = {
        from: Number.isSafeInteger(args?.from) ? args.from : undefined,
        to: Number.isSafeInteger(args?.to) ? args.to : undefined,
        limit: Number.isSafeInteger(args?.limit)
          ? Math.min(Math.max(args.limit, 1), RECALL_HARD_LIMIT)
          : config.recallLimit,
      }
      if (typeof args?.anchor === 'string' && range.from === undefined && range.to === undefined) {
        const parsed = /** @type {{ parseAnchor: (text: string) => { turn: number, seq: number } | undefined }} */ (createService()).parseAnchor(args.anchor)
        if (parsed !== undefined) {
          range.from = parsed.seq
          range.to = parsed.seq
        }
      }
      const slice = sliceEvents(events, range)
      return { parentSessionId: String(parentId), truncated: slice.truncated, events: slice.events }
    },
  })
}

/**
 * Schedule one HMR reconciliation after the current call settles.
 *
 * @param {{ runExclusive: Function, reconcileProfile: Function }} hmr - the HMR service.
 * @param {readonly string[]} ids - entry ids that must end up active.
 * @param {(level: string, message: string) => void} [log] - diagnostic sink.
 */
export function scheduleReload(hmr, ids, log) {
  setTimeout(() => {
    void hmr
      .runExclusive(() => hmr.reconcileProfile(ids))
      .catch((/** @type {unknown} */ error) => {
        log?.('warn', `plugin reload failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }, 100)
}

/**
 * Register the `reload_plugins` tool.
 *
 * @param {object} deps - registration dependencies.
 * @param {{ register: (definition: object) => unknown }} [deps.tools] - the tools service.
 * @param {{ runExclusive: Function, reconcileProfile: Function }} [deps.hmr] - the HMR service.
 * @param {(level: string, message: string) => void} [deps.log] - diagnostic sink.
 */
export function registerReloadTool({ tools, hmr, log }) {
  if (typeof tools?.register !== 'function') return
  if (typeof hmr?.runExclusive !== 'function') return
  tools.register({
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
      render(/** @type {unknown} */ _args, /** @type {any} */ value) {
        return [{
          type: 'text',
          text: value.ids.length === 0
            ? 'Reload scheduled for every changed plugin entry.'
            : `Reload scheduled for ${value.ids.join(', ')}.`,
        }]
      },
    },
    execute(/** @type {any} */ args) {
      const ids = Array.isArray(args?.ids) ? args.ids.filter((/** @type {unknown} */ id) => typeof id === 'string') : []
      scheduleReload(hmr, ids, log)
      return { scheduled: true, ids }
    },
  })
}

/**
 * Register the `/reload` command.
 *
 * A command lives in the composer's slash menu, so it takes no layout space and
 * cannot collide with a theme or a third-party UI. Commands are host-side; no
 * client bundle is needed.
 *
 * @param {object} deps - registration dependencies.
 * @param {{ register: (definition: object) => unknown }} [deps.commands] - the command registry.
 * @param {{ runExclusive: Function, reconcileProfile: Function }} [deps.hmr] - the HMR service.
 * @param {(level: string, message: string) => void} [deps.log] - diagnostic sink.
 */
export function registerReloadCommand({ commands, hmr, log }) {
  if (typeof commands?.register !== 'function') return
  if (typeof hmr?.runExclusive !== 'function') return
  commands.register({
    name: 'reload',
    description: 'Reload changed plugins in this profile in place (hot update, no application restart)',
    handler: () => {
      scheduleReload(hmr, [], log)
      return { kind: 'success', text: 'Reload scheduled; it takes effect in a moment.' }
    },
  })
}
