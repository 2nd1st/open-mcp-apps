// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/runtime-core.mjs — the widget runtime's DECISION CORE, pinned in node.
//
// "Click and it redraws with no extra round trip" is one inequality
// (prev_collection_seq ≤ the read stamp we hold); the adoption gate is one rule
// (un-adoptable ⇒ keep the old projection); a mount read is one walk (pages pinned to a
// version, restarts bounded, truncation marked). Those rules used to live only inside a
// browser bundle where no test could reach them — runtime-core.mjs exists so this file can.
//
// Run: node test/runtime-core.mjs
import { decideAck, applyAck, ackOf, canAdopt, walkPages, decideProbe, decideChanges, viaOf, themeVars, ackPosition, childPreviewSnapshot, THEME_KEY_PREFIX, MAX_PAGES, createAppTools, serveAppTools, appToolText, MAX_APP_TOOLS, APP_READER_META, READER_META_KEY } from "../src/runtime-core.mjs";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

console.log("1. decideAck — the continuity inequality");
const S = { collection: "todo", items: [], version: 100 };
ok("prev ≤ held ⇒ apply (nothing between our read and this write touched the collection)",
  decideAck(S, { ok: true, collection: "todo", seq: 130, prev_collection_seq: 100 }).kind === "apply");
ok("prev < held ⇒ apply too (our read already contained the earlier event)",
  decideAck(S, { ok: true, collection: "todo", seq: 130, prev_collection_seq: 40 }).kind === "apply");
ok("prev > held ⇒ apply-refresh (a concurrent write we have not seen)",
  decideAck(S, { ok: true, collection: "todo", seq: 130, prev_collection_seq: 120 }).kind === "apply-refresh");
ok("foreign collection ⇒ ignore (never rebinds, never repaints)",
  decideAck(S, { ok: true, collection: "other", seq: 130, prev_collection_seq: 0 }).kind === "ignore");
ok("ok:false ⇒ conflict (structured, no text sniffing)",
  decideAck(S, { ok: false, collection: "todo", reason: "version_conflict" }).kind === "conflict");
ok("not an ack shape ⇒ ignore", decideAck(S, { items: [] }).kind === "ignore");
ok("missing prev_collection_seq ⇒ apply-refresh (unknown is not safe)",
  decideAck(S, { ok: true, collection: "todo", seq: 130 }).kind === "apply-refresh");

console.log("1b. decideAck — ORDER, not just continuity (out-of-order receipts)");
ok("an ack AT our watermark is stale: the read we hold already contains it",
  decideAck(S, { ok: true, collection: "todo", seq: 100, prev_collection_seq: 99 }).kind === "stale");
ok("an ack BEHIND our watermark is stale — this is the older of two in-flight replies,\n     which satisfies prev ≤ held just as well and used to rewind both the row and the version",
  decideAck(S, { ok: true, collection: "todo", seq: 88, prev_collection_seq: 40 }).kind === "stale");
ok("staleness is checked before continuity, so a stale ack never asks for a walk either",
  decideAck(S, { ok: true, collection: "todo", seq: 88, prev_collection_seq: 120 }).kind === "stale");
ok("a refusal is still a conflict even when its seq is behind us (nothing to apply, but say so)",
  decideAck(S, { ok: false, collection: "todo", seq: 5, reason: "version_conflict" }).kind === "conflict");
ok("an ack with no seq keeps the old behaviour (unknown ⇒ judged on prev alone)",
  decideAck(S, { ok: true, collection: "todo", prev_collection_seq: 100 }).kind === "apply");

console.log("2. applyAck — local application + deletion accounting");
const rows = [
  { id: "a", group: "", position: 1, fields: { t: 1 }, version: 90 },
  { id: "b", group: "z", position: 1, fields: { t: 2 }, version: 95 },
];
const upd = applyAck(rows, { ok: true, id: "a", item: { id: "a", group: "", position: 1, fields: { t: 9 }, version: 130 } });
ok("update replaces the row in place", upd.length === 2 && upd[0].fields.t === 9);
const add = applyAck(rows, { ok: true, id: "c", item: { id: "c", group: "", position: 2, fields: {}, version: 131 } });
ok("add inserts in server order (group, position, id)", add.length === 3 && add[1].id === "c" && add[2].id === "b");
const del = applyAck(rows, { ok: true, id: "b", deleted: true });
ok("delete removes the row — the length delta IS the total accounting", del.length === 1 && del[0].id === "a");
ok("deleting an id we never held is a no-op, not a crash", applyAck(rows, { ok: true, id: "zz", deleted: true }).length === 2);
ok("an ack with no item (and no delete) returns null — the caller re-walks",
  applyAck(rows, { ok: true, id: "a" }) === null);
const replay = applyAck(upd, { ok: true, id: "a", item: { id: "a", group: "", position: 1, fields: { t: 9 }, version: 130 } });
ok("an idempotent replay upserts, never duplicates (total must not double-count)", replay.length === 2);

