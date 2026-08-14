// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/functions.mjs — the function pillar (W3), pinned end to end.
//
// What must stay true, forever:
//   1. The JOIN — a declared function with no body, or a body with no declaration, refuses the
//      SAVE. Silence in either direction is the failure mode the whole grammar exists to refuse.
//   2. The two axioms — execution never depends on render state (everything here runs with no
//      DOM anywhere), and a body is synchronous (a returned thenable is an ERROR, because the
//      time budget is only real without an escape onto the microtask queue).
//   3. The §2.5-D list holds structurally: the sandbox sees ONLY args+api, budgets refuse past
//      their line, inner command_ids derive from the call's (idempotent retry), via:{app,function}
//      is engine-stamped on every write and reaches the raw ledger — but never the AI face.
//   4. The seat is OPT-IN: createEngine grows call_function only when asked (hosted planes must
//      never inherit same-process execution by accident).
//
// Run: node test/functions.mjs

import { openStore, manifestShapeError } from "../src/store.mjs";
import { extractFunctionBodies, functionsJoinError, makeFunctionHost,
         FN_TIME_BUDGET_MS, FN_WRITE_BUDGET, FN_READ_BUDGET, MAX_FUNCTION_RESULT, MAX_FUNCTIONS } from "../src/functions.mjs";
import { createEngine } from "../src/engine.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

const dir = mkdtempSync(join(tmpdir(), "oma-fn-"));
const store = openStore(join(dir, "t.db"));
const CLOSE = "</" + "script>";
const block = (fn, body) => `<script type="text/oma-function" data-fn="${fn}">${body}${CLOSE}`;
const doc = (...blocks) => `<!doctype html><html><body>app\n${blocks.join("\n")}\n</body></html>`;
let cmdN = 0;
const save = (name, ui, manifest) => store.execute({
  type: "save_app", command_id: "s" + ++cmdN, name, ...(ui === undefined ? {} : { ui }),
  ...(manifest === undefined ? {} : { manifest }), actor: "agent",
});

// ------------------------------------------------------------------ 1. the byte grammar
console.log("1. the byte grammar — person-executable, loud on every near miss");
{
  const one = extractFunctionBodies(doc(block("tick", "return 1;")));
  ok("one block extracts", one.ok && one.bodies.tick === "return 1;");
  const two = extractFunctionBodies(doc(block("a", "return 1;"), block("b", "return 2;")));
  ok("two blocks extract independently", two.ok && two.bodies.a === "return 1;" && two.bodies.b === "return 2;");
  ok("a duplicate data-fn refuses rather than resolves",
    extractFunctionBodies(doc(block("a", "1"), block("a", "2"))).error === "duplicate_function_body");
  ok("an extra attribute on the tag is a refusal, not a shrug",
    extractFunctionBodies(doc('<script type="text/oma-function" data-fn="a" defer>x' + CLOSE)).error === "function_block_malformed");
  ok("a tag mentioning the type in another spelling is refused BY NAME",
    extractFunctionBodies(doc('<script type="TEXT/OMA-FUNCTION" data-fn="a">x' + CLOSE)).error === "function_block_malformed");
  ok("a bad function name is named in the refusal",
    extractFunctionBodies(doc(block("Bad-Name", "1"))).error === "bad_function_name");
  ok("the marker INSIDE a body is prose, not a tag — exempt",
    extractFunctionBodies(doc(block("a", 'const s = "text/oma-function"; return s;'))).ok === true);
  ok("an oversized body refuses with its size",
    extractFunctionBodies(doc(block("a", "x".repeat(40_000)))).error === "function_body_too_large");
  ok("CRLF documents extract the same bodies",
    extractFunctionBodies(doc(block("a", "return 1;")).replace(/\n/g, "\r\n")).bodies.a === "return 1;");
}

