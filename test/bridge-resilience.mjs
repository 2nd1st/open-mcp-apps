// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/bridge-resilience.mjs — a silently DROPPED bridge request must never wedge the runtime.
//
// Claude Desktop 1.24012.9 (and Claude Code — same MCP Apps bridge stack) drops widget→host
// calls sent in an early post-mount window: the request never settles — no reply, no SDK
// timeout ("oncalltool handler replaced" in the renderer log; requests on the replaced handler
// are lost). Live-test 2026-07-28 found v0.3's loader first paint 100% hung on that one call,
// and the runtime shares the failure mode wholesale: an unsettled await kills the poll chain,
// jams syncPrefs' busy latch, and holds walk()'s single-flight slot forever.
//
// These tests execute the ACTUAL shipped source — extracted from the runtime / the served
// loader document, with only the time constants scaled down — against a scripted bridge
// (resolve, reject, sink) and pin the envelope semantics.
//
// Run: node test/bridge-resilience.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wrapLoader } from "../src/shell.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rt = readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf-8");

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));
const sink = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("1. withDeadline — the runtime's bridge envelope (real source, deadline scaled to 40ms)");
{
  const m = rt.match(/const BRIDGE_DEADLINE_MS = [\d_]+;\s*\n(function withDeadline[\s\S]*?\n\})/);
  ok("withDeadline + BRIDGE_DEADLINE_MS exist in the runtime", !!m);
  const withDeadline = new Function("BRIDGE_DEADLINE_MS", m[1] + "; return withDeadline;")(40);

  let out = null;
  try { await withDeadline(sink(), "data_version"); } catch (e) { out = String(e.message); }
  ok("a SUNK promise rejects instead of hanging", out != null);
  ok("…and the rejection names the call and the drop", /data_version/.test(out) && /no reply/.test(out), out);

  ok("a resolution inside the deadline passes through", (await withDeadline(Promise.resolve(7), "x")) === 7);

  let err = null;
  try { await withDeadline(Promise.reject(new Error("denied")), "x"); } catch (e) { err = e; }
  ok("a real rejection passes through untouched", err && err.message === "denied");

  ok("the bridge call site is wrapped (SA /rpc keeps fetch's own failure modes)",
    /withDeadline\(app\.callServerTool\(/.test(rt));
}

console.log("\n2. loader first paint — fresh-call retry against the early-mount drop window");
{
  const doc = wrapLoader();
  const lm = doc.match(/(function fetchComponentHtml[\s\S]*?\n\})\s*\n\s*oma\.ready/);
  ok("fetchComponentHtml exists in the served loader document", !!lm);
  const scaled = lm[1].replace("[3000, 5000, 7000, 9000]", "[30, 50, 70, 90]");
  ok("…and the windows literal was found to scale (test rig integrity)", scaled !== lm[1]);
  const build = (callTool) => {
    const calls = { n: 0, shows: [] };
    const oma = { callTool: (...a) => { calls.n++; return callTool(calls.n, ...a); } };
    const show = (msg) => calls.shows.push(msg);
    const fn = new Function("oma", "show", scaled + "; return fetchComponentHtml;")(oma, show);
    return { fn, calls };
  };

  { // the observed failure: the first sends vanish, a later one lands
    const { fn, calls } = build((n) => (n <= 2 ? sink() : Promise.resolve({ structuredContent: { html: "<b>x</b>" } })));
    const r = await fn("bill-calendar");
    ok("two dropped attempts are abandoned, the third answer paints", r.structuredContent.html === "<b>x</b>");
    ok("…in exactly three sends", calls.n === 3, "sent " + calls.n);
    ok("…with visible retry progress, not a frozen placeholder", calls.shows.some((s) => /retry/.test(s)));
  }
  { // a real answer is terminal: retrying a denial can't help
    const { fn, calls } = build(() => Promise.reject(new Error("denied")));
    let err = null; try { await fn("x"); } catch (e) { err = e; }
    ok("a rejection inside the window is terminal", err && err.message === "denied");
    ok("…after a single send", calls.n === 1, "sent " + calls.n);
  }
  { // total drop: honest failure text instead of eternal "Loading component…"
    const { fn, calls } = build(() => sink());
    let err = null; try { await fn("x"); } catch (e) { err = e; }
    ok("all-dropped ends in an honest error", err && /did not answer/.test(err.message), err && err.message);
    ok("…after every window was tried", calls.n === 4, "sent " + calls.n);
  }
  await sleep(120); // let abandoned timers from the scaled windows drain before the summary
}

console.log("\n2b. the SHIPPED bundle carries the envelope (dist is what browsers run)");
{
  // Found the hard way: every widget loads dist/shell.js, not src/ — a fix that passes the
  // source-level tests above can still be absent from what the host serves. Strings survive
  // minification; the function names may not.
  const dist = readFileSync(join(ROOT, "dist", "shell.js"), "utf-8");
  ok("dist/shell.js contains the bridge deadline", dist.includes("no reply in"));
  ok("dist/shell.js contains the inert fixture answering", dist.includes('"fx-"') || dist.includes("'fx-'") || dist.includes("fx-"));
}

console.log("\n3. the recovery paths the deadline unlocks (source pins)");
{
  ok("pollTick guards its awaits — one rejected probe cannot kill the chain",
    /async function pollTick\(\)[\s\S]*?catch \{/.test(rt));
  ok("syncPrefs clears its busy latch in finally — a rejected read cannot jam prefs",
    /prefSyncBusy = false;\s*\n\s*if \(prefSyncQueued\)/.test(rt) && /finally \{/.test(rt.slice(rt.indexOf("async function syncPrefs"), rt.indexOf("function schedulePrefSync"))));
  ok("walk releases its single-flight slot in finally",
    /finally \{\s*\n\s*walking = null;/.test(rt));
  ok("addItem refuses an unbound collection loudly instead of sending collection:null",
    /addItem\(\{[\s\S]{0,600}?No collection bound yet/.test(rt));
}

console.log(fail ? `\nFAILURES: ${pass} passed, ${fail} failed` : `\nALL PASS: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
