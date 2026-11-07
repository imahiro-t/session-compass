# Session Compass

English | [日本語](README.ja.md)

A Claude Code plugin that adds a band above the prompt. Its left side tells you what the session is about: a one-line summary of what you have asked so far, or, in a session that works on a ticket, that ticket's ID and title. Its right side has buttons to step through your prompts in the conversation: ⏫ the first, 🔼 the previous, 🔽 the next, ⏬ the newest. The summary follows the session as it moves on (after each prompt, or only when you press 🔁, as you choose in settings), and it shows above Claude's question dialog too.

## How it works

### The summary

- After each of your prompts, the summary is made again from your first prompt and your newest ones (up to eight), so it moves with the topic as the session goes on. A model call (haiku) writes it.
- While a new summary is being made, and if one fails, the last one stays on the band.
- Slash commands count as prompts when they carry arguments (`/graph-ops:process-ticket SCMP-00001`, say); ones with none (`/clear`, `/config`) do not.
- In `manual` mode (see [`summaryMode`](#summarymode)) the first summary is still made by itself; after that it is made again only when you press 🔁 on the band.
- The summary is drawn bold in the theme's `claude` colour, so it stands out from plain text in both light and dark themes.

### The ticket

When a prompt asks to work on a ticket, the band shows that ticket for the rest of the session instead of the summary.

- A ticket is an ID such as `SCMP-00001` or `PROJ-123` in your prompt. Standards and versions such as `UTF-8` or `RFC-2119` are not tickets.
- An ID in a slash command's arguments counts as a request to work on it. An ID in an ordinary prompt is judged by a model call: "fix PROJ-123" fixes the band to it, "what did PROJ-12 say about this?" does not.
- The title is taken, whatever the tracker, from what the skill or tool working on the ticket read:
  - A tool result that holds the ticket's record (JSON naming the ID under `id`, `key` and the like, with a `title`, `summary`, `subject` or `name`: graph-ops' `get-ticket`, Jira's `fields.summary`, ...) gives the title with no model call, looked for as each tool call ends
  - Failing that, haiku looks for it in the parts of the conversation that mention the ID, at the end of a turn, tool results first, and again only once the ID is mentioned more (up to five tries)
  - For a [graph-ops](https://github.com/imahiro-t/graph-ops) ticket, `graph-engine get-ticket <ID>` is also run when the ticket is found, where `graph-engine` is on the PATH
  - Until then the band shows the ID alone
- The ID is drawn in the theme's `suggestion` colour and the title in `claude`.

### The buttons

- 🔼 and 🔽 go one prompt back and forward. Only your own prompts are stops, slash commands included: notifications, messages from other agents and the like are not. A move puts the prompt's row at the top of the transcript.
- ⏫ goes to the very first prompt of the session, and ⏬ to the very end of the transcript (the line that closes the last turn, or the newest row). Both read the session's transcript file for it, so they reach rows far off screen that the band has never seen drawn, in a long or resumed session too.
- If you scroll the transcript yourself, the buttons count from what you are reading: 🔼 goes back to the start of the prompt whose reply is on screen, 🔽 on to the next one. Until you scroll, they count from where the last button left you.

### While Claude asks you a question (AskUserQuestion)

The question dialog takes the prompt's place, and the band with it. The ticket or summary then shows on one row above the dialog, cut to fit (the dialog's rows are limited), without the buttons.

### What is sent, and when

- The summary sends your first prompt and your newest prompts (each cut to 600 characters) to haiku after each prompt (`auto`) or on 🔁 (`manual`).
- A prompt holding a ticket ID that is not in a slash command's arguments is sent to haiku once, to judge whether it asks to work on the ticket.
- For a ticket whose title no tool result's record gives, the parts of the conversation around its ID (up to 6,000 characters) are sent to haiku after a turn, only when the ID is mentioned more than at the last try, at most five times.
- `graph-engine get-ticket <ID>` runs on your machine for a ticket ID when it is found; where `graph-engine` is not installed, nothing happens.
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

A session on a ticket shows no 🔁. Change it in `/config`, or in your settings:

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

- Claude Code's own header at the top of the transcript, which names the prompt you are reading while you scroll, can name the prompt before the one 🔽 moved to. The header is Claude Code's, not this plugin's, and the plugin leaves it alone.
- In a resumed session, tickets are found only in the prompts you send from then on, not in the slash commands of the earlier part.

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
