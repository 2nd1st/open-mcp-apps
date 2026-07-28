// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/rig-version-radius.mjs — enumerate every consumer of a `version` number before the axes merge.
//
// Why a script and not a grep in a work order: the merge (item/component/file version -> ledger seq)
// changes what these numbers MEAN, not their type, so nothing fails — a missed consumer keeps
// working and starts lying. The only defence is a list nobody can claim was complete by memory.
//
// Run: node test/rig-version-radius.mjs        (prints the table; exits 0)
// A one-shot enumeration tool, not a regression gate — it is not in npm test on purpose: the
// pattern classes exist so a REINTRODUCTION (a new SQL-side +1, a new SUM(version)) is findable
// by rerunning this, not so CI turns red on every honest new consumer.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATTERNS = [
  ["read", /\.version\b/],
  ["occ", /expected_version/],
  ["inject", /__OMA_COMPONENT_VERSION__/],
  ["history", /maxHistVersion/],
  ["sql-bump", /version\s*=\s*version\s*\+\s*1/],
  ["sql-agg", /SUM\(version\)/],
  ["engine-own", /ENGINE_VERSION|SCHEMA_VERSION|manifest_version|kit_version/],
];

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(mjs|js|html)$/.test(e.name)) files.push(p);
  }
};
walk("src"); walk("components");

const rows = [];
for (const f of files) {
  const src = readFileSync(join(ROOT, f), "utf8").split("\n");
  for (let i = 0; i < src.length; i++) {
    for (const [kind, re] of PATTERNS) {
      if (!re.test(src[i])) continue;
      // `engine-own` names are OUR versions (package, schema, manifest, kit) — they do not move to
      // the ledger axis. Listed anyway, and labelled, because "is this one of the four?" is exactly
      // the question a reader of this table has.
      rows.push({ file: f, line: i + 1, kind, text: src[i].trim().slice(0, 110) });
      break;
    }
  }
}

const byFile = new Map();
for (const r of rows) byFile.set(r.file, (byFile.get(r.file) || 0) + 1);
const onAxis = rows.filter((r) => r.kind !== "engine-own");

console.log(`version consumers: ${rows.length} total, ${onAxis.length} on the row/component/file axis\n`);
for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) {
  const own = rows.filter((r) => r.file === f && r.kind === "engine-own").length;
  console.log(`  ${String(n).padStart(3)}  ${f}${own ? `   (${own} are engine-own names, not on the axis)` : ""}`);
}
console.log("\nOn-axis consumers, by kind:");
for (const [kind] of PATTERNS) {
  const hits = rows.filter((r) => r.kind === kind);
  if (!hits.length || kind === "engine-own") continue;
  console.log(`\n  [${kind}] ${hits.length}`);
  for (const h of hits) console.log(`    ${h.file}:${h.line}  ${h.text}`);
}
