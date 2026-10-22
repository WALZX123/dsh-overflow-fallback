/**
 * Public integration surface for dsh-overflow-fallback.
 *
 * Other plugins reach this contract through Cordis DI:
 *
 * ```js
 * export const inject = ['overflowFallback']
 * export function apply(ctx) {
 *   const { markdown } = ctx.overflowFallback.handoffFor(session, { reason: '手动交接' })
 * }
 * ```
 *
 * The service is a plain object (no class, no dependency on the Cordis
 * package) so the plugin stays installable with zero runtime dependencies.
 * Its methods are pure reads: they never mutate a session and never create one.
 *
 * @module dsh-overflow-fallback/service
 */

import { CONTEXT_WINDOW_EXCEEDED, failureCode } from './decide.js'
import { buildHandoff, excerpt, messageText } from './handoff.js'

/** Cordis service name other plugins inject. */
export const SERVICE_NAME = 'overflowFallback'

/** Bumped only on a breaking change to this object's members. */
export const CONTRACT_VERSION = 1

/**
 * Minimal Session surface this plugin reads.
 * @typedef {object} SessionLike
 * @property {unknown} [id]
 * @property {{ title?: string, cwd?: string }} [header]
 * @property {() => readonly unknown[]} [snapshotEvents]
 */

/**
 * Build the integration object.
 *
 * @param {object} [options] - optional dependencies.
 * @param {(session: object, opts?: object) => Promise<object>} [options.reviveRunner] - revival executor.
 * @returns {object} the service value.
 */
export function createService({ reviveRunner } = {}) {
  return {
    contractVersion: CONTRACT_VERSION,

    /**
     * Whether a request failure is the context-window overflow this plugin exists for.
     * @param {unknown} failure - an `agent/request-error` payload's `failure` field.
     * @returns true when the failure code is `CONTEXT_WINDOW_EXCEEDED`.
     */
    isOverflowFailure(failure) {
      return failureCode(failure) === CONTEXT_WINDOW_EXCEEDED
    },

    /**
     * Render a handoff from an explicit event list.
     * @param {{ events: readonly unknown[], title?: string, sessionId?: string, reason?: string }} input - `{ events, title?, sessionId?, reason? }`.
     * @returns the bounded Markdown document and what it kept.
     */
    buildHandoff(input) {
      if (input === null || typeof input !== 'object') {
        throw new TypeError('overflowFallback.buildHandoff: input object is required')
      }
      return buildHandoff(input)
    },

    /**
     * Render a handoff for one live session.
     * @param {SessionLike} session - a Session-like object exposing `id`, `header` and `snapshotEvents()`.
     * @param {{ title?: string, sessionId?: string, reason?: string }} [options] - optional `{ title?, sessionId?, reason? }` overrides.
     * @returns the bounded Markdown document and what it kept.
     */
    handoffFor(session, options = {}) {
      if (session === null || typeof session !== 'object') {
        throw new TypeError('overflowFallback.handoffFor: session is required')
      }
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      const header = session.header ?? {}
      return buildHandoff({
        events,
        title: options.title ?? header.title,
        sessionId: options.sessionId ?? (typeof session.id === 'string' ? session.id : undefined),
        reason: options.reason,
      })
    },

    /**
     * Render the stable anchor for one position in a session.
     * @param {number} turn - the turn number carried by the event.
     * @param {number} seq - the event's log sequence number.
     * @returns the anchor, e.g. `T3@seq42`.
     */
    anchor(turn, seq) {
      if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(seq)) {
        throw new TypeError('overflowFallback.anchor: turn and seq must be safe integers')
      }
      return `T${turn}@seq${seq}`
    },

    /**
     * Parse an anchor produced by {@link anchor}.
     * @param {string} text - anchor text, possibly embedded in a longer line.
     * @returns the parsed position, or `undefined` when the text holds no anchor.
     */
    parseAnchor(text) {
      if (typeof text !== 'string') return undefined
      const match = /T(\d+)@seq(-?\d+)/.exec(text)
      if (match === null) return undefined
      const turn = Number(match[1])
      const seq = Number(match[2])
      if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(seq)) return undefined
      return { turn, seq }
    },

    /**
     * Read a slice of a session log by sequence number.
     *
     * This is the retrieval half of the handoff: a handoff is lossy, so a
     * consumer follows its anchors back here for the exact wording.
     *
     * @param {SessionLike} session - a Session-like object exposing `snapshotEvents()`.
     * @param {{ from?: number, to?: number, limit?: number }} [range] - inclusive `{ from, to }` sequence bounds.
     * @returns {{ events: Array<{ seq: number, type: string, text: string }>, truncated: boolean }}
     *   the matching events in log order.
     */
    recall(session, range = {}) {
      if (session === null || typeof session !== 'object') {
        throw new TypeError('overflowFallback.recall: session is required')
      }
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      return sliceEvents(events, range)
    },

    /**
     * Revive a session into a fresh one that continues with a handoff.
     *
     * @param {SessionLike} session - the session to revive.
     * @param {object} [options] - optional `{ reason, title }`.
     * @returns the new session id, the handoff, and the new agent.
     */
    async reviveFor(session, options = {}) {
      if (typeof reviveRunner !== 'function') {
        throw new Error('overflowFallback.reviveFor: no revival runner configured')
      }
      return reviveRunner(session, options)
    },
  }
}

/**
 * Default number of events one retrieval returns.
 */
export const DEFAULT_RECALL_LIMIT = 200

/**
 * Read a slice of an event list by sequence number.
 *
 * Shared by the service contract and the `recall_original` tool so both see
 * exactly the same ordering, filtering, and text projection.
 *
 * @param {readonly unknown[]} events - session events in log order.
 * @param {{ from?: number, to?: number, limit?: number }} [range] - inclusive bounds and a result cap.
 * @returns {{ events: Array<{ seq: number, type: string, text: string }>, truncated: boolean }}
 *   the matching events.
 */
export function sliceEvents(events, range = {}) {
  const from = typeof range.from === 'number' && Number.isSafeInteger(range.from) ? range.from : -Infinity
  const to = typeof range.to === 'number' && Number.isSafeInteger(range.to) ? range.to : Infinity
  const limit = typeof range.limit === 'number' && Number.isSafeInteger(range.limit) && range.limit > 0
    ? range.limit
    : DEFAULT_RECALL_LIMIT
  const matched = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue
    const record = /** @type {{ seq?: unknown, type?: unknown }} */ (event)
    const seq = record.seq
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) continue
    if (seq < from || seq > to) continue
    matched.push({
      seq,
      type: typeof record.type === 'string' ? record.type : 'unknown',
      text: eventText(event),
    })
  }
  return {
    events: matched.slice(0, limit),
    truncated: matched.length > limit,
  }
}

/**
 * Best-effort plain text of one event payload.
 *
 * @param {object} event - one session event.
 * @returns {string} the message text, or the serialized payload.
 */
function eventText(event) {
  const data = /** @type {{ data?: unknown }} */ (event).data
  if (data === null || typeof data !== 'object') return ''
  const message = /** @type {{ message?: unknown }} */ (data).message
  const text = messageText(message)
  if (text.length > 0) return excerpt(text, 400)
  try {
    return excerpt(JSON.stringify(data), 400)
  } catch {
    // Cyclic or non-serializable payloads are not retrieval failures worth throwing over.
    return ''
  }
}