// A row's `version` IS the ledger seq of the last event that touched it, so it is exactly the
// mark a per-row staleness test needs — for callers that hold no single watermark (the pref
// cache, an embedded child) this is the whole defence against out-of-order replies.
const held = [{ id: "a", group: "", position: 1, fields: { t: 9 }, version: 130 }];
const late = applyAck(held, { ok: true, id: "a", seq: 120, item: { id: "a", group: "", position: 1, fields: { t: 1 }, version: 120 } });
ok("a receipt older than the row we hold does NOT overwrite it", late[0].fields.t === 9 && late.length === 1);
ok("…and it is not null either — a stale ack is no reason to pay for a walk", late !== null);
const staleDel = applyAck(held, { ok: true, id: "a", seq: 120, deleted: true });
ok("a stale DELETE cannot remove a row a newer write has since touched", staleDel.length === 1);
const newer = applyAck(held, { ok: true, id: "a", seq: 140, item: { id: "a", group: "", position: 1, fields: { t: 5 }, version: 140 } });
ok("a genuinely newer receipt still applies", newer[0].fields.t === 5);
ok("an equal-seq replay still applies (idempotent retry of the SAME write)",
  applyAck(held, { ok: true, id: "a", seq: 130, item: { id: "a", group: "", position: 1, fields: { t: 9 }, version: 130 } }).length === 1);

console.log("3. canAdopt — one rule: un-adoptable ⇒ keep the old projection");
const B = { collection: "todo", items: [{}, {}], version: 100 };
ok("complete same-collection snapshot at a newer version adopts",
  canAdopt(B, { collection: "todo", items: [{}, {}, {}], version: 120, total: 3 }));
ok("a FOREIGN collection never adopts (the rebind class of bugs, structurally out)",
  !canAdopt(B, { collection: "other", items: [], version: 200, total: 0 }));
ok("an older version never adopts (monotonic)",
  !canAdopt(B, { collection: "todo", items: [], version: 90, total: 0 }));
ok("an incomplete unfiltered set never adopts (items ≠ total)",
  !canAdopt(B, { collection: "todo", items: [{}], version: 120, total: 5 }));
ok("…unless the walker MARKED it truncated (honesty beats completeness)",
  canAdopt(B, { collection: "todo", items: [{}], version: 120, total: 5, truncated: true }));
ok("…or it is a filtered read (total means the pre-filter count there)",
  canAdopt(B, { collection: "todo", items: [{}], version: 120, total: 5, filtered: true }));
ok("equal version adopts (dedup is the wiring's job, not the gate's)",
  canAdopt(B, { collection: "todo", items: [{}, {}], version: 100, total: 2 }));
ok("unbound state adopts anything shaped like a snapshot (first bind)",
  canAdopt({ collection: null, items: [], version: 0 }, { collection: "todo", items: [], version: 5, total: 0 }));

console.log("4. walkPages — version-pinned merge, bounded restarts, honest truncation");
const page = (items, version, next, total) => ({ items, version, next_cursor: next, total, settings_version: 1, files_version: 1 });
{
  const pages = [page([1, 2], 50, "c1", 4), page([3, 4], 50, null, 4)];
  const out = await walkPages(async (cur) => (cur ? pages[1] : pages[0]));
  ok("two pages at one version merge whole", out.items.join() === "1,2,3,4" && out.version === 50 && !out.truncated && !out.torn);
}
{
  let calls = 0;
  const out = await walkPages(async (cur) => {
    calls++;
    if (calls <= 2) return cur ? page([3], 60, null, 3) : page([1, 2], 50, "c1", 3);  // torn: v50 → v60
    return cur ? page([3, 4], 70, null, 4) : page([1, 2], 70, "c1", 4);              // clean at v70
  });
  ok("a write mid-walk RESTARTS the walk; the clean pass adopts", out.items.join() === "1,2,3,4" && out.version === 70 && out.restarts === 1);
}
{
  let n = 0;
  const seen = [];
  const out = await walkPages(async () => { const v = 100 + n++; seen.push(v); return page([v], v, "more", 99); },
    { maxRestarts: 2, maxPages: 3 });
  ok("sustained writes: the final attempt tolerates the tear and SAYS so", out.torn === true && out.items.length === 3);
  // The stamp is the honest one: the OLDEST instant of the pass that was adopted. Taking the
  // freshest was the bug — the caller stamped a version its rows did not all have, the next probe
  // found seq unchanged, and the stale rows sat there forever. An older mark makes the probe fire.
  const finalPass = seen.slice(-3);
  ok("a torn walk keeps its FIRST page's version, never the newest one it read",
    out.version === finalPass[0] && out.version < finalPass[2],
    `version ${out.version}, final pass saw ${finalPass.join(" → ")}`);
  ok("…and that version is one the rows actually came from", out.items.includes(out.version));
}
{
  const out = await walkPages(async (cur) => page([cur || 0], 5, "next-" + (Number(String(cur).split("-")[1] || 0) + 1), 999), { maxPages: 4 });
  ok("the page cap marks the projection truncated instead of silently stopping",
    out.truncated === true && out.items.length === 4);
  ok("the default page cap exists and is finite", Number.isFinite(MAX_PAGES) && MAX_PAGES > 0);
}
ok("a bad page surfaces as an error, not a blank adoption", (await walkPages(async () => null)).error === "bad_page");

