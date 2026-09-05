// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/functions.mjs — the function pillar (W3), pinned end to end.
//
// What must stay true, forever:
//   1. The JOIN — a declared function with no body, or a body with no declaration, refuses the
//      SAVE. Silence in either direction is the failure mode the whole grammar exists to refuse.
//   2. The axiom — execution never depends on render state (everything here runs with no DOM
//      anywhere). Its former companion ("a body is synchronous, a returned thenable is an ERROR")
//      was retired 2026-08-16 when the body moved onto a worker thread: await is allowed, and the
//      time budget stayed real because terminate() is a harder stop than vm's timeout ever was.
//      Section 9 is the migration's own proof — the synchronous bodies above are UNCHANGED.
//   3. The §2.5-D list holds structurally: the sandbox sees args+api and a written-out capability
//      list and nothing else, budgets refuse past their line, inner command_ids derive from the
//      call's (idempotent retry), via:{app,function} is engine-stamped on every write and reaches
//      the raw ledger — but never the AI face.
//   4. The seat is OPT-IN: createEngine grows call_function only when asked (hosted planes must
//      never inherit same-process execution by accident).
//   5. A stuck body is ALWAYS a function_timeout and never the engine's problem: the deadline
//      terminates the thread, the process survives, and the next call is normal.
//
// Run: node test/functions.mjs

import { openStore, manifestShapeError } from "../src/store.mjs";
import { extractFunctionBodies, functionsJoinError, makeFunctionHost, runFunctionBody, FnAbort,
         FN_TIME_BUDGET_MS, FN_TIME_TIMER_MAX_MS, FN_WRITE_BUDGET, FN_READ_BUDGET,
         MAX_FUNCTION_RESULT, MAX_FUNCTIONS, MAX_CONCURRENT_FUNCTION_CALLS } from "../src/functions.mjs";
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
  // timeout_ms (2026-08-29): the OSS engine sets NO policy ceiling — the host's tool-call timeout
  // is the real limit. The save door keeps only a sanity floor: a positive integer the timer can
  // hold. The old "refused past 30 s" behavior is GONE; these assertions are its inverse, so they
  // go red against the code that clamped.
  ok("a declared timeout_ms passes (a plain positive integer)",
    manifestShapeError({ functions: { f: { timeout_ms: 500 } } }) === null);
  ok("a timeout_ms past the old 30 s ceiling now PASSES — there is no OSS ceiling",
    manifestShapeError({ functions: { f: { timeout_ms: 60_000 } } }) === null);
  ok("…and one all the way up to the timer's own bound passes too",
    manifestShapeError({ functions: { f: { timeout_ms: FN_TIME_TIMER_MAX_MS } } }) === null);
  // The sanity floor still refuses anything that is not a positive, schedulable integer.
  ok("zero is refused", /timeout_ms/.test(manifestShapeError({ functions: { f: { timeout_ms: 0 } } })));
  ok("a negative is refused", /timeout_ms/.test(manifestShapeError({ functions: { f: { timeout_ms: -5 } } })));
  ok("a fractional timeout_ms is refused (milliseconds are whole)",
    /timeout_ms/.test(manifestShapeError({ functions: { f: { timeout_ms: 1.5 } } })));
  ok("a non-number is refused", /timeout_ms/.test(manifestShapeError({ functions: { f: { timeout_ms: "x" } } })));
  ok("Infinity and NaN are refused (neither is a schedulable integer)",
    /timeout_ms/.test(manifestShapeError({ functions: { f: { timeout_ms: Infinity } } })) &&
    /timeout_ms/.test(manifestShapeError({ functions: { f: { timeout_ms: NaN } } })));
  ok("past the timer's 32-bit bound is refused (setTimeout would silently re-arm at 1 ms)",
    /timeout_ms/.test(manifestShapeError({ functions: { f: { timeout_ms: FN_TIME_TIMER_MAX_MS + 1 } } })));
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
  const r1 = await call("rsvpapp", "rsvp", { name: "Sam", coming: true });
  ok("first call adds and returns the body's value", r1.ok && r1.result.total === 1 && r1.writes[0].op === "add_item");
  const r2 = await call("rsvpapp", "rsvp", { name: "Sam", coming: false });
  ok("second call takes the update path", r2.ok && r2.writes[0].op === "update_item");
  ok("…onto the same row", r2.writes[0].id === r1.writes[0].id);
  const rows = store.snapshot("rsvpapp").items;
  ok("the data is really there", rows.length === 1 && rows[0].fields.coming === false);

  // Idempotent retry: same command_id ⇒ derived inner ids replay into the ledger's dedup.
  const again = await host.call({ app: "rsvpapp", function: "rsvp", args: { name: "Sam", coming: false }, actor: "agent", host: "test", command_id: "c" + cmdN });
  ok("a retried call marks its writes idempotent instead of writing twice",
    again.ok && again.writes[0].idempotent === true && store.snapshot("rsvpapp").items.length === 1);

  // via:{app,function} — engine-stamped, raw-ledger visible, AI-face invisible (row #8).
  const raw = store.db.prepare("SELECT payload FROM change_event WHERE event_type='item_added' AND aggregate_id=?").get(r1.writes[0].id);
  const via = JSON.parse(raw.payload).via;
  ok("every write is stamped via:{app,function} in the ledger", via && via.app === "rsvpapp" && via.function === "rsvp");
  const feed = store.changesSince("rsvpapp", 0);
  ok("…and the stamp never reaches the AI-facing change feed", feed.events.every((e) => !("via" in e) && !("via" in (e.fields || {}))));

  // actor passthrough — the initiator's class rides onto the inner writes.
  const rh = await call("rsvpapp", "rsvp", { name: "Kim", coming: true }, { actor: "human" });
  const rawH = store.db.prepare("SELECT actor FROM change_event WHERE event_type='item_added' AND aggregate_id=?").get(rh.writes[0].id);
  ok("a human-initiated call writes as human", rawH.actor === "human");
}

