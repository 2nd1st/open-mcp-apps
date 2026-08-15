# Contributing to open-mcp-apps

Thanks for your interest. **open-mcp-apps** is an open engine built on the
[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) standard — an app registry
the AI can write to, persistent versioned data, and a shell runtime that makes AI-authored apps
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

- `node test/server-smoke.mjs` — the stdio MCP server over a real transport (incl. runtime app creation)
- `node test/http-smoke.mjs` — the HTTP transport
- `node test/seed-smoke.mjs` — the seed / design-kit pipeline

`npm test` runs all three.

## Authoring apps

Apps are single-file HTML against the tiny `window.oma` API. The authoritative contract is what
the engine serves from the **`get_app_guide`** tool (source: `src/guide.mjs`) — read it before
writing one. Not in a host? Print it yourself:
`node -e 'import("./src/guide.mjs").then(m => console.log(m.GUIDE))'` — it is roughly three times
the size of `RUNTIME.md`, and everything about layout and the CSS kit lives only there. The host sandbox is strict: no `confirm()`/`alert()`/`prompt()`, no `target="_blank"` or
`window.open()`, no network/fetch. The guide spells out the patterns that work.

## Pull requests

- One focused change per PR; keep the diff readable.
- Match the surrounding style — vanilla JS/DOM, no build-heavy dependencies.
- Run `npm test` before pushing; add assertions for anything new.
- Say what changed and why.

## Scope

open-mcp-apps is the **engine**: the registry, the shell runtime, the data/command layer, the host
adapters. It stays standard-first (no host-private APIs) so one codebase serves every host that renders
`ui://`. Bug fixes, new host adapters, guide improvements, and example apps are all welcome.

## License

This project is **MIT throughout** — the engine and the official apps in
`components/` alike. See [LICENSING.md](LICENSING.md) for the map and
[TRADEMARKS.md](TRADEMARKS.md) for the reserved names, which the license does
not grant.

**Nothing to sign, ever.** MIT in, MIT out. MIT already grants everything the
project could ask for, so no contribution needs an agreement now and none will
later — engine and apps alike, whether you contribute as an individual or on
behalf of an employer.

There used to be a CLA for engine contributions. It existed only because the
engine was AGPL while the project retained the right to offer it under other
terms; that grant now lives in the license every patch already arrives under, so
the CLA and its check workflow were removed in v0.5.4. If you signed it earlier,
nothing about your contribution changes — it granted rights MIT grants anyway.

**Sign your commits off** (`git commit -s`). That adds a `Signed-off-by:` line
asserting the [Developer Certificate of Origin](https://developercertificate.org/)
— that the work is yours to submit. DCO is a provenance record, not a license
grant, so the relicense leaves it exactly where it was: it costs one flag, and
it is the provenance record the project relies on today.
