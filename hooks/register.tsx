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
  structuredTitle,
  titleLine,
  unknownPrompts,
  typedText,
  userPromptTexts,
  copyViewport,
  emptyViewport,
  noteMove,
  noteReport,
  viewSpan,
  withLivePrompt,
  withPastPrompts,
  withPrompt,
  withoutBadStops,
  rowIdOf,
  firstPromptRow,
  drawnRowIds,
  parseRows,
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
const TITLE_TRIES = 5
/** The least time between two searches of the transcript after tool calls, in ms. */
const TOOL_SEARCH_GAP_MS = 2000
let lastToolSearch = 0

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

/**
 * Cells the summary takes above the question dialog: under the 40 columns
 * the dialog counts as one row.
 */
const QUESTION_COLUMNS = 39

/** Bytes of the transcript file's head ⏫ reads for the first prompt. */
const HEAD_BYTES = 2_000_000
/** Lines of the transcript file's tail ⏬ reads for the last row. */
const TAIL_LINES = 200
/** The newest rows ⏬ tries at most, newest first, until one is drawn here. */
const END_TRIES = 30

// The session's transcript file, as Claude Code's hooks name it; null until
// one has. It moves with a resume or a /clear, so each one sets it again.
let transcriptPath: string | null = null

/** The doors whose rows the transcript draws at its end: what ⏬ goes to. */
const NEWEST_DOORS: ReadonlySet<string> = new Set(['prompt', 'command', 'response'])
/** How many of the newest rows ⏬ keeps to try, newest last. */
const NEWEST_KEPT = 3

/** Screens the first button climbs at most, looking for earlier prompts. */
const WALK_STEPS = 12
/** How long the rows a climb brought into view get to draw, in ms. */
const WALK_WAIT_MS = 150

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

// The ids of the newest rows appended to the main conversation, newest last:
// where ⏬ goes. A reload empties it; the next row appended starts it again.
const newestRows: string[] = []

function noteNewestRow(id: string): void {
  const at = newestRows.indexOf(id)
  if (at !== -1) newestRows.splice(at, 1)
  newestRows.push(id)
  if (newestRows.length > NEWEST_KEPT) newestRows.shift()
}

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

/** How the summary is kept: `auto` after each prompt, `manual` on 🔁 (userConfig `summaryMode`). */
type SummaryMode = 'auto' | 'manual'
let summaryMode: SummaryMode = 'auto'

/**
 * Makes the summary again, one at a time, and nobody is making one now.
 *
 * `said` (a prompt, the session's start): in `auto` mode when the person has
 * said more since it was made, and once it is done it looks again, so a
 * prompt said while it ran is not left out; in `manual` mode only the first
 * summary of the session. `asked` (🔁 pressed): whenever there is a prompt.
 * Once the session has a ticket, the band shows that instead and no summary
 * is made.
 */
