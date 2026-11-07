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
 * The ticket the session works on, found in the person's prompts (a ticket
 * id such as `SCMP-00001` or `PROJ-123`). Once found the band shows it in
 * place of the summary for the rest of the session.
 *
 * `title` is null until it is known: from `graph-engine get-ticket` for a
 * graph-ops ticket (`source: 'graph-ops'`), else from the transcript once the
 * ticket's title shows up there (`source: 'transcript'`): a tool result's
 * record of the ticket, read with no model, or else what the model finds.
 * `titleTries` counts the model's searches that found none (they stop at
 * five), and `mentionCount` how often the transcript named the id at the
 * last one, so it is asked again only once there is more.
 */
export type Ticket = {
  id: string
  title: string | null
  source: 'graph-ops' | 'transcript' | 'prompt'
  titleTries?: number
  mentionCount?: number
}

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
      /** The person's prompts, each cut short: the first and the newest ones. */
      prompts: string[]
      ticket: Ticket | null
    }
  }
}
