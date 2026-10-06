// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/sharing.mjs — cross-account sharing, the ENGINE half end to end (docs/sharing-design-2026-10-02.md
// §9 S2): three real stores (leo owns, leif receives, mia shares with someone else), the in-memory
// grant records test/rig/fake-sharing.mjs, and every tool driven through a real MCP client.
//
// The core of it is a MATRIX: every tool that takes a collection, an app or an id × every shape a
// handle can take (granted, a collection the owner keeps but did not share, one that does not exist,
// another account's alias, and the malformed ones: traversal, case, settings, a homoglyph, padding,
// empty segments) × both roles. For anything not granted the bar is twofold — refused, AND refused in
// the SAME words as a handle that names nothing (an answer that differs is an oracle) — and not one
// byte of any of the three stores may move.
// Run: node test/sharing.mjs
import { rmSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncResource } from "node:async_hooks";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createEngine } from "../src/engine.mjs";
import { openStore } from "../src/store.mjs";
import * as storeMod from "../src/store.mjs";
import { openFileChannel } from "../src/files.mjs";
import { makeGuard } from "../src/runner.mjs";
import { parseHandle } from "../src/sharing.mjs";
import { makeShareWorld } from "./rig/fake-sharing.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, "test", "sharing-tmp");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + String(note).slice(0, 600) : ""))));
const cid = () => randomUUID();
const b64 = (s) => Buffer.from(s).toString("base64");
const textOf = (r) => (r?.content || []).map((c) => c.text || "").join("\n");
const reasonOf = (r) => r?.structuredContent?.reason;

// ── three accounts, three stores ─────────────────────────────────────────────────────────────
const leo = openStore(join(TMP, "leo", "store.db"));
const leif = openStore(join(TMP, "leif", "store.db"));
const mia = openStore(join(TMP, "mia", "store.db"));
const CLOSE = "</" + "script>";
const save = (store, name, manifest, ui = `<!doctype html><p>${name}</p><script>oma.onChange(()=>{})${CLOSE}`) => {
  const cur = store.getApp(name);
  return store.execute({ type: "save_app", command_id: cid(), name, ui, ...(manifest !== undefined ? { manifest } : {}), actor: "agent", ...(cur ? { expected_version: cur.version } : {}) });
};
const add = (store, collection, fields) => store.execute({ type: "add_item", command_id: cid(), collection, fields, actor: "agent" });
save(leo, "trip-planner", { collections: { trips: {} } });
const finSaved = save(leo, "finance-app", { collections: { finances: {} }, functions: { total: {} } }, `<!doctype html><p>f</p><script type="text/oma-function" data-fn="total">return 1;${CLOSE}`);
if (!finSaved.ok) throw new Error(`fixture: ${JSON.stringify(finSaved)}`);
const trip1 = add(leo, "trips", { city: "Oslo", hotel: "Thon" });
const fin1 = add(leo, "finances", { amount: 9000, note: "salary" });
const leoFiles = openFileChannel(leo);
await leoFiles.put("trip-planner", "map.png", "trip-bytes", { mime: "image/png" });
await leoFiles.put("finance-app", "ledger.csv", "secret-bytes", { mime: "text/csv" });
save(mia, "notes-app", { collections: { notes: {} } });
add(mia, "notes", { text: "mia's private note" });
// leif has a collection literally called "trips" of his own — a bare name must only ever find it.
const leifTrip = add(leif, "trips", { city: "Leif's own" });
save(leif, "my-board", null);

const world = makeShareWorld();
world.addAccount("u_leo", "leo@example.com", leo);
world.addAccount("u_leif", "leif@example.com", leif);
world.addAccount("u_mia", "mia@example.com", mia);
world.grant("u_leo", "u_leif", "trip-planner", "editor");
world.grant("u_mia", "u_leo", "notes-app", "viewer");   // mia shares with LEO — never with leif
const leifGrant = world.grants.find((g) => g.recipient === "u_leif");