async function startSummary($: Dollar, why: 'said' | 'asked'): Promise<void> {
  if ((await $.state.get(TICKET)).value) return
  const prompts = (await $.state.get(PROMPTS)).value ?? []
  const held = await $.state.get(SUMMARY)
  const summary = held.value
  if (summary?.status === 'pending') return
  if (prompts.length === 0) return
  const basis = summaryBasis(summary)
  if (why === 'said' && (summaryMode === 'manual' ? basis > 0 : prompts.length <= basis)) return
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
  if (result.status === 'done') await startSummary($, 'said')
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
async function findTicketTitle($: Dollar, mayAskModel: boolean): Promise<void> {
  const held = await $.state.get(TICKET)
  const ticket = held.value
  if (!ticket || ticket.title !== null) return
  const messages = (await $.session.messages()) as SessionMessagesResult
  if (!Array.isArray(messages)) return
  const results = messages.flatMap(m => (m.toolResults ?? []).map(r => r.text))
  const texts = messages.flatMap(m => [m.text, ...(m.toolResults ?? []).map(r => r.text)])
  // A tracker's record a skill or tool read: the title, with no model.
  const recorded = structuredTitle(texts, ticket.id)
  if (recorded !== null) {
    debug($, `the title of ${ticket.id} is in a tool result`)
    await $.state.set(TICKET, { id: ticket.id, title: recorded, source: 'transcript' }, { ifVersion: held.version })
    return
  }
  if (!mayAskModel || (ticket.titleTries ?? 0) >= TITLE_TRIES) return
  // Asked again only once the transcript says more of the ticket.
  const mentionCount = texts.reduce((n, t) => n + t.split(ticket.id).length - 1, 0)
  if (mentionCount <= (ticket.mentionCount ?? 0)) return
  // Tool results first: where a skill read the ticket.
  const mentions = ticketMentions([...results, ...messages.map(m => m.text)], ticket.id)
  if (mentions === '') return
  const reply = await ask($, 'the ticket title', TICKET_TITLE_SYSTEM, `チケット ID: ${ticket.id}\n\n抜粋:\n${mentions}`, 120)
  const title = reply === null ? null : titleLine(reply)
  const next: Ticket =
    title === null
      ? { ...ticket, titleTries: (ticket.titleTries ?? 0) + 1, mentionCount }
      : { id: ticket.id, title, source: 'transcript' }
  await $.state.set(TICKET, next, { ifVersion: held.version })
}

/** What follows one of the person's prompts: keep it, look for a ticket, else summarize. */
async function onPrompt($: Dollar, line: string, args: string | undefined): Promise<void> {
  await keepPrompt($, line)
  if (await detectTicket($, line, args)) return
  await startSummary($, 'said')
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
        // A slash command with no arguments (`/clear`) says nothing to summarize.
        const said = texts.filter(t => !/^\/\S+$/.test(t))
        const prompts = said.map(t => promptLine(t)).reduce<string[]>((kept, line) => withPrompt(kept, line), [])
        await $.state.set(PROMPTS, prompts, { ifVersion: held.version })
      }
    }
  }
  if (prompt !== null) await startSummary($, 'said')
  await mergeBuffer($)
}

async function move($: Dollar, kind: NavKind, surface: string): Promise<void> {
  try {
    if (renderBuffer.size > 0) await mergeBuffer($)
    const held = await $.state.get(NAV)
    const nav = withoutBadStops(held.value ?? EMPTY_NAV)
    const viewport = viewOn(surface)
    const view = viewSpan(nav.promptIds, viewport.seen, viewport.sides)
    // Until the person scrolls, the last move is where they are; after, the viewport is.
    const isViewFirst = viewport.isHandScrolled
    const target = navTarget(kind, nav.promptIds, nav.cursorId, view, isViewFirst)
    debug(
      $,
      `${kind} counts from ${navPosition(nav.promptIds, nav.cursorId, view, isViewFirst)} ` +
        `(cursor ${nav.cursorId ?? 'end'}, view ${view === null ? 'none' : `${view.lo}..${view.hi} at ${view.at}`}` +
        `${isViewFirst ? ', scrolled by hand' : ''}, moving ${viewport.direction ?? 'unknown'})`,
    )
    // ⏫ and ⏬ go to the transcript's own first prompt and last row, read from
    // its file: rows far off screen are never drawn, so the band may not know them.
    if (kind === 'first' && (await toFirstOfFile($, surface, nav))) return
    if (kind === 'latest' && (await toEndOfFile($, surface, nav))) return
    if (target === null) return
    debug($, `${kind} scrolls to ${target.id}`)
    // What the rows said of the old viewport no longer holds once it moves;
    // the rows the scroll brings on screen report afresh. A scroll that does
    // not land leaves the viewport, and what is known of it, as it was.
    const before = copyViewport(viewport)
    noteMove(viewport, nav.promptIds, target.index, Date.now())
    // ⏬ goes to the end of the transcript: the bottom of the newest row on
    // the viewport's bottom. Where none of the newest rows can be reached, it
    // goes to the newest prompt, as the other buttons go to theirs.
    const landed = kind === 'latest' ? await scrollToEnd($) : false
    const denied = landed ? undefined : await scrollTo($, target.id, 'start')
    if (denied !== undefined) {
      viewBySurface.set(surface, before)
      debug($, `could not scroll to the prompt: ${denied}`)
      return
    }
    await setCursor($, target.id)
    if (target.index === 0) await walkUp($, surface, target.id)
  } catch (error) {
    debug($, `navigation failed: ${String(error)}`)
  }
}

