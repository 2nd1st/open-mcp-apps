// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/migration-drill.mjs — MIGRATIONS[2] against databases written by the OLD code.
//
// This is the first real firing of the migration mechanism, and the change it carries is the largest
// one planned: three independent counters (item.version, app.version, file.version) become
// positions on the ledger. Nothing about that is type-visible — a missed row keeps working and
// starts lying — so the drill asserts the MEANING afterwards, not the absence of an exception.
//
// Two fixtures on purpose:
//   · a hand-built v1 database containing the cases that are awkward BY CONSTRUCTION: rows with a
//     ledger event, rows without one (seeded before the ledger, or written by an older build),
//     a tombstoned app_history with a live recreation over it, and a file plane.
//   · test/dump.db — a real v1 registry (11 apps), for distribution rather than branch
//     coverage. It has no items, which is exactly why it cannot be the only fixture.
//
// ⏳ Still owed, and deliberately not faked here: the same drill against a COPY of a live
// multi-tenant volume (approved 2026-07-26; it needs the host, not this repo). A synthetic fixture
// proves every branch; only real data proves the distribution.
//
// Run: node test/migration-drill.mjs

import Database from "better-sqlite3";
import { existsSync, unlinkSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore, SCHEMA_VERSION } from "../src/store.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const V1 = join(ROOT, "test", "drill-v1.db");
const DUMP_COPY = join(ROOT, "test", "drill-dump.db");
const rm = (p) => { for (const f of [p, p + "-wal", p + "-shm"]) if (existsSync(f)) unlinkSync(f); };

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

// The v1 schema, verbatim — shared by the main fixture and the 2b collision fixture below.
const V1_SCHEMA = `
    CREATE TABLE item (id TEXT PRIMARY KEY, collection TEXT NOT NULL, grp TEXT NOT NULL DEFAULT '',
      position REAL NOT NULL DEFAULT 0, fields TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1,
      principal TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE component (name TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, html TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT 'agent', scene TEXT, manifest TEXT,
      kind TEXT NOT NULL DEFAULT 'app', visibility TEXT NOT NULL DEFAULT 'listed', kit_version TEXT,
      server_script TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE component_history (name TEXT NOT NULL, version INTEGER NOT NULL, html TEXT NOT NULL,
      ts TEXT NOT NULL, PRIMARY KEY (name, version));
    CREATE TABLE file (component TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream', version INTEGER NOT NULL DEFAULT 1,
      backend TEXT NOT NULL DEFAULT 'local', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (component, path));
    CREATE TABLE change_event (seq INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_id TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, payload TEXT NOT NULL, actor TEXT NOT NULL,
      principal TEXT, host TEXT, ts TEXT NOT NULL);
    CREATE TABLE report_watermark (scope TEXT PRIMARY KEY, seq INTEGER NOT NULL, ts TEXT NOT NULL);
`;

