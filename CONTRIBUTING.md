# Contributing to open-mcp-apps

Thanks for your interest. **open-mcp-apps** is an open engine built on the
[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) standard — a component registry
the AI can write to, persistent versioned data, and a shell runtime that makes AI-authored components
actually work.

## Development setup

```bash
git clone https://github.com/2nd1st/open-mcp-apps && cd open-mcp-apps
npm install
node build.mjs      # bundle the browser shell runtime → dist/
npm test            # server + http + seed smokes
```

The store lives in a fixed per-user directory. During development, point it at a throwaway file with
`OMA_DB=/tmp/dev.db node …` so you never touch your real store.

## Tests

Three real smoke suites, no framework — keep them green and add assertions for new behavior:

- `node test/server-smoke.mjs` — the stdio MCP server over a real transport (incl. runtime component creation)
- `node test/http-smoke.mjs` — the HTTP transport
- `node test/seed-smoke.mjs` — the seed / design-kit pipeline

`npm test` runs all three.

## Authoring components

Components are single-file HTML against the tiny `window.oma` API. The authoritative contract is what
the engine serves from the **`get_component_guide`** tool (source: `src/guide.mjs`) — read it before
writing one. The host sandbox is strict: no `confirm()`/`alert()`/`prompt()`, no `target="_blank"` or
`window.open()`, no network/fetch. The guide spells out the patterns that work.

## Pull requests

- One focused change per PR; keep the diff readable.
- Match the surrounding style — vanilla JS/DOM, no build-heavy dependencies.
- Run `npm test` before pushing; add assertions for anything new.
- Say what changed and why.

## Scope

open-mcp-apps is the **engine**: the registry, the shell runtime, the data/command layer, the host
adapters. It stays standard-first (no host-private APIs) so one codebase serves every host that renders
`ui://`. Bug fixes, new host adapters, guide improvements, and example components are all welcome.

By contributing you agree your contributions are licensed under the [MIT License](LICENSE).
