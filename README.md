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
- The title comes from `graph-engine get-ticket <ID>` for a [graph-ops](https://github.com/imahiro-t/graph-ops) ticket. For any other tracker (Jira and the like), it is picked up from the conversation once a skill or tool shows it, looked for after each turn (up to three tries); until then the band shows the ID alone.
- The ID is drawn in the theme's `suggestion` colour and the title in `claude`.

### The buttons

- ⏫ goes to your first prompt, ⏬ to the newest, 🔼 and 🔽 one prompt back and forward. Only your own prompts are stops: notifications, messages from other agents and the like are not.
- A move puts the prompt's row at the top of the transcript.
- If you scroll the transcript yourself, the buttons count from what you are reading: 🔼 goes back to the start of the prompt whose reply is on screen, 🔽 on to the next one. Until you scroll, they count from where the last button left you.

### While Claude asks you a question (AskUserQuestion)

The question dialog takes the prompt's place, and the band with it. The ticket or summary then shows on one row above the dialog, cut to fit (the dialog's rows are limited), without the buttons.

### What is sent, and when

- The summary sends your first prompt and your newest prompts (each cut to 600 characters) to haiku after each prompt (`auto`) or on 🔁 (`manual`).
- A prompt holding a ticket ID that is not in a slash command's arguments is sent to haiku once, to judge whether it asks to work on the ticket.
- For a ticket whose title is not known, the parts of the conversation around its ID (up to 6,000 characters) are sent to haiku after a turn, at most three times.
- `graph-engine get-ticket <ID>` runs on your machine for a ticket ID when it is found; where `graph-engine` is not installed, nothing happens.

## Install

This repository is its own marketplace (`.claude-plugin/marketplace.json`, named `session-compass`). At the prompt of a Claude Code terminal session, run the following.

```
/plugin marketplace add imahiro-t/session-compass
/plugin install session-compass@session-compass
```

1. When the plugin's details show, choose a scope (the user scope enables it in every later session)
2. On the settings screen, set `summaryMode` (default `auto`)
3. Once `Installed session-compass. Plugin is now active.` shows, it works in that session right away

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

## License

MIT