// ─────────────────────────────────────────────────────── fixture: a database as v1 would have left it
rm(V1);
{
  const db = new Database(V1);
  db.pragma("journal_mode = WAL");
  db.exec(V1_SCHEMA);
  const ts = "2026-07-01T00:00:00.000Z";
  const ev = db.prepare(`INSERT INTO change_event (aggregate_id, command_id, event_type, payload, actor, host, ts)
                         VALUES (?, ?, ?, ?, 'agent', 'drill', ?)`);
  const item = db.prepare(`INSERT INTO item (id, collection, grp, position, fields, version, created_at, updated_at)
                           VALUES (?, ?, '', ?, ?, ?, ?, ?)`);

  // (a) an item WITH history: added then updated twice, so v1 counted it to 3.
  item.run("it-tracked", "trips", 1, '{"title":"Kyoto"}', 3, ts, ts);
  ev.run("it-tracked", randomUUID(), "item_added",   JSON.stringify({ collection: "trips", sv: 1 }), ts);
  ev.run("it-tracked", randomUUID(), "item_updated", JSON.stringify({ collection: "trips", sv: 1 }), ts);
  const lastItemEvent = ev.run("it-tracked", randomUUID(), "item_updated", JSON.stringify({ collection: "trips", sv: 1 }), ts).lastInsertRowid;

  // (b) an item with NO event at all — seeded directly, which is how the settings rows and any
  //     pre-ledger write look. It must still end up with a usable OCC token.
  item.run("it-orphan", "trips", 2, '{"title":"no event ever"}', 1, ts, ts);

  // (c) an app saved twice, then DELETED, then recreated — the tombstone case the old
  //     maxHistVersion+1 dance existed for. v1 numbering: 1, 2, then 3 after the recreation.
  db.prepare("INSERT INTO component (name, version, html, description, author, updated_at) VALUES ('recreated', 3, '<p>third</p>', '', 'agent', ?)").run(ts);
  for (const [v, html] of [[1, "<p>first</p>"], [2, "<p>second</p>"], [3, "<p>third</p>"]])
    db.prepare("INSERT INTO component_history (name, version, html, ts) VALUES ('recreated', ?, ?, ?)").run(v, html, ts);
  ev.run("recreated", randomUUID(), "component_saved", JSON.stringify({ name: "recreated", version: 1, sv: 1 }), ts);
  ev.run("recreated", randomUUID(), "component_saved", JSON.stringify({ name: "recreated", version: 2, sv: 1 }), ts);
  ev.run("recreated", randomUUID(), "component_deleted", JSON.stringify({ name: "recreated", version: 2, sv: 1 }), ts);
  const lastCompEvent = ev.run("recreated", randomUUID(), "component_saved", JSON.stringify({ name: "recreated", version: 3, sv: 1 }), ts).lastInsertRowid;

  // (d) an app with NO event (seeded by an old build).
  db.prepare("INSERT INTO component (name, version, html, description, author, updated_at) VALUES ('eventless', 1, '<p>seeded</p>', '', 'seed', ?)").run(ts);
  db.prepare("INSERT INTO component_history (name, version, html, ts) VALUES ('eventless', 1, '<p>seeded</p>', ?)").run(ts);

  // (e) a file written twice (v1 counted to 2) and one with no event.
  db.prepare(`INSERT INTO file (component, path, sha256, size, mime, version, created_at, updated_at)
              VALUES ('recreated', 'logo.png', ?, 10, 'image/png', 2, ?, ?)`).run("a".repeat(64), ts, ts);
  ev.run("recreated/logo.png", randomUUID(), "file_written", JSON.stringify({ app: "recreated", path: "logo.png", sv: 1 }), ts);
  const lastFileEvent = ev.run("recreated/logo.png", randomUUID(), "file_written", JSON.stringify({ app: "recreated", path: "logo.png", sv: 1 }), ts).lastInsertRowid;
  db.prepare(`INSERT INTO file (component, path, sha256, size, mime, version, created_at, updated_at)
              VALUES ('eventless', 'stray.bin', ?, 3, 'application/octet-stream', 1, ?, ?)`).run("b".repeat(64), ts, ts);

  // (f) cold-review H12: aggregate_id is a SHARED namespace. An item whose id happens to equal a
  //     app's name must take ITS OWN last event's seq — not the app's later one.
  item.run("twin", "trips", 3, '{"title":"name collision"}', 1, ts, ts);
  const twinItemEvent = ev.run("twin", randomUUID(), "item_added", JSON.stringify({ collection: "trips", sv: 1 }), ts).lastInsertRowid;
  db.prepare("INSERT INTO component (name, version, html, description, author, updated_at) VALUES ('twin', 1, '<p>twin</p>', '', 'agent', ?)").run(ts);
  db.prepare("INSERT INTO component_history (name, version, html, ts) VALUES ('twin', 1, '<p>twin</p>', ?)").run(ts);
  const twinCompEvent = ev.run("twin", randomUUID(), "component_saved", JSON.stringify({ name: "twin", version: 1, sv: 1 }), ts).lastInsertRowid;

  // (g) the v3 rename: an app installed from the store under the OLD provenance word, and the OLD
  //     browse app itself. v3 must move the stamp and the name; the ledger stays as written.
  db.prepare("INSERT INTO component (name, version, html, description, author, updated_at) VALUES ('installed-app', 1, '<p>from the store</p>', '', 'gallery', ?)").run(ts);
  db.prepare("INSERT INTO component_history (name, version, html, ts) VALUES ('installed-app', 1, '<p>from the store</p>', ?)").run(ts);
  db.prepare("INSERT INTO component (name, version, html, description, author, updated_at) VALUES ('gallery', 2, '<p>old browse ui</p>', '', 'seed', ?)").run(ts);
  for (const [v, html] of [[1, "<p>browse v1</p>"], [2, "<p>old browse ui</p>"]])
    db.prepare("INSERT INTO component_history (name, version, html, ts) VALUES ('gallery', ?, ?, ?)").run(v, html, ts);

  db.pragma("user_version = 1");
  db.close();

  console.log("1. a v1 database written by the old code migrates on open");
  const store = openStore(V1);
  const raw = new Database(V1, { readonly: true });
  const head = raw.prepare("SELECT MAX(seq) v FROM change_event").get().v;

  ok("the database is stamped at the new version", raw.pragma("user_version", { simple: true }) === SCHEMA_VERSION);

  // The core claim: a row's version IS the seq of the last event that touched it.
  const iv = raw.prepare("SELECT version FROM item WHERE id = 'it-tracked'").get().version;
  ok("a tracked item's version is the seq of its last event", iv === Number(lastItemEvent),
    `item.version=${iv} lastEvent=${lastItemEvent}`);
  const ov = raw.prepare("SELECT version FROM item WHERE id = 'it-orphan'").get().version;
  ok("an item with no event still gets a usable token (never 0, never behind the head)", ov > 0 && ov <= head, `version=${ov} head=${head}`);
  const tv = raw.prepare("SELECT version FROM item WHERE id = 'twin'").get().version;
  ok("an item sharing its id with an app name keeps ITS OWN event's seq (event-type filter)",
    tv === Number(twinItemEvent) && tv !== Number(twinCompEvent), `item.version=${tv} itemEvent=${twinItemEvent} compEvent=${twinCompEvent}`);

  const cv = raw.prepare("SELECT version FROM app WHERE name = 'recreated'").get().version;
  ok("an app's version is the seq of its last save", cv === Number(lastCompEvent), `app.version=${cv} lastSave=${lastCompEvent}`);
  const ev2 = raw.prepare("SELECT version FROM app WHERE name = 'eventless'").get().version;
  ok("an eventless app gets one too", ev2 > 0 && ev2 <= head);

  const fv = raw.prepare("SELECT version FROM file WHERE app='recreated' AND path='logo.png'").get().version;
  ok("a file's version is the seq of its last write", fv === Number(lastFileEvent), `file.version=${fv} lastWrite=${lastFileEvent}`);

  // The history rekey: the CURRENT version has to exist in app_history, or restore_app
  // and auto-revert look up a version that is no longer there.
  const histRows = raw.prepare("SELECT version FROM app_history WHERE name='recreated' ORDER BY version DESC").all().map((r) => r.version);
  ok("the current version is present in history (restore/auto-revert can find it)", histRows.includes(cv), `history=[${histRows}] current=${cv}`);
  ok("history stayed monotonic and lost nothing", histRows.length === 3 && histRows[0] > histRows[1] && histRows[1] > histRows[2], `history=[${histRows}]`);
  ok("the restored html is still the right bytes for that version",
    raw.prepare("SELECT html FROM app_history WHERE name='recreated' AND version=?").get(cv).html === "<p>third</p>");

  // v3 — provenance and the system name now speak the new word; nothing else about the rows moved.
  ok("an installed app's author stamp moved gallery → library",
    raw.prepare("SELECT author FROM app WHERE name='installed-app'").get().author === "library");
  ok("the browse app answers to 'library' now, history moved with it",
    !raw.prepare("SELECT 1 FROM app WHERE name='gallery'").get() &&
    raw.prepare("SELECT 1 FROM app WHERE name='library' AND author='seed'").get() !== undefined &&
    raw.prepare("SELECT COUNT(*) c FROM app_history WHERE name='library'").get().c === 2 &&
    raw.prepare("SELECT COUNT(*) c FROM app_history WHERE name='gallery'").get().c === 0);
  raw.close();

  console.log("\n2. the migrated database still WORKS — one write round per plane, on the new axis");
  const add = store.execute({ type: "add_item", command_id: randomUUID(), collection: "trips", fields: { title: "after migration" }, actor: "agent" });
  ok("an item write succeeds and its version is this write's seq", add.ok && add.item.version === add.seq);
  ok("the new version is above everything the migration stamped", add.item.version > iv && add.item.version > cv);

  const occ = store.execute({ type: "update_item", command_id: randomUUID(), id: "it-tracked", fields: { title: "occ" }, expected_version: iv, actor: "agent" });
  ok("OCC works with the number the MIGRATION wrote (the round trip that proves the axis)", occ.ok === true, JSON.stringify(occ).slice(0, 200));
  const stale = store.execute({ type: "update_item", command_id: randomUUID(), id: "it-tracked", fields: { title: "no" }, expected_version: iv, actor: "agent" });
  ok("...and the same token is stale the second time", stale.ok === false && stale.conflict === true);

  const save = store.execute({ type: "save_app", command_id: randomUUID(), name: "recreated", html: "<p>fourth</p>", actor: "agent" });
  ok("an app re-save rolls forward past the migrated version", save.ok && save.version > cv);
  const hist2 = store.appHistory("recreated").map((h) => h.version);
  const rawHist = store.db.prepare("SELECT version FROM app_history WHERE name='recreated' ORDER BY version DESC").all().map((r) => r.version);
  // ⚠️ Rewritten 2026-07-29 along with the fix that scoped history to an app's CURRENT life.
  // This fixture is precisely the delete-then-recreate case (see its comment at the top of the
  // file), so the two halves of "nothing overwritten" are now asserted where each is observable:
  //   · the TABLE still holds every row of both lives — that is the tombstone, and the property
  //     the old `hist2.length === 4` was really about;
  //   · the READ hands back only this life's, because the previous life belonged to a different
  //     app that merely shared the name, and "restore checkpoint 1" must not reach into it.
  // The row count moved; nothing was overwritten then and nothing is now.
  ok("history still monotonic after the re-save, nothing overwritten",
    rawHist.length === 4 && rawHist[0] === save.version
    && hist2.length === 2 && hist2[0] === save.version && hist2[1] === rawHist[1]
    && hist2[1] > rawHist[2],   // the life boundary sits between rawHist[1] and rawHist[2]
    `table=[${rawHist}] read=[${hist2}]`);

  const fw = store.execute({ type: "write_file", command_id: randomUUID(), app: "recreated", path: "logo.png", sha256: "c".repeat(64), size: 11, mime: "image/png", actor: "agent" });
  ok("a file overwrite rolls forward past the migrated version", fw.ok && fw.meta.version > fv);

  store.close();
}