// ------------------------------------------------------------------ 5. fail-with-schema
console.log("5. refusals that TEACH — the retry needs no extra read");
{
  const r1 = await call("rsvpapp", "rsvp", { name: 5 });
  ok("bad args name every violation", r1.error === "bad_args" && r1.violations.length === 2);
  ok("…and carry the declared params back", r1.params.name.type === "string");
  const r2 = await call("rsvpapp", "rsvp", { name: "x", coming: true, extra: 1 });
  ok("an undeclared argument is a violation, not a silent drop", r2.error === "bad_args" && /not a declared parameter/.test(r2.violations[0]));
  const r3 = await call("rsvpapp", "nope", {});
  ok("an unknown function answers with the roster", r3.error === "no_such_function" && r3.available.join(",") === "rsvp");
  ok("an unknown app is its own refusal", (await call("nope", "f", {})).error === "no_such_app");
  // The pre-W3 legacy edge: a manifest that declares what the document never carried (unknown
  // keys were once ignored at save) — the executor refuses what the door could not.
  save("legacy", doc(block("real", "return 1;")), { functions: { real: {} } });
  store.db.prepare("UPDATE app SET manifest=? WHERE name=?")
    .run(JSON.stringify({ functions: { real: {}, phantom: {} } }), "legacy");
  ok("a declared function whose body never existed refuses at call time",
    (await host.call({ app: "legacy", function: "phantom", args: {}, command_id: "cX" })).error === "function_body_missing");
}

