import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'
import type { Nav } from '../types'
import { oneLine, textWidth } from '../hooks/logic'

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
function engine(
  on: On,
  reply: Reply = { isAnswered: true, text: 'ログインバグの修正' },
  options: {
    modelDelayMs?: number
    messagesFailures?: number
    messagesDeny?: string
    /** A reply of its own for some calls, by the call's system prompt. */
    answer?: (system: string, prompt: string) => string | undefined
  } = {},
) {
  const clock = mock.clock(on)
  const calls = { complete: [] as string[], scroll: [] as string[], messages: 0, logs: [] as string[] }
  const transcript: { role: 'user' | 'assistant'; text: string; toolUses: [] }[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', async (_, e) => {
    calls.complete.push(e.prompt)
    if (options.modelDelayMs !== undefined) await clock.sleep(options.modelDelayMs)
    const own = options.answer?.(e.system ?? '', e.prompt)
    if (own !== undefined) return { value: { isAnswered: true as const, text: own, usage: USAGE } } as never
    const value =
      reply.isAnswered
        ? { isAnswered: true as const, text: reply.text, usage: USAGE }
        : reply.reason === 'api-error'
          ? { isAnswered: false as const, reason: 'api-error' as const, status: 500, error: 'api_error', usage: USAGE }
          : { isAnswered: false as const, reason: reply.reason, usage: USAGE }
    return { value } as never
  })
  let messagesFailures = options.messagesFailures ?? 0
  on('session.messages', () => {
    calls.messages += 1
    if (messagesFailures > 0) {
      messagesFailures -= 1
      throw new Error('transcript unreadable')
    }
    if (options.messagesDeny !== undefined) return { value: { deny: options.messagesDeny } }
    return { value: transcript }
  })
  // The kit has no transcript to scroll, so `$.ui.scroll` to a row fails
  // there (the plugin catches it), and the cursor does not move. The debug
  // line the plugin writes just before the call says which prompt it asked
  // for; tests that need the cursor somewhere give the nav as stored.
  on('ui.log', (_, e) => {
    calls.logs.push(e.text)
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

test('the summary is made again each time the person says more', async ($, on) => {
  const { clock, calls } = engine(on)
  await start($)
  await say($, 'u1', 'ログイン画面でエラーになるバグを直してほしい')
  await clock.settle()
  await say($, 'u2', '次はテストを追加して')
  await clock.settle()
  await say($, 'u3', 'ありがとう')
  await clock.settle()

  expect(calls.complete).toEqual([
    '1. ログイン画面でエラーになるバグを直してほしい',
    '1. ログイン画面でエラーになるバグを直してほしい\n2. 次はテストを追加して',
    '1. ログイン画面でエラーになるバグを直してほしい\n2. 次はテストを追加して\n3. ありがとう',
  ])
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
  const { clock, calls } = engine(on, undefined, { modelDelayMs: 1000 })
  await start($)
  await say($, 'u1', 'write the docs')
  await clock.settle()
  // The model has been asked and has not answered yet.
  expect(calls.complete.length).toBe(1)
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
  expect(calls.complete).toEqual(['1. the very first ask\n2. second ask'])
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
  expect(calls.complete).toEqual(['1. the real one'])
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

test('after latest, prev steps to the prompt before the newest and next comes back to the newest', async ($, on) => {
  const { calls } = engine(on)
  // The nav lives in a versioned store, so what the plugin writes with
  // `state.set` (compare-and-set on the version) is what it reads next.
  const nav: Nav = { liveIds: ['u1', 'u2', 'u3'], pastPrompts: [], promptIds: ['u1', 'u2', 'u3'], cursorId: null }
  const store = new Map<string, { value: unknown; version: number }>([['nav', { value: nav, version: 1 }]])
  on('state.get', (_, e) => ({ value: store.get(e.key) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', (_, e) => {
    const held = store.get(e.key) ?? { value: undefined, version: 0 }
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) {
      return { value: { isSet: false, version: held.version } }
    }
    const written = { value: e.value, version: held.version + 1 }
    store.set(e.key, written)
    return { value: { isSet: true, version: written.version } }
  })
  const cursor = () => (store.get('nav')?.value as Nav).cursorId
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // The kit's `$.ui.scroll` to a row never lands, so the plugin never writes
  // the cursor itself. After each press that asked for a prompt, write what
  // `move()` writes once its scroll landed: the cursor on that prompt.
  async function pressAndLand(key: 'prev' | 'next' | 'latest') {
    const asked = calls.scroll.length
    await ui.press({ key })
    const target = calls.scroll[asked]
    if (target === undefined) return
    const held = store.get('nav')!
    store.set('nav', { value: { ...(held.value as Nav), cursorId: target }, version: held.version + 1 })
  }
  await pressAndLand('latest')
  expect(cursor()).toBe('u3')
  await pressAndLand('prev')
  // 🔽 is pressed with the cursor on u2, not left on the newest prompt.
  expect(cursor()).toBe('u2')
  await pressAndLand('next')
  expect(calls.scroll).toEqual(['u3', 'u2', 'u3'])
  expect(cursor()).toBe('u3')
  await ui.unmount()
})

test('the prompt goes on before the band\'s state is written', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await clock.settle()
  await say($, 'u1', 'write the docs')
  // The state writes wait on a timer the clock has not run yet.
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /まだプロンプトがありません/ })).toBeDefined()
  await ui.unmount()
  await clock.settle()
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /まだプロンプトがありません/ })).toBeUndefined()
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

