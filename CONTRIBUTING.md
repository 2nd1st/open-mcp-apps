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

## License and the CLA

This project is dual-licensed by directory: the **engine** (everything outside
`components/`) is **AGPL-3.0-only**, and the official **apps** in
`components/` are **MIT**. See [LICENSING.md](LICENSING.md) for the full map and
[TRADEMARKS.md](TRADEMARKS.md) for the reserved names.

What that means for you depends on which half you're touching.

**Apps (`components/`) — nothing to sign, ever.** They are MIT in, MIT out.
MIT already grants everything the project could ask for, so an app PR needs
no agreement now and will not need one later. New example apps and fixes to
existing ones are the easiest contribution to land.

**The engine (everything else) — open an issue first.** A Contributor License
Agreement is intended here: it is what lets the engine stay AGPL while remaining
offerable under other terms (including embedded in the maintainers' own hosted
service), and without it a single merged contribution could bind the whole
project — its maintainers included — to the AGPL. [CLA.md](CLA.md) is **in
effect for engine contributions**: your first PR gets a CLA check, and you sign
by replying to its prompt with one comment — once, against your GitHub identity.
`components/` contributions need no agreement. Contributing on behalf of an
employer? Open an issue first — corporate CLAs are handled case by case.

**Sign your commits off** (`git commit -s`). That adds a `Signed-off-by:` line
asserting the [Developer Certificate of Origin](https://developercertificate.org/)
— that the work is yours to submit. It applies to both halves, costs one flag,
and is the provenance record the project relies on today.
