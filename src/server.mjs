#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// server.mjs — stdio entry point (Claude Desktop / any local MCP host), and the target of the
// package's `bin`: from a clone, `npm install -g .` (or `npm link`) puts an `open-mcp-apps`
// command on PATH, so a host entry can name a command instead of an absolute path into a checkout.
//
// ⚠️ The npx form is `npx -y @2nd1st/open-mcp-apps` — SCOPED, and only scoped. Bare
// `npx open-mcp-apps` does NOT run this project: that unscoped name on the npm registry belongs to
// somebody else (an unrelated "Node.js SDK skeleton"), so the bare command downloads and executes
// a stranger's package. The scoped package has been ours since 0.5.4 (2026-08-15) and is the
// README's first install path; the bare name is still not ours and never will be. README carries
// that disclosure where users read it ("A note on npm"), and test/invariants.mjs pins the coupling:
// as long as `bin` names a command we do not own on npm, that note has to exist. This comment used
// to say "nothing in this repository may advertise the npx form" — true before the scoped name
// existed, and still here after the README had started advertising it (repriced 2026-08-16);
// the rule now is scoped-only, stated here so the source and the README say one thing.
// The engine itself lives in engine.mjs; http.mjs serves the same store over HTTP.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { openStore } from "./store.mjs";
import { createEngine } from "./engine.mjs";
import { startViewer } from "./http.mjs";

const store = openStore(); // fixed per-user data dir (see store.mjs) — OMA_DB overrides for tests/isolation

// The browser viewer is ON by default; OMA_VIEWER=0 turns it off. That switch is documented in
// README rather than left to be discovered: a port this process binds without being asked is a
// thing people notice and have opinions about (port clashes, corporate policy).
//
// Why default-on carries no token in front of it: the listener is hard-wired to 127.0.0.1, so
// there is no configuration in which it answers off-box — "accidental exposure" is not a risk being
// accepted here, it is structurally absent. And any local process that could reach the port can
// read the SQLite file directly, so a token would be a lock beside an open wall. The one way out of
// the machine is a tunnel the user deliberately starts, which is its own deliberate act and not
// something default-on creates. The reasoning is written out in
// docs/archive/2026-08-14-v05-cleanup/viewer-devmode-design.md §7 (archived 2026-08-14: a spec for a
// dev mode that was never built — §7's threat reading is why this paragraph exists, not a plan).
//
// Awaited because the viewer's URL is what makes the app links in tool results real (viewUrl in
// tools/apps.mjs), and the engine has to be built knowing it. startViewer never throws and never
// writes to stdout: this process speaks MCP over stdout, so a browser convenience must not be able
// to corrupt the protocol or take the server down with it.
const viewer = process.env.OMA_VIEWER === "0" ? null : await startViewer({ store });
// stderr, never stdout — see above. Said out loud on SUCCESS too, not only on failure: run from a
// terminal this line is the whole point, and a host that shows its server's stderr gives the user
// the URL without anyone having to know the default port.
if (viewer) console.error(`[oma] browser viewer: ${viewer.url}${viewer.adopted ? " (shared with another open-mcp-apps process)" : ""}`);

// One more line, ONLY when a person typed this command into a terminal. A stdio MCP server has no
// screen of its own: it prints nothing and waits for a host to speak on stdin, and from a terminal
// that reads as a hang. Measured 2026-08-16 in a clean environment: `npx -y @2nd1st/open-mcp-apps`
// pasted from README → ~60 s of install, stdout 0 bytes, stderr the viewer line above, cursor
// stopped — and none of the three guesses a person makes next (Ctrl-C / open the URL and see an
// empty "Apps · 0" / assume it installed and go looking in Claude Desktop) reaches a widget. The
// engine was healthy; the failure was that nothing SAID what this process is. The test is
// `process.stdin.isTTY`: a real terminal hands the child a tty.ReadStream (isTTY === true), a host
// spawning us over stdio pipes hands it a Socket (isTTY === undefined), `< /dev/null` an
// fs.ReadStream (undefined) — so a host never sees this line, and no host transcript changes.
// stderr, one line, no exit: the protocol still owns stdout, and the process still does its job
// if a host is what actually started it.
if (process.stdin.isTTY) console.error("[oma] this is a stdio MCP server: it waits for an MCP host to connect on stdin and prints nothing more. Run by hand it will just sit here — put this command in your host's MCP server config instead (README → Install) and let the host start it.");

// serveStdio owns the era decision (SEP-2575): a 2025-era `initialize` opening pins a legacy
// instance, a 2026-07-28 envelope opening (or a `server/discover` probe) gets a modern one — the
// SAME factory backs both, so the two wires can never drift apart. The factory may run more than
// once (a discarded probe instance is normal); createEngine is cheap and side-effect-free per
// call — the store and its file channel are shared, memoized state.
// `functions: …` — this entrypoint IS the local product, so the function pillar is on by
// default here (and in http.mjs); OMA_FUNCTIONS=0 is the kill-switch. createEngine itself
// defaults OFF so no embedding/hosted consumer inherits same-process execution unasked.
serveStdio(() => createEngine(store, { viewBase: viewer?.url, functions: process.env.OMA_FUNCTIONS !== "0" }), {
  onerror: (e) => console.error(`[oma] stdio: ${e && e.message || e}`),
});
