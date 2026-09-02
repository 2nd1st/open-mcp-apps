// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/write-ack.mjs — every runtime resolves a write to the SAME shape the .d.ts promises.
//
// `types/window-oma.d.ts` declares `addItem` / `updateItem` / `moveItem` / `deleteItem` / `setPref`
// as `Promise<OmaAck>` — `{ok, id, item, …}`, where a refusal is an ANSWER and not an exception.
// Three layers answered three different things instead (measured 2026-08-23, all three live):
//
//   direct / standalone   {content, structuredContent}     — the raw MCP envelope
//   sandboxed runner      {content, structuredContent}     — the same envelope, relayed
//   inert previews        {ok:true}                        — and nothing else
//
// None of the three is `OmaAck`. In Chrome against /view/hydration-tally that read as: `ack.ok`
// `undefined` on a write that had just succeeded, so `if (!ack.ok)` called every success a failure
// and `if (ack.ok === false)` called every refusal a success; `ack.item.version` invisible, so an
// editor-style app could not recognise the echo of its own write and wrote the stale server copy
// back over what the user was typing — two seconds later, with nothing logged.
//
// Every app in components/ had grown its own adapter for this (knowledge-cards `requireSuccess`,
// project-pulse `writeFailed`, wonder-atlas `writeResultFailed`, an inline test in
// meeting-actions), and most of them were subtly wrong, because a shim written against two of the
// three shapes reads the third as success. A contract each reader must adapt to is not a contract.
//
// What this file holds, forever: the SHAPE, on every runtime, through the real machinery — a real
// engine over stdio for the two live layers, the shipped bridge source evaluated into a document
// for the sandboxed one, and both inert previews. Plus the consequence that started it: a loop
// guard keyed on `ack.item.version` actually suppresses its own echo.
//
// Run: node test/write-ack.mjs
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeGuard, BRIDGE, stubOmaScript } from "../src/runner.mjs";
import { ackOf } from "../src/runtime-core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "write-ack.db");
const COLL = "write-ack";

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));
/** A runtime that hands back the wrong SHAPE makes the next call throw (an `id` read off an
 *  envelope is undefined, and the guard refuses an unknown id). That has to arrive as a red
 *  assertion, not as a stack trace that takes the rest of the file with it. */
const attempt = async (what, fn) => {
  try { return await fn(); }
  catch (e) { fail++; console.log("  ✗ " + what + " — threw instead of answering\n      " + String((e && e.message) || e)); return undefined; }
};

for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

const client = new Client({ name: "write-ack", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: "node",
  args: [join(ROOT, "src", "server.mjs")],
  env: { ...process.env, OMA_DB: DB, OMA_HOST: "write-ack", OMA_DYNAMIC_TOOLS: "" },
}));
const callTool = (name, args) => client.callTool({ name, arguments: args });
const rows = async () => (await callTool("data_list", { collection: COLL, limit: 100 })).structuredContent;

/** What `types/window-oma.d.ts` calls an OmaAck, checked as a shape rather than as a name. */
function isAck(v) {
  return !!v && typeof v === "object" && typeof v.ok === "boolean"
    && !("structuredContent" in v) && !("content" in v);
}
/** …and the three fields an app actually reaches for on a SUCCESSFUL row write. */
function isFullAck(v) {
  return isAck(v) && v.ok === true && typeof v.id === "string"
    && !!v.item && typeof v.item.version === "number" && !!v.item.fields;
}

// ─────────────────────────────────────────────────────────────── 1. direct / standalone runtime
console.log("1. the direct runtime (shell-runtime.js) — the surface a /view page and a chat host share");
{
  // Both transports rawCall can use end in the same place: `call()` finishes `return result` with
  // the CallToolResult verbatim, so what the verb ADDS after `call(...)` is the whole difference
  // between the envelope and the ack. Read out of the shipped source, then exercised for real.
  const src = readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf-8");
  for (const verb of ["data_add_item", "data_update_item", "data_move_item"]) {
    ok(`${verb} resolves through ackOf, not the raw envelope`,
      new RegExp(`return call\\("${verb}"[^\\n]*\\)\\.then\\(ackOf\\);`).test(src));
  }
  ok("the delete verb does too, AFTER the confirmation loop has settled",
    /return confirmable\("data_delete_item"[^\n]*\)\.then\(ackOf\);/.test(src));
  ok("…and setPref, which bypasses call() and so bypassed the unwrap living there",
    /\}\)\.then\(ackOf\);\n  \},/.test(src));
  // The escape hatch is DELIBERATELY not wrapped: `callTool` is typed Promise<unknown> and eight
  // apps in components/ read `.structuredContent` off it. Unwrapping it would break them.
  ok("oma.callTool is left alone — the raw tool surface stays raw",
    /return rawCall\(name, a\);/.test(src) && !/return rawCall\(name, a\)\.then\(ackOf\)/.test(src));

  const envelope = await callTool("data_add_item",
    { command_id: randomUUID(), collection: COLL, fields: { t: "direct" }, actor: "human" });
  ok("the engine's own answer is an envelope (the thing that used to reach the app)",
    !!envelope.structuredContent && !("ok" in envelope));
  ok("…and the verb's tail turns it into a complete ack", isFullAck(ackOf(envelope)),
    JSON.stringify(ackOf(envelope)));
}

