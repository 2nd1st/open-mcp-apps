# open-mcp-apps

**English** | [简体中文](README.zh-CN.md)

> Give your AI a persistent, reusable UI. It builds the component once — you keep it forever.

**open-mcp-apps** is an open engine built on the [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)
standard (`ui://`, SEP-1865). It gives any MCP-Apps-capable host (Claude Desktop, claude.ai, …)
three things the standard itself doesn't provide:

1. **A component registry the AI can write to.** Ask for a UI that doesn't exist — the AI reads
   the authoring guide, writes a single-file HTML component against a tiny `window.oma` API,
   and saves it. From that moment `open_<name>` is a tool, in this chat and every future one.
2. **Persistent, versioned data — separate from the UI.** Components bind to generic
   *collections* of items backed by SQLite plus an append-only `change_event` ledger. Every
   mutation is an idempotent domain command (`command_id`) with optimistic concurrency
   (`expected_version`). The AI and the human edit the same store — the widget is just a view.
3. **A shell runtime so AI-written components actually work.** Serving `ui://`, the engine wraps
   the component with the official MCP App bridge, host theming (Claude's design tokens,
   light/dark), and the `window.oma` data API. A component is ~50 lines of view code; the
   protocol, persistence, idempotency and theming are the engine's problem.

## The loop

```
"make me a kanban"
      │
      ▼
list_components ── exists? ──► open_kanban          (reuse, instant)
      │ no
      ▼
get_component_guide ──► AI writes HTML ──► save_component
      │
      ▼
open_kanban  →  rendered inline, themed, persistent — reusable in every future chat
```

Components accumulate. Each one is single-purpose and independent — a board, a tracker, a
splitter — minted for the task in front of you and kept for the next time you need it.

## What it looks like

The built-in library ships 16 ready-made apps — real, working previews, installed in a click:

![The component library — live previews of ready-made apps](.github/screenshots/library.png)

| | |
|---|---|
| ![Companion — an AI character with shared memory](.github/screenshots/companion.png) | ![Family Week — dinners, chores rotation, shopping and weekend plans](.github/screenshots/family-week.png) |
| ![Study Cards — spaced repetition with review heatmap and deck shelf](.github/screenshots/study-cards.png) | ![Knowledge Cards — a visual library of saved answers](.github/screenshots/knowledge-cards.png) |

Every app above is a single HTML file bound to plain data collections — written with the same
`window.oma` API and authoring guide your AI will use for the apps it builds you.

## Install

open-mcp-apps runs as a local MCP server. First get it **connected** to your host (below); then
**onboarding happens inside the host, separately** — that's where the AI builds your first app.
Installing needs a shell, so the chat apps (Claude Desktop, Codex) can't install themselves — use one
of these:

**As a user — one command:**

```bash
curl -fsSL https://raw.githubusercontent.com/2nd1st/open-mcp-apps/main/install.sh | sh
```

It opens a short picker to choose which hosts to register into — **Claude Desktop, Claude Code,
Codex** — plus your permission preference. Skip it with `-s -- --yes`, or target one host with
`-s -- --host codex`. (Or clone and run it yourself: `git clone
https://github.com/2nd1st/open-mcp-apps && cd open-mcp-apps && node install.mjs`.)

**With a coding agent** (Claude Code, Codex CLI — they have a shell), paste:

> Read https://raw.githubusercontent.com/2nd1st/open-mcp-apps/main/install.md and follow it.

Either way, `install.mjs` registers the server into each host you pick (Claude Desktop, Claude Code,
Codex), idempotently — it never clobbers your other servers, pins a stable `node` launcher (native SQLite
ABI), reports what changed, and cleans up a pre-rename entry if one lingers. Your data lives in a
**fixed per-user store** (not inside the clone), so every host shares the same apps and data. **After
installing or updating, fully quit and reopen the host** (Cmd-Q, not just close the window) — it keeps
its old server process on the old data until fully quit. *Remote / one-click install (no shell) is
coming later.*

**Uninstall:** `node uninstall.mjs` unregisters the server from every host it finds — but **keeps
your data**: the shared store stays put, so re-installing later restores every component and all
data. Add `--purge` to also delete the shared store (irreversible), or `--check` to preview what
would happen without changing anything:

```bash
node uninstall.mjs           # unregister from all detected hosts — keeps your data
node uninstall.mjs --purge   # also delete the shared store (components + data), irreversible
node uninstall.mjs --check   # read-only: show what's registered and what would change
```

