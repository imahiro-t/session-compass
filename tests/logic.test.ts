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

describe('orderPast', () => {
  const texts = ['one', 'two', 'three']

  test('rows drawn newest first come out in the order they were said', () => {
    const drawn = [
      { id: 'c', text: 'three' },
      { id: 'b', text: 'two' },
      { id: 'a', text: 'one' },
    ]
    expect(orderPast(drawn, texts).map(p => p.id)).toEqual(['a', 'b', 'c'])
  })

  test('the same text twice takes the earliest rows in turn', () => {
    const drawn = [
      { id: 'y', text: 'again' },
      { id: 'x', text: 'again' },
    ]
    expect(orderPast(drawn, ['again', 'other', 'again']).map(p => p.id)).toEqual(['y', 'x'])
  })

  test('rows that match nothing come first, in the order they were seen', () => {
    const drawn = [
      { id: 'b', text: 'two' },
      { id: 'q', text: 'unknown 1' },
      { id: 'r', text: 'unknown 2' },
    ]
    expect(orderPast(drawn, texts).map(p => p.id)).toEqual(['q', 'r', 'b'])
  })

  test('text is compared trimmed', () => {
    expect(orderPast([{ id: 'a', text: ' two\n' }, { id: 'b', text: 'one' }], texts).map(p => p.id)).toEqual(['b', 'a'])
  })
})

describe('the nav', () => {
  test('a live prompt goes last once, leaves the past list and resets the cursor', () => {
    const nav = { ...EMPTY_NAV, pastPrompts: [{ id: 'p', text: 'old' }, { id: 'x', text: 'new' }], cursorId: 'p' }
    const next = withLivePrompt(nav, 'x')
    expect(next).toEqual({
      liveIds: ['x'],
      pastPrompts: [{ id: 'p', text: 'old' }],
      promptIds: ['p', 'x'],
      cursorId: null,
    })
    expect(next && withLivePrompt(next, 'x')).toBe(null)
  })

  test('drawn prompts already known change nothing', () => {
    const nav = { ...EMPTY_NAV, liveIds: ['a'], promptIds: ['a'] }
    expect(withPastPrompts(nav, [{ id: 'a', text: 'x' }], [])).toBe(null)
  })

  test('new drawn prompts go before the live ones, in transcript order', () => {
    const nav = { ...EMPTY_NAV, liveIds: ['l'], promptIds: ['l'] }
    const next = withPastPrompts(
      nav,
      [
        { id: 'b', text: 'two' },
        { id: 'a', text: 'one' },
      ],
      ['one', 'two', 'live'],
    )
    expect(next?.promptIds).toEqual(['a', 'b', 'l'])
  })

  test('userPromptTexts keeps the person\'s rows only', () => {
    expect(
      userPromptTexts([
        { role: 'user', text: ' hi ' },
        { role: 'assistant', text: 'hello' },
        { role: 'user', text: '', toolResults: [] },
        { role: 'user', text: 'result', toolResults: [{}] },
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
    expect(navTarget('first', ids, null)).toEqual({ index: 0, cursorId: 'a' })
    expect(navTarget('latest', ids, 'a')).toEqual({ index: 2, cursorId: null })
  })

  test('prev from the latest goes to the newest prompt, and stops at the first', () => {
    expect(navTarget('prev', ids, null)).toEqual({ index: 2, cursorId: 'c' })
    expect(navTarget('prev', ids, 'b')).toEqual({ index: 0, cursorId: 'a' })
    expect(navTarget('prev', ids, 'a')).toEqual({ index: 0, cursorId: 'a' })
  })

  test('next at the latest does nothing, and stops at the last', () => {
    expect(navTarget('next', ids, null)).toBe(null)
    expect(navTarget('next', ids, 'a')).toEqual({ index: 1, cursorId: 'b' })
    expect(navTarget('next', ids, 'c')).toEqual({ index: 2, cursorId: 'c' })
  })

  test('a cursor no longer in the list counts as at the latest', () => {
    expect(navTarget('prev', ids, 'gone')).toEqual({ index: 2, cursorId: 'c' })
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
})