// ─────────────────────────────────────────────────────────── 2. the sandboxed runner, end to end
console.log("\n2. the sandboxed runner — the SHIPPED bridge source, wired to a real engine");

/** Evaluate the real child bridge into a stub document whose `parent` is a real guard. */
function mountBridge(guard) {
  const listeners = [];
  const parent = {
    postMessage(d) {
      if (!d || !d.omaRun) return;
      Promise.resolve().then(() => guard(d.method, d.args || {})).then(
        (result) => deliver({ omaRunResult: true, id: d.id, result }),
        (e) => deliver({ omaRunResult: true, id: d.id, error: String((e && e.message) || e) }));
    },
  };
  // A browser does not let one message listener's exception escape into the code that posted the
  // message, and neither may this rig — otherwise a runtime returning the wrong shape kills the run.
  const deliver = (data) => { for (const fn of listeners) { try { fn({ source: parent, data }); } catch { /* reported by the awaiting assertion */ } } };
  const el = () => ({ style: { setProperty() {}, removeProperty() {} }, addEventListener() {}, appendChild() {} });
  const doc = { readyState: "complete", addEventListener() {}, documentElement: el(), body: el(),
                createElement: el, querySelector: () => null };
  const win = { addEventListener: (t, fn) => { if (t === "message") listeners.push(fn); },
                innerHeight: 600, screen: { height: 900 }, document: doc, parent };
  const Obs = class { observe() {} disconnect() {} };
  new Function("window", "document", "parent", "self", "MutationObserver", "ResizeObserver",
    BRIDGE.replace(/^<script>/, "").replace(/<\/script>$/, ""))(win, doc, parent, win, Obs, Obs);
  return win.oma;
}

const CAPS = { read_source: true, file_read: true, file_write: true, cross_collection_read: true,
               cross_collection_write: true, settings_write: true, send_message: true,
               delete_items: "allow", call_tools: "*" };
// The guard scopes id-addressed writes to the rows the child is HOLDING, so the snapshot has to
// track the real collection or every updateItem refuses with "out of scope".
let held = { collection: COLL, items: [], version: 1 };
const io = { callTool, sendMessage: async () => ({}), snapshot: () => held,
             settingsIds: () => new Set(["never-empty"]),
             readCollection: async (c) => (await callTool("data_list", { collection: c, limit: 100 })).structuredContent,
             readFile: async () => ({ base64: "", mime: "" }), notify() {},
             requestConfirm: async () => true, uuid: () => randomUUID() };
const child = mountBridge(makeGuard({ name: "write-ack-app", coll: COLL, caps: CAPS, tier: "local", preset: "live", io }));
{
  const add = await attempt("child addItem", () => child.addItem({ fields: { t: "sandboxed" } }));
  ok("a sandboxed child's addItem resolves an ack, not the relayed envelope", isFullAck(add), JSON.stringify(add));
  held = await rows();
  const upd = await attempt("child updateItem", () => child.updateItem(add && add.id, { t: "edited" }));
  ok("…and so does updateItem", isFullAck(upd), JSON.stringify(upd));
  ok("…with the merged row inside it, not just a verdict", !!upd && upd.item.fields.t === "edited");
  held = await rows();
  const del = await attempt("child deleteItem", () => child.deleteItem(add && add.id));
  ok("…and a delete answers ok:true with deleted:true and no row", isAck(del) && del.ok === true && del.deleted === true,
    JSON.stringify(del));

  // The chokepoint on the PARENT side keeps speaking envelopes on purpose: the embedder's own
  // continuity machinery reads `result.structuredContent` off exactly this value to redraw the
  // child with no extra round trip. The unwrap belongs at `window.oma`, which is where the
  // contract is, and nowhere else.
  const raw = await makeGuard({ name: "write-ack-app", coll: COLL, caps: CAPS, tier: "local", preset: "live", io })(
    "addItem", { fields: { t: "guard-level" } });
  ok("the guard itself still returns the envelope (the embedder's continuity rule reads it)",
    !!raw.structuredContent && !("ok" in raw), JSON.stringify(Object.keys(raw)));
}