// ------------------------------------------------------------------ 2. declaration shape
console.log("2. manifest.functions — the declaration face, one field grammar with collections");
{
  ok("a valid roster passes", manifestShapeError({ functions: { rsvp: { description: "d", params: { name: { type: "string", required: true } } } } }) === null);
  ok("functions must be an object", /must be an object/.test(manifestShapeError({ functions: [] })));
  ok("a bad function name is refused", /function name/.test(manifestShapeError({ functions: { "Bad!": {} } })));
  ok("params reuse the FIELD grammar verbatim", /must be one of string\|number\|boolean\|object\|array/
    .test(manifestShapeError({ functions: { f: { params: { p: { type: "date" } } } } })));
  ok("public must be a boolean (the reserved B2 shape is validated from day one)",
    /public must be a boolean/.test(manifestShapeError({ functions: { f: { public: "yes" } } })));
  const many = Object.fromEntries(Array.from({ length: MAX_FUNCTIONS + 1 }, (_, i) => ["f" + i, {}]));
  ok("the roster is capped", new RegExp(`limit ${MAX_FUNCTIONS}`).test(manifestShapeError({ functions: many })));
}

// ------------------------------------------------------------------ 3. the save-door JOIN
console.log("3. the save door — declaration and body must agree, both directions, on the RESOLVED pair");
{
  ok("agreeing save lands", save("party", doc(block("rsvp", "return api.count();")),
    { functions: { rsvp: {} } }).ok === true);
  const r1 = save("ghosted", doc(), { functions: { ghost: {} } });
  ok("declared-but-bodiless refuses the save", r1.error === "bad_functions" && /no body block/.test(r1.detail));
  const r2 = save("orphaned", doc(block("orphan", "return 1;")));
  ok("body-but-undeclared refuses the save", r2.error === "bad_functions" && /does not declare/.test(r2.detail));
  // Inherited slots: the join is about what the app IS after the save, not about this call's args.
  const r3 = save("party", doc());   // new ui drops the body; manifest (with rsvp) is inherited
  ok("a ui-only save that drops a declared body refuses", r3.error === "bad_functions" && /no body block/.test(r3.detail));
  const r4 = save("party", undefined, null);   // clear the manifest; the body block is inherited
  ok("a manifest-only save that orphans a body refuses", r4.error === "bad_functions" && /does not declare/.test(r4.detail));
  ok("…and the app is still intact after every refusal (nothing half-saved)",
    JSON.parse(store.getApp("party").manifest).functions.rsvp !== undefined);
  ok("an ordinary app with neither declaration nor marker never pays the scanner",
    save("plain", "<html><body>plain</body></html>").ok === true);
  ok("functionsJoinError is the same judge the door used",
    functionsJoinError({ functions: { x: {} } }, doc()) !== null && functionsJoinError(null, doc()) === null);
}

// ------------------------------------------------------------------ 4. execution
console.log("4. execution — data in, data out, no DOM anywhere");
const host = makeFunctionHost(store);
const call = (app, fn, args, over = {}) => host.call({ app, function: fn, args, actor: "agent", host: "test", command_id: "c" + ++cmdN, ...over });
{
  save("rsvpapp", doc(block("rsvp",
    `const hit = api.list({ match: { name: args.name } })[0];
     if (hit) api.update({ id: hit.id, fields: { coming: args.coming } });
     else api.add({ fields: { name: args.name, coming: args.coming } });
     return { total: api.count() };`)),
    { functions: { rsvp: { params: { name: { type: "string", required: true }, coming: { type: "boolean", required: true } } } } });
  const r1 = call("rsvpapp", "rsvp", { name: "Sam", coming: true });
  ok("first call adds and returns the body's value", r1.ok && r1.result.total === 1 && r1.writes[0].op === "add_item");
  const r2 = call("rsvpapp", "rsvp", { name: "Sam", coming: false });
  ok("second call takes the update path", r2.ok && r2.writes[0].op === "update_item");
  ok("…onto the same row", r2.writes[0].id === r1.writes[0].id);
  const rows = store.snapshot("rsvpapp").items;
  ok("the data is really there", rows.length === 1 && rows[0].fields.coming === false);

  // Idempotent retry: same command_id ⇒ derived inner ids replay into the ledger's dedup.
  const again = host.call({ app: "rsvpapp", function: "rsvp", args: { name: "Sam", coming: false }, actor: "agent", host: "test", command_id: "c" + cmdN });
  ok("a retried call marks its writes idempotent instead of writing twice",
    again.ok && again.writes[0].idempotent === true && store.snapshot("rsvpapp").items.length === 1);

  // via:{app,function} — engine-stamped, raw-ledger visible, AI-face invisible (row #8).
  const raw = store.db.prepare("SELECT payload FROM change_event WHERE event_type='item_added' AND aggregate_id=?").get(r1.writes[0].id);
  const via = JSON.parse(raw.payload).via;
  ok("every write is stamped via:{app,function} in the ledger", via && via.app === "rsvpapp" && via.function === "rsvp");
  const feed = store.changesSince("rsvpapp", 0);
  ok("…and the stamp never reaches the AI-facing change feed", feed.events.every((e) => !("via" in e) && !("via" in (e.fields || {}))));

  // actor passthrough — the initiator's class rides onto the inner writes.
  const rh = call("rsvpapp", "rsvp", { name: "Kim", coming: true }, { actor: "human" });
  const rawH = store.db.prepare("SELECT actor FROM change_event WHERE event_type='item_added' AND aggregate_id=?").get(rh.writes[0].id);
  ok("a human-initiated call writes as human", rawH.actor === "human");
}

