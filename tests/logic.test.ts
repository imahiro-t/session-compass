import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY_NAV,
  EMPTY_TEXT,
  PENDING_NOTE,
  bandText,
  isOwnPrompt,
  navTarget,
  oneLine,
  orderPast,
  promptKey,
  summaryInput,
  summaryLine,
  textWidth,
  userPromptTexts,
  withLivePrompt,
  withPastPrompts,
} from '../hooks/logic'

describe('isOwnPrompt', () => {
  test('the person at the terminal or through Remote Control is the person', () => {
    expect(isOwnPrompt({ kind: 'composer' })).toBe(true)
    expect(isOwnPrompt({ kind: 'bridge' })).toBe(true)
  })

  test('anyone else is not', () => {
    for (const kind of ['task-notification', 'peer', 'plugin', 'unclassified', 'sdk', 'scheduled-trigger']) {
      expect(isOwnPrompt({ kind })).toBe(false)
    }
  })

  test('a row with no origin counts only without a task or a sender', () => {
    expect(isOwnPrompt(undefined)).toBe(true)
    expect(isOwnPrompt(undefined, { task: { id: 't' } })).toBe(false)
    expect(isOwnPrompt(undefined, { from: { kind: 'teammate' } })).toBe(false)
  })
})

describe('oneLine', () => {
  test('flattens whitespace and keeps a short text whole', () => {
    expect(oneLine('  fix\nthe   bug  ', 40)).toBe('fix the bug')
  })

  test('cuts to the width with an ellipsis, counting wide characters as two', () => {
    expect(oneLine('abcdefghij', 5)).toBe('abcd…')
    const cut = oneLine('あいうえおかきくけこ', 7)
    expect(cut).toBe('あいう…')
    expect(textWidth(cut)).toBeLessThanOrEqual(7)
  })

  test('a width of zero or less gives nothing', () => {
    expect(oneLine('abc', 0)).toBe('')
  })
})

describe('bandText', () => {
  test('a done summary is shown', () => {
    expect(bandText('long prompt', { status: 'done', text: 'Fix the login bug' }, 40)).toEqual({
      kind: 'summary',
      text: 'Fix the login bug',
    })
  })

  test('while pending, the prompt is cut with a note beside it', () => {
    const band = bandText('please fix the login bug', { status: 'pending', token: 't' }, 40)
    expect(band.kind).toBe('pending')
    expect(band.note).toBe(PENDING_NOTE)
    expect(textWidth(band.text) + textWidth(PENDING_NOTE)).toBeLessThanOrEqual(40)
  })

  test('a failed or not-started summary falls back to the cut prompt', () => {
    expect(bandText('a\nb', { status: 'failed', reason: 'api-error' }, 40)).toEqual({ kind: 'truncated', text: 'a b' })
    expect(bandText('abc', { status: 'idle' }, 40)).toEqual({ kind: 'truncated', text: 'abc' })
    expect(bandText('abcdefghij', undefined, 5)).toEqual({ kind: 'truncated', text: 'abcd…' })
  })

  test('no prompt yet shows the placeholder', () => {
    expect(bandText(null, { status: 'idle' }, 40)).toEqual({ kind: 'empty', text: EMPTY_TEXT })
    expect(bandText('   ', undefined, 40).kind).toBe('empty')
  })

  test('an empty done summary falls back too', () => {
    expect(bandText('abc', { status: 'done', text: ' ' }, 40).kind).toBe('truncated')
  })
})

/** A drawn prompt as the buffer holds it: its id and its text's fingerprint. */
const drawnRow = (id: string, text: string) => ({ id, key: promptKey(text) })
const keysOf = (texts: readonly string[]) => texts.map(promptKey)

describe('promptKey', () => {
  test('the same text on one line gives the same key, another text another', () => {
    expect(promptKey(' fix\n  the bug ')).toBe(promptKey('fix the bug'))
    expect(promptKey('fix the bug')).not.toBe(promptKey('fix the bugs'))
    expect(promptKey('ログイン')).toMatch(/^4:[0-9a-f]{8}$/)
  })

  test('a huge prompt still gives a short key', () => {
    expect(promptKey('x'.repeat(1_000_000)).length).toBeLessThan(20)
  })
})

describe('orderPast', () => {
  const texts = keysOf(['one', 'two', 'three'])

  test('rows drawn newest first come out in the order they were said', () => {
    const drawn = [drawnRow('c', 'three'), drawnRow('b', 'two'), drawnRow('a', 'one')]
    expect(orderPast(drawn, texts).map(p => p.id)).toEqual(['a', 'b', 'c'])
  })

  test('the same text twice takes the earliest rows in turn', () => {
    const drawn = [drawnRow('y', 'again'), drawnRow('x', 'again')]
    expect(orderPast(drawn, keysOf(['again', 'other', 'again'])).map(p => p.id)).toEqual(['y', 'x'])
  })

  test('rows that match nothing come first, in the order they were seen', () => {
    const drawn = [drawnRow('b', 'two'), drawnRow('q', 'unknown 1'), drawnRow('r', 'unknown 2')]
    expect(orderPast(drawn, texts).map(p => p.id)).toEqual(['q', 'r', 'b'])
  })

  test('text is compared on one line, trimmed', () => {
    expect(orderPast([drawnRow('a', ' two\n'), drawnRow('b', 'one')], texts).map(p => p.id)).toEqual(['b', 'a'])
  })
})