/** What a command printed, or null where it could not run or failed. */
async function runText($: Dollar, argv: readonly string[]): Promise<string | null> {
  try {
    const run = await $.process.run(argv, { timeoutMs: 10_000 })
    if (run.exitCode === 0) return run.stdout
    debug($, `${argv[0]} exited ${run.exitCode}: ${run.stderr.trim().slice(0, 300)}`)
    return null
  } catch (error) {
    debug($, `could not run ${argv[0]}: ${String(error)}`)
    return null
  }
}

/** A transcript file of the session, with what picks it. */
type TranscriptFile = { path: string; size: number; mtimeMs: number }

/**
 * The session's transcript files. Claude Code keeps one per working folder
 * the session ran in, and the path its hooks name follows the folder the
 * session was started from, which may hold none (a resume started from
 * another folder). So beside that path, every folder under the projects
 * folder is looked in for a file of the same name.
 */
async function transcriptFiles($: Dollar): Promise<TranscriptFile[]> {
  if (transcriptPath === null) return []
  const cut = transcriptPath.lastIndexOf('/')
  const name = transcriptPath.slice(cut + 1)
  const projects = transcriptPath.slice(0, transcriptPath.slice(0, cut).lastIndexOf('/'))
  const paths = new Set<string>([transcriptPath])
  try {
    for (const entry of await $.fs.list(projects)) {
      if (entry.kind === 'dir') paths.add(`${projects}/${entry.name}/${name}`)
    }
  } catch (error) {
    debug($, `could not list ${projects}: ${String(error)}`)
  }
  const files: TranscriptFile[] = []
  for (const path of paths) {
    try {
      if (!(await $.fs.exists(path))) continue
      const stat = await $.fs.stat(path)
      files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs })
    } catch {
      // Gone meanwhile, or not readable: not one to read.
    }
  }
  if (files.length === 0) debug($, `no transcript file named ${name} under ${projects}`)
  return files
}

/**
 * ⏫ from the transcript file: puts the session's first prompt on top, by the
 * id its file gives, and makes it a stop if the band did not know it. False
 * where the file cannot be read or the scroll did not land.
 */
async function toFirstOfFile($: Dollar, surface: string, nav: Nav): Promise<boolean> {
  // The largest file holds the session from its start.
  let first: { id: string; text: string } | null = null
  for (const file of (await transcriptFiles($)).sort((a, b) => b.size - a.size)) {
    const head = await runText($, ['head', '-c', String(HEAD_BYTES), file.path])
    first = head === null ? null : firstPromptRow(parseRows(head))
    if (first !== null) break
  }
  if (first === null) return false
  const viewport = viewOn(surface)
  const before = copyViewport(viewport)
  const index = nav.promptIds.indexOf(first.id)
  noteMove(viewport, nav.promptIds, Math.max(0, index), Date.now())
  const denied = await scrollTo($, first.id, 'start')
  if (denied !== undefined) {
    viewBySurface.set(surface, before)
    debug($, `could not scroll to the transcript's first prompt ${first.id}: ${denied}`)
    return false
  }
  debug($, `first lands on ${first.id}, the transcript's first prompt`)
  if (index === -1) {
    const keys = (await transcriptPrompts($)).texts.map(promptKey)
    await writeNav($, 'first prompt', current =>
      withPastPrompts(withoutBadStops(current), [{ id: first.id, key: promptKey(first.text) }], keys),
    )
  }
  await setCursor($, first.id)
  return true
}

/**
 * ⏬ from the transcript file: puts the bottom of the row drawn lowest on the
 * viewport's bottom, by the id the file's last rows give, the cursor at the
 * end of the transcript. False where the file cannot be read or the scroll
 * did not land.
 */
async function toEndOfFile($: Dollar, surface: string, nav: Nav): Promise<boolean> {
  // The newest rows, newest file first: the file written last holds the
  // session's newest rows, though not all of them may be drawn here.
  const candidates: string[] = []
  for (const file of (await transcriptFiles($)).sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (candidates.length >= END_TRIES) break
    const tail = await runText($, ['tail', '-n', String(TAIL_LINES), file.path])
    if (tail === null) continue
    for (const id of drawnRowIds(parseRows(tail), END_TRIES)) {
      if (!candidates.includes(id)) candidates.push(id)
    }
  }
  if (candidates.length === 0) return false
  const viewport = viewOn(surface)
  const before = copyViewport(viewport)
  noteMove(viewport, nav.promptIds, nav.promptIds.length, Date.now())
  let last: string | null = null
  let skipped = 0
  for (const id of candidates.slice(0, END_TRIES)) {
    const denied = await scrollTo($, id, 'end')
    if (denied === undefined) {
      last = id
      break
    }
    skipped += 1
  }
  if (last === null) {
    viewBySurface.set(surface, before)
    debug($, `could not scroll to the end of any of the transcript's last ${skipped} rows`)
    return false
  }
  debug($, `latest lands on the end of ${last}, the transcript's last row${skipped > 0 ? ` drawn here (${skipped} newer not drawn)` : ''}`)
  await writeNav($, 'cursor', current => (current.cursorId === null ? null : { ...current, cursorId: null }))
  return true
}