// ------------------------------------------------------------------ 5. fail-with-schema
console.log("5. refusals that TEACH — the retry needs no extra read");
{
  const r1 = call("rsvpapp", "rsvp", { name: 5 });
  ok("bad args name every violation", r1.error === "bad_args" && r1.violations.length === 2);
  ok("…and carry the declared params back", r1.params.name.type === "string");
  const r2 = call("rsvpapp", "rsvp", { name: "x", coming: true, extra: 1 });
  ok("an undeclared argument is a violation, not a silent drop", r2.error === "bad_args" && /not a declared parameter/.test(r2.violations[0]));
  const r3 = call("rsvpapp", "nope", {});
  ok("an unknown function answers with the roster", r3.error === "no_such_function" && r3.available.join(",") === "rsvp");
  ok("an unknown app is its own refusal", call("nope", "f", {}).error === "no_such_app");
  // The pre-W3 legacy edge: a manifest that declares what the document never carried (unknown
  // keys were once ignored at save) — the executor refuses what the door could not.
  save("legacy", doc(block("real", "return 1;")), { functions: { real: {} } });
  store.db.prepare("UPDATE app SET manifest=? WHERE name=?")
    .run(JSON.stringify({ functions: { real: {}, phantom: {} } }), "legacy");
  ok("a declared function whose body never existed refuses at call time",
    host.call({ app: "legacy", function: "phantom", args: {}, command_id: "cX" }).error === "function_body_missing");
}

// ------------------------------------------------------------------ 6. the walls
console.log("6. the walls — collections, settings, delete, and the sandbox's empty world");
{
  save("walls", doc(
    block("probe", `return { req: typeof require, proc: typeof process, fetch: typeof fetch, timer: typeof setTimeout };`),
    block("gen", `return new Function("return 1")();`),
    block("esc", `api.add({ collection: args.c, fields: { x: 1 } }); return 1;`),
    block("del", `api.delete({ id: "x" }); return 1;`),
    block("stew", `api.add({ collection: "wallsdata", fields: { x: 1 } }); return api.count("wallsdata");`)),
    { collections: { wallsdata: {} },
      functions: { probe: {}, gen: {}, esc: { params: { c: { type: "string", required: true } } }, del: {}, stew: {} } });
  const world = call("walls", "probe", {});
  ok("the sandbox world is empty — no require/process/fetch/timers",
    world.ok && Object.values(world.result).every((t) => t === "undefined"));
  ok("strings cannot become code (codeGeneration off)", call("walls", "gen", {}).error === "function_threw");
  const esc = call("walls", "esc", { c: "rsvpapp" });
  ok("another app's collection is out of reach", esc.error === "collection_not_allowed");
  ok("…and nothing was written on the way down", esc.writes.length === 0);
  ok("settings are walled even when stewarded-looking", call("walls", "esc", { c: "settings" }).error === "collection_not_allowed");
  ok("there is NO api.delete — destructive verbs keep the confirmation door", call("walls", "del", {}).error === "function_threw");
  const stew = call("walls", "stew", {});
  ok("a manifest-declared collection IS reachable (stewardship = scope)", stew.ok && stew.result === 1);
  // Membership pre-check: an id from another collection refuses before the write.
  save("cross", doc(block("hit", `api.update({ id: args.id, fields: { pwned: true } }); return 1;`)),
    { functions: { hit: { params: { id: { type: "string", required: true } } } } });
  const victim = store.snapshot("rsvpapp").items[0];
  const cr = call("cross", "hit", { id: victim.id });
  ok("an update aimed at a foreign row by guessed id refuses (not_found in OWN collection)",
    cr.error === "not_found" && store.snapshot("rsvpapp").items[0].fields.pwned === undefined);
}

