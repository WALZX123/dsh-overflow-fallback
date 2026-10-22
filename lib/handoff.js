/**
 * Handoff builder for session revival.
 *
 * When a session can no longer send any request (the prompt permanently
 * exceeds the model window), the user still owns everything that was said in
 * it. This module turns the session's own event log into one bounded Markdown
 * "handoff" document that a fresh session can start from.
 *
 * It is deliberately pure and offline:
 *
 * - no model call — the digest is derived from what is already in the log;
 * - no I/O — callers decide where the text goes;
 * - bounded output — a handoff never grows with the session;
 * - never destructive — the original session is only read.
 *
 * @module dsh-overflow-fallback/handoff
 */

/** Hard ceiling for one handoff document, in characters. */
export const MAX_HANDOFF_CHARS = 6000

/** Per-section ceiling for quoted material. */
const MAX_QUOTE_CHARS = 320

/** How many user requests to keep. */
const MAX_REQUESTS = 8

/** How many assistant conclusions to keep. */
const MAX_CONCLUSIONS = 3

/** How many touched files to list. */
const MAX_FILES = 30

/**
 * Flatten a message value into plain text.
 *
 * Session messages are either a string or a list of typed blocks. Unknown
 * shapes yield an empty string rather than throwing: a handoff must never fail
 * because one historical event looks odd.
 *
 * @param {unknown} message - the `message` field of a session event.
 * @returns {string} the concatenated text content.
 */
export function messageText(message) {
  if (typeof message === 'string') return message
  if (Array.isArray(message)) {
    const parts = []
    for (const block of message) {
      if (typeof block === 'string') {
        parts.push(block)
        continue
      }
      if (block === null || typeof block !== 'object') continue
      const typed = /** @type {{ type?: unknown, text?: unknown }} */ (block)
      // Only prose blocks belong in a handoff. Reasoning blocks also carry
      // `text`, and copying them would leak chain-of-thought and inflate the
      // document for no continuation value.
      if (typed.type !== undefined && typed.type !== 'text') continue
      if (typeof typed.text === 'string') parts.push(typed.text)
    }
    return parts.join('\n')
  }
  if (message !== null && typeof message === 'object') {
    const text = /** @type {{ text?: unknown }} */ (message).text
    if (typeof text === 'string') return text
  }
  return ''
}

/**
 * Collapse whitespace and clip one quoted line.
 *
 * @param {string} text - raw text.
 * @param {number} [limit] - maximum characters.
 * @returns {string} a single-line excerpt.
 */
