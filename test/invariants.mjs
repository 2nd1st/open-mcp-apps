// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/invariants.mjs — two architectural rules that only hold if a machine enforces them.
//
// Both exist because the author of this codebase is usually an AI, and an AI will cheerfully
// re-add a tool inline or introduce an undocumented env flag while doing something else. A rule
// living in a doc gets obeyed for a week; a rule living here gets obeyed.
//
//  1. TOOL REGISTRATION IS CONFINED. src/engine.mjs is the one file three tracks all need to
//     edit — it is the project's only real serialization bottleneck. Once registrations are split
//     into src/tools/*.mjs, this check is what stops the bottleneck from quietly growing back.
//  2. EVERY ENV FLAG IS DECLARED. Work-in-progress lands on main behind an OMA_* flag, which
//     means flag debt is the price of trunk-based development. Construction flags therefore carry
//     an expiry, and this test fails when one is overdue. Undeclared and unused flags both fail
//     too: an undeclared flag is a hidden switch, a stale entry is a lie about what exists.
//
// Static scan only — no server, no db, runs in milliseconds.
// Run: node test/invariants.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Where server.registerTool( is allowed to appear. src/tools/ is listed ahead of the split so the
// refactor needs no edit here — and so the intended destination is documented in the rule itself.
const TOOL_REGISTRATION_ALLOWED = [
  "src/engine.mjs",     // today: everything. Roadmap: split into src/tools/*.mjs
  /^src\/tools\/[a-z-]+\.mjs$/,
];

// The complete set of environment switches the SHIPPED engine reads. Test-only variables belong
// nowhere near this table: the registry's claim is "these are the switches a deployment has",
// and listing test/eval-live.mjs's OMA_EVAL_* here would make that claim false. shippedSources()
// scans src/** plus the root entry points for exactly that reason.
//   product      — a real, permanent capability toggle. Needs a `why`.
//   construction — temporary, gates unfinished work on main. Needs `removeBy` (ISO date).
//   build        — provenance stamped in by the image build. Not a toggle; never branched on.
//   platform     — not ours; set by the OS or a host.
const FLAGS = {
  OMA_BUILD:          { kind: "build",    why: "commit SHA baked in by the image build; reported to the host in the MCP server info so a deployment can be told apart from a checkout" },
  OMA_BUILD_FILE:     { kind: "build",    why: "path to the same SHA, for images that resolve it at build time — discoverable via `docker inspect`, unlike a value injected inline in CMD" },
  OMA_DB:             { kind: "product",  why: "database location override (tests, multi-tenant hosts)" },
  OMA_HOST:           { kind: "product",  why: "host label when clientInfo.name is unavailable" },
  OMA_FILE_BACKEND:   { kind: "product",  why: "swappable file-plane backend" },
  OMA_DYNAMIC_TOOLS:  { kind: "product",  why: "opt-in per-component open_<name> tools; DEFAULT OFF because every save_component would invalidate the whole conversation's prompt cache" },
  OMA_QUERY:          { kind: "construction", removeBy: "2026-09-15",
                        why: "gates EXECUTION of data_query, never its registration — a tool that appears mid-life invalidates every cached tool list, so the seat ships from day one and the flag decides whether calling it works. Off until a live-model eval shows models reach for it instead of pulling rows; the fallback (read and count) is always available, which is what makes the flag safe to leave off" },
  // OMA_PROBE / OMA_PROBE_OUT retired 2026-07-27 with src/tools/probe.mjs, exactly as their entry
  // demanded: both readings landed in the host matrix (E1b — audience ignored by every measured
  // host; E6 — the ui-extension predicate held at n=4; §15c — the delivery cut measured on the
  // four-host matrix). The delivery-cut campaign docs hold the numbers.
  PORT:               { kind: "product",  why: "http transport port" },
  OMA_VIEW_BASE:      { kind: "product",  why: "public base URL of the browser viewer, for the app links handed to the model. Defaults to loopback, which is right locally and DEAD behind a tunnel or reverse proxy — the setup every hosted chat reaches this server through. The process cannot discover its own external address; the operator can" },
  APPDATA:            { kind: "platform", why: "Windows data dir" },
  XDG_DATA_HOME:      { kind: "platform", why: "XDG data dir" },
  XDG_CONFIG_HOME:    { kind: "platform", why: "XDG config dir" },
};

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

