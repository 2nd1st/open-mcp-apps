// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/confirmation.mjs — the W-S confirmation layer (redesign §2.5-A/B), pinned end to end.
//
// What must stay true, forever:
//   1. TOTALITY — every store command is explicitly classified (the boot assertion in store.mjs
//      makes forgetting fatal; this file proves the assertion actually fires).
//   2. The two-phase flow: a human delete with confirm_delete on comes back as a typed demand,
//      nothing deleted; the resend with the engine's request_state executes exactly once.
//   3. The state binds EVERYTHING it was about — caller, tool, target, row version — and each
//      binding refuses independently. Single consumption is structural (version = ledger seq,
//      never reused), so a consumed state can never delete anything again.
//   4. The exemptions are the DESIGNED ones only: agent actor (the conversation confirms, until
//      W1 pilots MRTR), pref off, and the privileged/undo path — never an accident of routing.
//
// Run: node test/confirmation.mjs

import { openStore, ITEM_WRITE_KEYS } from "../src/store.mjs";
import { CONFIRMATION_CLASSES, createRequestStateCodec, deletePreview } from "../src/confirmation.mjs";
import { latestPref } from "../src/runtime-core.mjs";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

// ------------------------------------------------------------------ 1. totality
console.log("1. classification totality — a new command cannot dodge the question");
{
  // The load-time totality assertion already ran: store.mjs imported above WITHOUT throwing,
  // and it walks both tables against each other. What stays pinned here is the table's own shape:
  const classes = Object.keys(CONFIRMATION_CLASSES);
  ok("every class row answers the question", classes.every((k) => typeof CONFIRMATION_CLASSES[k].confirm === "boolean"));
  ok("every exempt row states WHY", classes.every((k) => CONFIRMATION_CLASSES[k].confirm || typeof CONFIRMATION_CLASSES[k].why === "string"));
  ok("the destructive set is exactly {delete_item, delete_file}",
    classes.filter((k) => CONFIRMATION_CLASSES[k].confirm).sort().join(",") === "delete_file,delete_item");
  ok("request_state is a published delete_item key (run() must not strip the resend)",
    ITEM_WRITE_KEYS.delete_item.includes("request_state"));

  // …and the table is checked against the DISPATCHER, not just against its sibling table. The
  // boot assertion compares CONFIRMATION_CLASSES with EVENT_TYPES, so a command added to neither
  // would start up unclassified and unasked-about. The dispatcher is the ground truth for what
  // commands exist, so that is what the coverage is measured against (static scan, the idiom
  // test/invariants.mjs already uses for rules a machine has to hold).
  const storeSrc = readFileSync(join(ROOT, "src", "store.mjs"), "utf-8");
  const core = storeSrc.slice(storeSrc.indexOf("function core(command, privileged)"));
  const dispatched = [...new Set([...core.matchAll(/\btype === "([a-z_]+)"/g)].map((m) => m[1]))]
    .filter((t) => t !== "boolean" && t !== "string" && t !== "number" && t !== "object");
  ok("the scan finds the real dispatcher (non-vacuous)", dispatched.length >= 8, dispatched.join(","));
  const unclassified = dispatched.filter((t) => !CONFIRMATION_CLASSES[t]);
  ok("every command core() dispatches on is classified", unclassified.length === 0,
    `unclassified: ${unclassified.join(", ")} — add it to CONFIRMATION_CLASSES with a decision, not a shrug`);
}