// ───────────────────────────────── 2b. the v3 collision: a USER already owns the name 'library'
// v0.2.0 never reserved the word, so a v1 store can legally hold a user app called 'library'.
// The migration must treat that row as the user's property: keep it, and DROP the stale 'gallery'
// system row instead of renaming onto it. (The seeder then refuses the occupied slot — its test.)
console.log("\n2b. a user's own 'library' app survives the rename; the stale 'gallery' row is dropped");
{
  const V1B = join(ROOT, "test", "drill-v1b.db");
  rm(V1B);
  const db = new Database(V1B);
  db.pragma("journal_mode = WAL");
  db.exec(V1_SCHEMA);
  const ts = "2026-07-01T00:00:00.000Z";
  db.prepare("INSERT INTO component (name, version, html, description, author, updated_at) VALUES ('gallery', 1, '<p>old browse ui</p>', '', 'seed', ?)").run(ts);
  db.prepare("INSERT INTO component_history (name, version, html, ts) VALUES ('gallery', 1, '<p>old browse ui</p>', ?)").run(ts);
  db.prepare("INSERT INTO component (name, version, html, description, author, updated_at) VALUES ('library', 1, '<p>the user built this</p>', '', 'agent', ?)").run(ts);
  db.prepare("INSERT INTO component_history (name, version, html, ts) VALUES ('library', 1, '<p>the user built this</p>', ?)").run(ts);
  db.pragma("user_version = 1");
  db.close();

  openStore(V1B).close();
  const raw = new Database(V1B, { readonly: true });
  const mine = raw.prepare("SELECT author, html FROM app WHERE name='library'").get();
  ok("the user's app kept its name, bytes and authorship", mine && mine.author === "agent" && mine.html === "<p>the user built this</p>");
  ok("the stale 'gallery' row and its history are gone",
    !raw.prepare("SELECT 1 FROM app WHERE name='gallery'").get() &&
    raw.prepare("SELECT COUNT(*) c FROM app_history WHERE name='gallery'").get().c === 0);
  ok("exactly one 'library' history line — the user's, untouched",
    raw.prepare("SELECT COUNT(*) c FROM app_history WHERE name='library'").get().c === 1 &&
    raw.prepare("SELECT html FROM app_history WHERE name='library'").get().html === "<p>the user built this</p>");
  raw.close();
  rm(V1B);
}