console.log("5. poll decisions — probe, then confirm against OUR collection");
ok("moved global seq ⇒ check changes; unmoved ⇒ decay", (() => {
  const a = decideProbe(100, 7, { seq: 130, settings_version: 7 });
  const b = decideProbe(130, 7, { seq: 130, settings_version: 7 });
  return a.checkChanges === true && b.checkChanges === false;
})());
ok("settings_version moved ⇒ pref sync (write acks no longer carry settings snapshots)",
  decideProbe(100, 7, { seq: 100, settings_version: 9 }).syncPrefs === true);
ok("events for our collection ⇒ walk", decideChanges({ events: [{ seq: 1 }], total: 1, latest_seq: 130 }).kind === "walk");
ok("over-budget window (empty events but total>0) still walks",
  decideChanges({ events: [], total: 3, latest_seq: 130 }).kind === "walk");
ok("no events ⇒ advance the mark to latest (a foreign write costs a probe, never a walk)", (() => {
  const d = decideChanges({ events: [], total: 0, latest_seq: 130 });
  return d.kind === "advance" && d.to === 130;
})());
ok("an unknown shape walks — being safe beats being clever", decideChanges(null).kind === "walk");

console.log("6. viaOf — the frozen object form");
ok("app form", viaOf("my-app").app === "my-app" && viaOf("my-app").function === undefined);
ok("invalid names stamp nothing (a write never fails over its shadow)",
  viaOf("BAD NAME!") === undefined && viaOf("") === undefined && viaOf(null) === undefined);

console.log("1c. ackPosition — a REPLAYED receipt sits where its ROW sits, not where its seq says");
{
  // store.mjs's replay branch answers a retried write with the ORIGINAL event's seq and the row as
  // it stands TODAY (deliberately: a retry must describe a real row). Judging staleness by seq alone
  // then threw away the freshest row in the system — and asked for no re-read either.
  // seq 2 (the original event) paired with a row at version 140 (a later write by someone else).
  const replay = { ok: true, collection: "todo", id: "a", seq: 2, idempotent: true,
    item: { id: "a", group: "", position: 1, fields: { v: "D" }, version: 140 } };
  ok("position comes from the ROW's version when the receipt carries one", ackPosition(replay) === 140);
  ok("a delete carries no row, so its seq IS its position",
    ackPosition({ ok: true, id: "a", seq: 7, deleted: true }) === 7);
  ok("an ordinary write is unaffected (item.version === seq by construction)",
    ackPosition({ ok: true, seq: 12, item: { version: 12 } }) === 12);
  ok("a replayed receipt is NOT judged stale on its old seq — it reconciles instead",
    decideAck(S, replay).kind === "apply-refresh", `got ${decideAck(S, replay).kind}`);
  ok("…and applyAck applies its row over an older local one",
    applyAck([{ id: "a", group: "", position: 1, fields: { v: "C" }, version: 3 }], replay)[0].fields.v === "D");
  // …while a replay whose row is genuinely behind our read is still stale — the point is the ROW,
  // not the seq, and a row we have already read past has nothing for us.
  ok("a replay whose row is BEHIND our watermark stays stale",
    decideAck(S, { ...replay, item: { ...replay.item, version: 40 } }).kind === "stale");
}

console.log("7. themeVars — the user theme layer (tokens, never a stylesheet)");
{
  const t = themeVars({ "theme:--color-text-info": "#326E64", locale: "auto", "theme:--border-radius-md": "4px" });
  ok("only theme: keys are taken, and the prefix is stripped",
    t.length === 2 && t[0][0] === "--border-radius-md" && t[1][0] === "--color-text-info");
  ok("sorted, so the same prefs always produce the same bytes", t[0][0] < t[1][0]);
  ok("a Map (the runtime's merged view) works exactly like an object",
    JSON.stringify(themeVars(new Map([["theme:--color-text-info", "red"]]))) === '[["--color-text-info","red"]]');
  // Everything below would have been a live injection hole in the removed brandCss option.
  const bad = themeVars({
    "theme:--x": "red;} :root{--color-text-primary:red",     // declaration/selector escape
    "theme:--y": "url(</style><script>alert(1)</script>)",   // tag escape
    "theme:--Z": "red",                                      // uppercase name
    "theme:onclick": "x",                                    // not a custom property at all
    "theme:--w": "",                                         // empty
    "theme:--v": "var(--color-text-info, #3b6cf6)",          // …but a legitimate var() chain passes
  });
  ok("every escape attempt is dropped, the legitimate value survives",
    bad.length === 1 && bad[0][0] === "--v" && bad[0][1] === "var(--color-text-info, #3b6cf6)");
  ok("junk input yields nothing rather than throwing",
    themeVars(null).length === 0 && themeVars("nope").length === 0 && themeVars(undefined).length === 0);
  ok("the prefix is outside the declared-key charset, so it cannot collide with an app pref",
    !/^[a-z][a-z0-9_]*$/.test(THEME_KEY_PREFIX + "--color-text-info"));
}

