# Session Compass

English | [日本語](README.ja.md)

A Claude Code plugin that adds a band above the prompt. Its left side tells you what the session is about: a one-line summary of what you have asked so far. Its right side has buttons to step through your prompts in the conversation: ⏫ the first, 🔼 the previous, 🔽 the next, ⏬ the newest. The summary follows the session as it moves on (after each prompt, or only when you press 🔁, as you choose in settings), and it shows above Claude's question dialog too.

## How it works

### The summary

- After each of your prompts, the summary is made again from your first prompt and your newest ones (up to eight), with the last summary made carrying what came between, so it moves with the topic as the session goes on. A model call (haiku) writes it.
- While a new summary is being made, and if one fails, the last one stays on the band.
- Slash commands count as prompts when they carry arguments (`/graph-ops:process-ticket SCMP-00001`, say); ones with none (`/clear`, `/config`) do not.
- In `manual` mode (see [`summaryMode`](#summarymode)) the first summary is still made by itself; after that it is made again only when you press 🔁 on the band.
- The summary is drawn bold in the theme's `claude` colour, so it stands out from plain text in both light and dark themes.

### The buttons

- 🔼 and 🔽 go one prompt back and forward. Only your own prompts are stops, slash commands included: notifications, messages from other agents and the like are not. A move puts the prompt's row at the top of the transcript.
- ⏫ goes to the very first prompt of the session, and ⏬ to the very end of the transcript (the line that closes the last turn, or the newest row). Both read the session's transcript file for it, so they reach rows far off screen that the band has never seen drawn, in a long or resumed session too.
- If you scroll the transcript yourself, the buttons count from what you are reading: 🔼 goes back to the start of the prompt whose reply is on screen, 🔽 on to the next one. Until you scroll, they count from where the last button left you.
- The prompt row a button lands on gets a background colour (the theme's `diffAddedDimmed`, with a `▌` mark in the `claude` colour at its left, so the row stands out without colour too), so you can see where you went. Moving to another prompt moves the colour with you, and sending a new prompt clears it. When ⏬ lands at the very end of the transcript, the newest prompt's row is the one coloured; it is not necessarily on screen then (a long latest reply pushes it above the window).

### While Claude asks you a question (AskUserQuestion)

The question dialog takes the prompt's place, and the band with it. The summary then shows on one row above the dialog, cut to the same width as on the band (so it shows as many characters as the band would at that window width), without the buttons. The dialog has no body width of its own to read, so the band's is reckoned from the window's columns; with a pane docked beside the transcript it can differ from the band's by a few cells.

### Folding Claude's output

- Each block of Claude's output that takes more than one row (wrapping counted: one long paragraph counts too) gets a marker at its left: `▼` while it is open, `▶` while it is folded. A block of one row gets none (blank lines before or after its text are not counted).
- Every block starts open. Click the marker to fold the block, and again to open it. The marker is drawn bold in the theme's `claude` colour, and is named by what a press does ("Fold output" / "Expand output") where the surface reads controls aloud; the output itself keeps Claude Code's own colours and drawing.
- A folded block shows one row: its first line of text, without markdown decoration, cut to the window's width, with `…` when the block has more text than that line. A block that starts with a code fence or a table shows its first line of prose (a table, its header cells), not the code or the table rules; a block that is only code shows the code's first line.
- Only the text blocks of Claude's replies fold. Tool calls and their results are not touched (Claude Code folds those itself with ctrl+o).

### What is sent, and when

- The summary sends your first prompt and your newest prompts (each cut to 600 characters), with the last summary made (cut to 200), to haiku after each prompt (`auto`) or on 🔁 (`manual`).
- ⏫ and ⏬ read the session's transcript file under `~/.claude/projects/` on your machine (its first 2 MB, or its last 200 lines, with `head` and `tail`). Nothing of it is sent anywhere.

## Install

This repository is its own marketplace (`.claude-plugin/marketplace.json`, named `session-compass`). At the prompt of a Claude Code terminal session, run the following.

```
/plugin marketplace add imahiro-t/session-compass
/plugin install session-compass@session-compass
```

1. When the plugin's details show, choose a scope (the user scope enables it in every later session)
2. On the settings screen, set `summaryMode` (default `auto`)
3. Once `Installed session-compass. Plugin is now active.` shows, it works in that session right away

Session Compass is also listed in the [erin-the-black-plugins](https://github.com/imahiro-t/claude-plugins) marketplace (installed from there, the settings key in the example below is `session-compass@erin-the-black-plugins` instead of `session-compass@session-compass`). Install it from one of the two marketplaces only: installed from both, its hooks are registered twice and the band is drawn by both. To switch from one to the other, uninstall the one you have first.

## Settings (userConfig)

### `summaryMode`

How the band's summary is kept: `auto` (the default) or `manual`.

| Value | What happens |
| --- | --- |
| `auto` | The summary is made again after each of your prompts |
| `manual` | The summary of the first prompt is made by itself; after that, only when you press 🔁 on the band. 🔁 makes it again even when nothing new was said |

Change it in `/config`, or in your settings:

```json
{
  "pluginConfigs": {
    "session-compass@session-compass": {
      "options": { "summaryMode": "manual" }
    }
  }
}
```

## Known limitations

- Folding and the highlight work in fullscreen mode (and on remote surfaces that redraw transcript rows). In the main, non-fullscreen screen, rows already written to the terminal's scrollback are never drawn again, so a fold or a highlight does not show there; the buttons' moves need fullscreen anyway.
- The fold marker is pressed with a click (the mouse) only: buttons inside the transcript cannot take the keyboard focus, so there is no key for it.
- Whether a block takes more than one row is reckoned from its plain text width, so where markdown changes the drawn width (a heading's marks, a link's URL) a block right at one row may get a marker; folding it then simply shows the same single row.
- The fold state is kept by each block's message id. A block drawn under a temporary id while it streams may open again once it has its own.
- Claude Code's own header at the top of the transcript, which names the prompt you are reading while you scroll, can name the prompt before the one 🔽 moved to. The header is Claude Code's, not this plugin's, and the plugin leaves it alone.

## Development

Run the plugin from this folder while you work on it, with the debug log on:

```sh
claude --debug --plugin-dir .
```

Saving a file reloads the plugin in that session. Before a change goes in, check it:

```sh
claude plugin validate .
claude plugin test .
```

## Releasing

1. Raise `version` in `.claude-plugin/plugin.json` and merge the change into `main`
2. Tag that commit of `main` with `vX.Y.Z` and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`
3. In [imahiro-t/claude-plugins](https://github.com/imahiro-t/claude-plugins), set the `ref` of the `session-compass` entry in `.claude-plugin/marketplace.json` to the new tag
4. Run `claude plugin validate .` at the root of claude-plugins, and once it passes, get the change into its `main`
5. (Optional) Try the install from the erin-the-black-plugins marketplace with a temporary configuration directory, using the same directory for every command:

   ```sh
   TMP=$(mktemp -d)
   CLAUDE_CONFIG_DIR="$TMP" claude plugin marketplace add imahiro-t/claude-plugins
   CLAUDE_CONFIG_DIR="$TMP" claude plugin install session-compass@erin-the-black-plugins
   rm -rf "$TMP"
   ```

Push the tag before the `ref` reaches claude-plugins' `main`: until the tag exists, installing from erin-the-black-plugins fails, and `claude plugin validate .` does not catch that.

## License

MIT
