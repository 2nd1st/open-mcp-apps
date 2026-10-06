// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/sharing-store.mjs — the STORE half of cross-account sharing (docs/sharing-design-2026-10-02.md
// §9 S1): schema v8 and its rung, the principal axis, the reserved `@` prefix, id-addressed writes
// that name their collection, the per-collection probe, and the scoped facade — the one wall a
// recipient's reach into an owner's store goes through.
//
// The facade section asks ONE question of every method, on purpose: given something OUTSIDE the
// grant (a collection, a row, an app, a file), is it refused — and is the refusal the
// very same answer as for something that does not exist at all? A refusal that differs from
// absence is an oracle for what the owner keeps.
// Run: node test/sharing-store.mjs
import Database from "better-sqlite3";
import { rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore, SCHEMA_VERSION, principalScope, scopeStore, sharedScopeOf, SHARE_ROLES } from "../src/store.mjs";
import { openFileChannel } from "../src/files.mjs";
import { TIER_CAPS, sharedCaps } from "../src/contracts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, "test", "sharing-store-tmp");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cid = () => randomUUID();

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("1. v7 → v8: one added column, one added table, every existing row byte-identical (and on through v9)");
{
  const P = join(TMP, "v7.db");
  const raw = new Database(P);
  // The v7 shape exactly as v0.7.x wrote it (no change_event.principal, no principal table).
  raw.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, collection TEXT NOT NULL, grp TEXT NOT NULL DEFAULT '', position REAL NOT NULL DEFAULT 0, fields TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE INDEX idx_item_collection ON item(collection);
            CREATE INDEX idx_item_coll_grp_pos ON item(collection, grp, position);
            CREATE TABLE app (name TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, ui TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT 'agent', scene TEXT, manifest TEXT, kind TEXT NOT NULL DEFAULT 'app', visibility TEXT NOT NULL DEFAULT 'listed', updated_at TEXT NOT NULL);
            CREATE TABLE app_history (name TEXT NOT NULL, version INTEGER NOT NULL, ui TEXT NOT NULL, manifest TEXT, ts TEXT NOT NULL, PRIMARY KEY (name, version));
            CREATE TABLE file (app TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL DEFAULT 'application/octet-stream', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (app, path));
            CREATE INDEX idx_file_app ON file(app);
            CREATE INDEX idx_file_sha ON file(app, sha256);
            CREATE TABLE change_event (seq INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_id TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, payload TEXT NOT NULL, actor TEXT NOT NULL, host TEXT, ts TEXT NOT NULL);
            CREATE INDEX idx_event_settings ON change_event(seq) WHERE json_extract(payload, '$.collection') = 'settings';
            CREATE INDEX idx_event_file ON change_event(seq) WHERE event_type = 'file_written' OR event_type = 'file_deleted';
            CREATE INDEX idx_event_collection ON change_event(json_extract(payload, '$.collection'), seq);
            CREATE TABLE live_pointer (id INTEGER PRIMARY KEY CHECK (id = 1), app TEXT NOT NULL, ts TEXT NOT NULL, n INTEGER NOT NULL);`);
  raw.prepare("INSERT INTO change_event (aggregate_id, command_id, event_type, payload, actor, host, ts) VALUES ('r1','c1','item_added',?,'human','claude','2026-09-01T00:00:00.000Z')")
     .run(JSON.stringify({ collection: "trips", group: "", position: 1, fields: { city: "Oslo" }, sv: 7 }));
  raw.prepare("INSERT INTO item (id, collection, grp, position, fields, version, created_at, updated_at) VALUES ('r1','trips','',1,?,1,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')")
     .run(JSON.stringify({ city: "Oslo" }));
  raw.prepare("INSERT INTO change_event (aggregate_id, command_id, event_type, payload, actor, host, ts) VALUES ('trip-planner','c2','component_saved',?,'agent',NULL,'2026-09-01T00:00:01.000Z')")
     .run(JSON.stringify({ name: "trip-planner", size: 8, created: true, sv: 7 }));
  raw.prepare("INSERT INTO app (name, version, ui, updated_at) VALUES ('trip-planner', 2, '<p>x</p>', 'T')").run();
  raw.prepare("INSERT INTO app_history (name, version, ui, ts) VALUES ('trip-planner', 2, '<p>x</p>', 'T')").run();
  raw.prepare("INSERT INTO live_pointer (id, app, ts, n) VALUES (1, 'trip-planner', 'T', 4)").run();
  raw.pragma("user_version = 7");
  const before = {
    item: raw.prepare("SELECT * FROM item ORDER BY id").all(),
    events: raw.prepare("SELECT * FROM change_event ORDER BY seq").all(),
    app: raw.prepare("SELECT * FROM app").all(),
    hist: raw.prepare("SELECT * FROM app_history").all(),
    live: raw.prepare("SELECT * FROM live_pointer").all(),
  };
  raw.close();

  const s = openStore(P);
  // The ladder climbs every rung in one open, so this store arrives at the CURRENT version — v9
  // added `skill` to app and app_history (test/app-skill.mjs owns that rung). Those two columns are
  // set aside here, and must be NULL: everything else this rung promised still holds byte for byte.
  ok(`v7 → v${SCHEMA_VERSION}: stamped with the current version`, s.db.pragma("user_version", { simple: true }) === SCHEMA_VERSION && SCHEMA_VERSION >= 8);
  ok("item rows byte-identical", same(s.db.prepare("SELECT * FROM item ORDER BY id").all(), before.item));
  const noSkill = (rows) => rows.every((r) => r.skill === null && r.skill_from === null) && rows.map(({ skill, skill_from, ...r }) => r);
  ok("app, app_history and live_pointer rows byte-identical (plus a NULL skill on the app rows)",
    same(noSkill(s.db.prepare("SELECT * FROM app").all()), before.app) && same(noSkill(s.db.prepare("SELECT * FROM app_history").all()), before.hist)
    && same(s.db.prepare("SELECT * FROM live_pointer").all(), before.live));
  const after = s.db.prepare("SELECT * FROM change_event ORDER BY seq").all();
  ok("every ledger row keeps every old column byte-identical, and gains principal = NULL",
    after.length === before.events.length && after.every((r, i) => {
      const { principal, ...old } = r;
      return principal === null && same(old, before.events[i]);
    }), JSON.stringify(after));
  ok("the principal table exists and is empty",
    s.db.prepare("SELECT COUNT(*) AS n FROM principal").get().n === 0);
  ok("old events read back with no `principal` key at all — a local event's shape is unchanged",
    s.changesSince("trips", 0).events.every((e) => !("principal" in e)));
  s.close();
  // A store from the future still refuses (the gate moved, it did not open up).
  const F = join(TMP, "future.db");
  const f = new Database(F); f.exec("CREATE TABLE item (id TEXT PRIMARY KEY, collection TEXT NOT NULL, grp TEXT NOT NULL DEFAULT '', position REAL NOT NULL DEFAULT 0, fields TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  f.pragma(`user_version = ${SCHEMA_VERSION + 1}`); f.close();
  let refused = null; try { openStore(F); } catch (e) { refused = e.message; }
  ok(`a v${SCHEMA_VERSION + 1} store is refused by this build`, /update open-mcp-apps/.test(refused || ""));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("2. the principal axis — stamped from the scope, never from a command");
const S = openStore(join(TMP, "owner.db"));
{
  const outside = S.execute({ type: "add_item", command_id: cid(), collection: "p-test", fields: { a: 1 }, actor: "human", principal: "forged" });
  const row = (seq) => S.db.prepare("SELECT principal FROM change_event WHERE seq = ?").get(seq).principal;
  ok("outside any scope: principal is NULL even when the command carries one", outside.ok && row(outside.seq) === null);
  const inside = principalScope.run({ principal: "user_leif", label: "leif@example.com" },
    () => S.execute({ type: "add_item", command_id: cid(), collection: "p-test", fields: { a: 2 }, actor: "agent", principal: "forged" }));
  ok("inside a scope: the scope's principal is stamped and the command's is ignored", inside.ok && row(inside.seq) === "user_leif");
  ok("…and its label is recorded in the principal table", S.principalLabel("user_leif") === "leif@example.com");
  principalScope.run({ principal: "user_leif", label: "leif@new.example" },
    () => S.execute({ type: "update_item", command_id: cid(), id: inside.id, fields: { a: 3 }, actor: "human" }));
  ok("a later write refreshes the label", S.principalLabel("user_leif") === "leif@new.example");
  const b = principalScope.run({ principal: "user_mia" },
    () => S.executeBatch([{ type: "add_item", collection: "p-test", fields: { a: 4 }, principal: "forged", command_id: cid() }]));
  ok("a batch is stamped from the scope too (and a batch command's own principal is dropped)",
    b.ok && row(b.results[0].seq) === "user_mia");
  const ev = S.changesSince("p-test", 0).events;
  ok("changesSince carries principal only on events an authenticated caller wrote",
    !("principal" in ev[0]) && ev[1].principal === "user_leif" && ev.at(-1).principal === "user_mia");
  const writers = S.writersOf([outside.seq, inside.seq, b.results[0].seq], "p-test");
  ok("writersOf answers for authenticated writers only, in the named collection",
    writers.size === 2 && !writers.has(outside.seq) && writers.get(inside.seq) === "user_leif"
    && writers.get(b.results[0].seq) === "user_mia" && S.writersOf([b.results[0].seq], "elsewhere").size === 0);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("3. `@` is the shared namespace — no local collection may be spelled like a handle");
{
  const r = S.execute({ type: "add_item", command_id: cid(), collection: "@leo/trips", fields: {}, actor: "agent" });
  ok("add_item into an @-name is refused", r.ok === false && r.error === "reserved_collection");
  const r2 = S.execute({ type: "add_item", command_id: cid(), collection: "  @x", fields: {}, actor: "agent" });
  ok("…after the same trim every write applies", r2.ok === false && r2.error === "reserved_collection");
  const bad = S.execute({ type: "save_app", command_id: cid(), name: "decl-at", ui: "<p>x</p>", manifest: { collections: { "@leo/trips": {} } }, actor: "agent" });
  ok("a manifest may not declare an @-name", bad.ok === false && bad.error === "bad_manifest" && /begins with "@"/.test(bad.detail));
  const batch = S.executeBatch([{ type: "add_item", collection: "@a", fields: {}, command_id: cid() }]);
  ok("…and a batch cannot slip one in", batch.ok === false && batch.failure?.error === "reserved_collection");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("4. id-addressed writes may name their collection — and a mismatch reads as absence");
{
  const a = S.execute({ type: "add_item", command_id: cid(), collection: "c-one", fields: { t: 1 }, actor: "agent" });
  const missing = (type) => S.execute({ type, command_id: cid(), id: randomUUID(), fields: { t: 9 }, actor: "agent" });
  for (const type of ["update_item", "move_item", "delete_item"]) {
    const wrong = S.execute({ type, command_id: cid(), id: a.id, collection: "c-two", fields: { t: 9 }, group: "g", actor: "agent" });
    ok(`${type} with the wrong collection is refused exactly like a missing id`, same(wrong, missing(type)) && wrong.error === "not_found", JSON.stringify(wrong));
  }
  ok("…and the row is untouched", S.snapshot("c-one").items[0].fields.t === 1);
  const right = S.execute({ type: "update_item", command_id: cid(), id: a.id, collection: "c-one", fields: { t: 2 }, actor: "agent" });
  ok("the right collection writes", right.ok && right.item.fields.t === 2);
  const bOk = S.executeBatch([{ type: "update_item", id: a.id, collection: "c-one", fields: { t: 3 }, command_id: cid() }]);
  const bBad = S.executeBatch([{ type: "update_item", id: a.id, collection: "c-two", fields: { t: 4 }, command_id: cid() }]);
  ok("a batch carries the assertion too", bOk.ok && bBad.ok === false && bBad.failure?.error === "not_found");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("5. dataVersion({collection}) — one collection's mark");
{
  const before = S.dataVersion({ collection: "c-one" }).seq;
  S.execute({ type: "add_item", command_id: cid(), collection: "c-elsewhere", fields: {}, actor: "agent" });
  ok("a write elsewhere moves the global seq and NOT the collection's", S.dataVersion({ collection: "c-one" }).seq === before && S.dataVersion().seq > before);
  const w = S.execute({ type: "add_item", command_id: cid(), collection: "c-one", fields: {}, actor: "agent" });
  ok("a write in it moves it to that write's seq", S.dataVersion({ collection: "c-one" }).seq === w.seq);
  ok("no argument = the global probe, exactly as before", S.dataVersion().seq === S.db.prepare("SELECT MAX(seq) AS v FROM change_event").get().v);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("6. the caps a shared app runs under");
{
  const v = sharedCaps("viewer", ["@leo/trips"]), e = sharedCaps("editor", ["@leo/trips"]);
  ok("TIER_CAPS.shared exists and sends nothing, reads no source, writes no settings",
    TIER_CAPS.shared.send_message === false && TIER_CAPS.shared.read_source === false && TIER_CAPS.shared.settings_write === false
    && TIER_CAPS.shared.cross_collection_read === false && TIER_CAPS.shared.cross_collection_write === false);
  ok("viewer: no writes, no deletes, no file writes; collections carried",
    v.delete_items === "deny" && v.file_write === false && !v.call_tools.some((t) => /add|update|move|delete|write/.test(t)) && same(v.collections, ["@leo/trips"]));
  ok("editor: writes, deletes behind confirmation, file writes",
    e.delete_items === "confirm" && e.file_write === true && e.call_tools.includes("data_update_item") && e.call_tools.includes("file_write"));
  ok("no shared caps ever name a control-plane or chat tool",
    !e.call_tools.some((t) => /app|call_function|security|list_data_collections|send/.test(t)));
  ok("the preset is never mutated by sharedCaps", !TIER_CAPS.shared.call_tools.includes("data_add_item") && !("collections" in TIER_CAPS.shared));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("7. the facade — every method, against something outside the grant AND something absent");
const files = openFileChannel(S);
const save = (name, manifest, author = "agent") => {
  const cur = S.getApp(name);
  return S.execute({ type: "save_app", command_id: cid(), name, ui: `<p>${name}</p>`, ...(manifest !== undefined ? { manifest } : {}), actor: author, ...(cur ? { expected_version: cur.version } : {}) });
};
save("trip-planner", { collections: { trips: {} } });
save("finance-app", { collections: { finances: {} } });
const t1 = S.execute({ type: "add_item", command_id: cid(), collection: "trips", fields: { city: "Oslo" }, actor: "agent" });
const f1 = S.execute({ type: "add_item", command_id: cid(), collection: "finances", fields: { amount: 9000 }, actor: "agent" });
S.execute({ type: "add_item", command_id: cid(), collection: "settings", fields: { key: "user_name", value: "Leo" }, actor: "human" });
await files.put("trip-planner", "map.png", "trip-bytes", { mime: "image/png" });
await files.put("finance-app", "ledger.csv", "secret-bytes", { mime: "text/csv" });
const birth = S.appBirth("trip-planner");
const face = (role, extra = []) => scopeStore(S, { grants: [{ app: "trip-planner", appBirth: birth, role }, ...extra], files });
const V = face("viewer"), E = face("editor");
const ghost = randomUUID();
{
  ok("scope: the app's binding, nothing else", same(E.scope().collections, [{ collection: "trips", role: "editor" }]) && E.scope().apps.map((a) => a.app).join() === "trip-planner");
  ok("roleOf: in scope → role; outside (exists) and absent → null, identically",
    E.roleOf("trips") === "editor" && E.roleOf("finances") === null && E.roleOf("nope") === null && E.roleOf("settings") === null);
  ok("getApp: granted → row; another app (exists) and an absent one → null, identically",
    E.getApp("trip-planner")?.name === "trip-planner" && E.getApp("finance-app") === null && E.getApp("nope") === null);
  ok("countItems: in scope → n; outside / absent / settings → null",
    E.countItems("trips") === 1 && E.countItems("finances") === null && E.countItems("nope") === null && E.countItems("settings") === null);
  const q = E.queryItems("trips", {});
  ok("queryItems in scope: rows, and version = the collection's own mark (not the global seq)",
    q.items.length === 1 && q.version === S.collectionVersion("trips") && q.version < S.dataVersion().seq && !("settings_version" in q));
  ok("queryItems outside ≡ absent ≡ settings: {error:not_shared}",
    same(E.queryItems("finances", {}), E.queryItems("nope", {})) && same(E.queryItems("settings", {}), { error: "not_shared" })
    && same(E.queryItems("finances", {}), { error: "not_shared" }));
  const ch = E.changesSince("trips", 0);
  ok("changesSince in scope: events, latest_seq on the collection's axis",
    ch.events.length === 1 && ch.latest_seq === S.collectionVersion("trips"));
  ok("changesSince outside ≡ absent", same(E.changesSince("finances", 0), E.changesSince("nope", 0)) && E.changesSince("finances", 0).error === "not_shared");
  ok("dataVersion in scope: the collection's mark; outside ≡ absent",
    E.dataVersion({ collection: "trips" }).seq === S.collectionVersion("trips") && !("settings_version" in E.dataVersion({ collection: "trips" }))
    && same(E.dataVersion({ collection: "finances" }), E.dataVersion({ collection: "nope" })) && E.dataVersion({}).error === "not_shared");
  ok("itemCollection: in scope → its collection; a row outside ≡ a missing row → null",
    E.itemCollection(t1.id) === "trips" && E.itemCollection(f1.id) === null && E.itemCollection(ghost) === null);
  ok("writersOf outside the scope answers nothing", E.writersOf("finances", [f1.seq]).size === 0);

  // writes, every type, against a row outside / a row that does not exist
  for (const type of ["update_item", "move_item", "delete_item"]) {
    const outside = E.execute({ type, command_id: cid(), id: f1.id, fields: { amount: 0 }, group: "x", actor: "agent" });
    const absent = E.execute({ type, command_id: cid(), id: ghost, fields: { amount: 0 }, group: "x", actor: "agent" });
    ok(`execute ${type}: a row outside ≡ a missing row → not_found`, same(outside, absent) && outside.error === "not_found", JSON.stringify(outside));
    const lie = E.execute({ type, command_id: cid(), id: t1.id, collection: "finances", fields: { city: "x" }, group: "x", actor: "agent" });
    ok(`execute ${type}: an in-scope row with a false collection claim → not_found`, same(lie, absent));
  }
  ok("finances untouched by all of it", S.snapshot("finances").items[0].fields.amount === 9000);
  const addOut = E.execute({ type: "add_item", command_id: cid(), collection: "finances", fields: {}, actor: "agent" });
  const addAbs = E.execute({ type: "add_item", command_id: cid(), collection: "nope", fields: {}, actor: "agent" });
  ok("execute add_item: outside → not_shared, and the same answer as absent (modulo the name echoed back)",
    addOut.error === "not_shared" && addAbs.error === "not_shared" && same(Object.keys(addOut), Object.keys(addAbs)));
  ok("execute add_item into settings → not_shared", E.execute({ type: "add_item", command_id: cid(), collection: "settings", fields: { key: "x", value: 1 }, actor: "agent" }).error === "not_shared");
  ok("execute anything that is not an item write → not_shared",
    E.execute({ type: "save_app", command_id: cid(), name: "trip-planner", ui: "<p>pwn</p>", actor: "agent" }).error === "not_shared"
    && E.execute({ type: "delete_app", command_id: cid(), name: "trip-planner", actor: "agent" }).error === "not_shared"
    && E.execute({ type: "write_file", command_id: cid(), app: "trip-planner", path: "x", sha256: "0".repeat(64), size: 1, actor: "agent" }).error === "not_shared");
  ok("execute with an actor that is not human|agent → refused", E.execute({ type: "add_item", command_id: cid(), collection: "trips", fields: {}, actor: "seed" }).error === "unknown_actor");
  const bOut = E.executeBatch([{ type: "add_item", collection: "trips", fields: { ok: 1 }, command_id: cid() }, { type: "update_item", id: f1.id, fields: { amount: 1 }, command_id: cid() }]);
  ok("executeBatch: one command outside → the whole batch refused before ANY runs",
    bOut.ok === false && bOut.index === 1 && bOut.failure.error === "not_found" && E.countItems("trips") === 1);

  // viewer: in scope, still no writes
  ok("viewer: add in scope → read_only", V.execute({ type: "add_item", command_id: cid(), collection: "trips", fields: {}, actor: "agent" }).error === "read_only");
  ok("viewer: update in scope → read_only; update outside → not_found (scope before role)",
    V.execute({ type: "update_item", command_id: cid(), id: t1.id, fields: { city: "x" }, actor: "agent" }).error === "read_only"
    && V.execute({ type: "update_item", command_id: cid(), id: f1.id, fields: { amount: 1 }, actor: "agent" }).error === "not_found");
  ok("viewer: reads work", V.queryItems("trips", {}).items.length === 1);
  const eAdd = principalScope.run({ principal: "user_leif", label: "leif@example.com" },
    () => E.execute({ type: "add_item", command_id: cid(), collection: "trips", fields: { city: "Bergen" }, actor: "agent", host: "chatgpt" }));
  ok("editor: add in scope lands in the OWNER's store, stamped with the recipient's principal",
    eAdd.ok && S.db.prepare("SELECT principal, actor, host FROM change_event WHERE seq = ?").get(eAdd.seq).principal === "user_leif");
  ok("…and changesSince through the facade labels it", E.changesSince("trips", 0).events.at(-1).by === "leif@example.com");
  ok("…and writersOf names the account for that row's version", E.writersOf("trips", [eAdd.seq]).get(eAdd.seq)?.label === "leif@example.com");

  // files — every method
  const F = E.files, FV = V.files;
  ok("files.list: granted app → its files only; another app ≡ absent → null",
    F.list("trip-planner").files.map((f) => f.path).join() === "map.png" && F.list("finance-app") === null && F.list("nope") === null);
  ok("files.stat / get: another app's file ≡ absent → null",
    F.stat("finance-app", "ledger.csv") === null && F.stat("nope", "ledger.csv") === null
    && (await F.get("finance-app", "ledger.csv")) === null && (await F.get("trip-planner", "map.png")).bytes.toString() === "trip-bytes");
  ok("files.version: granted → that app's mark; another app → null",
    F.version("trip-planner") === S.appFilesVersion("trip-planner") && F.version("finance-app") === null);
  const pOut = await F.put("finance-app", "x.txt", "pwn"), pAbs = await F.put("nope", "x.txt", "pwn");
  ok("files.put to another app ≡ absent → not_found", same(pOut, pAbs) && pOut.error === "not_found");
  const dOut = await F.del("finance-app", "ledger.csv"), dAbs = await F.del("nope", "ledger.csv");
  ok("files.del of another app's file ≡ absent → not_found, and the file survives",
    same(dOut, dAbs) && dOut.error === "not_found" && files.stat("finance-app", "ledger.csv") !== null);
  ok("viewer: files.put in the granted app → read_only; reads work",
    (await FV.put("trip-planner", "v.txt", "x")).error === "read_only" && FV.list("trip-planner") !== null);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("8. scope FOLLOWS THE APP — recomputed per call");
{
  save("trip-planner", { collections: { trips: {}, "trip-notes": {} } });
  S.execute({ type: "add_item", command_id: cid(), collection: "trip-notes", fields: { n: 1 }, actor: "agent" });
  ok("the owner binds a new collection → the recipient reaches it on the next call",
    E.roleOf("trip-notes") === "editor" && E.queryItems("trip-notes", {}).items.length === 1);
  save("trip-planner", { collections: { trips: {} } });
  ok("the owner unbinds it → refused on the next call", E.queryItems("trip-notes", {}).error === "not_shared");
  save("trip-planner", null);
  ok("no declaration → the app's own name is what it opens on, and that is the scope",
    same(E.scope().collections.map((c) => c.collection), ["trip-planner"]) && E.roleOf("trips") === null);
  save("trip-planner", { collections: { trips: {} } });
  const r = save("third-party", { collections: { finances: {} } }, "guest");
  ok("an unreviewed-tier app's declarations do not count (it binds its own name only)",
    r.ok && same(sharedScopeOf(S, "third-party", S.appBirth("third-party")).collections, ["third-party"]));
  const sys = sharedScopeOf(S, "settings-like", 0);
  ok("a grant on an app that does not exist is dead", sys === null);
  save("settings", null, "seed");
  ok("an app NAMED settings reaches nothing — settings is never in scope",
    same(sharedScopeOf(S, "settings", S.appBirth("settings")).collections, []));
  const two = scopeStore(S, { grants: [{ app: "trip-planner", appBirth: birth, role: "viewer" }, { app: "finance-app", appBirth: S.appBirth("finance-app"), role: "editor" }] });
  ok("two grants: each collection carries its own app's role", two.roleOf("trips") === "viewer" && two.roleOf("finances") === "editor");
  const overlap = scopeStore(S, { grants: [{ app: "trip-planner", appBirth: birth, role: "viewer" }, { app: "trip-planner", appBirth: birth, role: "editor" }] });
  ok("overlapping grants on one collection → the stronger role", overlap.roleOf("trips") === "editor");
  ok("malformed grants are ignored, not trusted",
    scopeStore(S, { grants: [{ app: "trip-planner", appBirth: "1", role: "editor" }, { app: "trip-planner", appBirth: birth, role: "owner" }] }).scope().apps.length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("9. T15 — delete and recreate under the same name does NOT revive an old grant");
{
  const before = E.queryItems("trips", {});
  ok("(the grant is alive)", Array.isArray(before.items));
  S.execute({ type: "delete_app", command_id: cid(), name: "trip-planner", actor: "agent" });
  ok("deleted → dead: no app, no scope, listed as ended",
    E.getApp("trip-planner") === null && E.queryItems("trips", {}).error === "not_shared" && same(E.scope().ended, [{ app: "trip-planner", appBirth: birth }]));
  S.execute({ type: "save_app", command_id: cid(), name: "trip-planner", ui: "<p>private</p>", manifest: { collections: { trips: {} } }, actor: "agent" });
  ok("recreated under the same name → still dead (a new life, a new birth)",
    S.appBirth("trip-planner") !== birth && E.getApp("trip-planner") === null && E.queryItems("trips", {}).error === "not_shared"
    && E.execute({ type: "add_item", command_id: cid(), collection: "trips", fields: {}, actor: "agent" }).error === "not_shared");
  const fresh = scopeStore(S, { grants: [{ app: "trip-planner", appBirth: S.appBirth("trip-planner"), role: "viewer" }] });
  ok("a grant issued for the new life reaches it", fresh.queryItems("trips", {}).items.length >= 1);
  ok("SHARE_ROLES is exactly viewer + editor", same(SHARE_ROLES, ["viewer", "editor"]));
}

S.close();
rmSync(TMP, { recursive: true, force: true });
console.log(fail ? `FAILURES: ${pass} passed, ${fail} failed` : `ALL PASS: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
