import { atom, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Nav, PastPrompt, Summary } from '../types'
import {
  EMPTY_NAV,
  bandText,
  isOwnPrompt,
  navTarget,
  summaryInput,
  summaryLine,
  userPromptTexts,
  withLivePrompt,
  withPastPrompts,
} from './logic'
import type { NavKind } from './logic'

const FIRST_PROMPT = { plugin: 'session-compass', key: 'firstPrompt' } as const
const SUMMARY = { plugin: 'session-compass', key: 'summary' } as const
const NAV = { plugin: 'session-compass', key: 'nav' } as const

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

/** Cells the button row takes on the terminal: `[ ⏫ ]` is 6, plus 1 between each, plus 1 before. */
const BUTTONS_WIDTH = BUTTONS.length * 6 + BUTTONS.length

type Dollar = EngineInterface

// One token per module environment: a `pending` summary that names another
// token was started by an environment that is gone (reload, respawn).
const envToken = crypto.randomUUID()

// Prompts seen by drawing their rows. A render hook may not write state, so
// they wait here until a hook outside drawing merges them (mergeBuffer).
// A reload empties it; the rows fire `UserMessage` again when redrawn.
const renderBuffer = new Map<string, string>()

/** Writes the nav with one compare-and-set; `change` null means no write. */
async function writeNav($: Dollar, change: (nav: Nav) => Nav | null): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const held = await $.state.get(NAV)
    const next = change(held.value ?? EMPTY_NAV)
    if (next === null) return
    const written = await $.state.set(NAV, next, { ifVersion: held.version })
    if (written.isSet) return
  }
}

/**
 * Moves the prompts drawn rows showed into the nav. Reads the transcript
 * (to order them) only when one of them is new to the nav.
 */
async function mergeBuffer($: Dollar): Promise<void> {
  if (renderBuffer.size === 0) return
  const drawn: PastPrompt[] = [...renderBuffer].map(([id, text]) => ({ id, text }))
  for (const p of drawn) renderBuffer.delete(p.id)
  const held = await $.state.get(NAV)
  const nav = held.value ?? EMPTY_NAV
  if (withPastPrompts(nav, drawn, []) === null) return
  const messages = await $.session.messages()
  const texts = 'deny' in messages ? [] : userPromptTexts(messages)
  await writeNav($, current => withPastPrompts(current, drawn, texts))
}

/** Runs the one summary of the session, if this caller wins the right to. */
async function startSummary($: Dollar, prompt: string): Promise<void> {
  const held = await $.state.get(SUMMARY)
  if (held.value !== undefined && held.value.status !== 'idle') return
  const pending: Summary = { status: 'pending', token: envToken }
  const won = await $.state.set(SUMMARY, pending, { ifVersion: held.version })
  if (!won.isSet) return
  // A timer, not the hook's own dispatch, carries the model call: it is not
  // cut short when the hook that started it settles, and nothing waits on it.
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
  try {
    // Written only over our own `pending`: if anything wrote since (it was
    // marked interrupted), the version moved and this write misses.
    await $.state.set(SUMMARY, result, { ifVersion: pendingVersion })
  } catch (error) {
    $.ui.log(`session-compass: could not store the summary: ${String(error)}`, { to: 'debug' })
  }
}

/** Fixes the first prompt once; true when this call fixed it. */
async function fixFirstPrompt($: Dollar, text: string): Promise<boolean> {
  const held = await $.state.get(FIRST_PROMPT)
  if (held.value !== undefined && held.value !== null) return false
  const written = await $.state.set(FIRST_PROMPT, text, { ifVersion: held.version })
  return written.isSet
}

/** What `session.start` does, off the hook's own (awaited) dispatch. */
async function onStart($: Dollar): Promise<void> {
  // A summary another environment left pending can never finish now.
  const summary = await $.state.get(SUMMARY)
  if (summary.value?.status === 'pending' && summary.value.token !== envToken) {
    await $.state.set(
      SUMMARY,
      { status: 'failed', reason: 'interrupted' },
      { ifVersion: summary.version },
    )
  }

  // A resumed session has prompts this process never saw submitted.
  const first = await $.state.get(FIRST_PROMPT)
  let prompt = first.value ?? null
  if (prompt === null) {
    const messages = await $.session.messages()
    const texts = 'deny' in messages ? [] : userPromptTexts(messages)
    const found = texts[0]
    if (found !== undefined && (await fixFirstPrompt($, found))) prompt = found
  }
  if (prompt !== null) await startSummary($, prompt)
  await mergeBuffer($)
}

async function move($: Dollar, kind: NavKind): Promise<void> {
  try {
    if (renderBuffer.size > 0) await mergeBuffer($)
    const held = await $.state.get(NAV)
    const nav = held.value ?? EMPTY_NAV
    const target = navTarget(kind, nav.promptIds, nav.cursorId)
    if (target === null) return
    const id = nav.promptIds[target.index]
    if (id === undefined) return
    $.ui.log(`session-compass: ${kind} scrolls to ${id}`, { to: 'debug' })
    const scrolled = await $.ui.scroll({ to: { requestId: id }, block: 'start' })
    if (scrolled.deny !== undefined) {
      $.ui.log(`session-compass: could not scroll to the prompt: ${scrolled.deny}`, { to: 'debug' })
      return
    }
    await writeNav($, current =>
      current.cursorId === target.cursorId ? null : { ...current, cursorId: target.cursorId },
    )
  } catch (error) {
    $.ui.log(`session-compass: navigation failed: ${String(error)}`, { to: 'debug' })
  }
}

export const register: Register = on => {
  on('session.start', ($, e, next) => {
    // The first `session.start` is awaited before the first prompt: nothing
    // slow runs in it. The work goes to a timer.
    $.clock.after(0, () => {
      onStart($).catch(error => $.ui.log(`session-compass: start failed: ${String(error)}`, { to: 'debug' }))
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    try {
      const text = e.text.trim()
      const isFirstCandidate =
        !('drop' in result && result.drop !== undefined) &&
        e.command === undefined &&
        e.isMeta === undefined &&
        isOwnPrompt(e.origin) &&
        text !== ''
      if (isFirstCandidate && (await fixFirstPrompt($, text))) {
        await startSummary($, text)
      }
      await mergeBuffer($)
    } catch (error) {
      $.ui.log(`session-compass: prompt.submit failed: ${String(error)}`, { to: 'debug' })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const result = await next(e)
    try {
      const isOwn =
        e.agentId === undefined &&
        e.message.type === 'user' &&
        e.message.isMeta === undefined &&
        isOwnPrompt(e.origin)
      if (isOwn && result.deny === undefined) {
        await writeNav($, nav => withLivePrompt(nav, e.uuid))
      }
      await mergeBuffer($)
    } catch (error) {
      $.ui.log(`session-compass: session.append failed: ${String(error)}`, { to: 'debug' })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    // Drawing may not write state: remember the row, merge it later.
    const { origin, task, from, text } = e.props
    if (isOwnPrompt(origin, { task, from }) && text.trim() !== '') {
      renderBuffer.set(e.requestId, text)
    }
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
        <Box flexDirection="row" flexShrink={0} gap={1} marginLeft={1}>
          {BUTTONS.map(b => (
            <Button
              key={b.kind}
              label={b.label}
              dimColor={!hasPrompts}
              onPress={() => move($, b.kind)}
            />
          ))}
        </Box>
      </Box>
    )
  })
}