/** Shipped source only: src/**.mjs plus the root entry points. Tests and scripts are not shipped. */
function shippedSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs")) out.push(p);
    }
  };
  if (existsSync(join(ROOT, "src"))) walk(join(ROOT, "src"));
  for (const f of ["index.mjs", "build.mjs", "seed.mjs", "install.mjs", "uninstall.mjs"])
    if (existsSync(join(ROOT, f))) out.push(join(ROOT, f));
  return out.map((p) => [relative(ROOT, p).split("\\").join("/"), readFileSync(p, "utf-8")]);
}

const sources = shippedSources();
const allowed = (rel) => TOOL_REGISTRATION_ALLOWED.some((a) => (typeof a === "string" ? a === rel : a.test(rel)));

// All three registration calls, not just server.registerTool: open_component and the per-component
// open_<name> tools go through the MCP-Apps helpers, so matching only .registerTool( would let
// 1 of the 33 tools — and every ui:// resource — escape the rule.
const REGISTRATION_CALL = /(?:\.registerTool|registerAppTool|registerAppResource)\s*\(/;

console.log("1. tool registration is confined");
const registrars = sources.filter(([, src]) => REGISTRATION_CALL.test(src)).map(([rel]) => rel);
const strays = registrars.filter((rel) => !allowed(rel));
ok(`registrations live in ${registrars.length} allowed file(s): ${registrars.join(", ") || "(none)"}`,
  strays.length === 0,
  `tools registered outside the allowed set: ${strays.join(", ")}\n` +
  `      Put them in src/tools/<domain>.mjs — engine.mjs is the bottleneck three tracks share.`);

console.log("2. every env flag is declared");
const used = new Map(); // NAME -> [files]
for (const [rel, src] of sources)
  for (const m of src.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g))
    used.set(m[1], [...new Set([...(used.get(m[1]) ?? []), rel])]);

const undeclared = [...used.keys()].filter((n) => !FLAGS[n]);
ok(`${used.size} env var(s) read, all declared`, undeclared.length === 0,
  `undeclared: ${undeclared.map((n) => `${n} (${used.get(n).join(", ")})`).join("; ")}\n` +
  `      Add it to FLAGS with a kind and a why — a hidden switch is a switch nobody can review.`);

const stale = Object.keys(FLAGS).filter((n) => !used.has(n));
ok("no stale declarations", stale.length === 0,
  `declared but never read: ${stale.join(", ")} — delete the entry, or the registry stops being true.`);

const today = new Date().toISOString().slice(0, 10);
const construction = Object.entries(FLAGS).filter(([, f]) => f.kind === "construction");
const undated = construction.filter(([, f]) => !/^\d{4}-\d{2}-\d{2}$/.test(f.removeBy ?? ""));
ok(`${construction.length} construction flag(s), all dated`, undated.length === 0,
  `missing a valid removeBy (YYYY-MM-DD): ${undated.map(([n]) => n).join(", ")}`);

const overdue = construction.filter(([, f]) => f.removeBy && f.removeBy < today);
ok("no overdue construction flags", overdue.length === 0,
  `past removeBy: ${overdue.map(([n, f]) => `${n} (due ${f.removeBy})`).join(", ")}\n` +
  `      Either finish the work and delete the flag, or move the date deliberately — flag debt ` +
  `is the one cost trunk-based development actually charges.`);

const missingWhy = Object.entries(FLAGS).filter(([, f]) => !f.why);
ok("every flag says why it exists", missingWhy.length === 0,
  `no why: ${missingWhy.map(([n]) => n).join(", ")}`);

console.log(`\ninvariants: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