test('a drawn prompt whose merge failed is merged later, not lost', async ($, on) => {
  const { clock, calls, transcript } = engine(on)
  transcript.push({ role: 'user', text: 'old one', toolUses: [] })
  // A store whose first three writes of the nav each lose the race.
  const store = new Map<string, { value: unknown; version: number }>()
  let navLosses = 3
  on('state.get', (_, e) => ({ value: store.get(e.key) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', (_, e) => {
    const held = store.get(e.key) ?? { value: undefined, version: 0 }
    const loses = e.key === 'nav' && navLosses > 0
    if (loses) navLosses -= 1
    if (loses || (e.ifVersion !== undefined && e.ifVersion !== held.version)) {
      return { value: { isSet: false, version: held.version } }
    }
    const written = { value: e.value, version: held.version + 1 }
    store.set(e.key, written)
    return { value: { isSet: true, version: written.version } }
  })
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  // Drawn before the session starts, so the start's merge is the one that loses.
  const row = await $.ui.mount({
    plugin: 'session-compass',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'r1',
    props: { text: 'old one', origin: COMPOSER, isExpanded: false },
  })
  await row.unmount()
  await start($)
  await clock.settle()
  expect(calls.logs).toContainEqual('session-compass: gave up writing the nav (drawn prompts): three writes lost the race')
  await say($, 'u2', 'new one')
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'first' })
  expect(calls.scroll).toEqual(['r1'])
  await ui.unmount()
})

test('a summary that fails says why in the debug log', async ($, on) => {
  const { clock, calls } = engine(on, { isAnswered: false, reason: 'api-error' })
  await start($)
  await say($, 'u1', 'fix it')
  await clock.settle()
  expect(calls.logs).toContainEqual('session-compass: the summary failed: api-error')
})

test('a transcript past what messages() returns names no first prompt', async ($, on) => {
  const { clock, calls, transcript } = engine(on)
  for (let i = 0; i < 4096; i++) transcript.push({ role: 'user', text: `ask ${i}`, toolUses: [] })
  await start($)
  await clock.settle()
  expect(calls.complete).toEqual([])
  expect(calls.logs).toContainEqual(
    'session-compass: the transcript is longer than $.session.messages() returns: its first prompt is not known',
  )
  expect(calls.logs.filter(line => line.includes('could not read the transcript'))).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /まだプロンプトがありません/ })).toBeDefined()
  await ui.unmount()
})

