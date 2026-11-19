// session-compass: the values this mod keeps in `$.state` for the session.

/**
 * Where the summary of the session stands. It is made again each time the
 * person says something new, from the prompts so far.
 *
 * `basis` is how many of the kept prompts (`prompts`) the summary was asked
 * for; a summary stored before it existed counts as one. `text` on `pending`
 * and `failed` is the last summary made, still shown while a new one runs or
 * after one fails. `pending` carries the token of the module environment that
 * started it, so a later environment (after a hot reload or a worker respawn)
 * can tell a summary it lost from one it is still running.
 */
export type Summary =
  | { status: 'idle' }
  | { status: 'pending'; token: string; basis?: number; text?: string }
  | { status: 'done'; text: string; basis?: number }
  | { status: 'failed'; reason: string; basis?: number; text?: string }

/**
 * A stop seen only by drawing its transcript row (e.g. after a resume): its
 * id and the fingerprint of its text, never the text itself. A prompt's key
 * is `promptKey` of its text; a reply's is `replyKey` (`r:` before it).
 */
export type PastPrompt = { id: string; key: string }

/**
 * Everything the navigation buttons read, kept under one key so it is always
 * written whole with one compare-and-set.
 *
 * A stop is a row the buttons step to: one of the person's prompts or, with
 * userConfig `navTarget` set to `all`, one of Claude's replies (an output
 * block, `AssistantMessage`). The field names stay those of the prompts-only
 * version, so a nav stored by it reads the same.
 */
export type Nav = {
  /** Ids of the stops appended in this process, oldest first. */
  liveIds: string[]
  /** Stops known only from drawn rows, not in `liveIds`. */
  pastPrompts: PastPrompt[]
  /** Every stop, oldest first: ordered past, then live. */
  promptIds: string[]
  /** The id of the stop last moved to; null means the end of the transcript. */
  cursorId: string | null
  /**
   * The stops of `promptIds` that are replies, not prompts. Absent in a nav
   * stored before replies were stops: none of its stops is a reply.
   */
  replyIds?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-compass': {
      firstPrompt: string | null
      summary: Summary
      nav: Nav
      /** The person's prompts, each cut short: the first and the newest ones. */
      prompts: string[]
      /** How the output blocks (`AssistantMessage` rows) are folded: the fold-all setting and the blocks turned against it. */
      fold: { allFolded: boolean; flipped: string[] }
      /** The stop (a prompt or a reply) the last button move landed on, drawn lit; null when none is. */
      highlightId: string | null
    }
  }
}
