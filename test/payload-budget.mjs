// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/payload-budget.mjs — the product's economics, as a regression test.
//
// The engine's claim is that cost stops scaling with data volume. E1Δ made that true and this
// file is what keeps it true: every mutation used to echo the ENTIRE collection back in text, so
// adding one row to a 500-item collection billed the model for 500 rows. It is now an ack.
//
// The caps are a RATCHET. A number in a roadmap decays; a number in CI does not — and the win
// here (1,711 tk -> 33 tk for a write) can now only be given back by a red build.
//
// Bytes, not tokens: see the calibration note in test/tool-surface.mjs — 4 B/tk, cross-checked
// against count_tokens. Free and deterministic, so CI needs no API key.
// Run: node test/payload-budget.mjs
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openStore } from "../src/store.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "budget.db");
const N = 500;          // the size the roadmap quotes its numbers at
const COLL = "budget-probe";

// Two axes, because they mean different things and only one is the model's bill:
//   text    — content[], what the model reads and pays for. THIS is where E1Δ's win is locked in.
//   emitted — the whole result on the wire. structuredContent dominates it and stays COMPLETE by
//             design (the widget needs it, and hosts route it away from the transcript), so this
//             axis only guards against runaway growth — it is not a cost the model bears here.
// Gating on `emitted` alone would have punished the correct design: E1Δ cut the model's bill 52x
// while `emitted` barely moved, because the full snapshot is exactly what we still owe the widget.
const CAPS = {
  // 423 B measured over a 500-item collection. The old 92,000 was sized for a write that echoed the
  // whole collection back; the ack carries one row, so the emitted cost no longer scales with the
  // data at all. Ratcheted to just above the measurement: if a write ever grows past 1,200 B here,
  // something has started riding along that should not be.
  write_one:  { text:   400, emitted:  1_200 },
  list_full:  { text: 13_000, emitted: 40_000 }, // write-set C: the default read is a 100-row FIRST PAGE (refusal deleted). Full rows ride — ~2.9K tk on this fat 500-collection — and the structured body is budget-bounded (RESULT_BUDGET + wrapper)
  list_paged: { text: 3_000, emitted:  7_000 },  // grew ON PURPOSE: pages now carry ids and every field
  version:    { text:   100, emitted:     250 },
};

for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

// Seed straight through the store: N tool round-trips would measure the transport, not the payload.
{
  const store = openStore(DB);
  for (let i = 0; i < N; i++)
    store.execute({
      type: "add_item", command_id: `seed-${i}`, collection: COLL, group: `g${i % 5}`,
      fields: { title: `item ${i}`, done: i % 3 === 0, note: "a realistic-length note field" },
      actor: "seed",
    });
  store.close();
}

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

const client = new Client({ name: "budget", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: "node",
  args: [join(ROOT, "src", "server.mjs")],
  env: { ...process.env, OMA_DB: DB, OMA_HOST: "budget", OMA_DYNAMIC_TOOLS: "" },
}));

/** Two numbers per call, because they are not the same number:
 *  emitted  — the whole result object, i.e. everything we put on the wire.
 *  text     — content[] only, which is what the MODEL is billed for on the widget path.
 *
 *  Probed live in claude.ai on 2026-07-26, on BOTH paths: after open_app (a widget tool) and
 *  after data_list (not a widget tool), the model could name nothing beyond what the text carried.
 *  So on THAT host structuredContent does not reach the model — it is routed to the widget — which
 *  is the asymmetry E1Δ is built on.
 *
 *  ⚠️ CORRECTED the same day, and the correction matters: that is not universal. codex reads the
 *  opposite channel — it feeds the model structuredContent and drops `content` entirely when
 *  structuredContent is present (OMA_PROBE, verbatim reproduction). So on codex the `text` column
 *  below is not the model's bill; `emitted` is. Keeping `emitted` gated was speculative when it was
 *  written ("whether a host feeds structuredContent is a per-host variable") and is now the only
 *  gate that binds on half the hosts we ship to. Neither number is THE bill — which one is depends
 *  on the host, and that is a fact about hosts, not about this file. See test/two-channel.mjs for
 *  the correctness consequence, which is the more serious half. */
const cost = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { emitted: JSON.stringify(r).length, text: (r.content ?? []).map((c) => c.text ?? "").join("").length };
};

const calls = {
  write_one:  await cost("data_add_item", { command_id: randomUUID(), collection: COLL, fields: { title: "one more" } }),
  list_full:  await cost("data_list", { collection: COLL }),
  list_paged: await cost("data_list", { collection: COLL, limit: 20 }),
  version:    await cost("data_version", {}),
};
const measured = Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, v.text]));

console.log(`payload cost over a ${N}-item collection  (emitted = on the wire · text = what the model reads):`);
for (const [k, { emitted, text }] of Object.entries(calls))
  ok(`${k.padEnd(10)} text ${String(text).padStart(6)} B ≈ ${String(Math.round(text / 4)).padStart(4)} tk (cap ${CAPS[k].text})` +
    `  ·  emitted ${String(emitted).padStart(6)} B (cap ${CAPS[k].emitted})`,
    text <= CAPS[k].text && emitted <= CAPS[k].emitted,
    `over budget. Lower the payload — do NOT raise a cap without saying why in the commit message.`);

// The relationship, not just the absolutes.
ok("a one-row write costs the model less than reading the collection",
  measured.write_one < measured.list_full,
  `write_one=${measured.write_one} B vs list_full=${measured.list_full} B — a mutation must never cost ` +
  `more to read about than the data itself. Before E1Δ these were equal, because every write echoed ` +
  `the entire snapshot.`);

console.log(`\n  E1Δ: a write costs the model ${Math.round(calls.write_one.text / 4)} tk over ${N} items ` +
  `(6,845 B / ~1,711 tk before). The default read is a first PAGE (never a refusal, never the whole ` +
  `collection): items ride whole, returned/total say what you got, next_cursor continues.`);

await client.close();
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

console.log(`\npayload-budget: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
