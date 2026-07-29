// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// runtime-core.mjs — the PURE decision core of the widget runtime (write-set D).
//
// Every rule the runtime lives by is a plain function here, with no DOM, no bridge, no
// timers — so the contract that makes "click and it redraws with no extra round trip" true
// is pinned by node tests (test/runtime-core.mjs) instead of by hope. shell-runtime.js is
// wiring around this core; if a behavior matters, it belongs here, testable.
//
// The version axis, stated once: `state.version` is the GLOBAL ledger seq stamped inside the
// read's own transaction (store.mjs queryItems). A write ack carries `prev_collection_seq` —
// the seq of the last event that touched the ack's collection BEFORE the write. Therefore
//   prev_collection_seq ≤ state.version  ⟹  the last thing that happened to this collection
// was already inside our read ⟹ applying just the acked row locally loses nothing. That
// single inequality is the whole 0-RTT mechanism, and it needs no collection-scoped stamp
// on the read face.

/** The RUNTIME CONTRACT version, readable by any app as `oma.contract`.
 *
 *  It exists for apps written OUTSIDE this repo (install-app.mjs). An AI-authored app is
 *  written against the engine it is running on and pulls the guide in the same breath; a file
 *  built in someone else's editor months earlier has neither, and "which window.oma am I talking
 *  to" is a question it must be able to answer from inside the page. RUNTIME.md is the prose;
 *  this is the number that prose is about, and both runtimes expose the same one.
 *
 *  Bump ONLY on a change an existing app could notice: a name removed, a signature or return
 *  shape changed, a documented behaviour altered. Adding a name does not bump — an app built
 *  against 1 keeps working on an engine that added something, and feature-detects what it wants.
 *  test/runtime-contract.mjs pins the surfaces this number describes. */
export const RUNTIME_CONTRACT = 1;

/** Pages a mount walk will fetch before declaring the projection truncated (honestly). */
export const MAX_PAGES = 10;
/** Times a walk restarts when a write moves the version mid-walk, before adopting anyway. */
export const MAX_WALK_RESTARTS = 3;
/** Page size a walk asks for (the server may shrink a page to its result budget; the cursor
 *  follows the rows that actually shipped, so a shrunk page continues exactly where it ended). */
export const WALK_LIMIT = 500;

// ---------------------------------------------------------------- continuity (the 0-RTT rule)

/** Where a receipt actually SITS on the ledger, which is not always `ack.seq`.
 *
 *  A REPLAYED write (lost reply, host retry — the case idempotency exists for) answers with the
 *  ORIGINAL event's seq paired with the row as it stands TODAY (store.mjs's replay branch reads
 *  `itemById` fresh, deliberately: a retry must describe a real row, not a historical one). So a
 *  replay can carry seq 2 and an item at version 40. Judging staleness by `seq` alone then throws
 *  away the freshest row in the system and asks for no re-read either.
 *
 *  A row's `version` IS the ledger position of the last event that touched it, so for anything
 *  carrying a row that version is the honest position. A delete carries no row; its seq is it. */
export function ackPosition(ack) {
  if (ack && !ack.deleted && ack.item && ack.item.version != null) return Number(ack.item.version);
  return Number(ack && ack.seq);
}

/** What to do with a WRITE result, given the state we hold.
 *  → "apply"          the ack's row is safe to apply locally; step version to ack.seq
 *  → "apply-refresh"  apply for instant paint, but something touched this collection since
 *                     our read — re-walk to pick the concurrent write up, and do NOT step the
 *                     version until that walk lands (see below)
 *  → "stale"          the ack sits at or behind our watermark: a read at `held` already
 *                     included it, so applying it could only move us backwards
 *  → "conflict"       ok:false with reason/current row — caller surfaces note + refreshes
 *  → "ignore"         not ours (foreign collection / not an ack shape)                       */
export function decideAck(state, ack) {
  if (!ack || typeof ack !== "object" || !("ok" in ack)) return { kind: "ignore" };
  if (!state.collection || ack.collection !== state.collection) return { kind: "ignore" };
  if (ack.ok !== true) return { kind: "conflict" };
  const held = Number(state.version) || 0;
  const seq = ackPosition(ack);
  // ORDER, not just continuity. Two writes can be in flight at once (a user rapid-clicking one
  // item, two calls sharing one bridge) and their replies can land in either order. `prev ≤ held`
  // alone says nothing about that: the OLDER receipt also satisfies it, and applying it after the
  // newer one rewound both the row and `state.version`. An ack at or behind the watermark is
  // already inside the read we hold, so there is nothing in it to gain — and something to lose.
  if (Number.isFinite(seq) && seq <= held) return { kind: "stale" };
  const prev = Number(ack.prev_collection_seq);
  if (Number.isFinite(prev) && prev <= held) return { kind: "apply" };
  return { kind: "apply-refresh" };
}

