# session-compass

A Claude Code mod that adds a band above the prompt:

- **Left:** a summary of the session (starting with a summary of the first prompt)
- **Right:** buttons to step back and forth through the conversation

## Settings

- **`summaryMode`** (`auto` | `manual`, default `auto`): how the band's summary is kept.
  - `auto`: made again after each prompt.
  - `manual`: made once for the first prompt, then only when you press 🔁 on the band.

  Change it from the config menu (`/config`), or under `pluginConfigs` in your settings.

> Work in progress.

## License

MIT
