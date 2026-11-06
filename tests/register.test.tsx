import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

const BAND = {
  plugin: 'session-compass',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const COMPOSER: PromptOrigin = { kind: 'composer' }
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

type Reply = { isAnswered: true; text: string } | { isAnswered: false; reason: 'api-error' | 'empty-reply' | 'aborted' }

/** The engine beneath the plugin: what each test needs answered. */
function engine(on: On, reply: Reply = { isAnswered: true, text: 'ログインバグの修正' }) {
  const clock = mock.clock(on)
  const calls = { complete: [] as string[], scroll: [] as string[], messages: 0 }
  const transcript: { role: 'user' | 'assistant'; text: string; toolUses: [] }[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', (_, e) => {
    calls.complete.push(e.prompt)
    const value =
      reply.isAnswered
        ? { isAnswered: true as const, text: reply.text, usage: USAGE }
        : reply.reason === 'api-error'
          ? { isAnswered: false as const, reason: 'api-error' as const, status: 500, error: 'api_error', usage: USAGE }
          : { isAnswered: false as const, reason: reply.reason, usage: USAGE }
    return { value } as never
  })
  on('session.messages', () => {
    calls.messages += 1
    return { value: transcript }
  })
  // The kit has no transcript to scroll, so `$.ui.scroll` to a row fails
  // there (the plugin catches it). The debug line the plugin writes just
  // before the call says which prompt it asked for.
  on('ui.log', (_, e) => {
    const asked = /scrolls to (\S+)$/.exec(e.text)
    if (asked?.[1] !== undefined) calls.scroll.push(asked[1])
    return { value: undefined }
  })
  return { clock, calls, transcript }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

async function say(
  $: Engine,
  uuid: string,
  text: string,
  origin: PromptOrigin = COMPOSER,
  extra: { isMeta?: true } = {},
) {
  await $.prompt.submit({ text, origin, wait: false, ...extra })
  await $.session.append({
    door: 'prompt',
    origin,
    uuid,
    message: { type: 'user', role: 'user', content: [{ type: 'text', text }], ...extra },
  })
}

test('with no prompt yet the band draws a placeholder and four buttons', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /まだプロンプトがありません/ }))).toBeDefined()
    for (const key of ['first', 'prev', 'next', 'latest']) {
      expect(await ui.find({ key })).toBeDefined()
    }
    // Pressing any button with nothing to go to throws nothing and scrolls nothing.
    for (const key of ['first', 'prev', 'next', 'latest']) {
      await ui.press({ key })
    }
    await ui.unmount()
  }
})

test('the first prompt is summarized once, and later prompts are not', async ($, on) => {
  const { clock, calls } = engine(on)
  await start($)
  await say($, 'u1', 'ログイン画面でエラーになるバグを直してほしい')
  await clock.settle()
  await say($, 'u2', '次はテストを追加して')
  await clock.settle()
  await say($, 'u3', 'ありがとう')
  await clock.settle()

  expect(calls.complete).toEqual(['ログイン画面でエラーになるバグを直してほしい'])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /ログインバグの修正/ }))).toBeDefined()
  await ui.unmount()
})

test('a summary that fails falls back to the cut first prompt', async ($, on) => {
  const { clock, calls } = engine(on, { isAnswered: false, reason: 'api-error' })
  await start($)
  await say($, 'u1', 'please fix\nthe login bug')
  await clock.settle()
  expect(calls.complete.length).toBe(1)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /please fix the login bug/ }))).toBeDefined()
  await ui.unmount()
})

test('while the summary runs the band shows the prompt with a note', async ($, on) => {
  const { calls } = engine(on)
  await start($)
  await say($, 'u1', 'write the docs')
  // The model call waits on a timer the clock has not run yet.
  expect(calls.complete.length).toBe(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /write the docs/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /要約中/ }))).toBeDefined()
  await ui.unmount()
})

test('session.start and prompt.submit racing still summarize once', async ($, on) => {
  const { clock, calls, transcript } = engine(on)
  // A resumed transcript: session.start's own pass finds this prompt too.
  transcript.push({ role: 'user', text: 'resumed prompt', toolUses: [] })
  await start($)
  await say($, 'u1', 'resumed prompt')
  await clock.settle()
  expect(calls.complete.length).toBe(1)
})

test('a resumed session summarizes its first transcript prompt', async ($, on) => {
  const { clock, calls, transcript } = engine(on)
  transcript.push(
    { role: 'user', text: 'the very first ask', toolUses: [] },
    { role: 'assistant', text: 'ok', toolUses: [] },
    { role: 'user', text: 'second ask', toolUses: [] },
  )
  await start($)
  await clock.settle()
  expect(calls.complete).toEqual(['the very first ask'])
})

