/**
 * Session revival: turn a dead session into a fresh one that continues the work.
 *
 * The original session is only ever read. Revival creates a brand-new agent
 * (same working directory, same provider/model when known), then injects the
 * handoff as durable model-visible context. Nothing is deleted, moved, or
 * rewritten.
 *
 * @module dsh-overflow-fallback/revive
 */

import { buildHandoff } from './handoff.js'

/** How revival is triggered. */
export const REVIVE_MODES = Object.freeze(['off', 'manual', 'auto'])

/**
 * Validate the `revive` config value.
 *
 * @param {unknown} value - raw config value.
 * @returns {'off' | 'manual' | 'auto'} the accepted mode.
 */
export function normalizeReviveMode(value) {
  if (value === undefined) return 'off'
  if (typeof value !== 'string' || !REVIVE_MODES.includes(value)) {
    throw new TypeError(`dsh-overflow-fallback: config.revive must be one of ${REVIVE_MODES.join(', ')}`)
  }
  return /** @type {'off' | 'manual' | 'auto'} */ (value)
}

/**
 * Read the routing selection recorded on the session's newest request.
 *
 * @param {object} session - Session-like object.
 * @returns {{ provider?: string, model?: string }} the routed target, when known.
 */
export function routedTarget(session) {
  if (typeof session.requestHeader !== 'function') return {}
  const header = session.requestHeader()
  const config = header?.config
  if (config === null || typeof config !== 'object') return {}
  const { provider, model } = /** @type {{ provider?: unknown, model?: unknown }} */ (config)
  if (typeof provider !== 'string' || provider.length === 0) return {}
  if (typeof model !== 'string' || model.length === 0) return {}
  return { provider, model }
}

/**
 * Read the working directory recorded on the session header.
 *
 * The durable header carries `cwd` at its top level; `meta.cwd` is accepted as
 * a fallback for older rows that nested it.
 *
 * @param {object} session - Session-like object.
 * @returns {string | undefined} the absolute cwd, when recorded.
 */
export function sessionCwd(session) {
  const header = session.header
  if (header === null || typeof header !== 'object') return undefined
  const direct = /** @type {{ cwd?: unknown }} */ (header).cwd
  if (typeof direct === 'string' && direct.length > 0) return direct
  const meta = /** @type {{ meta?: unknown }} */ (header).meta
  if (meta === null || typeof meta !== 'object') return undefined
  const nested = /** @type {{ cwd?: unknown }} */ (meta).cwd
  return typeof nested === 'string' && nested.length > 0 ? nested : undefined
}

/**
 * Build the revival request for one session, without creating anything.
 *
 * Pure: useful for previews, dry runs and tests.
 *
 * @param {object} input - planning inputs.
 * @param {object} input.session - Session-like object.
 * @param {string} [input.reason] - why the handoff exists.
 * @param {string} [input.title] - title override.
 * @returns {{ handoff: { markdown: string, stats: object }, create: object }} the handoff and the `agents.create` options.
 */
export function planRevive({ session, reason, title }) {
  const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  const header = session.header !== null && typeof session.header === 'object' ? session.header : {}
  const handoff = buildHandoff({
    events,
    title: title ?? header.title,
    sessionId: session.id,
    reason,
  })
  const cwd = sessionCwd(session)
  const target = routedTarget(session)
  const meta = {
    ...(cwd === undefined ? {} : { cwd }),
    parentSession: session.id,
  }
  return {
    handoff,
    create: {
      meta,
      ...(target.provider === undefined
        ? {}
        : { agentOptions: { provider: target.provider, model: target.model } }),
    },
  }
}

/**
 * Create a runner that performs one revival.
 *
 * The runner only touches the public `ctx.agents.create()` API and
 * `agent.inject()`. A failed creation disposes the handle and rethrows, so a
 * half-built agent never stays registered.
 *
 * @param {object} options - runner dependencies.
 * @param {{ create: Function } | (() => { create: Function } | undefined)} [options.agents] - the `ctx.agents` registry, or a getter for it.
 * @param {() => string} [options.newId] - session id factory.
 * @param {(level: string, message: string) => void} [options.log] - diagnostic sink.
 * @param {(sourceSessionId: string, newSessionId: string, cwd?: string) => Promise<void>} [options.attach] - registers the new session with the owning workspace so the UI lists it.
 * @returns {(session: object, options?: { reason?: string, title?: string }) => Promise<{
 *   sessionId: string,
 *   handoff: { markdown: string, stats: object },
 *   agent: object,
 * }>} the runner.
 */
export function createReviveRunner({ agents, newId, log, attach } = {}) {
  const mint = newId ?? (() => `revive-${globalThis.crypto.randomUUID()}`)
  const say = log ?? (() => {})
  const bind = typeof attach === 'function' ? attach : async () => {}
  const registry = typeof agents === 'function' ? agents : () => agents

  return async function revive(session, options = {}) {
    const resolved = registry()
    if (resolved === undefined || typeof resolved.create !== 'function') {
      throw new Error('dsh-overflow-fallback: agents service is not available')
    }
    if (session === null || typeof session !== 'object') {
      throw new TypeError('dsh-overflow-fallback: session is required to revive')
    }

    const plan = planRevive({ session, reason: options.reason, title: options.title })
    const sessionId = mint()

    let handle
    try {
      handle = await resolved.create({
        sessionId,
        ...plan.create,
      })
    } catch (error) {
      say('warn', `revival failed for session ${String(session.id)}: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }

    const message = {
      content: [{ type: 'text', text: plan.handoff.markdown }],
      source: { kind: 'overflow-fallback' },
    }

    try {
      // A queued `inject` alone leaves the session empty and invisible in the
      // session list. Starting the first turn persists the handoff and makes the
      // revived session a real conversation; `inject` remains the fallback.
      if (options.kickoff === true && typeof handle.agent.followup === 'function') {
        try {
          handle.agent.followup(message)
        } catch {
          // Some compositions reject a hand-built follow-up; context injection
          // still delivers the handoff without starting a turn.
          handle.agent.inject(message)
        }
      } else {
        handle.agent.inject(message)
      }
    } catch (error) {
      try {
        await handle.dispose()
      } catch (disposeError) {
        say('warn', `revival cleanup failed: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}`)
      }
      say('warn', `handoff delivery failed: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }

    try {
      await bind(session.id, sessionId, plan.create.meta.cwd)
    } catch (error) {
      // The session exists and is usable; a failed attachment only hides it from
      // the workspace list, which is not a reason to lose the revived context.
      say('warn', `workspace attach failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }

    return { sessionId, handoff: plan.handoff, agent: handle.agent }
  }
}
