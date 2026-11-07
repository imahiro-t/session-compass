import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY_NAV,
  EMPTY_TEXT,
  PENDING_NOTE,
  bandText,
  commandLine,
  rowIdOf,
  typedText,
  graphTicketTitle,
  isOwnPrompt,
  isStopId,
  isYes,
  navPosition,
  navTarget,
  oneLine,
  orderPast,
  promptKey,
  promptLine,
  PROMPTS_KEPT,
  summaryBasis,
  summaryPrompts,
  ticketBand,
  ticketCandidates,
  ticketMentions,
  structuredTitle,
  titleLine,
  summaryInput,
  summaryLine,
  textWidth,
  userPromptTexts,
  directionOf,
  emptyViewport,
  MOVE_SETTLE_MS,
  noteMove,
  noteReport,
  viewSpan,
  withLivePrompt,
  withPastPrompts,
  withPrompt,
  withoutBadStops,
} from '../hooks/logic'
import type { Seen } from '../hooks/logic'

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

  test('userPromptTexts keeps the person\'s rows only, slash commands as typed', () => {
    expect(
      userPromptTexts([
        { role: 'user', text: ' hi ' },
        { role: 'assistant', text: 'hello' },
        { role: 'user', text: '', toolResults: [] },
        { role: 'user', text: 'result', toolResults: [{}] },
        { role: 'user', text: '<command-name>/clear</command-name>' },
        {
          role: 'user',
          text: '<command-message>graph-ops:autopilot-tree</command-message>\n<command-name>/graph-ops:autopilot-tree</command-name>\n<command-args>SCMP-00001 --run r1</command-args>',
        },
        { role: 'user', text: '<local-command-stdout>ok</local-command-stdout>' },
        { role: 'user', text: '<task-notification>done</task-notification>' },
        { role: 'user', text: 'bye' },
      ]),
    ).toEqual(['hi', '/clear', '/graph-ops:autopilot-tree SCMP-00001 --run r1', 'bye'])
  })

  test('the row an appended message draws last: its last tool call, else itself', () => {
    expect(rowIdOf('m1', [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't1' }, { type: 'tool_use', id: 't2' }])).toBe('t2')
    expect(rowIdOf('m1', [{ type: 'text', text: 'a' }])).toBe('m1')
    expect(rowIdOf('m1', 'plain')).toBe('m1')
    expect(rowIdOf('m1', [null, { type: 'tool_use' }])).toBe('m1')
  })

  test('a stored slash command reads back as typed; other text is as it is', () => {
    expect(commandLine('<command-name>/model</command-name>\n<command-args> haiku </command-args>')).toBe('/model haiku')
    expect(commandLine('<command-name>graph-ops:ui</command-name>')).toBe('/graph-ops:ui')
    expect(commandLine('plain text')).toBe(null)
    expect(typedText('<command-name>/clear</command-name>')).toBe('/clear')
    expect(typedText('/graph-ops:autopilot-tree SCMP-00001')).toBe('/graph-ops:autopilot-tree SCMP-00001')
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

describe('stops that are not real messages', () => {
  test('the row a just-sent prompt is drawn under first is no stop', () => {
    expect(isStopId('placeholder')).toBe(false)
    expect(isStopId('')).toBe(false)
    expect(isStopId('402fa281-5788-4e9b-b6e8-b3fe1bf9d7e3')).toBe(true)
  })

  test('a nav an earlier version stored with a placeholder loses it', () => {
    const nav = {
      liveIds: ['u1', 'u2'],
      pastPrompts: [{ id: 'placeholder', key: '3:00000000' }],
      promptIds: ['placeholder', 'u1', 'u2'],
      cursorId: 'placeholder',
    }
    const clean = withoutBadStops(nav)
    expect(clean.promptIds).toEqual(['u1', 'u2'])
    expect(clean.pastPrompts).toEqual([])
    expect(clean.cursorId).toBe(null)
    expect(navTarget('first', clean.promptIds, clean.cursorId)?.id).toBe('u1')
  })

  test('a clean nav is handed back as it is', () => {
    const nav = { liveIds: ['u1'], pastPrompts: [], promptIds: ['u1'], cursorId: null }
    expect(withoutBadStops(nav)).toBe(nav)
  })
})

describe('the viewport the person scrolled to', () => {
  const ids = ['a', 'b', 'c', 'd']
  const seen = (entries: [string, Seen][]) => new Map<string, Seen>(entries)

  test('no prompt row on screen tells nothing', () => {
    expect(viewSpan(ids, seen([]))).toBe(null)
    expect(viewSpan(ids, seen([['a', null], ['b', null]]))).toBe(null)
  })

  test('a prompt whose row top scrolled away puts the viewport in its turn', () => {
    expect(viewSpan(ids, seen([['b', { first: 2, last: 4, of: 5 }]]))).toEqual({ lo: 1, hi: 1.5, at: 1.5 })
  })

  test('a prompt whose row starts on screen leaves the turn before it at the top', () => {
    const view = viewSpan(ids, seen([['b', { first: 0, last: 1, of: 2 }], ['c', { first: 0, last: 0, of: 3 }]]))
    expect(view).toEqual({ lo: 0, hi: 2.5, at: 0.5 })
  })

  test('scrolled by hand away from the cursor, the buttons count from the viewport', () => {
    // At the end of the transcript (cursor null), scrolled up into b's turn.
    const view = viewSpan(ids, seen([['b', { first: 3, last: 9, of: 10 }]]))
    expect(navPosition(ids, null, view)).toBe(1.5)
    expect(navTarget('prev', ids, null, view)?.id).toBe('b')
    expect(navTarget('next', ids, null, view)?.id).toBe('c')
    // From the cursor on d instead, the same viewport wins as well.
    expect(navTarget('prev', ids, 'd', view)?.id).toBe('b')
  })

  test('scrolled into the turn before the first visible prompt, prev and next straddle it', () => {
    const view = viewSpan(ids, seen([['c', { first: 0, last: 2, of: 3 }]]))
    expect(navTarget('prev', ids, null, view)?.id).toBe('b')
    expect(navTarget('next', ids, null, view)?.id).toBe('c')
  })

  test('a viewport where the cursor says keeps the cursor', () => {
    // A button just put b at the top: b's row starts on screen.
    const view = viewSpan(ids, seen([['b', { first: 0, last: 1, of: 2 }]]))
    expect(navPosition(ids, 'b', view)).toBe(1)
    expect(navTarget('prev', ids, 'b', view)?.id).toBe('a')
    expect(navTarget('next', ids, 'b', view)?.id).toBe('c')
    // At the end of the transcript with the newest prompt on screen.
    const end = viewSpan(ids, seen([['d', { first: 0, last: 1, of: 2 }]]))
    expect(navTarget('prev', ids, null, end)?.id).toBe('d')
    expect(navTarget('next', ids, null, end)).toBe(null)
  })

  test('right after a button, the prompt it moved to sits under the header and is not reported', () => {
    // 🔽 put b on the top row; only c, lower down, says it is on screen.
    const view = viewSpan(ids, seen([['b', null], ['c', { first: 0, last: 1, of: 2 }]]))
    expect(navTarget('prev', ids, 'b', view)?.id).toBe('a')
    expect(navTarget('next', ids, 'b', view)?.id).toBe('c')
  })

  test('above the first prompt, prev and next both go to it', () => {
    const view = viewSpan(ids, seen([['a', { first: 0, last: 1, of: 2 }]]))
    expect(navTarget('prev', ids, 'c', view)?.id).toBe('a')
    expect(navTarget('next', ids, 'c', view)?.id).toBe('a')
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

describe('ticket ids', () => {
  test('graph-ops and Jira ids are found in order, each once', () => {
    expect(ticketCandidates('/graph-ops:process-ticket SCMP-00001')).toEqual(['SCMP-00001'])
    expect(ticketCandidates('PROJ-123 と AB2-7、もう一度 PROJ-123')).toEqual(['PROJ-123', 'AB2-7'])
  })

  test('standards, versions and lower-case words are not tickets', () => {
    expect(ticketCandidates('UTF-8 で RFC-2119 に従う、sha-256、A-1、my-PROJ-1x')).toEqual([])
  })

  test('the title graph-engine prints is read for that ticket only', () => {
    const out = JSON.stringify({ id: 'SCMP-00001', title: ' 帯を\n実装する ' })
    expect(graphTicketTitle(out, 'SCMP-00001')).toBe('帯を 実装する')
    expect(graphTicketTitle(out, 'SCMP-00002')).toBe(null)
    expect(graphTicketTitle('not json', 'SCMP-00001')).toBe(null)
  })

  test('replies of the model', () => {
    expect(isYes('yes')).toBe(true)
    expect(isYes('Yes.')).toBe(true)
    expect(isYes('no')).toBe(false)
    expect(titleLine('「ログイン画面のバグ」')).toBe('ログイン画面のバグ')
    expect(titleLine('NONE')).toBe(null)
  })

  test('the mentions of a ticket are cut around each occurrence', () => {
    const text = `${'x'.repeat(1000)} PROJ-1 title here ${'y'.repeat(1000)}`
    const found = ticketMentions([text, 'nothing'], 'PROJ-1', 6000, 10)
    expect(found).toBe('x'.repeat(9) + ' PROJ-1 title her')
    expect(ticketMentions(['nothing'], 'PROJ-1')).toBe('')
  })

  test('the band shows the id, and the title when known, cut to fit', () => {
    expect(ticketBand({ id: 'PROJ-1', title: null, source: 'prompt' }, 40)).toEqual({ id: 'PROJ-1', title: '' })
    expect(ticketBand({ id: 'PROJ-1', title: 'abcdefghij', source: 'transcript' }, 12)).toEqual({ id: 'PROJ-1', title: 'abcd…' })
  })
})

describe('the prompts the summary is made from', () => {
  test('a slash command is kept as typed, on one line', () => {
    expect(promptLine('ignored', { name: 'graph-ops:process-ticket', args: 'SCMP-1' })).toBe('/graph-ops:process-ticket SCMP-1')
    expect(promptLine('a\n  b')).toBe('a b')
  })

  test('the first prompt stays and the newest are kept; a repeat of the last is not', () => {
    let kept: string[] = []
    for (let i = 1; i <= PROMPTS_KEPT + 5; i++) kept = withPrompt(kept, `p${i}`)
    expect(kept.length).toBe(PROMPTS_KEPT)
    expect(kept[0]).toBe('p1')
    expect(kept[kept.length - 1]).toBe(`p${PROMPTS_KEPT + 5}`)
    expect(withPrompt(['a', 'b'], 'b')).toEqual(['a', 'b'])
  })

  test('the summary is asked for the first prompt and the newest, numbered as said', () => {
    expect(summaryPrompts(['a', 'b'])).toBe('1. a\n2. b')
    const many = Array.from({ length: 12 }, (_, i) => `p${i + 1}`)
    expect(summaryPrompts(many).split('\n')).toEqual(['1. p1', '5. p5', '6. p6', '7. p7', '8. p8', '9. p9', '10. p10', '11. p11', '12. p12'])
  })

  test('a summary stored before the basis existed counts as one prompt', () => {
    expect(summaryBasis({ status: 'idle' })).toBe(0)
    expect(summaryBasis({ status: 'done', text: 't' })).toBe(1)
    expect(summaryBasis({ status: 'done', text: 't', basis: 4 })).toBe(4)
  })

  test('the last summary shows while a new one runs and after one fails', () => {
    expect(bandText('first', { status: 'pending', token: 'x', text: 'old' }, 40)).toEqual({ kind: 'summary', text: 'old' })
    expect(bandText('first', { status: 'failed', reason: 'api-error', text: 'old' }, 40)).toEqual({ kind: 'summary', text: 'old' })
  })
})

describe('a viewport with no prompt row on screen', () => {
  const ids = ['a', 'b', 'c', 'd']

  test('a row cut at the top that goes off screen went up past the top', () => {
    const view = emptyViewport()
    noteReport(view, 'b', { first: 0, last: 2, of: 3 }, true, 1000)
    noteReport(view, 'b', { first: 2, last: 2, of: 3 }, true, 1000)
    noteReport(view, 'b', null, true, 1000)
    expect(view.sides.get('b')).toBe('above')
    // Scrolled up from the end to get here: c went down past the bottom.
    noteReport(view, 'c', { first: 0, last: 0, of: 2 }, true, 1000)
    noteReport(view, 'c', null, true, 1000)
    // In b's reply: prev goes back to b, next on to c.
    const span = viewSpan(ids, view.seen, view.sides)
    expect(span).toEqual({ lo: 1, hi: 1.5, at: 1.5 })
    expect(navTarget('prev', ids, null, span)?.id).toBe('b')
    expect(navTarget('next', ids, null, span)?.id).toBe('c')
  })

  test('a row cut at the bottom that goes off screen went down past the bottom', () => {
    const view = emptyViewport()
    noteReport(view, 'c', { first: 0, last: 0, of: 3 }, true, 1000)
    noteReport(view, 'c', null, true, 1000)
    expect(view.sides.get('c')).toBe('below')
    expect(viewSpan(ids, view.seen, view.sides)).toEqual({ lo: -0.5, hi: 1.5, at: 1.5 })
  })

  test('a row shown whole and then gone keeps the side it had', () => {
    const view = emptyViewport()
    noteReport(view, 'c', { first: 0, last: 1, of: 2 }, true, 1000)
    noteReport(view, 'c', null, true, 1000)
    expect(view.sides.has('c')).toBe(false)
    expect(viewSpan(ids, view.seen, view.sides)).toBe(null)
  })

  test('after a button the prompts before the target are above and those after below', () => {
    const view = emptyViewport()
    noteReport(view, 'a', { first: 0, last: 0, of: 1 }, true, 1000)
    noteMove(view, ids, 2, 0)
    expect(view.seen.size).toBe(0)
    expect([...view.sides]).toEqual([['a', 'above'], ['b', 'above'], ['d', 'below']])
    // The cursor on c agrees with that.
    const span = viewSpan(ids, view.seen, view.sides)
    expect(navTarget('prev', ids, 'c', span)?.id).toBe('b')
    expect(navTarget('next', ids, 'c', span)?.id).toBe('d')
  })

  test('sides that disagree tell nothing', () => {
    const sides = new Map([['a', 'below'], ['c', 'above']] as const)
    expect(viewSpan(ids, new Map(), sides)).toBe(null)
  })
})

describe('which way the viewport moves', () => {
  test('from two reports of one row', () => {
    expect(directionOf({ first: 0, last: 3, of: 9 }, { first: 2, last: 5, of: 9 })).toBe('down')
    expect(directionOf({ first: 2, last: 5, of: 9 }, { first: 0, last: 3, of: 9 })).toBe('up')
    expect(directionOf({ first: 4, last: 8, of: 9 }, null)).toBe('down')
    expect(directionOf({ first: 0, last: 3, of: 9 }, null)).toBe('up')
    expect(directionOf(undefined, { first: 0, last: 3, of: 9 })).toBe('down')
    expect(directionOf(null, { first: 5, last: 8, of: 9 })).toBe('up')
    expect(directionOf({ first: 0, last: 1, of: 2 }, null)).toBe(null)
  })

  test('a prompt row that jumps out whole goes the way a reply row shows', () => {
    const view = emptyViewport()
    // Scrolling down: the prompt row c shown whole, the reply below it moving up the screen.
    noteReport(view, 'c', { first: 0, last: 0, of: 1 }, true, 1000)
    noteReport(view, 'r', { first: 0, last: 5, of: 40 }, false, 1000)
    noteReport(view, 'r', { first: 6, last: 11, of: 40 }, false, 1000)
    noteReport(view, 'c', null, true, 1000)
    expect(view.sides.get('c')).toBe('above')
    // And back up: the reply moves down, c reappears and jumps out below.
    noteReport(view, 'c', { first: 0, last: 0, of: 1 }, true, 1000)
    noteReport(view, 'r', { first: 0, last: 5, of: 40 }, false, 1000)
    noteReport(view, 'c', null, true, 1000)
    expect(view.sides.get('c')).toBe('below')
  })

  test('reports right after a button are the move\'s own; later ones are a scroll', () => {
    const view = emptyViewport()
    noteMove(view, ['a', 'b'], 1, 1000)
    noteReport(view, 'b', { first: 0, last: 0, of: 1 }, true, 1000 + MOVE_SETTLE_MS)
    expect(view.isHandScrolled).toBe(false)
    noteReport(view, 'b', { first: 0, last: 0, of: 1 }, true, 1001 + MOVE_SETTLE_MS)
    expect(view.isHandScrolled).toBe(true)
  })

  test('scrolled by hand, the viewport wins even where the cursor would agree', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    // In d's reply, e's row not reached: c, d above.
    const sides = new Map([['a', 'above'], ['b', 'above'], ['c', 'above'], ['d', 'above']] as const)
    const view = viewSpan(ids, new Map(), sides)
    expect(view).toEqual({ lo: 3, hi: 4.5, at: 3.5 })
    // The last button stopped at d; the person scrolled down into d's reply.
    // The cursor agrees with the viewport, yet 🔼 goes to d itself, where the
    // person reads, not past it to c.
    expect(navTarget('prev', ids, 'd', view, false)?.id).toBe('c')
    expect(navTarget('prev', ids, 'd', view, true)?.id).toBe('d')
  })
})

describe('a ticket\'s title in a tool result', () => {
  test('graph-ops get-ticket, pretty-printed, its children not taken for it', () => {
    const out = JSON.stringify(
      {
        id: 'SCMP-00001',
        project_id: 'proj-1',
        title: 'プロンプト上部に帯を実装する',
        children: [{ id: 'SCMP-00002', title: 'ログの誤りを直す' }],
      },
      null,
      2,
    )
    expect(structuredTitle(['ran it', out], 'SCMP-00001')).toBe('プロンプト上部に帯を実装する')
    expect(structuredTitle([out], 'SCMP-00002')).toBe('ログの誤りを直す')
  })

  test('a record cut short still gives its title', () => {
    expect(structuredTitle(['{\n  "id": "SCMP-00001",\n  "title": "帯を実装する",\n  "description": "セッ'], 'SCMP-00001')).toBe('帯を実装する')
  })

  test('Jira: the key, then fields.summary, before the issue type\'s name', () => {
    const issue = '{"key":"PROJ-123","fields":{"summary":"Login fails with \\"bad token\\"","issuetype":{"id":"1","name":"Bug"}}}'
    expect(structuredTitle([issue], 'PROJ-123')).toBe('Login fails with "bad token"')
  })

  test('the newest record wins; a mention with no record gives none', () => {
    const old = '{"id":"PROJ-1","title":"old title"}'
    const renamed = '{"id":"PROJ-1","title":"new title"}'
    expect(structuredTitle([old, 'talking about PROJ-1', renamed], 'PROJ-1')).toBe('new title')
    expect(structuredTitle(['PROJ-1 is broken', '{"id":"PROJ-2","title":"other"}'], 'PROJ-1')).toBe(null)
  })
})