test('a refused messages() read says why and names no first prompt', async ($, on) => {
  const { clock, calls, transcript } = engine(on, undefined, { messagesDeny: 'no transcript for you' })
  transcript.push({ role: 'user', text: 'fix the login bug', toolUses: [] })
  await start($)
  await clock.settle()
  expect(calls.messages).toBeGreaterThan(0)
  expect(calls.logs).toContainEqual(
    'session-compass: could not read the transcript: no transcript for you: its first prompt is not known',
  )
  expect(calls.logs.filter(line => line.includes('longer than'))).toEqual([])
  expect(calls.complete).toEqual([])
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

/** Draws one of the person's prompt rows, as the transcript would. */
async function drawRow(
  $: Engine,
  requestId: string,
  text: string,
  onScreen?: { first: number; last: number; of: number } | null,
) {
  const row = await $.ui.mount({
    plugin: 'session-compass',
    surface: 'terminal',
    component: 'UserMessage',
    requestId,
    props: { text, origin: COMPOSER, isExpanded: false, ...(onScreen === undefined ? {} : { onScreen }) },
  })
  await row.unmount()
}

test('the row a just-sent prompt is drawn under first is no stop for ⏫', async ($, on) => {
  const { clock, calls } = engine(on)
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  await start($)
  // The terminal draws each prompt under `placeholder` until its message has an id.
  await drawRow($, 'placeholder', 'one')
  await say($, 'u1', 'one')
  await drawRow($, 'u1', 'one')
  await drawRow($, 'placeholder', 'two')
  await say($, 'u2', 'two')
  await drawRow($, 'u2', 'two')
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'first' })
  expect(calls.scroll).toEqual(['u1'])
  await ui.unmount()
})

test('a placeholder an earlier version stored is skipped', async ($, on) => {
  const { calls } = engine(on)
  on('state.get', (_, e) => {
    if (e.key === 'nav') {
      const nav: Nav = {
        liveIds: ['u1', 'u2'],
        pastPrompts: [{ id: 'placeholder', key: '3:00000000' }],
        promptIds: ['placeholder', 'u1', 'u2'],
        cursorId: 'u1',
      }
      return { value: { value: nav, version: 1 } }
    }
    return { value: { value: undefined, version: 0 } }
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'first' })
  await ui.press({ key: 'prev' })
  expect(calls.scroll).toEqual(['u1', 'u1'])
  await ui.unmount()
})

test('after scrolling by hand, the buttons step from the prompt on screen', async ($, on) => {
  const { clock, calls } = engine(on)
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  await start($)
  for (const [id, text] of [['u1', 'one'], ['u2', 'two'], ['u3', 'three'], ['u4', 'four']] as const) {
    await say($, id, text)
  }
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // Scrolled up by hand into u2's turn: u2's row top is above the viewport.
  await drawRow($, 'u2', 'two', { first: 2, last: 3, of: 4 })
  await drawRow($, 'u3', 'three', null)
  await ui.press({ key: 'prev' })
  // Scrolled by hand again, to where u3's row starts below u2's turn.
  await drawRow($, 'u2', 'two', { first: 3, last: 3, of: 4 })
  await drawRow($, 'u3', 'three', { first: 0, last: 1, of: 2 })
  await ui.press({ key: 'next' })
  // Scrolled down by hand until u3's row went up past the top: no prompt row
  // is on screen, and the viewport is in u3's reply.
  await drawRow($, 'u2', 'two', null)
  await drawRow($, 'u3', 'three', { first: 1, last: 1, of: 2 })
  await drawRow($, 'u3', 'three', null)
  // u4 is further down, its row still below the bottom.
  await drawRow($, 'u4', 'four', { first: 0, last: 0, of: 2 })
  await drawRow($, 'u4', 'four', null)
  await ui.press({ key: 'prev' })
  await ui.press({ key: 'next' })
  expect(calls.scroll).toEqual(['u2', 'u3', 'u3', 'u4'])
  await ui.unmount()
})

/** The model's replies in the ticket tests, by what it is asked. */
function ticketAnswers(work: 'yes' | 'no', title = 'NONE') {
  return (system: string) =>
    system.includes('yes') ? work : system.includes('タイトル') ? title : undefined
}

