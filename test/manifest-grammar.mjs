// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/manifest-grammar.mjs — the declaration reader is a security boundary, so its grammar is a
// golden file rather than a claim in a comment.
//
// The corpus below was built to attack an HTML-tokenizer implementation of this reader, against a
// real headless browser. Two fixtures found real holes that review had missed. The reader is now a
// BYTE grammar instead (see src/manifest-block.mjs for why: the browser stopped being a reader, so
// the obligation to match its tokenizer stopped existing), which makes most of those attacks
// meaningless by construction — a nested <template> hides nothing from a byte scan, and no tokenizer
// state exists to be confused.
//
// The corpus is kept anyway, and that is the point of it: these are the inputs someone once had to
// use a browser to reason about, and every one of them now has an answer a person can reach by
// reading three lines of code. If a future change reintroduces HTML semantics here, this file reds.
//
// Run: node test/manifest-grammar.mjs   ·   bless: UPDATE_GOLDEN=1 node test/manifest-grammar.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readDeclaration, MAX_DECLARATION_BYTES, DECLARATION_OPEN } from "../src/manifest-block.mjs";
import { FIXTURES } from "./rig/manifest-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = join(ROOT, "test", "golden", "manifest-grammar.json");
const BLESS = process.env.UPDATE_GOLDEN === "1";

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
const byName = new Map(golden.fixtures.map((f) => [f.name, f]));

console.log("1. every fixture decides exactly as recorded");
const actual = [];
for (const f of FIXTURES) {
  const r = readDeclaration(f.html);
  const got = { state: r.state, ...(r.error ? { error: r.error } : {}) };
  actual.push({ name: f.name, why: f.why, expect: got, ...(r.state === "present" ? { keys: Object.keys(r.value).sort() } : {}) });
  const want = byName.get(f.name);
  if (!want) { ok(`${f.name} — is in the golden`, false, "new fixture: re-bless with UPDATE_GOLDEN=1 and review the diff"); continue; }
  const same = want.expect.state === got.state && (want.expect.error || null) === (got.error || null) &&
    JSON.stringify(want.keys || null) === JSON.stringify(r.state === "present" ? Object.keys(r.value).sort() : null);
  ok(`${f.name} → ${got.state}${got.error ? ` (${got.error})` : ""}`, same,
    `expected ${JSON.stringify(want.expect)}${want.keys ? " keys=" + JSON.stringify(want.keys) : ""}, got ${JSON.stringify(got)}${r.state === "present" ? " keys=" + JSON.stringify(Object.keys(r.value).sort()) : ""}`);
}
ok("no golden row lost its fixture", golden.fixtures.every((g) => FIXTURES.some((f) => f.name === g.name)),
  `orphaned: ${golden.fixtures.filter((g) => !FIXTURES.some((f) => f.name === g.name)).map((g) => g.name).join(", ")}`);

console.log("\n2. the grammar is executable by eye — one spelling, and a near-miss is loud");
ok("the canonical opening is a single literal a person can grep for",
  DECLARATION_OPEN === '<script type="application/json" id="oma-manifest">');
for (const [label, html] of [
  ["single quotes", `<script type='application/json' id='oma-manifest'>{"a":1}</script>`],
  ["attributes swapped", `<script id="oma-manifest" type="application/json">{"a":1}</script>`],
  ["extra attribute", `<script type="application/json" id="oma-manifest" defer>{"a":1}</script>`],
])
  ok(`a near-miss (${label}) is refused BY NAME, never silently ignored`,
    readDeclaration(html).error === "manifest_block_malformed");
ok("prose may mention the marker — a comment about it is not a declaration attempt",
  readDeclaration("<p>the oma-manifest block goes in the head</p>").state === "absent");
ok("two declarations are refused rather than resolved (any pick leaves some reader on the other one)",
  readDeclaration(DECLARATION_OPEN + "{}</script>" + DECLARATION_OPEN + "{}</script>").error === "duplicate_manifest_block");

console.log("\n3. what used to need a browser to answer");
// Both of these were live holes in the tokenizer version. Under a byte grammar the first is simply
// found (position is irrelevant, and documented as such — the authoritative record of what a
// component declared is the materialised column, not a rendering), and the second cannot arise
// because there is no tokenizer state to double-escape into.
ok("a block inside a <template> is found, because position is not part of the grammar",
  readDeclaration(`<template>${DECLARATION_OPEN}{"functions":{"x":{}}}</script></template>`).state === "present");
ok("a `<!--<script>` sequence has nothing to confuse — the block ends at the first </script",
  readDeclaration(`${DECLARATION_OPEN}{"n":"ok"}</script>{"tail":1}</script>`).state === "present");
ok("...and the JSON that runs past its own </script> simply fails to parse, loudly",
  readDeclaration(`${DECLARATION_OPEN}{"n":"</script>"}</script>`).error === "manifest_bad_json");

console.log("\n4. real components — the corpus is not the only input that matters");
for (const name of ["dashboard", "bill-calendar", "keep-in-touch", "settings"]) {
  const html = readFileSync(join(ROOT, "components", `${name}.html`), "utf8");
  const r = readDeclaration(html);
  const expectPresent = name !== "settings";           // settings.html ships no block
  ok(`${name}.html → ${r.state}`, expectPresent ? r.state === "present" : r.state === "absent", r.error || "");
}
// Five of the nine shipped blocks declare no `settings` key at all — which is exactly the case a
// consumer-side `Array.isArray(m.settings)` gate used to drop on the floor.
const noSettings = ["bill-calendar", "habit-streaks", "keep-in-touch", "savings-goals", "spending-journal"]
  .filter((n) => { const r = readDeclaration(readFileSync(join(ROOT, "components", `${n}.html`), "utf8")); return r.state === "present" && r.value.settings === undefined; });
ok("a declaration with no `settings` key is still a declaration (5 shipped components rely on it)", noSettings.length === 5, `saw ${noSettings.length}`);

console.log("\n5. bounds");
const big = `<script type="application/json" id="oma-manifest">{"pad":"${"x".repeat(MAX_DECLARATION_BYTES)}"}</script>`;
ok("an oversized declaration is refused by size, not by parsing it", readDeclaration(big).error === "manifest_too_large");
const t0 = performance.now();
readDeclaration("<".repeat(200_000));
const worst = performance.now() - t0;
ok(`adversarial 200KB input stays linear (${worst.toFixed(1)}ms)`, worst < 250,
  "this runs inside the write transaction — a quadratic blowup here is a write-path stall");

if (BLESS) {
  writeFileSync(GOLDEN, JSON.stringify({ note: golden.note, fixtures: actual }, null, 2) + "\n");
  console.log(`\n  ⟳ blessed ${GOLDEN}`);
}
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 || BLESS ? 0 : 1);
