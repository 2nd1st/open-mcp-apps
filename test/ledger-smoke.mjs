// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/ledger-smoke.mjs — the delta substrate: changesSince() + the report watermark.
//
// This is the store half of E1Δ, whose whole premise is that the model-facing text is never
// LOSSY. Delta is the only way to be both cheap and lossless — the model already holds the
// earlier copy in its transcript, so re-sending it is redundant, not thorough. Everything here
// exists to keep that promise:
//
//   · a window that cannot hold everything reports `total` and `dropped` rather than looking
//     complete (a silent sample is the exact thing this design refuses)
//   · a truncated window keeps the NEWEST events, because later events supersede earlier ones
//   · `actor` survives, because 'human' events ARE the product: what the user did in the widget
//     while the model was not looking
//   · the watermark marks what was REPORTED, never when an app was opened — advancing on open
//     would swallow precisely the user's edits
//
// Run: node test/ledger-smoke.mjs
import { existsSync, unlinkSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openStore } from "../src/store.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "ledger.db");
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

const store = openStore(DB);
const add = (cid, collection, fields, actor) =>
  store.execute({ type: "add_item", command_id: cid, collection, fields, actor, host: "smoke" });

console.log("1. changesSince — scope and fidelity");
const a = add("l1", "probe", { title: "咖啡豆", amount: 88 }, "agent");
add("l2", "other", { title: "不该出现" }, "agent");
const h = add("l3", "probe", { title: "键盘", amount: 320 }, "human");
{
  const d = store.changesSince("probe", 0);
  ok("only this collection's events", d.events.length === 2, `got ${d.events.length}`);
  ok("ascending by seq", d.events[0].seq < d.events[1].seq);
  ok("actor survives — 'human' is what the user did unseen",
    d.events.map((e) => e.actor).join(",") === "agent,human", d.events.map((e) => e.actor).join(","));
  ok("item id travels (the model needs it to update/delete later)",
    d.events[0].id === a.id && d.events[1].id === h.id);
  ok("full fields, not a label", d.events[0].fields?.amount === 88 && d.events[0].fields?.title === "咖啡豆",
    JSON.stringify(d.events[0].fields));
  ok("`collection` and the `sv` format pin are stripped (they are the query, not news)",
    !("collection" in d.events[0]) && !("sv" in d.events[0]), Object.keys(d.events[0]).join(","));
  ok("nothing dropped when it all fits", d.total === 2 && d.dropped === 0);
}

console.log("2. `since` is exclusive — a second read reports only what is new");
{
  const first = store.changesSince("probe", 0);
  const d = store.changesSince("probe", first.events.at(-1).seq);
  ok("empty after consuming everything", d.events.length === 0 && d.total === 0);
  add("l4", "probe", { title: "域名续费", amount: 1200 }, "human");
  const d2 = store.changesSince("probe", first.events.at(-1).seq);
  ok("the new event alone", d2.events.length === 1 && d2.events[0].fields.title === "域名续费");
}

console.log("3. limited windows say so — and a next_since walk misses nothing");
{
  for (let i = 0; i < 20; i++) add(`bulk${i}`, "probe", { title: `t${i}`, n: i }, "human");
  const d = store.changesSince("probe", 0, 5);
  ok("window honors the limit", d.events.length === 5, `got ${d.events.length}`);
  ok(`total counted in full (${d.total})`, d.total === 23, `got ${d.total}`);
  ok(`dropped is stated (${d.dropped}) — never a silent sample`, d.dropped === d.total - 5);
  // Write-set C: the window is the contiguous run right after `since` — oldest first, never a
  // newest-window with a gap. That is what makes a caller-held mark sound: next_since is the last
  // event delivered, and everything undelivered is still strictly after it (read-plane D4).
  ok("next_since is the last delivered event", d.next_since === d.events.at(-1).seq);
  ok("still ascending inside the window", d.events.every((e, i, arr) => !i || arr[i - 1].seq < e.seq));
  let mark = 0; const seen = [];
  for (;;) {
    const w = store.changesSince("probe", mark, 5);
    if (!w.events.length) break;
    seen.push(...w.events.map((e) => e.seq));
    mark = w.next_since;
  }
  ok("a next_since walk visits every event exactly once, in order — nothing can be skipped over",
    seen.length === d.total && seen.every((s, i, a) => !i || a[i - 1] < s),
    `walked ${seen.length} of ${d.total}`);
}

console.log("4. event shapes carry what reconciliation needs");
{
  const before = store.dataVersion().seq;
  const target = store.snapshot("probe").items[0];
  store.execute({ type: "move_item", command_id: "mv1", id: target.id, group: "done", actor: "human", host: "smoke" });
  // A human delete rides the W-S two-phase flow (test/confirmation.mjs owns the pins; here it
  // just runs honestly): first leg returns the demand, the resend with its state executes.
  const demand = store.execute({ type: "delete_item", command_id: "dl1", id: target.id, actor: "human", host: "smoke" });
  store.execute({ type: "delete_item", command_id: "dl1", id: target.id, actor: "human", host: "smoke", request_state: demand.request_state });
  const d = store.changesSince("probe", before);
  const [moved, deleted] = d.events;
  ok("item_moved carries from/to", moved.type === "item_moved" && moved.to === "done", JSON.stringify(moved));
  ok("item_deleted carries the id so the model can reconcile",
    deleted.type === "item_deleted" && deleted.id === target.id);
  // Known and deliberate: the delete payload has no fields, so a delta alone cannot say WHAT was
  // removed — only which id. Enriching it needs a SCHEMA_VERSION bump, which is a separate batch.
  ok("delete has no fields (documented limit, not an oversight)", deleted.fields === undefined);
}

console.log("5. the server-held watermark is GONE (write-set C) — the mark lives with the caller");
{
  // It was keyed by (collection, host), and hostName turned out to be unstable (one claude.ai user
  // presents three clientInfo names — measured), on top of two chats on one host sharing a mark.
  // data_changes now takes the caller's own `since` and hands back `next_since`; the table drops
  // in place (its own comment declared it rebuildable side state holding no truth).
  ok("the store exposes no reportWatermark", store.reportWatermark === undefined);
  const raw = store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'report_watermark'").get();
  ok("the table itself is dropped on open", raw === undefined);
}

console.log("6. the ledger survives a reopen");
{
  store.close();
  const again = openStore(DB);
  ok("ledger still readable", again.changesSince("probe", 0).total > 0);
  again.close();
}