describe('the nav', () => {
  test('a live prompt goes last once, leaves the past list and resets the cursor', () => {
    const nav = { ...EMPTY_NAV, pastPrompts: [drawnRow('p', 'old'), drawnRow('x', 'new')], cursorId: 'p' }
    const next = withLivePrompt(nav, 'x')
    expect(next).toEqual({
      liveIds: ['x'],
      pastPrompts: [drawnRow('p', 'old')],
      promptIds: ['p', 'x'],
      cursorId: null,
    })
    expect(next && withLivePrompt(next, 'x')).toBe(null)
  })

  test('drawn prompts already known change nothing', () => {
    const nav = { ...EMPTY_NAV, liveIds: ['a'], promptIds: ['a'] }
    expect(withPastPrompts(nav, [drawnRow('a', 'x')], [])).toBe(null)
  })

  test('new drawn prompts go before the live ones, in transcript order', () => {
    const nav = { ...EMPTY_NAV, liveIds: ['l'], promptIds: ['l'] }
    const next = withPastPrompts(nav, [drawnRow('b', 'two'), drawnRow('a', 'one')], keysOf(['one', 'two', 'live']))
    expect(next?.promptIds).toEqual(['a', 'b', 'l'])
  })

  test('the nav keeps fingerprints, never the prompts\' text', () => {
    const huge = 'log line\n'.repeat(100_000)
    const next = withPastPrompts(EMPTY_NAV, [drawnRow('a', huge)], keysOf([huge]))
    expect(JSON.stringify(next).length).toBeLessThan(200)
  })

  test('userPromptTexts keeps the person\'s rows only', () => {
    expect(
      userPromptTexts([
        { role: 'user', text: ' hi ' },
        { role: 'assistant', text: 'hello' },
        { role: 'user', text: '', toolResults: [] },
        { role: 'user', text: 'result', toolResults: [{}] },
        { role: 'user', text: '<command-name>/clear</command-name>' },
        { role: 'user', text: '<task-notification>done</task-notification>' },
        { role: 'user', text: 'bye' },
      ]),
    ).toEqual(['hi', 'bye'])
  })
})

describe('navTarget', () => {
  const ids = ['a', 'b', 'c']

  test('nothing to go to with no prompts', () => {
    for (const kind of ['first', 'prev', 'next', 'latest'] as const) {
      expect(navTarget(kind, [], null)).toBe(null)
    }
  })

  test('first and latest', () => {
    expect(navTarget('first', ids, null)).toEqual({ index: 0, id: 'a' })
    expect(navTarget('latest', ids, 'a')).toEqual({ index: 2, id: 'c' })
    expect(navTarget('latest', ids, null)).toEqual({ index: 2, id: 'c' })
  })

  test('after latest, prev goes one before the newest prompt and next stays on it', () => {
    const latest = navTarget('latest', ids, null)
    expect(latest?.id).toBe('c')
    expect(navTarget('prev', ids, latest?.id ?? null)).toEqual({ index: 1, id: 'b' })
    expect(navTarget('next', ids, latest?.id ?? null)).toEqual({ index: 2, id: 'c' })
  })

  test('prev from the end of the transcript goes to the newest prompt, and stops at the first', () => {
    expect(navTarget('prev', ids, null)).toEqual({ index: 2, id: 'c' })
    expect(navTarget('prev', ids, 'b')).toEqual({ index: 0, id: 'a' })
    expect(navTarget('prev', ids, 'a')).toEqual({ index: 0, id: 'a' })
  })

  test('next at the end of the transcript does nothing, and stops at the last', () => {
    expect(navTarget('next', ids, null)).toBe(null)
    expect(navTarget('next', ids, 'a')).toEqual({ index: 1, id: 'b' })
    expect(navTarget('next', ids, 'c')).toEqual({ index: 2, id: 'c' })
  })

  test('a cursor no longer in the list counts as the end of the transcript', () => {
    expect(navTarget('prev', ids, 'gone')).toEqual({ index: 2, id: 'c' })
    expect(navTarget('next', ids, 'gone')).toBe(null)
  })
})

describe('summary text', () => {
  test('a reply becomes one line, an empty one nothing', () => {
    expect(summaryLine(' ログイン\nバグの修正 ')).toBe('ログイン バグの修正')
    expect(summaryLine(' \n ')).toBe(null)
  })

  test('a long prompt is cut before it is sent', () => {
    expect(summaryInput('x'.repeat(5000)).length).toBe(4001)
    expect(summaryInput('short')).toBe('short')
  })

  test('the cut never splits an emoji, and cutting twice changes nothing', () => {
    const cut = summaryInput('😀'.repeat(5000))
    expect(Array.from(cut).length).toBe(4001)
    expect(cut.endsWith('😀…')).toBe(true)
    expect(summaryInput(cut)).toBe(cut)
  })
})