// ─────────────────────────────────────────────────────────────────────── 3. the inert previews
console.log("\n3. the two inert previews — a pretend write still owes a real answer");
{
  const inert = mountBridge(makeGuard({ name: "write-ack-app", coll: COLL, caps: CAPS, tier: "local", preset: "inert",
    io: { ...io, snapshot: () => ({ collection: COLL, items: [{ group: "", fields: { t: "fx" } }], version: 7, apps: [] }) } }));
  const a = await attempt("inert addItem", () => inert.addItem({ fields: { t: "preview" } })) || {};
  ok("parented inert: addItem answers a complete ack, not a bare {ok:true}", isFullAck(a), JSON.stringify(a));
  ok("…whose seq sits ABOVE the snapshot version, so an ack.seq > state.version test reads true",
    a.seq > 7, "seq " + a.seq + " vs version 7");
  const b = await attempt("inert updateItem", () => inert.updateItem("fx-0", { t: "typed" })) || {};
  ok("…and an update carries the named row, merged with the fields it was sent",
    isFullAck(b) && b.id === "fx-0" && b.item.fields.t === "typed" && b.item.fields.t !== "fx", JSON.stringify(b));
  ok("…and two writes do not share one seq", b.seq > a.seq, a.seq + " then " + b.seq);
  const d = await attempt("inert deleteItem", () => inert.deleteItem("fx-0")) || {};
  ok("…and a delete says deleted, without inventing a row", isAck(d) && d.deleted === true && !d.item);

  const win = {};
  new Function("window", stubOmaScript(COLL, [{ group: "", fields: { t: "fx" } }])
    .replace(/^<script>/, "").replace(/<\/script>$/, ""))(win);
  const s1 = await win.oma.addItem({ fields: { t: "preview" } });
  const s2 = await win.oma.updateItem("fx-0", { t: "typed" });
  ok("standalone inert stub: addItem answers a complete ack too", isFullAck(s1), JSON.stringify(s1));
  ok("…and it agrees with its parented twin, key for key",
    JSON.stringify(Object.keys(s1).sort()) === JSON.stringify(Object.keys(a).sort()),
    JSON.stringify(Object.keys(s1).sort()) + " vs " + JSON.stringify(Object.keys(a).sort()));
  // It used to resolve ONE frozen `{ok:true}` for every write in the document: identical seqs for
  // every writer, and a mutation by any app visible to the next one.
  ok("…and every call mints its own ack (one shared object served them all before)",
    s1 !== s2 && s2.seq > s1.seq);
  ok("…and setPref answers in the same shape as the other verbs",
    isFullAck(await win.oma.setPref("k", "v")));
}

// ────────────────────────────────────────────────────────────────────────── 4. the loop guard
console.log("\n4. the consequence: an echo-suppressing bridge can recognise its own write");
{
  // The pattern a two-way bridge (TiddlyWiki, a text editor, anything with an outside source of
  // truth) is obliged to use: remember the version your own write produced, and skip any change
  // event at or below it. With `ack.item` invisible the memory stays 0, the app's own echo looks
  // newer than anything it remembers, and the guard writes the server's stale copy back over
  // what the user is typing — silently, because nothing failed.
  const seed = ackOf(await callTool("data_add_item",
    { command_id: randomUUID(), collection: COLL, fields: { text: "" }, actor: "human" }));
  let mine = 0;                                    // the guard's memory
  const write = async (text) => {
    const ack = ackOf(await callTool("data_update_item",
      { command_id: randomUUID(), id: seed.id, fields: { text }, actor: "human" }));
    mine = (ack.item && ack.item.version) || 0;
    return ack;
  };
  await write("the user is typing");
  const echoed = (await rows()).items.find((r) => r.id === seed.id);
  ok("the guard remembers a real version, not 0", mine > 0, "remembered " + mine);
  ok("…so the change its OWN write provokes is recognised and skipped",
    echoed.version <= mine, "echo v" + echoed.version + " vs remembered v" + mine);

  // …and it still lets a FOREIGN write through, or the guard would be a mute button.
  await callTool("data_update_item",
    { command_id: randomUUID(), id: seed.id, fields: { text: "the AI edited this" }, actor: "agent" });
  const foreign = (await rows()).items.find((r) => r.id === seed.id);
  ok("…while somebody else's write is still let through", foreign.version > mine,
    "foreign v" + foreign.version + " vs remembered v" + mine);
}

await client.close();
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);
console.log(`\nwrite-ack: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
