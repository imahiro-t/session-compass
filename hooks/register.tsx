import { atom, read } from 'claude-code'
import type { EngineInterface, Register, SessionMessagesResult } from 'claude-code'

import type { Nav, PastPrompt, Summary, Ticket } from '../types'
import {
  EMPTY_NAV,
  bandText,
  graphTicketTitle,
  isOwnPrompt,
  isYes,
  lastSummaryText,
  isStopId,
  navPosition,
  navTarget,
  promptKey,
  promptLine,
  summaryBasis,
  summaryInput,
  summaryLine,
  summaryPrompts,
  ticketBand,
  ticketCandidates,
  ticketMentions,
  titleLine,
  unknownPrompts,
  userPromptTexts,
  emptyViewport,
  noteMove,
  noteReport,
  viewSpan,
  withLivePrompt,
  withPastPrompts,
  withPrompt,
  withoutBadStops,
} from './logic'
import type { NavKind, Viewport } from './logic'

const FIRST_PROMPT = { plugin: 'session-compass', key: 'firstPrompt' } as const
const SUMMARY = { plugin: 'session-compass', key: 'summary' } as const
const NAV = { plugin: 'session-compass', key: 'nav' } as const
const PROMPTS = { plugin: 'session-compass', key: 'prompts' } as const
const TICKET = { plugin: 'session-compass', key: 'ticket' } as const

const firstPromptAtom = atom(FIRST_PROMPT, null)
const summaryAtom = atom(SUMMARY, { status: 'idle' })
const navAtom = atom(NAV, EMPTY_NAV)
const ticketAtom = atom(TICKET, null)

const SUMMARY_SYSTEM =
  'あなたはセッションの要約を書く。番号順に並んだユーザーの依頼（1 番がセッション最初の依頼、以降は新しいもの）から、このセッションで今取り組んでいることを 1 行（全角 40 字程度）で要約する。話題が移っていれば新しい話題を中心に、全体の流れが分かるように書く。前置き・引用符・句点以外の記号は不要で、要約だけを出力する。'

const TICKET_WORK_SYSTEM =
  'ユーザーの依頼が、指定されたチケット（課題管理ツールのチケット）そのものに取り組む・対応する・処理する依頼なら yes、チケットに触れているだけ（質問・参照・比較など）なら no とだけ答える。'

const TICKET_TITLE_SYSTEM =
  '与えられた抜粋から、指定されたチケット ID のチケットのタイトル（件名・summary）を、書かれているとおりに 1 行で答える。抜粋にタイトルが書かれていなければ NONE とだけ答える。推測はしない。'

/** The executable that answers for graph-ops tickets. */
const GRAPH_ENGINE = 'graph-engine'
/** Transcript searches for a ticket's title before giving up. */
const TITLE_TRIES = 3

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
const viewBySurface = new Map<string, Viewport>()

function viewOn(surface: string): Viewport {
  let view = viewBySurface.get(surface)
  if (view === undefined) {
    view = emptyViewport()
    viewBySurface.set(surface, view)
  }
  return view
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

/** One model call, its reply as text, or null (said in the debug log). */
async function ask($: Dollar, what: string, system: string, prompt: string, maxTokens = 200): Promise<string | null> {
  try {
    const reply = await $.model.complete({ model: 'haiku', system, prompt, maxTokens, effort: 'low', timeoutMs: 60_000 })
    if (reply.isAnswered) return reply.text
    debug($, `${what} got no answer: ${reply.reason}`)
  } catch (error) {
    debug($, `${what} failed: ${String(error)}`)
  }
  return null
}

/** Keeps one more of the person's prompts; the kept list, or null if every write lost. */
async function keepPrompt($: Dollar, line: string): Promise<string[] | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const held = await $.state.get(PROMPTS)
    const prompts = withPrompt(held.value ?? [], line)
    if (prompts.length === (held.value ?? []).length) return prompts
    const written = await $.state.set(PROMPTS, prompts, { ifVersion: held.version })
    if (written.isSet) return prompts
  }
  debug($, 'gave up keeping a prompt: three writes lost the race')
  return null
}

/**
 * Makes the summary again when the person has said more since it was made,
 * and nobody is making one now: one at a time, and once it is done it looks
 * again, so a prompt said while it ran is not left out. Called from timers
 * only. Once the session has a ticket, the band shows that instead and no
 * summary is made.
 */
async function startSummary($: Dollar): Promise<void> {
  if ((await $.state.get(TICKET)).value) return
  const prompts = (await $.state.get(PROMPTS)).value ?? []
  const held = await $.state.get(SUMMARY)
  const summary = held.value
  if (summary?.status === 'pending') return
  if (prompts.length === 0 || prompts.length <= summaryBasis(summary)) return
  const text = lastSummaryText(summary)
  const pending: Summary = { status: 'pending', token: envToken, basis: prompts.length, ...(text === undefined ? {} : { text }) }
  const won = await $.state.set(SUMMARY, pending, { ifVersion: held.version })
  if (!won.isSet) return
  // A timer of its own carries the model call: nothing waits on it, and it is
  // not cut short when whatever started it settles.
  $.clock.after(0, () => {
    void runSummary($, prompts, text, won.version)
  })
}

