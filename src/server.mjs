#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// server.mjs — stdio entry point (Claude Desktop / any local MCP host), and the target of the
// package's `bin`: from a clone, `npm install -g .` (or `npm link`) puts an `open-mcp-apps`
// command on PATH, so a host entry can name a command instead of an absolute path into a checkout.
//
// ⚠️ That is the WHOLE of what `bin` buys here. `npx open-mcp-apps` does NOT run this project —
// the name on the npm registry belongs to somebody else (an unrelated "Node.js SDK skeleton"), so
// that command downloads and executes a stranger's package. README says so where users read it;
// this note exists so the two never drift apart again. Until the name is ours, nothing in this
// repository may advertise the npx form — test/invariants.mjs holds us to it.
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