export function excerpt(text, limit = MAX_QUOTE_CHARS) {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit - 1)}…`
}

/**
 * Read a `data` payload without assuming its shape.
 *
 * @param {unknown} event - one session event.
 * @returns {Record<string, unknown>} the payload, or an empty object.
 */
function payloadOf(event) {
  if (event === null || typeof event !== 'object') return {}
  const data = /** @type {{ data?: unknown }} */ (event).data
  return data !== null && typeof data === 'object' ? /** @type {Record<string, unknown>} */ (data) : {}
}

/**
 * Whether one `user/message` event came from the human rather than an
 * injection. Unlabelled events are treated as human input.
 *
 * @param {Record<string, unknown>} data - the event payload.
 * @returns {boolean} true for a human prompt.
 */
function isHumanPrompt(data) {
  const source = data.source
  if (source === null || typeof source !== 'object') return true
  const kind = /** @type {{ kind?: unknown }} */ (source).kind
  return kind === undefined || kind === 'user'
}

/**
 * Read the text of one `user/message` payload.
 *
 * Such an event carries the `UserMessage` itself (`{ content, source }`), not a
 * wrapper with a `message` field. The wrapper form is still accepted so a log
 * produced by another producer does not lose its text.
 *
 * @param {Record<string, unknown>} data - the event payload.
 * @returns {string} the concatenated text content.
 */
function userText(data) {
  if (data.content !== undefined) return messageText(data.content)
  return messageText(data.message)
}

/**
 * Read the text of one `assistant/message` payload.
 *
 * That event wraps an `AssistantMessage` in `message`; the prose lives in its
 * `content` blocks, never in a `text` field on the wrapper.
 *
 * @param {Record<string, unknown>} data - the event payload.
 * @returns {string} the concatenated text content.
 */
function assistantText(data) {
  const message = data.message
  if (message !== null && typeof message === 'object') {
    const content = /** @type {{ content?: unknown }} */ (message).content
    if (content !== undefined) return messageText(content)
    return messageText(message)
  }
  return messageText(message)
}

/**
 * Extract file paths mentioned by tool calls.
 *
 * @param {unknown} event - one session event.
 * @returns {string[]} paths named by `path` / `file_path` / `filePath` / `notebook_path`.
 */
function pathsOf(event) {
  const data = payloadOf(event)
  const raw = data.arguments
  if (typeof raw !== 'string') return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Tool arguments are model output; malformed JSON is expected and simply not indexed.
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const record = /** @type {Record<string, unknown>} */ (parsed)
  const found = []
  for (const key of ['path', 'file_path', 'filePath', 'notebook_path']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) found.push(value)
  }
  return found
}

/**
 * Build one bounded Markdown handoff from a session's event log.
 *
 * @param {object} input - builder inputs.
 * @param {readonly unknown[]} input.events - the session's events in order.
 * @param {string} [input.title] - the original session's title, when known.
 * @param {string} [input.sessionId] - the original session's id, so the new session can point back.
 * @param {string} [input.reason] - why the handoff exists (shown to the user).
 * @returns {{ markdown: string, stats: { requests: number, conclusions: number, files: number, tools: number, turns: number } }}
 *   the handoff document and what it kept.
 */
export function buildHandoff({ events, title, sessionId, reason }) {
  const requests = []
  const conclusions = []
  const files = new Set()
  const tools = new Map()
  const turns = new Map()

  let turnCounter = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue
    const type = /** @type {{ type?: unknown }} */ (event).type
    const data = payloadOf(event)

    if (type === 'user/message' && isHumanPrompt(data)) {
      turnCounter += 1
      const text = excerpt(userText(data))
      if (text.length > 0) requests.push(text)
      const seq = /** @type {{ seq?: unknown }} */ (event).seq
      turns.set(turnCounter, { seq: typeof seq === 'number' ? seq : -1 })
      continue
    }
    if (type === 'assistant/message') {
      const text = excerpt(assistantText(data))
      if (text.length > 0) conclusions.push(text)
      continue
    }
    if (type === 'tool/call') {
      const name = data.name
      if (typeof name === 'string' && name.length > 0) {
        tools.set(name, (tools.get(name) ?? 0) + 1)
      }
      for (const path of pathsOf(event)) files.add(path)
    }
  }

  const keptRequests = requests.slice(-MAX_REQUESTS)
  const keptConclusions = conclusions.slice(-MAX_CONCLUSIONS)
  const keptFiles = [...files].slice(0, MAX_FILES)
  const toolSummary = [...tools.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => `${name} ×${count}`)

  const lines = []
  lines.push('# 会话续命 · 交接包')
  lines.push('')
  if (title !== undefined && title.length > 0) {
    lines.push(`原会话：${excerpt(title, 120)}`)
    lines.push('')
  }
  if (reason !== undefined && reason.length > 0) {
    lines.push(`> ${excerpt(reason, 240)}`)
    lines.push('')
  }
  lines.push('这是从原会话日志自动整理的交接，不保证完整。原会话仍可打开查阅。')
  lines.push('')
  lines.push('## 你要继续的事')
  if (keptRequests.length === 0) {
    lines.push('（原会话里没有记录到人工提问）')
  } else {
    for (const request of keptRequests) lines.push(`- ${request}`)
  }
  lines.push('')
  lines.push('## 最后的结论')
  if (keptConclusions.length === 0) {
    lines.push('（没有记录到助手回复）')
  } else {
    for (const conclusion of keptConclusions) lines.push(`- ${conclusion}`)
  }
  if (keptFiles.length > 0 || toolSummary.length > 0) {
    lines.push('')
    lines.push('## 动过的东西')
    if (keptFiles.length > 0) {
      lines.push('文件：')
      for (const path of keptFiles) lines.push(`- \`${path}\``)
    }
    if (toolSummary.length > 0) {
      lines.push('工具：')
      lines.push(toolSummary.join('、'))
    }
  }
  const anchors = [...turns.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-20)
    .map(([turn, row]) => `T${turn}@seq${row.seq}`)
  lines.push('')
  lines.push('## 原文在哪')
  lines.push(sessionId !== undefined && sessionId.length > 0
    ? `- 原会话 ID：\`${sessionId}\`（完整日志保留，可重新打开查阅）`
    : '- 原会话完整保留，可重新打开查阅')
  lines.push(`- 轮次锚点：${anchors.length > 0 ? anchors.join('、') : '（未记录）'}`)
  lines.push('- 上面是摘录，不是全文；需要细节时回到原会话对应轮次查看。')
  lines.push('')
  lines.push('## 接着做')
  lines.push('请先确认上面的理解是否正确，再继续未完成的部分。')

  let markdown = lines.join('\n')
  if (markdown.length > MAX_HANDOFF_CHARS) {
    markdown = `${markdown.slice(0, MAX_HANDOFF_CHARS - 20)}
…（交接包已截断）`
  }

  return {
    markdown,
    stats: {
      requests: keptRequests.length,
      conclusions: keptConclusions.length,
      files: keptFiles.length,
      tools: tools.size,
      turns: turns.size,
    },
  }
}