// ──────────────────── 2c. the v4 collision: a USER already owns the name 'app'
// `app` only became a reserved name in v0.3.2, and a reserved name is refused at CREATE time — it
// was never enforced against rows that already existed. v0.4 makes `app` the house word, whose
// document claims the universal loader's own resource URI, so the migration has to move the user's
// row out of the way. Three things are being asserted, and the third is the one that is easy to
// skip: the rename has to be WRITTEN DOWN, or a name changing under the user is indistinguishable
// from the app having been deleted.
console.log("\n2c. a user's own 'app' is renamed out of the reserved word, with a ledger record");
{
  const V3 = join(ROOT, "test", "drill-v3.db");
  rm(V3);
  const db = new Database(V3);
  db.pragma("journal_mode = WAL");
  db.exec(V1_SCHEMA);
  const ts = "2026-07-01T00:00:00.000Z";
  // The user's app, plus a file it owns — the `file` plane is keyed on the owner name, so a rename
  // that forgets it silently orphans every file the app had.
  db.prepare("INSERT INTO component (name, version, html, description, author, updated_at) VALUES ('app', 7, '<p>mine</p>', '', 'agent', ?)").run(ts);
  db.prepare("INSERT INTO component_history (name, version, html, ts) VALUES ('app', 7, '<p>mine</p>', ?)").run(ts);
  db.prepare(`INSERT INTO file (component, path, sha256, size, mime, version, created_at, updated_at)
              VALUES ('app', 'note.txt', ?, 4, 'text/plain', 1, ?, ?)`).run("c".repeat(64), ts, ts);
  // 'app-1' is ALREADY TAKEN, so the first candidate name is not free: the migration must keep
  // looking rather than collide onto someone else's row.
  db.prepare("INSERT INTO component (name, version, html, description, author, updated_at) VALUES ('app-1', 1, '<p>someone else</p>', '', 'agent', ?)").run(ts);
  // An ordinary app, to prove the migration touches only what it must.
  db.prepare("INSERT INTO component (name, version, html, description, author, updated_at) VALUES ('trip-board', 1, '<p>untouched</p>', '', 'agent', ?)").run(ts);
  db.pragma("user_version = 3");
  db.close();

  openStore(V3).close();
  const raw = new Database(V3, { readonly: true });

  ok("stamped at v4", raw.pragma("user_version", { simple: true }) === SCHEMA_VERSION);
  ok("the reserved name is free again", !raw.prepare("SELECT 1 FROM app WHERE name='app'").get());
  const moved = raw.prepare("SELECT name, version, html FROM app WHERE html='<p>mine</p>'").get();
  ok("the user's app moved to the first FREE name, not onto 'app-1'", moved && moved.name === "app-2",
    `landed on ${moved && moved.name}`);
  ok("it kept its bytes and its position on the ordinal axis", moved && moved.version === 7);
  ok("its history followed the name",
    raw.prepare("SELECT COUNT(*) c FROM app_history WHERE name='app-2'").get().c === 1 &&
    raw.prepare("SELECT COUNT(*) c FROM app_history WHERE name='app'").get().c === 0);
  ok("its FILES followed the name — the file plane is keyed on the owner",
    raw.prepare("SELECT COUNT(*) c FROM file WHERE app='app-2' AND path='note.txt'").get().c === 1 &&
    raw.prepare("SELECT COUNT(*) c FROM file WHERE app='app'").get().c === 0);
  ok("the squatter on 'app-1' was not touched",
    raw.prepare("SELECT html FROM app WHERE name='app-1'").get().html === "<p>someone else</p>");
  ok("an unrelated app is untouched",
    raw.prepare("SELECT html FROM app WHERE name='trip-board'").get().html === "<p>untouched</p>");

  // The record. Without it the user sees an app they named vanish and another appear.
  const rec = raw.prepare("SELECT aggregate_id, event_type, payload FROM change_event WHERE event_type='component_renamed'").all();
  ok("exactly one rename is recorded in the ledger", rec.length === 1);
  const pay = rec.length ? JSON.parse(rec[0].payload) : {};
  ok("the record says where the app went and why",
    rec.length === 1 && rec[0].aggregate_id === "app-2" &&
    pay.from === "app" && pay.to === "app-2" && pay.reason === "reserved_name" && pay.sv === SCHEMA_VERSION,
    JSON.stringify(pay));

  raw.close();
  // Idempotence: a second open must not rename anything a second time. The store is already at v4,
  // so the ladder does not run — but the structural half is reached on EVERY open, and a
  // non-idempotent one would throw or double-move here.
  openStore(V3).close();
  const again = new Database(V3, { readonly: true });
  ok("reopening changes nothing",
    again.prepare("SELECT COUNT(*) c FROM change_event WHERE event_type='component_renamed'").get().c === 1 &&
    again.prepare("SELECT COUNT(*) c FROM app WHERE name='app-2'").get().c === 1);
  again.close();
  rm(V3);
}