async function connect(store, principal, { clientName = "chatgpt", functions = false, providers = true } = {}) {
  const a = world.accounts.get(principal);
  const server = createEngine(store, {
    dynamicTools: false, functions,
    ...(providers ? { caller: { principal, label: a.label }, mounts: world.mountsFor(principal), sharing: world.sharingFor(principal) } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: clientName, version: "1.0.0" });
  await c.connect(ct);
  return c;
}
const call = (c, name, args) => c.callTool({ name, arguments: args });
const copyApp = (c, args) => call(c, "copy_app", args);

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log("1. a local install is untouched: no option, no tool, no behaviour change");
let hostedBytes = 0;
{
  const plain = await connect(leif, "u_leif", { providers: false });
  const plainTools = (await plain.listTools()).tools;
  const callerOnly = createEngine(leif, { caller: { principal: "u_leif" }, dynamicTools: false });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await callerOnly.connect(st);
  const cc = new Client({ name: "x", version: "1" }); await cc.connect(ct);
  const callerTools = (await cc.listTools()).tools;
  const hosted = await connect(leif, "u_leif");
  const hostedTools = (await hosted.listTools()).tools;
  ok("caller alone adds nothing to tools/list (byte-identical)", JSON.stringify(callerTools) === JSON.stringify(plainTools));
  ok("with providers: exactly share + copy_app, APPENDED after the unchanged surface",
    JSON.stringify(hostedTools.slice(0, plainTools.length)) === JSON.stringify(plainTools)
    && hostedTools.slice(plainTools.length).map((t) => t.name).join() === "share,copy_app");
  hostedBytes = JSON.stringify(hostedTools).length;
  ok(`hosted surface measured: ${hostedBytes} B (OSS-equivalent ${JSON.stringify(plainTools).length} B + ${hostedBytes - JSON.stringify(plainTools).length} B for share + copy_app)`, hostedBytes > 0);
  // Without a router, a handle is just a string: an @-name reads as the (empty) local collection it
  // always was, and no other account's store is ever consulted.
  const r = await call(plain, "data_list", { collection: "@leo/trips" });
  ok("OSS: data_list on an @-name is the plain empty local read it always was", !r.isError && r.structuredContent.total === 0 && !textOf(r).includes("Oslo"));
  const w = await call(plain, "data_add_item", { command_id: cid(), collection: "@leo/trips", fields: { x: 1 } });
  ok("OSS: …and no local collection can be created under one", w.isError && w.structuredContent?.reason === "reserved_collection");
  let threw = null;
  try { createEngine(leif, { mounts: world.mountsFor("u_leif") }); } catch (e) { threw = e.message; }
  ok("mounts without caller is refused at construction", /mounts needs caller/.test(threw || ""));
  threw = null;
  try { createEngine(leif, { caller: { principal: "" } }); } catch (e) { threw = e.message; }
  ok("an empty principal is refused at construction", /caller must be/.test(threw || ""));
  threw = null;
  try { createEngine(leif, { caller: { principal: "u" }, mounts: world.mountsFor("u_leif"), sharing: { invite() {} } }); } catch (e) { threw = e.message; }
  ok("a sharing provider missing methods is refused at construction", /sharing\.list must be a function/.test(threw || ""));
  await plain.close(); await cc.close(); await hosted.close();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log("2. the matrix — every tool × every handle shape × both roles");
const FORMS = {
  granted: { coll: "@leo/trips", app: "@leo/trip-planner" },
  ungranted: { coll: "@leo/finances", app: "@leo/finance-app" },
  nonexistent: { coll: "@leo/nothing", app: "@leo/nope" },
  othersAlias: { coll: "@mia/notes", app: "@mia/notes-app" },
  traversal: { coll: "@leo/../trips", app: "@leo/../trip-planner" },
  upper: { coll: "@LEO/trips", app: "@LEO/trip-planner" },
  settings: { coll: "@leo/settings", app: "@leo/settings" },
  homoglyph: { coll: "@lеo/trips", app: "@lеo/trip-planner" },
  padded: { coll: "@leo/trips ", app: "@leo/trip-planner " },
  doubleSlash: { coll: "@leo//trips", app: "@leo//trip-planner" },
  noAlias: { coll: "@/trips", app: "@/trip-planner" },
  bareAlias: { coll: "@leo", app: "@leo" },
};
// A row and a file per destructive case, made BEFORE the snapshot, so a granted editor's success has
// something of its own to remove and the refused forms have something to (not) touch.
const victims = [];
const victim = () => { const r = add(leo, "trips", { city: "victim" }); victims.push(r.id); return r.id; };
// kind: "read" (granted → served), "write" (granted → editor writes, viewer read_only),
// "code" (granted → shared_app_locked), "never" (every form refused alike, granted included).
const CASES = [
  { tool: "data_list", kind: "read", args: (f) => ({ collection: f.coll }) },
  { tool: "data_changes", kind: "read", args: (f) => ({ collection: f.coll, since: 0 }) },
  { tool: "data_changes", kind: "read", note: "no since", args: (f) => ({ collection: f.coll }) },
  { tool: "get_data_version", kind: "read", args: (f) => ({ collection: f.coll }) },
  { tool: "open_app", kind: "read", note: "shared app on this collection", args: (f) => ({ app: "@leo/trip-planner", collection: f.coll }) },
  { tool: "data_add_item", kind: "write", args: (f) => ({ command_id: cid(), collection: f.coll, fields: { city: "added" } }) },
  { tool: "data_update_item", kind: "write", args: (f) => ({ command_id: cid(), id: trip1.id, collection: f.coll, fields: { hotel: "Hilton" } }) },
  { tool: "data_move_item", kind: "write", args: (f) => ({ command_id: cid(), id: trip1.id, collection: f.coll, group: "day-2" }) },
  { tool: "data_delete_item", kind: "write", args: (f, v) => ({ command_id: cid(), id: v, collection: f.coll }), victim: true },
  { tool: "apply_data_writes", kind: "write", args: (f) => ({ command_id: cid(), commands: [{ type: "add_item", collection: f.coll, fields: { city: "batched" } }] }) },
  { tool: "open_app", kind: "read", args: (f) => ({ app: f.app }) },
  { tool: "get_app_html", kind: "read", args: (f) => ({ name: f.app }) },
  { tool: "get_app", kind: "read", args: (f) => ({ name: f.app }) },
  { tool: "get_app", kind: "read", note: "manifest slot", args: (f) => ({ name: f.app, slot: "manifest" }) },
  { tool: "file_list", kind: "read", args: (f) => ({ app: f.app }) },
  { tool: "file_read", kind: "read", args: (f) => ({ app: f.app, path: "map.png" }) },
  { tool: "share", kind: "read", note: "participants", args: (f) => ({ action: "list", app: f.app }) },
  { tool: "file_write", kind: "write", args: (f) => ({ command_id: cid(), app: f.app, path: "notes.txt", data_base64: b64("hi") }) },
  { tool: "file_delete", kind: "write", args: (f, v) => ({ command_id: cid(), app: f.app, path: v }), victimFile: true },
  { tool: "save_app", kind: "code", args: (f) => ({ name: f.app, ui: "<p>pwn</p>" }) },
  { tool: "edit_app", kind: "code", args: (f) => ({ command_id: cid(), app: f.app, expected_version: 1, edits: [{ old_string: "p", new_string: "q" }] }) },
  { tool: "list_app_checkpoints", kind: "code", args: (f) => ({ name: f.app }) },
  { tool: "restore_app", kind: "code", args: (f) => ({ name: f.app, checkpoint: 1 }) },
  { tool: "delete_app", kind: "code", args: (f) => ({ command_id: cid(), name: f.app, data: "cascade" }) },
  { tool: "call_function", kind: "code", args: (f) => ({ command_id: cid(), app: f.app, function: "total" }) },
  { tool: "share", kind: "never", note: "re-share", args: (f) => ({ action: "invite", app: f.app, role: "editor", access: "anyone" }) },
  { tool: "security_set", kind: "never", args: (f) => ({ key: `security:${f.app}:send_message`, value: "allow" }) },
  { tool: "install_from_app_store", kind: "never", args: (f) => ({ name: f.app }) },
];
const fp = (s) => JSON.stringify([s.dataVersion().seq, s.db.prepare("SELECT COUNT(*) AS n FROM item").get().n,
  s.fileUsageTotal(), s.listApps().map((a) => `${a.name}:${a.version}`), s.livePointer()?.n ?? 0,
  s.db.prepare("SELECT COUNT(*) AS n FROM principal").get().n]);
const fpAll = () => fp(leo) + fp(leif) + fp(mia) + JSON.stringify(world.grants.map((g) => g.status + g.role)) + world.links.length;
// The refusal, with the caller-supplied handle replaced — the only byte allowed to differ.
const norm = (r, h) => JSON.stringify(r).split(JSON.stringify(h).slice(1, -1)).join("<H>");

const matrix = { cells: 0, refusedIdentical: 0, grantedOk: 0, failures: [] };
for (const role of ["viewer", "editor"]) {
  leifGrant.role = role;
  const c = await connect(leif, "u_leif", { functions: true });
  for (const k of CASES) {
    const label = `${k.tool}${k.note ? ` (${k.note})` : ""} [${role}]`;
    // Which of the two handle shapes this case varies — the only caller-supplied bytes that may
    // differ between two refusals.
    const which = JSON.stringify(k.args({ coll: "\u0001C", app: "\u0001A" }, "v")).includes("\\u0001C") ? "coll" : "app";
    const baseArgs = k.args(FORMS.nonexistent, k.victim ? victim() : k.victimFile ? "x.txt" : undefined);
    const before0 = fpAll();
    const baseline = await call(c, k.tool, baseArgs);
    const baseNorm = norm(baseline, FORMS.nonexistent[which]);
    if (!baseline.isError || fpAll() !== before0) matrix.failures.push(`${label}: the nonexistent handle was not refused cleanly`);
    for (const [form, f] of Object.entries(FORMS)) {
      if (form === "nonexistent") continue;
      matrix.cells++;
      let v;
      if (k.victim) v = victim();
      if (k.victimFile) { v = `victim-${randomUUID().slice(0, 8)}.txt`; await leoFiles.put("trip-planner", v, "x"); }
      const args = k.args(f, v);
      const h = f[which];
      const before = fpAll();
      const r = await call(c, k.tool, args);
      const after = fpAll();
      if (form === "granted" && k.kind !== "never") {
        const want = k.kind === "code" ? reasonOf(r) === "shared_app_locked"
          : k.kind === "read" ? !r.isError
          : role === "viewer" ? reasonOf(r) === "read_only" && after === before
          : !r.isError;
        if (want) matrix.grantedOk++;
        else matrix.failures.push(`${label} granted: ${JSON.stringify(r).slice(0, 300)}`);
        if (k.kind !== "write" || role === "viewer") if (after !== before && k.tool !== "data_changes") matrix.failures.push(`${label} granted: state moved on a ${k.kind}`);
        continue;
      }
      const same = norm(r, h) === baseNorm;
      // …and refused as NOT SHARED, for every verb that takes a handle — the one answer a handle
      // that resolves to nothing gets (the "never" verbs have their own single refusal).
      const why = k.kind === "never" || reasonOf(r) === "not_shared";
      if (r.isError && same && why && after === before) matrix.refusedIdentical++;
      else matrix.failures.push(`${label} ${form}: refused=${!!r.isError} identical=${same} not_shared=${why} stateMoved=${after !== before} :: ${JSON.stringify(r).slice(0, 260)}`);
    }
  }
  await c.close();
}
ok(`${matrix.cells} matrix cells: ${matrix.refusedIdentical} refused exactly like "does not exist", ${matrix.grantedOk} granted cells behaved per role`,
  matrix.failures.length === 0 && matrix.refusedIdentical + matrix.grantedOk === matrix.cells, matrix.failures.slice(0, 8).join("\n      "));
leifGrant.role = "editor";

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log("3. a bare name is the caller's OWN, always (T2); an id alone finds exactly one shared row");
{
  const c = await connect(leif, "u_leif");
  const own = await call(c, "data_list", { collection: "trips" });
  ok("data_list \"trips\" reads leif's own trips — never leo's",
    own.structuredContent.items.length === 1 && own.structuredContent.items[0].fields.city === "Leif's own");
  const before = fpAll();
  const r = await call(c, "data_update_item", { command_id: cid(), id: trip1.id, collection: "trips", fields: { hotel: "x" } });
  ok("an update naming the bare collection does not reach the owner's row (not_found, nothing moved)",
    r.isError && r.structuredContent.reason === "not_found" && fpAll() === before);
  const finR = await call(c, "data_update_item", { command_id: cid(), id: fin1.id, fields: { amount: 0 } });
  const ghostR = await call(c, "data_update_item", { command_id: cid(), id: randomUUID(), fields: { amount: 0 } });
  ok("an id alone, outside every grant ≡ an id that exists nowhere (byte-identical refusal)",
    finR.isError && JSON.stringify(finR) === JSON.stringify(ghostR), JSON.stringify([finR, ghostR]).slice(0, 400));
  const byId = await call(c, "data_update_item", { command_id: cid(), id: trip1.id, fields: { hotel: "Hilton" } });
  ok("an id alone that lives in exactly one shared collection is routed there, and the receipt names the HANDLE",
    !byId.isError && byId.structuredContent.collection === "@leo/trips" && leo.snapshot("trips").items.find((i) => i.id === trip1.id).fields.hotel === "Hilton");
  const ownById = await call(c, "data_update_item", { command_id: cid(), id: leifTrip.id, fields: { note: "mine" } });
  ok("…and an id the caller owns is the caller's own row, first", !ownById.isError && ownById.structuredContent.collection === "trips");
  const mixed = await call(c, "apply_data_writes", { command_id: cid(), commands: [
    { type: "add_item", collection: "trips", fields: { a: 1 } }, { type: "add_item", collection: "@leo/trips", fields: { a: 2 } }] });
  ok("a batch spanning the caller's store and a share is refused whole (mixed_batch), nothing applied",
    mixed.isError && reasonOf(mixed) === "mixed_batch");
  const sharedBatch = await call(c, "apply_data_writes", { command_id: cid(), commands: [
    { type: "add_item", collection: "@leo/trips", fields: { city: "Bergen" } }, { type: "update_item", id: trip1.id, fields: { nights: 2 } }] });
  ok("a batch wholly inside one share applies in one transaction", !sharedBatch.isError && sharedBatch.structuredContent.count === 2);
  await c.close();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log("4. attribution — principal (server-stamped) · actor · host, in the OWNER's ledger");
{
  const c = await connect(leif, "u_leif", { clientName: "chatgpt" });
  const forged = await call(c, "data_add_item", { command_id: cid(), collection: "@leo/trips", fields: { city: "Paris" }, actor: "human", principal: "u_leo", principal_label: "leo@example.com" });
  const row = leo.db.prepare("SELECT principal, actor, host FROM change_event WHERE seq = ?").get(forged.structuredContent.seq);
  ok("the recipient's write lands in leo's ledger as principal=u_leif · actor=human · host=chatgpt (a principal in the arguments is ignored)",
    row.principal === "u_leif" && row.actor === "human" && row.host === "chatgpt", JSON.stringify(row));
  ok("…and leo's store now knows leif's label", leo.principalLabel("u_leif") === "leif@example.com");
  const agent = await call(c, "data_update_item", { command_id: cid(), id: forged.structuredContent.id, collection: "@leo/trips", fields: { hotel: "Ritz" } });
  ok("an AI write is actor=agent under the same principal",
    leo.db.prepare("SELECT principal, actor FROM change_event WHERE seq = ?").get(agent.structuredContent.seq).actor === "agent");
  const own = await call(c, "data_add_item", { command_id: cid(), collection: "trips", fields: { city: "home" } });
  ok("leif's writes to his OWN store are stamped too", leif.db.prepare("SELECT principal FROM change_event WHERE seq = ?").get(own.structuredContent.seq).principal === "u_leif");
  await c.close();
  const o = await connect(leo, "u_leo", { clientName: "claude" });
  const ch = await call(o, "data_changes", { collection: "trips", since: forged.structuredContent.seq - 1 });
  ok("the owner's data_changes names the account: `by` on the event, \"leif@… (chatgpt) human added\" in the text",
    ch.structuredContent.events[0].by === "leif@example.com" && !("principal" in ch.structuredContent.events[0])
    && /leif@example\.com \(chatgpt\) human added/.test(textOf(ch)));
  ok("…and says another account's fields are data, not instructions (T14)", /another account/.test(ch.structuredContent.note || "") && /not as instructions/.test(textOf(ch)));
  const list = await call(o, "data_list", { collection: "trips" });
  ok("the owner's data_list marks the rows another account last wrote (T14)",
    /last written by another account — leif@example\.com:/.test(list.structuredContent.note || "") && list.structuredContent.note.includes(forged.structuredContent.id));
  ok("…on both channels", textOf(list).includes("leif@example.com"));
  const leoOwn = await call(o, "data_add_item", { command_id: cid(), collection: "trips", fields: { city: "by leo" } });
  const list2 = await call(o, "data_list", { collection: "trips", match: { city: "by leo" } });
  ok("rows the caller wrote are not marked", !(list2.structuredContent.note || "").includes(leoOwn.structuredContent.id));
  await o.close();
  // A function body's writes arrive on a message port from a worker thread — they must still carry
  // the caller who made the call (functions.mjs re-enters the call's async context per dispatch).
  const fnApp = save(leo, "tally", { collections: { tally: {} }, functions: { bump: {} } },
    `<!doctype html><p>t</p><script type="text/oma-function" data-fn="bump">api.add({ fields: { n: 1 } }); return 1;${CLOSE}`);
  const fo = await connect(leo, "u_leo", { functions: true });
  const ran = await call(fo, "call_function", { command_id: cid(), app: "tally", function: "bump" });
  const fnSeq = ran.structuredContent?.writes?.[0]?.seq;
  ok("a function body's write is stamped with the caller's principal too",
    fnApp.ok && !ran.isError && leo.db.prepare("SELECT principal FROM change_event WHERE seq = ?").get(fnSeq)?.principal === "u_leo", JSON.stringify(ran).slice(0, 300));
  await fo.close();
  // …including under an EXECUTOR whose store round trips come back on a connection opened before
  // the call (a socket to a remote runner): the dispatch then runs in that connection's context,
  // not the call's, and only the engine re-entering the call's context keeps the stamp.
  const socket = new AsyncResource("remote-runner-socket");
  const remote = createEngine(leo, { dynamicTools: false, caller: { principal: "u_leo", label: "leo@example.com" },
    functions: { executor: async ({ dispatch }) => { socket.runInAsyncScope(() => dispatch("add", { row: { fields: { n: 2 } } })); return { kind: "value", json: "2" }; } } });
  const [rct, rst] = InMemoryTransport.createLinkedPair(); await remote.connect(rst);
  const rc = new Client({ name: "claude", version: "1" }); await rc.connect(rct);
  const viaSocket = await call(rc, "call_function", { command_id: cid(), app: "tally", function: "bump" });
  const sockSeq = viaSocket.structuredContent?.writes?.[0]?.seq;
  ok("…and when the executor answers from a context opened before the call (a remote runner's socket)",
    !viaSocket.isError && leo.db.prepare("SELECT principal FROM change_event WHERE seq = ?").get(sockSeq)?.principal === "u_leo", JSON.stringify(viaSocket).slice(0, 300));
  await rc.close();
  // A local install sees none of this: no caller, no `by`, no note.
  const plain = await connect(leo, "u_leo", { providers: false });
  const pc = await call(plain, "data_changes", { collection: "trips", since: forged.structuredContent.seq - 1 });
  ok("without a caller the events carry the raw ledger shape (principal, no `by`, no note)",
    !("by" in pc.structuredContent.events[0]) && !pc.structuredContent.note);
  await plain.close();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log("5. what the recipient's AI sees: list_apps · list_data_collections · open · html · probe");
{
  const c = await connect(leif, "u_leif");
  const apps = await call(c, "list_apps", {});
  const row = apps.structuredContent.apps.find((a) => a.name === "@leo/trip-planner");
  ok("list_apps lists the caller's own apps, then the shared one with who and what role",
    apps.structuredContent.apps.some((a) => a.name === "my-board") && row && row.locked === true
    && row.shared.from === "leo@example.com" && row.shared.role === "editor" && row.shared.collections.join() === "@leo/trips");
  ok("…and the text says it, in its own section", /Shared with you[\s\S]*@leo\/trip-planner v\d+ — shared by leo@example\.com · you can EDIT DATA · collections: @leo\/trips/.test(textOf(apps)));
  ok("…and nothing else of leo's (no finance-app) and nothing of mia's", !textOf(apps).includes("finance") && !textOf(apps).includes("notes-app"));
  const one = await call(c, "list_apps", { name: "@leo/trip-planner" });
  ok("an exact lookup by handle finds it", one.structuredContent.total === 1 && one.structuredContent.apps[0].name === "@leo/trip-planner");
  const cols = await call(c, "list_data_collections", {});
  const sharedCol = cols.structuredContent.collections.find((x) => x.collection === "@leo/trips");
  ok("list_data_collections: own collections, then @leo/trips with from + role", sharedCol && sharedCol.shared.role === "editor"
    && cols.structuredContent.collections.some((x) => x.collection === "trips" && !x.shared) && !textOf(cols).includes("finances"));
  const open = await call(c, "open_app", { app: "@leo/trip-planner" });
  ok("open_app binds the handle of the app's own collection", open.structuredContent.collection === "@leo/trips" && /Shared with you by leo@example\.com/.test(textOf(open)));
  const outside = await call(c, "open_app", { app: "@leo/trip-planner", collection: "trips" });
  ok("open_app refuses to bind a shared app to the caller's OWN collection (T13a)", outside.isError && reasonOf(outside) === "not_shared");
  const html = await call(c, "get_app_html", { name: "@leo/trip-planner", mount: true });
  const sc = html.structuredContent;
  ok("get_app_html: tier shared, locked, bound to the handle", sc.tier === "shared" && sc.locked === true && sc.collection === "@leo/trips");
  ok("…caps: no messages, no source, no settings, collections = the shared handles",
    sc.caps.send_message === false && sc.caps.read_source === false && sc.caps.settings_write === false && sc.caps.collections.join() === "@leo/trips"
    && sc.caps.call_tools.includes("data_update_item") && !sc.caps.call_tools.some((t) => /get_app|list_data|call_function|save|security/.test(t)));
  ok("mount:true moved the CALLER's live pointer to the handle — the owner's is untouched",
    leif.livePointer()?.app === "@leo/trip-planner" && leo.livePointer() === null);
  // The probe: the collection's own mark; the owner's writes elsewhere do not move it (T4).
  const p1 = (await call(c, "get_data_version", { collection: "@leo/trips" })).structuredContent;
  add(leo, "finances", { amount: 1 });
  const p2 = (await call(c, "get_data_version", { collection: "@leo/trips" })).structuredContent;
  ok("the probe on a handle is the collection's own seq; an owner write in an unshared collection does not move it",
    p1.seq === p2.seq && p1.seq === leo.collectionVersion("trips") && p1.seq < leo.dataVersion().seq);
  ok("…and its settings_version is the CALLER's (the prefs they render with)", p1.settings_version === leif.dataVersion().settings_version);
  const dl = await call(c, "data_list", { collection: "@leo/trips" });
  ok("a shared data_list leads with where it came from, and its version is the collection's mark",
    /^\d+ returned\nShared with you by leo@example\.com · you can EDIT DATA\.\nCollection "@leo\/trips"/.test(textOf(dl)) && dl.structuredContent.version === leo.collectionVersion("trips"), textOf(dl).slice(0, 200));
  // An editor's delete from a widget (actor human) goes through the usual two steps (§10-9): the
  // demand, then the same call with request_state — issued and verified by the OWNER's store.
  const doomed = add(leo, "trips", { city: "to delete" });
  const ask = await call(c, "data_delete_item", { command_id: cid(), id: doomed.id, collection: "@leo/trips", actor: "human", require_confirmation: true });
  ok("an editor's human delete first returns confirmation_required, naming the handle",
    reasonOf(ask) === "confirmation_required" && ask.structuredContent.collection === "@leo/trips" && leo.countItems("trips") > 0 && !!ask.structuredContent.request_state);
  const yes = await call(c, "data_delete_item", { command_id: cid(), id: doomed.id, collection: "@leo/trips", actor: "human", require_confirmation: true, request_state: ask.structuredContent.request_state });
  ok("…and the confirmed resend deletes the owner's row", !yes.isError && yes.structuredContent.deleted === true && !leo.snapshot("trips").items.some((i) => i.id === doomed.id));
  // The caller's OWN app opened on a shared collection: their app, their trust, their grant.
  const mine = await call(c, "open_app", { app: "my-board", collection: "@leo/trips" });
  ok("the caller's own app can be opened on a collection shared with them (size from the share)",
    !mine.isError && mine.structuredContent.collection === "@leo/trips" && mine.structuredContent.total === leo.countItems("trips"));
  const notMine = await call(c, "open_app", { app: "my-board", collection: "@leo/finances" });
  ok("…but not on a handle they hold no grant for", notMine.isError && reasonOf(notMine) === "not_shared");
  // viewer
  leifGrant.role = "viewer";
  const v = await call(c, "data_add_item", { command_id: cid(), collection: "@leo/trips", fields: { x: 1 } });
  ok("a viewer's write is read_only, with the owner named", v.isError && reasonOf(v) === "read_only" && /read-only by leo@example\.com/.test(textOf(v)));
  ok("…and get_app_html gives a viewer no write verbs", !(await call(c, "get_app_html", { name: "@leo/trip-planner" })).structuredContent.caps.call_tools.some((t) => /add|update|move|delete|write/.test(t)));
  leifGrant.role = "editor";
  await c.close();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log("6. scope FOLLOWS THE APP — and the owner is told when it moves");
{
  const o = await connect(leo, "u_leo");
  const r = leo.getApp("trip-planner");
  const saved = await call(o, "save_app", { name: "trip-planner", manifest: { collections: { trips: {}, "trip-notes": {} } }, expected_version: r.version });
  ok("binding a new collection on a shared app: the receipt says who can now ALSO reach it",
    /shared \(1 account\(s\)\): they can now ALSO reach "trip-notes"/.test(textOf(saved)) && /ALSO reach/.test(saved.structuredContent.note || ""));
  add(leo, "trip-notes", { text: "pack light" });
  const c = await connect(leif, "u_leif");
  const notes = await call(c, "data_list", { collection: "@leo/trip-notes" });
  ok("…and the recipient reaches it on the next call", !notes.isError && notes.structuredContent.items[0].fields.text === "pack light");
  const unbind = await call(o, "save_app", { name: "trip-planner", manifest: { collections: { trips: {} } }, expected_version: leo.getApp("trip-planner").version });
  ok("unbinding it: the receipt says they no longer reach it", /no longer reach "trip-notes"/.test(textOf(unbind)));
  const gone = await call(c, "data_list", { collection: "@leo/trip-notes" });
  ok("…and the recipient is refused on the next call", gone.isError && reasonOf(gone) === "not_shared");
  const plainSave = await call(o, "save_app", { name: "finance-app", ui: leo.getApp("finance-app").ui, expected_version: leo.getApp("finance-app").version });
  ok("a save of an unshared app says nothing about sharing", !/shared \(/.test(textOf(plainSave)));
  await c.close(); await o.close();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log("7. copy_app — without data, with data, rename mapping, idempotent replay");
{
  const c = await connect(leif, "u_leif");
  const bare = await copyApp(c, { command_id: cid(), app: "@leo/trip-planner", name: "trips-empty", with_data: false });
  ok("without data: a local app, its collection mapped, no rows moved",
    !bare.isError && leif.getApp("trips-empty")?.author === "agent" && bare.structuredContent.collections.trips === "trips-copy"
    && leif.countItems("trips-copy") === 0 && /No data was copied/.test(textOf(bare)));
  ok("…the copy's manifest declares the mapped collection (it would otherwise open on an empty one)",
    JSON.parse(leif.getApp("trips-empty").manifest).collections["trips-copy"] !== undefined);
  ok("…\"trips\" already holds leif's own rows, so it was NOT merged into: mapped to trips-copy", leif.countItems("trips") >= 1 && leif.snapshot("trips").items.every((i) => i.fields.city !== "Oslo"));
  const copyCid = cid();
  const leoRows = leo.countItems("trips");
  const leoFileCount = openFileChannel(leo).list("trip-planner").files.length;
  const full = await copyApp(c, { command_id: copyCid, app: "@leo/trip-planner", name: "my-trips", with_data: true });
  const mapped = full.structuredContent.collections.trips;
  ok("with data: every row and every file arrive", !full.isError && full.structuredContent.rows === leoRows && full.structuredContent.files === leoFileCount
    && leif.countItems(mapped) === leoRows && openFileChannel(leif).stat("my-trips", "map.png")?.size === 10, JSON.stringify(full.structuredContent));
  ok("…into a collection of its own: an empty collection another copy is bound to is not reused",
    mapped !== "trips-copy" && mapped !== "trips" && leif.countItems("trips-copy") === 0, mapped);
  ok("…ids preserved where free (references inside fields keep working)", leif.snapshot(mapped).items.some((i) => i.id === trip1.id));
  ok("…the save records where it came from (copied_from in the ledger)",
    /"copied_from":\{"owner":"leo@example\.com","app":"@leo\/trip-planner"/.test(leif.db.prepare("SELECT payload FROM change_event WHERE command_id = ?").get(`${copyCid}:app`).payload));
  const seqBefore = leif.dataVersion().seq;
  const replay = await copyApp(c, { command_id: copyCid, app: "@leo/trip-planner", name: "my-trips", with_data: true });
  ok("an idempotent replay: same mapping, no duplicate rows, no new ledger events",
    !replay.isError && replay.structuredContent.collections.trips === mapped && leif.countItems(mapped) === leoRows && leif.dataVersion().seq === seqBefore,
    JSON.stringify(replay.structuredContent));
  const third = await copyApp(c, { command_id: cid(), app: "@leo/trip-planner", name: "again", with_data: true });
  ok("a second copy re-mints the ids that already exist here, and says so",
    !third.isError && third.structuredContent.reminted === leoRows && /got new ids/.test(textOf(third)));
  const taken = await call(c, "copy_app", { command_id: cid(), app: "@leo/trip-planner", name: "my-trips", with_data: false });
  ok("a taken name is refused (no auto-suffix)", taken.isError && /already exists/.test(textOf(taken)));
  const leoBefore = fp(leo);
  await call(c, "data_update_item", { command_id: cid(), id: trip1.id, collection: mapped, fields: { hotel: "copy-edit" } });
  await call(c, "save_app", { name: "my-trips", ui: "<p>mine now</p>", expected_version: leif.getApp("my-trips").version });
  ok("editing the copy's rows and code leaves the owner's store byte-identical", fp(leo) === leoBefore && leo.snapshot("trips").items.find((i) => i.id === trip1.id).fields.hotel !== "copy-edit");
  ok("the provider heard about the copies (audit hook)", world.copies.length >= 3 && world.copies[0].as === "trips-empty");
  leifGrant.role = "viewer";
  const vcopy = await copyApp(c, { command_id: cid(), app: "@leo/trip-planner", name: "viewer-copy", with_data: true });
  ok("a viewer may copy too", !vcopy.isError && leif.getApp("viewer-copy") !== null);
  leifGrant.role = "editor";
  await c.close();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log("8. share — invite (restricted / anyone), claim, list, set_role, revoke, leave");
{
  save(leo, "recipes", { collections: { recipes: {} } });
  add(leo, "recipes", { dish: "soup" });
  const o = await connect(leo, "u_leo");
  const noRole = await call(o, "share", { action: "invite", app: "recipes", accounts: ["mia@example.com"] });
  ok("invite without a role is refused — the AI must ask", noRole.isError && /needs role/.test(textOf(noRole)));
  const noAcc = await call(o, "share", { action: "invite", app: "recipes", role: "viewer" });
  ok("a restricted invite without accounts is refused", noAcc.isError && /needs accounts/.test(textOf(noAcc)));
  const sys = await call(o, "share", { action: "invite", app: "settings", role: "viewer", access: "anyone" });
  ok("a system / missing app cannot be shared", sys.isError);
  const inv = await call(o, "share", { action: "invite", app: "recipes", role: "viewer", accounts: ["Mia@Example.com "] });
  const link = inv.structuredContent.link;
  ok("restricted invite: a link for exactly the listed (normalised) account, and the receipt says what it shares",
    !inv.isError && link.accounts.join() === "mia@example.com" && /Only mia@example\.com can claim/.test(textOf(inv))
    && /"recipes" \(1 rows\)/.test(textOf(inv)) && /Nothing was emailed/.test(textOf(inv)));
  ok("…with the app's birth recorded for the grant", world.links.at(-1).appBirth === leo.appBirth("recipes"));
  ok("a claim by someone not on the list is refused (the deployment's rule)", world.claim(link.id, "u_leif").ok === false);
  ok("…and by the listed account succeeds", world.claim(link.id, "u_mia").ok === true);
  const m = await connect(mia, "u_mia");
  ok("mia now sees @leo/recipes", (await call(m, "data_list", { collection: "@leo/recipes" })).structuredContent?.items?.[0]?.fields.dish === "soup");
  const anyone = await call(o, "share", { action: "invite", app: "recipes", role: "editor", access: "anyone" });
  ok("anyone-with-link: the receipt states the risk", !anyone.isError && /ANYONE who has this link can claim it/.test(textOf(anyone)) && anyone.structuredContent.link.accounts.length === 0);
  world.claim(anyone.structuredContent.link.id, "u_leif");
  const lst = await call(o, "share", { action: "list", app: "recipes" });
  ok("list: links and people", /mia@example\.com \(viewer\)/.test(textOf(lst)) && /leif@example\.com \(editor\)/.test(textOf(lst)) && /ANYONE with the link/.test(textOf(lst)));
  const parts = await call(m, "share", { action: "list", app: "@leo/recipes" });
  ok("participants can see each other (§10-6)", /leo@example\.com \(owner\)/.test(textOf(parts)) && /leif@example\.com/.test(textOf(parts)));
  const reshare = await call(m, "share", { action: "invite", app: "@leo/recipes", role: "editor", access: "anyone" });
  ok("a recipient cannot re-share", reshare.isError && reasonOf(reshare) === "not_yours");
  await call(o, "share", { action: "set_role", app: "recipes", accounts: ["mia@example.com"], role: "editor" });
  const nowEdit = await call(m, "data_add_item", { command_id: cid(), collection: "@leo/recipes", fields: { dish: "bread" } });
  ok("set_role takes effect on the next call", !nowEdit.isError);
  const rl = await call(o, "share", { action: "revoke", app: "recipes", link: anyone.structuredContent.link.id });
  ok("revoking a link does not remove people who already claimed it (§10-1)", !rl.isError
    && !(await call(await connect(leif, "u_leif"), "data_list", { collection: "@leo/recipes" })).isError);
  await call(o, "share", { action: "revoke", app: "recipes", accounts: ["mia@example.com"] });
  const after = await call(m, "data_list", { collection: "@leo/recipes" });
  ok("revoking an account: refused on its very next call", after.isError && reasonOf(after) === "not_shared");
  const c = await connect(leif, "u_leif");
  const left = await call(c, "share", { action: "leave", app: "@leo/recipes" });
  ok("leave: the recipient gives it up, and it is gone on the next call", !left.isError && (await call(c, "data_list", { collection: "@leo/recipes" })).isError);
  await o.close(); await m.close(); await c.close();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log("9. T15 — delete and recreate under the same name does not revive a share");
{
  save(leo, "diary", { collections: { diary: {} } });
  add(leo, "diary", { entry: "shared once" });
  world.grant("u_leo", "u_leif", "diary", "editor");
  const c = await connect(leif, "u_leif");
  ok("(shared and reachable)", !(await call(c, "data_list", { collection: "@leo/diary" })).isError);
  const o = await connect(leo, "u_leo");
  const del = await call(o, "delete_app", { command_id: cid(), name: "diary" });
  ok("the owner's delete receipt says the share ended with it", /shared with 1 account\(s\): those shares ended/.test(textOf(del)));
  const dead = await call(c, "data_list", { collection: "@leo/diary" });
  ok("deleted: refused", dead.isError && reasonOf(dead) === "not_shared");
  ok("…and the engine reported the dead grant to the provider", world.ended.some((d) => d.app === "diary"));
  leo.execute({ type: "save_app", command_id: cid(), name: "diary", ui: "<p>a new, private diary</p>", manifest: { collections: { diary: {} } }, actor: "agent" });
  // Re-activate the record to prove the ENGINE refuses on its own (a provider that did not close it).
  for (const g of world.grants) if (g.app === "diary") g.status = "active";
  const reborn = await call(c, "data_list", { collection: "@leo/diary" });
  const rebornApp = await call(c, "get_app", { name: "@leo/diary" });
  ok("recreated under the same name, even with the old record still active: refused", reborn.isError && rebornApp.isError && reasonOf(rebornApp) === "not_shared");
  ok("…and not listed", !textOf(await call(c, "list_apps", {})).includes("@leo/diary"));
  await c.close(); await o.close();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log("10. files through a share — a write lands in the owner's app, named back by the handle");
{
  const c = await connect(leif, "u_leif");
  // (The chunked-upload half of this section — share-scoped upload ids — went with the
  // begin/chunk/commit trio in 0.8.1.)
  const w = await call(c, "file_write", { command_id: cid(), app: "@leo/trip-planner", path: "route.gpx", data_base64: b64("gpx-data") });
  ok("file_write lands in the owner's app, named back by the handle",
    !w.isError && w.structuredContent.app === "@leo/trip-planner" && openFileChannel(leo).stat("trip-planner", "route.gpx")?.size === 8);
  const quota = leo.fileUsage("trip-planner").bytes;
  ok("shared file writes count against the OWNER's quota (they live in the owner's store)", quota >= 8);
  await c.close();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log("11. the runner — a shared app is pinned to its shared collections");
{
  const calls = [];
  const io = { callTool: async (tn, ta) => { calls.push([tn, ta]); return tn === "data_list" ? { structuredContent: { collection: ta.collection, items: [{ id: "seen-2", fields: {} }] } } : { structuredContent: { ok: true } }; },
    readCollection: async (c) => ({ collection: c, items: [{ id: "seen-3", fields: {} }], version: 1 }),
    snapshot: () => ({ collection: "@leo/trips", items: [{ id: "bound-1", fields: {} }], version: 1 }),
    settingsIds: () => new Set(["s1"]), sendMessage: async () => "sent", notify: () => {}, requestConfirm: async () => true, uuid: () => "u" };
  const caps = { call_tools: ["data_list", "data_changes", "data_add_item", "data_update_item", "data_move_item", "data_delete_item", "file_list", "file_read"],
    send_message: false, delete_items: "confirm", cross_collection_read: false, cross_collection_write: false, settings_write: false,
    read_source: false, file_read: true, file_write: false, collections: ["@leo/trips", "@leo/trip-notes"] };
  const g = makeGuard({ name: "@leo/trip-planner", coll: "@leo/trips", caps, tier: "shared", io });
  const last = () => calls.at(-1)[1];
  await g("callTool", { name: "data_list", args: { collection: "trip-notes" } });
  ok("a bare name the owner's code uses maps to its handle", last().collection === "@leo/trip-notes");
  await g("callTool", { name: "data_list", args: { collection: "trips" } });
  ok("…and so does the bound one", last().collection === "@leo/trips");
  await g("callTool", { name: "data_list", args: { collection: "my-private" } });
  ok("a name outside the shared set falls back to the bound collection — never the viewer's own", last().collection === "@leo/trips");
  await g("callTool", { name: "data_changes", args: { collection: "@mia/notes" } });
  ok("…handles of another owner too", last().collection === "@leo/trips");
  let threw = null; try { await g("callTool", { name: "list_data_collections", args: {} }); } catch (e) { threw = e.message; }
  ok("list_data_collections is refused", !!threw);
  threw = null; try { await g("callTool", { name: "get_data_version", args: {} }); } catch (e) { threw = e.message; }
  ok("tools outside the share's verbs (the viewer's probe, the registry, functions) are refused", !!threw);
  await g("updateItem", { id: "bound-1", fields: { a: 1 } });
  ok("a typed write on a row of the bound collection names that collection", last().collection === "@leo/trips" && last().actor === "human");
  await g("callTool", { name: "data_update_item", args: { id: "seen-2", fields: {} } });
  ok("a write on a row the app was SHOWN in another shared collection names that one", last().collection === "@leo/trips");
  await g("readCollection", { collection: "trip-notes" });
  await g("updateItem", { id: "seen-3", fields: {} });
  ok("…readCollection results count as shown", last().collection === "@leo/trip-notes");
  threw = null; try { await g("updateItem", { id: "never-seen", fields: {} }); } catch (e) { threw = e.message; }
  ok("a write on a row it was never shown is refused before it leaves (never routed by id alone)", threw === "out of scope");
  await g("callTool", { name: "data_add_item", args: { collection: "my-private", fields: {} } });
  ok("an add aimed outside the set lands in the bound collection", last().collection === "@leo/trips");
  await g("deleteItem", { id: "bound-1" });
  ok("a delete carries require_confirmation (editor: confirm)", last().require_confirmation === true);
  const sm = await g("sendMessage", { text: "hi" });
  ok("sendMessage is denied", sm && sm.isError);
  threw = null; try { await g("setPref", { key: "x", value: 1 }); } catch (e) { threw = e.message; }
  ok("setPref is denied", !!threw);
  // A guard WITHOUT the collections cap is exactly the old one (local/unreviewed paths untouched).
  const old = makeGuard({ name: "x", coll: "x", caps: { ...caps, collections: undefined, call_tools: ["data_list"] }, tier: "unreviewed", io });
  await old("callTool", { name: "data_list", args: { collection: "trips" } });
  ok("no collections cap ⇒ the single bound collection, as before", last().collection === "x");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log("12. handle grammar");
ok("parseHandle: only lower-case aliases, a slash, a non-empty name",
  JSON.stringify(parseHandle("@leo/trips")) === '{"alias":"leo","name":"trips"}' && parseHandle("@LEO/x") === null && parseHandle("@/x") === null
  && parseHandle("@leo") === null && parseHandle("@leo/") === null && parseHandle("@lеo/x") === null && parseHandle("leo/x") === null);

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log("13. the widget runtime — a handle-bound widget names its collection, and a lost share is said");
{
  const rt = readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf-8");
  const blk = rt.match(/const isHandle = [\s\S]*?\nfunction noLongerShared\(\) \{[\s\S]*?\n\}\n/);
  ok("the runtime's sharing block is extractable (rig integrity)", !!blk);
  const appended = [];
  const doc = { createElement: () => ({ style: {}, textContent: "" }), documentElement: { appendChild: (el) => appended.push(el) } };
  const state = { collection: "@leo/trips" };
  const f = new Function("state", "document", blk[0] + "; return { isHandle, sharedBinding, isNotShared, noLongerShared };")(state, doc);
  ok("a handle-bound widget sends its collection with every id write and the probe",
    JSON.stringify(f.sharedBinding()) === '{"collection":"@leo/trips"}');
  state.collection = "trips";
  ok("…a locally bound one sends nothing new (its wire is what it was)", JSON.stringify(f.sharedBinding()) === "{}");
  ok("not_shared is recognised from the structured reason", f.isNotShared({ isError: true, structuredContent: { reason: "not_shared" } }) && !f.isNotShared({ isError: true, structuredContent: { reason: "not_found" } }));
  f.noLongerShared(); f.noLongerShared();
  ok("the mask is drawn once, saying the share ended", appended.length === 1 && appended[0].textContent === "No longer shared with you.");
  ok("the three id-addressed writes carry the binding",
    (rt.match(/id, \.\.\.sharedBinding\(\), /g) || []).length === 3);
  ok("the probe carries it, and a not_shared probe draws the mask",
    /rawCall\("get_data_version", sharedBinding\(\)\)/.test(rt) && /isNotShared\(r\)\) \{ noLongerShared\(\);/.test(rt));
  ok("a walk that meets not_shared draws the mask", /if \(r && r\.isError && isNotShared\(r\)\) \{ noLongerShared\(\); throw/.test(rt));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The S4 security audit of sharing: every finding below is first an ATTACK, performed through the
// real tool layer by a recipient's MCP client, and the assertion is that it fails.
console.log("14. S4 audit — each finding's attack, through the real tool layer");
const rateStore = openStore(join(TMP, "rate", "store.db"));
{
  leifGrant.role = "editor";
  const c = await connect(leif, "u_leif");
  const o = await connect(leo, "u_leo");

  // X1 — a known command_id replays another collection's / another account's event.
  const K = cid();
  const priv = leo.execute({ type: "add_item", command_id: K, collection: "finances", fields: { secret: "PRIVATE-ROW" }, actor: "agent" });
  let before = fpAll();
  const x1 = await call(c, "data_add_item", { command_id: K, collection: "@leo/trips", fields: {} });
  ok("X1 data_add_item replaying a private command_id into a shared collection is refused and leaks nothing",
    x1.isError && reasonOf(x1) === "command_id_reused" && !JSON.stringify(x1).includes("PRIVATE-ROW") && !JSON.stringify(x1).includes(priv.id) && fpAll() === before,
    JSON.stringify(x1).slice(0, 300));
  const B = cid();
  const privB = leo.executeBatch([{ type: "add_item", command_id: `${B}:0`, collection: "finances", fields: { secret: "PRIVATE-BATCH" } }]);
  before = fpAll();
  const x1b = await call(c, "apply_data_writes", { command_id: B, commands: [{ type: "add_item", collection: "@leo/trips", fields: {} }] });
  ok("X1 apply_data_writes replaying a private batch id through a share is refused and leaks nothing",
    x1b.isError && /command_id/.test(textOf(x1b)) && !JSON.stringify(x1b).includes(privB.results[0].id) && fpAll() === before, JSON.stringify(x1b).slice(0, 300));
  const Ku = cid();
  leo.execute({ type: "update_item", command_id: Ku, id: trip1.id, fields: { owner_note: "by leo" }, actor: "agent" });
  const x1u = await call(c, "data_update_item", { command_id: Ku, id: trip1.id, collection: "@leo/trips", fields: { hotel: "leif's" } });
  ok("X1 data_update_item replaying the OWNER's command_id on a shared row is refused (not a false 'Already updated')",
    x1u.isError && reasonOf(x1u) === "command_id_reused", JSON.stringify(x1u).slice(0, 300));
  const Km = cid();
  leo.execute({ type: "move_item", command_id: Km, id: trip1.id, group: "owner-lane", actor: "agent" });
  const x1m = await call(c, "data_move_item", { command_id: Km, id: trip1.id, collection: "@leo/trips", group: "leif-lane" });
  ok("X1 data_move_item replaying the owner's command_id is refused", x1m.isError && reasonOf(x1m) === "command_id_reused", JSON.stringify(x1m).slice(0, 300));
  const Kd = cid();
  const gone = add(leo, "trips", { city: "owner-deleted" });
  leo.execute({ type: "delete_item", command_id: Kd, id: gone.id, actor: "agent" });
  const x1d = await call(c, "data_delete_item", { command_id: Kd, id: gone.id, collection: "@leo/trips" });
  ok("X1 data_delete_item replaying the owner's delete is not answered 'Already deleted'", x1d.isError && x1d.structuredContent?.deleted !== true, JSON.stringify(x1d).slice(0, 300));
  // …and in the caller's OWN store: one command_id cannot answer for two collections.
  const Ko = cid();
  await call(c, "data_add_item", { command_id: Ko, collection: "leif-a", fields: { p: "OWN-A" } });
  const x1own = await call(c, "data_add_item", { command_id: Ko, collection: "leif-b", fields: {} });
  ok("X1 own store: a command_id replayed into a different collection is refused", x1own.isError && reasonOf(x1own) === "command_id_reused" && !JSON.stringify(x1own).includes("OWN-A"),
    JSON.stringify(x1own).slice(0, 300));
  const Bo = cid();
  await call(c, "apply_data_writes", { command_id: Bo, commands: [{ type: "add_item", collection: "leif-a", fields: { p: "OWN-BATCH" } }] });
  const x1ownB = await call(c, "apply_data_writes", { command_id: Bo, commands: [{ type: "add_item", collection: "leif-b", fields: {} }] });
  ok("X1 own store: a batch id replayed into a different collection is refused", x1ownB.isError && /command_id/.test(textOf(x1ownB)), JSON.stringify(x1ownB).slice(0, 300));
  // The legitimate retry still works, on both stores.
  const again = await call(c, "data_add_item", { command_id: Ko, collection: "leif-a", fields: { p: "OWN-A" } });
  const Ks = cid();
  const first = await call(c, "data_add_item", { command_id: Ks, collection: "@leo/trips", fields: { city: "retry" } });
  const retry = await call(c, "data_add_item", { command_id: Ks, collection: "@leo/trips", fields: { city: "retry" } });
  ok("…a real retry (same collection, same account) is still the original receipt, own and shared",
    !again.isError && /Already added/.test(textOf(again)) && !retry.isError && retry.structuredContent.id === first.structuredContent.id && /Already added/.test(textOf(retry)));

  // T12 — `actor` is the caller's word; a delete through a share must ask whatever it claims.
  const v = add(leo, "trips", { city: "agent-delete-victim" });
  const del = await call(c, "data_delete_item", { command_id: cid(), id: v.id, collection: "@leo/trips", actor: "agent" });
  ok("T12 an agent-labelled delete through a share still demands confirmation",
    reasonOf(del) === "confirmation_required" && leo.snapshot("trips").items.some((i) => i.id === v.id), JSON.stringify(del).slice(0, 300));
  const delYes = await call(c, "data_delete_item", { command_id: cid(), id: v.id, collection: "@leo/trips", actor: "agent", request_state: del.structuredContent?.request_state });
  ok("…and the confirmed resend deletes", !delYes.isError && delYes.structuredContent.deleted === true);
  const vb = add(leo, "trips", { city: "batch-delete-victim" });
  const fv = leo.execute({ type: "add_item", command_id: cid(), collection: "trips", fields: {}, actor: "agent" });
  const face = storeMod.scopeStore(leo, { grants: [{ app: "trip-planner", appBirth: leo.appBirth("trip-planner"), role: "editor" }] });
  const faceDel = storeMod.principalScope.run({ principal: "u_leif" }, () => face.executeBatch([{ type: "delete_item", command_id: cid(), id: vb.id, actor: "agent" }]));
  ok("…a delete inside a batch through the facade demands it too", !faceDel.ok && faceDel.failure?.confirmation_required === true && leo.snapshot("trips").items.some((i) => i.id === vb.id), JSON.stringify(faceDel).slice(0, 300));
  await leoFiles.put("trip-planner", "t12.txt", "x");
  const fdel = await call(c, "file_delete", { command_id: cid(), app: "@leo/trip-planner", path: "t12.txt", actor: "agent" });
  ok("…and so does a file delete", reasonOf(fdel) === "confirmation_required" && !!openFileChannel(leo).stat("trip-planner", "t12.txt"), JSON.stringify(fdel).slice(0, 300));
  const ownDel = await call(o, "data_delete_item", { command_id: cid(), id: fv.id, actor: "agent" });
  ok("…while the owner's own agent delete is unchanged (no demand)", !ownDel.isError && ownDel.structuredContent.deleted === true);

  // T13b — copying is the recipient's only way to change a shared app, not something the owner
  // grants: one call, no confirmation (Leo 10-04 — a demand the AI can satisfy alone is no gate).
  const cp = await call(c, "copy_app", { command_id: cid(), app: "@leo/trip-planner", name: "t13b-copy", with_data: false });
  ok("T13b copy_app copies in one call — no confirmation to ask for",
    !cp.isError && cp.structuredContent?.ok === true && leif.getApp("t13b-copy") !== null, JSON.stringify(cp).slice(0, 300));

  // T19 — a shared collection has a row cap, and a share has a write rate.
  const CAP = storeMod.SHARED_COLLECTION_MAX_ROWS ?? 50_000;
  save(leo, "bulk-app", { collections: { bulk: {} } });
  world.grant("u_leo", "u_leif", "bulk-app", "editor");
  leo.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO item (id, collection, grp, position, fields, version, created_at, updated_at)
    SELECT 'bulk-' || i, 'bulk', '', i, '{}', 1, 'ts', 'ts' FROM n`).run(CAP);
  const full = await call(c, "data_add_item", { command_id: cid(), collection: "@leo/bulk", fields: {} });
  const fullB = await call(c, "apply_data_writes", { command_id: cid(), commands: [{ type: "add_item", collection: "@leo/bulk", fields: {} }] });
  ok(`T19 a shared collection at ${CAP} rows refuses another add (single and batched)`,
    full.isError && reasonOf(full) === "collection_full" && fullB.isError && /collection_full/.test(textOf(fullB)) && leo.countItems("bulk") === CAP, JSON.stringify([full, fullB]).slice(0, 400));
  const ownBulk = await call(o, "data_add_item", { command_id: cid(), collection: "bulk", fields: {} });
  ok("…the owner's own add is not capped", !ownBulk.isError);
  world.addAccount("u_rate", "rate@example.com", rateStore);
  world.grant("u_leo", "u_rate", "trip-planner", "editor");
  const r = await connect(rateStore, "u_rate");
  const LIMIT = storeMod.SHARED_WRITES_PER_HOUR ?? 600;
  let applied = 0;
  for (let i = 0; i < Math.ceil(LIMIT / 200); i++) {
    const res = await call(r, "apply_data_writes", { command_id: cid(), commands: Array.from({ length: Math.min(200, LIMIT - i * 200) }, () => ({ type: "add_item", collection: "@leo/trips", fields: { n: i } })) });
    if (!res.isError) applied += res.structuredContent.count;
  }
  const over = await call(r, "data_add_item", { command_id: cid(), collection: "@leo/trips", fields: {} });
  ok(`T19 after ${LIMIT} shared writes in an hour, the next is refused (rate_limited)`,
    applied === LIMIT && over.isError && reasonOf(over) === "rate_limited" && /hour/.test(textOf(over)), `applied=${applied} ${JSON.stringify(over).slice(0, 300)}`);
  const overOwn = await call(r, "data_add_item", { command_id: cid(), collection: "mine", fields: {} });
  ok("…the same account's writes to its OWN store are not limited", !overOwn.isError);
  const leifStill = await call(c, "data_add_item", { command_id: cid(), collection: "@leo/trips", fields: { city: "leif-after-rate" } });
  ok("…and another account's budget is its own", !leifStill.isError, JSON.stringify(leifStill).slice(0, 200));
  await r.close();
  await c.close(); await o.close();
}

// T13a — the parent runtime posts its pref map into every child it mounts; a shared child is the
// OWNER's code and must get none of the recipient's settings.
{
  const rt = readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf-8");
  const blk = rt.match(/    let prefMap = null[\s\S]*?\n    function rebuildPrefs\(rows, ver\) \{[\s\S]*?\n    \}\n/);
  ok("T13a the runtime's pref block is extractable (rig integrity)", !!blk);
  const rows = [{ id: "s1", group: "", fields: { key: "theme", value: "dark" } },
    { id: "s2", group: "", fields: { key: "my_private_pref", value: "RECIPIENT-PRIVATE" } }];
  const prefsFor = (n, tier) => new Function("n", "tier", "rows", blk[0] + "; rebuildPrefs(rows, 1); return { prefMap, settingsIds };")(n, tier, rows);
  const shared = prefsFor("@leo/trip-planner", "shared");
  ok("T13a a shared child is posted NO recipient preferences (oma.pref falls back)",
    JSON.stringify(shared.prefMap) === "{}" && shared.settingsIds.size === 0, JSON.stringify(shared.prefMap));
  const local = prefsFor("my-board", "local");
  ok("…a local child still gets them", local.prefMap.my_private_pref === "RECIPIENT-PRIVATE" && local.prefMap.theme === "dark");
  ok("…and the shared child's boot and pref refresh do not even read settings",
    /noPrefs \? Promise\.resolve\(\)\s*:\s*readCollection\("settings"\)/.test(rt) && /if \(preset === "inert" \|\| noPrefs\) return;/.test(rt));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// S4 round 2: every access boundary the feature promises, pinned through the real tool layer as a
// recipient's AI would call it — variants of each round-1 fix (A), the file plane's limits (B), and
// breadth: names outside the grant, revocation, rebirth, attribution (C). Fresh accounts carry the
// cases that spend a write budget, so no case leans on another's leftovers.
console.log("15. S4 round 2 — fix variants · file-write limits · every tool against what was not granted");
const extraStores = [];
const newAccount = (p) => {
  const s = openStore(join(TMP, p, "store.db"));
  extraStores.push(s);
  world.addAccount(p, `${p.slice(2)}@example.com`, s);
  return s;
};
const LIMIT = storeMod.SHARED_WRITES_PER_HOUR ?? 600;
// A refusal for something outside the grant must read exactly like one for something that does not
// exist (the caller-supplied name the only byte allowed to differ), and neither may move a byte.
// `reset` runs before each call (re-arming a grant record the engine is expected to close), and
// `fpOf` is then the stores alone — the provider's record moving is that close, not a leak.
async function absentAlike(label, c, tool, argsFor, real, absent, { error = true, also = () => true, reset = () => {}, fpOf = fpAll } = {}) {
  reset();
  const before = fpOf();
  const rR = await call(c, tool, argsFor(real));
  const mid = fpOf();
  reset();
  const rA = await call(c, tool, argsFor(absent));
  const after = fpOf();
  const same = norm(rR, real) === norm(rA, absent);
  ok(label, (!error || (rR.isError && rA.isError)) && same && before === mid && mid === after && also(rR),
    `error=${!!rR.isError}/${!!rA.isError} identical=${same} moved=${before !== mid || mid !== after} :: ${JSON.stringify(rR).slice(0, 220)} || ${JSON.stringify(rA).slice(0, 220)}`);
  return rR;
}
// A second shared app of leo's, so "another granted collection" exists for leif.
save(leo, "two-app", { collections: { two: {} } });
const two1 = add(leo, "two", { n: 1 });
world.grant("u_leo", "u_leif", "two-app", "editor");
const ownerPref = leo.execute({ type: "add_item", command_id: cid(), collection: "settings", group: "", fields: { key: "owner_private_pref", value: "OWNER-PREF" }, actor: "agent" });
if (!ownerPref.ok) throw new Error(`fixture: ${JSON.stringify(ownerPref)}`);

console.log("15A. variants of the round-1 fixes");
{
  leifGrant.role = "editor";
  const c = await connect(leif, "u_leif");

  // X1 in a batch that mixes the three verbs, under an id the owner used for a private batch.
  const B = cid();
  const ob = leo.executeBatch([
    { type: "add_item", command_id: `${B}:0`, collection: "finances", fields: { secret: "A1-PRIVATE" } },
    { type: "update_item", command_id: `${B}:1`, id: trip1.id, fields: { a1: "owner" } },
    { type: "move_item", command_id: `${B}:2`, id: trip1.id, group: "a1-owner" }]);
  let before = fpAll();
  const mixed = await call(c, "apply_data_writes", { command_id: B, commands: [
    { type: "add_item", collection: "@leo/trips", fields: { a1: "leif" } },
    { type: "update_item", id: trip1.id, collection: "@leo/trips", fields: { a1: "leif" } },
    { type: "move_item", id: trip1.id, collection: "@leo/trips", group: "a1-leif" }] });
  ok("A1 apply_data_writes (add + update + move) under the owner's private batch id: refused whole, leaks nothing",
    ob.ok && mixed.isError && /command_id/.test(textOf(mixed)) && !JSON.stringify(mixed).includes("A1-PRIVATE")
    && !JSON.stringify(mixed).includes(ob.results[0].id) && fpAll() === before, JSON.stringify(mixed).slice(0, 300));
  // Same verb, same row, same collection — only the account differs: still not this caller's receipt.
  const B2 = cid();
  leo.executeBatch([{ type: "update_item", command_id: `${B2}:0`, id: trip1.id, collection: "trips", fields: { a1b: "owner" } }]);
  before = fpAll();
  const aligned = await call(c, "apply_data_writes", { command_id: B2, commands: [{ type: "update_item", id: trip1.id, collection: "@leo/trips", fields: { a1b: "leif" } }] });
  ok("A1 …even when type, row and collection all match the owner's command, a different account is refused (no false 'applied')",
    aligned.isError && /command_id/.test(textOf(aligned)) && leo.snapshot("trips").items.find((i) => i.id === trip1.id).fields.a1b === "owner" && fpAll() === before,
    JSON.stringify(aligned).slice(0, 300));
  const L = cid();
  const legit = [{ type: "add_item", collection: "@leo/trips", fields: { a1: "retry" } }, { type: "update_item", id: trip1.id, collection: "@leo/trips", fields: { a1r: 1 } }];
  const first = await call(c, "apply_data_writes", { command_id: L, commands: legit });
  const seq0 = leo.dataVersion().seq;
  const again = await call(c, "apply_data_writes", { command_id: L, commands: legit });
  ok("A1 …the recipient's own batch, retried, is its original receipt and writes nothing new",
    !first.isError && !again.isError && again.structuredContent.results[0].id === first.structuredContent.results[0].id && leo.dataVersion().seq === seq0,
    JSON.stringify(again).slice(0, 300));
  const X = cid();
  await call(c, "apply_data_writes", { command_id: X, commands: [{ type: "add_item", collection: "@leo/trips", fields: { a1x: 1 } }] });
  before = fpAll();
  const across = await call(c, "apply_data_writes", { command_id: X, commands: [{ type: "add_item", collection: "@leo/two", fields: { a1x: 2 } }] });
  ok("A1 …and its batch id replayed into ANOTHER shared app's collection is refused, nothing added there",
    across.isError && /command_id/.test(textOf(across)) && leo.countItems("two") === 1 && fpAll() === before, JSON.stringify(across).slice(0, 300));

  // X1 on the file plane: a single-shot write (the chunked commit cases went with the trio, 0.8.1).
  const Kw = cid();
  await leoFiles.put("trip-planner", "a2-owner.txt", "owner-a2", { command_id: Kw });
  before = fpAll();
  const overwrite = await call(c, "file_write", { command_id: Kw, app: "@leo/trip-planner", path: "a2-owner.txt", data_base64: b64("leif-a2") });
  ok("A2 file_write under the owner's command_id is refused and the owner's file keeps its bytes",
    overwrite.isError && /command_id/.test(textOf(overwrite)) && (await leoFiles.get("trip-planner", "a2-owner.txt")).bytes.toString() === "owner-a2" && fpAll() === before,
    JSON.stringify(overwrite).slice(0, 300));

  // X1 / T5 across apps: an owner's command id or a row of another app, through an id write.
  const Ku = cid();
  leo.execute({ type: "update_item", command_id: Ku, id: two1.id, fields: { owner: 1 }, actor: "agent" });
  const crossU = await call(c, "data_update_item", { command_id: Ku, id: trip1.id, collection: "@leo/trips", fields: { x: 1 } });
  ok("A3 data_update_item replaying the owner's id from ANOTHER app's row is refused", crossU.isError && reasonOf(crossU) === "command_id_reused", JSON.stringify(crossU).slice(0, 300));
  const Kx = cid();
  await call(c, "data_move_item", { command_id: Kx, id: trip1.id, collection: "@leo/trips", group: "a3" });
  const crossM = await call(c, "data_move_item", { command_id: Kx, id: two1.id, collection: "@leo/two", group: "a3" });
  ok("A3 data_move_item: the recipient's own id replayed onto a row of another shared app is refused",
    crossM.isError && reasonOf(crossM) === "command_id_reused" && leo.snapshot("two").items[0].group !== "a3", JSON.stringify(crossM).slice(0, 300));
  await absentAlike("A3 data_update_item on a row of ANOTHER granted app, named under this app's collection ≡ a row that does not exist",
    c, "data_update_item", (id) => ({ command_id: cid(), id, collection: "@leo/trips", fields: { x: 1 } }), two1.id, randomUUID());
  await absentAlike("A3 data_move_item on a row of an UNSHARED app, under a shared collection ≡ a row that does not exist",
    c, "data_move_item", (id) => ({ command_id: cid(), id, collection: "@leo/two", group: "g" }), fin1.id, randomUUID());

  // Code outside the shared runner: list rows, resources, windowed export, the widget runtime.
  const apps = (await call(c, "list_apps", {})).structuredContent.apps.filter((a) => a.shared);
  ok("A4 list_apps (visibility any): shared rows carry no source of any kind",
    apps.length >= 2 && apps.every((a) => !("ui" in a) && !("html" in a) && !("manifest" in a)) && !JSON.stringify(apps).includes("<script"), JSON.stringify(apps).slice(0, 300));
  const res = (await c.listResources()).resources;
  let readShared = null;
  try { readShared = await c.readResource({ uri: "ui://open-mcp-apps/@leo/trip-planner.html" }); } catch (e) { readShared = { threw: e.message }; }
  ok("A4 no ui:// resource exists for a shared app — none listed, and reading one by its guessed uri fails",
    res.every((r) => !r.uri.includes("@") && !/trip-planner|two-app/.test(r.uri)) && !!readShared.threw && !JSON.stringify(readShared).includes("<p>"), JSON.stringify(readShared).slice(0, 200));
  leifGrant.role = "viewer";
  const vh = (await call(c, "get_app_html", { name: "@leo/trip-planner", mount: true })).structuredContent;
  ok("A4 get_app_html for a viewer is tier shared too, with the shared preset (no messages, no source, no settings)",
    vh.tier === "shared" && vh.caps.send_message === false && vh.caps.read_source === false && vh.caps.settings_write === false && vh.caps.file_write === false);
  leifGrant.role = "editor";
  // The runtime's embed decides html / caps / tier before anything mounts: a handle-named app takes
  // the engine's answer (get_app_html → tier shared + sharedCaps) whatever the embedder supplied.
  const rt = readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf-8");
  const seg = rt.match(/    const preset = opts\.preset \|\| "live";\n[\s\S]*?\n    const noPrefs = [^\n]*\n/);
  ok("A4 the runtime's embed resolution block is extractable (rig integrity)", !!seg);
  const engineAnswer = { html: "<p>owner code</p>", tier: "shared", caps: { call_tools: ["data_list"], collections: ["@leo/trips"], send_message: false }, csp: null };
  const resolve = (n, opts) => new Function("n", "opts", "rawCall", "childPreviewSnapshot", "state",
    `return (async () => {${seg[0]}; return { html, caps, tier, noPrefs }; })();`)(n, opts, async () => ({ structuredContent: engineAnswer }), () => null, { host: "" });
  const e1 = await resolve("@leo/trip-planner", { preset: "live" });
  ok("A4 oma.embed of a handle: the engine's tier (shared) and caps, no prefs", e1.tier === "shared" && e1.caps === engineAnswer.caps && e1.noPrefs === true);
  const e2 = await resolve("@leo/trip-planner", { html: "<p>embedder's</p>" });
  ok("A4 …an embedder passing its own html still gets the engine's tier and caps for it", e2.tier === "shared" && e2.caps === engineAnswer.caps && e2.noPrefs === true);
  ok("A4 the @live brick mounts what get_app_html answered — its tier and caps, never a default",
    /const r = await rawCall\("get_app_html", \{ name \}\);[\s\S]*?caps: sc\.caps \|\| \{\},\n\s*tier: sc\.tier == null \? "local" : sc\.tier,/.test(rt));

  // T13a variants: a handle name alone, or tier shared alone, withholds the recipient's prefs.
  const blk = rt.match(/    let prefMap = null[\s\S]*?\n    function rebuildPrefs\(rows, ver\) \{[\s\S]*?\n    \}\n/);
  const rows = [{ id: "s1", group: "", fields: { key: "theme_accent", value: "#ff0000" } }, { id: "s2", group: "@leo/trip-planner", fields: { key: "k", value: "RECIPIENT-PRIVATE" } }];
  const prefsFor = (n, tier) => new Function("n", "tier", "rows", blk[0] + "; rebuildPrefs(rows, 1); return { prefMap, settingsIds };")(n, tier, rows);
  const p1 = prefsFor("@leo/trip-planner", "local"), p2 = prefsFor("plain-app", "shared");
  ok("A5 a handle-named child gets no prefs even if called local; a shared-tier child gets none whatever its name",
    JSON.stringify(p1.prefMap) === "{}" && p1.settingsIds.size === 0 && JSON.stringify(p2.prefMap) === "{}" && p2.settingsIds.size === 0);
  ok("A5 a settings change pushed by the parent rebuilds through the same guard (rebuildPrefs), and the child's push carries only prefMap",
    /if \(s\.collection === "settings"\) \{ rebuildPrefs\(s\.items, lastSettingsVersion\); push\(\); \}/.test(rt)
    && /prefs: prefMap \|\| \{\},/.test(rt) && /themeVars: themeVars\(prefMap \|\| \{\}\),/.test(rt));
  await c.close();
}

{
  // Per-recipient limits on batches and on copy_app.
  const limStore = newAccount("u_lim");
  world.grant("u_leo", "u_lim", "trip-planner", "editor");
  const r = await connect(limStore, "u_lim");
  for (const n of [200, 200, LIMIT - 401]) await call(r, "apply_data_writes", { command_id: cid(), commands: Array.from({ length: n }, () => ({ type: "add_item", collection: "@leo/trips", fields: { lim: 1 } })) });
  const rows0 = leo.countItems("trips");
  const straddle = await call(r, "apply_data_writes", { command_id: cid(), commands: [{ type: "add_item", collection: "@leo/trips", fields: { lim: 2 } }, { type: "update_item", id: trip1.id, collection: "@leo/trips", fields: { lim: 2 } }] });
  ok(`A6 a batch that would cross the hourly budget (${LIMIT - 1} used + 2) is refused whole — nothing applied`,
    straddle.isError && /rate_limited/.test(textOf(straddle)) && leo.countItems("trips") === rows0, JSON.stringify(straddle).slice(0, 300));
  const last = await call(r, "data_update_item", { command_id: cid(), id: trip1.id, collection: "@leo/trips", fields: { lim: 3 } });
  const past = await call(r, "data_move_item", { command_id: cid(), id: trip1.id, collection: "@leo/trips", group: "lim" });
  ok("A6 …the one write left is spent by an update, and a move after it is refused (every verb draws on it)",
    !last.isError && past.isError && reasonOf(past) === "rate_limited", JSON.stringify(past).slice(0, 200));
  const leoBefore = fp(leo);
  const cp = await copyApp(r, { command_id: cid(), app: "@leo/trip-planner", name: "lim-copy", with_data: true });
  ok("A6 copy_app with_data is a READ of the owner: it works with the budget spent, and the owner's store does not move",
    !cp.isError && limStore.countItems(cp.structuredContent.collections.trips) === leo.countItems("trips") && fp(leo) === leoBefore, JSON.stringify(cp).slice(0, 300));
  await r.close();
  const c = await connect(leif, "u_leif");
  const leifBefore = fp(leif);
  const big = await copyApp(c, { command_id: cid(), app: "@leo/bulk-app", name: "bulk-copy", with_data: true });
  ok(`A6 copy_app with_data past ${50_000} rows is refused before anything is saved`, big.isError && /more than one copy carries/.test(textOf(big)) && fp(leif) === leifBefore && leif.getApp("bulk-copy") === null,
    JSON.stringify(big).slice(0, 200));
  await c.close();
  const capStore = newAccount("u_cap");
  world.grant("u_leo", "u_cap", "bulk-app", "editor");
  const CAP = storeMod.SHARED_COLLECTION_MAX_ROWS ?? 50_000;
  leo.db.prepare("DELETE FROM item WHERE collection = 'bulk' AND id IN (SELECT id FROM item WHERE collection = 'bulk' LIMIT ?)").run(leo.countItems("bulk") - (CAP - 1));
  const k = await connect(capStore, "u_cap");
  const two = await call(k, "apply_data_writes", { command_id: cid(), commands: [{ type: "add_item", collection: "@leo/bulk", fields: {} }, { type: "add_item", collection: "@leo/bulk", fields: {} }] });
  ok(`A6 a batch whose SECOND add would pass ${CAP} rows is refused at that index, nothing applied`,
    two.isError && /Command 1/.test(textOf(two)) && /collection_full/.test(textOf(two)) && leo.countItems("bulk") === CAP - 1, JSON.stringify(two).slice(0, 300));
  await k.close();
}

console.log("15C. breadth — every tool, named outside the grant, answers like not-found and changes nothing");
{
  leifGrant.role = "editor";
  const c = await connect(leif, "u_leif");
  const U = "@leo/finance-app", N = "@leo/nope", UC = "@leo/finances", NC = "@leo/nothing";
  await absentAlike("C1 file_read of an UNSHARED app's real file ≡ a missing app", c, "file_read", (h) => ({ app: h, path: "ledger.csv" }), U, N);
  await absentAlike("C1 file_list (prefix) of an unshared app", c, "file_list", (h) => ({ app: h, prefix: "led" }), U, N);
  await absentAlike("C1 file_write over an unshared app's real file", c, "file_write", (h) => ({ command_id: cid(), app: h, path: "ledger.csv", data_base64: b64("pwn") }), U, N);
  await absentAlike("C1 file_delete of an unshared app's real file (with a forged request_state)", c, "file_delete", (h) => ({ command_id: cid(), app: h, path: "ledger.csv", actor: "human", request_state: "forged" }), U, N);
  await absentAlike("C1 get_app node of an unshared app", c, "get_app", (h) => ({ name: h, node: "x" }), U, N);
  await absentAlike("C1 get_app_html mount:true of an unshared app (and the caller's live pointer stays)", c, "get_app_html", (h) => ({ name: h, mount: true }), U, N);
  await absentAlike("C1 list_apps by the exact handle of an unshared app finds nothing", c, "list_apps", (h) => ({ name: h }), U, N,
    { error: false, also: (r) => r.structuredContent.total === 0 });
  await absentAlike("C1 copy_app of an unshared app (nothing copied, no confirmation offered)", c, "copy_app", (h) => ({ command_id: cid(), app: h, with_data: true }), U, N);
  await absentAlike("C1 share leave of an unshared app", c, "share", (h) => ({ action: "leave", app: h }), U, N);
  await absentAlike("C1 share list (participants) of an unshared app", c, "share", (h) => ({ action: "list", app: h }), U, N);
  await absentAlike("C1 preview_app_store_entry by a handle", c, "preview_app_store_entry", (h) => ({ name: h }), U, N);
  await absentAlike("C1 open_app of the SHARED app bound to an unshared collection", c, "open_app", (h) => ({ app: "@leo/trip-planner", collection: h }), UC, NC);
  await absentAlike("C1 open_app of the caller's OWN app bound to an unshared collection", c, "open_app", (h) => ({ app: "my-board", collection: h }), UC, NC);
  await absentAlike("C1 open_app of the shared app bound to the owner's settings", c, "open_app", (h) => ({ app: "@leo/trip-planner", collection: h }), "@leo/settings", NC);
  for (const [label, tool, argsFor] of [
    ["data_update_item", "data_update_item", (id) => ({ command_id: cid(), id, collection: "@leo/trips", fields: { x: 1 } })],
    ["data_move_item", "data_move_item", (id) => ({ command_id: cid(), id, collection: "@leo/trips", group: "g" })],
    ["data_delete_item", "data_delete_item", (id) => ({ command_id: cid(), id, collection: "@leo/trips", actor: "human" })],
    ["data_update_item (no collection)", "data_update_item", (id) => ({ command_id: cid(), id, fields: { x: 1 } })],
    ["data_move_item (no collection)", "data_move_item", (id) => ({ command_id: cid(), id, group: "g" })],
    ["data_delete_item (no collection)", "data_delete_item", (id) => ({ command_id: cid(), id })],
    ["apply_data_writes update", "apply_data_writes", (id) => ({ command_id: cid(), commands: [{ type: "update_item", id, collection: "@leo/trips", fields: { x: 1 } }, { type: "add_item", collection: "@leo/trips", fields: { y: 1 } }] })],
  ]) {
    await absentAlike(`C1 ${label} on a row of an UNSHARED collection ≡ a row that exists nowhere`, c, tool, argsFor, fin1.id, randomUUID());
    await absentAlike(`C1 ${label} on the owner's SETTINGS row ≡ a row that exists nowhere`, c, tool, argsFor, ownerPref.id, randomUUID());
  }
  const ch = await call(c, "data_changes", { collection: "@leo/trips", since: 0, limit: 500 });
  const evs = JSON.stringify(ch.structuredContent.events);
  ok("C1 data_changes on a shared collection carries its item events only — no app, file, settings or other-collection event",
    !ch.isError && ch.structuredContent.events.every((e) => /^item_/.test(e.type)) && !/PRIVATE|salary|ledger|owner_private_pref|finances|component_|file_/.test(evs), evs.slice(0, 300));
  const cols = await call(c, "list_data_collections", {});
  ok("C1 list_data_collections names only granted collections of leo's (no finances, no settings)",
    !/@leo\/(finances|settings)/.test(textOf(cols)) && cols.structuredContent.collections.filter((x) => x.shared).every((x) => ["@leo/trips", "@leo/two", "@leo/bulk"].includes(x.collection)),
    textOf(cols).slice(0, 300));
  await c.close();
}

{
  // Revocation: in force on the very next call, for every tool — both when the alias goes away
  // entirely (u_rev holds nothing else of leo's) and when it stays for another app (leif).
  save(leo, "rev-app", { collections: { rev: {} } });
  const rev1 = add(leo, "rev", { r: 1 });
  await leoFiles.put("rev-app", "r.txt", "rev-bytes");
  const revStore = newAccount("u_rev");
  world.grant("u_leo", "u_rev", "rev-app", "editor");
  world.grant("u_leo", "u_leif", "rev-app", "editor");
  for (const [who, store] of [["u_rev", revStore], ["u_leif", leif]]) {
    const c = await connect(store, who);
    const okBefore = !(await call(c, "data_list", { collection: "@leo/rev" })).isError;
    for (const g of world.grants) if (g.recipient === who && g.app === "rev-app") g.status = "revoked";
    const H = "@leo/rev-app", HC = "@leo/rev", NA = "@leo/nope", NCo = "@leo/nothing";
    const tag = `C2 revoked (${who === "u_rev" ? "alias gone" : "alias still holds another app"})`;
    ok(`${tag}: (granted and working before)`, okBefore);
    await absentAlike(`${tag}: data_list`, c, "data_list", (h) => ({ collection: h }), HC, NCo);
    await absentAlike(`${tag}: data_changes`, c, "data_changes", (h) => ({ collection: h, since: 0 }), HC, NCo);
    await absentAlike(`${tag}: get_data_version (the open widget's probe)`, c, "get_data_version", (h) => ({ collection: h }), HC, NCo);
    await absentAlike(`${tag}: data_add_item`, c, "data_add_item", (h) => ({ command_id: cid(), collection: h, fields: { x: 1 } }), HC, NCo);
    await absentAlike(`${tag}: data_update_item by id alone`, c, "data_update_item", (id) => ({ command_id: cid(), id, fields: { x: 1 } }), rev1.id, randomUUID());
    await absentAlike(`${tag}: open_app`, c, "open_app", (h) => ({ app: h }), H, NA);
    await absentAlike(`${tag}: get_app_html`, c, "get_app_html", (h) => ({ name: h, mount: true }), H, NA);
    await absentAlike(`${tag}: get_app`, c, "get_app", (h) => ({ name: h }), H, NA);
    await absentAlike(`${tag}: file_read`, c, "file_read", (h) => ({ app: h, path: "r.txt" }), H, NA);
    await absentAlike(`${tag}: file_write`, c, "file_write", (h) => ({ command_id: cid(), app: h, path: "late.txt", data_base64: b64("late") }), H, NA);
    await absentAlike(`${tag}: copy_app`, c, "copy_app",
      (h) => ({ command_id: cid(), app: h, name: `rev-copy-${who.slice(2)}`, with_data: true }), H, NA,
      { also: () => store.getApp(`rev-copy-${who.slice(2)}`) === null });
    await absentAlike(`${tag}: share list`, c, "share", (h) => ({ action: "list", app: h }), H, NA);
    ok(`${tag}: gone from list_apps and list_data_collections`,
      !textOf(await call(c, "list_apps", {})).includes("rev-app") && !textOf(await call(c, "list_data_collections", {})).includes("@leo/rev"));
    await c.close();
  }
  // A demotion takes effect the same way: the next write after it is a viewer's.
  const demStore = newAccount("u_dem");
  world.grant("u_leo", "u_dem", "rev-app", "editor");
  const d = await connect(demStore, "u_dem");
  const dPre = await call(d, "file_write", { command_id: cid(), app: "@leo/rev-app", path: "as-editor.txt", data_base64: b64("as-editor") });
  world.grants.find((g) => g.recipient === "u_dem").role = "viewer";
  const before = fpAll();
  const dWrite = await call(d, "file_write", { command_id: cid(), app: "@leo/rev-app", path: "demoted.txt", data_base64: b64("as-viewer") });
  const dAdd = await call(d, "data_add_item", { command_id: cid(), collection: "@leo/rev", fields: { x: 1 } });
  const dDel = await call(d, "data_delete_item", { command_id: cid(), id: rev1.id, collection: "@leo/rev", actor: "human" });
  ok("C2 demoted to viewer: a file write that worked as editor is now read_only, as are item writes and deletes",
    !dPre.isError && reasonOf(dWrite) === "read_only" && reasonOf(dAdd) === "read_only" && reasonOf(dDel) === "read_only" && fpAll() === before && !openFileChannel(leo).stat("rev-app", "demoted.txt"),
    JSON.stringify([dPre, dWrite, dDel]).slice(0, 300));
  await d.close();
}

{
  // Rebirth: a delete (kept data, kept files) and a same-name recreate — or a restore — grant nothing.
  save(leo, "reborn", { collections: { "reborn-c": {} } });
  const old1 = add(leo, "reborn-c", { era: "first" });
  await leoFiles.put("reborn", "keep.txt", "first-life");
  world.grant("u_leo", "u_leif", "reborn", "editor");
  const c = await connect(leif, "u_leif");
  const o = await connect(leo, "u_leo");
  const del = await call(o, "delete_app", { command_id: cid(), name: "reborn" });
  const orphan = await call(c, "data_list", { collection: "@leo/reborn-c" });
  ok("C3 deleted with its data KEPT: the orphaned collection is not reachable", !del.isError && orphan.isError && reasonOf(orphan) === "not_shared" && leo.countItems("reborn-c") === 1);
  leo.execute({ type: "save_app", command_id: cid(), name: "reborn", ui: "<p>second life, private</p>", manifest: { collections: { "reborn-c": {} } }, actor: "agent" });
  await leoFiles.put("reborn", "new.txt", "second-life");
  const old2 = add(leo, "reborn-c", { era: "second" });
  // Every call below meets the old grant record still ACTIVE (a provider that never closed it), so
  // the refusal is the engine's own birth check, not the record.
  const rearm = { reset: () => { for (const g of world.grants) if (g.app === "reborn") g.status = "active"; }, fpOf: () => fp(leo) + fp(leif) + fp(mia) };
  const endedBefore = world.ended.length;
  const H = "@leo/reborn", HC = "@leo/reborn-c", NA = "@leo/nope", NCo = "@leo/nothing";
  await absentAlike("C3 reborn: data_list", c, "data_list", (h) => ({ collection: h }), HC, NCo, rearm);
  await absentAlike("C3 reborn: data_add_item", c, "data_add_item", (h) => ({ command_id: cid(), collection: h, fields: { x: 1 } }), HC, NCo, rearm);
  await absentAlike("C3 reborn: data_update_item by id alone (a first-life row)", c, "data_update_item", (id) => ({ command_id: cid(), id, fields: { x: 1 } }), old1.id, randomUUID(), rearm);
  await absentAlike("C3 reborn: data_update_item by id alone (a second-life row)", c, "data_update_item", (id) => ({ command_id: cid(), id, fields: { x: 1 } }), old2.id, randomUUID(), rearm);
  await absentAlike("C3 reborn: open_app", c, "open_app", (h) => ({ app: h }), H, NA, rearm);
  await absentAlike("C3 reborn: get_app_html", c, "get_app_html", (h) => ({ name: h }), H, NA, rearm);
  await absentAlike("C3 reborn: get_app", c, "get_app", (h) => ({ name: h }), H, NA, rearm);
  await absentAlike("C3 reborn: file_read of the new life's file", c, "file_read", (h) => ({ app: h, path: "new.txt" }), H, NA, rearm);
  await absentAlike("C3 reborn: file_write", c, "file_write", (h) => ({ command_id: cid(), app: h, path: "x.txt", data_base64: b64("x") }), H, NA, rearm);
  await absentAlike("C3 reborn: copy_app", c, "copy_app", (h) => ({ command_id: cid(), app: h, with_data: true }), H, NA, rearm);
  await absentAlike("C3 reborn: data_changes", c, "data_changes", (h) => ({ collection: h, since: 0 }), HC, NCo, rearm);
  rearm.reset();
  ok("C3 reborn: not listed — and the engine reported the old grant dead to the provider",
    !textOf(await call(c, "list_apps", {})).includes("@leo/reborn") && world.ended.length > endedBefore);
  // A restore after a delete starts a new life too: the share does not come back with it.
  save(leo, "restorable", { collections: { restorable: {} } });
  add(leo, "restorable", { r: 1 });
  world.grant("u_leo", "u_leif", "restorable", "editor");
  await call(o, "delete_app", { command_id: cid(), name: "restorable" });
  const restored = await call(o, "restore_app", { command_id: cid(), name: "restorable", checkpoint: 1 });
  for (const g of world.grants) if (g.app === "restorable") g.status = "active";
  const afterRestore = await call(c, "data_list", { collection: "@leo/restorable" });
  ok("C3 deleted then RESTORED: the old grant still reaches nothing", !restored.isError && !!leo.getApp("restorable") && afterRestore.isError && reasonOf(afterRestore) === "not_shared",
    JSON.stringify([restored, afterRestore]).slice(0, 300));
  await c.close(); await o.close();
}

{
  // Attribution: the account is stamped by the server; nothing in the arguments can name another.
  const c = await connect(leif, "u_leif", { clientName: "chatgpt" });
  const forge = { principal: "u_leo", principal_label: "leo@example.com", by: "leo@example.com", host: "forged-host" };
  const evOf = (seq) => leo.db.prepare("SELECT principal, actor, host FROM change_event WHERE seq = ?").get(seq);
  const isLeif = (e) => e && e.principal === "u_leif" && e.host === "chatgpt";
  const b = await call(c, "apply_data_writes", { command_id: cid(), commands: [
    { type: "add_item", collection: "@leo/trips", fields: { attr: 1 }, ...forge },
    { type: "update_item", id: trip1.id, collection: "@leo/trips", fields: { attr: 2 }, ...forge }] });
  ok("C4 apply_data_writes: principal / label / host inside a command are ignored — both events are leif's, from chatgpt",
    !b.isError && b.structuredContent.results.every((x) => isLeif(evOf(x.seq))), JSON.stringify(b.structuredContent?.results?.map((x) => evOf(x.seq))));
  const u = await call(c, "data_update_item", { command_id: cid(), id: trip1.id, collection: "@leo/trips", fields: { attr: 3 }, ...forge });
  const m = await call(c, "data_move_item", { command_id: cid(), id: trip1.id, collection: "@leo/trips", group: "attr", ...forge });
  ok("C4 data_update_item / data_move_item: same", isLeif(evOf(u.structuredContent.seq)) && isLeif(evOf(m.structuredContent.seq)));
  const victimRow = add(leo, "trips", { attr: "victim" });
  const ask = await call(c, "data_delete_item", { command_id: cid(), id: victimRow.id, collection: "@leo/trips", ...forge });
  const yes = await call(c, "data_delete_item", { command_id: cid(), id: victimRow.id, collection: "@leo/trips", request_state: ask.structuredContent?.request_state, ...forge });
  ok("C4 data_delete_item (confirmed): the delete event is leif's", !yes.isError && isLeif(evOf(yes.structuredContent.seq)), JSON.stringify(yes).slice(0, 200));
  const fw = await call(c, "file_write", { command_id: cid(), app: "@leo/trip-planner", path: "attr.txt", data_base64: b64("a"), ...forge });
  const fwEv = leo.db.prepare("SELECT principal, host FROM change_event WHERE event_type = 'file_written' AND aggregate_id = ? ORDER BY seq DESC LIMIT 1").get("trip-planner/attr.txt");
  ok("C4 file_write: the file event is leif's", !fw.isError && fwEv?.principal === "u_leif", JSON.stringify(fwEv));
  const badActor = await call(c, "data_add_item", { command_id: cid(), collection: "@leo/trips", fields: { x: 1 }, actor: "owner" });
  ok("C4 an actor class outside human|agent is refused, nothing written", badActor.isError);
  ok("C4 …and leo's store still labels u_leif as leif, and no forged label was recorded",
    leo.principalLabel("u_leif") === "leif@example.com" && leo.db.prepare("SELECT COUNT(*) AS n FROM principal WHERE id = 'u_leo' AND label <> 'leo@example.com'").get().n === 0);
  const o = await connect(leo, "u_leo");
  const seen = await call(o, "data_changes", { collection: "trips", since: u.structuredContent.seq - 1 });
  ok("C4 the owner's data_changes names leif for those events, never leo", seen.structuredContent.events.filter((e) => e.seq === u.structuredContent.seq).every((e) => e.by === "leif@example.com"));
  await c.close(); await o.close();
}

console.log("15B. the file plane through a share — the same hourly budget, a per-app ceiling");
{
  // B1 — the hourly budget covers file writes and is ONE budget with items.
  const fStore = newAccount("u_files");
  world.grant("u_leo", "u_files", "trip-planner", "editor");
  const f = await connect(fStore, "u_files");
  let stored = 0;
  for (let i = 0; i < LIMIT; i++) {
    const r = await call(f, "file_write", { command_id: cid(), app: "@leo/trip-planner", path: `b1/${i}.txt`, data_base64: b64(`b1-${i}`) });
    if (!r.isError) stored++;
  }
  const over = await call(f, "file_write", { command_id: cid(), app: "@leo/trip-planner", path: "b1/over.txt", data_base64: b64("over") });
  ok(`B1 after ${LIMIT} file writes through a share in an hour, the next file_write is refused (rate_limited)`,
    stored === LIMIT && over.isError && reasonOf(over) === "rate_limited" && !openFileChannel(leo).stat("trip-planner", "b1/over.txt"),
    `stored=${stored} ${JSON.stringify(over).slice(0, 200)}`);
  const item = await call(f, "data_add_item", { command_id: cid(), collection: "@leo/trips", fields: { b1: 1 } });
  ok("B1 …and an item write: files and rows draw on one budget", item.isError && reasonOf(item) === "rate_limited", JSON.stringify(item).slice(0, 200));
  await f.close();
  const mStore = newAccount("u_mixed");
  world.grant("u_leo", "u_mixed", "trip-planner", "editor");
  const mx = await connect(mStore, "u_mixed");
  for (const n of [200, 200, LIMIT - 400]) await call(mx, "apply_data_writes", { command_id: cid(), commands: Array.from({ length: n }, () => ({ type: "add_item", collection: "@leo/trips", fields: { mixed: 1 } })) });
  const fAfterItems = await call(mx, "file_write", { command_id: cid(), app: "@leo/trip-planner", path: "b1/after-items.txt", data_base64: b64("x") });
  ok(`B1 an account that spent its ${LIMIT} on rows cannot keep writing through files`, fAfterItems.isError && reasonOf(fAfterItems) === "rate_limited", JSON.stringify(fAfterItems).slice(0, 200));
  await mx.close();
  const o = await connect(leo, "u_leo");
  const ownWrite = await call(o, "file_write", { command_id: cid(), app: "trip-planner", path: "b1/owner.txt", data_base64: b64("owner") });
  ok("B1 the owner's own file writes are not limited", !ownWrite.isError);

  // B2 — a per-app ceiling on what collaborators may make an app's files hold (count and bytes).
  const MAXF = storeMod.SHARED_APP_MAX_FILES ?? 1_000, MAXB = storeMod.SHARED_APP_MAX_FILE_BYTES ?? 1024 ** 3;
  const Z = "0".repeat(64);
  save(leo, "files-app", { collections: { "files-c": {} } });
  leo.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO file (app, path, sha256, size, mime, version, created_at, updated_at) SELECT 'files-app', 'f-' || i, ?, 1, 'text/plain', 1, 'ts', 'ts' FROM n`).run(MAXF, Z);
  const capStore = newAccount("u_fcap");
  world.grant("u_leo", "u_fcap", "files-app", "editor");
  const k = await connect(capStore, "u_fcap");
  const more = await call(k, "file_write", { command_id: cid(), app: "@leo/files-app", path: "one-more.txt", data_base64: b64("x") });
  ok(`B2 a shared app already holding ${MAXF} files refuses a collaborator's NEW file (app_files_full)`,
    more.isError && reasonOf(more) === "app_files_full" && !openFileChannel(leo).stat("files-app", "one-more.txt"), JSON.stringify(more).slice(0, 200));
  const replace = await call(k, "file_write", { command_id: cid(), app: "@leo/files-app", path: "f-1", data_base64: b64("replaced") });
  ok("B2 …an overwrite that adds no file is still fine", !replace.isError, JSON.stringify(replace).slice(0, 200));
  const ownMore = await call(o, "file_write", { command_id: cid(), app: "files-app", path: "owner-more.txt", data_base64: b64("x") });
  ok("B2 …and the owner's own new file is not capped by it", !ownMore.isError);
  save(leo, "bytes-app", { collections: { "bytes-c": {} } });
  leo.db.prepare("INSERT INTO file (app, path, sha256, size, mime, version, created_at, updated_at) VALUES ('bytes-app', 'huge.bin', ?, ?, 'application/octet-stream', 1, 'ts', 'ts')").run(Z, MAXB - 5);
  world.grant("u_leo", "u_fcap", "bytes-app", "editor");
  const tooBig = await call(k, "file_write", { command_id: cid(), app: "@leo/bytes-app", path: "ten.bin", data_base64: b64("0123456789") });
  const fits = await call(k, "file_write", { command_id: cid(), app: "@leo/bytes-app", path: "three.bin", data_base64: b64("abc") });
  ok("B2 the bytes ceiling: a collaborator's write that would pass it is refused, one that fits lands",
    tooBig.isError && reasonOf(tooBig) === "app_files_full" && !fits.isError, JSON.stringify([tooBig, fits]).slice(0, 300));
  const ownBig = await call(o, "file_write", { command_id: cid(), app: "bytes-app", path: "owner-ten.bin", data_base64: b64("0123456789") });
  ok("B2 …while the owner may fill their own app", !ownBig.isError);
  await k.close();

  await o.close();
}

for (const s of [leo, leif, mia, rateStore, ...extraStores]) s.close();
rmSync(TMP, { recursive: true, force: true });
console.log(`hosted surface (OSS + share + copy_app): ${hostedBytes} B`);
console.log(fail ? `FAILURES: ${pass} passed, ${fail} failed` : `ALL PASS: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