console.log("7. E4/E13 — the shape reservations, which must change nothing today");
{
  const s2 = openStore(DB);
  const r = s2.execute({ type: "save_app", command_id: "c1", name: "shaped",
    ui: "<!DOCTYPE html><html><body><div id='x'>shape-reservation fixture with enough body to clear the minimum-size guard</div></body></html>", actor: "agent" });
  ok("app saves", r.ok === true);
  const row = s2.listApps().find((c) => c.name === "shaped");
  ok("kind defaults to 'app' — so nothing vanishes from list_apps today",
    row.kind === "app", JSON.stringify(row.kind));
  ok("visibility defaults to 'listed'", row.visibility === "listed");
  // (kit_version / server_script / principal reservations dropped 2026-08-04, elegance A4 —
  // columns with no writer and no reader; each returns WITH its consumer as a schema bump.)

  // The two values come from DIFFERENT places, and the split is the design: `kind` is something the
  // author knows about their own app, so it lives in the manifest slot; `visibility` is lifecycle
  // state (retired, curated, long-tail) that someone else decides later, so it stays a command.
  const shapedUi = "<!DOCTYPE html><html><head></head><body><div id='x'>shape-reservation fixture with enough body to clear the minimum-size guard</div></body></html>";

  s2.execute({ type: "save_app", command_id: "c2", name: "shaped", actor: "agent",
    manifest: { manifest_version: 2, kind: "visual" }, visibility: "unlisted" });
  const v = s2.listApps().find((c) => c.name === "shaped");
  ok("kind arrives from the manifest slot, visibility from the command", v.kind === "visual" && v.visibility === "unlisted");

  s2.execute({ type: "save_app", command_id: "c3", name: "shaped", ui: shapedUi, actor: "agent" });
  const k = s2.listApps().find((c) => c.name === "shaped");
  ok("a save that omits the manifest slot preserves both (slot inheritance, not a reset)",
    k.kind === "visual" && k.visibility === "unlisted", JSON.stringify([k.kind, k.visibility]));

  ok("a typo'd kind is refused at the manifest, not stored",
    s2.execute({ type: "save_app", command_id: "c4", name: "shaped", manifest: { kind: "aap" }, actor: "agent" }).error === "bad_manifest");

  // E13b: the closed actor set is what keeps an anonymous write from landing as "human".
  ok("an unknown actor on a DATA write is refused",
    s2.execute({ type: "add_item", command_id: "c5", collection: "probe", fields: { title: "x" }, actor: "sneaky" }).error === "unknown_actor");
  ok("'anon' and 'guest' are reserved and already accepted (no code produces them yet)",
    s2.execute({ type: "add_item", command_id: "c6", collection: "probe", fields: { title: "x" }, actor: "anon" }).ok === true);
  // ...but authorship stays OPEN, because tierOf() reads an unrecognised author as PROVENANCE:
  // that is exactly how a third-party app earns the 'unreviewed' tier.
  ok("an arbitrary AUTHOR is still allowed — closing it would delete the trust model",
    s2.execute({ type: "save_app", command_id: "c7", name: "thirdparty", ui: "<!DOCTYPE html><html><body><div id='x'>shape-reservation fixture with enough body to clear the minimum-size guard</div></body></html>", actor: "some-community-author" }).ok === true);

  const strayPrincipal = s2.execute({ type: "add_item", command_id: "c8", collection: "probe", fields: { title: "owned" }, actor: "human", principal: "user_x" });
  ok("a stray principal key on a command is ignored, not stored (reservation dropped, A4)",
    strayPrincipal.ok === true && s2.changesSince("probe", 0).events.every((e) => !("principal" in e) || e.principal === undefined));
  s2.close();
}

