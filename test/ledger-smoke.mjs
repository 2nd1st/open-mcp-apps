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
  store.execute({ type: "delete_item", command_id: "dl1", id: target.id, actor: "human", host: "smoke" });
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
    html: "<!DOCTYPE html><html><body><div id='x'>shape-reservation fixture with enough body to clear the minimum-size guard</div></body></html>", actor: "agent" });
  ok("app saves", r.ok === true);
  const row = s2.listApps().find((c) => c.name === "shaped");
  ok("kind defaults to 'app' — so nothing vanishes from list_apps today",
    row.kind === "app", JSON.stringify(row.kind));
  ok("visibility defaults to 'listed'", row.visibility === "listed");
  ok("kit_version starts null (L4 fills it)", row.kit_version === null);

  // The two columns come from DIFFERENT places, and the split is the design: `kind` is something the
  // author knows about their own app, so it lives in the declaration; `visibility` is lifecycle
  // state (retired, curated, long-tail) that someone else decides later, so it stays a command.
  const shapedHtml = (decl) => "<!DOCTYPE html><html><head>" +
    (decl ? `<script type="application/json" id="oma-manifest">${JSON.stringify(decl)}</script>` : "") +
    "</head><body><div id='x'>shape-reservation fixture with enough body to clear the minimum-size guard</div></body></html>";

  s2.execute({ type: "save_app", command_id: "c2", name: "shaped", actor: "agent",
    html: shapedHtml({ manifest_version: 2, kind: "visual" }), visibility: "unlisted" });
  const v = s2.listApps().find((c) => c.name === "shaped");
  ok("kind arrives from the declaration, visibility from the command", v.kind === "visual" && v.visibility === "unlisted");

  s2.execute({ type: "save_app", command_id: "c3", name: "shaped", html: shapedHtml(null), actor: "agent" });
  const k = s2.listApps().find((c) => c.name === "shaped");
  ok("a document that says nothing preserves both (three-state, not a reset)",
    k.kind === "visual" && k.visibility === "unlisted", JSON.stringify([k.kind, k.visibility]));

  ok("a typo'd kind is refused at the declaration, not stored",
    s2.execute({ type: "save_app", command_id: "c4", name: "shaped", html: shapedHtml({ kind: "aap" }), actor: "agent" }).error === "bad_manifest");

  // E13b: the closed actor set is what keeps an anonymous write from landing as "human".
  ok("an unknown actor on a DATA write is refused",
    s2.execute({ type: "add_item", command_id: "c5", collection: "probe", fields: { title: "x" }, actor: "sneaky" }).error === "unknown_actor");
  ok("'anon' and 'guest' are reserved and already accepted (no code produces them yet)",
    s2.execute({ type: "add_item", command_id: "c6", collection: "probe", fields: { title: "x" }, actor: "anon" }).ok === true);
  // ...but authorship stays OPEN, because tierOf() reads an unrecognised author as PROVENANCE:
  // that is exactly how a third-party app earns the 'unreviewed' tier.
  ok("an arbitrary AUTHOR is still allowed — closing it would delete the trust model",
    s2.execute({ type: "save_app", command_id: "c7", name: "thirdparty", html: "<!DOCTYPE html><html><body><div id='x'>shape-reservation fixture with enough body to clear the minimum-size guard</div></body></html>", actor: "some-community-author" }).ok === true);

  const withPrincipal = s2.execute({ type: "add_item", command_id: "c8", collection: "probe", fields: { title: "owned" }, actor: "human", principal: "user_x" });
  ok("principal rides into the ledger when supplied", withPrincipal.ok === true);
  const ev = s2.changesSince("probe", 0).events.find((e) => e.principal === "user_x");
  ok("🔴 and comes back out — the one reservation that cannot be added retroactively", !!ev);
  ok("absent principal stays absent (today's meaning: shared across the org)",
    s2.changesSince("probe", 0).events.some((e) => e.principal === undefined));
  s2.close();
}