test('a skill run on a graph-ops ticket shows the ticket and its title, not a summary', async ($, on) => {
  const { clock, calls } = engine(on)
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify({ id: 'SCMP-00001', title: '帯を実装する' }), stderr: '' } } as never
  })
  await start($)
  const command = { name: 'graph-ops:process-ticket', args: 'SCMP-00001' }
  await $.prompt.submit({ text: '/graph-ops:process-ticket SCMP-00001', origin: COMPOSER, wait: false, command })
  await clock.settle()

  expect(runs).toEqual([['graph-engine', 'get-ticket', 'SCMP-00001']])
  // A command naming the id asks to work on it: no model call to judge it, and no summary.
  expect(calls.complete).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'SCMP-00001' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / 帯を実装する/ })).toBeDefined()
  await ui.unmount()

  // Later prompts leave the ticket in place and make no summary.
  await say($, 'u2', 'テストも追加して')
  await clock.settle()
  expect(calls.complete).toEqual([])
})

test('a ticket only mentioned is no ticket of the session: the summary goes on', async ($, on) => {
  const { clock, calls } = engine(on, { isAnswered: true, text: '仕様の確認' }, { answer: ticketAnswers('no') })
  await start($)
  await say($, 'u1', 'PROJ-12 の仕様ってどうなってたっけ')
  await clock.settle()
  expect(calls.complete).toEqual(['チケット ID: PROJ-12\n\n依頼:\nPROJ-12 の仕様ってどうなってたっけ', '1. PROJ-12 の仕様ってどうなってたっけ'])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /仕様の確認/ })).toBeDefined()
  await ui.unmount()
})

test('a ticket graph-ops does not know shows its id, then its title once the transcript has it', async ($, on) => {
  const { clock, transcript } = engine(on, undefined, { answer: ticketAnswers('yes', 'ログイン画面のバグ') })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'TICKET_NOT_FOUND' } }) as never)
  on('turn.complete', () => ({ text: '' }))
  await start($)
  await say($, 'u1', 'Jira の PROJ-123 を対応して')
  await clock.settle()

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'PROJ-123' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ログイン画面のバグ/ })).toBeUndefined()
  await ui.unmount()

  // A skill read the ticket; the turn ends.
  transcript.push({ role: 'user', text: 'Jira の PROJ-123 を対応して', toolUses: [] })
  transcript.push({ role: 'assistant', text: 'PROJ-123「ログイン画面のバグ」を確認します', toolUses: [] })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answered' } as never)
  await clock.settle()
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: / ログイン画面のバグ/ })).toBeDefined()
  await ui.unmount()
})

test('the summary keeps showing while a new one is made', async ($, on) => {
  const { clock, calls } = engine(on, undefined, { modelDelayMs: 1000 })
  await start($)
  await say($, 'u1', 'one')
  await clock.settle()
  await clock.advance(1000) // the first summary comes back
  await clock.settle()
  await say($, 'u2', 'two')
  await clock.advance(10)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(calls.complete.length).toBe(2)
  expect(await ui.find({ type: 'Text', text: /ログインバグの修正/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /要約中/ })).toBeUndefined()
  await ui.unmount()
})

