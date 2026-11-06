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

/** The person's prompt rows of `$.session.messages()`, oldest first. */
export function userPromptTexts(
  messages: readonly { role: string; text: string; toolResults?: readonly unknown[] }[],
): string[] {
  return messages
    .filter(m => m.role === 'user' && (m.toolResults?.length ?? 0) === 0 && m.text.trim() !== '')
    .map(m => m.text.trim())
}

/**
 * Orders prompts seen only by their drawn rows by when they were said: each
 * takes the earliest not-yet-taken transcript row whose text matches its own.
 * Those that match none come first, in the order they were seen.
 */
export function orderPast(
  past: readonly PastPrompt[],
  userTexts: readonly string[],
): PastPrompt[] {
  const taken = new Set<number>()
  const matched: { prompt: PastPrompt; at: number }[] = []
  const unmatched: PastPrompt[] = []
  for (const prompt of past) {
    const text = prompt.text.trim()
    let at = -1
    for (let i = 0; i < userTexts.length; i++) {
      if (!taken.has(i) && userTexts[i] === text) {
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
export function withPastPrompts(nav: Nav, drawn: readonly PastPrompt[], userTexts: readonly string[]): Nav | null {
  const added = unknownPrompts(nav, drawn)
  if (added.length === 0) return null
  const pastPrompts = orderPast([...nav.pastPrompts, ...added], userTexts)
  return { ...nav, pastPrompts, promptIds: promptIdsOf(pastPrompts, nav.liveIds) }
}

export type NavKind = 'first' | 'prev' | 'next' | 'latest'

export type NavMove = {
  /** The index in `promptIds` to scroll to. */
  index: number
  /** What `cursorId` becomes once the scroll landed (`null`: at the latest). */
  cursorId: string | null
}

/**
 * Where a button goes, or null when there is nowhere to go (no prompts yet,
 * or "next" while already at the latest). Always an index inside the list.
 */
export function navTarget(kind: NavKind, promptIds: readonly string[], cursorId: string | null): NavMove | null {
  const n = promptIds.length
  if (n === 0) return null
  const found = cursorId === null ? -1 : promptIds.indexOf(cursorId)
  const cursor = found === -1 ? null : found
  let index: number
  switch (kind) {
    case 'first':
      index = 0
      break
    case 'prev':
      index = cursor === null ? n - 1 : Math.max(0, cursor - 1)
      break
    case 'next':
      if (cursor === null) return null
      index = Math.min(n - 1, cursor + 1)
      break
    case 'latest':
      return { index: n - 1, cursorId: null }
  }
  const id = promptIds[index]
  if (id === undefined) return null
  return { index, cursorId: id }
}

/** A model reply as one clean line, or null when nothing is left. */
export function summaryLine(reply: string): string | null {
  const line = reply.replace(/\s+/g, ' ').trim()
  return line === '' ? null : line
}

/** The prompt text sent for the summary: long prompts are cut. */
export const SUMMARY_INPUT_LIMIT = 4000

export function summaryInput(prompt: string): string {
  return prompt.length > SUMMARY_INPUT_LIMIT ? `${prompt.slice(0, SUMMARY_INPUT_LIMIT)}…` : prompt
}