async function runSummary($: Dollar, prompts: readonly string[], previous: string | undefined, pendingVersion: number): Promise<void> {
  const basis = prompts.length
  const keep = previous === undefined ? {} : { text: previous }
  let result: Summary
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system: SUMMARY_SYSTEM,
      prompt: summaryPrompts(prompts),
      maxTokens: 200,
      effort: 'low',
      timeoutMs: 60_000,
    })
    if (reply.isAnswered) {
      const text = summaryLine(reply.text)
      result = text === null ? { status: 'failed', reason: 'empty-reply', basis, ...keep } : { status: 'done', text, basis }
    } else {
      result = { status: 'failed', reason: reply.reason, basis, ...keep }
    }
  } catch (error) {
    result = { status: 'failed', reason: error instanceof Error ? error.message : String(error), basis, ...keep }
  }
  if (result.status === 'failed') debug($, `the summary failed: ${result.reason}`)
  try {
    // Written only over our own `pending`: if anything wrote since (it was
    // marked interrupted), the version moved and this write misses.
    const written = await $.state.set(SUMMARY, result, { ifVersion: pendingVersion })
    if (!written.isSet) {
      debug($, `the summary result was dropped: the summary changed while it ran`)
      return
    }
  } catch (error) {
    debug($, `could not store the summary: ${String(error)}`)
    return
  }
  // The person may have said more while it ran.
  if (result.status === 'done') await startSummary($)
}

/** The title graph-ops holds for the ticket, or null where it has none or cannot be asked. */
async function graphOpsTitle($: Dollar, id: string): Promise<string | null> {
  try {
    const run = await $.process.run([GRAPH_ENGINE, 'get-ticket', id], { timeoutMs: 15_000 })
    if (run.exitCode !== 0) return null
    return graphTicketTitle(run.stdout, id)
  } catch {
    // graph-engine is not installed here, or did not answer in time.
    return null
  }
}

/** Stores the ticket the session works on, unless one is already stored. */
async function fixTicket($: Dollar, ticket: Ticket): Promise<boolean> {
  const held = await $.state.get(TICKET)
  if (held.value) return false
  const written = await $.state.set(TICKET, ticket, { ifVersion: held.version })
  if (written.isSet) debug($, `the session works on ${ticket.id} (${ticket.source})`)
  return written.isSet
}

/**
 * Looks for a ticket the prompt asks to work on. A slash command naming the
 * id in its arguments asks to; a prompt that names it is judged by the
 * model, so a ticket only mentioned in passing is no ticket of the session.
 * True once the session has a ticket.
 */
async function detectTicket($: Dollar, line: string, args: string | undefined): Promise<boolean> {
  if ((await $.state.get(TICKET)).value) return true
  for (const id of ticketCandidates(line)) {
    const isCommandArg = args !== undefined && ticketCandidates(args).includes(id)
    if (!isCommandArg) {
      const reply = await ask($, 'the ticket check', TICKET_WORK_SYSTEM, `チケット ID: ${id}\n\n依頼:\n${line}`, 5)
      if (reply === null || !isYes(reply)) continue
    }
    const title = await graphOpsTitle($, id)
    const ticket: Ticket = title === null ? { id, title: null, source: 'prompt' } : { id, title, source: 'graph-ops' }
    await fixTicket($, ticket)
    return true
  }
  return false
}

/**
 * Looks in the transcript for the title of the session's ticket while it is
 * not known (a Jira ticket a skill or a tool read, say); at most TITLE_TRIES
 * searches that find a mention but no title. Called after each turn.
 */
async function findTicketTitle($: Dollar): Promise<void> {
  const held = await $.state.get(TICKET)
  const ticket = held.value
  if (!ticket || ticket.title !== null || (ticket.titleTries ?? 0) >= TITLE_TRIES) return
  const messages = (await $.session.messages()) as SessionMessagesResult
  if (!Array.isArray(messages)) return
  const texts = messages.flatMap(m => [m.text, ...(m.toolResults ?? []).map(r => r.text)])
  const mentions = ticketMentions(texts, ticket.id)
  if (mentions === '') return
  const reply = await ask($, 'the ticket title', TICKET_TITLE_SYSTEM, `チケット ID: ${ticket.id}\n\n抜粋:\n${mentions}`, 120)
  const title = reply === null ? null : titleLine(reply)
  const next: Ticket =
    title === null ? { ...ticket, titleTries: (ticket.titleTries ?? 0) + 1 } : { id: ticket.id, title, source: 'transcript' }
  await $.state.set(TICKET, next, { ifVersion: held.version })
}