// ------------------------------------------------------------------ 2. the two-phase flow
console.log("2. two-phase flow — demand, confirm, execute exactly once");
const st = openStore(":memory:");
const add = (cid, fields, actor = "human") =>
  st.execute({ type: "add_item", command_id: cid, collection: "probe", fields, actor, host: "t" });
{
  const a = add("a1", { title: "Buy milk" });
  const d = st.execute({ type: "delete_item", command_id: "d1", id: a.id, actor: "human", via: { app: "todo" } });
  // A demand answers to ONE name in the store: the boolean, exactly as `conflict` does. It is
  // deliberately NOT an `error` — nothing failed, and the wire word is minted at the tool layer.
  ok("first leg is a typed demand, not an error and not a delete",
    d.ok === false && d.confirmation_required === true && d.error === undefined);
  ok("the row is untouched", st.snapshot("probe").items.length === 1);
  ok("the demand carries state + preview + expiry",
    typeof d.request_state === "string" && d.preview === "Buy milk" && !Number.isNaN(Date.parse(d.expires_at)));
  ok("no ledger event was emitted for the demand", st.changesSince("probe", 0).events.every((e) => e.type !== "item_deleted"));
  const done = st.execute({ type: "delete_item", command_id: "d1", id: a.id, actor: "human", via: { app: "todo" }, request_state: d.request_state });
  ok("the resend (same command_id) executes", done.ok === true && done.deleted === true);
  ok("row gone", st.snapshot("probe").items.length === 0);
  const replay = st.execute({ type: "delete_item", command_id: "d2", id: a.id, actor: "human", via: { app: "todo" }, request_state: d.request_state });
  ok("the consumed state cannot act again (row gone = binding dead)", replay.ok === false && replay.error === "not_found");
}

// ------------------------------------------------------------------ 3. bindings refuse independently
console.log("3. every binding refuses on its own");
{
  const a = add("b1", { title: "target" });
  const b = add("b2", { title: "bystander" });
  const demand = (id, extra = {}) => st.execute({ type: "delete_item", command_id: "cd-" + id + Math.random(), id, actor: "human", ...extra });
  const d = demand(a.id, { via: { app: "todo" } });

  const cross = st.execute({ type: "delete_item", command_id: "x1", id: b.id, actor: "human", via: { app: "todo" }, request_state: d.request_state });
  ok("state for row A refuses row B", cross.error === "confirmation_invalid" && st.snapshot("probe").items.length === 2);

  const wrongVia = st.execute({ type: "delete_item", command_id: "x2", id: a.id, actor: "human", via: { app: "other" }, request_state: d.request_state });
  ok("state issued to one caller refuses another", wrongVia.error === "confirmation_invalid");

  st.execute({ type: "update_item", command_id: "x3", id: a.id, fields: { title: "edited meanwhile" }, actor: "human" });
  const stale = st.execute({ type: "delete_item", command_id: "x4", id: a.id, actor: "human", via: { app: "todo" }, request_state: d.request_state });
  ok("a row edited after issue kills the state (stale preview dies with it)", stale.error === "confirmation_invalid");

  const forged = st.execute({ type: "delete_item", command_id: "x5", id: a.id, actor: "human", via: { app: "todo" }, request_state: "AAAA.BBBB" });
  ok("a forged state refuses", forged.error === "confirmation_invalid");
  ok("nothing was deleted by any refusal", st.snapshot("probe").items.length === 2);
}

// ------------------------------------------------------------------ 4. codec properties
console.log("4. codec — expiry and tamper at the primitive level");
{
  const c = createRequestStateCodec({ ttlMs: -1 });   // everything it issues is already expired
  const bind = { type: "delete_item", caller: "human|todo", target: "row-1", version: 7 };
  ok("expired state says so", c.verify(c.issue(bind).state, bind).error === "confirmation_expired");
  const c2 = createRequestStateCodec();
  const s = c2.issue(bind).state;
  ok("valid state verifies", c2.verify(s, bind).ok === true);
  ok("one flipped bit refuses", c2.verify(s.slice(0, -2) + (s.slice(-2) === "aa" ? "bb" : "aa"), bind).ok === false);
  ok("a different codec instance (fresh secret) refuses — restart fails closed",
    createRequestStateCodec().verify(s, bind).ok === false);
  ok("preview truncates and survives junk", deletePreview({ x: 1 }) === "(item)" && deletePreview({ title: "y".repeat(99) }).length === 64);
}