// ------------------------------------------------------------------ 6. the walls
console.log("6. the walls — collections, settings, delete, and the sandbox's empty world");
{
  save("walls", doc(
    block("probe", `return { req: typeof require, proc: typeof process, mod: typeof module, glob: typeof global,
                             wd: typeof workerData, buf: typeof Buffer,
                             fetch: typeof fetch, timer: typeof setTimeout,
                             si: typeof setInterval, qm: typeof queueMicrotask, sc: typeof structuredClone };`),
    block("gen", `return new Function("return 1")();`),
    block("esc", `api.add({ collection: args.c, fields: { x: 1 } }); return 1;`),
    block("del", `api.delete({ id: "x" }); return 1;`),
    block("stew", `api.add({ collection: "wallsdata", fields: { x: 1 } }); return api.count("wallsdata");`)),
    { collections: { wallsdata: {} },
      functions: { probe: {}, gen: {}, esc: { params: { c: { type: "string", required: true } } }, del: {}, stew: {} } });
  const world = await call("walls", "probe", {});
  // CHANGED 2026-08-16 (worker executor): fetch and timers are now IN the sandbox, on purpose and
  // by an explicit list. What must stay out is Node itself — the worker's module scope, its
  // process, its globals. "Everything is undefined" was the old shape of this check; the new shape
  // has to name the halves separately or it stops checking anything. (`console` is contextified by
  // vm itself, before and after, and measurably writes to neither stream — 0 bytes on stdout, 0 on
  // stderr — so it is neither a capability nor a leak, and is not listed either way.)
  ok("the sandbox has NO Node — no require, process, module, global, workerData, Buffer",
    world.ok && ["req", "proc", "mod", "glob", "wd", "buf"].every((k) => world.result[k] === "undefined"));
  ok("…and DOES have the declared capability list — fetch and timers are named, not inherited",
    world.result.fetch === "function" && world.result.timer === "function");
  ok("…and the list is a LIST, not a filter: setInterval/queueMicrotask/structuredClone are absent",
    ["si", "qm", "sc"].every((k) => world.result[k] === "undefined"));
  ok("strings cannot become code (codeGeneration off)", (await call("walls", "gen", {})).error === "function_threw");
  const esc = await call("walls", "esc", { c: "rsvpapp" });
  ok("another app's collection is out of reach", esc.error === "collection_not_allowed");
  ok("…and nothing was written on the way down", esc.writes.length === 0);
  ok("settings are walled even when stewarded-looking", (await call("walls", "esc", { c: "settings" })).error === "collection_not_allowed");
  ok("there is NO api.delete — destructive verbs keep the confirmation door", (await call("walls", "del", {})).error === "function_threw");
  const stew = await call("walls", "stew", {});
  ok("a manifest-declared collection IS reachable (stewardship = scope)", stew.ok && stew.result === 1);
  // Membership pre-check: an id from another collection refuses before the write.
  save("cross", doc(block("hit", `api.update({ id: args.id, fields: { pwned: true } }); return 1;`)),
    { functions: { hit: { params: { id: { type: "string", required: true } } } } });
  const victim = store.snapshot("rsvpapp").items[0];
  const cr = await call("cross", "hit", { id: victim.id });
  ok("an update aimed at a foreign row by guessed id refuses (not_found in OWN collection)",
    cr.error === "not_found" && store.snapshot("rsvpapp").items[0].fields.pwned === undefined);

  // THE IMPLICIT COLLECTION IS THE BOUND ONE — the same collection the app's WIDGET opens on.
  // It used to be the app's NAME, unconditionally, so an app that declared exactly one collection
  // had its function reading an empty one while its widget showed rows. Silent, because the app
  // name is in the allowed set: the read succeeded and found nothing.
  save("bound", doc(
    block("mine", `return { implicit: api.count(), explicit: api.count("bounddata") };`),
    block("write", `api.add({ fields: { x: 1 } }); return api.count();`)),
    { collections: { bounddata: {} }, functions: { mine: {}, write: {} } });
  store.execute({ type: "add_item", command_id: "b1", collection: "bounddata",
    fields: { seeded: true }, actor: "agent" });
  const b = await call("bound", "mine", {});
  ok("api.count() with no argument reads the app's DECLARED collection, not its name",
    b.ok && b.result.implicit === 1 && b.result.explicit === 1, JSON.stringify(b));
  const bw = await call("bound", "write", {});
  ok("…and a write with no collection lands in the same one the widget reads",
    bw.ok && bw.result === 2 && store.snapshot("bounddata").items.length === 2
      && store.snapshot("bound").items.length === 0, JSON.stringify(bw));
  // Two declared collections = no "the" collection to pick, so the name stays the default —
  // the same rule defaultCollectionFor states for the widget, reached through one function.
  save("ambig", doc(block("mine", `api.add({ fields: { x: 1 } }); return api.count();`)),
    { collections: { one: {}, two: {} }, functions: { mine: {} } });
  const am = await call("ambig", "mine", {});
  ok("an AMBIGUOUS declaration still defaults to the app's name (one rule, both faces)",
    am.ok && am.result === 1 && store.snapshot("ambig").items.length === 1, JSON.stringify(am));
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
  const b = await call("budget", "burn", {});
  ok("the write budget refuses past its line", b.error === "write_budget_exceeded");
  ok("…and reports the writes that DID land", b.writes.length === FN_WRITE_BUDGET);
  ok("the read budget refuses past its line", (await call("budget", "peek", {})).error === "read_budget_exceeded");
  const t0 = Date.now();
  const s = await call("budget", "spin", {});
  ok("an infinite loop dies at the time budget", s.error === "function_timeout" && s.limit_ms === FN_TIME_BUDGET_MS);
  ok("…in about that long, not forever", Date.now() - t0 < FN_TIME_BUDGET_MS + 1_500);
  ok("an oversized result refuses rather than truncates", (await call("budget", "bloat", {})).error === "result_too_large");
  // CHANGED 2026-08-16 (worker executor): async_not_supported is GONE. A returned promise is
  // awaited, because the deadline no longer depends on the body staying on one stack.
  const later = await call("budget", "later", {});
  ok("a returned thenable is AWAITED, not refused — async_not_supported no longer exists",
    later.ok === true && later.result === 1);
  ok("an unserializable result is named", (await call("budget", "weird", {})).error === "unserializable_result");
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
  // Same-body doctrine (test/two-channel.mjs): claude.ai hands the model content[].text ONLY, so a
  // return value that lived in structuredContent alone was invisible there (measured 2026-09-02).
  ok("the return value rides the text channel too", r.content[0].text.includes(JSON.stringify(sc.result)));
  const bad = await client.callTool({ name: "call_function", arguments: {
    command_id: "wire-2", app: "rsvpapp", function: "rsvp", args: {} } });
  ok("a wire refusal is isError AND teaches the schema", bad.isError === true
    && bad.structuredContent.violations.length === 2 && /Declared params/.test(bad.content[0].text));
  await client.close();
}