/** Stable server order (store pages emit group, position, id) — a local apply must land the
 *  row where a re-read would have put it, or the paint and the next walk disagree. */
const byGroupPos = (a, b) =>
  a.group < b.group ? -1 : a.group > b.group ? 1
  : a.position !== b.position ? a.position - b.position
  : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Apply one write receipt to a row array. Returns the new array, or null when there is
 *  nothing applicable (no item on a non-delete ack — the caller re-walks instead).
 *  Deletion accounting is inside: delete removes, add/update/move upsert; the caller keeps
 *  `total` honest via the LENGTH DELTA (never the verb — an idempotent replay must not
 *  double-count). */
export function applyAck(items, ack) {
  const rows = items.slice();
  const i = rows.findIndex((r) => r.id === ack.id);
  // PER-ROW staleness, for callers that hold no single watermark (the pref cache, an embedded
  // child): a row's `version` IS the ledger seq of the last event that touched it, so a receipt
  // whose seq is behind it describes a state that has already been superseded. Returning the rows
  // UNCHANGED is deliberately not the same as returning null — null means "I could not apply this,
  // go re-read", and a stale ack is not a reason to pay for a walk.
  const seq = ackPosition(ack);   // the row's own version when it carries one — see ackPosition
  if (i !== -1 && Number.isFinite(seq) && (Number(rows[i].version) || 0) > seq) return rows;
  if (ack.deleted) {
    if (i !== -1) rows.splice(i, 1);
    return rows;
  }
  if (!ack.item || typeof ack.item !== "object") return null;
  if (i === -1) rows.push(ack.item);
  else rows[i] = ack.item;
  rows.sort(byGroupPos);
  return rows;
}

// ---------------------------------------------------------------- adoption gate (one rule)

/** The ONE adoption rule: un-adoptable ⇒ keep the old projection (never blank, never rebind).
 *  A snapshot is adoptable iff it is ours, complete-or-honestly-marked, and not older than
 *  what we already painted. `total === items.length` is only meaningful for an unfiltered
 *  walk — the walker marks filtered/truncated sets itself (J2's caveat, encoded). */
export function canAdopt(state, snap) {
  if (!snap || !Array.isArray(snap.items)) return false;
  if (state.collection && snap.collection !== state.collection) return false;
  if ((Number(snap.version) || 0) < (Number(state.version) || 0)) return false;
  if (!snap.truncated && !snap.filtered && typeof snap.total === "number" && snap.items.length !== snap.total) return false;
  return true;
}

// ---------------------------------------------------------------- the paged walk

/** Drive `fetchPage(cursor)` (→ a data_list body) until the cursor is exhausted or the page
 *  cap trips. Pages are pinned to ONE version: a write landing mid-walk moves the stamp and
 *  restarts the walk (bounded); the final permitted attempt tolerates the tear and says so
 *  (`torn: true`) rather than looping forever under sustained writes — the caller schedules a
 *  fast re-poll and convergence does the rest.
 *  Returns { items, version, settings_version, files_version, total, truncated, torn, restarts }
 *  or { error }. */
export async function walkPages(fetchPage, { maxPages = MAX_PAGES, maxRestarts = MAX_WALK_RESTARTS } = {}) {
  for (let attempt = 0; ; attempt++) {
    const tolerateTorn = attempt >= maxRestarts;
    const out = await walkOnce(fetchPage, maxPages, tolerateTorn);
    if (out.error || !out.torn || tolerateTorn) return { ...out, restarts: attempt };
  }
}