console.log("7b. the door: fresh + v4 + v5 open; anything older refuses with the way forward");
// v4 is the shape of the LAST PUBLIC RELEASE (v0.4.2), so this is the case with real users behind
// it: a v4 store must climb BOTH rungs in one open (v4→v5→v6) and arrive with every atom intact.
{
  const OLD = join(ROOT, "test", "ledger-old.db");
  for (const f of [OLD, OLD + "-wal", OLD + "-shm"]) if (existsSync(f)) unlinkSync(f);
  const { default: Database } = await import("better-sqlite3");
  // (a) an ANCIENT store (tables but pre-versioned) is REFUSED, untouched — the ladder reaches
  // back to the last public release and no further, and the refusal must name the way forward
  // rather than guess at history.
  {
    const raw = new Database(OLD);
    raw.exec("CREATE TABLE item (id TEXT PRIMARY KEY, collection TEXT NOT NULL, grp TEXT NOT NULL DEFAULT '', position REAL NOT NULL DEFAULT 0, fields TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    raw.prepare("INSERT INTO item (id, collection, fields, created_at, updated_at) VALUES (?,?,?,?,?)")
       .run("old-1", "legacy-coll", JSON.stringify({ title: "untouched" }), "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    raw.close();
    let refusal = null;
    try { openStore(OLD); } catch (e) { refusal = String(e.message); }
    ok("a pre-v4 store is refused, naming the recovery path", /migrates v4/.test(refusal || ""));
    const check = new Database(OLD, { readonly: true });
    ok("…and the refusal touched NOTHING (rows intact, version still 0)",
      check.pragma("user_version", { simple: true }) === 0 &&
      check.prepare("SELECT fields FROM item WHERE id='old-1'").get() !== undefined);
    check.close();
    for (const f of [OLD, OLD + "-wal", OLD + "-shm"]) if (existsSync(f)) unlinkSync(f);
  }
  // (b) the ONE retained migration, v5 → v6 (W-N): the declaration leaves the document. The
  // fixture exercises the load-bearing legacy semantics — a block-carrying revision, an
  // absent-block revision (which INHERITS), a delete→recreate boundary (which does not), and a
  // CRLF document — because "just parse each row" gets every one of those wrong.
  {
    const OPEN = '<script type="application/json" id="oma-manifest">';
    const legacyDoc = (m, body) => `<!DOCTYPE html><html><head>${m == null ? "" : OPEN + JSON.stringify(m) + "</" + "script>"}</head><body>${body}</body></html>`;
    const raw = new Database(OLD);
    raw.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, collection TEXT NOT NULL, grp TEXT NOT NULL DEFAULT '', position REAL NOT NULL DEFAULT 0, fields TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
              CREATE TABLE app (name TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, html TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT 'agent', scene TEXT, manifest TEXT, kind TEXT NOT NULL DEFAULT 'app', visibility TEXT NOT NULL DEFAULT 'listed', updated_at TEXT NOT NULL);
              CREATE TABLE app_history (name TEXT NOT NULL, version INTEGER NOT NULL, html TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY (name, version));
              CREATE TABLE file (app TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL DEFAULT 'application/octet-stream', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (app, path));
              CREATE TABLE change_event (seq INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_id TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, payload TEXT NOT NULL, actor TEXT NOT NULL, host TEXT, ts TEXT NOT NULL);`);
    const ev = raw.prepare("INSERT INTO change_event (aggregate_id, command_id, event_type, payload, actor, ts) VALUES (?, ?, ?, '{}', 'agent', 'T')");
    const hist = raw.prepare("INSERT INTO app_history (name, version, html, ts) VALUES (?, ?, ?, 'T')");
    const app = raw.prepare("INSERT INTO app (name, version, html, manifest, kind, updated_at) VALUES (?, ?, ?, ?, ?, 'T')");
    // "a": v1 declares visual, v2 has NO block (absent → inherits visual)
    ev.run("a", "m1", "component_saved"); hist.run("a", 1, legacyDoc({ kind: "visual" }, "<p>a1</p>"));
    ev.run("a", "m2", "component_saved"); hist.run("a", 2, legacyDoc(null, "<p>a2</p>"));
    app.run("a", 2, legacyDoc(null, "<p>a2</p>"), JSON.stringify({ kind: "visual" }), "visual");
    // "b": declares, is DELETED, recreated with no block — the new life starts from nothing
    ev.run("b", "m3", "component_saved"); hist.run("b", 3, legacyDoc({ kind: "app", scene: { category_id: "local-tools" } }, "<p>b1</p>"));
    ev.run("b", "m4", "component_deleted");
    ev.run("b", "m5", "component_saved"); hist.run("b", 5, legacyDoc(null, "<p>b2</p>"));
    app.run("b", 5, legacyDoc(null, "<p>b2</p>"), null, "app");
    // "c": a CRLF document whose block must strip without touching the other bytes
    const crlfDoc = `<!DOCTYPE html>\r\n<html><head>${OPEN}{"kind":"visual"}</` + `script></head><body><p>c</p></body></html>`;
    ev.run("c", "m6", "component_saved"); hist.run("c", 6, crlfDoc);
    app.run("c", 6, crlfDoc, JSON.stringify({ kind: "visual" }), "visual");
    raw.pragma("user_version = 5");
    raw.close();
    const migrated = openStore(OLD);
    ok("v5 → v6: every stored document lost its block, head and history alike",
      !migrated.getApp("a").ui.includes("oma-manifest") && !migrated.getAppVersion("a", 1).ui.includes("oma-manifest"));
    ok("a block-carrying revision's manifest moved into the revision column",
      JSON.parse(migrated.getAppVersion("a", 1).manifest).kind === "visual");
    ok("an absent-block revision INHERITED the previous declaration (old three-state semantics)",
      JSON.parse(migrated.getAppVersion("a", 2).manifest).kind === "visual" && migrated.getApp("a").kind === "visual");
    ok("a delete→recreate boundary resets the walk — the new life inherited NOTHING",
      migrated.getAppVersion("b", 5).manifest === null && JSON.parse(migrated.getAppVersion("b", 3).manifest).scene.category_id === "local-tools");
    ok("CRLF bytes outside the block survived the strip verbatim",
      migrated.getApp("c").ui.includes("\r\n") && !migrated.getApp("c").ui.includes("oma-manifest"));
    ok("writes work against the migrated db",
      migrated.execute({ type: "add_item", command_id: "post-mig", collection: "legacy-coll", fields: { title: "after" }, actor: "human" }).ok === true);
    ok("…and the store is stamped v6", migrated.db.pragma("user_version", { simple: true }) === 6);
    migrated.close();
    for (const f of [OLD, OLD + "-wal", OLD + "-shm"]) if (existsSync(f)) unlinkSync(f);
  }
  // (c) v4 — the LAST RELEASED shape (v0.4.2) — climbs BOTH rungs in one open. The fixture below
  // is that release's DDL verbatim (`git show v0.4.2:src/store.mjs`), reserved columns, partial
  // and expression indexes and all: the indexes are not decoration here, they are what a DROP
  // COLUMN has to survive. Built as SQL rather than by driving the old engine because a test
  // cannot check out a tag — the equivalence was drilled once against a real v0.4.2 worktree
  // (store built by v0.4.2's own execute(), opened by this build, every atom compared).
  {
    const OPEN = '<script type="application/json" id="oma-manifest">';
    const legacyDoc = (m, body) => `<!DOCTYPE html><html><head>${m == null ? "" : OPEN + JSON.stringify(m) + "</" + "script>"}</head><body>${body}</body></html>`;
    const v4 = (p) => {
      const raw = new Database(p);
      raw.pragma("journal_mode = WAL");   // as a real v0.4.2 store is — the byte-identity claim below is about ITS bytes
      raw.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, collection TEXT NOT NULL, grp TEXT NOT NULL DEFAULT '', position REAL NOT NULL DEFAULT 0, fields TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, principal TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE INDEX idx_item_collection ON item(collection);
                CREATE INDEX idx_item_coll_grp_pos ON item(collection, grp, position);
                CREATE TABLE app (name TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, html TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT 'agent', scene TEXT, manifest TEXT, kind TEXT NOT NULL DEFAULT 'app', visibility TEXT NOT NULL DEFAULT 'listed', kit_version TEXT, server_script TEXT, updated_at TEXT NOT NULL);
                CREATE TABLE app_history (name TEXT NOT NULL, version INTEGER NOT NULL, html TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY (name, version));
                CREATE TABLE file (app TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL DEFAULT 'application/octet-stream', version INTEGER NOT NULL DEFAULT 1, backend TEXT NOT NULL DEFAULT 'local', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (app, path));
                CREATE INDEX idx_file_app ON file(app);
                CREATE INDEX idx_file_sha ON file(app, sha256);
                CREATE TABLE change_event (seq INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_id TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, payload TEXT NOT NULL, actor TEXT NOT NULL, principal TEXT, host TEXT, ts TEXT NOT NULL);
                CREATE INDEX idx_event_settings ON change_event(seq) WHERE json_extract(payload, '$.collection') = 'settings';
                CREATE INDEX idx_event_file ON change_event(seq) WHERE event_type = 'file_written' OR event_type = 'file_deleted';
                CREATE INDEX idx_event_collection ON change_event(json_extract(payload, '$.collection'), seq);
                CREATE TABLE ledger_truncation (collection TEXT PRIMARY KEY, before_seq INTEGER NOT NULL, ts TEXT NOT NULL);`);
      const ev = raw.prepare("INSERT INTO change_event (aggregate_id, command_id, event_type, payload, actor, principal, ts) VALUES (?, ?, ?, ?, ?, ?, 'T')");
      const hist = raw.prepare("INSERT INTO app_history (name, version, html, ts) VALUES (?, ?, ?, 'T')");
      const app = raw.prepare("INSERT INTO app (name, version, html, manifest, kind, kit_version, updated_at) VALUES (?, ?, ?, ?, ?, 'kit-9', 'T')");
      const item = raw.prepare("INSERT INTO item (id, collection, grp, position, fields, version, principal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'T', 'T')");
      // Data first: rows whose ids the ledger then names, exactly as a live store's do.
      ev.run("i1", "v4-1", "item_added", JSON.stringify({ collection: "reading", group: "queue", position: 1, fields: { title: "one" } }), "human", "user_x");
      item.run("i1", "reading", "queue", 1, JSON.stringify({ title: "one" }), 1, "user_x");
      ev.run("i2", "v4-2", "item_added", JSON.stringify({ collection: "reading", group: "done", position: 2, fields: { title: "two" } }), "agent", null);
      item.run("i2", "reading", "done", 2, JSON.stringify({ title: "two" }), 2, null);
      // "a": v1 declares, v2 has NO block (absent → inherits) — the legacy semantics must survive
      // the first rung untouched, because the second rung is what reads them.
      ev.run("a", "v4-3", "component_saved", "{}", "agent", null); hist.run("a", 3, legacyDoc({ kind: "visual" }, "<p>a1</p>"));
      ev.run("a", "v4-4", "component_saved", "{}", "agent", null); hist.run("a", 4, legacyDoc(null, "<p>a2</p>"));
      app.run("a", 4, legacyDoc(null, "<p>a2</p>"), JSON.stringify({ kind: "visual" }), "visual");
      raw.prepare("INSERT INTO file (app, path, sha256, size, mime, version, backend, created_at, updated_at) VALUES ('a','cover.png',?,5,'image/png',5,'local','T','T')")
         .run("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
      raw.pragma("user_version = 4");
      raw.close();
      return p;
    };

    v4(OLD);
    const m = openStore(OLD);
    ok("v4 → v6: the store climbed both rungs in ONE open", m.db.pragma("user_version", { simple: true }) === 6);
    const cols = (t) => m.db.pragma(`table_info(${t})`).map((c) => c.name);
    ok("the reservations nothing consumed are gone from every table",
      !cols("item").includes("principal") && !cols("change_event").includes("principal") &&
      !cols("app").includes("kit_version") && !cols("app").includes("server_script") && !cols("file").includes("backend"),
      JSON.stringify([cols("app"), cols("change_event")]));
    ok("…and so are the side tables that lost their readers",
      !m.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_truncation'").get());
    ok("the indexes a DROP COLUMN had to survive are still there",
      m.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").get().n === 7);
    ok("every data row crossed both rungs verbatim — grp, position, fields, version",
      JSON.stringify(m.db.prepare("SELECT id, collection, grp, position, fields, version FROM item ORDER BY id").all()) ===
      JSON.stringify([{ id: "i1", collection: "reading", grp: "queue", position: 1, fields: '{"title":"one"}', version: 1 },
        { id: "i2", collection: "reading", grp: "done", position: 2, fields: '{"title":"two"}', version: 2 }]),
      JSON.stringify(m.db.prepare("SELECT * FROM item").all()));
    ok("the ledger is intact — seq, type, aggregate and the actor that makes it worth keeping",
      JSON.stringify(m.db.prepare("SELECT seq, event_type, aggregate_id, actor FROM change_event ORDER BY seq").all()) ===
      JSON.stringify([{ seq: 1, event_type: "item_added", aggregate_id: "i1", actor: "human" },
        { seq: 2, event_type: "item_added", aggregate_id: "i2", actor: "agent" },
        { seq: 3, event_type: "component_saved", aggregate_id: "a", actor: "agent" },
        { seq: 4, event_type: "component_saved", aggregate_id: "a", actor: "agent" }]));
    ok("the file ref survives the dropped backend column", m.statFile("a", "cover.png").version === 5);
    ok("the app's history is whole and the declaration reached the revision column",
      JSON.parse(m.getAppVersion("a", 3).manifest).kind === "visual" && JSON.parse(m.getAppVersion("a", 4).manifest).kind === "visual");
    ok("…with the blocks stripped from the documents, head and history alike",
      !m.getApp("a").ui.includes("oma-manifest") && !m.getAppVersion("a", 3).ui.includes("oma-manifest"));
    ok("writes work against the twice-migrated store",
      m.execute({ type: "add_item", command_id: "post-v4", collection: "reading", fields: { title: "after" }, actor: "human" }).ok === true);
    m.close();
    for (const f of [OLD, OLD + "-wal", OLD + "-shm"]) if (existsSync(f)) unlinkSync(f);

    // (d) the chain is ATOMIC ACROSS RUNGS. The first rung succeeds and the second refuses — if the
    // two were separate transactions the store would be left at v4-stamped-v5 shape, a half state
    // no build can open. One transaction means the dropped columns come back with the rollback.
    v4(OLD);
    {
      const raw = new Database(OLD);
      raw.prepare("UPDATE app_history SET html = ? WHERE name = 'a' AND version = 3")
         .run(`<!DOCTYPE html><html><head>${OPEN}{not json</` + "script></head><body>x</body></html>");
      raw.close();
    }
    const bytesBefore = readFileSync(OLD);
    let refusal = null;
    try { openStore(OLD); } catch (e) { refusal = String(e.message); }
    ok("a v4 store whose declaration cannot be read is refused, naming the offending revision",
      /migration refused/.test(refusal || "") && /a@3/.test(refusal || ""), (refusal || "").slice(0, 160));
    {
      const check = new Database(OLD, { readonly: true });
      ok("…and the FIRST rung rolled back with it — still v4, reservations and all",
        check.pragma("user_version", { simple: true }) === 4 &&
        check.pragma("table_info(item)").some((c) => c.name === "principal") &&
        check.pragma("table_info(app)").some((c) => c.name === "html") &&
        !!check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_truncation'").get());
      check.close();
    }
    ok("…not one byte of the file changed", readFileSync(OLD).equals(bytesBefore));
    for (const f of [OLD, OLD + "-wal", OLD + "-shm"]) if (existsSync(f)) unlinkSync(f);

    // (e) what a real v0.4.2 store actually looks like. A rehearsal against read-only copies of
    // six production stores (2026-08-13) refused five, and not one of the five was corrupt — the
    // rung was strict about its own ASSUMPTIONS. Two of them were wrong, in the shapes below.
    // Every case here is transcribed from that corpus, not invented.
    const v5Store = (p, build) => {
      const raw = new Database(p);
      raw.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, collection TEXT NOT NULL, grp TEXT NOT NULL DEFAULT '', position REAL NOT NULL DEFAULT 0, fields TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE app (name TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, html TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT 'agent', scene TEXT, manifest TEXT, kind TEXT NOT NULL DEFAULT 'app', visibility TEXT NOT NULL DEFAULT 'listed', updated_at TEXT NOT NULL);
                CREATE TABLE app_history (name TEXT NOT NULL, version INTEGER NOT NULL, html TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY (name, version));
                CREATE TABLE file (app TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL DEFAULT 'application/octet-stream', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (app, path));
                CREATE TABLE change_event (seq INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_id TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, payload TEXT NOT NULL, actor TEXT NOT NULL, host TEXT, ts TEXT NOT NULL);`);
      build({
        ev: raw.prepare("INSERT INTO change_event (aggregate_id, command_id, event_type, payload, actor, ts) VALUES (?, ?, 'component_saved', '{}', 'seed', ?)"),
        hist: raw.prepare("INSERT INTO app_history (name, version, html, ts) VALUES (?, ?, ?, ?)"),
        app: raw.prepare("INSERT INTO app (name, version, html, manifest, updated_at) VALUES (?, ?, ?, ?, 'T')"),
      });
      raw.pragma("user_version = 5");
      raw.close();
      return p;
    };
    const reset = () => { for (const f of [OLD, OLD + "-wal", OLD + "-shm"]) if (existsSync(f)) unlinkSync(f); };
    const refuseOf = (p) => { try { openStore(p).close(); return null; } catch (e) { return String(e.message); } };

    // The three shapes that must now CROSS.
    reset();
    const SHARED = { manifest_version: 1, uses_shared: ["locale", "week_start"] };
    const STEWARD = { collections: { notes: { fields: { title: { type: "string" } } } } };
    v5Store(OLD, (q) => {
      // A-forward — v0.4.2 never projected a declaration carrying no `collections` key, which is
      // the uses_shared-only form EVERY app-store app ships. Document declares, column NULL.
      q.ev.run("fwd", "e1", "t1"); q.hist.run("fwd", 1, legacyDoc(SHARED, "<p>fwd</p>"), "t1");
      q.app.run("fwd", 1, legacyDoc(SHARED, "<p>fwd</p>"), null);
      // A-reverse — the document is silent and the column is the only surviving record that this
      // app ever declared anything (the old upsert's CASE carried a projection forward).
      q.ev.run("rev", "e2", "t2"); q.hist.run("rev", 2, legacyDoc(null, "<p>rev</p>"), "t2");
      q.app.run("rev", 2, legacyDoc(null, "<p>rev</p>"), JSON.stringify(STEWARD));
      // B — the seed-era pair: the ledger still says `gallery`, the tables say `library`, and the
      // revision is numbered by the old per-app counter instead of the seq. One transaction, so
      // one timestamp: that is the only thing left that identifies the row.
      q.ev.run("gallery", "e3", "t3"); q.hist.run("library", 1, legacyDoc(SHARED, "<p>lib</p>"), "t3");
      q.app.run("library", 3, legacyDoc(SHARED, "<p>lib</p>"), JSON.stringify(SHARED));
    });
    const mm = openStore(OLD);
    ok("A-forward: a declaration v0.4.2 never projected is ADOPTED at the head slot, not called a mismatch",
      JSON.parse(mm.getApp("fwd").manifest).uses_shared.join() === "locale,week_start", JSON.stringify(mm.getApp("fwd").manifest));
    ok("A-reverse: a column the document stopped carrying survives at the head slot…",
      JSON.parse(mm.getApp("rev").manifest).collections.notes.fields.title.type === "string", JSON.stringify(mm.getApp("rev").manifest));
    ok("…and on the head REVISION too — else the next ui-only edit inherits null and clears it",
      JSON.parse(mm.getAppVersion("rev", 2).manifest).collections.notes.fields.title.type === "string");
    ok("B: a save event whose revision drifted in NAME and VERSION is paired by its timestamp",
      JSON.parse(mm.getAppVersion("library", 1).manifest).uses_shared.join() === "locale,week_start" &&
      !mm.getAppVersion("library", 1).ui.includes("oma-manifest"));
    mm.close();

    // …and the two that must still REFUSE, because they are genuinely ambiguous.
    reset();
    v5Store(OLD, (q) => {
      q.ev.run("clash", "e1", "t1"); q.hist.run("clash", 1, legacyDoc({ kind: "visual" }, "<p>x</p>"), "t1");
      q.app.run("clash", 1, legacyDoc({ kind: "visual" }, "<p>x</p>"), JSON.stringify({ kind: "app" }));
    });
    const clash = refuseOf(OLD);
    ok("a REAL conflict — both sides declare, and they differ — is still fatal",
      /projection_mismatch/.test(clash || "") && /clash@head/.test(clash || ""), (clash || "opened").slice(0, 160));

    reset();
    v5Store(OLD, (q) => {
      // no revision row at all: nothing to find, by seq or by timestamp
      q.ev.run("ghost", "e1", "t1"); q.app.run("ghost", 1, legacyDoc(null, "<p>g</p>"), null);
      // two revisions share one timestamp and neither is addressed by its seq — the fallback
      // must refuse to pick rather than pick wrong. This is the whole width of the tolerance.
      q.ev.run("amb-x", "e2", "tz"); q.ev.run("amb-y", "e3", "tz");
      q.hist.run("amb-x", 7, legacyDoc(null, "<p>x</p>"), "tz");
      q.hist.run("amb-y", 8, legacyDoc(null, "<p>y</p>"), "tz");
    });
    const stillBad = refuseOf(OLD);
    ok("a save event with no revision anywhere is still fatal, and so is an AMBIGUOUS timestamp",
      /ghost@1: save_event_without_revision/.test(stillBad || "") &&
      /amb-x@2: save_event_without_revision/.test(stillBad || "") &&
      /amb-y@3: save_event_without_revision/.test(stillBad || ""), (stillBad || "opened").slice(0, 200));
    reset();
  }
}

console.log("8. a FUTURE-versioned store is refused by an older build");
{
  const FUT = join(ROOT, "test", "ledger-future.db");
  for (const f of [FUT, FUT + "-wal", FUT + "-shm"]) if (existsSync(f)) unlinkSync(f);
  const { default: Database } = await import("better-sqlite3");
  const raw = new Database(FUT);
  raw.exec("CREATE TABLE item (id TEXT PRIMARY KEY, collection TEXT NOT NULL, grp TEXT NOT NULL DEFAULT '', position REAL NOT NULL DEFAULT 0, fields TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  raw.pragma("user_version = 99");
  raw.close();
  let refusal = null;
  try { openStore(FUT); } catch (e) { refusal = String(e.message); }
  ok("a v99 store tells this build to update instead of writing old-shaped events into it",
    /update open-mcp-apps/.test(refusal || ""));
  for (const f of [FUT, FUT + "-wal", FUT + "-shm"]) if (existsSync(f)) unlinkSync(f);
}

for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

// ───────────────────────────────────────────────────────────────────── undo: one verb, every plane
console.log("\n9. undo — pre-image in the ledger, one verb, no tool");
{
  const st = openStore(DB);
  const cid = () => randomUUID();
  const a = st.execute({ type: "add_item", command_id: cid(), collection: "undo-t", fields: { title: "one", n: 1 }, actor: "agent" });
  st.execute({ type: "update_item", command_id: cid(), id: a.id, fields: { title: "two" }, actor: "agent" });
  const evs = st.changesSince("undo-t", 0, 10).events;
  ok("an update records the PRE-IMAGE of exactly the keys it touched",
    evs.at(-1).was && evs.at(-1).was.title === "one" && !("n" in evs.at(-1).was));
  ok("undo restores them", st.undoLast(a.id).ok && st.snapshot("undo-t").items[0].fields.title === "one");
  ok("...and leaves the untouched keys alone", st.snapshot("undo-t").items[0].fields.n === 1);

  st.execute({ type: "delete_item", command_id: cid(), id: a.id, actor: "agent" });
  ok("a delete records the WHOLE row (nothing else survives to rebuild it)",
    st.changesSince("undo-t", 0, 10).events.at(-1).was.title === "one");
  const back = st.undoLast(a.id);
  ok("undo brings the row back, same id, same fields",
    back.ok && st.snapshot("undo-t").items.length === 1 && st.snapshot("undo-t").items[0].id === a.id);

  st.execute({ type: "save_app", command_id: cid(), name: "undo-comp", ui: "<p>A</p>", actor: "agent" });
  st.execute({ type: "save_app", command_id: cid(), name: "undo-comp", ui: "<p>B</p>", actor: "agent" });
  ok("undo on an app rolls FORWARD to the previous ui", st.undoLast("undo-comp").ok && st.getApp("undo-comp").ui === "<p>A</p>");
  ok("history grew instead of being rewritten (so the undo is itself undoable)",
    st.appHistory("undo-comp").length === 3);
  ok("undoing the undo works — the ledger is append-only in both directions",
    st.undoLast("undo-comp").ok && st.getApp("undo-comp").ui === "<p>B</p>");
  ok("nothing to undo says so, rather than pretending", st.undoLast("no-such-target").error === "nothing_to_undo");

  // (retention/pruneLedger retired 2026-08-04, elegance A2 — the ledger is append-only and
  // unbounded until a real maintenance caller exists.)
  ok("the store exposes no pruner (append-only, unbounded)", st.pruneLedger === undefined && st.retentionEvents === undefined);
  st.close();
}


console.log("\n11. the manifest slot's tri-state — omit inherits, null clears, {} refused");
{
  const st = openStore(DB);
  const cid = () => randomUUID();
  st.execute({ type: "save_app", command_id: cid(), name: "clear-probe", ui: "<p>probe</p>",
    manifest: { manifest_version: 2, kind: "visual", scene: { category_id: "local-tools" } }, actor: "human" });
  let cp = st.getApp("clear-probe");
  ok("a declared kind and scene materialise as projections", cp.kind === "visual" && JSON.parse(cp.scene).category_id === "local-tools");
  st.execute({ type: "save_app", command_id: cid(), name: "clear-probe", ui: "<p>probe v2</p>", actor: "human" });
  cp = st.getApp("clear-probe");
  ok("an omitted slot INHERITS — a ui-only save never loses the declaration",
    JSON.parse(cp.manifest).kind === "visual" && cp.kind === "visual" && cp.ui === "<p>probe v2</p>");
  st.execute({ type: "save_app", command_id: cid(), name: "clear-probe", manifest: null, actor: "human" });
  cp = st.getApp("clear-probe");
  ok("manifest: null clears ALL projections — manifest and scene to null, kind back to its default",
    cp.manifest === null && cp.scene === null && cp.kind === "app" && cp.ui === "<p>probe v2</p>");
  const amb = st.execute({ type: "save_app", command_id: cid(), name: "clear-probe", manifest: {}, actor: "human" });
  ok("manifest: {} is refused — one spelling must not carry two meanings",
    amb.ok === false && amb.error === "empty_manifest_use_null", JSON.stringify(amb));
  const blocked = st.execute({ type: "save_app", command_id: cid(), name: "clear-probe",
    ui: `<p>x</p><script type="application/json" id="oma-manifest">{}<` + `/script>`, actor: "human" });
  ok("a document still carrying the legacy block is refused loudly, never inert",
    blocked.ok === false && blocked.error === "embedded_manifest_block", JSON.stringify(blocked));
  const noSlots = st.execute({ type: "save_app", command_id: cid(), name: "clear-probe", actor: "human" });
  ok("touching neither slot is a refusal, not a ghost version", noSlots.error === "no_slots_provided");

  console.log("\n12. a move remembers where it left — from_position rides the pre-image");
  const mA = st.execute({ type: "add_item", command_id: cid(), collection: "move-t", group: "g", fields: { t: "A" }, actor: "human" });
  st.execute({ type: "add_item", command_id: cid(), collection: "move-t", group: "g", fields: { t: "B" }, actor: "human" });
  const posBefore = st.snapshot("move-t").items.find((i) => i.id === mA.id).position;
  st.execute({ type: "move_item", command_id: cid(), id: mA.id, group: "h", actor: "human" });
  st.undoLast(mA.id);
  const back = st.snapshot("move-t").items.find((i) => i.id === mA.id);
  ok("undoing a move restores the group AND the position it left from",
    back.group === "g" && back.position === posBefore, `group=${back.group} position=${back.position} want=${posBefore}`);

  console.log("\n13. declaration-quality notes reach the save receipt");
  const declOn = (extra) => ({ manifest_version: 2, collections: { shared_notes: extra } });
  const rA = st.execute({ type: "save_app", command_id: cid(), name: "decl-a", ui: "<p>a</p>",
    manifest: declOn({ fields: { title: { type: "string" } }, label_field: "headline" }), actor: "human" });
  ok("label_field outside the declared fields warns without rejecting",
    rA.ok === true && /label_field "headline" is not among/.test(rA.note || ""), rA.note);
  const rB = st.execute({ type: "save_app", command_id: cid(), name: "decl-b", ui: "<p>b</p>",
    manifest: declOn({ fields: { title: { type: "number" } } }), actor: "human" });
  ok("a second declarer of the same key hears about the conflict and who wins",
    rB.ok === true && /declared by decl-a and decl-b/.test(rB.note || "") && /title \(redeclared by decl-b\)/.test(rB.note || ""), rB.note);

  console.log("\n14. archive is an event on the one axis — and undo restores the EXACT visibility");
  st.executePrivileged({ type: "archive_app", command_id: cid(), name: "decl-a", visibility: "featured", actor: "human" });
  const arch = st.execute({ type: "archive_app", command_id: cid(), name: "decl-a", archived: true, actor: "human" });
  ok("archive stamps the row's version with its event seq (one axis, no exceptions)",
    arch.ok === true && st.getApp("decl-a").visibility === "archived" && st.getApp("decl-a").version === arch.seq);
  st.undoLast("decl-a");
  ok("undoing the flip restores featured — the pre-image, not merely 'listed'",
    st.getApp("decl-a").visibility === "featured");
  st.close();
}

{
  console.log("\n15. the shadow via edge — stamped into payloads, invisible on every AI face");
  const P = join(ROOT, "test", "via.db");
  for (const f of [P, P + "-wal", P + "-shm"]) if (existsSync(f)) unlinkSync(f);
  const st = openStore(P);
  const cid = () => randomUUID();
  // These sections exercise via/undo MECHANICS with human-actor writes; the W-S confirmation
  // layer (its own suite: test/confirmation.mjs) is switched off the designed way — the pref.
  st.execute({ type: "add_item", command_id: cid(), collection: "settings", fields: { key: "confirm_delete", value: false }, actor: "human" });
  const w1 = st.execute({ type: "add_item", command_id: cid(), collection: "vp", fields: { t: "a" }, actor: "human", via: { app: "my-app" } });
  ok("a valid via lands in the ledger payload (object form, frozen)",
    w1.ok === true && st.recentEvents({ collection: "vp" })[0].via.app === "my-app");
  const w2 = st.execute({ type: "update_item", command_id: cid(), id: w1.id, fields: { t: "b" }, actor: "human", via: { app: "my-app", function: "tick" } });
  ok("the function key rides when present — write-set F never changes the shape",
    w2.ok === true && st.recentEvents({ collection: "vp" })[0].via.function === "tick");
  const w3 = st.execute({ type: "move_item", command_id: cid(), id: w1.id, group: "g2", actor: "human", via: { app: "BAD NAME!" } });
  ok("an invalid via is DROPPED, never refused — a write must not fail over its shadow",
    w3.ok === true && st.recentEvents({ collection: "vp" })[0].via === undefined);
  const ch = st.changesSince("vp", 0, 50);
  ok("changesSince (the AI face) strips via from every event",
    ch.events.length === 3 && ch.events.every((e) => !("via" in e)));
  ok("recentEvents keeps via AND marks the aggregate's latest event undoable",
    st.recentEvents({ collection: "vp" }).every((e) => e.undoable === (e.seq === w3.seq)));
  const b = st.executeBatch([{ type: "add_item", command_id: cid(), collection: "vp", fields: { t: "c" }, actor: "agent", via: { app: "my-app" } }]);
  ok("the batch key filter excludes via — the model's bulk verb cannot stamp a shadow",
    b.ok === true && st.recentEvents({ collection: "vp", limit: 1 })[0].via === undefined);

  console.log("\n16. undo edges — creation, null-sentinel round trip, recreate collision");
  const u0 = st.undoLast(b.results[0].id);
  ok("undo of a creation deletes the row (delete's `was` keeps the undo undoable)",
    u0.ok === true && u0.deleted === true);
  const u1 = st.undoLast(b.results[0].id);
  ok("…and undoing THAT restores the row with its exact fields",
    u1.ok === true && u1.item.fields.t === "c");
  // null-sentinel round trip: an update that ADDED a key records was:{k:null}; undo removes it.
  const nx = st.execute({ type: "add_item", command_id: cid(), collection: "vp", fields: { keep: 1 }, actor: "human" });
  st.execute({ type: "update_item", command_id: cid(), id: nx.id, fields: { added: "yes" }, actor: "human" });
  const u2 = st.undoLast(nx.id);
  ok("a key the update ADDED goes back to ABSENT (null is 'remove', so the round trip is exact)",
    u2.ok === true && !("added" in u2.item.fields) && u2.item.fields.keep === 1);
  // delete → recreate under the same id → undo of the delete must refuse, not clobber or throw
  const dx = st.execute({ type: "add_item", command_id: cid(), collection: "vp", fields: { t: "orig" }, actor: "human" });
  st.execute({ type: "delete_item", command_id: cid(), id: dx.id, actor: "human" });
  st.executePrivileged({ type: "add_item", command_id: cid(), id: dx.id, collection: "vp", fields: { t: "recreated" }, actor: "human" });
  // the recreate is now the aggregate's LAST event, so first undo it (removes the recreate)…
  const u3 = st.undoLast(dx.id);
  ok("undo walks the aggregate's history newest-first (recreate undone first)", u3.ok === true && u3.deleted === true);
  // …after which the last event is that deletion; undo restores the RECREATED image. Now force
  // the collision: make the live row exist while the last event is a delete of the same id.
  st.undoLast(dx.id);   // restores {t:"recreated"} — last event is now an add
  const del2 = st.execute({ type: "delete_item", command_id: cid(), id: dx.id, actor: "human" });
  st.executePrivileged({ type: "add_item", command_id: cid(), id: dx.id, collection: "vp", fields: { t: "again" }, actor: "human" });
  // aggregate's last event = the recreate; craft the collision via the DELETE event directly:
  ok("delete happened then id lives again — setup sane", del2.ok === true && st.snapshot("vp").items.some((i) => i.id === dx.id));
  const u4 = st.undoLast(dx.id);          // undoes the recreate (delete) …
  const u5 = st.undoLast(dx.id);          // … last event now the delete; id is FREE → restore works
  ok("the chain converges without ever throwing", u4.ok === true && u5.ok === true);
  ok("a save with no earlier version refuses by name", (() => {
    st.execute({ type: "save_app", command_id: cid(), name: "one-save", ui: "<p>v1</p>", actor: "human" });
    return st.undoLast("one-save").error === "no_previous_version";
  })());
  // stale-undo guard: a target that advanced since the pane looked must refuse, not revert the
  // newer write (adversarial D review — reproduced a silent 2→1 field revert).
  {
    const w = st.execute({ type: "add_item", command_id: cid(), collection: "vp", fields: { v: 1 }, actor: "human" });
    const shown = w.seq;                                   // what the pane rendered an Undo for
    const w2 = st.execute({ type: "update_item", command_id: cid(), id: w.id, fields: { v: 2 }, actor: "human" });
    const stale = st.undoLast(w.id, { expectedSeq: shown });
    ok("undo pinned to a stale seq refuses (stale_undo), leaving the newer write intact",
      stale.ok === false && stale.error === "stale_undo" && stale.latest_seq === w2.seq &&
      st.snapshot("vp").items.find((i) => i.id === w.id).fields.v === 2);
    const fresh = st.undoLast(w.id, { expectedSeq: w2.seq });   // pin the CURRENT last event
    ok("undo pinned to the current seq proceeds", fresh.ok === true &&
      st.snapshot("vp").items.find((i) => i.id === w.id).fields.v === 1);
  }
  st.close();
  for (const f of [P, P + "-wal", P + "-shm"]) if (existsSync(f)) unlinkSync(f);
}

console.log("\n17. a NAME is not an identity — a second life is a different app");
// A delete is a tombstone, so the ledger and app_history keep every trace of the app that
// used to bear a name. Two separate destructive decisions were reading those traces as if they
// belonged to whatever app bears the name NOW:
//
//   · cascade's ownership test asked "was this collection born after the app?" against the FIRST
//     component_saved ever recorded under that name — so rows a user created while NO app existed
//     were judged to belong to the app that appeared afterwards, and deleted;
//   · app_history listed every checkpoint ever saved under that name, so restoring
//     "checkpoint 1" of a budget tracker could hand back a deleted recipe app's source.
//
// Same root, one primitive: an app's CURRENT LIFE starts at the most recent delete that was
// followed by a save (0 if it was never deleted). Everything before that belongs to someone else.
{
  const P = join(ROOT, "test", "lives.db");
  for (const f of [P, P + "-wal", P + "-shm"]) if (existsSync(f)) unlinkSync(f);
  const st = openStore(P);
  const HTML = (t) => `<!doctype html><html><body>${t}</body></html>`;
  let n = 0; const cid = () => "life" + (++n);

  // Life 1: a recipe app, saved twice, then deleted (data kept — the default).
  st.execute({ type: "save_app", command_id: cid(), name: "notes", ui: HTML("RECIPES v1"), actor: "agent" });
  const life1v2 = st.execute({ type: "save_app", command_id: cid(), name: "notes", ui: HTML("RECIPES v2"), actor: "agent" }).version;
  st.execute({ type: "delete_app", command_id: cid(), name: "notes", actor: "agent" });

  // Between the lives the USER puts rows into a collection that happens to share the name.
  for (let i = 0; i < 3; i++)
    st.execute({ type: "add_item", command_id: cid(), collection: "notes", fields: { t: "mine " + i }, actor: "human" });

  // Life 2: a completely unrelated app, same name.
  st.execute({ type: "save_app", command_id: cid(), name: "notes", ui: HTML("BUDGET TRACKER"), actor: "agent" });

  // ---- N10: history is this app's history
  const hist = st.appHistory("notes");
  ok("history lists only the CURRENT life's checkpoints",
    hist.length === 1 && hist[0].checkpoint === 1, JSON.stringify(hist));
  const cp1 = hist.find((h) => h.checkpoint === 1);
  ok("…so restoring 'checkpoint 1' cannot hand back a deleted, unrelated app",
    !!cp1 && st.getAppVersion("notes", cp1.version).ui.includes("BUDGET TRACKER"),
    cp1 ? st.getAppVersion("notes", cp1.version).ui : "no checkpoint 1");
  // The tombstone promise, and §21's real property: the earlier rows were never overwritten.
  ok("the previous life's source is still IN the table — retained, not clobbered (no REPLACE over a tombstone)",
    st.getAppVersion("notes", life1v2).ui.includes("RECIPES v2"));

  // (N3 — cascade's ownership judge — retired with cascade itself, elegance B1. The life
  // primitive above is what survives: it still scopes history and restore to THIS app's life.)

  // ---- a deleted app that was NOT recreated keeps its history reachable (the documented tombstone)
  st.execute({ type: "save_app", command_id: cid(), name: "gone", ui: HTML("GONE v1"), actor: "agent" });
  st.execute({ type: "save_app", command_id: cid(), name: "gone", ui: HTML("GONE v2"), actor: "agent" });
  st.execute({ type: "delete_app", command_id: cid(), name: "gone", actor: "agent" });
  ok("a tombstoned app still lists its OWN checkpoints — 'history survives delete' is unchanged",
    st.appHistory("gone").length === 2, JSON.stringify(st.appHistory("gone")));

  st.close();
  for (const f of [P, P + "-wal", P + "-shm"]) if (existsSync(f)) unlinkSync(f);
}

console.log("\n18. delete replay — idempotent at the COMMAND level (cascade receipts retired with cascade)");
{
  const P = join(ROOT, "test", "cid.db");
  for (const f of [P, P + "-wal", P + "-shm"]) if (existsSync(f)) unlinkSync(f);
  const st = openStore(P);
  const HTML = "<!doctype html><html><body>fixture body long enough to clear the size floor</body></html>";
  let n = 0; const cid = () => "cid-" + (++n);
  st.execute({ type: "save_app", command_id: cid(), name: "kept", ui: HTML, actor: "agent" });
  st.execute({ type: "add_item", command_id: cid(), collection: "kept", fields: { t: "still here" }, actor: "agent" });
  const KEEP = "reused-id";
  st.execute({ type: "delete_app", command_id: KEEP, name: "kept", actor: "agent" });
  const replay = st.execute({ type: "delete_app", command_id: KEEP, name: "kept", actor: "agent" });
  ok("a replayed delete short-circuits at the command level", replay.ok === true && replay.idempotent === true);
  ok("…and never claims a cascade it did not perform (retired verb, historical echo only)",
    replay.cascaded === undefined);
  ok("…and the rows a keep-delete never took are still there", st.snapshot("kept").items.length === 1);
  st.close();
  for (const f of [P, P + "-wal", P + "-shm"]) if (existsSync(f)) unlinkSync(f);
}

// §19 (N9 — pruned history vs ownership) retired 2026-08-04: BOTH halves of that collision are
// gone — pruneLedger/retention (elegance A2, zero production callers) and cascade's ownership
// judge (elegance B1). The asymmetry doctrine it protected returns with cascade on W1's MRTR.

console.log(`\nledger: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
