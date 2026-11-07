// Pure helpers of the session-compass band: no `$`, no state, easy to test.
// Not a hooks module of its own (hooks.json names only register.tsx).

import type { Nav, PastPrompt, Summary, Ticket } from '../types'

export const EMPTY_NAV: Nav = {
  liveIds: [],
  pastPrompts: [],
  promptIds: [],
  cursorId: null,
}

/** The origin kinds that are the person's own prompt. */
const OWN_KINDS: ReadonlySet<string> = new Set(['composer', 'bridge'])

/**
 * Whether a prompt is the person's own, the one rule every path uses
 * (`prompt.submit`, `session.append`, `UserMessage`).
 *
 * `composer` (typed at this terminal) and `bridge` (typed on a phone or web
 * client through Remote Control) are the person's. Everything else is not:
 * notifications, peers, plugins, schedules, and `unclassified` (a teammate's
 * row, or a row stored before origin stamps existed).
 *
 * The types make `origin` required everywhere; a row that still arrives with
 * none counts as the person's only when it names no `task` and no sender
 * (`from`), the two marks of a row that is someone else's.
 */
export function isOwnPrompt(
  origin: { readonly kind: string } | undefined | null,
  marks: { readonly task?: unknown; readonly from?: unknown } = {},
): boolean {
  if (origin === undefined || origin === null) {
    return marks.task === undefined && marks.from === undefined
  }
  return OWN_KINDS.has(origin.kind)
}