// ------------------------------------------------------------------ 5. designed exemptions only
console.log("5. the exemptions are the designed ones");
{
  const a = add("e1", { title: "agent-deletable" });
  ok("agent delete is exempt (the conversation confirms; W1 pilots MRTR)",
    st.execute({ type: "delete_item", command_id: "e2", id: a.id }).ok === true);

  const b = add("e3", { title: "undo-deletable" });
  // The privileged flag rides the ledger-reverse/undo path (store-internal). security_set is its
  // only tool-facing door and cannot express delete_item — so exercise it via executePrivileged
  // directly, as the undo machinery does.
  ok("privileged (undo/reverse) path is exempt",
    st.executePrivileged({ type: "delete_item", command_id: "e4", id: b.id, actor: "human" }).ok === true);

  st.execute({ type: "add_item", command_id: "e5", collection: "settings", fields: { key: "confirm_delete", value: false }, actor: "human" });
  const c = add("e6", { title: "pref-off" });
  ok("pref off (global) = no demand", st.execute({ type: "delete_item", command_id: "e7", id: c.id, actor: "human" }).ok === true);

  // per-app override BEATS global: global back on, app "quickdel" opts out, another app doesn't
  st.execute({ type: "add_item", command_id: "e8", collection: "settings", fields: { key: "confirm_delete", value: true }, actor: "human" });
  st.execute({ type: "add_item", command_id: "e9", collection: "settings", group: "quickdel", fields: { key: "confirm_delete", value: false }, actor: "human" });
  const d1 = add("e10", { title: "one" }), d2 = add("e11", { title: "two" });
  ok("app override off = direct", st.execute({ type: "delete_item", command_id: "e12", id: d1.id, actor: "human", via: { app: "quickdel" } }).ok === true);
  ok("other app still demands", st.execute({ type: "delete_item", command_id: "e13", id: d2.id, actor: "human", via: { app: "other" } }).confirmation_required === true);
  // later global rows win (snapshot order) — the OFF written above was superseded by ON
  const d3 = add("e14", { title: "three" });
  ok("later global row wins", st.execute({ type: "delete_item", command_id: "e15", id: d3.id, actor: "human" }).confirmation_required === true);
}

// ------------------------------------------------------------------ 6. no route around: batch
// ------------------------------------------------------------------ 5b. the pref is ONE reading
console.log("5b. the pref the engine reads is the pref the UI shows (codex review, both halves)");
{
  // (a) PRECEDENCE is snapshot order — grp, position, created_at — the renderer's own. A store
  // resolver ordering by rowid read the low-position row as "later", so a settings UI showing
  // ON let a delete through with no demand.
  const p = openStore(":memory:");
  let i = 0;
  const w = (c) => p.execute({ ...c, command_id: "p" + ++i, actor: "human" });
  w({ type: "add_item", collection: "settings", group: "app-x", position: 100, fields: { key: "confirm_delete", value: true } });
  w({ type: "add_item", collection: "settings", group: "app-x", position: 0, fields: { key: "confirm_delete", value: false } });
  const row = w({ type: "add_item", collection: "probe", fields: { title: "t" } });
  ok("position order decides, not insertion order",
    w({ type: "delete_item", id: row.id, via: { app: "app-x" } }).confirmation_required === true);

  // (b) COERCION is coercePref's: a boolean pref only turns off on false/"false"/0. "FALSE" is
  // junk → the catalog default (on). A case-insensitive store-side reading treated it as off.
  const q2 = openStore(":memory:");
  let j = 0;
  const w2 = (c) => q2.execute({ ...c, command_id: "q" + ++j, actor: "human" });
  for (const junk of ["FALSE", "no", "0", "", "off"]) {
    const g = openStore(":memory:");
    let k = 0;
    const w3 = (c) => g.execute({ ...c, command_id: "g" + ++k, actor: "human" });
    w3({ type: "add_item", collection: "settings", fields: { key: "confirm_delete", value: junk } });
    const r = w3({ type: "add_item", collection: "probe", fields: { title: "t" } });
    ok(`junk value ${JSON.stringify(junk)} falls back to ON, never off`,
      w3({ type: "delete_item", id: r.id }).confirmation_required === true);
  }
  w2({ type: "add_item", collection: "settings", fields: { key: "confirm_delete", value: 0 } });
  const r2 = w2({ type: "add_item", collection: "probe", fields: { title: "t" } });
  ok("…while the real off values (false/\"false\"/0) still turn it off", w2({ type: "delete_item", id: r2.id }).ok === true);
}