test('a summary left pending by a lost environment is marked interrupted, not rerun', async ($, on) => {
  const { clock, calls } = engine(on)
  // What an environment before this reload stored.
  on('state.get', (_, e) => {
    if (e.key === 'summary') return { value: { value: { status: 'pending', token: 'gone' }, version: 3 } }
    if (e.key === 'firstPrompt') return { value: { value: 'fix the bug', version: 1 } }
    return { value: { value: undefined, version: 0 } }
  })
  const writes: unknown[] = []
  on('state.set', (_, e) => {
    writes.push({ key: e.key, value: e.value })
    return { value: { isSet: true, version: 4 } }
  })
  await start($)
  await clock.settle()
  expect(calls.complete.length).toBe(0)
  expect(writes).toContainEqual({ key: 'summary', value: { status: 'failed', reason: 'interrupted' } })
})

test('meta prompts, slash commands and others\' messages are not the first prompt', async ($, on) => {
  const { clock, calls } = engine(on)
  await start($)
  await $.prompt.submit({ text: 'reminder', origin: COMPOSER, wait: false, isMeta: true })
  await $.prompt.submit({ text: 'note from task', origin: { kind: 'task-notification' }, wait: false })
  await $.prompt.submit({ text: 'from a peer', origin: { kind: 'peer' }, wait: false })
  await clock.settle()
  expect(calls.complete.length).toBe(0)
  await $.prompt.submit({ text: 'the real one', origin: COMPOSER, wait: false })
  await clock.settle()
  expect(calls.complete).toEqual(['the real one'])
})

test('each button asks for the right prompt, and none goes past the ends', async ($, on) => {
  const { clock, calls } = engine(on)
  await start($)
  await say($, 'u1', 'one')
  await say($, 'u2', 'two')
  await say($, 'u3', 'three')
  // Not the person's: no stop for it.
  await say($, 'n1', 'notification', { kind: 'task-notification' })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'next' }) // at the latest: nowhere to go
  expect(calls.scroll).toEqual([])
  await ui.press({ key: 'prev' })
  await ui.press({ key: 'first' })
  await ui.press({ key: 'latest' })
  expect(calls.scroll).toEqual(['u3', 'u1', 'u3'])
  await ui.unmount()
})

test('from a prompt in the middle, prev and next step one each way', async ($, on) => {
  const { calls } = engine(on)
  on('state.get', (_, e) => {
    if (e.key === 'nav') {
      return {
        value: {
          value: { liveIds: ['u1', 'u2', 'u3'], pastPrompts: [], promptIds: ['u1', 'u2', 'u3'], cursorId: 'u2' },
          version: 5,
        },
      }
    }
    return { value: { value: undefined, version: 0 } }
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'prev' })
  await ui.press({ key: 'next' })
  expect(calls.scroll).toEqual(['u1', 'u3'])
  await ui.unmount()
})

test('at the ends prev and next stay on the end prompt', async ($, on) => {
  const { calls } = engine(on)
  let cursorId = 'u1'
  on('state.get', (_, e) => {
    if (e.key === 'nav') {
      return {
        value: { value: { liveIds: ['u1', 'u2'], pastPrompts: [], promptIds: ['u1', 'u2'], cursorId }, version: 1 },
      }
    }
    return { value: { value: undefined, version: 0 } }
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'prev' })
  cursorId = 'u2'
  await ui.press({ key: 'next' })
  expect(calls.scroll).toEqual(['u1', 'u2'])
  await ui.unmount()
})

test('prompts known only from drawn rows join the list in transcript order', async ($, on) => {
  const { clock, calls, transcript } = engine(on)
  transcript.push(
    { role: 'user', text: 'old one', toolUses: [] },
    { role: 'user', text: 'old two', toolUses: [] },
  )
  // The engine's own drawing of a row, beneath the plugin's pass-through.
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  await start($)
  await clock.settle()
  // Drawn newest first, as a resumed transcript scrolled back up would be.
  for (const [requestId, text] of [['r2', 'old two'], ['r1', 'old one']] as const) {
    const row = await $.ui.mount({
      plugin: 'session-compass',
      surface: 'terminal',
      component: 'UserMessage',
      requestId,
      props: { text, origin: COMPOSER, isExpanded: false },
    })
    await row.unmount()
  }
  // A drawn notification row is not the person's.
  const note = await $.ui.mount({
    plugin: 'session-compass',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'r9',
    props: { text: 'task done', origin: { kind: 'task-notification' }, isExpanded: false },
  })
  await note.unmount()
  await say($, 'u3', 'new one')
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'first' })
  await ui.press({ key: 'prev' })
  expect(calls.scroll).toEqual(['r1', 'u3'])
  await ui.unmount()
})

test('the two paths started at the same moment still summarize once', async ($, on) => {
  const { clock, calls, transcript } = engine(on)
  transcript.push({ role: 'user', text: 'same moment', toolUses: [] })
  await start($)
  await Promise.all([say($, 'u1', 'same moment'), clock.settle()])
  await clock.settle()
  expect(calls.complete.length).toBe(1)
})

test('the band yields to a survey', async ($, on) => {
  engine(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>survey</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ type: 'Text', text: /survey/ })).toBeDefined()
  expect(await ui.find({ key: 'first' })).toBeUndefined()
  await ui.unmount()
})
