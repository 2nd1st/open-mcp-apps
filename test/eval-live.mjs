// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/eval-live.mjs — the live-model tier. Drives a REAL model against a REAL engine.
//
// WHY THIS TIER EXISTS. Everything else in test/ proves the engine emits the strings we meant. It
// cannot prove those strings make a model behave. Every change to INSTRUCTIONS, to a tool
// description, to an acknowledgement is otherwise a blind edit — and we make those constantly.
//
// WHAT IT ASSERTS, and what it deliberately does not: the FINAL STATE IN THE STORE, plus which
// tools were called. Never the model's prose. Wording is unstable across models and across the
// same model's revisions; "a component exists and has three rows" is not.
//
// 🔺 THE PART NO REAL HOST CAN DO. claude.ai feeds the model `content` and routes structuredContent
// to the widget; codex feeds it structuredContent and does not pass content to the model at all
// (both measured 2026-07-26, confirmed at the wire). No single host exercises both. This harness is
// the host, so it runs every task under BOTH policies — which is the only way to catch a fact that
// exists on one channel and not the other, the exact class of bug found the day this was written.
//
// Costs money, so it is NOT in `npm test`. Runs when OMA_EVAL_KEY is set:
//   OMA_EVAL_KEY=... OMA_EVAL_BASE=http://host/v1 node test/eval-live.mjs [taskId...]
// Without a key it exits 0 and says so, so CI stays green and honest rather than green and blind.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.mjs";
import { createEngine } from "../src/engine.mjs";
import { seedSystemComponents } from "../seed.mjs";

const KEY = process.env.OMA_EVAL_KEY;
// Any OpenAI-compatible chat-completions endpoint. Defaulting to a private gateway would have
// shipped one operator's internal hostname to every reader of a public repo; point it wherever.
const BASE = process.env.OMA_EVAL_BASE || "https://api.openai.com/v1";
const MODEL = process.env.OMA_EVAL_MODEL || "gpt-5.4-mini";
const MAX_TURNS = 14;   // a runaway loop is a real cost, not just a slow test

if (!KEY) {
  console.log("eval-live: SKIPPED — no OMA_EVAL_KEY.");
  console.log("  This tier is the only thing that checks whether our text changes MODEL BEHAVIOUR.");
  console.log("  Everything else proves the strings are what we wrote, not that they work.");
  process.exit(0);
}

// ── the two host channel policies, as measured ───────────────────────────────────────────────
// The whole point of running both: a fact carried on only one channel is invisible on one host.
const CHANNELS = {
  // claude.ai: the model reads content; structuredContent goes to the widget.
  content: (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n") || "(no text)",
  // codex: the model reads structuredContent when present, otherwise content.
  structured: (r) => (r.structuredContent
    ? JSON.stringify(r.structuredContent)
    : (r.content ?? []).map((c) => c.text ?? "").join("\n")) || "(empty)",
};

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("    ✓ " + name))
  : (fail++, console.log("    ✗ " + name + (note ? "\n        " + note : ""))));

/** One MCP session over a private store. */
async function session() {
  const dir = mkdtempSync(join(tmpdir(), "oma-eval-"));
  const db = join(dir, "store.db");
  const store = openStore(db);
  seedSystemComponents(store);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const engine = createEngine(store, { hostLabel: "eval" });
  await engine.connect(st);
  const client = new Client({ name: "eval", version: "1.0.0" },
    { capabilities: { extensions: { "io.modelcontextprotocol/ui": {} } } });
  await client.connect(ct);
  const instructions = engine.server._instructions;
  const { tools } = await client.listTools();
  return {
    store, client, instructions, tools,
    async close() { await client.close(); store.close(); for (const f of [db, db + "-wal", db + "-shm"]) if (existsSync(f)) unlinkSync(f); },
  };
}

/** MCP tool definitions -> Responses API function tools. */
const asFunctions = (tools) => tools.map((t) => ({
  type: "function",
  name: t.name,
  description: t.description,
  parameters: t.inputSchema?.properties ? t.inputSchema : { type: "object", properties: {} },
}));

