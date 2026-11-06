// Pure helpers of the session-compass band: no `$`, no state, easy to test.
// Not a hooks module of its own (hooks.json names only register.tsx).

import type { Nav, PastPrompt, Summary } from '../types'

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
  if (summary?.status === 'done' && summary.text.trim() !== '') {
    return { kind: 'summary', text: oneLine(summary.text, maxWidth) }
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
 * typed: a slash command's expansion, a command's local output, a
 * notification or a reminder the engine filed as a user row.
 */
const MACHINE_ROW = /^<(command-|local-command-|task-notification|system-reminder)/

/** The person's prompt rows of `$.session.messages()`, oldest first. */
export function userPromptTexts(
  messages: readonly { role: string; text: string; toolResults?: readonly unknown[] }[],
): string[] {
  return messages
    .filter(m => m.role === 'user' && (m.toolResults?.length ?? 0) === 0)
    .map(m => m.text.trim())
    .filter(text => text !== '' && !MACHINE_ROW.test(text))
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

/**
 * The span the viewport shows, from what the drawn prompt rows last reported;
 * null when no prompt row is on screen (the viewport is inside one long
 * turn, or nothing has reported).
 */
export function viewSpan(promptIds: readonly string[], seen: ReadonlyMap<string, Seen>): ViewSpan | null {
  let v = -1
  let w = -1
  for (let i = 0; i < promptIds.length; i++) {
    const s = seen.get(promptIds[i]!)
    if (s === undefined || s === null) continue
    if (v === -1) v = i
    w = i
  }
  if (v === -1) return null
  const top = seen.get(promptIds[v]!)!
  // Its row's top scrolled away: the viewport is in prompt v's turn.
  if (top.first > 0) return { lo: v, hi: w + 0.5, at: v + 0.5 }
  // Its row starts on screen: either at the top, or below the end of the
  // turn before, which then fills the top.
  return { lo: v - 0.5, hi: w + 0.5, at: v - 0.5 }
}

/**
 * The position a button counts from: the cursor, while the viewport is where
 * the cursor says or nothing reports where it is; else where the viewport
 * is, so a person who scrolled by hand steps from what they see.
 *
 * `cursorId` null (or an id no longer listed) is the end of the transcript,
 * below the newest prompt.
 */
export function navPosition(promptIds: readonly string[], cursorId: string | null, view: ViewSpan | null = null): number {
  const found = cursorId === null ? -1 : promptIds.indexOf(cursorId)
  const cursor = found === -1 ? promptIds.length - 0.5 : found
  if (view === null) return cursor
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
): NavMove | null {
  const n = promptIds.length
  if (n === 0) return null
  const at = navPosition(promptIds, cursorId, view)
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