console.log("7b. a database that predates the columns gains them, with its rows intact");
{
  // Build the OLD shape by hand — this is the only way to prove the ALTER path, and it is the path
  // every existing deployment will take. A migration that is only ever exercised on fresh
  // databases has not been tested at all.
  const OLD = join(ROOT, "test", "ledger-old.db");
  for (const f of [OLD, OLD + "-wal", OLD + "-shm"]) if (existsSync(f)) unlinkSync(f);
  const { default: Database } = await import("better-sqlite3");
  const raw = new Database(OLD);
  raw.exec(`CREATE TABLE app (name TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, html TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT 'agent', updated_at TEXT NOT NULL);
            CREATE TABLE item (id TEXT PRIMARY KEY, collection TEXT NOT NULL, grp TEXT NOT NULL DEFAULT '',
              position REAL NOT NULL DEFAULT 0, fields TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  raw.prepare("INSERT INTO app (name, html, description, author, updated_at) VALUES (?,?,?,?,?)")
     .run("legacy", "<html>old</html>", "made before the columns existed", "agent", "2026-01-01T00:00:00Z");
  raw.prepare("INSERT INTO item (id, collection, fields, created_at, updated_at) VALUES (?,?,?,?,?)")
     .run("old-1", "legacy-coll", JSON.stringify({ title: "survived" }), "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  raw.close();

  const migrated = openStore(OLD);
  const comp = migrated.listApps().find((c) => c.name === "legacy");
  ok("the pre-existing app is still there", !!comp && comp.description === "made before the columns existed");
  ok("and acquired kind='app' / visibility='listed' — no row disappears from any list",
    comp.kind === "app" && comp.visibility === "listed", JSON.stringify([comp?.kind, comp?.visibility]));
  ok("its data survived untouched", migrated.snapshot("legacy-coll").items[0].fields.title === "survived");
  ok("writes work against the migrated db",
    migrated.execute({ type: "add_item", command_id: "post-mig", collection: "legacy-coll", fields: { title: "after" }, actor: "human" }).ok === true);
  ok("and the ledger read path works on it", migrated.changesSince("legacy-coll", 0).total === 1);
  migrated.close();
  for (const f of [OLD, OLD + "-wal", OLD + "-shm"]) if (existsSync(f)) unlinkSync(f);
}

console.log("8. E4a — the forward-migration branch exists before the first bump needs it");
{
  const { migrationsBetween, MIGRATIONS } = await import("../src/store.mjs");
  ok("a version with no registered step contributes nothing (0->1 predates the first bump)", migrationsBetween(0, 1).length === 0);
  MIGRATIONS[99] = () => {};
  MIGRATIONS[100] = () => {};
  ok("runs exactly the versions in (from, to]", migrationsBetween(98, 100).length === 2);
  ok("excludes the version already stamped", migrationsBetween(99, 100).length === 1);
  ok("empty when already current", migrationsBetween(100, 100).length === 0);
  delete MIGRATIONS[99]; delete MIGRATIONS[100];
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

  st.execute({ type: "save_app", command_id: cid(), name: "undo-comp", html: "<p>A</p>", actor: "agent" });
  st.execute({ type: "save_app", command_id: cid(), name: "undo-comp", html: "<p>B</p>", actor: "agent" });
  ok("undo on an app rolls FORWARD to the previous html", st.undoLast("undo-comp").ok && st.getApp("undo-comp").html === "<p>A</p>");
  ok("history grew instead of being rewritten (so the undo is itself undoable)",
    st.appHistory("undo-comp").length === 3);
  ok("undoing the undo works — the ledger is append-only in both directions",
    st.undoLast("undo-comp").ok && st.getApp("undo-comp").html === "<p>B</p>");
  ok("nothing to undo says so, rather than pretending", st.undoLast("no-such-target").error === "nothing_to_undo");

  // Retention is a POLICY VALUE, not a feature: unbounded until a deployment says otherwise.
  ok("the engine's default keeps everything (a silent pruner is the worst data loss)", st.retentionEvents() === null);
  ok("pruning with no policy is a no-op that says which policy it followed", st.pruneLedger("undo-t").policy === "unbounded");
  st.executePrivileged({ type: "add_item", command_id: cid(), collection: "settings", fields: { key: "policy:retention.events", value: 2 }, actor: "human" });
  ok("the policy key is readable once set", st.retentionEvents() === 2);
  const pruned = st.pruneLedger("undo-t");
  ok("pruning keeps the newest window and reports what it dropped", pruned.pruned > 0 && st.changesSince("undo-t", 0, 50).events.length === 2);
  ok("the DATA is untouched — retention bounds history, never state", st.snapshot("undo-t").items.length === 1);
  st.close();
}


// ─────────────────────────────────────────────────────── aggregate: the answer travels, not the rows
console.log("\n10. data_query's engine — one filter table shared with match, and an auditable answer");
{
  const st = openStore(DB);
  const cid = () => randomUUID();
  const rows = [
    { category: "coffee", amount: 4.5, note: "latte" },
    { category: "coffee", amount: 3.75 },
    { category: "books", amount: 32, note: "novel" },
    { category: "books", amount: 12 },
    { category: "rent", amount: 1200 },
    { category: "coffee", amount: "not a number" },      // deliberately non-numeric
  ];
  st.executeBatch(rows.map((f) => ({ type: "add_item", command_id: cid(), collection: "agg", fields: f, actor: "agent" })));

  const all = st.aggregate("agg", { metrics: [{ op: "count" }] });
  ok("count with no grouping is one bucket over everything", all.groups.length === 1 && all.groups[0].count === 6);
  ok("`matched` and `scanned` are both reported — an aggregate you cannot check is one you must trust",
    all.scanned === 6 && all.matched === 6);

  const byCat = st.aggregate("agg", { group_by: "category", metrics: [{ op: "sum", field: "amount" }] });
  ok("grouped, biggest bucket first (a grouped answer is read as a ranking)",
    byCat.groups[0].category === "coffee" && byCat.groups[0].count === 3);
  const coffee = byCat.groups.find((g) => g.category === "coffee");
  ok("the sum ignores the non-numeric row", coffee.sum_amount === 8.25);
  ok("...and SAYS it did: `_from` reports how many rows carried a number", coffee.sum_amount_from === 2,
    `sum over ${coffee.sum_amount_from} of ${coffee.count}`);
  const books = byCat.groups.find((g) => g.category === "books");
  ok("a bucket where every row counted carries no `_from` (it would be noise)", books.sum_amount === 44 && books.sum_amount_from === undefined);

  // The filter grammar is the SAME one data_list's match uses — that is the whole point of the table.
  const big = st.aggregate("agg", { match: { amount: { gte: 12 } }, metrics: [{ op: "max", field: "amount" }, { op: "min", field: "amount" }] });
  ok("operators filter before aggregating", big.matched === 3 && big.groups[0].max_amount === 1200 && big.groups[0].min_amount === 12);
  // Found by this very test, when it expected 3 and got 4: the comparison KIND has to come from the
  // filter. A numeric question cannot be answered "yes" by a value that is not a number — and the
  // aggregate already treats such a value that way, so the filter agreeing with it is what keeps
  // this one doctrine instead of two that nearly match.
  ok("a numeric comparison does not match a non-numeric value (no silent string-order fallback)",
    !st.aggregate("agg", { match: { amount: { gte: 12 } } }).groups.some(() => false) &&
    st.aggregate("agg", { match: { amount: { gte: 0 } } }).matched === 5);
  ok("a STRING comparison still orders lexicographically — this is what makes ISO dates work",
    st.aggregate("agg", { match: { category: { gte: "coffee" } } }).matched === 4);
  const has = st.aggregate("agg", { match: { note: { exists: true } } });
  ok("exists works on absence, not on falsiness", has.matched === 2);
  const pre = st.aggregate("agg", { match: { category: { prefix: "co" } } });
  ok("prefix works (the ISO-date workhorse)", pre.matched === 3);
  ok("a typo'd operator is named, never silently matching nothing",
    st.aggregate("agg", { match: { amount: { greaterThan: 1 } } }).error === "unknown_operator");
  ok("an unknown metric is named too", st.aggregate("agg", { metrics: [{ op: "median", field: "amount" }] }).error === "unknown_metric");
  ok("a metric that needs a field says which one", st.aggregate("agg", { metrics: [{ op: "sum" }] }).error === "metric_needs_field");

  // match and aggregate must AGREE — two filter implementations would be two dialects.
  const viaRead = st.queryItems("agg", { match: { category: "coffee" }, limit: 500 }).items.length;
  const viaAgg = st.aggregate("agg", { match: { category: "coffee" } }).matched;
  ok("the read path and the aggregate path count the same rows for the same filter", viaRead === viaAgg && viaRead === 3);
  st.close();
}

// ─────────────────────────────────────────────────────── cold-review pins (fix wave, 2026-07-26)
console.log("\n11. clear semantics are ONE thing — {} ≡ whitespace ≡ cleared projections");
{
  const st = openStore(DB);
  const cid = () => randomUUID();
  const block = (json) => `<p>probe</p><script type="application/json" id="oma-manifest">${json}<` + `/script>`;
  st.execute({ type: "save_app", command_id: cid(), name: "clear-probe",
    html: block('{"manifest_version":2,"kind":"visual","scene":{"category_id":"local-tools"}}'), actor: "human" });
  let cp = st.getApp("clear-probe");
  ok("a declared kind and scene materialise", cp.kind === "visual" && JSON.parse(cp.scene).category_id === "local-tools");
  st.execute({ type: "save_app", command_id: cid(), name: "clear-probe", html: block("{}"), actor: "human" });
  cp = st.getApp("clear-probe");
  ok("{} clears ALL projections — manifest and scene to null, kind back to its default",
    cp.manifest === null && cp.scene === null && cp.kind === "app");
  st.execute({ type: "save_app", command_id: cid(), name: "clear-probe",
    html: block('{"manifest_version":2,"kind":"visual","scene":{"category_id":"local-tools"}}'), actor: "human" });
  const sv = st.execute({ type: "save_app", command_id: cid(), name: "clear-probe",
    html: block("{not json}"), declaration_policy: "salvage", actor: "human" });
  cp = st.getApp("clear-probe");
  ok("salvage on a bad block clears the SAME set, and the note says so",
    sv.ok === true && /scene and kind reset too/.test(sv.note || "") && cp.manifest === null && cp.scene === null && cp.kind === "app",
    sv.note);

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
  const declOn = (extra) => block(JSON.stringify({ manifest_version: 2, collections: { shared_notes: extra } }));
  const rA = st.execute({ type: "save_app", command_id: cid(), name: "decl-a",
    html: declOn({ fields: { title: { type: "string" } }, label_field: "headline" }), actor: "human" });
  ok("label_field outside the declared fields warns without rejecting",
    rA.ok === true && /label_field "headline" is not among/.test(rA.note || ""), rA.note);
  const rB = st.execute({ type: "save_app", command_id: cid(), name: "decl-b",
    html: declOn({ fields: { title: { type: "number" } } }), actor: "human" });
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
    st.execute({ type: "save_app", command_id: cid(), name: "one-save", html: "<p>v1</p>", actor: "human" });
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
  st.execute({ type: "save_app", command_id: cid(), name: "notes", html: HTML("RECIPES v1"), actor: "agent" });
  const life1v2 = st.execute({ type: "save_app", command_id: cid(), name: "notes", html: HTML("RECIPES v2"), actor: "agent" }).version;
  st.execute({ type: "delete_app", command_id: cid(), name: "notes", actor: "agent" });

  // Between the lives the USER puts rows into a collection that happens to share the name.
  for (let i = 0; i < 3; i++)
    st.execute({ type: "add_item", command_id: cid(), collection: "notes", fields: { t: "mine " + i }, actor: "human" });

  // Life 2: a completely unrelated app, same name.
  st.execute({ type: "save_app", command_id: cid(), name: "notes", html: HTML("BUDGET TRACKER"), actor: "agent" });

  // ---- N10: history is this app's history
  const hist = st.appHistory("notes");
  ok("history lists only the CURRENT life's checkpoints",
    hist.length === 1 && hist[0].checkpoint === 1, JSON.stringify(hist));
  const cp1 = hist.find((h) => h.checkpoint === 1);
  ok("…so restoring 'checkpoint 1' cannot hand back a deleted, unrelated app",
    !!cp1 && st.getAppVersion("notes", cp1.version).html.includes("BUDGET TRACKER"),
    cp1 ? st.getAppVersion("notes", cp1.version).html : "no checkpoint 1");
  // The tombstone promise, and §21's real property: the earlier rows were never overwritten.
  ok("the previous life's source is still IN the table — retained, not clobbered (no REPLACE over a tombstone)",
    st.getAppVersion("notes", life1v2).html.includes("RECIPES v2"));

  // ---- N3: rows that predate this life are not this app's to delete
  const d = st.deleteDisposition("notes");
  ok("rows written before this life began are NOT judged exclusive",
    d.collections[0].verdict !== "exclusive" && d.exclusive.length === 0, JSON.stringify(d.collections));
  ok("…and the reason shown to the user says so rather than claiming provable ownership",
    /nothing proves/.test(d.collections[0].why), d.collections[0].why);

  // ---- the ordinary case still works: an app that made its own rows still owns them
  st.execute({ type: "save_app", command_id: cid(), name: "fresh", html: HTML("FRESH"), actor: "agent" });
  st.execute({ type: "add_item", command_id: cid(), collection: "fresh", fields: { t: "made by the app" }, actor: "agent" });
  const df = st.deleteDisposition("fresh");
  ok("an app that was created BEFORE its collection still owns it (the gate did not just say no to everything)",
    df.exclusive.join() === "fresh", JSON.stringify(df.collections));

  // ---- a deleted app that was NOT recreated keeps its history reachable (the documented tombstone)
  st.execute({ type: "save_app", command_id: cid(), name: "gone", html: HTML("GONE v1"), actor: "agent" });
  st.execute({ type: "save_app", command_id: cid(), name: "gone", html: HTML("GONE v2"), actor: "agent" });
  st.execute({ type: "delete_app", command_id: cid(), name: "gone", actor: "agent" });
  ok("a tombstoned app still lists its OWN checkpoints — 'history survives delete' is unchanged",
    st.appHistory("gone").length === 2, JSON.stringify(st.appHistory("gone")));

  st.close();
  for (const f of [P, P + "-wal", P + "-shm"]) if (existsSync(f)) unlinkSync(f);
}

console.log("\n18. a cascade's own receipts must not live in the caller's id namespace (N6)");
// Each cleared collection gets a `rows_cleared` receipt, and change_event.command_id is UNIQUE, so
// those extra events needed ids. They were DERIVED from the command's — `${command_id}#rows:${coll}`
// — on the reasoning that derived ids are as idempotent as the command. They are, but command_id is
// a CALLER-SUPPLIED string, so the derived space is one the caller can already be sitting in: a
// prior write whose id happened to be that exact shape makes the cascade die on a UNIQUE violation.
// Idempotence never needed them: a replay short-circuits at the command level and never reaches the
// emit at all (§18b below pins that).
{
  const P = join(ROOT, "test", "cid.db");
  for (const f of [P, P + "-wal", P + "-shm"]) if (existsSync(f)) unlinkSync(f);
  const st = openStore(P);
  const HTML = "<!doctype html><html><body>fixture body long enough to clear the size floor</body></html>";
  let n = 0; const cid = () => "c" + (++n);

  st.execute({ type: "save_app", command_id: cid(), name: "app", html: HTML, actor: "agent" });
  st.execute({ type: "add_item", command_id: cid(), collection: "app", fields: { t: "row" }, actor: "agent" });
  // A perfectly ordinary earlier write that happens to have used the derived shape as its own id.
  st.execute({ type: "add_item", command_id: "X#rows:app", collection: "elsewhere", fields: { t: "y" }, actor: "human" });

  let threw = null, res = null;
  try { res = st.execute({ type: "delete_app", command_id: "X", name: "app", cascade: true, cascade_collections: ["app"], actor: "agent" }); }
  catch (e) { threw = e; }
  ok("a destructive command cannot be killed by a caller's earlier choice of id",
    threw === null, threw && `${threw.constructor.name}: ${threw.message}`);
  ok("…and it actually did the delete", res && res.ok === true && !st.getApp("app"));
  ok("…and the cleared collection still got its receipt",
    st.changesSince("app", 0).events.some((e) => e.type === "rows_cleared"),
    JSON.stringify(st.changesSince("app", 0).events.map((e) => e.type)));

  console.log("18b. …because idempotence lives at the COMMAND level, not in the receipts' ids");
  const again = st.execute({ type: "delete_app", command_id: "X", name: "app", cascade: true, cascade_collections: ["app"], actor: "agent" });
  ok("a replay of the same command short-circuits and emits nothing new",
    again.ok === true && again.idempotent === true, JSON.stringify(again));
  ok("…so exactly one rows_cleared receipt exists, however many times it is retried",
    st.changesSince("app", 0).events.filter((e) => e.type === "rows_cleared").length === 1);

  console.log("18c. a replay says WHICH act it is replaying (N5)");
  // The registry's retry path reports "already applied" when an app is gone but the caller
  // holds a plan token. It asked the store "did this command_id run?" and the store answered only
  // yes/no — so a command_id previously used for a KEEP delete answered yes, and the caller was
  // told its irreversible cascade had happened while every row was still on disk.
  st.execute({ type: "save_app", command_id: cid(), name: "kept", html: HTML, actor: "agent" });
  st.execute({ type: "add_item", command_id: cid(), collection: "kept", fields: { t: "still here" }, actor: "agent" });
  const KEEP = "reused-id";
  st.execute({ type: "delete_app", command_id: KEEP, name: "kept", actor: "agent" });
  const replay = st.execute({ type: "delete_app", command_id: KEEP, name: "kept", cascade: true, cascade_collections: [], actor: "agent" });
  ok("replaying a KEEP delete does not claim to have cascaded",
    replay.ok === true && replay.cascaded === undefined, JSON.stringify(replay));
  ok("…and the rows it never took are still there", st.snapshot("kept").items.length === 1);

  st.execute({ type: "save_app", command_id: cid(), name: "casc", html: HTML, actor: "agent" });
  st.execute({ type: "add_item", command_id: cid(), collection: "casc", fields: { t: "doomed" }, actor: "agent" });
  const CASC = "cascade-id";
  st.execute({ type: "delete_app", command_id: CASC, name: "casc", cascade: true, cascade_collections: ["casc"], actor: "agent" });
  const replay2 = st.execute({ type: "delete_app", command_id: CASC, name: "casc", cascade: true, cascade_collections: ["casc"], actor: "agent" });
  ok("replaying a real CASCADE says so, so the caller can tell the two apart",
    replay2.ok === true && !!replay2.cascaded, JSON.stringify(replay2));

  st.close();
  for (const f of [P, P + "-wal", P + "-shm"]) if (existsSync(f)) unlinkSync(f);
}

console.log("\n19. N9 — a pruned history must make ownership UNKNOWABLE, never wrongly certain");
// deleteDisposition decides "was this collection created FOR this app?" by comparing earliest
// events. Retention deletes a collection's OLDEST events — precisely the ones proving it predates
// the app that merely shares its name — so a pruned ledger reads as "created for the app" and
// cascade would take the user's own older rows.
//
// The judge cannot see the gap from the inside: the evidence it needs is the evidence that is gone.
// So pruning records that it happened, and the judge treats an unaccounted-for gap as unknowable.
// Unknowable means KEPT — the asymmetry from delete-cascade-design: deleting too little leaves rows
// a user can remove again, deleting too much breaks a second app and the data is gone.
{
  const P = join(ROOT, "test", "n9.db");
  const fresh = () => {
    for (const f of [P, P + "-wal", P + "-shm"]) if (existsSync(f)) unlinkSync(f);
    return openStore(P);
  };
  const HTML = "<!doctype html><html><body>an app that arrived long after the diary did</body></html>";
  let n = 0; const cid = () => "n9-" + (++n);
  const seedOlderThanItsApp = (st) => {
    for (let i = 0; i < 5; i++)
      st.execute({ type: "add_item", command_id: cid(), collection: "diary", fields: { t: "mine " + i }, actor: "human" });
    st.execute({ type: "save_app", command_id: cid(), name: "diary", html: HTML, actor: "agent" });
    st.execute({ type: "add_item", command_id: cid(), collection: "diary", fields: { t: "the app wrote this" }, actor: "agent" });
  };
  const enableRetention = (st, keep) => st.executePrivileged({ type: "add_item", command_id: cid(),
    collection: "settings", group: "", fields: { key: "policy:retention.events", value: keep }, actor: "agent" });

  {
    const st = fresh();
    seedOlderThanItsApp(st);
    ok("before pruning: rows older than the app are KEPT, on the evidence",
      st.deleteDisposition("diary").exclusive.length === 0,
      JSON.stringify(st.deleteDisposition("diary").collections));

    enableRetention(st, 1);
    const pruned = st.pruneLedger("diary");
    ok("retention really does remove the evidence (the rig is doing the dangerous thing)",
      pruned.pruned > 0, JSON.stringify(pruned));

    const after = st.deleteDisposition("diary");
    ok("🔴 THE MAIN JUDGE: a pruned collection is never exclusive — cascade cannot take it",
      after.exclusive.length === 0 && after.collections[0].verdict !== "exclusive",
      `verdict=${after.collections[0].verdict} exclusive=${JSON.stringify(after.exclusive)}`);
    ok("…and the reason names THIS unknowable — pruned history, not 'nothing proves it'",
      /pruned/.test(after.collections[0].why), after.collections[0].why);
    ok("…while the rows themselves are untouched (pruning trims history, not data)",
      st.snapshot("diary").items.length === 6);
    st.close();
  }

  {
    // The mark must not become a blanket amnesty: an app that genuinely made its own collection,
    // in a store where some OTHER collection was pruned, still owns its rows.
    const st = fresh();
    st.execute({ type: "save_app", command_id: cid(), name: "fresh-app", html: HTML, actor: "agent" });
    st.execute({ type: "add_item", command_id: cid(), collection: "fresh-app", fields: { t: "made by the app" }, actor: "agent" });
    for (let i = 0; i < 4; i++)
      st.execute({ type: "add_item", command_id: cid(), collection: "unrelated", fields: { t: "x" + i }, actor: "human" });
    enableRetention(st, 1);
    st.pruneLedger("unrelated");
    const d = st.deleteDisposition("fresh-app");
    ok("pruning ONE collection does not amnesty another — the untouched app still owns its rows",
      d.exclusive.join() === "fresh-app", JSON.stringify(d.collections));
    st.close();
  }

  {
    // A prune that removed nothing truncated nothing, so it must leave no mark and change no verdict.
    const st = fresh();
    st.execute({ type: "save_app", command_id: cid(), name: "tidy", html: HTML, actor: "agent" });
    st.execute({ type: "add_item", command_id: cid(), collection: "tidy", fields: { t: "one row" }, actor: "agent" });
    enableRetention(st, 500);
    const noop = st.pruneLedger("tidy");
    ok("a prune that deleted nothing records nothing", noop.pruned === 0);
    ok("…and the verdict is unchanged by having merely ASKED to prune",
      st.deleteDisposition("tidy").exclusive.join() === "tidy",
      JSON.stringify(st.deleteDisposition("tidy").collections));
    st.close();
  }

  // Depth, not the main judge any more: these two used to BE the guard, back when the plan was to
  // keep N9 latent. They stay because "nothing prunes by default" is still worth knowing if it
  // changes — but the assertion above is what actually protects the data now.
  {
    const st = fresh();
    ok("depth: a default deployment still prunes nothing", st.retentionEvents() === null
      && st.pruneLedger("anything").pruned === 0);
    const code = readdirSync(join(ROOT, "src"), { recursive: true })
      .filter((f) => /\.(mjs|js)$/.test(String(f)))
      .map((f) => readFileSync(join(ROOT, "src", String(f)), "utf-8"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    ok("depth: the engine still never calls pruneLedger itself — retention stays caller-driven",
      (code.match(/\bpruneLedger\s*\(/g) || []).length === 1);
    st.close();
  }
  for (const f of [P, P + "-wal", P + "-shm"]) if (existsSync(f)) unlinkSync(f);
}

console.log(`\nledger: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
