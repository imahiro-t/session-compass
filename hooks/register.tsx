import { atom, read } from 'claude-code'
import type { EngineInterface, Register, SessionMessagesResult } from 'claude-code'

import type { Nav, PastPrompt, Summary } from '../types'
import {
  EMPTY_NAV,
  bandText,
  isOwnPrompt,
  isStopId,
  navPosition,
  navTarget,
  promptKey,
  summaryInput,
  summaryLine,
  unknownPrompts,
  userPromptTexts,
  viewSpan,
  withLivePrompt,
  withPastPrompts,
  withoutBadStops,
} from './logic'
import type { NavKind, Seen } from './logic'

const FIRST_PROMPT = { plugin: 'session-compass', key: 'firstPrompt' } as const
const SUMMARY = { plugin: 'session-compass', key: 'summary' } as const
const NAV = { plugin: 'session-compass', key: 'nav' } as const
const HEADS = { plugin: 'session-compass', key: 'heads' } as const

const firstPromptAtom = atom(FIRST_PROMPT, null)
const summaryAtom = atom(SUMMARY, { status: 'idle' })
const navAtom = atom(NAV, EMPTY_NAV)

const SUMMARY_SYSTEM =
  'あなたはセッションの目的を要約する。ユーザーの依頼を、このセッションの目的として 1 行（全角 40 字程度）で要約する。前置き・引用符・句点以外の記号は不要で、要約だけを出力する。'

/** The buttons, left to right. */
const BUTTONS: readonly { kind: NavKind; label: string }[] = [
  { kind: 'first', label: '⏫' },
  { kind: 'prev', label: '🔼' },
  { kind: 'next', label: '🔽' },
  { kind: 'latest', label: '⏬' },
]

/** Cells one button takes on the terminal: `[ ⏫ ]`. */
const BUTTON_CELLS = 6
/** Cells between two buttons (the row's `gap`). */
const BUTTON_GAP = 1
/** Cells between the summary and the buttons (the row's `marginLeft`). */
const BUTTONS_MARGIN = 1
/** Cells the whole button row takes, the margin before it included. */
const BUTTONS_WIDTH = BUTTONS.length * BUTTON_CELLS + (BUTTONS.length - 1) * BUTTON_GAP + BUTTONS_MARGIN

/** `$.session.messages()` returns at most this many entries, the newest. */
const MESSAGES_LIMIT = 4096

type Dollar = EngineInterface

// One token per module environment: a `pending` summary that names another
// token was started by an environment that is gone (reload, respawn).
const envToken = crypto.randomUUID()

// Prompts seen by drawing their rows, id to fingerprint (`promptKey`). A
// render hook may not write state, so they wait here until a hook outside
// drawing merges them (mergeBuffer). A reload empties it; the rows fire
// `UserMessage` again when redrawn.
const renderBuffer = new Map<string, string>()

// What each drawn prompt row last said of the viewport (`onScreen`), per
// surface: where the person has scrolled to, read when a button is pressed.
// Kept here, not in state, for the same reason as renderBuffer.
const seenBySurface = new Map<string, Map<string, Seen>>()

// The person's prompt appended last whose reply has drawn no row yet, the
// rows of replies drawn so far, and the reply heads found and not yet stored:
// a prompt's head is the first new reply row drawn after it.
let awaitingHead: string | null = null
const drawnReplies = new Set<string>()
const headBuffer = new Map<string, string>()

function noteReplyRow(requestId: string): void {
  if (drawnReplies.has(requestId)) return
  drawnReplies.add(requestId)
  if (awaitingHead === null || !isStopId(requestId)) return
  headBuffer.set(awaitingHead, requestId)
  awaitingHead = null
}

/** Stores the reply heads found while drawing; a lost race keeps them buffered. */
async function mergeHeads($: Dollar): Promise<void> {
  if (headBuffer.size === 0) return
  const found = [...headBuffer]
  const held = await $.state.get(HEADS)
  const heads = held.value ?? {}
  if (found.every(([id, head]) => heads[id] === head)) {
    for (const [id] of found) headBuffer.delete(id)
    return
  }
  const written = await $.state.set(HEADS, { ...heads, ...Object.fromEntries(found) }, { ifVersion: held.version })
  if (!written.isSet) return
  for (const [id, head] of found) {
    if (headBuffer.get(id) === head) headBuffer.delete(id)
  }
}