console.log("\n11. childPreviewSnapshot — one shared snapshot, sliced per app");
{
  // The embedder (settings' Installed grid, the hosted store composer) fetches ONE snapshot
  // covering every collection and hands each preview only its own share. That slice is a security
  // boundary — a preview of the shopping list must not contain the medication log — and it is also
  // the thing that decides whether a preview has any data at all. Both halves are pinned here
  // because the first version got the security right and the data wrong: it sliced on
  // `row.collection === appName`, which is not what an app is bound to.
  const rows = [
    { collection: "build-progress", group: "", fields: { t: "bp" } },
    { collection: "elder-meds", group: "", fields: { t: "meds" } },
    { collection: "elder-checks", group: "", fields: { t: "checks" } },
    { collection: "notes", group: "", fields: { t: "note" } },
    { collection: "medication-log", group: "", fields: { t: "SECRET" } },
  ];
  const decl = (...names) => ({ collections: Object.fromEntries(names.map((n) => [n, {}])) });

  // A SINGLE declared collection is what the app opens on, even when it is not the app's name.
  // This is the case the name-equality slice starved: builder-progress lives in build-progress.
  const bp = childPreviewSnapshot(rows, { app: "builder-progress", declaration: decl("build-progress"), tier: "local" });
  ok("a single declared collection binds the child, exactly as defaultCollectionFor would",
    bp.collection === "build-progress", bp.collection);
  ok("…and its rows are the ones it gets", bp.items.length === 1 && bp.items[0].fields.t === "bp");

  // MANY declared collections: no "the" collection, so the name stays the binding — again matching
  // defaultCollectionFor — but the app self-fetches each one, so all of them must be present.
  const ed = childPreviewSnapshot(rows, { app: "elder-days", declaration: decl("elder-meds", "elder-checks", "elder-vitals"), tier: "local" });
  ok("several declared collections leave the binding on the app's own name",
    ed.collection === "elder-days", ed.collection);
  ok("…and the child receives every collection it declares (a multi-collection app is not one row short)",
    ed.items.length === 2 && ed.items.some((r) => r.collection === "elder-meds") && ed.items.some((r) => r.collection === "elder-checks"),
    JSON.stringify(ed.items.map((r) => r.collection)));

  // The security half, unchanged: nothing it did not ask for.
  ok("a declared app gets NOTHING it did not declare", !ed.items.some((r) => r.collection === "medication-log"));
  const plain = childPreviewSnapshot(rows, { app: "notes", declaration: null, tier: "local" });
  ok("an app with no manifest still binds to its own name and sees only that",
    plain.collection === "notes" && plain.items.length === 1 && plain.items[0].fields.t === "note");
  ok("…and one app's rows never reach another app's document",
    !plain.items.some((r) => r.collection === "medication-log"));

  // The roster travels: inert has no host to ask, so an app with an EMPTY collection is invisible
  // unless the embedder supplies the registry listing it already holds.
  const roster = [{ name: "notes" }, { name: "empty-app" }];
  ok("the apps roster survives the slice (inert list_apps has no other source)",
    childPreviewSnapshot(rows, { app: "notes", declaration: null, apps: roster, tier: "local" }).apps.length === 2);
  ok("…and is an empty list, never undefined, when the embedder has none",
    Array.isArray(childPreviewSnapshot(rows, { app: "notes", declaration: null, tier: "local" }).apps));

  // Grammar defence: a manifest is data, and the store REJECTS the array form — a reader that
  // accepted it would silently bind to nothing.
  ok("a malformed collections key claims nothing rather than throwing",
    childPreviewSnapshot(rows, { app: "notes", declaration: { collections: ["notes"] }, tier: "local" }).collection === "notes"
    && childPreviewSnapshot(rows, { app: "notes", declaration: "nope", tier: "local" }).collection === "notes");
  ok("junk rows are dropped, not carried into a sandbox",
    childPreviewSnapshot([null, { collection: "notes" }, "x"], { app: "notes", declaration: null, tier: "local" }).items.length === 1);

  // A FIXTURE row is allowed to omit `collection` — preview_app_store_entry's schema says so in as many
  // words, and 13 of the 21 shipped store entries take it up. Reading the key raw made
  // `has(undefined)` false for every one of them, so those previews rendered their empty state on
  // every host (measured 2026-08-14 on /view/app-store: study-cards, whose rows happen to name the
  // app itself, was the only live card on the shelf). An unstamped row belongs to the collection
  // this snapshot binds to — including when a single declared collection moved that binding off
  // the app's name.
  const bare = [{ fields: { t: "unstamped" } }, { collection: "medication-log", fields: { t: "SECRET" } }];
  const fx = childPreviewSnapshot(bare, { app: "habit-streaks", declaration: null, tier: "local" });
  ok("a fixture row with no collection binds to the app's own collection, not to nothing",
    fx.items.length === 1 && fx.items[0].fields.t === "unstamped", JSON.stringify(fx.items));
  ok("…and it follows the binding when a single declared collection moves it off the app name",
    childPreviewSnapshot(bare, { app: "builder-progress", declaration: decl("build-progress"), tier: "local" }).items.length === 1);
  ok("…while the slice still keeps another app's rows out",
    !fx.items.some((r) => r.collection === "medication-log"));

  // 🔴 THE TIER GATE. A manifest is written BY the app, so honouring it for an UNREVIEWED
  // app (share-install, T19 P-c) would let that app name its way into rows the parent has already
  // fetched — the shared snapshot is right there, and the slice is the only thing separating them.
  // Same gate contracts.mjs puts on the same question, and it FAILS CLOSED.
  const hostile = { collections: { "medication-log": {}, "notes": {} } };
  const unrev = childPreviewSnapshot(rows, { app: "free-app", declaration: hostile, tier: "unreviewed" });
  ok("an UNREVIEWED app cannot declare its way into another app's rows",
    unrev.items.length === 0 && unrev.collection === "free-app", JSON.stringify(unrev));
  ok("…and a missing tier is treated as untrusted, not as local (fail closed)",
    childPreviewSnapshot(rows, { app: "free-app", declaration: hostile }).items.length === 0);
  ok("…while the SAME manifest on a local app is honoured, so the gate is the tier and not the shape",
    childPreviewSnapshot(rows, { app: "free-app", declaration: hostile, tier: "local" }).items.length === 2);
}