// ------------------------------------------------------------------ 9. the worker executor
// Everything above this line is the pillar as it shipped, running UNCHANGED on the new executor —
// that is the migration's whole claim, and sections 1–8 are its evidence. This section is what the
// thread bought (await, fetch, a declared deadline, real concurrency) and what it must never cost
// (a stuck body taking the process with it).
console.log("9. the worker executor — await, fetch, a deadline that terminates, and a process that survives");
{
  const { createServer } = await import("node:http");

  save("worker", doc(
    block("topawait", `const a = await Promise.resolve(args.n);
                       const b = await new Promise((r) => setTimeout(() => r(a * 2), 5));
                       return { doubled: b, sync: api.count() };`),
    block("net", `const res = await fetch(args.url + "/thing?q=" + encodeURIComponent(args.q));
                  const body = await res.json();
                  api.add({ fields: { got: body.echo } });
                  return { status: res.status, echo: body.echo, rows: api.count() };`),
    block("hang", `api.add({ fields: { marker: "landed-before-the-hang" } });
                   await new Promise(() => {});
                   return "unreachable";`),
    block("napper", `await new Promise((r) => setTimeout(r, 30_000)); return "unreachable";`),
    block("slow", `await new Promise((r) => setTimeout(r, 120)); return args.n;`),
    block("keys", `return api.secret("openai_api_key");`)),
    { functions: {
      topawait: { params: { n: { type: "number", required: true } } },
      net: { params: { url: { type: "string", required: true }, q: { type: "string", required: true } } },
      hang: { timeout_ms: 600 },
      napper: { timeout_ms: 400 },
      slow: { params: { n: { type: "number", required: true } } },
      keys: {},
    } });

  // (b) a body may await at its top level, and `api` is still synchronous next to it.
  const ta = await call("worker", "topawait", { n: 21 });
  ok("a body may await at its top level, and its resolved value is the result",
    ta.ok && ta.result.doubled === 42 && typeof ta.result.sync === "number");

  // (c) …and the await that matters is the network one. A real socket, a real server, this process.
  const server = createServer((req, res) => {
    const q = new URL(req.url, "http://x").searchParams.get("q");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ echo: q.toUpperCase() }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const net = await call("worker", "net", { url: base, q: "hello" });
  ok("a body can await fetch() against a real server and use what came back",
    net.ok && net.result.status === 200 && net.result.echo === "HELLO");
  ok("…and the fetched value went through the store on the same call",
    net.writes.length === 1 && store.snapshot("worker").items.some((i) => i.fields.got === "HELLO"));
  server.close();

  // (e)+(f)+(g) a body that parks on a promise nothing will settle is ended by the DECLARED
  // deadline — and the write it made first is still receipted, because a function's writes commit
  // one at a time and always did. There is no rollback here and never was one.
  const t0 = Date.now();
  const hung = await call("worker", "hang", {});
  const hungMs = Date.now() - t0;
  ok("a body awaiting a promise that never settles dies at its deadline",
    hung.error === "function_timeout" && hung.limit_ms === 600);
  ok("…at the DECLARED limit, not the default", 600 !== FN_TIME_BUDGET_MS && hungMs < 600 + 1_500);
  ok("…and the write that landed before the hang is in the receipt",
    hung.writes.length === 1 && hung.writes[0].op === "add_item");
  ok("…and is really in the store (nothing was rolled back)",
    store.snapshot("worker").items.some((i) => i.fields.marker === "landed-before-the-hang"));

  // The other shape of stuck: parked on a timer far past the deadline. terminate() takes the
  // timer with the thread — this is the cancel vm never had.
  const t1 = Date.now();
  const nap = await call("worker", "napper", {});
  ok("a body parked on a 30 s timer dies at its 400 ms deadline",
    nap.error === "function_timeout" && nap.limit_ms === 400 && Date.now() - t1 < 1_900);

  // (d, second half) the process survived all of that, and the next call is ordinary.
  const after = await call("worker", "topawait", { n: 1 });
  ok("…and the very next call runs normally (the process never noticed)", after.ok && after.result.doubled === 2);

  // (h) more calls in flight than there are slots: the queue holds them, nothing is dropped, and
  // every answer belongs to its own call.
  const n = MAX_CONCURRENT_FUNCTION_CALLS + 2;
  const t2 = Date.now();
  const all = await Promise.all(Array.from({ length: n }, (_, i) => call("worker", "slow", { n: i })));
  ok(`${n} concurrent calls (cap ${MAX_CONCURRENT_FUNCTION_CALLS}) all complete, each with its OWN answer`,
    all.length === n && all.every((r, i) => r.ok && r.result === i));
  console.log(`      · ${n} concurrent calls in ${Date.now() - t2} ms`);

  // (j) keys are RESERVED, in all three places, with one sentence.
  const sec = await call("worker", "keys", {});
  ok("api.secret exists and refuses — the name is reserved before the feature exists",
    sec.error === "secrets_not_available" && /viewer settings UI/.test(sec.detail));
  const plainSecret = store.execute({ type: "add_item", command_id: "sec1", collection: "settings",
    fields: { key: "secret:openai_api_key", value: "sk-live-nope" }, actor: "agent" });
  ok("a generic write to a secret: settings key is refused, and says why",
    plainSecret.error === "reserved_key" && /viewer settings UI/.test(plainSecret.detail));
  const privSecret = store.executePrivileged({ type: "add_item", command_id: "sec2", collection: "settings",
    fields: { key: "secret:openai_api_key", value: "sk-live-nope" }, actor: "human" });
  ok("…and the PRIVILEGED writer is refused too — security:* has a writer, secret:* has none",
    privSecret.error === "reserved_key");
  ok("…so nothing squatted the namespace",
    !store.snapshot("settings").items.some((i) => String(i.fields.key || "").startsWith("secret:")));

  // The measurement the deadline numbers rest on: what one worker costs, start to stop.
  const t3 = Date.now();
  await call("rsvpapp", "rsvp", { name: "Timing", coming: true });
  console.log(`      · one whole call (worker start → body → terminate): ${Date.now() - t3} ms`);
  ok("one worker's start-to-stop cost is a rounding error next to the deadline",
    Date.now() - t3 < FN_TIME_BUDGET_MS / 10);
}

// ------------------------------------------------------------------ 10. the secret: wall on the wire
console.log("10. secret: on the tool face — refused by the privileged writer, in its own words");
{
  const { InMemoryTransport, Client } = await import("@modelcontextprotocol/client");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createEngine(store, { functions: true }).connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  const denied = await client.callTool({ name: "security_set", arguments: {
    key: "secret:openai_api_key", value: "sk-live-nope", command_id: "sec-wire-1" } });
  ok("security_set refuses a secret: key BEFORE its reserved-key gate would have let it through",
    denied.isError === true && /viewer settings UI/.test(denied.content[0].text));
  const allowed = await client.callTool({ name: "security_set", arguments: {
    key: "security:walls:send_message", value: "deny", command_id: "sec-wire-2" } });
  ok("…and the door it guards still opens for the keys it was built for",
    allowed.isError !== true);
  await client.close();
}

// ------------------------------------------------------------------ 10. discovery
console.log("10. discovery — list_apps carries the COUNT, and only when there is one");
{
  // R5 (Leo, 2026-08-16): "\u4e0d\u5982\u53ea\u7b80\u5355\u7684\u8bf4\u4e00\u4e0b\u6709 n \u4e2a function \u5982\u679c\u6709\u5fc5\u8981 ai \u518d\u5355\u72ec\u53d1\u73b0" — the registry
  // listing says HOW MANY, never which; the names are one get_app {slot:"manifest"} away. The
  // negative half matters as much as the positive one: an app with no functions must look exactly
  // as it did before this field existed, or every registry pays for a feature it does not use.
  const { InMemoryTransport, Client } = await import("@modelcontextprotocol/client");
  ok("a two-function app saves", save("twofn",
    doc(block("alpha", "return 1;"), block("beta", "return 2;")),
    { functions: { alpha: {}, beta: {} } }).ok === true);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createEngine(store, {}).connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  // Exact-name lookup: it bypasses the browsing defaults, so these rows are about the field and
  // not about kind/visibility filtering.
  const rowOf = async (name) => {
    const r = await client.callTool({ name: "list_apps", arguments: { name } });
    return { row: r.structuredContent.apps[0], text: r.content[0].text };
  };
  const two = await rowOf("twofn");
  ok("the row reports the DECLARED count", two.row.functions === 2, JSON.stringify(two.row));
  ok("\u2026and the text line says it where the model actually reads", / \u00b7 2 functions/.test(two.text), two.text);
  const one = await rowOf("rsvpapp");
  ok("one function reads as \"1 function\", not \"1 functions\"",
    one.row.functions === 1 && /\u00b7 1 function(?!s)/.test(one.text), one.text);
  const none = await rowOf("plain");
  ok("an app declaring NO function carries no key at all — absence, not 0",
    !("functions" in none.row) && !("fn_count" in none.row), JSON.stringify(none.row));
  ok("\u2026and its line says nothing about functions", !/function/.test(none.text), none.text);
  await client.close();
}

// ------------------------------------------------------------------ 11. the seat's two seams
// 0.6.1 (gateway wave). The seat grew from a boolean into `false | true | {egress?, executor?}`,
// and both new members are SEAMS rather than policy: `egress` says who the body's fetch talks to,
// `executor` says where the body runs. The engine ships neither an allowlist nor a protocol — what
// is pinned here is that the seam is honoured exactly, because a hosted plane's whole containment
// story hangs off these two shapes being what it was told they are.
console.log("11. the egress seam — the body's fetch, pointed at somebody else's gateway");
{
  const http = await import("node:http");
  const seen = [];
  let mode = "ok";
  const gw = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers,
                  body: Buffer.concat(chunks).toString("utf-8") });
      if (mode === "deny") {
        res.writeHead(403, { "content-type": "text/plain", "X-Egress-Error": "host_not_allowed" });
        res.end("api.example.test is not on this workspace's allowlist");
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("upstream said hi");
      }
    });
  });
  await new Promise((r) => gw.listen(0, "127.0.0.1", r));
  const gateway = `http://127.0.0.1:${gw.address().port}`;
  const egress = { gateway, token: "tok-tenant-42" };
  const egressHost = makeFunctionHost(store, { egress });
  const eCall = (fn, args = {}) => egressHost.call({ app: "fnegress", function: fn, args,
    actor: "agent", host: "test", command_id: "e" + ++cmdN });

  save("fnegress", doc(
    block("out", `const r = await fetch("https://example.test/x", { method: "POST",
                    headers: { Authorization: "Bearer u" }, body: "hi" });
                  return await r.text();`),
    // The wrapper must be BOTH places: the sandbox object is what a well-behaved body sees, and
    // the worker realm's globalThis is what an escaped one sees. `api.list.constructor` is the
    // documented escape (functions.mjs header: a host function carries its own realm back out),
    // so this reads the far side of the vm seam and compares it to the near side.
    block("both", `const escaped = api.list.constructor("return globalThis.fetch")();
                   return { inside: globalThis.fetch === fetch, realm: escaped === fetch };`),
    block("rel", `try { await fetch("/relative"); return "no throw"; }
                  catch (e) { return e.constructor.name + ": " + e.message.slice(0, 20); }`),
    block("stomp", `const r = await fetch("https://example.test/y",
                      { headers: { "X-Egress-Token": "forged", "X-Egress-Url": "https://evil.test" } });
                    return await r.text();`)),
    { functions: { out: {}, both: {}, rel: {}, stomp: {} } });

  const out = await eCall("out");
  ok("a body's fetch reaches the GATEWAY, not the internet", out.ok && out.result === "upstream said hi",
    JSON.stringify(out));
  const hit = seen[seen.length - 1];
  ok("…on the gateway's one path", hit && hit.url === "/egress", hit && hit.url);
  ok("…carrying the absolute target as X-Egress-Url",
    hit.headers["x-egress-url"] === "https://example.test/x", hit.headers["x-egress-url"]);
  ok("…and the tenant token as X-Egress-Token", hit.headers["x-egress-token"] === "tok-tenant-42");
  ok("…while the body's OWN Authorization rides through untouched (it is the target api's, not the gateway's)",
    hit.headers["authorization"] === "Bearer u", hit.headers["authorization"]);
  ok("…with the method and body the body asked for", hit.method === "POST" && hit.body === "hi",
    `${hit.method} ${JSON.stringify(hit.body)}`);

  const stomp = await eCall("stomp");
  const stompHit = seen[seen.length - 1];
  ok("a body that writes the gateway's own headers is OVERWRITTEN, never trusted",
    stomp.ok && stompHit.headers["x-egress-token"] === "tok-tenant-42"
      && stompHit.headers["x-egress-url"] === "https://example.test/y",
    JSON.stringify({ t: stompHit.headers["x-egress-token"], u: stompHit.headers["x-egress-url"] }));

  mode = "deny";
  const denied = await eCall("out");
  ok("a refusal reaches the body as a REJECTED fetch, carrying the gateway's code",
    denied.error === "function_threw" && denied.detail.startsWith("egress_denied: host_not_allowed"),
    JSON.stringify(denied));
  mode = "ok";

  const both = await eCall("both");
  ok("the wrapper is on the sandbox's fetch AND the worker realm's globalThis (a vm escape sees the same one)",
    both.ok && both.result.inside === true && both.result.realm === true, JSON.stringify(both));
  const rel = await eCall("rel");
  ok("a relative url is a TypeError — a function body has no page to resolve one against",
    rel.ok && /^TypeError: fetch/.test(rel.result), JSON.stringify(rel));

  // The control: with NO egress seat the fetch is the platform's, so the gateway never hears from
  // it. (It fails to connect — example.test does not resolve — and that failure is the point.)
  const plainHost = makeFunctionHost(store);
  const before = seen.length;
  await plainHost.call({ app: "fnegress", function: "out", args: {}, actor: "agent", host: "test",
                         command_id: "e" + ++cmdN });
  ok("…and with no egress seat, nothing is rewritten: the gateway hears nothing", seen.length === before);
  await new Promise((r) => gw.close(r));
}