async function walkOnce(fetchPage, maxPages, tolerateTorn) {
  let items = [];
  let stamp = null;   // the walk's version pin (first page's trio + total)
  let sawTear = false;
  let cursor;
  for (let pages = 1; ; pages++) {
    const sc = await fetchPage(cursor);
    if (!sc || !Array.isArray(sc.items)) return { error: "bad_page" };
    if (stamp == null) {
      stamp = { version: sc.version, settings_version: sc.settings_version, files_version: sc.files_version, total: sc.total };
    } else if (sc.version !== stamp.version) {
      if (!tolerateTorn) return { torn: true };
      // Tolerated tear: the rows mix instants, so the walk KEEPS THE FIRST PAGE'S STAMP — the
      // oldest instant it actually saw. Adopting the freshest one was the bug: the caller stamped
      // v14 onto rows that were partly v13, the poll's probe then found seq unchanged and never
      // re-read, and the stale rows stayed forever. Holding the older mark makes the very next
      // probe see the collection move and walk again — convergence instead of a permanent lie.
      sawTear = true;
    }
    items = items.concat(sc.items);
    const next = sc.next_cursor;
    if (next == null) return { ...stamp, items, truncated: false, torn: sawTear };
    if (pages >= maxPages) return { ...stamp, items, truncated: true, torn: sawTear };
    cursor = next;
  }
}

// ---------------------------------------------------------------- poll decisions

/** What a data_version probe means for us. `checkChanges` says the global seq moved past what
 *  we hold — cheap to confirm against OUR collection before paying for a walk. `syncPrefs`
 *  catches a settings change that no longer rides data snapshots (writes return acks now). */
export function decideProbe(held, lastSettingsVersion, probe) {
  return {
    checkChanges: typeof probe?.seq === "number" && probe.seq !== (Number(held) || 0),
    syncPrefs: typeof probe?.settings_version === "number"
      && typeof lastSettingsVersion === "number"
      && probe.settings_version !== lastSettingsVersion,
  };
}

/** What a data_changes reply means: events (or an over-budget `total`) for OUR collection →
 *  walk; none → everything since our mark happened elsewhere, so holding `latest_seq` is safe
 *  and the next foreign write costs one probe, not a walk. An ahead-of-ledger re-anchor
 *  (`note` + next_since) lands on the same advance path by construction. */
export function decideChanges(changes) {
  if (!changes || typeof changes !== "object") return { kind: "walk" }; // unknown shape: be safe
  const n = Array.isArray(changes.events) ? changes.events.length : 0;
  if (n > 0 || (Number(changes.total) || 0) > 0) return { kind: "walk" };
  return typeof changes.latest_seq === "number" ? { kind: "advance", to: changes.latest_seq } : { kind: "walk" };
}

// ---------------------------------------------------------------- theme (the token cascade)
//
// Six layers, outermost first:
//   TOKEN_FALLBACK_CSS → host tokens → the kit → GLOBAL theme → PER-APP theme → app <style>
// The last three are what a user can change. A theme is TOKENS, never a stylesheet: the kit and
// every well-written app already read var(--color-*), so one token moves both at once, and
// a token cannot smuggle a selector or a `}` the way a raw CSS blob could (the brandCss hole).
//
// It needs NO new tool seat and no new store concept: a theme token is a row in the existing
// settings collection under the key `theme:--<name>`, and the two theme layers ARE the two pref
// scopes that already exist — group "" is global, group "<app>" is that one app. Merge
// order is oma.pref's merge order, unchanged.

/** Custom-property name/value charsets. ONE definition: shell.mjs's hostTokenStyle validates the
 *  EMBEDDER's tokens against the same pair, and a theme row is the same class of data arriving
 *  through a different door. The value charset excludes < > ; { } backslash and newline. */