// ------------------------------------------------------------------ 7. budgets
console.log("7. budgets — refusal at the line, honest about what landed");
{
  save("budget", doc(
    block("burn", `for (let i = 0; i < ${FN_WRITE_BUDGET + 5}; i++) api.add({ fields: { i } }); return 1;`),
    block("peek", `for (let i = 0; i < ${FN_READ_BUDGET + 5}; i++) api.count(); return 1;`),
    block("spin", `for (;;) {}`),
    block("bloat", `return "x".repeat(${MAX_FUNCTION_RESULT + 10});`),
    block("later", `return Promise.resolve(1);`),
    block("weird", `const a = {}; a.a = a; return a;`)),
    { functions: { burn: {}, peek: {}, spin: {}, bloat: {}, later: {}, weird: {} } });
  const b = call("budget", "burn", {});
  ok("the write budget refuses past its line", b.error === "write_budget_exceeded");
  ok("…and reports the writes that DID land", b.writes.length === FN_WRITE_BUDGET);
  ok("the read budget refuses past its line", call("budget", "peek", {}).error === "read_budget_exceeded");
  const t0 = Date.now();
  const s = call("budget", "spin", {});
  ok("an infinite loop dies at the time budget", s.error === "function_timeout" && s.limit_ms === FN_TIME_BUDGET_MS);
  ok("…in about that long, not forever", Date.now() - t0 < FN_TIME_BUDGET_MS + 1_500);
  ok("an oversized result refuses rather than truncates", call("budget", "bloat", {}).error === "result_too_large");
  ok("a returned thenable is an ERROR — bodies are synchronous, that is the whole time-budget story",
    call("budget", "later", {}).error === "async_not_supported");
  ok("an unserializable result is named", call("budget", "weird", {}).error === "unserializable_result");
}

// ------------------------------------------------------------------ 8. the seat is opt-in
console.log("8. the engine seat — present when asked, absent by default (hosted planes inherit nothing)");
{
  const { InMemoryTransport } = await import("@modelcontextprotocol/client");
  const { Client } = await import("@modelcontextprotocol/client");
  const list = async (engine) => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await engine.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const { tools } = await client.listTools();
    await client.close();
    return tools;
  };
  const withSeat = await list(createEngine(store, { functions: true }));
  const seat = withSeat.find((t) => t.name === "call_function");
  ok("functions:true registers call_function", !!seat);
  ok("…widget-callable on OpenAI hosts (the runner's free path needs the flag)",
    seat._meta && seat._meta["openai/widgetAccessible"] === true);
  // W5 (SEP-2243): the edge sees the INNER operation without parsing the body — behind the
  // dispatcher Mcp-Name only ever says "call_function", so these two params mirror into
  // Mcp-Param-App / Mcp-Param-Function. Header↔body verification (-32020) is the SDK's.
  ok("app and function carry x-mcp-header on the wire (edge routing vocabulary)",
    seat.inputSchema.properties.app["x-mcp-header"] === "App"
    && seat.inputSchema.properties.function["x-mcp-header"] === "Function");
  const without = await list(createEngine(store, {}));
  ok("a default engine has NO seat — same-process execution is never inherited",
    !without.some((t) => t.name === "call_function"));
  // …and the seat actually executes over the wire, envelope and all.
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createEngine(store, { functions: true }).connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  const r = await client.callTool({ name: "call_function", arguments: {
    command_id: "wire-1", app: "rsvpapp", function: "rsvp", args: { name: "Wire", coming: true } } });
  const sc = r.structuredContent;
  ok("the wire call runs the function and acks with receipts", sc.ok === true && sc.writes.length === 1 && sc.result.total >= 2);
  ok("…with the envelope's tail mark", sc.eot === "·eot");
  const bad = await client.callTool({ name: "call_function", arguments: {
    command_id: "wire-2", app: "rsvpapp", function: "rsvp", args: {} } });
  ok("a wire refusal is isError AND teaches the schema", bad.isError === true
    && bad.structuredContent.violations.length === 2 && /Declared params/.test(bad.content[0].text));
  await client.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