console.log("12. the executor seam — where a body runs is the host's to choose; the ledger is not");
{
  save("fnexec", doc(block("noop", "return 1;")), { functions: { noop: {} } });
  let got = null;
  const runElsewhere = async (arg) => {
    got = arg;
    // A remote executor's dispatch is a network hop on the far side; here it is just async, which
    // is the property the parent's message pump had to grow to tolerate.
    const rows = await arg.dispatch("list", { opts: { collection: "fnexec" } });
    return { kind: "value", json: JSON.stringify({ ran: "elsewhere", rows: rows.length, body: arg.body.trim() }) };
  };
  const egress = { gateway: "http://gw.invalid", token: "t" };
  const host2 = makeFunctionHost(store, { executor: runElsewhere, egress });
  store.execute({ type: "add_item", command_id: "x-exec-1", collection: "fnexec", fields: { a: 1 }, actor: "agent" });
  const r = await host2.call({ app: "fnexec", function: "noop", args: {}, actor: "agent", host: "test", command_id: "x1" });
  ok("the executor REPLACES the worker — its value is the call's value",
    r.ok && r.result.ran === "elsewhere" && r.result.rows === 1, JSON.stringify(r));
  ok("…and it is handed the whole call: body, app, fn, args, limitMs, dispatch, egress",
    got && got.body.trim() === "return 1;" && got.app === "fnexec" && got.fn === "noop"
      && typeof got.args === "object" && typeof got.limitMs === "number"
      && typeof got.dispatch === "function" && got.egress === egress,
    JSON.stringify({ ...got, dispatch: typeof got.dispatch }));

  // The receipt is the PARENT's. An executor reports the FACT of an abort and nothing else — a
  // shape that crossed a wire is a shape the far side could have authored, so the engine reads the
  // refusal it minted itself on the way out of dispatch.
  const refuser = async ({ dispatch }) => {
    try { await dispatch("add", { row: { collection: "rsvpapp", fields: { x: 1 } } }); }
    catch { return { kind: "abort" }; }
    return { kind: "value", json: "null" };
  };
  const host3 = makeFunctionHost(store, { executor: refuser });
  const ab = await host3.call({ app: "fnexec", function: "noop", args: {}, actor: "agent", host: "test", command_id: "x2" });
  ok("a store refusal through the seam is still the store's own answer, with the parent's receipt",
    ab.ok === false && ab.error === "collection_not_allowed"
      && ab.receipt && ab.receipt.collection === "rsvpapp", JSON.stringify(ab));
  // …and an executor that CLAIMS an abort no dispatch ever made cannot mint one.
  const liar = makeFunctionHost(store, { executor: async () => ({ kind: "abort" }) });
  const lie = await liar.call({ app: "fnexec", function: "noop", args: {}, actor: "agent", host: "test", command_id: "x3" });
  ok("…and an abort nobody asked for is named as the lie it is",
    lie.ok === false && lie.error === "function_threw" && /never happened/.test(lie.detail), JSON.stringify(lie));
}