function seenOn(surface: string): Map<string, Seen> {
  let seen = seenBySurface.get(surface)
  if (seen === undefined) {
    seen = new Map()
    seenBySurface.set(surface, seen)
  }
  return seen
}

function debug($: Dollar, text: string): void {
  $.ui.log(`session-compass: ${text}`, { to: 'debug' })
}

/**
 * Runs `work` on a timer, off the hook's dispatch: the hook answers at once
 * and nothing the person waits on (a prompt, a transcript row) waits on it.
 */
function later($: Dollar, what: string, work: () => Promise<void>): void {
  $.clock.after(0, () => {
    work().catch(error => debug($, `${what} failed: ${String(error)}`))
  })
}

/**
 * Writes the nav with one compare-and-set; `change` null means no write is
 * needed. True once the nav holds the change, false when three tries all
 * lost the race (said in the debug log).
 */
async function writeNav($: Dollar, what: string, change: (nav: Nav) => Nav | null): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const held = await $.state.get(NAV)
    const next = change(held.value ?? EMPTY_NAV)
    if (next === null) return true
    const written = await $.state.set(NAV, next, { ifVersion: held.version })
    if (written.isSet) return true
  }
  debug($, `gave up writing the nav (${what}): three writes lost the race`)
  return false
}

/**
 * The person's prompts in the transcript, oldest first, and whether that is
 * the whole transcript. `$.session.messages()` holds the newest 4096 entries
 * only, so an answer of exactly 4096 counts as not whole too: at the limit
 * there is no telling a lost head from a transcript that happens to be 4096
 * entries long. When the read is refused (`{ deny }`), `texts` is empty,
 * `isWhole` is false and `deny` gives the reason.
 */
async function transcriptPrompts($: Dollar): Promise<{ texts: string[]; isWhole: boolean; deny?: string }> {
  // Typed wide on purpose: the main conversation's read is never denied by
  // the type, yet a `session.messages` hook may still answer `{ deny }`.
  const messages = (await $.session.messages()) as SessionMessagesResult
  if (!Array.isArray(messages)) return { texts: [], isWhole: false, deny: messages.deny }
  return { texts: userPromptTexts(messages), isWhole: messages.length < MESSAGES_LIMIT }
}

/**
 * Moves the prompts drawn rows showed into the nav. Reads the transcript
 * (to order them) only when one of them is new to the nav. A drawn prompt
 * leaves the buffer only once the nav holds it, so a failed write loses none.
 */
async function mergeBuffer($: Dollar): Promise<void> {
  if (renderBuffer.size === 0) return
  const drawn: PastPrompt[] = [...renderBuffer].map(([id, key]) => ({ id, key }))
  const held = await $.state.get(NAV)
  let isHeld = unknownPrompts(held.value ?? EMPTY_NAV, drawn).length === 0
  if (!isHeld) {
    const keys = (await transcriptPrompts($)).texts.map(promptKey)
    isHeld = await writeNav($, 'drawn prompts', current => withPastPrompts(current, drawn, keys))
  }
  if (!isHeld) return
  for (const p of drawn) {
    // A row drawn again meanwhile with another text stays for the next merge.
    if (renderBuffer.get(p.id) === p.key) renderBuffer.delete(p.id)
  }
}

/**
 * Runs the one summary of the session, if this caller wins the right to.
 * Called from timers only (onStart, the prompt.submit follow-up).
 */
async function startSummary($: Dollar, prompt: string): Promise<void> {
  const held = await $.state.get(SUMMARY)
  if (held.value !== undefined && held.value.status !== 'idle') return
  const pending: Summary = { status: 'pending', token: envToken }
  const won = await $.state.set(SUMMARY, pending, { ifVersion: held.version })
  if (!won.isSet) return
  // A timer of its own carries the model call: nothing waits on it, and it is
  // not cut short when whatever started it settles.
  $.clock.after(0, () => {
    void runSummary($, prompt, won.version)
  })
}