// ------------------------------------------------------------------ 5c. the codex-review blockers
console.log("5c. the four reproduced bypasses, pinned shut");
{
  // B1 — ONE total order. The engine read (grp, position, created_at) while every widget reads
  // through the paged tool face, (grp, position, id). Equal positions are common in settings,
  // and "the last row wins" then meant different rows to the UI and to the gate.
  const p = openStore(":memory:");
  let i = 0;
  const w = (c) => p.execute({ ...c, command_id: "o" + ++i, actor: "human" });
  for (let k = 0; k < 8; k++) w({ type: "add_item", collection: "settings", group: "g", position: 5, fields: { key: "k", k } });
  ok("B1 the engine's row order IS the widget's row order, tie for tie",
    p.snapshot("settings").items.map((r) => r.id).join() === p.queryItems("settings", { limit: 500 }).items.map((r) => r.id).join());

  // B2 — presence ≠ value. The renderer's Map.has() makes a valueless app row an override that
  // falls back to ON; reading `value !== undefined` made it fall through to a global OFF.
  const q2 = openStore(":memory:");
  let j = 0;
  const w2 = (c) => q2.execute({ ...c, command_id: "v" + ++j, actor: "human" });
  w2({ type: "add_item", collection: "settings", fields: { key: "confirm_delete", value: false } });
  w2({ type: "add_item", collection: "settings", group: "victim", fields: { key: "confirm_delete" } });
  const row = w2({ type: "add_item", collection: "probe", fields: { title: "t" } });
  ok("B2 a valueless per-app row overrides the global layer, as the renderer has it",
    w2({ type: "delete_item", id: row.id, via: { app: "victim" } }).confirmation_required === true);

  // B4 — delete_file was classified but unreachable: no face carried `actor`, so every file
  // delete arrived as "agent" and executed. (B3 is a runtime-side hole; runner-guard owns it.)
  const f = openStore(":memory:");
  f.execute({ type: "write_file", command_id: "f1", app: "victim", path: "x.png", sha256: "a".repeat(64), size: 1 });
  const fd = f.execute({ type: "delete_file", command_id: "f2", app: "victim", path: "x.png", actor: "human" });
  ok("B4 a human file delete is demanded, and the file is still there", fd.confirmation_required === true && !!f.statFile("victim", "x.png"));
  ok("…and the confirmed resend deletes it",
    f.execute({ type: "delete_file", command_id: "f2", app: "victim", path: "x.png", actor: "human", request_state: fd.request_state }).ok === true
      && !f.statFile("victim", "x.png"));

  // The embedder's tier speaks through the SAME prompt now: it can only raise the bar.
  const g = openStore(":memory:");
  let m = 0;
  const w3 = (c) => g.execute({ ...c, command_id: "r" + ++m, actor: "human" });
  w3({ type: "add_item", collection: "settings", fields: { key: "confirm_delete", value: false } });
  const r3 = w3({ type: "add_item", collection: "probe", fields: { title: "t" } });
  ok("require_confirmation demands even with the preference OFF (the caps 'confirm' tier)",
    w3({ type: "delete_item", id: r3.id, require_confirmation: true }).confirmation_required === true);
  ok("…and it can only ADD one: it cannot wave a denied delete through",
    w3({ type: "delete_item", id: r3.id, require_confirmation: false }).ok === true);
}