async function callModel(body) {
  const res = await fetch(`${BASE}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/**
 * Run one task to completion. Returns what happened, not what was said.
 * `render` is the channel policy — the single knob that makes this harness able to impersonate
 * either host.
 */
async function run({ prompt, tools, instructions, client, render }) {
  const input = [{ role: "user", content: [{ type: "input_text", text: prompt }] }];
  const calls = [];
  let modelId = null;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await callModel({ model: MODEL, instructions, input, tools: asFunctions(tools) });
    modelId = res.model ?? modelId;
    const fnCalls = (res.output ?? []).filter((o) => o.type === "function_call");
    for (const o of res.output ?? []) input.push(o);
    if (!fnCalls.length) break;
    for (const fc of fnCalls) {
      let args = {};
      try { args = JSON.parse(fc.arguments || "{}"); } catch {}
      let out, isError = false;
      try {
        const r = await client.callTool({ name: fc.name, arguments: args });
        isError = r.isError === true;
        out = render(r);
      } catch (e) { isError = true; out = `error: ${e.message}`; }
      calls.push({ name: fc.name, args, isError });
      input.push({ type: "function_call_output", call_id: fc.call_id, output: String(out).slice(0, 60_000) });
    }
  }
  return { calls, modelId };
}

// ── tasks ────────────────────────────────────────────────────────────────────────────────────
// Each asserts the store, not the transcript. `setup` runs before the model sees anything.
const TASKS = [
  {
    id: "onboarding",
    why: "the GETTING STARTED half of INSTRUCTIONS is only served to users with nothing — does it actually produce an app?",
    prompt: "I just installed this. How do I use it?",
    check: (s, { calls }) => {
      const own = s.listComponents().filter((c) => !["settings", "dashboard", "library"].includes(c.name));
      ok("built at least one app instead of explaining", own.length >= 1,
        `components: ${s.listComponents().map((c) => c.name).join(", ")}`);
      ok("and opened it", calls.some((c) => c.name === "open_component" || c.name.startsWith("open_")));
      ok("no failed tool calls", !calls.some((c) => c.isError),
        calls.filter((c) => c.isError).map((c) => c.name).join(", "));
    },
  },
  {
    id: "first-stop",
    why: "INSTRUCTIONS says look HERE first for the user's own data — does it?",
    setup: (s) => {
      s.execute({ type: "save_component", command_id: "t1", name: "reading-list", html: "<p>x</p>".repeat(200), description: "Books to read", actor: "agent" });
      s.execute({ type: "add_item", command_id: "t2", collection: "reading-list", fields: { title: "Dune" }, actor: "human" });
    },
    prompt: "What am I tracking?",
    check: (s, { calls }) => {
      ok("looked in the engine rather than answering from nothing",
        calls.some((c) => ["data_collections", "list_components"].includes(c.name)),
        `called: ${calls.map((c) => c.name).join(", ") || "(nothing)"}`);
      ok("no failed tool calls", !calls.some((c) => c.isError));
    },
  },
  {
    id: "reuse-not-recreate",
    why: "INSTRUCTIONS warns against recreating something under a new name — the returning-user half now says it twice",
    setup: (s) => {
      s.execute({ type: "save_component", command_id: "r1", name: "reading-list", html: "<p>x</p>".repeat(200), description: "Books to read", actor: "agent" });
      s.execute({ type: "add_item", command_id: "r2", collection: "reading-list", fields: { title: "Dune" }, actor: "human" });
    },
    prompt: "Add 'Neuromancer' to my reading list.",
    check: (s) => {
      const items = s.snapshot("reading-list").items;
      ok("the row landed in the EXISTING collection", items.some((i) => /Neuromancer/i.test(JSON.stringify(i.fields))),
        `reading-list has: ${items.map((i) => JSON.stringify(i.fields)).join(" | ")}`);
      const own = s.listComponents().filter((c) => !["settings", "dashboard", "library"].includes(c.name));
      ok("no near-duplicate component was created", own.length === 1, `components: ${own.map((c) => c.name).join(", ")}`);
    },
  },
  {
    id: "multi-write",
    why: "three rows, three ids — the ack is now the ONLY place an id appears, on both channels",
    setup: (s) => s.execute({ type: "save_component", command_id: "m1", name: "todos", html: "<p>x</p>".repeat(200), description: "Simple todo list", actor: "agent" }),
    prompt: "Add three todos to my todos app: buy milk, call the dentist, renew passport.",
    check: (s) => {
      const items = s.snapshot("todos").items;
      ok("exactly three rows exist", items.length === 3, `got ${items.length}: ${items.map((i) => JSON.stringify(i.fields)).join(" | ")}`);
      const blob = JSON.stringify(items).toLowerCase();
      ok("all three are the ones asked for", ["milk", "dentist", "passport"].every((w) => blob.includes(w)));
    },
  },
  {
    id: "update-by-id",
    why: "🔴 the regression this catches: a FAILED write used to be indistinguishable from a successful one on the structured channel",
    setup: (s) => {
      s.execute({ type: "save_component", command_id: "u1", name: "todos", html: "<p>x</p>".repeat(200), description: "Simple todo list", actor: "agent" });
      for (const [i, t] of ["buy milk", "call the dentist", "renew passport"].entries())
        s.execute({ type: "add_item", command_id: `u2-${i}`, collection: "todos", fields: { title: t, done: false }, actor: "human" });
    },
    prompt: "I finished the dentist one — mark it done.",
    check: (s) => {
      const items = s.snapshot("todos").items;
      const dentist = items.find((i) => /dentist/i.test(String(i.fields?.title ?? "")));
      ok("the right row was updated", dentist?.fields?.done === true || dentist?.fields?.done === "true",
        `dentist row: ${JSON.stringify(dentist?.fields)}`);
      ok("the other two were left alone",
        items.filter((i) => i.fields?.done === true || i.fields?.done === "true").length === 1,
        items.map((i) => JSON.stringify(i.fields)).join(" | "));
    },
  },
  {
    id: "user-changed-it",
    why: "the differentiator: the user edited the widget directly, and that never passed through the model",
    setup: (s) => {
      s.execute({ type: "save_component", command_id: "d1", name: "todos", html: "<p>x</p>".repeat(200), description: "Simple todo list", actor: "agent" });
      s.execute({ type: "add_item", command_id: "d2", collection: "todos", fields: { title: "buy milk" }, actor: "agent" });
      s.execute({ type: "add_item", command_id: "d3", collection: "todos", fields: { title: "book flights" }, actor: "human" });
      s.execute({ type: "delete_item", command_id: "d4", collection: "todos", id: s.snapshot("todos").items[0].id, actor: "human" });
    },
    prompt: "I was just in the todos app doing things. What did I change?",
    check: (s, { calls }) => {
      ok("asked the ledger rather than diffing a snapshot it never had",
        calls.some((c) => c.name === "data_changes"),
        `called: ${calls.map((c) => c.name).join(", ") || "(nothing)"}`);
      ok("no failed tool calls", !calls.some((c) => c.isError));
    },
  },
];

// ── run ──────────────────────────────────────────────────────────────────────────────────────
const want = process.argv.slice(2);
const tasks = want.length ? TASKS.filter((t) => want.includes(t.id)) : TASKS;
console.log(`eval-live — model ${MODEL} @ ${BASE}\n${tasks.length} task(s) x ${Object.keys(CHANNELS).length} channel policies\n`);

let seenModel = null;
for (const task of tasks) {
  console.log(`▸ ${task.id} — ${task.why}`);
  for (const [channel, render] of Object.entries(CHANNELS)) {
    console.log(`  [${channel}]`);
    const s = await session();
    try {
      task.setup?.(s.store);
      const result = await run({ prompt: task.prompt, tools: s.tools, instructions: s.instructions, client: s.client, render });
      seenModel = result.modelId ?? seenModel;
      const before = fail;
      task.check(s.store, result);
      // The sequence is the diagnosis. Without it a red line says "the model did not do the thing"
      // and leaves you guessing WHICH step it skipped — which is most of the work.
      if (fail > before)
        console.log(`        calls: ${result.calls.map((c) => c.name + (c.isError ? "!" : "")).join(" -> ") || "(none)"}`);
    } catch (e) {
      fail++; console.log(`    ✗ threw: ${e.message}`);
    } finally { await s.close(); }
  }
}

// The model id is recorded because we cannot detect someone else upgrading a model — but when
// behaviour drifts, this is what makes the drift attributable instead of mysterious.
console.log(`\neval-live: ${pass} passed, ${fail} failed   (model reported: ${seenModel ?? "unknown"})`);
process.exit(fail ? 1 : 0);