/**
 * Puts the bottom of the newest row of the transcript on the viewport's
 * bottom, trying the newest rows appended, newest first; true once one
 * landed.
 */
async function scrollToEnd($: Dollar): Promise<boolean> {
  for (const id of [...newestRows].reverse()) {
    const denied = await scrollTo($, id, 'end')
    if (denied === undefined) {
      debug($, `latest lands on the end of ${id}`)
      return true
    }
    debug($, `could not scroll to the end of ${id}: ${denied}`)
  }
  return false
}

/** Writes the cursor (and drops stops that are no real messages). */
async function setCursor($: Dollar, id: string): Promise<void> {
  await writeNav($, 'cursor', stored => {
    const current = withoutBadStops(stored)
    return current === stored && current.cursorId === id ? null : { ...current, cursorId: id }
  })
}

/** Scrolls a row into view; the reason when it did not move. */
async function scrollTo($: Dollar, id: string, block: 'start' | 'end'): Promise<string | undefined> {
  try {
    return (await $.ui.scroll({ to: { requestId: id }, block })).deny
  } catch (error) {
    return String(error)
  }
}

/** Waits `ms` on the session's clock. */
function sleep($: Dollar, ms: number): Promise<void> {
  return new Promise(resolve => {
    $.clock.after(ms, () => resolve())
  })
}

/**
 * Climbs from the first prompt the mod knows to the session's first one.
 *
 * Only drawn rows tell their ids, and a long or resumed transcript draws
 * only the rows near the viewport, so the earliest prompt known may not be
 * the first. While the transcript holds more of the person's prompts than
 * the mod knows, it shows the screen above the known first prompt (that
 * prompt at the bottom), lets the rows there draw, and moves on to any
 * earlier prompt they show; at the last one found it puts that prompt on
 * top. It stops where the screen above shows no prompt (a reply longer than
 * the screen) or a scroll is refused.
 */
async function walkUp($: Dollar, surface: string, from: string): Promise<void> {
  const nav = withoutBadStops((await $.state.get(NAV)).value ?? EMPTY_NAV)
  const { texts } = await transcriptPrompts($)
  if (texts.length <= nav.promptIds.length) return
  debug($, `the transcript has ${texts.length} prompts, the band knows ${nav.promptIds.length}: looking above ${from}`)
  let current = from
  for (let step = 0; step < WALK_STEPS; step++) {
    const denied = await scrollTo($, current, 'end')
    if (denied !== undefined) {
      debug($, `could not look above ${current}: ${denied}`)
      break
    }
    await sleep($, WALK_WAIT_MS)
    if (renderBuffer.size > 0) await mergeBuffer($)
    const first = withoutBadStops((await $.state.get(NAV)).value ?? EMPTY_NAV).promptIds[0]
    if (first === undefined || first === current) break
    debug($, `found ${first} above ${current}`)
    current = first
  }
  const ids = withoutBadStops((await $.state.get(NAV)).value ?? EMPTY_NAV).promptIds
  noteMove(viewOn(surface), ids, Math.max(0, ids.indexOf(current)), Date.now())
  const denied = await scrollTo($, current, 'start')
  if (denied !== undefined) {
    debug($, `could not scroll to the prompt: ${denied}`)
    return
  }
  if (current !== from) await setCursor($, current)
}