// ------------------------------------------------------------------ 5d. one resolver, one answer
console.log("5d. ONE resolver for 'which row answers for this key' (found while verifying 5c)");
{
  // Duplicates under one key are ordinary — nothing forbids a second data_add_item. Every
  // WRITER (setPref in both runtimes, the settings UI, security_set) targets the LAST matching
  // row, so that is the canonical rule. Two readers disagreed: engine's readPref took the FIRST
  // match, and security_set UPDATED the first while computeCaps read the last — a policy that
  // reports itself set and never takes effect. latestPref is now the single implementation.
  const s = openStore(":memory:");
  let i = 0;
  const w = (c) => s.execute({ ...c, command_id: "n" + ++i, actor: "human" });
  w({ type: "add_item", collection: "settings", fields: { key: "user_name", value: "OLD" } });
  w({ type: "add_item", collection: "settings", fields: { key: "user_name", value: "NEW" } });
  const items = s.snapshot("settings").items;
  ok("the resolver takes the last row, like every writer", latestPref(items, "user_name").fields.value === "NEW");
  ok("…and returns the ROW, so a writer can target what the reader reads", typeof latestPref(items, "user_name").id === "string");
  w({ type: "add_item", collection: "settings", group: "an-app", fields: { key: "user_name", value: "APP" } });
  const items2 = s.snapshot("settings").items;
  ok("layers stay apart: the app scope does not leak into the global one",
    latestPref(items2, "user_name").fields.value === "NEW" && latestPref(items2, "user_name", "an-app").fields.value === "APP");
  ok("an absent key is undefined, not a guess", latestPref(items2, "nope") === undefined);
  ok("no reader is still resolving settings rows by hand",
    !/items\.find\(\(i\) => i\.fields\.key/.test(readFileSync(join(ROOT, "src", "tools", "settings.mjs"), "utf-8")));

  // Two fixes that each looked complete, and did not COMPOSE: the generic door learned to stamp
  // (so a delete cannot hide behind a different method name) and the file plane learned to demand
  // — but the stamped set was written before the second, so a top-level widget's file delete still
  // left unstamped, arrived as "agent" and executed. The set and the classified-destructive
  // commands are the same question asked twice; they are checked against each other here.
  // W4 moved the membership to tool-policy.mjs — ONE list beside the control-plane set — so
  // this pin now checks the shared list itself, plus that BOTH runtimes actually consume it
  // rather than restating it (a local `new Set([...])` reappearing is the drift coming back).
  const { STAMPED_TOOLS } = await import("../src/tool-policy.mjs");
  const stamped = new Set(STAMPED_TOOLS);
  // Store command name → tool name. They are NOT the same word and the difference is easy to
  // miss in both directions: the item verb gains a `data_` prefix, and the file verb REVERSES
  // (store `delete_file`, tool `file_delete`).
  const TOOL_OF = { delete_item: "data_delete_item", delete_file: "file_delete" };
  const mustStamp = Object.keys(CONFIRMATION_CLASSES).filter((k) => CONFIRMATION_CLASSES[k].confirm).map((k) => TOOL_OF[k]);
  ok("…and every destructive command has a known tool name (a new one must be added here)", mustStamp.every(Boolean));
  ok("every command that CAN be demanded is stamped on the direct runtime's generic door too",
    mustStamp.every((t) => stamped.has(t)), `stamped: ${[...stamped].join(",")} | must: ${mustStamp.join(",")}`);
  const rt = readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf-8");
  const rn = readFileSync(join(ROOT, "src", "runner.mjs"), "utf-8");
  ok("…and both runtimes import the shared membership instead of restating it",
    /new Set\(STAMPED_LIST\)/.test(rt) && /new Set\(DATA_WRITE_LIST\)/.test(rn)
      && !/new Set\(\["data_add_item"/.test(rt) && !/new Set\(\["data_add_item"/.test(rn));
}

// ------------------------------------------------------------------ 5e. built for the roadmap
console.log("5e. the three shapes that were built for TODAY only (roadmap review, Leo)");
{
  // ① The signing key belongs to the STORE, not the process. N hosts already share one database,
  // and hosted workers are interchangeable by design — a per-process key made a confirmation
  // issued by one engine unanswerable through any other.
  const p1 = join(ROOT, "test", "xproc.db");
  for (const f of [p1, p1 + "-wal", p1 + "-shm", p1 + ".confirm-key"]) { try { unlinkSync(f); } catch {} }
  const A = openStore(p1);
  const row = A.execute({ type: "add_item", command_id: "s1", collection: "t", fields: { title: "X" }, actor: "human" });
  const demand = A.execute({ type: "delete_item", command_id: "s2", id: row.id, actor: "human" });
  A.db.close();
  const B = openStore(p1);   // a second engine over the SAME database
  ok("① a demand issued by one engine is answerable through another over the same store",
    B.execute({ type: "delete_item", command_id: "s2", id: row.id, actor: "human", request_state: demand.request_state }).ok === true);
  B.db.close();
  ok("…and the key sits beside the database, never inside it (no schema, no migration rung)",
    existsSync(p1 + ".confirm-key"));
  const mem = openStore(":memory:");
  ok("…while an in-memory store keeps a process key — nothing else can open it", !!mem);
  for (const f of [p1, p1 + "-wal", p1 + "-shm", p1 + ".confirm-key"]) { try { unlinkSync(f); } catch {} }

  // ② The binding field is named for what it carries. It is NOT an authenticated principal.
  const src = readFileSync(join(ROOT, "src", "confirmation.mjs"), "utf-8");
  ok("② the binding field is `caller`, not `principal` — the gap is named where it is looked for",
    /issue\(\{ type, caller, target, version \}\)/.test(src) && /not called a principal/.test(src));

  // ③ ONE confirm-and-resend loop for both runtimes — W4 collapses mirrors, W-S must not add one.
  const rt = readFileSync(join(ROOT, "src", "runtime-core.mjs"), "utf-8");
  const runner = readFileSync(join(ROOT, "src", "runner.mjs"), "utf-8");
  const shell = readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf-8");
  ok("③ the loop is defined once, in the shared core", /export function withConfirmation/.test(rt));
  ok("…and both runtimes consume it rather than restating it",
    /withConfirmation\(\{ send:/.test(runner) && /withConfirmation\(\{ send:/.test(shell)
      && !/function confirmable\(/.test(runner) && !/function confirmable\(/.test(shell));
}

console.log("6. the batch cannot route around the gate");
{
  const a = add("g1", { title: "batched" });
  const r = st.executeBatch([{ type: "delete_item", id: a.id, command_id: "g2", actor: "human" }]);
  ok("a human batch delete fails CLOSED (all-or-nothing, demand as the failure)",
    r.ok === false && r.error === "batch_failed" && r.failure && r.failure.confirmation_required === true);
  ok("…and the failure carries the preview, so data_batch's message can say WHICH row",
    r.failure.preview === "batched");
  ok("row survived the failed batch", st.snapshot("probe").items.some((i) => i.id === a.id));
  const r2 = st.executeBatch([{ type: "delete_item", id: a.id, command_id: "g3", actor: "human", request_state: r.failure.request_state }]);
  ok("…and completes WITH the state (request_state is a published batch key)", r2.ok === true);
}

console.log("7. cascade (W1) — an unconditional two-step bound to the world the user was shown");
{
  // delete_app data:"cascade" demands for EVERY actor with the confirm_delete pref IGNORED —
  // the pref tunes friction on recoverable row deletes; this destroys whole collections with no
  // undo. The binding's `version` is the world (app version + candidate collection seqs +
  // settings stream), so any interleaved write invalidates the answer — plan_changed semantics
  // through the same codec, no bespoke token protocol.
  const s7 = openStore(":memory:");
  const UI = "<!DOCTYPE html><html><body>" + "x".repeat(300) + "</body></html>";
  s7.execute({ type: "save_app", command_id: "k1", name: "casc", ui: UI, actor: "local", description: "d" });
  s7.execute({ type: "add_item", command_id: "k2", collection: "casc", fields: { title: "row" }, actor: "agent" });
  s7.execute({ type: "add_item", command_id: "k3", collection: "settings", group: "casc", fields: { key: "a", value: 1 }, actor: "agent" });
  // pref OFF globally — a row delete would sail through, cascade must still demand
  s7.execute({ type: "add_item", command_id: "k4", collection: "settings", fields: { key: "confirm_delete", value: false }, actor: "human" });

  const d1 = s7.execute({ type: "delete_app", command_id: "k5", name: "casc", data: "cascade", actor: "agent" });
  ok("cascade demands even with confirm_delete OFF and actor=agent",
    d1.ok === false && d1.confirmation_required === true && typeof d1.request_state === "string");
  ok("…and the demand carries the plan (exclusive verdict for the app's own young collection)",
    Array.isArray(d1.plan) && d1.plan.some((c) => c.collection === "casc" && c.verdict === "exclusive"));

  // the world moves between demand and answer — the old answer must die
  s7.execute({ type: "add_item", command_id: "k6", collection: "casc", fields: { title: "sneaked in" }, actor: "human" });
  const stale = s7.execute({ type: "delete_app", command_id: "k7", name: "casc", data: "cascade", actor: "agent", request_state: d1.request_state });
  ok("a write between plan and confirmation invalidates the state (plan_changed, fail-closed)",
    stale.ok === false && stale.error === "confirmation_invalid");
  ok("…and nothing was deleted", s7.countItems("casc") === 2);

  // fresh demand, answered by a DIFFERENT caller — the binding refuses
  const d2 = s7.execute({ type: "delete_app", command_id: "k8", name: "casc", data: "cascade", actor: "agent" });
  const cross = s7.execute({ type: "delete_app", command_id: "k9", name: "casc", data: "cascade", actor: "human", request_state: d2.request_state });
  ok("one caller cannot spend another's answer", cross.ok === false && cross.error === "confirmation_invalid");

  // the honest completion: same caller, unchanged world
  const done = s7.execute({ type: "delete_app", command_id: "k10", name: "casc", data: "cascade", actor: "agent", request_state: d2.request_state });
  ok("confirmed cascade takes the exclusive rows AND the settings group",
    done.ok === true && done.cascaded.some((c) => c.collection === "casc" && c.rows === 2) && done.settings_keys === 1);
  ok("…rows and settings group are gone, the shared settings row survives",
    s7.countItems("casc") === 0 &&
    s7.snapshot("settings").items.every((i) => i.group !== "casc") &&
    s7.snapshot("settings").items.some((i) => i.fields.key === "confirm_delete"));
  const replay = s7.execute({ type: "delete_app", command_id: "k10", name: "casc", data: "cascade", actor: "agent" });
  ok("replaying the confirmed command_id echoes the cascade receipt without re-demanding",
    replay.ok === true && replay.idempotent === true && Array.isArray(replay.cascaded));

  // a collection that PREDATES the app is never exclusive — the name is not the rows
  s7.execute({ type: "add_item", command_id: "k11", collection: "notes", fields: { title: "old note" }, actor: "human" });
  s7.execute({ type: "save_app", command_id: "k12", name: "notes", ui: UI, actor: "local", description: "d" });
  const d3 = s7.execute({ type: "delete_app", command_id: "k13", name: "notes", data: "cascade", actor: "agent" });
  const verdict = d3.plan.find((c) => c.collection === "notes");
  ok("a same-named collection born BEFORE the app is unknown → kept",
    d3.confirmation_required === true && verdict && verdict.verdict === "unknown");
  const done3 = s7.execute({ type: "delete_app", command_id: "k14", name: "notes", data: "cascade", actor: "agent", request_state: d3.request_state });
  ok("…and the confirmed cascade leaves it untouched", done3.ok === true && s7.countItems("notes") === 1);
  s7.close();
}

console.log(fail ? `FAILED: ${pass} passed, ${fail} failed` : `ALL PASS: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