/** Cells one code point takes in a terminal: 2 for wide (CJK, emoji), else 1. */
export function cellWidth(codePoint: number): number {
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0
  // Combining marks and variation selectors / zero-width joiner.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x23e9 && codePoint <= 0x23ec) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

/** Cells a string takes. */
export function textWidth(text: string): number {
  let width = 0
  for (const ch of text) width += cellWidth(ch.codePointAt(0) ?? 0)
  return width
}

/**
 * The text on one line (every run of whitespace, newlines included, becomes
 * one space), cut to `width` cells with a trailing `…` when it is longer.
 */
export function oneLine(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (width <= 0) return ''
  if (textWidth(flat) <= width) return flat
  let out = ''
  let used = 0
  for (const ch of flat) {
    const w = cellWidth(ch.codePointAt(0) ?? 0)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out.trimEnd()}…`
}

export type BandKind = 'summary' | 'truncated' | 'pending' | 'empty'

export type BandText = {
  kind: BandKind
  /** The main text, already cut to fit (with `note`) in the width given. */
  text: string
  /** A dim note after the text: shown while the summary is pending. */
  note?: string
}

export const PENDING_NOTE = '（要約中…）'
export const EMPTY_TEXT = 'まだプロンプトがありません'

/**
 * What the band's left side shows: the summary once it is done, else the
 * first prompt cut to one line (with a note while the summary runs), else a
 * quiet placeholder. Never throws, whatever the state holds.
 */
export function bandText(
  firstPrompt: string | null | undefined,
  summary: Summary | null | undefined,
  maxWidth: number,
): BandText {
  // The last summary made stands while a newer one runs or after one failed.
  const made = summary !== null && summary !== undefined && 'text' in summary ? summary.text : undefined
  if (typeof made === 'string' && made.trim() !== '') {
    return { kind: 'summary', text: oneLine(made, maxWidth) }
  }
  if (typeof firstPrompt === 'string' && firstPrompt.trim() !== '') {
    if (summary?.status === 'pending') {
      const room = maxWidth - textWidth(PENDING_NOTE)
      return { kind: 'pending', text: oneLine(firstPrompt, room), note: PENDING_NOTE }
    }
    return { kind: 'truncated', text: oneLine(firstPrompt, maxWidth) }
  }
  return { kind: 'empty', text: oneLine(EMPTY_TEXT, maxWidth) }
}

/**
 * Rows of `$.session.messages()` that are machinery, not something the person
 * typed: a command's local output, a notification or a reminder the engine
 * filed as a user row. (A slash command the person typed is stored as
 * `<command-name>` markup too; `commandLine` reads it back.)
 */
const MACHINE_ROW = /^<(command-|local-command-|task-notification|system-reminder)/

/**
 * A slash command as the person typed it, from the markup the transcript
 * stores it as (`<command-name>/x</command-name>` and `<command-args>`):
 * `/x args`. Null for any other text.
 */
export function commandLine(text: string): string | null {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1]
  if (name === undefined || name === '') return null
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? ''
  const slashed = name.startsWith('/') ? name : `/${name}`
  return args === '' ? slashed : `${slashed} ${args}`
}

/**
 * A prompt row's text as the person typed it: a stored slash command read
 * back from its markup, anything else as it is. What drawn rows and
 * transcript rows are matched by.
 */
export function typedText(text: string): string {
  return commandLine(text) ?? text
}

/** One line of the session's transcript file, as far as the band reads it. */
export type TranscriptRow = {
  type?: unknown
  uuid?: unknown
  isMeta?: unknown
  isSidechain?: unknown
  origin?: { kind?: unknown } | null
  message?: { content?: unknown } | null
}

/** The transcript file's lines as rows; a line cut short (at a read's edge) or not JSON is left out. */
export function parseRows(text: string): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as unknown
      if (row !== null && typeof row === 'object') rows.push(row as TranscriptRow)
    } catch {
      // A line cut short at the read's edge.
    }
  }
  return rows
}

/** A stored row's text blocks joined; null when it holds a tool result (not something typed). */
function rowText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content as { type?: unknown; text?: unknown }[]) {
    if (block?.type === 'tool_result') return null
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Whether a stored row is of the main conversation, as drawn (no subagent's, no meta row). */
function isMainRow(row: TranscriptRow): row is TranscriptRow & { uuid: string } {
  return typeof row.uuid === 'string' && row.isSidechain !== true && row.isMeta !== true
}

/**
 * The first prompt the person sent, from the transcript file's rows: a user
 * row of the main conversation that is the person's own (stamped `human`, or
 * unstamped from before stamps), typed (no tool result) and not machinery;
 * a slash command counts, read back as typed. Its id is what its row is drawn
 * and scrolled to under.
 */
export function firstPromptRow(rows: readonly TranscriptRow[]): { id: string; text: string } | null {
  for (const row of rows) {
    if (row.type !== 'user' || !isMainRow(row)) continue
    const kind = row.origin?.kind
    if (kind !== undefined && kind !== 'human' && !(typeof kind === 'string' && OWN_KINDS.has(kind))) continue
    const text = rowText(row.message?.content)?.trim()
    if (text === undefined || text === '') continue
    const typed = commandLine(text)
    if (typed === null && MACHINE_ROW.test(text)) continue
    return { id: row.uuid, text: typed ?? text }
  }
  return null
}

/**
 * The id of the row drawn lowest in the transcript, from the file's last
 * rows: the newest row of the main conversation that draws (a reply's text,
 * a tool call, a tool result under its call, a prompt), by the id its row is
 * drawn under. A reply's thinking draws no row of its own and is passed over.
 */
export function lastDrawnRowId(rows: readonly TranscriptRow[]): string | null {
  return drawnRowIds(rows, 1)[0] ?? null
}

/**
 * The ids of the rows drawn lowest in the transcript, newest first, each
 * once, at most `limit`: what ⏬ tries in turn, since the file may hold rows
 * this process never drew (another process appending to the same session).
 */
export function drawnRowIds(rows: readonly TranscriptRow[], limit: number): string[] {
  const out: string[] = []
  const add = (id: string) => {
    if (!out.includes(id)) out.push(id)
  }
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    const row = rows[i]!
    if ((row.type !== 'assistant' && row.type !== 'user') || !isMainRow(row)) continue
    const content = row.message?.content
    if (typeof content === 'string') {
      if (content.trim() !== '') add(row.uuid)
      continue
    }
    if (!Array.isArray(content)) continue
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j] as { type?: unknown; id?: unknown; tool_use_id?: unknown; text?: unknown } | null
      if (block?.type === 'tool_use' && typeof block.id === 'string') add(block.id)
      else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') add(block.tool_use_id)
      else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') add(row.uuid)
      else continue
      break
    }
  }
  return out.slice(0, limit)
}

/**
 * The id of the row an appended message draws last in the transcript: its
 * last tool call's (the tool rows are drawn below the message's text), else
 * the message's own.
 */
export function rowIdOf(uuid: string, content: unknown): string {
  if (!Array.isArray(content)) return uuid
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type?: unknown; id?: unknown } | null
    if (block !== null && typeof block === 'object' && block.type === 'tool_use' && typeof block.id === 'string') {
      return block.id
    }
  }
  return uuid
}

/** The person's prompt rows of `$.session.messages()`, oldest first, slash commands included. */
export function userPromptTexts(
  messages: readonly { role: string; text: string; toolResults?: readonly unknown[] }[],
): string[] {
  return messages
    .filter(m => m.role === 'user' && (m.toolResults?.length ?? 0) === 0)
    .map(m => {
      const text = m.text.trim()
      return commandLine(text) ?? (MACHINE_ROW.test(text) ? '' : text)
    })
    .filter(text => text !== '')
}

/**
 * A short fingerprint of a prompt's text, what drawn rows and transcript rows
 * are matched by: the length (in code points) of the text on one line, and an
 * FNV-1a hash of it. A few dozen bytes whatever the prompt's size, so the nav
 * kept in `$.state` stays small however long the pasted prompts are.
 */
export function promptKey(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  let hash = 0x811c9dc5
  let length = 0
  for (const ch of flat) {
    const point = ch.codePointAt(0) ?? 0
    hash = Math.imul(hash ^ point, 0x01000193) >>> 0
    length += 1
  }
  return `${length}:${hash.toString(16).padStart(8, '0')}`
}

/**
 * Orders prompts seen only by their drawn rows by when they were said: each
 * takes the earliest not-yet-taken transcript row whose fingerprint matches
 * its own. Those that match none come first, in the order they were seen.
 *
 * `$.session.messages()` holds only the newest 4096 entries, so in a longer
 * session a drawn prompt older than those matches nothing and is placed among
 * the unmatched ones, by the order it was drawn: there is no other source for
 * the order of rows that old.
 */
export function orderPast(
  past: readonly PastPrompt[],
  transcriptKeys: readonly string[],
): PastPrompt[] {
  const taken = new Set<number>()
  const matched: { prompt: PastPrompt; at: number }[] = []
  const unmatched: PastPrompt[] = []
  for (const prompt of past) {
    let at = -1
    for (let i = 0; i < transcriptKeys.length; i++) {
      if (!taken.has(i) && transcriptKeys[i] === prompt.key) {
        at = i
        break
      }
    }
    if (at === -1) {
      unmatched.push(prompt)
    } else {
      taken.add(at)
      matched.push({ prompt, at })
    }
  }
  matched.sort((a, b) => a.at - b.at)
  return [...unmatched, ...matched.map(m => m.prompt)]
}

/** The list the buttons step through: the past prompts, then the live ones. */
export function promptIdsOf(pastPrompts: readonly PastPrompt[], liveIds: readonly string[]): string[] {
  return [...pastPrompts.map(p => p.id), ...liveIds]
}

/**
 * The nav with a newly appended prompt of the person's: added at the end of
 * `liveIds` once, taken out of `pastPrompts`, and the cursor back at the
 * latest. Null when it changes nothing.
 */
export function withLivePrompt(nav: Nav, id: string): Nav | null {
  if (nav.liveIds.includes(id) && nav.cursorId === null) return null
  const liveIds = nav.liveIds.includes(id) ? nav.liveIds : [...nav.liveIds, id]
  const pastPrompts = nav.pastPrompts.filter(p => p.id !== id)
  return { liveIds, pastPrompts, promptIds: promptIdsOf(pastPrompts, liveIds), cursorId: null }
}

/** The drawn prompts the nav does not know yet. */
export function unknownPrompts(nav: Nav, drawn: readonly PastPrompt[]): PastPrompt[] {
  const known = new Set([...nav.liveIds, ...nav.pastPrompts.map(p => p.id)])
  const out: PastPrompt[] = []
  for (const p of drawn) {
    if (!known.has(p.id)) {
      known.add(p.id)
      out.push(p)
    }
  }
  return out
}

/**
 * The nav with drawn prompts it did not know merged into `pastPrompts`, in
 * the order `orderPast` gives them. Null when there are none to add.
 */
export function withPastPrompts(nav: Nav, drawn: readonly PastPrompt[], transcriptKeys: readonly string[]): Nav | null {
  const added = unknownPrompts(nav, drawn)
  if (added.length === 0) return null
  const pastPrompts = orderPast([...nav.pastPrompts, ...added], transcriptKeys)
  return { ...nav, pastPrompts, promptIds: promptIdsOf(pastPrompts, nav.liveIds) }
}

export type NavKind = 'first' | 'prev' | 'next' | 'latest'

export type NavMove = {
  /** The index in `promptIds` to scroll to. */
  index: number
  /** The prompt there: what to scroll to, and what `cursorId` becomes once the scroll landed. */
  id: string
}

/**
 * The id the terminal draws a just-sent prompt's row under until the message
 * has its own id. Nothing can be scrolled to it once the real row is drawn,
 * so it is never a stop.
 */
export const PLACEHOLDER_ID = 'placeholder'

/** Whether a drawn row's id names a real message the buttons can stop at. */
export function isStopId(id: string): boolean {
  return id !== '' && id !== PLACEHOLDER_ID
}

/**
 * The nav without stops that are not real messages (a `placeholder` an
 * earlier version kept). The same nav object when there is none.
 */
export function withoutBadStops(nav: Nav): Nav {
  if (nav.promptIds.every(isStopId)) return nav
  const liveIds = nav.liveIds.filter(isStopId)
  const pastPrompts = nav.pastPrompts.filter(p => isStopId(p.id))
  const cursorId = nav.cursorId !== null && isStopId(nav.cursorId) ? nav.cursorId : null
  return { liveIds, pastPrompts, promptIds: promptIdsOf(pastPrompts, liveIds), cursorId }
}

/**
 * Which rows of a message the viewport shows (`UserMessage`'s `onScreen`), or
 * null while it is drawn outside the viewport.
 */
export type Seen = { readonly first: number; readonly last: number; readonly of: number } | null

/**
 * Where the viewport stands among the prompts, in half steps of the prompt
 * list: `k` is prompt k's own row at the top, `k + 0.5` somewhere in prompt
 * k's turn past its row, `-0.5` above the first prompt.
 *
 * `at` is the best guess, from the viewport's top as the terminal's own
 * header reads it; `lo`..`hi` is every position the viewport is consistent
 * with, since a prompt whose row starts on screen may sit at the very top
 * (where a button put it) or lower down.
 */
export type ViewSpan = { lo: number; hi: number; at: number }

/** Which side of the viewport a prompt row is on while it is off screen. */
export type Side = 'above' | 'below'

/** Which way the viewport last moved over the transcript. */
export type Direction = 'up' | 'down'

/**
 * Reports after a button's move that come later than this many ms are not
 * the move's own: the viewport moved again (the person scrolled, or the
 * transcript grew under it).
 */
export const MOVE_SETTLE_MS = 500

/**
 * What the drawn rows said of one surface's viewport: each prompt row's last
 * report (`seen`, null once off screen) and, for a prompt row off screen,
 * the side it left by (`sides`); every row's last report (`rows`, replies
 * too), which way the viewport last moved (`direction`), when a button last
 * moved it (`movedAt`), and whether it moved since (`isHandScrolled`).
 */
export type Viewport = {
  seen: Map<string, Seen>
  sides: Map<string, Side>
  rows: Map<string, Seen>
  direction: Direction | null
  movedAt: number
  isHandScrolled: boolean
}

export function emptyViewport(): Viewport {
  return { seen: new Map(), sides: new Map(), rows: new Map(), direction: null, movedAt: 0, isHandScrolled: false }
}

export function copyViewport(view: Viewport): Viewport {
  return { ...view, seen: new Map(view.seen), sides: new Map(view.sides), rows: new Map(view.rows) }
}

/**
 * Which way the viewport moved, from two reports of one row: its rows in
 * view moving down the row (or the row leaving by its top, or coming in by
 * its bottom) mean the viewport went down; the other way, up. Null when the
 * reports do not tell.
 */
export function directionOf(before: Seen | undefined, after: Seen): Direction | null {
  if (before !== undefined && before !== null && after !== null) {
    if (after.first > before.first || after.last > before.last) return 'down'
    if (after.first < before.first || after.last < before.last) return 'up'
    return null
  }
  if (before !== undefined && before !== null) {
    if (before.first > 0) return 'down'
    if (before.last < before.of - 1) return 'up'
    return null
  }
  if (after !== null) {
    if (after.first > 0) return 'up'
    if (after.last < after.of - 1) return 'down'
  }
  return null
}

/**
 * Takes in one row's report, `isPrompt` for the person's prompt rows. A
 * prompt row that goes off screen left by the edge it was cut at (its top
 * cut: above; its bottom cut: below); one shown whole that is gone the next
 * report jumped out of view, the way the viewport was moving.
 */
export function noteReport(view: Viewport, id: string, report: Seen, isPrompt: boolean, now: number): void {
  const direction = directionOf(view.rows.get(id), report)
  view.rows.set(id, report)
  if (direction !== null) view.direction = direction
  if (now - view.movedAt > MOVE_SETTLE_MS) view.isHandScrolled = true
  if (!isPrompt) return
  const before = view.seen.get(id)
  view.seen.set(id, report)
  if (report !== null) {
    view.sides.delete(id)
    return
  }
  if (before === undefined || before === null) return
  if (before.first > 0) view.sides.set(id, 'above')
  else if (before.last < before.of - 1) view.sides.set(id, 'below')
  else if (view.direction === 'down') view.sides.set(id, 'above')
  else if (view.direction === 'up') view.sides.set(id, 'below')
}

/**
 * Takes in a button's move to prompt `index` at `now`: the old reports no
 * longer hold, the prompts before it are now above the viewport and those
 * after it below, until the rows report otherwise.
 */
export function noteMove(view: Viewport, promptIds: readonly string[], index: number, now: number): void {
  view.seen.clear()
  view.sides.clear()
  view.rows.clear()
  view.direction = null
  view.movedAt = now
  view.isHandScrolled = false
  promptIds.forEach((id, i) => {
    if (i < index) view.sides.set(id, 'above')
    else if (i > index) view.sides.set(id, 'below')
  })
}

/**
 * The span the viewport shows, from what the drawn prompt rows last reported;
 * null when nothing tells where it is.
 *
 * With no prompt row on screen (the viewport inside a long reply), it is
 * between the last prompt known to be above it and the first known to be
 * below, in the turn of the one above: what the terminal's header names.
 */
export function viewSpan(
  promptIds: readonly string[],
  seen: ReadonlyMap<string, Seen>,
  sides: ReadonlyMap<string, Side> = new Map(),
): ViewSpan | null {
  let v = -1
  let w = -1
  for (let i = 0; i < promptIds.length; i++) {
    const s = seen.get(promptIds[i]!)
    if (s === undefined || s === null) continue
    if (v === -1) v = i
    w = i
  }
  if (v === -1) {
    let above = -1
    let below = -1
    for (let i = 0; i < promptIds.length; i++) {
      const side = sides.get(promptIds[i]!)
      if (side === 'above') above = i
      else if (side === 'below' && below === -1) below = i
    }
    if (above === -1 && below === -1) return null
    // Rows that disagree (one below another above it) tell nothing.
    if (above !== -1 && below !== -1 && above >= below) return null
    const lo = above === -1 ? -0.5 : above
    const hi = below === -1 ? promptIds.length - 0.5 : below - 0.5
    return { lo, hi, at: above === -1 ? below - 0.5 : above + 0.5 }
  }
  const top = seen.get(promptIds[v]!)!
  // Its row's top scrolled away: the viewport is in prompt v's turn.
  if (top.first > 0) return { lo: v, hi: w + 0.5, at: v + 0.5 }
  // Its row starts on screen: below the end of the turn before, which then
  // fills the top. That turn's own prompt may be on the top row too, yet not
  // reported: a button puts it there, under the terminal's header of the
  // prompt being read. So a cursor on it still agrees with the viewport.
  return { lo: v - 1, hi: w + 0.5, at: v - 0.5 }
}

/**
 * The position a button counts from. With `isViewFirst` (the person scrolled
 * since the last move) it is where the viewport is, so they step from what
 * they see. Otherwise the cursor, while the viewport is where the cursor says
 * or nothing reports where it is; else where the viewport is.
 *
 * `cursorId` null (or an id no longer listed) is the end of the transcript,
 * below the newest prompt.
 */
export function navPosition(
  promptIds: readonly string[],
  cursorId: string | null,
  view: ViewSpan | null = null,
  isViewFirst = false,
): number {
  const found = cursorId === null ? -1 : promptIds.indexOf(cursorId)
  const cursor = found === -1 ? promptIds.length - 0.5 : found
  if (view === null) return cursor
  if (isViewFirst) return view.at
  return cursor >= view.lo && cursor <= view.hi ? cursor : view.at
}

/**
 * Where a button goes, or null when there is nowhere to go (no prompts yet,
 * or "next" while at the end of the transcript). Always an index inside the
 * list.
 *
 * The position comes from `navPosition`: at the end of the transcript
 * (where a session starts and where a new prompt leaves it) "prev" goes to
 * the newest prompt; inside a prompt's turn "prev" goes to that prompt's own
 * row and "next" to the one after; on a prompt's row they step one each way.
 * "latest" lands on the newest prompt itself, so the cursor names it and
 * "prev" next goes one further back.
 */
export function navTarget(
  kind: NavKind,
  promptIds: readonly string[],
  cursorId: string | null,
  view: ViewSpan | null = null,
  isViewFirst = false,
): NavMove | null {
  const n = promptIds.length
  if (n === 0) return null
  const at = navPosition(promptIds, cursorId, view, isViewFirst)
  let index: number
  switch (kind) {
    case 'first':
      index = 0
      break
    case 'prev':
      index = Math.max(0, Math.ceil(at) - 1)
      break
    case 'next':
      if (at > n - 1) return null
      index = Math.min(n - 1, Math.floor(at) + 1)
      break
    case 'latest':
      index = n - 1
      break
  }
  const id = promptIds[index]
  return id === undefined ? null : { index, id }
}

/** A model reply as one clean line, or null when nothing is left. */
export function summaryLine(reply: string): string | null {
  const line = reply.replace(/\s+/g, ' ').trim()
  return line === '' ? null : line
}

/** The prompt text sent for the summary: long prompts are cut. */
export const SUMMARY_INPUT_LIMIT = 4000

/**
 * The prompt cut to SUMMARY_INPUT_LIMIT code points (never inside a surrogate
 * pair), an ellipsis after when it was longer. Cutting twice gives the same
 * text as cutting once.
 */
export function summaryInput(prompt: string): string {
  const points = Array.from(prompt)
  return points.length > SUMMARY_INPUT_LIMIT ? `${points.slice(0, SUMMARY_INPUT_LIMIT).join('')}…` : prompt
}

/** A kept prompt is cut to this many code points. */
export const PROMPT_KEEP_LIMIT = 600
/** At most this many prompts are kept: the first and the newest. */
export const PROMPTS_KEPT = 30
/** The summary is asked for the first prompt and this many newest ones. */
export const SUMMARY_RECENT = 8

/** Text cut to `limit` code points, an ellipsis after when it was longer. */
function cut(text: string, limit: number): string {
  const points = Array.from(text)
  return points.length <= limit ? text : `${points.slice(0, limit).join('')}…`
}

/**
 * The line a prompt is kept as: a slash command as `/name args`, anything
 * else as typed; on one line, cut to PROMPT_KEEP_LIMIT.
 */
export function promptLine(text: string, command?: { readonly name: string; readonly args: string }): string {
  const typed = command === undefined ? text : `/${command.name} ${command.args}`
  return cut(typed.replace(/\s+/g, ' ').trim(), PROMPT_KEEP_LIMIT)
}

/**
 * The kept prompts with one more: the first stays, then the newest. A line
 * the same as the last kept one is the same prompt seen twice (a resumed
 * transcript read while it was submitted) and is not kept again.
 */
export function withPrompt(prompts: readonly string[], line: string): string[] {
  if (prompts[prompts.length - 1] === line) return [...prompts]
  const all = [...prompts, line]
  if (all.length <= PROMPTS_KEPT) return all
  return [all[0]!, ...all.slice(all.length - (PROMPTS_KEPT - 1))]
}

/** How many kept prompts the summary was made from. */
export function summaryBasis(summary: Summary | null | undefined): number {
  if (summary === null || summary === undefined || summary.status === 'idle') return 0
  return summary.basis ?? 1
}

/** The last summary made, if any. */
export function lastSummaryText(summary: Summary | null | undefined): string | undefined {
  return summary !== null && summary !== undefined && 'text' in summary ? summary.text : undefined
}

/**
 * What the summary is asked: the session's first prompt and the newest few,
 * numbered in the order said.
 */
export function summaryPrompts(prompts: readonly string[]): string {
  const recent = prompts.length <= SUMMARY_RECENT + 1 ? prompts : [prompts[0]!, ...prompts.slice(-SUMMARY_RECENT)]
  const skipped = prompts.length - recent.length
  return recent
    .map((p, i) => {
      const n = i === 0 ? 1 : i + 1 + skipped
      return `${n}. ${p}`
    })
    .join('\n')
}

/** Letter-and-digit runs that look like ids yet name no ticket. */
const NOT_TICKETS: ReadonlySet<string> = new Set([
  'UTF', 'ISO', 'RFC', 'SHA', 'MD', 'CVE', 'CWE', 'GPT', 'HTTP', 'TLS', 'SSL', 'ES', 'IE', 'PEP', 'JSR', 'ECMA', 'WCAG',
])

/**
 * The ticket ids a prompt names, in order, each once: a project key of two
 * to ten capitals and digits starting with a capital, a hyphen, digits
 * (`SCMP-00001`, `PROJ-123`). Standards and versions (`UTF-8`, `RFC-2119`)
 * are not tickets.
 */
export function ticketCandidates(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,9})-(\d{1,7})(?![A-Za-z0-9-])/g)) {
    if (NOT_TICKETS.has(m[1]!)) continue
    const id = `${m[1]}-${m[2]}`
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/** The title `graph-engine get-ticket <id>` printed for that ticket, or null. */
export function graphTicketTitle(stdout: string, id: string): string | null {
  try {
    const ticket = JSON.parse(stdout) as unknown
    if (typeof ticket !== 'object' || ticket === null) return null
    const { id: got, title } = ticket as { id?: unknown; title?: unknown }
    if (got !== id || typeof title !== 'string') return null
    const line = title.replace(/\s+/g, ' ').trim()
    return line === '' ? null : line
  } catch {
    return null
  }
}

/** A yes/no reply read as a yes. */
export function isYes(reply: string): boolean {
  return /^\s*(yes|はい)\b/i.test(reply)
}

/** A title reply as one line, or null for `NONE` or nothing. */
export function titleLine(reply: string): string | null {
  const line = reply.replace(/\s+/g, ' ').trim().replace(/^["「『]|["」』]$/g, '')
  if (line === '' || /^none$/i.test(line)) return null
  return line
}

/** Keys a tracker's record names a ticket by. */
const ID_KEYS = 'id|key|identifier|ticket|ticketId|ticket_id|issue|issueKey|number'
/** Keys a tracker's record holds a ticket's title under, most telling first. */
const TITLE_KEYS = ['title', 'summary', 'subject', 'name'] as const
/** How far past the id a record's title is looked for, in characters. */
const RECORD_REACH = 4000

/** A JSON string literal's body as text. */
function jsonString(body: string): string {
  try {
    return JSON.parse(`"${body}"`) as string
  } catch {
    return body
  }
}

/**
 * The ticket's title as a tool result holds it, read with no model: a JSON
 * record (whole or cut short) that names the id under an id-like key
 * (`"id": "SCMP-00001"`, `"key": "PROJ-123"`) and has a title-like field
 * after it, before the next record's id (`"title"`, Jira's
 * `"fields": { "summary" }`, `"subject"`, `"name"`). Null when no text holds
 * one. Each text is read newest last; the last record found wins, as it is
 * the freshest.
 */
export function structuredTitle(texts: readonly string[], id: string): string | null {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const named = new RegExp(`"(?:${ID_KEYS})"\\s*:\\s*"${escaped}"`, 'g')
  const nextRecord = new RegExp(`"(?:${ID_KEYS})"\\s*:\\s*"`)
  let found: string | null = null
  for (const text of texts) {
    if (!text.includes(id)) continue
    for (const m of text.matchAll(named)) {
      let after = text.slice(m.index + m[0].length, m.index + m[0].length + RECORD_REACH)
      const cut = nextRecord.exec(after)
      if (cut !== null) after = after.slice(0, cut.index)
      for (const key of TITLE_KEYS) {
        const field = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(after)
        const line = field === null ? '' : jsonString(field[1]!).replace(/\s+/g, ' ').trim()
        if (line !== '' && line !== id) {
          found = line
          break
        }
      }
    }
  }
  return found
}

/**
 * The parts of the transcript that mention the ticket id, each with some
 * text around it, joined and cut to `limit` code points: what the title is
 * looked for in. Empty when the id is not mentioned.
 */
export function ticketMentions(texts: readonly string[], id: string, limit = 6000, around = 300): string {
  const parts: string[] = []
  let used = 0
  for (const text of texts) {
    let from = 0
    for (;;) {
      const at = text.indexOf(id, from)
      if (at === -1) break
      const part = text.slice(Math.max(0, at - around), at + id.length + around)
      parts.push(part)
      used += part.length
      from = at + id.length + around
      if (used >= limit) return cut(parts.join('\n---\n'), limit)
    }
  }
  return cut(parts.join('\n---\n'), limit)
}

/** What the band shows for a ticket: its id, and its title when known. */
export function ticketBand(ticket: Ticket, maxWidth: number): { id: string; title: string } {
  const id = oneLine(ticket.id, maxWidth)
  const room = maxWidth - textWidth(id) - 1
  const title = ticket.title === null || room <= 1 ? '' : oneLine(ticket.title, room)
  return { id, title }
}