console.log("\n1d. ackOf — the ONE shape a write resolves to, whatever the layer handed back");
{
  const ACK = { ok: true, id: "i1", collection: "c", seq: 7, prev_collection_seq: 6,
                item: { id: "i1", group: "", position: 1, fields: { t: 1 }, version: 7 } };
  ok("an MCP envelope yields its ack body, identically",
    ackOf({ content: [{ type: "text", text: "ok" }], structuredContent: ACK }) === ACK);
  ok("…so ack.ok is a boolean and not undefined — `if (!ack.ok)` was reporting every success as a failure",
    ackOf({ content: [], structuredContent: ACK }).ok === true);
  ok("…and ack.item.version is visible — the token an echo-suppressing bridge keys on",
    ackOf({ content: [], structuredContent: ACK }).item.version === 7);

  const REFUSAL = { ok: false, reason: "version_conflict", note: "…", item: { id: "i1", version: 9 } };
  ok("a refusal is an ANSWER, not an exception, and keeps its reason",
    ackOf({ content: [], structuredContent: REFUSAL, isError: true }).reason === "version_conflict");

  // IDEMPOTENT: the inert previews answer without an envelope at all, and the bridge hands the
  // child something the parent may already have unwrapped. Applying this twice must be safe.
  const bare = { ok: true, id: "fx-0", item: { id: "fx-0", version: 2 } };
  ok("a bare ack passes through untouched (the inert presets)", ackOf(bare) === bare);
  ok("…and unwrapping twice changes nothing", ackOf(ackOf(bare)) === bare);

  // An envelope with no ack body at all: the only thing that can speak is the text channel.
  ok("an isError envelope with no ack body still answers ok:false",
    ackOf({ isError: true, content: [{ type: "text", text: "denied" }] }).ok === false);
  ok("…and quotes what the tool actually said",
    ackOf({ isError: true, content: [{ type: "text", text: "denied" }] }).note === "denied");
  ok("a bodyless success is ok:true rather than a shape with no verdict in it",
    ackOf({ content: [{ type: "text", text: "done" }], structuredContent: {} }).ok === true);
  ok("nothing at all is a refusal, never a crash and never a silent success",
    ackOf(undefined).ok === false && ackOf(null).ok === false && ackOf("x").ok === false);

  // The function is INJECTED into the sandboxed child by toString(), the way the height helpers
  // travel — so it may not close over anything this module holds.
  const standalone = new Function("return (" + ackOf.toString() + ")")();
  ok("it survives toString() transport into the bridge (no closure, no imports)",
    standalone({ content: [], structuredContent: ACK }).seq === 7);
}