async function runSummary($: Dollar, prompt: string, pendingVersion: number): Promise<void> {
  let result: Summary
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system: SUMMARY_SYSTEM,
      prompt: summaryInput(prompt),
      maxTokens: 200,
      effort: 'low',
      timeoutMs: 60_000,
    })
    if (reply.isAnswered) {
      const text = summaryLine(reply.text)
      result = text === null ? { status: 'failed', reason: 'empty-reply' } : { status: 'done', text }
    } else {
      result = { status: 'failed', reason: reply.reason }
    }
  } catch (error) {
    result = { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
  if (result.status === 'failed') debug($, `the summary failed: ${result.reason}`)
  try {
    // Written only over our own `pending`: if anything wrote since (it was
    // marked interrupted), the version moved and this write misses.
    const written = await $.state.set(SUMMARY, result, { ifVersion: pendingVersion })
    if (!written.isSet) debug($, `the summary result was dropped: the summary changed while it ran`)
  } catch (error) {
    debug($, `could not store the summary: ${String(error)}`)
  }
}

/**
 * Fixes the first prompt once; true when this call fixed it. What is kept is
 * the prompt as the summary is sent it (cut to SUMMARY_INPUT_LIMIT), so a
 * huge first prompt does not sit whole in the state.
 */
async function fixFirstPrompt($: Dollar, prompt: string): Promise<boolean> {
  const held = await $.state.get(FIRST_PROMPT)
  if (held.value !== undefined && held.value !== null) return false
  const written = await $.state.set(FIRST_PROMPT, prompt, { ifVersion: held.version })
  return written.isSet
}

/** What `session.start` does, off the hook's own (awaited) dispatch. */
async function onStart($: Dollar): Promise<void> {
  // A summary another environment left pending can never finish now.
  const summary = await $.state.get(SUMMARY)
  if (summary.value?.status === 'pending' && summary.value.token !== envToken) {
    const marked = await $.state.set(
      SUMMARY,
      { status: 'failed', reason: 'interrupted' },
      { ifVersion: summary.version },
    )
    if (marked.isSet) debug($, 'a summary an earlier environment left pending is marked interrupted')
  }

  // A resumed session has prompts this process never saw submitted. Only a
  // whole transcript names its first prompt: past 4096 entries the head is
  // gone, and the oldest prompt left is not the session's first. A refused
  // read names none either.
  const first = await $.state.get(FIRST_PROMPT)
  let prompt = first.value ?? null
  if (prompt === null) {
    const { texts, isWhole, deny } = await transcriptPrompts($)
    const found = texts[0]
    if (deny !== undefined) {
      debug($, `could not read the transcript: ${deny}: its first prompt is not known`)
    } else if (!isWhole) {
      debug($, 'the transcript is longer than $.session.messages() returns: its first prompt is not known')
    } else if (found !== undefined) {
      const kept = summaryInput(found)
      if (await fixFirstPrompt($, kept)) prompt = kept
    }
  }
  if (prompt !== null) await startSummary($, prompt)
  await mergeBuffer($)
  await mergeHeads($)
}

async function move($: Dollar, kind: NavKind, surface: string): Promise<void> {
  try {
    if (renderBuffer.size > 0) await mergeBuffer($)
    const held = await $.state.get(NAV)
    const nav = withoutBadStops(held.value ?? EMPTY_NAV)
    const seen = seenOn(surface)
    const view = viewSpan(nav.promptIds, seen)
    const target = navTarget(kind, nav.promptIds, nav.cursorId, view)
    debug(
      $,
      `${kind} counts from ${navPosition(nav.promptIds, nav.cursorId, view)} ` +
        `(cursor ${nav.cursorId ?? 'end'}, view ${view === null ? 'none' : `${view.lo}..${view.hi} at ${view.at}`})`,
    )
    if (target === null) return
    debug($, `${kind} scrolls to ${target.id}`)
    // What the rows said of the old viewport no longer holds once it moves;
    // the rows the scroll brings on screen report afresh.
    seen.clear()
    // The reply's first row on top puts the prompt's own row just above it,
    // where the terminal's header names it, as when the person scrolls there.
    // A prompt whose reply was not drawn in this session lands on its own row.
    const head = headBuffer.get(target.id) ?? (await $.state.get(HEADS)).value?.[target.id]
    let scrolled = { deny: 'no reply row' } as { deny?: string }
    if (head !== undefined) {
      debug($, `asks for the reply row ${head}`)
      scrolled = await $.ui.scroll({ to: { requestId: head }, block: 'start' })
      if (scrolled.deny === undefined) debug($, `landed on the reply row ${head}`)
      else debug($, `could not scroll to the reply row ${head}: ${scrolled.deny}`)
    }
    if (scrolled.deny !== undefined) scrolled = await $.ui.scroll({ to: { requestId: target.id }, block: 'start' })
    if (scrolled.deny !== undefined) {
      debug($, `could not scroll to the prompt: ${scrolled.deny}`)
      return
    }
    await writeNav($, 'cursor', stored => {
      const current = withoutBadStops(stored)
      return current === stored && current.cursorId === target.id ? null : { ...current, cursorId: target.id }
    })
  } catch (error) {
    debug($, `navigation failed: ${String(error)}`)
  }
}

export const register: Register = on => {
  on('session.start', ($, e, next) => {
    // The first `session.start` is awaited before the first prompt: nothing
    // slow runs in it. The work goes to a timer.
    later($, 'start', () => onStart($))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    // Only what is read off the event is judged here; every state read and
    // write runs on a timer, so the prompt goes on without waiting for them.
    const text = e.text.trim()
    const isFirstCandidate =
      !('drop' in result && result.drop !== undefined) &&
      e.command === undefined &&
      e.isMeta === undefined &&
      isOwnPrompt(e.origin) &&
      text !== ''
    later($, 'prompt.submit', async () => {
      if (isFirstCandidate) {
        const kept = summaryInput(text)
        if (await fixFirstPrompt($, kept)) await startSummary($, kept)
      }
      await mergeBuffer($)
      await mergeHeads($)
    })
    return result
  }).catch(($, e, next) => next(e))

  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const result = await next(e)
    const isOwn =
      e.agentId === undefined &&
      e.message.type === 'user' &&
      e.message.isMeta === undefined &&
      isOwnPrompt(e.origin) &&
      result.deny === undefined
    const { uuid } = e
    if (isOwn) awaitingHead = uuid
    later($, 'session.append', async () => {
      if (isOwn) await writeNav($, 'new prompt', nav => withLivePrompt(nav, uuid))
      await mergeBuffer($)
      await mergeHeads($)
    })
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    // Drawing may not write state: remember the row, merge it later.
    const { origin, task, from, text } = e.props
    if (isStopId(e.requestId) && isOwnPrompt(origin, { task, from }) && text.trim() !== '') {
      renderBuffer.set(e.requestId, promptKey(text))
      if ('onScreen' in e.props && e.props.onScreen !== undefined) {
        seenOn(e.surface).set(e.requestId, e.props.onScreen)
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    noteReplyRow(e.requestId)
    return next(e)
  })

  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    noteReplyRow(e.requestId)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const firstPrompt = await read($, firstPromptAtom)
    const summary = await read($, summaryAtom)
    const nav = await read($, navAtom)

    const { Box, Button, Text } = $.ui.resolve(e)
    const room = Math.max(8, e.props.bodyColumns - BUTTONS_WIDTH)
    const left = bandText(firstPrompt, summary, room)
    const hasPrompts = nav.promptIds.length > 0

    return (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end" dimColor={left.kind === 'empty'}>
            {left.text}
            {left.note === undefined ? '' : <Text dimColor>{left.note}</Text>}
          </Text>
        </Box>
        <Box flexDirection="row" flexShrink={0} gap={BUTTON_GAP} marginLeft={BUTTONS_MARGIN}>
          {BUTTONS.map(b => (
            <Button
              key={b.kind}
              label={b.label}
              dimColor={!hasPrompts}
              onPress={() => move($, b.kind, e.surface)}
            />
          ))}
        </Box>
      </Box>
    )
  })
}