**Reset escape hatch:** the whole store is one SQLite file, `open-mcp-apps.db`, in
`~/Library/Application Support/open-mcp-apps/` (macOS), `%APPDATA%\open-mcp-apps\` (Windows), or
`$XDG_DATA_HOME` else `~/.local/share/open-mcp-apps/` (Linux). Fully quit your host(s), delete
that file (plus its `-wal`/`-shm` siblings), and you start clean — all components and data gone,
irreversibly, while staying installed.

**Then get started — in your host.** Restart it. New here? Tell the AI something like **"I just
installed open-mcp-apps — show me how to use it with a couple of examples, and suggest a few apps that
fit how I work."** It reads what it can build, draws on what it knows about you (your memory and past
chats — or it asks a couple of questions), and sets up a first app or two tailored to you. This step
is separate from install and lives in the host. Or just ask directly:

- *"make me a board for what I'm juggling right now"* → the AI writes it, seeds it, and opens it (persistent)
- *"make me a habit tracker"* → watch it read the guide, write the component, save it, open it
- close the app, reopen, ask again → everything is still there

**First-run permissions:** the first few tool calls each show an approval dialog — pick
**"Always allow"**. The tool set is small and stable on purpose: read-only tools generally
skip approval, and the single `open_component` tool covers opening *every* component
(including ones the AI creates later), so after those first clicks it's zero-prompt forever.
You can also batch it in **Settings → Connectors → open-mcp-apps → Tool permissions**.
Note: a Desktop auto-update occasionally resets these decisions (upstream
[#56954](https://github.com/anthropics/claude-code/issues/56954)) — just re-allow.
Multiple widgets in one conversation work fine (habit-streaks + meal-planner side by side).

## What's in the box

| | |
|---|---|
| `src/server.mjs` | stdio MCP server; single `open_component` path (per-component `open_<name>` tools opt-in) |
| `src/http.mjs` | `/mcp` (stateless Streamable HTTP) + `/view/<name>` browser viewer, bound to `127.0.0.1` |
| `src/store.mjs` | SQLite: items + component registry + `change_event` ledger (idempotent, OCC) |
| `src/shell-runtime.js` | browser runtime injected into every component (`window.oma`) |
| `src/shell.mjs` | wraps stored HTML with runtime + design-token fallbacks at serve time |
| `src/guide.mjs` | the authoring contract the AI reads before generating a component |
| `install-app.mjs` | install an app you wrote yourself, from a file — the one door into the registry that doesn't go through the AI |
| `components/` | 3 system components installed on seed (settings, dashboard, library) + 16 library apps — not auto-installed; browse the library app for live previews with sample data and one-click install |

```bash
npm test                     # every suite below, plus the static invariants and budget checks
node test/server-smoke.mjs   # 351 assertions over real stdio — incl. runtime component creation
node test/http-smoke.mjs     #  35 assertions over the HTTP transport (incl. SSE /events)
node test/provenance.mjs     #  39 assertions that a component's author — its trust tier — is not overwritable
node test/seed-smoke.mjs     #  12 assertions on the seed / design-kit pipeline
node test/files-smoke.mjs    #  45 assertions on the per-app file store (chunked uploads, GC races)
```

### Writing an app yourself

The AI is the usual author, but it isn't the only one — its context window shouldn't be the ceiling
on what an app can be. Build one in your own editor, with your own bundler, and install it:

```bash
node install-app.mjs ./my-app.html              # yours, full trust — same as an AI-authored app
node install-app.mjs ./my-app.html --sandboxed  # untrusted: runs behind the runner, no capabilities
node install-app.mjs --list                     # what's installed, and under whose provenance
```

One self-contained HTML document, ≤200 KB, no network requests — the engine injects the kit CSS,
the host's design tokens and `window.oma`. The trade: the AI can no longer iterate on it (your file
is the source of truth, you rebuild and re-install), though it can still read the source, and the
app shares your data like any other. Provenance is not overwritable in either direction, so an app
installed `--sandboxed` stays sandboxed until you delete it.

**[`RUNTIME.md`](RUNTIME.md) is the contract** — the `window.oma` API in both modes, what a
sandboxed app can still do, and the traps that only bite authors who aren't the AI. It carries a
version (`oma.contract`) and `test/runtime-contract.mjs` pins it to the two runtimes' real
surfaces, so it can't drift from them silently.

## Design positions (why it's built this way)

- **UI and data persist separately, both versioned.** Components are views; collections are
  truth; the ledger is history. Swap either without losing the other.
- **The AI talks domain commands, never SQL, never raw state.** That's what makes human+AI
  concurrent editing safe (idempotency + optimistic concurrency at the command layer).
- **Standard-first.** Everything rides the MCP Apps standard bridge — no host-private APIs.
  One codebase should serve every host that renders `ui://`.
