// SPDX-License-Identifier: AGPL-3.0-only
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
import { decideAck, applyAck, canAdopt, walkPages, decideProbe, decideChanges, viaOf, themeVars, ackPosition, childPreviewSnapshot, THEME_KEY_PREFIX, MAX_PAGES } from "../src/runtime-core.mjs";

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
ok("component form", viaOf("my-app").component === "my-app" && viaOf("my-app").function === undefined);
ok("function form", viaOf("my-app", "tick").function === "tick");
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
  ok("the prefix is outside the declared-key charset, so it cannot collide with a component pref",
    !/^[a-z][a-z0-9_]*$/.test(THEME_KEY_PREFIX + "--color-text-info"));
}

console.log("\n11. childPreviewSnapshot — one shared snapshot, sliced per app");
{
  // The embedder (settings' Installed grid, the hosted /library composer) fetches ONE snapshot
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
  ok("the components roster survives the slice (inert list_components has no other source)",
    childPreviewSnapshot(rows, { app: "notes", declaration: null, components: roster, tier: "local" }).components.length === 2);
  ok("…and is an empty list, never undefined, when the embedder has none",
    Array.isArray(childPreviewSnapshot(rows, { app: "notes", declaration: null, tier: "local" }).components));

  // Grammar defence: a manifest is data, and the store REJECTS the array form — a reader that
  // accepted it would silently bind to nothing.
  ok("a malformed collections key claims nothing rather than throwing",
    childPreviewSnapshot(rows, { app: "notes", declaration: { collections: ["notes"] }, tier: "local" }).collection === "notes"
    && childPreviewSnapshot(rows, { app: "notes", declaration: "nope", tier: "local" }).collection === "notes");
  ok("junk rows are dropped, not carried into a sandbox",
    childPreviewSnapshot([null, { collection: "notes" }, "x"], { app: "notes", declaration: null, tier: "local" }).items.length === 1);

  // 🔴 THE TIER GATE. A manifest is written BY the component, so honouring it for an UNREVIEWED
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

console.log(`\nruntime-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
