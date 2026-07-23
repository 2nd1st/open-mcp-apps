---
name: open-mcp-apps-install
description: >
  Install or update open-mcp-apps (a persistent MCP-app engine) on this machine, into any of Claude
  Desktop, Claude Code, and Codex. Follow this when a user pastes "Read <this url> and follow it", or
  asks to install / update open-mcp-apps. This is INSTALL only — onboarding (getting to know the user
  and building their first apps) is separate and happens inside their chat host after restart.
---

# Install open-mcp-apps

> You are a shell-capable coding agent (Claude Code, Codex CLI, or similar), following this file for
> a user who pasted one line. Your job is to get the **open-mcp-apps** MCP server installed — or
> updated — and registered with their host(s), then point them at onboarding (which happens *in the
> host*, not here). This file is **safe to re-run**: every stage detects what's already there and
> changes only what's stale. Work top to bottom, run each stage's self-check, report in plain language.

**The only host-specific value** (swap once to re-point this file):

```
REPO = https://github.com/2nd1st/open-mcp-apps
```

Everything else named here (`install.mjs`, `src/…`) lives **inside the repo**, so it stays correct
no matter which URL served you this file.

**OBJECTIVE:** `open-mcp-apps` is registered in the user's MCP host(s) — any of Claude Desktop, Claude
Code, and Codex. One clone, one server, one shared per-user store; only the per-host *registration* is
N-way.
**DONE WHEN:** Stage 3's self-check passes. Onboarding is the user's next step, in their host — you don't do it here.

Copy this checklist into your reply and tick as you go:

```
- [ ] 1 · Detect — cloned already? which hosts, which are stale?   (decides fresh vs update)
- [ ] 2 · Install / update — clone-or-pull, build, register (--yes, idempotent)
- [ ] 3 · Verify — registered, then FULLY QUIT + reopen the host   ← DONE WHEN
- [ ] 4 · Offer to remember this install         (ask first; optional)
- [ ] 5 · Hand off to onboarding                 (it happens in the host, not here)
```

---

## Stage 1 · Detect — *decides the whole run*  ·  read-only

Two questions, no writes:

1. **Already cloned?** Look for an existing `open-mcp-apps` clone (ask the user, or check likely
   spots like their home dir). Found one → you'll `git pull` it in place in Stage 2, not clone again.
2. **Which hosts, and are they current?** If the clone exists, run the read-only probe — it inspects
   every supported host's config and writes nothing:
   ```bash
   node install.mjs --check
   ```
   It prints one line per host — Claude Desktop · Claude Code · Codex — each `not found` · `fresh` ·
   `already current` · `stale` (registered but pointing at an old path/node). That tells you which
   hosts are present and which need work.

Say one sentence about what you found, then continue. This is the only branch; the rest is linear.

---

## Stage 2 · Install or update — *exact commands*

**Use `--yes`.** You're a shell agent, not a person at a keyboard — bare `node install.mjs` opens a
3-step interactive wizard meant for humans and will hang waiting for keypresses. `--yes` skips the
picker and installs into **every detected host** non-interactively.

**If not yet cloned:**
```bash
git clone REPO && cd open-mcp-apps
node install.mjs --yes
```
**If already cloned** (from Stage 1) — update in place, don't re-clone (that errors):
```bash
cd path/to/open-mcp-apps && git pull --ff-only
node install.mjs --yes
```

- To target a subset instead of all detected, use `--host claude,claude-code,codex` (any combination).
- Add `--fresh` to start a clean shared store instead of migrating an existing clone-local db.

`install.mjs` installs deps, builds the shell runtime, seeds the starter components, then **inspects
each host's config and adjusts only what's off** — it never clobbers the user's other MCP servers,
never blindly re-adds itself, and cleans up the pre-rename `open-mcp-app` entry if it lingers. It pins
the exact `node` it ran with (the native SQLite module needs a matched ABI — don't "fix" this to a
bare `node`). Data lives in a **fixed per-user store** (e.g. `~/Library/Application Support/open-mcp-apps/`
on macOS), *not* inside the clone — so the clone can be moved or re-cloned without losing anything, and
every host sees the same apps and data. It ends with a per-host `before → after` summary and a final
`result:` line — `installed` (newly added), `updated` (a stale/legacy entry corrected), or `unchanged`
(already matched, nothing written).

**Relay that summary to the user in your own words** — `unchanged` is the good, boring outcome. If the
installer exits with a config error, surface its message and **stop — do not hand-edit their config.**

---

## Stage 3 · Verify — *this is DONE WHEN*  ·  self-check

Confirm the outcome, not just that commands exited 0:

- Re-run `node install.mjs --check`. Every host you installed into must now print `already current`.
  If a second run would still change something, the write didn't take — surface it and stop.
- Tell the user to **FULLY QUIT and reopen their host(s)** — Cmd-Q, or right-click the Dock icon →
  Quit; **not** just closing the window. A GUI host keeps its old server process (bound to the old
  code and old data) alive until it is fully quit — that's the usual reason a freshly-installed or
  updated server looks wrong, or two hosts look out of sync. The installer prints how many server
  processes are live to underscore this. (Claude Code has no window to quit — it picks up the change
  on its next run.)
- After restart, `open-mcp-apps` appears in the tool list, and the first few tool calls show an
  approval dialog — tell them to pick **"Always allow"** (after that it's near zero-prompt: one
  `open_component` tool opens every component, including ones built later).

That's the install done.

---

## Stage 4 · Offer to remember this  ·  OFFER (ask first, optional)

You have your own memory; the user's host has its own. **Offer in one line, proceed only on a yes:**

> "Want me to note in my memory that open-mcp-apps is installed here — so future sessions know it's
> available and reach for it when you want to track or manage something?"

On a yes, store **one compact fact**: *"open-mcp-apps installed at `<path>`, registered in `<hosts>` —
a persistent-UI engine over a shared per-user store; when the user wants to track / manage / organize
something over time, its tools are there; to get started they ask the AI in-host to show them how to
use it with a few tailored examples."* If you have no memory store, skip it — don't fabricate one,
don't write a local file. Never store preferences the user didn't volunteer.

---

## Stage 5 · Hand off to onboarding — *it's separate, and it's in the host*

Installing is not onboarding. **Onboarding — getting to know the user and building their first apps —
happens inside their chat host, not here** (this file is followed by a shell agent that can't render
widgets or reach the freshly-installed tools). Close by telling them, in your own words:

> "Installed. Fully quit and reopen <their host>, then ask me something like: 'I just installed
> open-mcp-apps — show me how to use it with a couple of examples, and suggest a few apps that fit how
> I work.' I'll draw on what I know about you and tailor it."

Don't try to build an app from here. You're done once they know that next step.

---

## If something's off (pre-answered)

- **No config file yet** → the installer creates it; expected on a clean machine.
- **`node` not found / Node < 18** → install Node 18+, re-run `node install.mjs --yes` (safe to re-run).
- **Config exists but isn't valid JSON/TOML** → the installer refuses to touch it and says why.
  Surface that; don't guess-edit it — their other MCP servers matter.
- **A build step fails** → the error is printed; fix it and re-run `node install.mjs --yes`.
- **Only some hosts registered** → re-run with `--host claude,claude-code,codex` (any subset) to add
  the ones you want; each host is idempotent.
- **Some other MCP host** → take the server path the installer prints and register it however that
  host adds a stdio MCP server (command = the printed `node`, arg = the printed `server.mjs`).
