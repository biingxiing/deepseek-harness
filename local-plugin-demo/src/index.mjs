/**
 * Session bookmarks — a runtime-loadable Cordis Host plugin for `/add-plugin`.
 *
 * Import-free on purpose: the Loader resolves this entry through Node's ESM
 * resolver from an arbitrary workspace directory, where the harness packages
 * are not resolvable. Every registration therefore uses raw JSON Schema and
 * plain objects instead of the `defineTool` / typed helpers a workspace
 * package would import.
 *
 * @module dsh-plugin-bookmarks
 */

export const name = 'plugin-bookmarks'
export const inject = ['tools', 'commands', 'systemPrompt']

/** Bookmarks kept per session; the oldest is dropped once the list is full. */
const MAX_BOOKMARKS_PER_SESSION = 50

/**
 * Sessions the store tracks at once. The plugin has no session-disposal hook,
 * so the map is bounded by least-recently-written eviction instead.
 */
const MAX_TRACKED_SESSIONS = 32

const COMMAND_USAGE = 'Usage: /bookmarks | /bookmarks clear | /bookmarks remove <id>'

/**
 * Per-session bookmark lists with bounded growth in both dimensions.
 * Insertion order of `#sessions` is the eviction order: a write re-inserts its
 * session at the end, so eviction removes the least recently written one.
 */
class BookmarkStore {
  /** @type {Map<string, { nextId: number, bookmarks: object[] }>} */
  #sessions = new Map()

  /**
   * Read one session's bookmarks without creating or touching its entry, so a
   * prompt assembly on every turn cannot grow or reorder the store.
   * @param {string} sessionId - the owning session's id.
   * @returns {readonly object[]} the bookmarks in insertion order, possibly empty.
   */
  list(sessionId) {
    return this.#sessions.get(sessionId)?.bookmarks ?? []
  }

  /**
   * Append one bookmark, evicting the oldest entry of an over-full list.
   * @param {string} sessionId - the owning session's id.
   * @param {{ file: string, line?: number, note: string }} entry - validated bookmark fields.
   * @returns {object} the stored bookmark, including its assigned id.
   */
  add(sessionId, entry) {
    const state = this.#open(sessionId)
    const bookmark = { id: state.nextId++, ...entry }
    state.bookmarks.push(bookmark)
    if (state.bookmarks.length > MAX_BOOKMARKS_PER_SESSION) state.bookmarks.shift()
    return bookmark
  }

  /**
   * Remove one bookmark by id.
   * @param {string} sessionId - the owning session's id.
   * @param {number} bookmarkId - the id shown by `bookmark_list` and `/bookmarks`.
   * @returns {object | undefined} the removed bookmark, or `undefined` when no such id exists.
   */
  remove(sessionId, bookmarkId) {
    const bookmarks = this.#sessions.get(sessionId)?.bookmarks
    if (bookmarks === undefined) return undefined
    const index = bookmarks.findIndex(bookmark => bookmark.id === bookmarkId)
    if (index < 0) return undefined
    return bookmarks.splice(index, 1)[0]
  }

  /**
   * Drop one session's bookmarks and stop tracking it.
   * @param {string} sessionId - the owning session's id.
   * @returns {number} how many bookmarks were dropped.
   */
  clear(sessionId) {
    const removed = this.list(sessionId).length
    this.#sessions.delete(sessionId)
    return removed
  }

  /** Drop every tracked session. Called when this plugin's fiber is disposed. */
  clearAll() {
    this.#sessions.clear()
  }

  /**
   * Return one session's writable state, creating it and evicting the least
   * recently written session when the tracking budget is exhausted.
   * @param {string} sessionId - the owning session's id.
   * @returns {{ nextId: number, bookmarks: object[] }} the session's mutable state.
   */
  #open(sessionId) {
    const existing = this.#sessions.get(sessionId)
    if (existing !== undefined) {
      this.#sessions.delete(sessionId)
      this.#sessions.set(sessionId, existing)
      return existing
    }
    if (this.#sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.#sessions.keys().next()
      if (!oldest.done) this.#sessions.delete(oldest.value)
    }
    const created = { nextId: 1, bookmarks: [] }
    this.#sessions.set(sessionId, created)
    return created
  }
}

/**
 * Narrow the model's raw tool arguments to a plain object. The registry hands
 * `execute` frozen but UNVALIDATED arguments for a raw `register()` call — only
 * `output.schema` is enforced — so each field is checked here.
 * @param {unknown} args - the model-supplied arguments.
 * @returns {Record<string, unknown>} the arguments as a plain object.
 */
function readArguments(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('arguments must be a JSON object')
  }
  return args
}

/**
 * Read one required non-empty string field.
 * @param {unknown} value - the raw field value.
 * @param {string} field - the field name, for the rejection message.
 * @returns {string} the trimmed value.
 */
function readText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`\`${field}\` must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Read the optional 1-based line number.
 * @param {unknown} value - the raw field value.
 * @returns {number | undefined} the line, or `undefined` when the field is absent.
 */
function readLine(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('`line` must be a positive integer when present')
  }
  return value
}

/**
 * Recover the session that owns a tool call. A non-agent caller has no session
 * to bookmark against, so the call is rejected rather than silently discarded.
 * @param {object} exec - the tool run context.
 * @param {string} tool - the calling tool's name, for the rejection message.
 * @returns {object} the owning session.
 */
function requireSession(exec, tool) {
  if (!exec.agent) throw new Error(`${tool} requires an owning agent session`)
  return exec.agent.session
}

/**
 * Render one bookmark as a single human- and model-readable line.
 * @param {object} bookmark - a stored bookmark.
 * @returns {string} the rendered line.
 */
function formatBookmark(bookmark) {
  const location = bookmark.line === undefined ? bookmark.file : `${bookmark.file}:${bookmark.line}`
  return `#${bookmark.id} ${location} — ${bookmark.note}`
}