export const TOKEN_NAME_RE = /^--[a-z][a-z0-9-]*$/;
export const TOKEN_VALUE_RE = /^[-a-zA-Z0-9 _.,()%#/'"]+$/;

/** Settings keys that carry a theme token. The colon is outside the declared-key charset
 *  (settings-design's a-z0-9_), so a theme row can never collide with an app's own pref. */
export const THEME_KEY_PREFIX = "theme:";

/** Merged prefs (object or Map) → [[--name, value], …], sorted, with everything that fails the
 *  charsets dropped. Pure shape: the global-vs-per-app decision already happened in the merge. */
export function themeVars(prefs) {
  const entries = prefs instanceof Map ? [...prefs] : (prefs && typeof prefs === "object" ? Object.entries(prefs) : []);
  const out = [];
  for (const [key, raw] of entries) {
    if (typeof key !== "string" || key.slice(0, THEME_KEY_PREFIX.length) !== THEME_KEY_PREFIX) continue;
    const name = key.slice(THEME_KEY_PREFIX.length);
    const value = String(raw == null ? "" : raw).trim();
    if (!TOKEN_NAME_RE.test(name) || !TOKEN_VALUE_RE.test(value)) continue;
    out.push([name, value]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ---------------------------------------------------------------- shared preview snapshots

/** The collections a manifest DECLARES, defensively — a manifest is data.
 *
 *  The grammar keys collections by name (`{"collections":{"trips":{…}}}`) and the store rejects
 *  the array form outright, so the array form is treated as declaring nothing rather than being
 *  index-walked. That is deliberately one notch stricter than contracts.mjs defaultCollectionFor,
 *  which would read `["trips"]` as the single key "0"; a shape the store refuses to persist should
 *  not be able to bind a preview to a collection named after an array index. */
function declaredCollections(declaration) {
  const c = declaration && declaration.collections;
  if (!c || typeof c !== "object" || Array.isArray(c)) return [];
  return Object.keys(c).map((k) => String(k).trim()).filter(Boolean);
}

/** One shared preview snapshot, cut down to what ONE app may see — and bound the way the engine
 *  would bind it.
 *
 *  An embedder that previews many apps at once (settings' Installed grid; the hosted /library
 *  composer) fetches every collection ONCE and hands each child its share. Two things have to be
 *  right at the same time, and the first version got one of them:
 *
 *    · a preview of the shopping list must not CONTAIN the medication log — the child is a real
 *      sandboxed document, so whatever is handed to it is inside it whether it reads it or not;
 *    · a preview that is starved of its own rows is just as broken, only quietly.
 *
 *  Slicing on `row.collection === appName` satisfies the first and fails the second, because an
 *  app's rows are not required to live under its own name. `builder-progress` declares
 *  `build-progress`; `elder-days` reads `elder-meds` / `elder-checks` / `elder-vitals`. Measured
 *  2026-07-29: 6 of the 17 shipped manifests declare a collection that is not the app name,
 *  and every one of them previewed empty.
 *
 *  So the share is what the app DECLARES, plus its own name, and the binding follows
 *  contracts.mjs defaultCollectionFor exactly: one declared collection is "the" one, several means
 *  there is no "the" and the name stays the default. Kept here rather than at the call sites
 *  because a second copy of "what does this app open on" is a second answer waiting to disagree —
 *  the same reason that rule lives in one place on the server. */
export function childPreviewSnapshot(rows, { app, declaration, apps, tier } = {}) {
  const name = String(app || "");
  // TIER GATE, and it is not decoration — it is the same gate contracts.mjs defaultCollectionFor
  // puts on the same question, for a sharper reason here. A manifest is written BY THE APP.
  // For a local (first-party / AI-authored) app that is it telling us where its own rows live. For
  // an UNREVIEWED one — a share-installed third-party app, T19 P-c — honouring it would let the
  // app NAME ITS WAY INTO another app's rows: this snapshot is shared, the parent has already
  // fetched every collection, and the slice is the only thing keeping them apart. An unreviewed
  // app declaring `{"collections":{"private-ledger":{}}}` would be handed that collection by the
  // act of being previewed. Untrusted apps see their own name and nothing else.
  //
  // Fail closed: an absent tier is not a local tier.
  const declared = tier === "local" ? declaredCollections(declaration) : [];
  const collection = declared.length === 1 ? declared[0] : name;
  const allowed = new Set([collection, name, ...declared]);
  return {
    collection,
    items: (rows || []).filter((r) => r && typeof r === "object" && allowed.has(r.collection)),
    // Never undefined: inert's list_apps has no other source, and an app whose collection is
    // empty is invisible to a row-derived answer — it exists only in the roster.
    apps: Array.isArray(apps) ? apps : [],
  };
}

// ---------------------------------------------------------------- via (shadow provenance)

/** App names, as the store enforces them (contracts bad_name rule). */
export const VIA_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** The via stamp for a widget write — OBJECT FORM, frozen before the first stamp (row #8):
 *  widget write = {app}; a function write adds {function} (write-set F). Advisory
 *  provenance only (forgeable, like actor): consumed by the Data pane, stripped from every
 *  AI face, never part of export/publish closure. Returns undefined when the name can't be
 *  stamped — a write must never fail over its shadow edge. */
export function viaOf(app, fn) {
  const c = String(app || "");
  if (!VIA_NAME_RE.test(c)) return undefined;
  if (fn == null) return { app: c };
  const f = String(fn);
  return f ? { app: c, function: f } : { app: c };
}