// ─────────── 2d. the v4 collision the live table CANNOT see: a TOMBSTONE holds the free name
// Deleting an app keeps its history, its files and its ledger — only the registry row goes. So a
// name the live table reports as free can still own a (name, version) primary key. Picking it moves
// a user's app onto a dead app's records, and there are exactly two outcomes, both reproduced here:
// the versions clash and the migration throws — leaving the tables renamed, user_version at 3, and
// every later open replaying the same failure, which is a store that never opens again — or the
// versions happen not to clash and two apps merge in silence.
console.log("\n2d. a DELETED app's tombstone still owns its name — the migration must not land on it");
{
  const V3T = join(ROOT, "test", "drill-v3t.db");
  rm(V3T);
  const db = new Database(V3T);
  db.pragma("journal_mode = WAL");
  db.exec(V1_SCHEMA);
  const ts = "2026-07-01T00:00:00.000Z";
  const ev = db.prepare(`INSERT INTO change_event (aggregate_id, command_id, event_type, payload, actor, host, ts)
                         VALUES (?, ?, ?, ?, 'agent', 'drill', ?)`);
  // The user's live app, sitting on the reserved word.
  db.prepare("INSERT INTO component (name, version, html, description, author, updated_at) VALUES ('app', 7, '<p>mine</p>', '', 'agent', ?)").run(ts);
  db.prepare("INSERT INTO component_history (name, version, html, ts) VALUES ('app', 7, '<p>mine</p>', ?)").run(ts);
  db.prepare(`INSERT INTO file (component, path, sha256, size, mime, version, created_at, updated_at)
              VALUES ('app', 'mine.txt', ?, 4, 'text/plain', 1, ?, ?)`).run("a".repeat(64), ts, ts);
  // A DELETED app called 'app-1': no registry row (that is what delete removes), everything else
  // still there. Version 7 on purpose — the live app is at 7 too, so the naive rename collides.
  for (const v of [1, 7])
    db.prepare("INSERT INTO component_history (name, version, html, ts) VALUES ('app-1', ?, '<p>THEIRS</p>', ?)").run(v, ts);
  db.prepare(`INSERT INTO file (component, path, sha256, size, mime, version, created_at, updated_at)
              VALUES ('app-1', 'theirs.bin', ?, 9, 'application/octet-stream', 1, ?, ?)`).run("b".repeat(64), ts, ts);
  ev.run("app-1", randomUUID(), "component_saved", JSON.stringify({ name: "app-1", version: 7, sv: 3 }), ts);
  ev.run("app-1", randomUUID(), "component_deleted", JSON.stringify({ name: "app-1", version: 7, sv: 3 }), ts);
  db.prepare("INSERT INTO component (name, version, html, description, author, updated_at) VALUES ('trip-board', 1, '<p>untouched</p>', '', 'agent', ?)").run(ts);
  db.pragma("user_version = 3");
  db.close();

  // ── consequence 1: the store must still OPEN — and keep opening. A migration that throws here
  // leaves v4 tables stamped v3, so the next open replays it and throws again; being unable to
  // retry your way out is what turns a failed upgrade into a dead store, and it is the half a
  // single open would not catch.
  let firstErr = null, secondErr = null;
  try { openStore(V3T).close(); } catch (e) { firstErr = e; }
  try { openStore(V3T).close(); } catch (e) { secondErr = e; }
  ok("the store opens", !firstErr, String(firstErr && firstErr.message));
  ok("…and opens AGAIN — the upgrade is re-entrant, not a one-shot that bricks on replay",
    !secondErr, String(secondErr && secondErr.message));
  if (firstErr || secondErr) { rm(V3T); }
  else {
    const raw = new Database(V3T, { readonly: true });
    ok("stamped at v4", raw.pragma("user_version", { simple: true }) === SCHEMA_VERSION);

    // ── consequence 2: no silent merge. The tombstone's records must be exactly where they were.
    const moved = raw.prepare("SELECT name, version FROM app WHERE html='<p>mine</p>'").get();
    ok("the user's app skipped the name a tombstone still holds", moved && moved.name === "app-2",
      `landed on ${moved && moved.name}`);
    ok("the dead app's history is untouched — still 2 rows under 'app-1', still its own bytes",
      raw.prepare("SELECT COUNT(*) c FROM app_history WHERE name='app-1'").get().c === 2 &&
      raw.prepare("SELECT COUNT(*) c FROM app_history WHERE name='app-1' AND html='<p>THEIRS</p>'").get().c === 2);
    ok("the user's history came across whole, and carries none of the dead app's versions",
      raw.prepare("SELECT COUNT(*) c FROM app_history WHERE name='app-2'").get().c === 1 &&
      raw.prepare("SELECT html FROM app_history WHERE name='app-2'").get().html === "<p>mine</p>");
    ok("the two file planes did not merge either",
      raw.prepare("SELECT COUNT(*) c FROM file WHERE app='app-2' AND path='mine.txt'").get().c === 1 &&
      raw.prepare("SELECT COUNT(*) c FROM file WHERE app='app-1' AND path='theirs.bin'").get().c === 1);
    ok("the dead app's ledger stays its own — the live app did not inherit its lives",
      raw.prepare("SELECT COUNT(*) c FROM change_event WHERE aggregate_id='app-1' AND event_type IN ('component_saved','component_deleted')").get().c === 2 &&
      raw.prepare("SELECT COUNT(*) c FROM change_event WHERE aggregate_id='app-2' AND event_type='component_renamed'").get().c === 1);
    ok("an unrelated app is untouched",
      raw.prepare("SELECT html FROM app WHERE name='trip-board'").get().html === "<p>untouched</p>");
    raw.close();
    rm(V3T);
  }
}

