// session-compass: the values this mod keeps in `$.state` for the session.

/**
 * Where the one-time summary of the session's first prompt stands.
 *
 * `pending` carries the token of the module environment that started the
 * summary, so a later environment (after a hot reload or a worker respawn)
 * can tell a summary it lost from one it is still running.
 */
export type Summary =
  | { status: 'idle' }
  | { status: 'pending'; token: string }
  | { status: 'done'; text: string }
  | { status: 'failed'; reason: string }

/**
 * A prompt seen only by drawing its transcript row (e.g. after a resume):
 * its id and the fingerprint of its text (`promptKey`), never the text itself.
 */
export type PastPrompt = { id: string; key: string }

/**
 * Everything the navigation buttons read, kept under one key so it is always
 * written whole with one compare-and-set.
 */
export type Nav = {
  /** Ids of the person's prompts appended in this process, oldest first. */
  liveIds: string[]
  /** Prompts known only from `UserMessage` rows, not in `liveIds`. */
  pastPrompts: PastPrompt[]
  /** What the buttons step through, oldest first: ordered past, then live. */
  promptIds: string[]
  /** The id of the prompt last moved to; null means the end of the transcript. */
  cursorId: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-compass': {
      firstPrompt: string | null
      summary: Summary
      nav: Nav
    }
  }
}