/** What follows one of the person's prompts: keep it, look for a ticket, else summarize. */
async function onPrompt($: Dollar, line: string, args: string | undefined): Promise<void> {
  await keepPrompt($, line)
  if (await detectTicket($, line, args)) return
  await startSummary($)
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
    const { basis, text } = summary.value
    const marked = await $.state.set(
      SUMMARY,
      { status: 'failed', reason: 'interrupted', ...(basis === undefined ? {} : { basis }), ...(text === undefined ? {} : { text }) },
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
      // The prompts it said, for the summary, unless some are kept already.
      const held = await $.state.get(PROMPTS)
      if ((held.value ?? []).length === 0) {
        const prompts = texts.map(t => promptLine(t)).reduce<string[]>((kept, line) => withPrompt(kept, line), [])
        await $.state.set(PROMPTS, prompts, { ifVersion: held.version })
      }
    }
  }
  if (prompt !== null) await startSummary($)
  await mergeBuffer($)
}

async function move($: Dollar, kind: NavKind, surface: string): Promise<void> {
  try {
    if (renderBuffer.size > 0) await mergeBuffer($)
    const held = await $.state.get(NAV)
    const nav = withoutBadStops(held.value ?? EMPTY_NAV)
    const viewport = viewOn(surface)
    const view = viewSpan(nav.promptIds, viewport.seen, viewport.sides)
    const target = navTarget(kind, nav.promptIds, nav.cursorId, view)
    debug(
      $,
      `${kind} counts from ${navPosition(nav.promptIds, nav.cursorId, view)} ` +
        `(cursor ${nav.cursorId ?? 'end'}, view ${view === null ? 'none' : `${view.lo}..${view.hi} at ${view.at}`})`,
    )
    if (target === null) return
    debug($, `${kind} scrolls to ${target.id}`)
    // What the rows said of the old viewport no longer holds once it moves;
    // the rows the scroll brings on screen report afresh. A scroll that does
    // not land leaves the viewport, and what is known of it, as it was.
    const before = { seen: new Map(viewport.seen), sides: new Map(viewport.sides) }
    noteMove(viewport, nav.promptIds, target.index)
    let scrolled: { deny?: string }
    try {
      scrolled = await $.ui.scroll({ to: { requestId: target.id }, block: 'start' })
    } catch (error) {
      scrolled = { deny: String(error) }
    }
    if (scrolled.deny !== undefined) {
      viewport.seen = before.seen
      viewport.sides = before.sides
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
    const isOwn =
      !('drop' in result && result.drop !== undefined) && e.isMeta === undefined && isOwnPrompt(e.origin)
    const isFirstCandidate = isOwn && e.command === undefined && text !== ''
    // A slash command counts as said when it carries arguments (a skill run on
    // a ticket, say); one with none (`/clear`, `/config`) says nothing.
    const isSaid = isOwn && (e.command === undefined ? text !== '' : e.command.args.trim() !== '')
    const line = isSaid ? promptLine(text, e.command) : ''
    const args = e.command?.args
    later($, 'prompt.submit', async () => {
      if (isFirstCandidate) await fixFirstPrompt($, summaryInput(text))
      if (isSaid) await onPrompt($, line, args)
      await mergeBuffer($)
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
    later($, 'session.append', async () => {
      if (isOwn) await writeNav($, 'new prompt', nav => withLivePrompt(nav, uuid))
      await mergeBuffer($)
    })
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's turn is not the session's.
    if (e.agentId === undefined) later($, 'turn.complete', () => findTicketTitle($))
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    // Drawing may not write state: remember the row, merge it later.
    const { origin, task, from, text } = e.props
    if (isStopId(e.requestId) && isOwnPrompt(origin, { task, from }) && text.trim() !== '') {
      renderBuffer.set(e.requestId, promptKey(text))
      if ('onScreen' in e.props && e.props.onScreen !== undefined) {
        noteReport(viewOn(e.surface), e.requestId, e.props.onScreen)
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const firstPrompt = await read($, firstPromptAtom)
    const summary = await read($, summaryAtom)
    const nav = await read($, navAtom)
    const ticket = await read($, ticketAtom)

    const { Box, Button, Text } = $.ui.resolve(e)
    const room = Math.max(8, e.props.bodyColumns - BUTTONS_WIDTH)
    const hasPrompts = nav.promptIds.length > 0

    let left: JSX.Element
    if (ticket) {
      const shown = ticketBand(ticket, room)
      left = (
        <Text wrap="truncate-end" weight="bold">
          <Text color="suggestion">{shown.id}</Text>
          {shown.title === '' ? '' : <Text color="claude">{` ${shown.title}`}</Text>}
        </Text>
      )
    } else {
      const band = bandText(firstPrompt, summary, room)
      left =
        band.kind === 'empty' ? (
          <Text wrap="truncate-end" dimColor>
            {band.text}
          </Text>
        ) : (
          <Text wrap="truncate-end" color="claude" weight="bold">
            {band.text}
            {band.note === undefined ? '' : <Text dimColor weight="regular">{band.note}</Text>}
          </Text>
        )
    }

    return (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexGrow={1} flexShrink={1}>
          {left}
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