console.log("\n12. app tools — the page's own tools (oma.tools), the registry both roads read");
{
  const t = createAppTools();
  let changes = 0;
  t.onChange(() => changes++);
  const ran = [];
  const off = t.register({
    name: "show_day", description: "Open one day.",
    inputSchema: { properties: { day: { type: "string", description: "YYYY-MM-DD" }, wide: { type: "boolean" } }, required: ["day"] },
    annotations: { readOnlyHint: true },
    run: (a) => { ran.push(a); return "day " + a.day; },
  });
  const [listed] = t.list();
  ok("register → listed in the tools/list shape (name, description, an OBJECT inputSchema, annotations)",
    t.list().length === 1 && listed.name === "show_day" && listed.description === "Open one day."
      && listed.inputSchema.type === "object" && listed.inputSchema.required[0] === "day" && listed.annotations.readOnlyHint === true,
    JSON.stringify(t.list()));
  ok("…and no `run` leaks into what a host is handed", !("run" in listed));
  ok("a tool with no schema still lists an object schema (MCP Tool requires one)",
    (t.register({ name: "ping", run: () => "pong" }), t.list().find((x) => x.name === "ping").inputSchema.type === "object"));
  ok("every change to the list is heard (register ×2 so far)", changes === 2, `changes=${changes}`);

  // round trip: input → run → CallToolResult
  const r1 = await t.call("show_day", { day: "2026-10-03" });
  ok("call runs it with the input and a string becomes the text", r1.content[0].text === "day 2026-10-03" && !r1.isError && ran.length === 1, JSON.stringify(r1));
  t.register({ name: "obj", run: () => ({ n: 2 }) });
  const r2 = await t.call("obj");
  ok("a JSON value comes back as its JSON text AND structuredContent", r2.content[0].text === '{"n":2}' && r2.structuredContent.n === 2, JSON.stringify(r2));
  t.register({ name: "mcp", run: async () => ({ content: [{ type: "text", text: "as-is" }], isError: true }) });
  ok("an MCP CallToolResult passes through untouched (async run too)", (await t.call("mcp")).content[0].text === "as-is");
  t.register({ name: "nothing", run: () => {} });
  ok("nothing returned is \"Done.\"", (await t.call("nothing")).content[0].text === "Done.");

  // errors are ANSWERS the model can correct from — never a throw out of call()
  const before = ran.length;
  const miss = await t.call("show_day", {});
  ok("missing a required key → isError naming it, and run never sees the call",
    miss.isError === true && /missing day/.test(miss.content[0].text) && ran.length === before, JSON.stringify(miss));
  const typ = await t.call("show_day", { day: 3 });
  ok("a wrong primitive type → isError naming the key", typ.isError === true && /day must be a string/.test(typ.content[0].text), JSON.stringify(typ));
  t.register({ name: "kind", inputSchema: { properties: { k: { type: "string", enum: ["eat", "see"] } } }, run: (a) => a.k });
  ok("an enum is held", (await t.call("kind", { k: "fly" })).isError === true && (await t.call("kind", { k: "eat" })).content[0].text === "eat");
  t.register({ name: "boom", run: () => { throw new Error("no trip yet"); } });
  const boom = await t.call("boom");
  ok("a throw → isError carrying the app's message", boom.isError === true && /boom failed: no trip yet/.test(boom.content[0].text), JSON.stringify(boom));
  const unk = await t.call("nope");
  ok("an unknown name → isError listing what the app DOES have", unk.isError === true && /no tool "nope"/.test(unk.content[0].text) && /show_day/.test(unk.content[0].text), JSON.stringify(unk));

  // the relay's listing
  const d = t.describe().split("\n");
  ok("describe(): one line per tool — name, typed args with ? for optional, enum values, what it does",
    d.includes('- show_day(day: string (YYYY-MM-DD), wide?: boolean) — Open one day.') && d.includes('- kind(k?: "eat"|"see")'), t.describe());
  ok("…and \"\" for an app that registered none (screen_read then adds no section)", createAppTools().describe() === "");
  ok("appToolText: the text blocks, joined; another block is named, not dropped",
    appToolText({ content: [{ type: "text", text: "a" }, { type: "image", data: "" }] }) === "a\n[image]" && appToolText({}) === "Done.");

  // lifecycle: replace by name; the replaced handle no longer owns it; unregister removes
  const n = t.list().length;
  const offNew = t.register({ name: "show_day", description: "v2", run: () => "v2" });
  ok("registering a name again REPLACES it (no duplicate, no throw — an app may register in render)",
    t.list().length === n && t.list().find((x) => x.name === "show_day").description === "v2");
  off();
  ok("…and the OLD handle's unregister is now a no-op (it no longer owns the name)", t.has("show_day"));
  const c0 = changes;
  offNew();
  ok("unregister removes it, and is heard", !t.has("show_day") && t.list().length === n - 1 && changes === c0 + 1);
  ok("…a removed tool answers like an unknown one", (await t.call("show_day", { day: "x" })).isError === true);

  // registration is checked where the author can see it
  const throws = (f) => { try { f(); return false; } catch { return true; } };
  ok("a bad name throws (MCP tool-name charset)", throws(() => t.register({ name: "has space", run() {} })) && throws(() => t.register({ name: "", run() {} })));
  ok("no run() throws", throws(() => t.register({ name: "x" })));
  const many = createAppTools();
  for (let i = 0; i < MAX_APP_TOOLS; i++) many.register({ name: "t" + i, run() {} });
  ok(`the ${MAX_APP_TOOLS + 1}st tool throws (the draft's recommended limit), replacing one does not`,
    throws(() => many.register({ name: "one-more", run() {} })) && !throws(() => many.register({ name: "t0", run() {} })));
}