console.log("12a. a refusal is read by SHAPE — a dispatch that crossed a wire has no class to throw");
{
  // The far half of the same seam. `executor` moves where a body runs; the thing it is handed —
  // `dispatch` — can be moved just as far, and then the refusal that comes back is rebuilt from
  // whatever crossed the socket. `instanceof FnAbort` cannot answer for that object (wrong realm,
  // or simply a plain one), so the duck test is what decides: a `receipt` carrying the store's own
  // word. Driven against `runFunctionBody` DIRECTLY, because that is the seam's own contract.
  const remoteish = await runFunctionBody({
    body: "return api.count('anything');", app: "fnexec", fn: "noop", args: {}, limitMs: 5_000,
    // Not a FnAbort, not an Error, no prototype in common with anything in src/ — the shape only.
    dispatch: () => { throw { receipt: { ok: false, error: "collection_not_allowed", collection: "elsewhere" } }; },
  });
  ok("a plain object carrying {receipt:{error}} aborts the call, class or no class",
    remoteish.kind === "abort", JSON.stringify(remoteish));
  // The control: without it the assertion above would pass on any throw at all, since a body that
  // throws is also a tagged outcome. A refusal and a bug must not arrive under the same tag.
  const plainThrow = await runFunctionBody({
    body: "return api.count('anything');", app: "fnexec", fn: "noop", args: {}, limitMs: 5_000,
    dispatch: () => { throw new Error("the far side fell over"); },
  });
  ok("…while an ordinary throw is still `threw`, not an abort (so the shape is what answered)",
    plainThrow.kind === "threw" && /fell over/.test(plainThrow.detail), JSON.stringify(plainThrow));
  // And the class is on the export map, for the callers that CAN hold it: a host writing its own
  // dispatch in this process should not have to reverse-engineer the shape from this test.
  const classy = await runFunctionBody({
    body: "return api.count('anything');", app: "fnexec", fn: "noop", args: {}, limitMs: 5_000,
    dispatch: () => { throw new FnAbort({ ok: false, error: "write_budget_exceeded", limit: 1 }); },
  });
  ok("`FnAbort` is exported and still the first arm", classy.kind === "abort", JSON.stringify(classy));
}