test('scrolling down after a button and pressing 🔼 goes back to the prompt being read, every time', async ($, on) => {
  const { clock, calls } = engine(on)
  let cursorId: string | null = 'u2'
  on('state.get', (_, e, next) => {
    if (e.key === 'nav') {
      const ids = ['u1', 'u2', 'u3', 'u4']
      return { value: { value: { liveIds: ids, pastPrompts: [], promptIds: ids, cursorId }, version: 1 } }
    }
    return next(e)
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  async function drawReplyAt(requestId: string, onScreen: { first: number; last: number; of: number } | null) {
    const row = await $.ui.mount({
      plugin: 'session-compass',
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId,
      props: { text: 'reply', isFirstOfReply: true, onScreen },
    })
    await row.unmount()
  }
  await start($)
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // The last button put u2 on top; the person scrolls down: u2's reply moves
  // up, u3's one-line row comes in and jumps out of view whole at the top.
  await drawRow($, 'u2', 'two', { first: 0, last: 0, of: 1 })
  await drawReplyAt('a2', { first: 0, last: 9, of: 30 })
  await drawReplyAt('a2', { first: 20, last: 29, of: 30 })
  await drawRow($, 'u2', 'two', null)
  await drawRow($, 'u3', 'three', { first: 0, last: 0, of: 1 })
  await drawReplyAt('a3', { first: 0, last: 8, of: 30 })
  await drawReplyAt('a3', { first: 3, last: 12, of: 30 })
  await drawRow($, 'u3', 'three', null)
  await ui.press({ key: 'prev' })
  expect(calls.scroll).toEqual(['u3'])
  await ui.unmount()
})

/** The engine's own drawing of the question dialog, beneath the plugin. */
function questionEngine(on: On) {
  on('ui.render', { component: 'AskUserQuestion' }, () => ({ type: 'engine', ref: 0 }) as never)
}

/** The question dialog, drawn over the engine's own node. */
async function drawQuestion($: Engine) {
  return $.ui.mount({
    plugin: 'session-compass',
    surface: 'terminal',
    component: 'AskUserQuestion',
    requestId: 'toolu_1',
    props: { tool: 'AskUserQuestion', questions: [{ question: 'どちらにしますか？' }] },
  })
}

test('the summary shows above the question dialog, cut to one row', async ($, on) => {
  const { clock } = engine(on, { isAnswered: true, text: 'ログイン画面のエラーを直して、テストを追加し、リリース手順を整える' })
  questionEngine(on)
  await start($)
  await say($, 'u1', 'ログイン画面でエラーになるバグを直してほしい')
  await clock.settle()
  const ui = await drawQuestion($)
  const line = await ui.find({ type: 'Text', text: /^ログイン画面のエラー/ })
  expect(line).toBeDefined()
  expect(await ui.find({ type: 'engine' } as never)).toBeDefined()
  // One row of the dialog's 40 columns: 39 cells at most.
  const cutText = oneLine('ログイン画面のエラーを直して、テストを追加し、リリース手順を整える', 39)
  expect(textWidth(cutText)).toBeLessThanOrEqual(39)
  expect(cutText.endsWith('…')).toBe(true)
  expect(await ui.find({ type: 'Text', text: cutText })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('a ticket shows above the question dialog; with nothing to show the dialog is the engine\'s alone', async ($, on) => {
  const { clock } = engine(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ id: 'SCMP-00001', title: '帯' }), stderr: '' } }) as never)
  questionEngine(on)
  await start($)
  await clock.settle()
  let ui = await drawQuestion($)
  expect(await ui.find({ type: 'engine' } as never)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /まだプロンプト/ })).toBeUndefined()
  await ui.unmount()

  const command = { name: 'graph-ops:process-ticket', args: 'SCMP-00001' }
  await $.prompt.submit({ text: '/graph-ops:process-ticket SCMP-00001', origin: COMPOSER, wait: false, command })
  await clock.settle()
  ui = await drawQuestion($)
  expect(await ui.find({ type: 'Text', text: 'SCMP-00001' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / 帯/ })).toBeDefined()
  await ui.unmount()
})

test('in manual mode the first summary is made unasked, later ones on 🔁', { options: { summaryMode: 'manual' } }, async ($, on) => {
  const { clock, calls } = engine(on)
  await start($)
  await say($, 'u1', 'one')
  await clock.settle()
  await say($, 'u2', 'two')
  await clock.settle()
  // The first prompt was summarized; the second waits for 🔁.
  expect(calls.complete).toEqual(['1. one'])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect(calls.complete).toEqual(['1. one', '1. one\n2. two'])
  // 🔁 remakes it even with nothing new said.
  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect(calls.complete.length).toBe(3)
  await ui.unmount()
})

test('in auto mode there is no 🔁', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await say($, 'u1', 'one')
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'refresh' })).toBeUndefined()
  await ui.unmount()
})

test('a session on a ticket has no 🔁, even in manual mode', { options: { summaryMode: 'manual' } }, async ($, on) => {
  const { clock } = engine(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ id: 'SCMP-00001', title: '帯' }), stderr: '' } }) as never)
  await start($)
  const command = { name: 'graph-ops:process-ticket', args: 'SCMP-00001' }
  await $.prompt.submit({ text: '/graph-ops:process-ticket SCMP-00001', origin: COMPOSER, wait: false, command })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'SCMP-00001' })).toBeDefined()
  expect(await ui.find({ key: 'refresh' })).toBeUndefined()
  await ui.unmount()
})