console.log("\n13. the NATIVE road — a host that sends tools/list / tools/call to the view (real ext-apps App, simulated host)");
{
  // A real SDK App over an in-memory transport; this test plays the host. What is under test is
  // serveAppTools' wiring against the SDK as installed: the handlers are accepted (the SDK refuses
  // them without the tools capability), the answers go out on the request's own id, and
  // list_changed waits for the host to have listed.
  const fromApp = [];
  const toApp = (m) => transport.onmessage(m);   // the host speaking; onmessage is wired by connect()
  const transport = {
    async start() {}, async close() {},
    async send(msg) {
      fromApp.push(msg);
      if (msg.method === "ui/initialize") queueMicrotask(() => toApp({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, hostInfo: { name: "sim-host", version: "0" }, hostCapabilities: {}, hostContext: {} } }));
    },
  };
  const app = new App({ name: "open-mcp-apps", version: "0.1.0" }, { tools: { listChanged: true } }, { autoResize: false });
  const tools = createAppTools();
  tools.register({ name: "add_stop", description: "Add a stop.", inputSchema: { properties: { title: { type: "string" } }, required: ["title"] }, run: (a) => "added " + a.title });
  const served = serveAppTools(app, tools);
  await app.connect(transport);
  const init = fromApp.find((m) => m.method === "ui/initialize");
  ok("ui/initialize carries appCapabilities.tools.listChanged — the declaration a host reads", init && init.params.appCapabilities.tools && init.params.appCapabilities.tools.listChanged === true, JSON.stringify(init && init.params));
  const reply = async (id, method, params) => {
    toApp({ jsonrpc: "2.0", id, method, params });
    for (let i = 0; i < 50; i++) { const r = fromApp.find((m) => m.id === id && !m.method); if (r) return r; await new Promise((ok) => setTimeout(ok, 2)); }
    return null;
  };
  // Before the host has listed, a change sends NOTHING: that host has not shown it speaks app tools.
  tools.register({ name: "early", run: () => "x" });
  await new Promise((ok) => setTimeout(ok, 5));
  ok("before any tools/list, a registration sends no list_changed (no host has asked)",
    !fromApp.some((m) => m.method === "notifications/tools/list_changed") && served.listed === false);
  const list = await reply(101, "tools/list", {});
  ok("host tools/list → the registered tools, answered on the same id",
    list && list.result && list.result.tools.map((x) => x.name).join(",") === "add_stop,early" && served.listed === true, JSON.stringify(list));
  const call = await reply(102, "tools/call", { name: "add_stop", arguments: { title: "Kinkaku-ji" } });
  ok("host tools/call → run(input) → the result back on the same id",
    call && call.result && call.result.content[0].text === "added Kinkaku-ji" && !call.result.isError, JSON.stringify(call));
  const bad = await reply(103, "tools/call", { name: "add_stop", arguments: {} });
  ok("…bad arguments come back as a tool error (isError) the model can correct", bad && bad.result && bad.result.isError === true, JSON.stringify(bad));
  const unk = await reply(104, "tools/call", { name: "nope", arguments: {} });
  ok("…an unknown name is a protocol error (MCP \"Unknown tool\")", unk && unk.error && /Unknown tool: nope/.test(unk.error.message), JSON.stringify(unk));
  // After listing: one notification per burst.
  const offA = tools.register({ name: "a", run() {} });
  tools.register({ name: "b", run() {} });
  await new Promise((ok) => setTimeout(ok, 5));
  ok("after the host listed, a burst of changes sends ONE notifications/tools/list_changed",
    fromApp.filter((m) => m.method === "notifications/tools/list_changed").length === 1);
  offA();
  await new Promise((ok) => setTimeout(ok, 5));
  ok("…and an unregister sends the next one", fromApp.filter((m) => m.method === "notifications/tools/list_changed").length === 2);
  const list2 = await reply(105, "tools/list", {});
  ok("…which a re-list reflects", list2 && list2.result.tools.map((x) => x.name).join(",") === "add_stop,early,b", JSON.stringify(list2 && list2.result));
}