// ─────────── 2e. the same tombstone, versions that do NOT clash — the silent half
// 2d's fixture collides on (name, version), which is the loud outcome. This one is the quiet one:
// the dead app's only version is 1, the live app is at 7, so a naive rename raises nothing at all
// and simply merges them — one name, two apps' histories and files, and a restore that hands the
// user somebody else's app. Kept as its OWN case because in 2d the throw happens first and these
// assertions never run: an assertion that cannot be reached cannot fail, and one that cannot fail
// is not a test.
console.log("\n2e. …and when the versions happen not to clash, nothing throws — it just merges");
{
  const V3M = join(ROOT, "test", "drill-v3m.db");
  rm(V3M);
  const db = new Database(V3M);
  db.pragma("journal_mode = WAL");
  db.exec(V1_SCHEMA);
  const ts = "2026-07-01T00:00:00.000Z";
  db.prepare("INSERT INTO component (name, version, html, description, author, updated_at) VALUES ('app', 7, '<p>mine</p>', '', 'agent', ?)").run(ts);
  db.prepare("INSERT INTO component_history (name, version, html, ts) VALUES ('app', 7, '<p>mine</p>', ?)").run(ts);
  db.prepare(`INSERT INTO file (component, path, sha256, size, mime, version, created_at, updated_at)
              VALUES ('app', 'mine.txt', ?, 4, 'text/plain', 1, ?, ?)`).run("d".repeat(64), ts, ts);
  db.prepare("INSERT INTO component_history (name, version, html, ts) VALUES ('app-1', 1, '<p>THEIRS</p>', ?)").run(ts);
  db.prepare(`INSERT INTO file (component, path, sha256, size, mime, version, created_at, updated_at)
              VALUES ('app-1', 'theirs.bin', ?, 9, 'application/octet-stream', 1, ?, ?)`).run("c".repeat(64), ts, ts);
  db.pragma("user_version = 3");
  db.close();

  openStore(V3M).close();
  const raw = new Database(V3M, { readonly: true });
  const moved = raw.prepare("SELECT name FROM app WHERE html='<p>mine</p>'").get();
  ok("the user's app still skips the tombstone's name when nothing would have complained",
    moved && moved.name === "app-2", `landed on ${moved && moved.name}`);
  ok("no history merge: the user's name holds exactly their own version, and only theirs",
    raw.prepare("SELECT COUNT(*) c FROM app_history WHERE name='app-2'").get().c === 1 &&
    raw.prepare("SELECT COUNT(*) c FROM app_history WHERE name='app-2' AND html='<p>THEIRS</p>'").get().c === 0);
  // The user OWNS a file here on purpose: without one, "the planes did not merge" is true no
  // matter what the migration does, and an assertion that cannot fail proves nothing.
  ok("no file merge: the user's file went with them, the stranger's stayed put",
    raw.prepare("SELECT COUNT(*) c FROM file WHERE app='app-2' AND path='mine.txt'").get().c === 1 &&
    raw.prepare("SELECT COUNT(*) c FROM file WHERE app='app-1' AND path='theirs.bin'").get().c === 1 &&
    raw.prepare("SELECT COUNT(*) c FROM file WHERE app='app-1'").get().c === 1);
  raw.close();
  rm(V3M);
}