export const register: Register = (on, options) => {
  summaryMode = options.summaryMode === 'manual' ? 'manual' : 'auto'

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

  // The newest rows of the main conversation, for ⏬: a prompt or a slash
  // command by its id, a reply by its last tool call's id (the tool row is
  // drawn below the reply's text) or else its own.
  on('session.append', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && result.deny === undefined && NEWEST_DOORS.has(e.door)) {
      noteNewestRow(rowIdOf(e.uuid, (e.message as { content?: unknown }).content))
    }
    return result
  }).catch(($, e, next) => next(e))

  // The transcript file's path, which ⏫ and ⏬ read: named by the classic
  // hooks' input, at the session's start (a resume included) and each prompt.
  on('classic.SessionStart', ($, e, next) => {
    transcriptPath = e.transcript_path
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.UserPromptSubmit', ($, e, next) => {
    transcriptPath = e.transcript_path
    return next(e)
  }).catch(($, e, next) => next(e))

  // A skill working on a ticket reads it with a tool; its result may hold the
  // title. Looked for (with no model) as each tool call of the session ends,
  // at most every TOOL_SEARCH_GAP_MS.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const now = Date.now()
    if (e.agentId === undefined && now - lastToolSearch >= TOOL_SEARCH_GAP_MS) {
      lastToolSearch = now
      later($, 'tool.call', () => findTicketTitle($, false))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's turn is not the session's.
    if (e.agentId === undefined) later($, 'turn.complete', () => findTicketTitle($, true))
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    // Drawing may not write state: remember the row, merge it later.
    const { origin, task, from, text } = e.props
    if (isStopId(e.requestId) && isOwnPrompt(origin, { task, from }) && text.trim() !== '') {
      renderBuffer.set(e.requestId, promptKey(typedText(text)))
      if ('onScreen' in e.props && e.props.onScreen !== undefined) {
        noteReport(viewOn(e.surface), e.requestId, e.props.onScreen, true, Date.now())
      }
    }
    return next(e)
  })

  // Reply rows tell which way the viewport moves, so a prompt row that jumps
  // out of view whole is known to be above it or below it.
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if ('onScreen' in e.props && e.props.onScreen !== undefined) {
      noteReport(viewOn(e.surface), e.requestId, e.props.onScreen, false, Date.now())
    }
    return next(e)
  })

  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    if ('onScreen' in e.props && e.props.onScreen !== undefined) {
      noteReport(viewOn(e.surface), e.requestId, e.props.onScreen, false, Date.now())
    }
    return next(e)
  })

  // The question dialog takes the prompt's place, the band with it: the
  // ticket or summary goes above the dialog instead, on one row (the dialog
  // counts each 40 columns a row, its tree held to 12 on the terminal), with
  // no buttons.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const dialog = await next(e)
    const firstPrompt = await read($, firstPromptAtom)
    const summary = await read($, summaryAtom)
    const ticket = await read($, ticketAtom)
    const { Box, Text } = $.ui.resolve(e)
    let line: JSX.Element
    if (ticket) {
      const shown = ticketBand(ticket, QUESTION_COLUMNS)
      line = (
        <Text wrap="truncate-end" weight="bold">
          <Text color="suggestion">{shown.id}</Text>
          {shown.title === '' ? '' : <Text color="claude">{` ${shown.title}`}</Text>}
        </Text>
      )
    } else {
      const band = bandText(firstPrompt, summary, QUESTION_COLUMNS)
      if (band.kind === 'empty') return dialog
      // No dim note here: the row is the summary's alone.
      line = (
        <Text wrap="truncate-end" color="claude" weight="bold">
          {band.kind === 'pending' ? bandText(firstPrompt, { status: 'idle' }, QUESTION_COLUMNS).text : band.text}
        </Text>
      )
    }
    return (
      <Box flexDirection="column">
        {line}
        {dialog}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const firstPrompt = await read($, firstPromptAtom)
    const summary = await read($, summaryAtom)
    const nav = await read($, navAtom)
    const ticket = await read($, ticketAtom)

    const { Box, Button, Text } = $.ui.resolve(e)
    const canRefresh = summaryMode === 'manual' && !ticket
    const room = Math.max(8, e.props.bodyColumns - BUTTONS_WIDTH - (canRefresh ? BUTTON_CELLS + BUTTON_GAP : 0))
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
          {canRefresh ? (
            <Button
              key="refresh"
              label="🔁"
              dimColor={summary.status === 'pending' || !hasPrompts}
              onPress={() => startSummary($, 'asked').catch(error => debug($, `refresh failed: ${String(error)}`))}
            />
          ) : null}
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
