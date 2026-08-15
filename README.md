# open-mcp-apps

[![npm](https://img.shields.io/npm/v/%402nd1st%2Fopen-mcp-apps?logo=npm&label=npm)](https://www.npmjs.com/package/@2nd1st/open-mcp-apps)
[![license](https://img.shields.io/npm/l/%402nd1st%2Fopen-mcp-apps)](LICENSE)
[![node](https://img.shields.io/node/v/%402nd1st%2Fopen-mcp-apps)](package.json)
[![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dopen-mcp-apps&query=%24.servers%5B0%5D.server.version&label=MCP%20Registry&color=blue&prefix=v)](https://registry.modelcontextprotocol.io/v0/servers?search=open-mcp-apps)

**English** | [简体中文](README.zh-CN.md)

> Give your AI a persistent, reusable UI. It builds the app once — you keep it forever.

**open-mcp-apps** is an open engine built on [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)
(`ui://`, `io.modelcontextprotocol/ui`) — an extension to the core Model Context Protocol
specification, and the first official one, GA since January 2026. It gives any MCP-Apps-capable
host (Claude Desktop, claude.ai, Codex, ChatGPT, …) three things the extension itself
doesn't provide:

1. **An app registry the AI can write to.** Ask for a UI that doesn't exist — the AI reads
   the authoring guide, writes a single-file HTML app against a tiny `window.oma` API,
   and saves it. From that moment you can open it by name, in this chat and every future one.
2. **Persistent, versioned data — separate from the UI.** Apps bind to generic
   *collections* of items backed by SQLite plus an append-only `change_event` ledger. Every
   mutation is an idempotent domain command (`command_id`) with optimistic concurrency
   (`expected_version`). The AI and the human edit the same store — the widget is just a view.
3. **A shell runtime so AI-written apps actually work.** Serving `ui://`, the engine wraps
   the app with the official MCP App bridge, host theming (Claude's design tokens,
   light/dark), and the `window.oma` data API. What you write is a view; the protocol,
   persistence, idempotency and theming are the engine's problem.

| | |
|---|---|
| **Version** | 0.5.6 ([`CHANGELOG.md`](CHANGELOG.md)) |
| **License** | MIT, whole repository ([`LICENSE`](LICENSE) · [`LICENSING.md`](LICENSING.md)) |
| **npm** | `@2nd1st/open-mcp-apps` — **scoped**; the unscoped name is an unrelated package |
| **Run it** | `npx -y @2nd1st/open-mcp-apps` (stdio MCP server) |
| **Requires** | Node 22 or newer. `git` too, on the installer path |
| **Surface** | 33 tools · a built-in App Store · 3 system apps seeded |
| **Platforms** | macOS · Windows · Linux |
| **Hosts** | Claude Desktop · Claude Code · Codex · ChatGPT web — see [Host support](#host-support) |
| **Hosted** | [openmcp.app](https://openmcp.app) |

## Install

open-mcp-apps runs as a local MCP server. First get it **connected** to your host (below); then
**onboarding happens inside the host, separately** — that's where the AI builds your first app.

### From npm — nothing to clone

If you are comfortable editing your host's config file, point it at the published package and
let `npx` fetch the engine. This path needs only Node 22 — no `git`, and no checkout for you to
keep updated. Paste this into your host's MCP server config:

```json
{
  "mcpServers": {
    "open-mcp-apps": {
      "command": "npx",
      "args": ["-y", "@2nd1st/open-mcp-apps"]
    }
  }
}
```

Two things the installer below does that this path does not: it registers the server into every
host it finds, and it pre-seeds the built-in system apps (settings, dashboard, App Store) into
your store — so on the `npx` path your registry starts empty and your AI installs what it needs
from the App Store on demand, which is fully available either way. Your data lives in the same
fixed per-user store, so you can move between an `npx` server and a cloned one without migrating
anything.

> **A note on npm:** this project publishes under the **scoped** name
> [`@2nd1st/open-mcp-apps`](https://www.npmjs.com/package/@2nd1st/open-mcp-apps). The *unscoped*
> `open-mcp-apps` on the registry is **not this project** — that name is held by an unrelated
> package. Check for the `@2nd1st/` prefix; the scope is the only thing telling the two apart.

### With the installer — one command

Installing needs a shell, so the chat apps (Claude Desktop, Codex) can't install themselves — use
one of these instead:

```bash
curl -fsSL https://raw.githubusercontent.com/2nd1st/open-mcp-apps/main/install.sh | sh
```

It opens a short picker to choose which hosts to register into — **Claude Desktop, Claude Code,
Codex** — plus your permission preference. Skip it with `-s -- --yes`, or target one host with
`-s -- --host codex`.

**With a coding agent** (Claude Code, Codex CLI — they have a shell), paste:

> Read https://raw.githubusercontent.com/2nd1st/open-mcp-apps/main/install.md and follow it.

Either way, `install.mjs` registers the server into each host you pick, idempotently — it never
clobbers your other servers, pins a stable `node` launcher (native SQLite ABI), reports what
changed, and cleans up a pre-rename entry if one lingers. Your data lives in a **fixed per-user
store** (not inside the clone), so every host shares the same apps and data.

### From a clone — for development

```bash
git clone https://github.com/2nd1st/open-mcp-apps && cd open-mcp-apps
npm install
node install.mjs        # same picker as the one-liner above
```

To wire a clone into a host by hand instead, point it at the checkout — this is the shape
`install.mjs` writes:

```json
{
  "mcpServers": {
    "open-mcp-apps": {
      "command": "node",
      "args": ["/absolute/path/to/open-mcp-apps/src/server.mjs"]
    }
  }
}
```

### Hosted

[openmcp.app](https://openmcp.app) runs the engine for you. The engine in this repository binds
`127.0.0.1` by design, so a self-hosted remote deployment is not a supported shape yet — see
[Status and roadmap](#status-and-roadmap).

### Uninstall

`node uninstall.mjs` unregisters the server from every host it finds — but **keeps your data**:
the shared store stays put, so re-installing later restores every app and all data.

```bash
node uninstall.mjs           # unregister from all detected hosts — keeps your data
node uninstall.mjs --purge   # also delete the shared store (apps + data), irreversible
node uninstall.mjs --check   # read-only: show what's registered and what would change
```

## Requirements

- **Node 22 or newer**, on macOS, Windows or Linux.
- **`git`** — only on the installer path. The `npx` path above needs neither `git` nor a checkout.
  The installer checks for both and stops with a message rather than half-installing if either is
  missing.
- **A host that renders `ui://`** if you want widgets rather than text. Terminal hosts (Claude
  Code, codex CLI) drive the same data by design and show it in the browser viewer instead. The
  per-host detail is in [Host support](#host-support).
- **After installing or updating, fully quit and reopen the host** (Cmd-Q, not just closing the
  window) — it keeps its old server process on the old data until fully quit.

## Configuration

Every setting is an environment variable, set in the `env` block of your host's MCP server entry:

```json
{
  "mcpServers": {
    "open-mcp-apps": {
      "command": "npx",
      "args": ["-y", "@2nd1st/open-mcp-apps"],
      "env": {
        "OMA_VIEWER": "1",
        "PORT": "8787",
        "OMA_DYNAMIC_TOOLS": "0"
      }
    }
  }
}
```

| Variable | Default | What it does |
|---|---|---|
| `OMA_VIEWER` | `1` | The browser viewer on loopback. `0` doesn't start it at all. |
| `PORT` | `8787` | Where the viewer listens. |
| `OMA_DYNAMIC_TOOLS` | `0` | `1` also publishes one `open_<name>` tool per saved app. Off by default because it costs prompt cache — and one approval prompt per app. |
| `OMA_DB` | per-user store | Path to the SQLite store. Set it to isolate a store. |

**Where your data lives.** The whole store is one SQLite file, `open-mcp-apps.db`, in
`~/Library/Application Support/open-mcp-apps/` (macOS), `%APPDATA%\open-mcp-apps\` (Windows), or
`$XDG_DATA_HOME` else `~/.local/share/open-mcp-apps/` (Linux). It is outside any clone, which is
why every host shares the same apps and data.

**First-run permissions.** The first few tool calls each show an approval dialog — pick
**"Always allow"**. The tool set is small and stable on purpose: read-only tools generally
skip approval, and by default the single `open_app` tool covers opening *every* app
(including ones the AI creates later) behind that one grant, so nothing new asks again.
Two hosts are the exception: the installer registers **Claude Desktop and Claude Code** with
`OMA_DYNAMIC_TOOLS=1`, which gives every app its own `open_<name>` tool — the price is one
approval prompt per app. That is a deliberate, temporary workaround for a chat-surface bridge
regression on those hosts (it is marked TEMPORARY in `install.mjs` and written up in
[`KNOWN-ISSUES.md`](KNOWN-ISSUES.md)); it comes off when the host is fixed.
You can also batch approvals in **Settings → Connectors → open-mcp-apps → Tool permissions**.

## Usage

**Start in your host.** Restart it after installing. New here? Tell the AI something like **"I just
installed open-mcp-apps — show me how to use it with a couple of examples, and suggest a few apps that
fit how I work."** It reads what it can build, draws on what it knows about you (your memory and past
chats — or it asks a couple of questions), and sets up a first app or two tailored to you. This step
is separate from install and lives in the host. Or just ask directly:

- *"make me a board for what I'm juggling right now"* → the AI writes it, seeds it, and opens it (persistent)
- *"make me a habit tracker"* → watch it read the guide, write the app, save it, open it
- close the app, reopen, ask again → everything is still there

### The loop

```
"make me a kanban"
      │
      ▼
list_apps ── exists? ──► open_kanban          (reuse, instant)
      │ no
      ▼
get_app_guide ──► AI writes HTML ──► save_app
      │
      ▼
open_kanban  →  rendered inline, themed, persistent — reusable in every future chat
```

Apps accumulate. Each one is single-purpose and independent — a board, a tracker, a
splitter — minted for the task in front of you and kept for the next time you need it.

### What it looks like

Apps render inline, in the chat you were already having. Ask for one and the AI writes it:

![Codex — asking for a reading tracker; the AI writes it and it renders inline, already holding the three books](.github/screenshots/host-codex.webp)

Come back in another chat — or another host — and it's still there, with your data in it:

![Claude — a new chat opens the same reading list, now eight books long](.github/screenshots/host-claude.webp)

The built-in App Store — rebuilt in 0.5.0 as a real storefront — ships 22 ready-made apps, with
working previews and one-click install:

![The App Store — live previews of ready-made apps](.github/screenshots/app-store.webp)

| | |
|---|---|
| ![Companion — an AI character with shared memory](.github/screenshots/companion.webp) | ![Family Week — dinners, chores rotation, shopping and weekend plans](.github/screenshots/family-week.webp) |
| ![Study Cards — spaced repetition with review heatmap and deck shelf](.github/screenshots/study-cards.webp) | ![Knowledge Cards — a visual library of saved answers](.github/screenshots/knowledge-cards.webp) |

Every app above is a single HTML file bound to plain data collections — written with the same
`window.oma` API and authoring guide your AI will use for the apps it builds you.

Multiple widgets in one conversation work fine (habit-streaks + meal-planner side by side).

### The browser viewer, and the port it binds

Every install runs a small local web server on **<http://127.0.0.1:8787>**. It is how you *see*
your apps outside a chat window — one page per app, the same data your AI is reading — and in a
terminal host it is the only way to see them at all, so the AI hands you the link when it builds
or opens something.

It starts on its own; `OMA_VIEWER` and `PORT` above change that. If the port is already taken by
another open-mcp-apps process, that one is already serving the same data and this one just shares
its address; if it is taken by something else, you get no viewer and no links rather than a link
into a stranger's server.

**There is no password on it, and that is deliberate.** The listener is hard-wired to `127.0.0.1`,
so there is no setting that makes it answer from another machine. Any program on your computer that
could reach the port can already open the SQLite file directly — a password would be a lock beside
an open wall. The one way this reaches the internet is a tunnel you start yourself, which is its own
deliberate decision; **while a tunnel is up, treat its URL as a secret**, because it is currently the
only thing standing between the internet and your data.

## Host support

Live-tested 2026-07-22; ChatGPT web row updated 2026-07-28.

| Host | Renders widgets | Human clicks widget | AI operates data | Same store |
|---|---|---|---|---|
| **Claude Desktop** (local stdio) | ✅ | ✅ full loop incl. `sendMessage` reply | ✅ | ✅ |
| **Browser viewer** (`/view/<name>`) | ✅ | ✅ (no chat attached — `sendMessage` degrades to a notice) | via CLI AI | ✅ |
| **Codex desktop** (ChatGPT app, `enable_mcp_apps` flag) — tested against a **local** engine; remote not established | ✅ experimental | ◐ updates/toggles from widget clicks work; adds still blocked host-side ([openai/codex#28912](https://github.com/openai/codex/issues/28912), see KNOWN-ISSUES) | ✅ | ✅ |
| **Claude Code** (CLI, `claude mcp`) | — (text fallback by design) | — | ✅ | ✅ |
| **codex CLI / IDE** | — (text fallback by design) | — | ✅ | ✅ |
| **ChatGPT web** (Work mode) | ✅ live-tested 2026-07-28 (remote HTTPS) — renders at full height, no clamping; a widget loses its data after a page refresh (mitigation shipped, awaiting live re-test here — see KNOWN-ISSUES) | ✅ a widget button added a row and it stuck | ✅ | ✅ |

Everything rides the MCP Apps bridge, so host fixes upstream (e.g. #28912) benefit this
project with zero changes.

**On Codex specifically:** plugins are registered on the web side, so a locally-installed engine
is reached as an **MCP server**, not as a plugin — which is the right path for a self-hosted
install anyway. Widget rendering in the ChatGPT desktop app also appears to depend on how you are
signed in (we have seen it work under an account sign-in; not yet established under an API key).

## Writing an app yourself

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

## Security model

Trust is tiered by where an app came from. Locally-authored and system apps run in
**direct mode**. The engine also ships a **runner** — a sandboxed `srcdoc` iframe with a
CSP-first document and a minimal read-scoped bridge — as the mandatory execution mode for any
app that isn't locally trusted, plus reserved `security:*` / `policy:*` config keys that
generic data writes can't touch and an out-of-band privileged writer.

**Honest status:** everything in the OSS version — your apps, AI-built apps, and the built-in
App Store apps (all first-party) — runs locally in direct mode with full trust; there is nothing
third-party to sandbox yet. The runner is *built and tested but dormant*: it is the ready seam
for shared/published apps later, where review + sandboxing arrive together. See
[`SECURITY.md`](SECURITY.md) for the full threat model and trust tiers.

## Design positions (why it's built this way)

- **UI and data persist separately, both versioned.** Apps are views; collections are
  truth; the ledger is history. Swap either without losing the other.
- **The AI talks domain commands, never SQL, never raw state.** That's what makes human+AI
  concurrent editing safe (idempotency + optimistic concurrency at the command layer).
- **Extension-first.** Everything rides the MCP Apps bridge — no host-private APIs.
  One codebase should serve every host that renders `ui://`.
- **Single-purpose, not composite.** Each app owns one scenario and its own collection; the
  engine mints a new one rather than cramming features into an old one. System apps (settings,
  dashboard) are the deliberate exception — engine-owned, privileged, allowed to see across
  collections.

## Troubleshooting

| Symptom | What it is |
|---|---|
| Updated, but the host still shows the old behaviour | The host keeps its old server process on the old data until **fully quit** (Cmd-Q, not just closing the window). |
| Approval dialogs came back after a Claude Desktop auto-update | A Desktop auto-update occasionally resets these decisions (upstream [#56954](https://github.com/anthropics/claude-code/issues/56954)) — just re-allow. |
| One approval prompt per app | `OMA_DYNAMIC_TOOLS=1`, which the installer sets for Claude Desktop and Claude Code. See [Configuration](#configuration). |
| No viewer link, or the viewer is somebody else's | The port is taken by a non-open-mcp-apps process. Set `PORT` to something free. |
| A widget loses its data after a page refresh (ChatGPT web) | Known, mitigation shipped, live re-test pending — [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md). |
| Widget clicks can update but not add (Codex desktop) | Blocked host-side, [openai/codex#28912](https://github.com/openai/codex/issues/28912). |
| You want to start completely clean | Fully quit your host(s), delete `open-mcp-apps.db` (plus its `-wal`/`-shm` siblings) from the store directory under [Configuration](#configuration). All apps and data gone, irreversibly, while staying installed. |
| `pnpm install` exits 1 with `ERR_PNPM_IGNORED_BUILDS` | pnpm 11 refuses third-party build scripts until you decide about them, and calls that an error. Nothing here needs building — `better-sqlite3` loads a prebuilt binary it ships, and esbuild's binary comes from its platform package — so the tree it leaves behind is complete and working. Answer `pnpm approve-builds` however you like, or use npm. We do not declare those scripts as allowed, because that would make pnpm compile `better-sqlite3` on machines with no toolchain (a container, most CI) and fail there for nothing. |

## Development

| | |
|---|---|
| `src/server.mjs` | stdio MCP server; single `open_app` path (per-app `open_<name>` tools off unless `OMA_DYNAMIC_TOOLS=1`) |
| `src/http.mjs` | `/mcp` (stateless Streamable HTTP) + `/view/<name>` browser viewer, bound to `127.0.0.1` |
| `src/store.mjs` | SQLite: items + app registry + `change_event` ledger (idempotent, OCC) |
| `src/shell-runtime.js` | browser runtime injected into every app (`window.oma`) |
| `src/shell.mjs` | wraps stored HTML with runtime + design-token fallbacks at serve time |
| `src/guide.mjs` | the authoring contract the AI reads before generating an app |
| `install-app.mjs` | install an app you wrote yourself, from a file — the one door into the registry that doesn't go through the AI |
| `components/` | 3 system apps installed on seed (settings, dashboard, app-store) + 22 App Store apps — not auto-installed; browse the app-store app for live previews with sample data and one-click install |

```bash
npm test                     # every suite below, plus the static invariants and budget checks
node test/server-smoke.mjs   # 427 assertions over real stdio — incl. runtime app creation
node test/http-smoke.mjs     #  79 assertions over the HTTP transport (incl. SSE /events, viewer)
node test/provenance.mjs     #  39 assertions that an app's author — its trust tier — is not overwritable
node test/seed-smoke.mjs     #  22 assertions on the seed / design-kit pipeline
node test/files-smoke.mjs    #  41 assertions on the per-app file store (chunked uploads, GC races)
```

Contributions need nothing signed — MIT in, MIT out ([`CONTRIBUTING.md`](CONTRIBUTING.md)).

## Status and roadmap

Early v0 — proven end-to-end on Claude Desktop; cross-vendor render + shared store proven
on Codex desktop and the browser viewer.

**What 0.5.0 changed** (breaking, and the largest change so far —
[`CHANGELOG.md`](CHANGELOG.md) has the full account):

- **An app's declaration is a first-class object.** `save_app` takes `ui` and `manifest` as two
  slots instead of a manifest block buried in the document, and every revision snapshots both, so
  restoring brings back the pair.
- **An app can expose a function** — a data→data closure the AI calls with `call_function`, run by
  the engine against that app's own collections. The seat is opt-in at `createEngine` and absent by
  default, so a hosted deployment cannot inherit it.
- **Deleting a row is confirmed by the engine**, inside the store transaction every path passes
  through. App authors no longer write confirmation UI; the apps that carried their own
  arm-then-delete had it removed.
- **`promote_app`** turns a one-off `visual` into a kept app in one atomic step, and **`edit_app`
  takes a hash-checked `{offset, length}` range**, so a model that has read a window can edit it
  without sending an anchor back up.
- **Settings and the App Store were rebuilt** — rail navigation, in-place detail pages, and the
  storefront pictured above.
- Underneath: **SDK v1 → v2**, `2026-07-28` in the supported protocol versions, and a tool surface
  audited down to **33 tools**. Renamed and removed tools mean hosts will ask you to approve the
  tools once more after upgrading.

Where it stands:

- [x] engine: registry + shell + generic data commands + ledger
- [x] system apps installed (settings, dashboard, app-store); 22 App Store apps with live previews, one-click install
- [x] AI app creation loop (guide → save → open)
- [x] in-context onboarding (ask how to use it → the AI reads your history/memory and builds a tailored starter set)
- [x] security foundation: trust tiers + sandboxed runner + reserved config keys
- [x] multi-host discovery installer (Claude Desktop · Claude Code · Codex) + shared per-user store
- [x] `npx` one-command install (`@2nd1st/open-mcp-apps` on npm)
- [ ] remote (Streamable HTTP) as a *supported* shape → claude.ai / ChatGPT / mobile — the
      transport exists (`src/http.mjs`) and has been live-tested over HTTPS; what's missing is the
      hosted story, since the engine binds `127.0.0.1` by design
- [ ] one-click install with no shell
- [ ] app export/import → sharing → community App Store (review + runner sandbox activate here)

## License

**MIT**, for the whole repository — the engine and the apps in
[`components/`](components/) alike ([`LICENSE`](LICENSE) ·
[`LICENSING.md`](LICENSING.md)). Use it, fork it, modify it, embed it, run a
modified version as a hosted service; keep the copyright notice with substantial
portions you redistribute. That is the whole obligation. Up to v0.5.2 the engine
was AGPL-3.0-only under a directory split — see [`LICENSING.md`](LICENSING.md)
for what changed and why.

The names **open-mcp-apps**, **openmcp.app**, **SecondFirst**, and **2nd1st**,
and their logos, are **not** granted by the license — see
[`TRADEMARKS.md`](TRADEMARKS.md). Fork the code freely; give your fork its own name.

Copyright © 2026 2nd1st.

© 2026 [2nd1st](https://github.com/2nd1st)