// ─────────────────────────────────────────────────── a real v1 registry (distribution, not branches)
// The fixture is a REAL database, and real databases never ship: the publish snapshot bans *.db
// wholesale (scripts/publish.mjs — a genuine store could carry genuine data). In the public tree
// this section skips LOUDLY; the full drill still runs on every internal checkout and CI.
if (!existsSync(join(ROOT, "test", "dump.db"))) {
  console.log("\n3. test/dump.db — SKIPPED (internal-only fixture: real databases never ship)");
} else {
console.log("\n3. test/dump.db — a REAL v1 database (11 seeded apps, no items)");
{
  rm(DUMP_COPY);
  copyFileSync(join(ROOT, "test", "dump.db"), DUMP_COPY);
  const store = openStore(DUMP_COPY);
  const raw = new Database(DUMP_COPY, { readonly: true });
  ok("stamped at the new version", raw.pragma("user_version", { simple: true }) === SCHEMA_VERSION);
  const comps = raw.prepare("SELECT name, version FROM app ORDER BY name").all();
  ok(`all ${comps.length} apps carry a positive version`, comps.length > 0 && comps.every((c) => c.version > 0));
  const orphans = comps.filter((c) => !raw.prepare("SELECT 1 FROM app_history WHERE name=? AND version=?").get(c.name, c.version));
  ok("every app's CURRENT version exists in history", orphans.length === 0,
    `missing history rows for: ${orphans.map((c) => `${c.name} v${c.version}`).join(", ")}`);
  ok("nothing in a REAL registry answers to 'gallery' any more (name or provenance)",
    !raw.prepare("SELECT 1 FROM app WHERE name='gallery'").get() &&
    raw.prepare("SELECT COUNT(*) c FROM app WHERE author='gallery'").get().c === 0);
  raw.close();
  // And it still takes a write.
  const w = store.execute({ type: "save_app", command_id: randomUUID(), name: comps[0].name, html: "<p>post-migration edit</p>", actor: "agent" });
  ok("a real migrated registry accepts a save", w.ok && w.version > comps[0].version);
  store.close();
}
}

rm(V1); rm(DUMP_COPY);
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