/**
 * Project one bookmark to its editor-follow-along location.
 * @param {Record<string, unknown>} args - raw `bookmark_add` arguments.
 * @returns {object[]} a one-entry location list, or none when `file` is unusable.
 */
function locationsOf(args) {
  if (typeof args?.file !== 'string' || args.file.length === 0) return []
  return [typeof args.line === 'number' ? { path: args.file, line: args.line } : { path: args.file }]
}

/** JSON Schema of one bookmark as it appears in tool output. */
const BOOKMARK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'file', 'note'],
  properties: {
    id: { type: 'integer' },
    file: { type: 'string' },
    line: { type: 'integer' },
    note: { type: 'string' },
  },
}

const GUIDANCE = `## Bookmarks

Use \`bookmark_add\` to pin a place you will need again — an entry point, the site of a bug, a file awaiting an edit — with a short note saying why it matters. Bookmark deliberately: a place you already handled is not worth pinning. Use \`bookmark_list\` to recover the full list.

Bookmarks live only in this session and are never written to disk.`

/**
 * Register the bookmark tools, the `/bookmarks` command, and the two prompt
 * sections, and release every bookmark when this plugin's fiber is disposed.
 * @param {object} ctx - the registrant Cordis context.
 */
export function apply(ctx) {
  const store = new BookmarkStore()

  ctx.effect(() => () => store.clearAll(), 'plugin-bookmarks: session bookmarks')

  ctx.effect(() => ctx.tools.register({
    name: 'bookmark_add',
    description:
      'Pin one place in the codebase for later, with a short note on why it matters. '
      + 'Bookmarks are session-local and survive until the session ends.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file', 'note'],
      properties: {
        file: { type: 'string', description: 'Workspace-relative path of the file to pin.' },
        line: { type: 'integer', description: 'Optional 1-based line number within the file.' },
        note: { type: 'string', description: 'Why this place matters — one short line.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['bookmark', 'total'],
        properties: { bookmark: BOOKMARK_SCHEMA, total: { type: 'integer' } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Bookmarked ${formatBookmark(value.bookmark)} (${value.total} total).`,
      }],
    },
    execute(rawArgs, exec) {
      const args = readArguments(rawArgs)
      const file = readText(args.file, 'file')
      const note = readText(args.note, 'note')
      const line = readLine(args.line)
      const session = requireSession(exec, 'bookmark_add')
      const bookmark = store.add(session.id, line === undefined ? { file, note } : { file, line, note })
      return Promise.resolve({ bookmark, total: store.list(session.id).length })
    },
    isConcurrencySafe: () => false,
    presentCall: args => ({
      card: 'generic',
      title: 'Add bookmark',
      kind: 'other',
      rawInput: typeof args?.note === 'string' ? args.note : undefined,
      locations: locationsOf(readArguments(args)),
    }),
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'bookmark_list',
    description: 'List every place bookmarked in this session, with its id and note.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['bookmarks', 'total'],
        properties: {
          bookmarks: { type: 'array', items: BOOKMARK_SCHEMA },
          total: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.total === 0
          ? 'No bookmarks in this session.'
          : value.bookmarks.map(formatBookmark).join('\n'),
      }],
    },
    execute(_rawArgs, exec) {
      const bookmarks = [...store.list(requireSession(exec, 'bookmark_list').id)]
      return Promise.resolve({ bookmarks, total: bookmarks.length })
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'List bookmarks', kind: 'read' }),
  }))

  ctx.effect(() => ctx.commands.register({
    name: 'bookmarks',
    description: 'show, clear, or remove this session\'s bookmarks',
    input: { hint: '[clear | remove <id>]' },
    handler: (invocation) => {
      const sessionId = invocation.agent.session.id
      const input = invocation.rawInput.trim()

      if (input.length === 0) {
        const bookmarks = store.list(sessionId)
        return {
          kind: 'success',
          text: bookmarks.length === 0
            ? 'No bookmarks in this session.'
            : bookmarks.map(formatBookmark).join('\n'),
        }
      }

      if (input === 'clear') {
        const removed = store.clear(sessionId)
        return { kind: 'success', text: `Cleared ${removed} bookmark(s).` }
      }

      const removal = /^remove\s+#?(\d+)$/u.exec(input)
      if (removal === null) return { kind: 'error', text: COMMAND_USAGE }
      const removed = store.remove(sessionId, Number(removal[1]))
      return removed === undefined
        ? { kind: 'error', text: `No bookmark #${removal[1]} in this session.` }
        : { kind: 'success', text: `Removed ${formatBookmark(removed)}.` }
    },
  }))

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'bookmarks:guidance',
    order: 116,
    text: GUIDANCE,
  }))

  // The assembling agent rides `AssembleContext.agent`, which is how a globally
  // registered section reaches per-session state. An assembly with no agent
  // (a hand-built one-shot) and an empty list both contribute nothing.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'bookmarks:list',
    order: 117,
    text: (context) => {
      if (context.agent === undefined) return ''
      const bookmarks = store.list(context.agent.session.id)
      if (bookmarks.length === 0) return ''
      return `### Current bookmarks\n\n${bookmarks.map(bookmark => `- ${formatBookmark(bookmark)}`).join('\n')}`
    },
  }))
}
