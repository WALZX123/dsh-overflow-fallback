/**
 * Pure decision core for dsh-overflow-fallback.
 *
 * No I/O, no clock, no randomness: every function here is a pure function of
 * its arguments so it can be replayed in tests and reasoned about in isolation
 * from the Cordis plugin that uses it.
 *
 * @module dsh-overflow-fallback/decide
 */

/** Stable failure code the harness reports when the prompt exceeds the window. */
export const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'

/**
 * Read the provider failure code from a request error payload.
 *
 * The harness reports `failure` as an `LlmFailure`; its code may sit on the
 * failure itself or on a nested `error`. Anything else is treated as unknown so
 * the plugin never claims an overflow it cannot identify.
 *
 * @param {unknown} failure - the `failure` field of an `agent/request-error` payload.
 * @returns {string | undefined} the failure code when it is a non-empty string.
 */
export function failureCode(failure) {
  if (failure === null || typeof failure !== 'object') return undefined
  const direct = /** @type {{ code?: unknown }} */ (failure).code
  if (typeof direct === 'string' && direct.length > 0) return direct
  const nested = /** @type {{ error?: unknown }} */ (failure).error
  if (nested !== null && typeof nested === 'object') {
    const code = /** @type {{ code?: unknown }} */ (nested).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return undefined
}

/**
 * Decide whether this plugin should attempt a recovery for one failed request.
 *
 * @param {object} input - decision inputs.
 * @param {unknown} input.failure - the `failure` field of the event payload.
 * @param {number} input.attempts - recovery attempts already made for this agent.
 * @param {number} input.maxAttempts - configured ceiling; `0` disables recovery.
 * @param {boolean} input.compactionAvailable - whether a compaction backend is loaded.
 * @returns {{ attempt: true } | { attempt: false, reason: 'not-overflow' | 'exhausted' | 'no-compaction' }}
 *   `attempt: true` means the caller should run one forced compaction and retry.
 */
export function decideRecovery({ failure, attempts, maxAttempts, compactionAvailable }) {
  if (failureCode(failure) !== CONTEXT_WINDOW_EXCEEDED) return { attempt: false, reason: 'not-overflow' }
  if (!Number.isSafeInteger(attempts) || attempts < 0) return { attempt: false, reason: 'exhausted' }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) return { attempt: false, reason: 'exhausted' }
  if (attempts >= maxAttempts) return { attempt: false, reason: 'exhausted' }
  if (!compactionAvailable) return { attempt: false, reason: 'no-compaction' }
  return { attempt: true }
}

/**
 * Map one recovery attempt to the waterfall value the agent loop expects.
 *
 * @param {object | null | undefined} compacted - the `compactIfNeeded` result.
 * @returns {{ kind: 'retry' } | undefined} retry when compaction made progress.
 */
export function recoveryAction(compacted) {
  return compacted === null || compacted === undefined ? undefined : { kind: 'retry' }
}