console.log("\n14. the reader `_meta` survives the MCP Apps stack (real ext-apps App → real AppBridge → upstream)");
{
  // The runtime tells the engine the APP is reading through the request's `_meta`
  // (READER_META_KEY), not an argument — so whether it arrives is a fact about the bridge between
  // them. This is the reference host stack as installed: the view's App.callServerTool, over a
  // transport, into the ext-apps AppBridge, whose default oncalltool forwards to the host's MCP
  // client. The client here is a recorder. A host with its OWN bridge (claude.ai, ChatGPT) is not
  // covered by this and may strip `_meta`; then the read falls back to the model's page budget.
  const upstream = [];
  const client = {
    getServerCapabilities: () => ({ tools: {} }),
    setNotificationHandler() {},
    async request(req) { upstream.push(req); return { content: [{ type: "text", text: "ok" }], structuredContent: { items: [] } }; },
  };
  const [viewSide, hostSide] = InMemoryTransport.createLinkedPair();
  const bridge = new AppBridge(client, { name: "sim-host", version: "0" }, { serverTools: {} }, { hostContext: {} });
  await bridge.connect(hostSide);
  const app = new App({ name: "open-mcp-apps", version: "0.1.0" }, {}, { autoResize: false });
  await app.connect(viewSide);
  await app.callServerTool({ name: "data_list", arguments: { collection: "c" }, _meta: APP_READER_META }, { timeout: 2000 });
  const got = upstream.find((r) => r.method === "tools/call");
  ok("the reader key reaches the upstream tools/call verbatim, beside the SDK's own progressToken",
    got && got.params._meta && got.params._meta[READER_META_KEY] === "app" && "progressToken" in got.params._meta,
    JSON.stringify(got && got.params));
  ok("…and the arguments are untouched (the signal never becomes an argument)",
    got && JSON.stringify(got.params.arguments) === JSON.stringify({ collection: "c" }));
  await app.close(); await bridge.close();
}

console.log("\nafterAppScripts — the data-or-page decision waits for the app's own scripts");
{
  const { afterAppScripts } = await import("../src/runtime-core.mjs");
  const fakeDoc = (readyState) => {
    const on = {};
    return { readyState, on, addEventListener: (t, fn) => { (on[t] ||= []).push(fn); },
             fire: (t) => { for (const fn of on[t] || []) fn(); } };
  };
  const sync = (f) => f();
  // The measured case: the runtime's module ran when parsing had ended (interactive) but before
  // DOMContentLoaded; the app's module subscribes in between.
  const doc = fakeDoc("interactive"), win = fakeDoc();
  const when = afterAppScripts(doc, win, sync);
  let subscribedAtDecision = null, appSubscribed = false;
  when(() => { subscribedAtDecision = appSubscribed; });
  appSubscribed = true;                 // the app's <script type="module"> runs now
  ok("at readyState \"interactive\" nothing is decided yet", subscribedAtDecision === null);
  doc.fire("DOMContentLoaded");
  ok("…the decision comes at DOMContentLoaded and sees the app's subscription", subscribedAtDecision === true);
  let late = 0;
  win.fire("load");
  when(() => { late++; });
  ok("…fires each waiter once (load after it does not fire again) and a later ask runs at once", late === 1);
  const doc2 = fakeDoc("interactive"), win2 = fakeDoc();
  let viaLoad = false;
  afterAppScripts(doc2, win2, sync)(() => { viaLoad = true; });
  win2.fire("load");
  ok("a runtime that arrived after DOMContentLoaded still decides, at load", viaLoad);
  let now = false;
  afterAppScripts(fakeDoc("complete"), fakeDoc(), sync)(() => { now = true; });
  ok("a finished document decides without waiting", now);
}

console.log("\nfitFrame — fullscreen gives the frame's height back to the app");
{
  const { fitFrame } = await import("../src/runtime-core.mjs");
  const el = () => { const m = new Map(); return { style: {
    setProperty: (k, v) => m.set(k, v), removeProperty: (k) => m.delete(k), get: (k) => m.get(k) } }; };
  const root = el(), body = el();
  const unpin = () => { for (const e of [root, body]) { e.style.setProperty("height", "auto"); e.style.setProperty("min-height", "0"); e.style.setProperty("overflow-y", "visible"); } };
  ok("inline: unpinned, so the host can measure the card from its content",
    fitFrame("inline", [root, body], unpin) === "content" && root.style.get("height") === "auto" && body.style.get("height") === "auto");
  ok("fullscreen: the unpin comes off html AND body, so height:100% fills the host's frame",
    fitFrame("fullscreen", [root, body], unpin) === "app" && [root, body].every((e) => ["height", "min-height", "overflow-y"].every((k) => e.style.get(k) === undefined)));
  ok("back to inline: unpinned again", fitFrame("inline", [root, body], unpin) === "content" && body.style.get("min-height") === "0");
}

console.log(`\nruntime-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