- **Single-purpose, not composite.** Each app owns one scenario and its own collection; the
  engine mints a new one rather than cramming features into an old one. System apps (settings,
  dashboard) are the deliberate exception — engine-owned, privileged, allowed to see across
  collections.

## Security model

Trust is tiered by where a component came from. Locally-authored and system components run in
**direct mode**. The engine also ships a **runner** — a sandboxed `srcdoc` iframe with a
CSP-first document and a minimal read-scoped bridge — as the mandatory execution mode for any
component that isn't locally trusted, plus reserved `security:*` / `policy:*` config keys that
generic data writes can't touch and an out-of-band privileged writer.

**Honest status:** everything in the OSS version — your apps, AI-built apps, and the built-in
library apps (all first-party) — runs locally in direct mode with full trust; there is nothing
third-party to sandbox yet. The runner is *built and tested but dormant*: it is the ready seam
for shared/published components later, where review + sandboxing arrive together. See
[`SECURITY.md`](SECURITY.md) for the full threat model and trust tiers.

## Host support (live-tested 2026-07-22)

| Host | Renders widgets | Human clicks widget | AI operates data | Same store |
|---|---|---|---|---|
| **Claude Desktop** (local stdio) | ✅ | ✅ full loop incl. `sendMessage` reply | ✅ | ✅ |
| **Browser viewer** (`/view/<name>`) | ✅ | ✅ (no chat attached — `sendMessage` degrades to a notice) | via CLI AI | ✅ |
| **Codex desktop** (ChatGPT app, `enable_mcp_apps` flag) | ✅ experimental | ◐ updates/toggles from widget clicks work; adds still blocked host-side ([openai/codex#28912](https://github.com/openai/codex/issues/28912), see KNOWN-ISSUES) | ✅ | ✅ |
| **Claude Code** (CLI, `claude mcp`) | — (text fallback by design) | — | ✅ | ✅ |
| **codex CLI / IDE** | — (text fallback by design) | — | ✅ | ✅ |
| **ChatGPT web** (Work mode) | supported by the standard — needs remote HTTPS (`/mcp` + tunnel), untested here | | | |

Everything rides the standard bridge, so host fixes upstream (e.g. #28912) benefit this
project with zero changes.

## Status / roadmap

Early v0 — proven end-to-end on Claude Desktop; cross-vendor render + shared store proven
on Codex desktop and the browser viewer.

- [x] engine: registry + shell + generic data commands + ledger
- [x] system components installed (settings, dashboard, library); 16 library apps with live previews, one-click install
- [x] AI component creation loop (guide → save → dynamic tool)
- [x] in-context onboarding (ask how to use it → the AI reads your history/memory and builds a tailored starter set)
- [x] security foundation: trust tiers + sandboxed runner + reserved config keys
- [x] multi-host discovery installer (Claude Desktop · Claude Code · Codex) + shared per-user store
- [ ] `npx` one-command install
- [ ] remote (Streamable HTTP) mode → claude.ai / ChatGPT / mobile
- [ ] component export/import → sharing → community library (review + runner sandbox activate here)

## License

Two licenses, split by directory ([`LICENSING.md`](LICENSING.md) has the full map):

- **The engine** — everything outside `components/` — is **AGPL-3.0-only**
  ([`LICENSE`](LICENSE)). Run a modified version as a network service and you
  must offer its source to your users (AGPL §13). Improvements to the engine
  stay open.
- **The official components** in [`components/`](components/) — the apps you run
  and edit — are **MIT** ([`components/LICENSE`](components/LICENSE)). Open, copy,
  fork, and redistribute any app freely; changing your own dashboard is never a
  legal question.

The names **open-mcp-apps**, **openmcp.app**, **SecondFirst**, and **2nd1st**,
and their logos, are **not** granted by either license — see
[`TRADEMARKS.md`](TRADEMARKS.md). Fork the code freely; give your fork its own name.

Copyright © 2026 2nd1st.

Component contributions need nothing signed — MIT in, MIT out. For engine
contributions, open an issue first: a CLA is intended but is still a draft
([`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CLA.md`](CLA.md)).

© 2026 [2nd1st](https://github.com/2nd1st)