console.log("13. the seat's SHAPE — a malformed one throws rather than degrading to same-process");
{
  const bad = (opt) => { try { createEngine(store, { functions: opt }); return null; }
                         catch (e) { return e; } };
  ok("a string seat is refused", bad("yes") instanceof TypeError);
  ok("an array seat is refused", bad([]) instanceof TypeError);
  ok("egress without a gateway is refused (the failure it prevents is silent open egress)",
    bad({ egress: { token: "t" } }) instanceof TypeError);
  ok("egress without a token is refused", bad({ egress: { gateway: "https://gw.example" } }) instanceof TypeError);
  ok("a gateway that is not an http(s) origin is refused",
    bad({ egress: { gateway: "gw.example", token: "t" } }) instanceof TypeError);
  ok("a non-function executor is refused", bad({ executor: "run it" }) instanceof TypeError);
  ok("…while the shapes that mean something do NOT throw",
    bad(true) === null && bad(false) === null && bad({}) === null
      && bad({ egress: { gateway: "https://gw.example", token: "t" }, executor: async () => ({ kind: "value", json: "null" }) }) === null);
}

console.log("14. the guide follows the SEAT — no host teaches a tool it does not register");
{
  const { InMemoryTransport, Client } = await import("@modelcontextprotocol/client");
  const chapter = async (functions, topic) => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createEngine(store, { functions }).connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const r = await client.callTool({ name: "get_app_guide", arguments: topic ? { topic } : {} });
    await client.close();
    return r.content[0].text;
  };
  const off = await chapter(false, "functions");
  ok("seat OFF: the functions chapter never names the tool that is not there",
    !/call_function/.test(off) && /not available on this host/.test(off), off.slice(0, 200));
  ok("…and it still says what the save door DOES with a declaration (validated and stored, never run)",
    /NOT rejected/.test(off) && /never run/.test(off));
  const on = await chapter(true, "functions");
  ok("seat ON: the chapter teaches the real dispatcher", /call_function \{app, function/.test(on));
  ok("…and says nothing about a gateway when there is none", !/egress_denied/.test(on));
  const eg = await chapter({ egress: { gateway: "https://gw.example", token: "t" } }, "functions");
  ok("seat ON with egress: the chapter warns that out-of-allowlist fetches reject",
    /egress_denied/.test(eg), eg.slice(-600));
  const basicsOff = await chapter(false);
  ok("the basics directory line follows too — it does not point at a chapter for a missing pillar",
    !/\{topic: "functions"\} — exposing/.test(basicsOff) && /no functions on this host/.test(basicsOff));
  // 25,900: the same gate server-smoke states, moved by the same mechanical amount and for the
  // same reason — the seven verb-leading renames made several names the chapter mentions longer.
  ok("…and basics stays under its byte gate on both seats", basicsOff.length < 25_900
    && (await chapter(true)).length < 25_900, `off is ${basicsOff.length}`);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
