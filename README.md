# open-mcp-apps

[![CI](https://github.com/2nd1st/open-mcp-apps/actions/workflows/ci.yml/badge.svg)](https://github.com/2nd1st/open-mcp-apps/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%402nd1st%2Fopen-mcp-apps?logo=npm&label=npm)](https://www.npmjs.com/package/@2nd1st/open-mcp-apps)
[![license](https://img.shields.io/npm/l/%402nd1st%2Fopen-mcp-apps)](LICENSE)
[![node](https://img.shields.io/node/v/%402nd1st%2Fopen-mcp-apps)](package.json)
[![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dopen-mcp-apps%26version%3Dlatest&query=%24.servers%5B0%5D.server.version&label=MCP%20Registry&color=blue&prefix=v)](https://registry.modelcontextprotocol.io/v0/servers?search=open-mcp-apps&version=latest)

**English** | [简体中文](i18n/README.zh-CN.md)

> Give your AI a persistent, reusable UI. It builds the app once — you keep it forever.

**open-mcp-apps** is an open engine built on [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)
(`ui://`, `io.modelcontextprotocol/ui`) — an extension to the core Model Context Protocol
specification, and [the first official one](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/),
live since 26 January 2026. It gives any MCP-Apps-capable host (Claude Desktop, claude.ai, Codex,
ChatGPT, …) three things the extension itself doesn't provide:

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

**Which of those hosts *this* engine reaches.** It runs on your machine and binds `127.0.0.1`, so it
serves the hosts on that same machine: Claude Desktop, Claude Code, Codex, plus its own browser
viewer. A browser host cannot reach a loopback server on your laptop, so **claude.ai and ChatGPT web
need a remote deployment** — today that means the hosted [openmcp.app](https://openmcp.app), which
runs this same engine for you. Running that remote shape *yourself* is on the roadmap and not done.

| | |
|---|---|
| **Version** | 0.5.9 ([`CHANGELOG.md`](CHANGELOG.md)) |
| **License** | MIT, whole repository ([`LICENSE`](LICENSE) · [`LICENSING.md`](LICENSING.md)) |
| **npm** | `@2nd1st/open-mcp-apps` — **scoped**; the unscoped name is an unrelated package |
| **Command** | `npx -y @2nd1st/open-mcp-apps` — the line your host's MCP config runs; a stdio server, not something to run by hand (typed into a terminal it just waits, and says so) |
| **Requires** | Node 22 or newer. `git` too, on the installer path |
| **Surface** | 33 tools · a built-in App Store · 3 system apps seeded |
| **Platforms** | macOS · Windows · Linux |
| **Hosts** | Claude Desktop · Claude Code · Codex · ChatGPT web — see [Host support](#host-support) |
| **Hosted** | [openmcp.app](https://openmcp.app) — the remote shape, and the way to reach browser hosts (claude.ai, ChatGPT) |

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

**Where it puts the clone**, before you pipe anything into a shell: `~/open-mcp-apps`. Set `OMA_DIR`
to put it somewhere else — `curl -fsSL <url> | OMA_DIR=~/src/oma sh`. Re-running the one-liner
updates that same clone in place instead of making a second one. Your apps and data are *not* in it
(they live in the per-user store under [Configuration](#configuration)), so the folder is safe to
move or delete — and `node uninstall.mjs` does not delete it for you.

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
the shared store stays put, so re-installing later restores every app and all data. It also leaves
the installer's clone (`~/open-mcp-apps`, or wherever `OMA_DIR` pointed) on disk — nothing here ever
deletes that folder, so remove it yourself when you want the checkout gone.

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
- **A host that renders `ui://`** if you want widgets *in the conversation*. Terminal hosts (Claude
  Code in a terminal, codex CLI) drive the same data by design and put the UI on a browser screen
  beside the terminal instead — one that can follow along, showing whatever the AI just opened. The
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
skip approval, and the single `open_app` tool covers opening *every* app (including ones the AI
creates later) behind that one grant, so nothing new asks again — on every host the installer
registers, with no exceptions any more. From 2026-07-28 to 2026-08-16 there were two: **Claude
Desktop and Claude Code** were registered with `OMA_DYNAMIC_TOOLS=1`, which routed around a
chat-surface bridge regression by giving every app its own `open_<name>` tool, at one approval
prompt per app. Re-measured on Desktop 1.30096.5, that symptom is gone, so the installer no longer
sets the flag for anybody — [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md) carries both readings.
**If you installed during that window, your entry still has the flag:** `node install.mjs --check`
reports it as `stale`, and re-running the installer removes that one key while leaving every other
env value you have set exactly where it is.
You can also batch approvals in **Settings → Connectors → open-mcp-apps → Tool permissions**.

## Usage

**Start in your host.** Restart it after installing. New here? The engine ships one MCP prompt,
`get_started`. A host that surfaces prompts lists it as **Get started with open-mcp-apps**; hosts
that render prompts as slash commands spell it `/mcp__open-mcp-apps__get_started`. Picking it hands
the AI the whole opening move. Not every host surfaces prompts — where yours doesn't, nothing is
lost, because the prompt is just a sentence you can say yourself: **"I just installed open-mcp-apps
— show me how to use it with a couple of examples, and suggest a few apps that fit how I work."**
Either way it looks at what you already have and what the App Store already offers, draws on what it
knows about you (your memory and past chats — or it asks a couple of questions), and sets up a first
app tailored to you. This step is separate from install and lives in the host. Or just ask directly:

- *"make me a board for what I'm juggling right now"* → the AI writes it, seeds it, and opens it (persistent)
- *"make me a habit tracker"* → watch it read the guide, write the app, save it, open it
- close the app, reopen, ask again → everything is still there

### The loop

```
"make me a kanban"
      │
      ▼
list_apps ── exists? ──► open_app {app: "kanban"}     (reuse, instant)
      │ no
      ▼
get_app_guide ──► AI writes HTML ──► save_app
      │
      ▼
open_app {app: "kanban"}  →  rendered inline, themed, persistent — reusable in every future chat
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

Live-tested 2026-07-22; ChatGPT web row updated 2026-07-28. **Both readings predate 0.5.0** — the
largest change so far, and later than either date. Apart from the cells that carry their own
2026-08-16 date, nothing in this table has been re-tested on 0.5.0 or newer; a date says when that
row was true, not that it was checked again since.

| Host | Renders widgets | Human clicks widget | AI operates data | Same store |
|---|---|---|---|---|
| **Claude Desktop** (local stdio) | ✅ — re-checked 2026-08-16 on 1.30096.5: the universal `open_app` renders in chat without the `OMA_DYNAMIC_TOOLS` workaround that shipped for 1.24012.9 (see KNOWN-ISSUES) | ✅ full loop incl. `sendMessage` reply | ✅ | ✅ |
| **Browser viewer** (`/view/<name>`) | ✅ | ✅ (no chat attached — `sendMessage` degrades to a notice) | via CLI AI | ✅ |
| **Codex desktop** (ChatGPT app, `enable_mcp_apps` flag) — tested against a **local** engine; remote not established | ✅ experimental | ◐ updates/toggles from widget clicks work; adds were blocked host-side. The umbrella request [openai/codex#28912](https://github.com/openai/codex/issues/28912) (an `enhancement`: "make MCP apps work end-to-end in the Codex GUI") closed as completed on 2026-08-05 — but [#30092](https://github.com/openai/codex/issues/30092), the `bug` matching this exact failure and reproduced there by a third party, was still open on 2026-08-16. Not re-tested here either way, so the cell stays ◐. See KNOWN-ISSUES | ✅ | ✅ |
| **Claude Code** — in a terminal (`claude mcp`) | — in the chat, by design (text fallback) — but see **[a screen beside the terminal](#a-screen-beside-the-terminal)** | — in the chat | ✅ | ✅ |
| **Claude Code** — the Code surface inside the Claude app | ✅ live-tested 2026-08-16: an app opened with the universal `open_app` renders inline, the same shape the chat surface gives | not measured on this surface | ✅ | ✅ |
| **codex CLI / IDE** | — in the chat, by design (text fallback) — but see **[a screen beside the terminal](#a-screen-beside-the-terminal)** | — in the chat | ✅ | ✅ |
| **ChatGPT web** (Work mode) | ✅ live-tested 2026-07-28 (remote HTTPS) — renders at full height, no clamping; a widget loses its data after a page refresh (mitigation shipped, awaiting live re-test here — see KNOWN-ISSUES) | ✅ a widget button added a row and it stuck | ✅ | ✅ |

Everything rides the MCP Apps bridge, so host fixes upstream (e.g. #28912) benefit this
project with zero changes.

**On Claude Code specifically:** it is one product with two surfaces, and only one of them can
draw — which is why it takes two rows. In a terminal there is no inline widget surface at all: that
is architecture rather than a gap, and it is exactly what [a screen beside the
terminal](#a-screen-beside-the-terminal) is for. The Code surface inside the Claude app has a UI and
renders inline; the 2026-08-16 reading there came through the universal `open_app`.

**On Codex specifically:** plugins are registered on the web side, so a locally-installed engine
is reached as an **MCP server**, not as a plugin — which is the right path for a self-hosted
install anyway. Widget rendering in the ChatGPT desktop app also appears to depend on how you are
signed in (we have seen it work under an account sign-in; not yet established under an API key).

### A screen beside the terminal

Those two `—` cells say the **chat** shows text. They do not say there is no UI. Since 0.5.1 the
engine remembers which app was opened last and pushes that pointer to the viewer on the `/events`
frame, and an app can place a region — `oma.embed("@live", {into})` — that mounts whatever the AI
opened last and swaps itself when the AI opens another. The App Store ships one: install **`live`**,
open `http://127.0.0.1:8787/view/live` in a window you then leave alone, and the terminal keeps the
conversation while that screen shows the app. The AI opens or writes from the CLI, the screen
follows, and you can click, edit and type into it there. Headless CLI use is what it was built for.

**The cheapest form of "that screen" is a browser pane in the same tiled workspace** — one column
over from the agent, in the window you are already working in. Same machine, no tunnel, no second
device; most modern terminal setups can put a browser next to a shell, and that is all this needs.
A second monitor is the same idea with more desk, and a screen on another device is the same idea
again with the caveat below.

The costs are real and worth stating plainly. There is still **no widget in the transcript**.
`sendMessage` degrades to a notice on a standalone page, exactly as in the **Browser viewer** row —
clicks change data, they do not talk back to the chat. The viewer has to be running (`OMA_VIEWER`,
on by default) with a browser pointed at it; this is not zero-config. And the listener is bound to
`127.0.0.1`, so "a spare tablet on the wall" means *this machine's* screen unless you put up the
tunnel described above and accept what that section says about it. Inside a chat host the same
region deliberately draws a placeholder instead of following anything.

*Described from the code as built, not measured on a host — the live-test dates above cover the
table, not this section.*

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
| Approval dialogs came back after a Claude Desktop auto-update | A Desktop auto-update occasionally resets these decisions (upstream [#56954](https://github.com/anthropics/claude-code/issues/56954), closed 2026-06-23 as *not planned*) — no fix is coming from that issue, so just re-allow. |
| One approval prompt per app | `OMA_DYNAMIC_TOOLS=1` is in your host entry — either you put it there, or you installed between 2026-07-28 and 2026-08-16, when the installer set it for Claude Desktop and Claude Code as a workaround. `node install.mjs --check` calls such an entry `stale`; re-running the installer removes that one key and keeps the rest of your env. See [Configuration](#configuration). |
| No viewer link, or the viewer is somebody else's | The port is taken by a non-open-mcp-apps process. Set `PORT` to something free. |
| A widget loses its data after a page refresh (ChatGPT web) | Known, mitigation shipped, live re-test pending — [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md). |
| Widget clicks can update but not add (Codex desktop) | Blocked host-side. The umbrella request [openai/codex#28912](https://github.com/openai/codex/issues/28912) closed as completed on 2026-08-05, but that one is an `enhancement`, not this defect: the matching `bug`, [#30092](https://github.com/openai/codex/issues/30092), was still open on 2026-08-16. Update Codex and try, but expect it to still bite. |
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
node test/server-smoke.mjs   # 429 assertions over real stdio — incl. runtime app creation
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
- [ ] **self-hosted** remote (Streamable HTTP) as a *supported* shape → claude.ai / ChatGPT / mobile
      off an engine *you* run — the transport exists (`src/http.mjs`) and has been live-tested over
      HTTPS; what's missing is the hosted story, since the engine binds `127.0.0.1` by design.
      Those browser hosts already work against the hosted [openmcp.app](https://openmcp.app); this
      box is about doing it yourself
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
