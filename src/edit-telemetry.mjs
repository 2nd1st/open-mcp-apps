// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// edit-telemetry.mjs — the R1 tripwire's data source (W-E, redesign §8-R1).
//
// R1's full source-graph rewrite is DEFERRED behind a measured tripwire (devil's original
// conjunction): across ≥2 hosts and ≥50 qualified range/hash edits, median upload bytes per
// changed byte still >2× AND >10% of edits still fall back to full rewrite or die on
// structural ambiguity. Somebody has to actually count those things, per edit, per host —
// that somebody is this file.
//
// One JSONL line per editing event, in a sidecar next to the DB (the .confirm-key precedent:
// operational data lives BESIDE the store, never inside it — no schema migration for metrics).
// The sidecar never enters git or the public snapshot (guardrails in .gitignore/publish).
// Failures are swallowed: telemetry must never take an edit down with it.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REPORT_EVERY = 50; // qualified edits per report — the tripwire's own cadence

export function editTelemetry(dataDir) {
  const file = join(dataDir, "edit-telemetry.jsonl");
  let qualified = null; // lazily counted once per process, incremented in memory after

  const countQualified = () => {
    try {
      return readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"outcome":"ok"') && !l.includes('"mode":"rewrite"')).length;
    } catch { return 0; }
  };

  // entry: {host, app, mode: "range"|"string"|"mixed"|"rewrite", edits, req_bytes,
  //         changed_bytes, doc_bytes, outcome}
  // Returns the qualified-edit count when this entry crosses a REPORT_EVERY boundary
  // (the caller puts a one-line milestone note in the ack for Leo), else null.
  return function record(entry) {
    try {
      appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
      if (entry.outcome !== "ok" || entry.mode === "rewrite") return null;
      qualified = (qualified === null ? countQualified() : qualified + 1);
      return qualified % REPORT_EVERY === 0 ? qualified : null;
    } catch { return null; }
  };
}
