// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// store.mjs — the generic persistent store behind open-mcp-apps.
//
// Two things live here, both versioned, both MCP-independent:
//   1. DATA:      collections of items ({id, group, position, fields, version})
//   2. COMPONENTS: the UI registry ({name, version, html}) — what the AI creates & reuses
//
// Invariants (carried over from the proven todo prototype):
//   - current-state tables + an append-only `change_event` ledger, ONE transaction per command
//   - every mutation is idempotent via a client-supplied command_id
//   - optimistic concurrency via expected_version
//   - callers (AI or widget) speak typed domain commands only — never SQL

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import { readDeclaration } from "./manifest-block.mjs";
// tierOf only, and deliberately from the module that owns the security model rather than a second
// copy of the author→tier partition living here: the disease this codebase watches for is DIALECTS,
// and two places deciding what "local" means is exactly one. contracts.mjs imports nothing but zod,
// so this direction adds no cycle.
import { tierOf } from "./contracts.mjs";

// Migration-format pin: stamped into PRAGMA user_version AND every change_event payload (`sv`).
// Export/import + SaaS sync read this to know which event shape they are looking at — bump it on
// any breaking payload/schema change and translate old values on read. Never reuse a number.
export const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS item (
  id         TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  grp        TEXT NOT NULL DEFAULT '',
  position   REAL NOT NULL DEFAULT 0,
  fields     TEXT NOT NULL DEFAULT '{}',   -- JSON object, component-defined shape
  version    INTEGER NOT NULL DEFAULT 1,
  -- E13f/g: WHO owns this row. NULL is today's meaning — shared across the org — and stays the
  -- default forever. Reserved now because principal has to cover member / guest / anon in ONE
  -- definition: a guest is authenticated but not a member, so a scheme that only knows members
  -- cannot be widened to hold one later.
  principal  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_collection ON item(collection);
-- Serves the paged/filtered read path (queryItems): WHERE collection [AND grp] with an
-- ORDER BY that matches the index columns, so pages never sort the whole collection.
CREATE INDEX IF NOT EXISTS idx_item_coll_grp_pos ON item(collection, grp, position);

CREATE TABLE IF NOT EXISTS component (
  name        TEXT PRIMARY KEY,             -- [a-z][a-z0-9-]*; with OMA_DYNAMIC_TOOLS=1 it also surfaces as an open_<name> tool (flag defaults OFF — cache)
  version     INTEGER NOT NULL DEFAULT 1,
  html        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT 'agent',
  scene       TEXT,                         -- JSON {category_id, tags?} | NULL — Library taxonomy metadata
  manifest    TEXT,                         -- JSON {collections:{<coll>:{fields:{..},strict?}}} | NULL — declared field contracts, enforced in core()
  -- E4 shape reservations, added early because a column added later cannot describe rows that
  -- already exist. Two have since been claimed by current law: kind (list_components filters on
  -- it) and visibility (listing + archive_component live on it). kit_version and server_script
  -- remain reservations — written and read by nothing yet.
  kind        TEXT NOT NULL DEFAULT 'app',  -- app | visual | primitive — lets list_components stop listing non-apps
  visibility  TEXT NOT NULL DEFAULT 'listed', -- featured | listed | unlisted | archived (archive, curation and the long tail, in one field)
  kit_version TEXT,                         -- which inlined kit build this component carries (L4)
  server_script TEXT,                       -- E13d: server-side functions. Reserved now so they never have to live inside the html column
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS component_history (
  name    TEXT NOT NULL,
  version INTEGER NOT NULL,
  html    TEXT NOT NULL,
  ts      TEXT NOT NULL,
  PRIMARY KEY (name, version)
);

-- File plane (scope b — user files; design: scratchpad/FILE-STORAGE-design.md). Bytes live in a
-- SWAPPABLE backend (src/files.mjs — local folder now, remote later), NEVER here; this table is the
-- per-app ref index that drives quota + versioning + audit. Isolation is a KEY, not a convention:
-- PRIMARY KEY (component, path) + WHERE component=? on every read make cross-app addressing impossible.
CREATE TABLE IF NOT EXISTS file (
  component  TEXT NOT NULL,               -- owning app = isolation namespace (COMPONENT_NAME_RE)
  path       TEXT NOT NULL,               -- app-chosen logical name; a DB VALUE, never a fs path segment
  sha256     TEXT NOT NULL,               -- content address → files/<component>/<sha256>.blob in the backend
  size       INTEGER NOT NULL,            -- LOGICAL bytes (drives quota; content-addressed dedup cannot bypass)
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  version    INTEGER NOT NULL DEFAULT 1,  -- +1 per overwrite (OCC token, mirrors item.version)
  backend    TEXT NOT NULL DEFAULT 'local', -- remote seam: 'local' | 'remote' (per-row, mid-migration transparent)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (component, path)
);
CREATE INDEX IF NOT EXISTS idx_file_component ON file(component);
CREATE INDEX IF NOT EXISTS idx_file_sha       ON file(component, sha256);

CREATE TABLE IF NOT EXISTS change_event (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_id TEXT NOT NULL,               -- item id | component name | collection name
  command_id   TEXT NOT NULL UNIQUE,        -- idempotency key
  event_type   TEXT NOT NULL,               -- item_added|item_updated|item_moved|item_deleted|component_saved|component_deleted
  payload      TEXT NOT NULL,               -- JSON (component html NOT included — it's in component_history)
  actor        TEXT NOT NULL,             -- see ACTORS: the CLASS that wrote this
  -- 🔴 The one genuinely irreversible reservation. The ledger only grows, so if anonymous writes
  -- ever land without a dimension that distinguishes them, the history can never be sorted into
  -- "the owner did this" and "a stranger did this" — not a missing feature, unrecoverable data.
  principal    TEXT,
  host         TEXT,
  ts           TEXT NOT NULL
);
-- settings_version: every item event's payload carries \`collection\`; component_saved does
-- not and is excluded. Ledger-derived so it stays correct across processes sharing one DB.
CREATE INDEX IF NOT EXISTS idx_event_settings ON change_event(seq)
  WHERE json_extract(payload, '$.collection') = 'settings';
-- files_version: file events are ledger-derived (mirrors idx_event_settings) so it stays correct
-- across processes sharing one DB. file_* payloads carry NO 'collection' key, so idx_event_settings
-- ignores them and settings_version is unaffected by file activity.
CREATE INDEX IF NOT EXISTS idx_event_file ON change_event(seq)
  WHERE event_type = 'file_written' OR event_type = 'file_deleted';

-- Delta reads walk the ledger for ONE collection. idx_event_settings/idx_event_file are partial
-- indexes over fixed predicates and cannot serve an arbitrary collection, so this is the general
-- expression index for the same json_extract they already established as the access pattern.
CREATE INDEX IF NOT EXISTS idx_event_collection
  ON change_event(json_extract(payload, '$.collection'), seq);

-- WHERE THE LEDGER STOPS BEING A COMPLETE ACCOUNT OF A COLLECTION.
--
-- Retention deletes a collection's OLDEST events, and one question in this store reads exactly
-- those: "was this collection created FOR this app, or was it already here?" is answered by
-- comparing earliest events, and pruning moves that answer forward. The judge cannot see the gap
-- from the inside — the rows it needs are the rows that are gone — so pruning writes down that it
-- happened, and the judge reads the note instead of guessing.
--
-- Deliberately NOT a change_event: the mark has to outlive the very operation that removes events.
-- Additive and idempotent (CREATE IF NOT EXISTS), so an existing database gains it on next open
-- with nothing to migrate — a database that has never pruned simply has no rows here, which is the
-- correct reading of "nothing was truncated".
CREATE TABLE IF NOT EXISTS ledger_truncation (
  collection TEXT PRIMARY KEY,
  before_seq INTEGER NOT NULL,     -- events strictly below this are no longer accounted for
  ts         TEXT NOT NULL
);

`;

// The CLASS that performed a write. Closed on purpose (E13b): `actor` used to be free text, so an
// anonymous write could silently land labelled "human" and the ledger would never be able to tell
// the owner's edits from a stranger's. The ledger only grows, so that mislabelling is permanent —
// this is the one reservation that cannot be fixed after the fact. 'guest' and 'anon' are reserved
// NOW and rejected nowhere: no code path produces them yet, and when one does it must say so.
// version N here runs when upgrading a database stamped at N-1. Empty until the first bump; the
// SHAPE is what E4a is for. Exported as a pure lookup so it can be tested without one.
export const MIGRATIONS = {
  // v2 — ONE ordinal axis. Three separate counters (item.version, component.version, file.version)
  // become positions on the ledger, which is the only clock every plane already shares. What this
  // buys: `expected_version` means the same number everywhere, a delta's `seq` is directly usable as
  // the OCC token for the row it describes, and "is my copy current?" stops needing a per-plane
  // answer. What it costs: version numbers stop being small and consecutive (v3 becomes v41782),
  // and for one moment after the upgrade an in-flight caller holding an old small number gets one
  // conflict and retries. Both were signed for.
  //
  // Each row is stamped with the seq of the LAST event that touched it — its true position in the
  // history — and rows with no event (seeded before the ledger, or written by an older build) keep
  // a monotonic stand-in derived from the current head, so every OCC check still compares like
  // with like. (An entirely empty ledger stamps 0 — with nothing on the axis yet, nothing collides.)
  2(db) {
    const head = db.prepare("SELECT COALESCE(MAX(seq),0) AS v FROM change_event").get().v;
    // item: last ITEM event for this id. The type restriction is load-bearing: aggregate_id is a
    // shared namespace, and an item whose id happens to equal a component's name must not inherit
    // the component's seq.
    db.exec(`UPDATE item SET version = COALESCE(
               (SELECT MAX(e.seq) FROM change_event e WHERE e.aggregate_id = item.id
                  AND e.event_type IN ('item_added','item_updated','item_moved')), ${head})`);
    // component: last component_saved for this name. component_history is keyed (name, version), so
    // it is rewritten in the same pass — otherwise restore_component would look up a version that
    // no longer exists on the row.
    const comps = db.prepare("SELECT name, version FROM component").all();
    const lastSave = db.prepare(
      "SELECT MAX(seq) AS v FROM change_event WHERE event_type = 'component_saved' AND aggregate_id = ?");
    const setComp = db.prepare("UPDATE component SET version = ? WHERE name = ?");
    const rekeyHist = db.prepare("UPDATE component_history SET version = ? WHERE name = ? AND version = ?");
    for (const c of comps) {
      const seq = lastSave.get(c.name).v ?? head;
      // History rows for OTHER versions of this component keep their old numbers: they are historical
      // positions that no longer collide with anything live, and rewriting them would need an event
      // per version, which the ledger does not have for pre-ledger saves. The CURRENT version is the
      // one that has to agree with the row, because that is the one restore/auto-revert reads.
      rekeyHist.run(seq, c.name, c.version);
      setComp.run(seq, c.name);
    }
    // file: last file_written for component/path.
    db.exec(`UPDATE file SET version = COALESCE((SELECT MAX(e.seq) FROM change_event e
               WHERE e.event_type = 'file_written'
                 AND e.aggregate_id = file.component || '/' || file.path), ${head})`);
  },
  // v3 — the library rename (gallery → library, v0.3.0). Two facts move: the PROVENANCE stamp
  // (author 'gallery' → 'library', which tierOf reads — without this, rows installed by v0.2.0
  // would fall to the strictest tier under a build whose tierOf no longer knows the old word),
  // and the SYSTEM component's NAME (the seeder would otherwise add 'library' beside a stale
  // 'gallery' row that nothing locks or lists any more). The LEDGER is deliberately untouched:
  // events are history, history happened under the old name, and rewriting payloads would forge
  // the past — a reader of old events sees 'gallery' and that is the truth of when they occurred.
  3(db) {
    db.exec(`UPDATE component SET author = 'library' WHERE author = 'gallery'`);
    // Rename the system row only when the new name is free — a collision would mean a v0.3 build
    // already seeded 'library' into this store, and then the stale row is dropped, not renamed
    // (its html is the OLD build's browse surface; keeping two library UIs helps nobody).
    const hasNew = db.prepare("SELECT 1 FROM component WHERE name = 'library'").get();
    const hasOld = db.prepare("SELECT 1 FROM component WHERE name = 'gallery'").get();
    if (hasOld && !hasNew) {
      db.exec(`UPDATE component SET name = 'library' WHERE name = 'gallery'`);
      db.exec(`UPDATE component_history SET name = 'library' WHERE name = 'gallery'`);
    } else if (hasOld && hasNew) {
      db.exec(`DELETE FROM component_history WHERE name = 'gallery'`);
      db.exec(`DELETE FROM component WHERE name = 'gallery'`);
    }
  },
};
export function migrationsBetween(from, to) {
  const steps = [];
  for (let v = from + 1; v <= to; v++) if (MIGRATIONS[v]) steps.push(MIGRATIONS[v]);
  return steps;
}

export const ACTORS = new Set(["agent", "human", "seed", "library", "guest", "anon"]);

// What a component IS (drives what list_components will eventually bother listing) and how visible
// it is. Closed sets for the same reason ACTORS is: a typo'd value would be indistinguishable from
// a real one, and these decide what the model gets to see.
// Commands where `actor` is authorship provenance rather than a write class — see execute().
const AUTHORSHIP_COMMANDS = new Set(["save_component", "delete_component"]);

export const COMPONENT_KINDS = new Set(["app", "visual", "primitive"]);
export const VISIBILITIES = new Set(["featured", "listed", "unlisted", "archived"]);

export const COMPONENT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_COMPONENT_HTML = 200_000;

// Security v0.1 content-rules (docs/security-model.md §4–§5), enforced in the store so they
// bind EVERY caller and transport (the AI, the browser /rpc, a widget) — the engine cannot
// tell an AI tool-call from a widget tool-call, so these are the rules that hold for all.
export const SETTINGS_COLLECTION = "settings";
// Reserved policy namespaces: writable ONLY via executePrivileged (the security_set tool).
// The colon prefix is outside the settings-design declared-key charset, so it never collides
// with a component's own preference keys.
export const RESERVED_KEY_RE = /^(?:security|policy):/;
// Per-item DoS floor: no single item's fields JSON may exceed this, for anyone.
export const MAX_ITEM_FIELDS_BYTES = 32_768;
// A group is a LANE NAME, not a data field: it rides every event, every cursor and every receipt
// for its rows, so it must not be essay-sized. The cap is also what keeps a SINGLE row structurally
// unable to outgrow the result budget (fields have their own cap; group was the uncapped hole).
export const MAX_GROUP_CHARS = 500;
// ─────────────────────────────────────────── one key table, two write paths (both need the wall)
// WHICH keys a caller may set on an item write, per command. Everything else it sends is dropped
// rather than forwarded — "unpublished keys are dropped, not honored", which data_batch has always
// enforced and the single-write tools did not, because their schemas are `.passthrough()` (they
// have to be, to carry the runner's `via` stamp). Two consequences of that gap, both measured:
//   · `type` survived and dispatched a control-plane command through a data tool (fixed separately
//     by pinning type after the spread — this table is the general form of the same wall);
//   · `id` survived on add_item, and CHOOSING an id is what makes a deleted id re-creatable in
//     another collection. After that a widget's stale snapshot still lists the id and an
//     id-addressed write lands on the foreign row (adversarial #2, B-3).
// Note what is deliberately absent: `id` on add_item. The engine mints row ids. The ledger-replay
// path DOES recreate rows under their original ids, and it reaches store.execute() directly — this
// table governs the TOOL face, which is the only face an untrusted caller has.
export const ITEM_WRITE_KEYS = {
  add_item: ["collection", "group", "fields", "position"],
  update_item: ["id", "fields", "expected_version"],
  move_item: ["id", "group", "position", "expected_version"],
  delete_item: ["id", "expected_version"],
};
/** Envelope keys a batch command may carry — the historical set, unchanged. */
export const BATCH_ENVELOPE_KEYS = ["command_id", "actor", "host"];
/** …and the SINGLE-tool envelope, which adds `via`: the widget's shadow provenance stamp is the
 *  reason those four schemas are passthrough at all, so the wall has to let it through. Kept apart
 *  from the batch's set deliberately — `data_batch` is the model's bulk verb, never a widget's
 *  (the runner refuses it by name), so nothing should start stamping provenance through it. */
export const ITEM_WRITE_ENVELOPE = [...BATCH_ENVELOPE_KEYS, "via"];

// Commands per batch. Sized from what a batch is FOR — seeding an app from a conversation's history,
// filling a board in one go — not from what SQLite can take. A caller with more than this has a
// migration, not an interaction, and should page it.
export const MAX_BATCH_COMMANDS = 200;

// File plane (scope b — unstructured user files too big/binary for `fields`). The store enforces
// LOGICAL-byte quotas (SUM of ref sizes) so content-addressed dedup can never bypass them; byte
// TRANSPORT (single-shot vs chunked/streamed) is the engine/channel's concern, not the store's.
// Caps are the "generous, OSS-local" profile (Leo 2026-07-23) — a runaway-app disk floor, not a
// business limit; tune freely. `path` is an app-chosen logical name, NEVER a filesystem path.
export const FILE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/ -]{0,255}$/; // ".."/leading-slash/backslash/NUL/control rejected separately
export const MAX_FILE_BYTES       = 250 * 1024 * 1024;        // per-file logical cap
export const MAX_FILE_INLINE_BYTES = 5 * 1024 * 1024;         // single-call/data:-inline ceiling (engine tools); larger files use the chunked/streaming path (F4). ⚠ real host tool-result char limits validated at F3
export const MAX_APP_FILE_BYTES   = 5 * 1024 * 1024 * 1024;   // per-app (SUM of ref sizes)
export const MAX_APP_FILE_COUNT   = 10_000;                   // per-app file count
export const MAX_TOTAL_FILE_BYTES = 50 * 1024 * 1024 * 1024;  // global
export const MAX_TOTAL_FILE_COUNT = 200_000;                 // global file-count floor — bounds zero-byte/deduped rows + inodes the byte caps can't (every regex-valid component name is otherwise a fresh per-app budget)

// Component schema manifests: a component declares WHICH collections it stewards and, optionally,
// field contracts for them. Validation lives HERE (not the engine) so it binds EVERY caller — AI
// tool, widget mutation, /rpc. Manifest-less collections behave exactly as before.
//
// `fields` is OPTIONAL: a bare `{collections: {trips: {}}}` is a pure STEWARDSHIP declaration —
// it claims the collection for the lifecycle plane (export/archive view/retention/Data pane) and
// validates nothing. That split is the point: stewardship is declared, access is decided by caps,
// and neither implies the other. Requiring `fields` is what made stewardship unaffordable to
// declare, which is why the collection↔component edge appeared not to exist at all.
export const MANIFEST_FIELD_TYPES = new Set(["string", "number", "boolean", "object", "array"]);
export function manifestShapeError(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "manifest must be an object";
  // `collections` is OPTIONAL at the top level. A component's declaration is mostly about itself —
  // its settings, which shared prefs it honours, later its functions and what it embeds — and most
  // real components declare no collection contract at all. Demanding one made the whole declaration
  // unwritable for them.
  if (m.collections != null) {
    if (typeof m.collections !== "object" || Array.isArray(m.collections)) return "manifest.collections must be an object";
    for (const [coll, spec] of Object.entries(m.collections)) {
      if (!coll) return "empty collection name";
      // CANONICAL form only. Every write canonicalizes with String(collection).trim(), so a padded
      // key names a collection that can be declared but never written: the manifest would govern
      // " trips " while the rows land in "trips" — two names, one of which holds nothing. Since the
      // declaration also drives the default binding, that opens the app on the empty one. Refuse it
      // at the door, where the message can say what to write instead.
      if (coll !== coll.trim()) return `collection name "${coll}" has leading/trailing whitespace — write "${coll.trim()}"`;
      if (coll === SETTINGS_COLLECTION) return `manifest may not govern the reserved "${SETTINGS_COLLECTION}" collection`;
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) return `collections.${coll} must be an object`;
      if (spec.strict != null && typeof spec.strict !== "boolean") return `collections.${coll}.strict must be a boolean`;
      // strict without fields would mean "reject every key against an empty contract" — a footgun
      // that reads as a typo, never as an intent. Say so instead of enforcing it.
      if (spec.strict && spec.fields == null) return `collections.${coll}.strict requires fields`;
      if (spec.label_field != null && (typeof spec.label_field !== "string" || !spec.label_field))
        return `collections.${coll}.label_field must be a non-empty string`;
      if (spec.fields == null) continue;   // stewardship-only declaration
      if (typeof spec.fields !== "object" || Array.isArray(spec.fields)) return `collections.${coll}.fields must be an object`;
      for (const [fname, f] of Object.entries(spec.fields)) {
        if (!f || typeof f !== "object" || Array.isArray(f)) return `field ${coll}.${fname} must be an object`;
        if (!MANIFEST_FIELD_TYPES.has(f.type)) return `field ${coll}.${fname}.type must be one of ${[...MANIFEST_FIELD_TYPES].join("|")}`;
        if (f.required != null && typeof f.required !== "boolean") return `field ${coll}.${fname}.required must be a boolean`;
        if (f.enum != null && (!Array.isArray(f.enum) || f.enum.length === 0)) return `field ${coll}.${fname}.enum must be a non-empty array`;
      }
    }
  }
  // The rest of the declaration face. Shape only — what each key MEANS is enforced by whoever reads
  // it (the settings app renders `settings`, list_components filters on `kind`), which is why a key
  // this build does not know yet is IGNORED rather than rejected: a document written for a newer
  // engine must still save on an older one, or the declaration stops being safe to grow.
  if (m.manifest_version != null && ![1, 2].includes(m.manifest_version)) return "manifest_version must be 1 or 2";
  if (m.settings != null && !Array.isArray(m.settings)) return "manifest.settings must be an array";
  if (m.uses_shared != null && !Array.isArray(m.uses_shared)) return "manifest.uses_shared must be an array";
  if (m.kind != null && !COMPONENT_KINDS.has(m.kind)) return `manifest.kind must be one of ${[...COMPONENT_KINDS].join("|")}`;
  if (m.scene != null && (typeof m.scene !== "object" || Array.isArray(m.scene))) return "manifest.scene must be an object";
  return null;
}

// ─────────────────────────────────────────────────────────────── one operator table, two consumers
// Filtering appears in two places — `match` on a read, and the aggregate query — and they use the
// SAME table. Two tables would be two dialects, and the second one is always the one nobody knows.
//
// The forms, all of them:
//   fields.done: false            → equality (a bare value is `eq`, because that is what a caller writes first)
//   fields.n: {gt: 3}             → gt / gte / lt / lte
//   fields.state: {ne: "done"}    → ne
//   fields.title: {contains: "x"} → substring, case-insensitive (a human filter, not a regex)
//   fields.date: {prefix: "2026-"}→ starts-with; the workhorse for ISO date buckets
//   fields.note: {exists: true}   → is the key present and non-null
//
// One consequence, written down so it is a rule and not an accident: an OBJECT VALUE is always read
// as an operator set. A collection whose field genuinely holds `{gt: 3}` cannot be matched on that
// field by equality — and that is the trade, because operator-or-literal ambiguity resolved by
// guessing is worse than a documented restriction.
export const MATCH_OPS = new Set(["eq", "ne", "lt", "lte", "gt", "gte", "contains", "prefix", "exists"]);

// Numeric coercion is the same rule preferences use — one doctrine, so "3" and 3 never mean
// different things in different corners of the engine.
const asNumExport = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Order two values, or report that the question does not apply.
 *
 *  The COMPARISON KIND comes from the filter, not from the data: {amount: {gte: 12}} is a numeric
 *  question, so a field holding "not a number" is not "greater than 12" — it is incomparable, and it
 *  does not match. (Falling back to string order here is how `gte: 12` quietly matched "not a
 *  number": "n" sorts after "1". Measured, in a test that was written to check something else.)
 *  {date: {gte: "2026-01"}} is a string question and compares lexicographically, which is what makes
 *  ISO dates work. This is the same treatment the aggregate gives a non-numeric value — it is left
 *  out of the sum and `_from` says so — because one doctrine beats two that nearly agree. */
const INCOMPARABLE = Symbol("incomparable");
const cmp = (a, b) => {
  if (typeof b === "number") {
    const na = asNumExport(a);
    return na == null ? INCOMPARABLE : na === b ? 0 : na < b ? -1 : 1;
  }
  const sa = String(a ?? ""), sb = String(b ?? "");
  return sa === sb ? 0 : sa < sb ? -1 : 1;
};
const ordered = (v, want, test) => { const c = cmp(v, want); return c !== INCOMPARABLE && test(c); };

/** Does one field value satisfy one operator set (or one literal)? */
function opMatches(value, spec) {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return value === spec;
  for (const [op, want] of Object.entries(spec)) {
    if (!MATCH_OPS.has(op)) return false;                       // an unknown operator matches nothing
    switch (op) {
      case "eq":       if (value !== want) return false; break;
      case "ne":       if (value === want) return false; break;
      case "lt":       if (!ordered(value, want, (c) => c < 0)) return false; break;
      case "lte":      if (!ordered(value, want, (c) => c <= 0)) return false; break;
      case "gt":       if (!ordered(value, want, (c) => c > 0)) return false; break;
      case "gte":      if (!ordered(value, want, (c) => c >= 0)) return false; break;
      case "contains": if (!String(value ?? "").toLowerCase().includes(String(want ?? "").toLowerCase())) return false; break;
      case "prefix":   if (!String(value ?? "").startsWith(String(want ?? ""))) return false; break;
      case "exists":   if ((value != null) !== Boolean(want)) return false; break;
    }
  }
  return true;
}

/** Every clause must hold (AND). There is no OR: a caller who needs one runs two reads, and a
 *  filter language that grows an expression tree stops being something a model can write correctly. */
export function itemMatches(fields, match) {
  for (const [key, spec] of Object.entries(match)) if (!opMatches(fields[key], spec)) return false;
  return true;
}

/** Which operator name in a filter is not one — so a typo is a message, not silence. */
export function unknownOps(match) {
  const bad = [];
  for (const [key, spec] of Object.entries(match || {}))
    if (spec && typeof spec === "object" && !Array.isArray(spec))
      for (const op of Object.keys(spec)) if (!MATCH_OPS.has(op)) bad.push(`${key}.${op}`);
  return bad;
}

// null/absent counts as "not set" (update_item uses null-to-delete; required catches it, type doesn't).
// Match is on JS primitives; enum membership is strict equality.
function fieldViolations(spec, fields) {
  const out = [];
  // A stewardship-only declaration (no `fields`) validates nothing. Without this guard the
  // Object.entries below throws INSIDE the write transaction — not a clean rejection, a crash.
  if (spec.fields == null) return out;
  for (const [fname, f] of Object.entries(spec.fields)) {
    const val = fields[fname];
    if (val == null) { if (f.required) out.push(`${fname}: required`); continue; }
    const t = Array.isArray(val) ? "array" : typeof val;
    if (t !== f.type) { out.push(`${fname}: expected ${f.type}, got ${t}`); continue; }
    if (f.enum && !f.enum.includes(val)) out.push(`${fname}: must be one of [${f.enum.join(", ")}]`);
  }
  if (spec.strict) for (const k of Object.keys(fields)) if (!(k in spec.fields) && fields[k] != null) out.push(`${k}: undeclared field (strict manifest)`);
  return out;
}

// command type → ledger event_type. Idempotency replays are matched against this: a seen
// command_id only short-circuits when the prior event is the SAME command (type + target).
const EVENT_TYPES = {
  add_item: "item_added", update_item: "item_updated", move_item: "item_moved",
  delete_item: "item_deleted", save_component: "component_saved", delete_component: "component_deleted",
  archive_component: "component_archived",
  write_file: "file_written", delete_file: "file_deleted",
};

// The store lives in a FIXED per-user data dir, decoupled from the clone location, so every
// host (Claude Desktop, Claude Code, Codex) and every clone opens the SAME db — components and
// data stay in sync instead of forking one db per install (the #1 cause of "the two hosts don't
// see each other's apps"). OMA_DB overrides for tests / isolated stores; an explicit `path` arg
// wins over everything (the smoke tests pass one).
export function defaultDbDir() {
  const h = homedir();
  if (platform() === "darwin") return join(h, "Library", "Application Support", "open-mcp-apps");
  if (platform() === "win32") return join(process.env.APPDATA || join(h, "AppData", "Roaming"), "open-mcp-apps");
  return join(process.env.XDG_DATA_HOME || join(h, ".local", "share"), "open-mcp-apps");
}
export function defaultDbPath() { return join(defaultDbDir(), "open-mcp-apps.db"); }

export function openStore(path) {
  const dbPath = path || process.env.OMA_DB || defaultDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");   // N hosts share ONE db → wait out a busy writer instead of throwing SQLITE_BUSY
  db.exec(SCHEMA);
  // The server-held delta watermark is gone: it was keyed by (collection, host) and hostName turned
  // out to be unstable (one claude.ai user presents three clientInfo names — measured), on top of
  // being shared across conversations. The mark lives with the CALLER now (data_changes since /
  // next_since). The table described itself as rebuildable side state holding no truth, which is
  // exactly what makes dropping it in place safe — no version bump, nothing to migrate.
  db.exec("DROP TABLE IF EXISTS report_watermark");
  // Additive migrations: SQLite has no ADD COLUMN IF NOT EXISTS, so guard by pragma. Every entry is
  // nullable or defaulted, which is what makes it safe to run against a live database — existing
  // rows acquire the default and no reader has to change.
  const addColumn = (table, column, decl) => {
    if (!db.pragma(`table_info(${table})`).some((c) => c.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  };
  addColumn("component", "scene", "TEXT");
  addColumn("component", "manifest", "TEXT");
  addColumn("component", "kind", "TEXT NOT NULL DEFAULT 'app'");
  addColumn("component", "visibility", "TEXT NOT NULL DEFAULT 'listed'");
  addColumn("component", "kit_version", "TEXT");
  addColumn("component", "server_script", "TEXT");
  addColumn("item", "principal", "TEXT");
  addColumn("change_event", "principal", "TEXT");
  // Stamp the migration-format version. 0 = pre-versioned db (same layout as v1) → claim it as v1.
  // A FUTURE-versioned db must not be opened by older code that would write old-shaped events into it.
  const uv = db.pragma("user_version", { simple: true });
  if (uv > SCHEMA_VERSION) throw new Error(`store schema is v${uv}, this build understands up to v${SCHEMA_VERSION} — update open-mcp-apps`);
  else if (uv < SCHEMA_VERSION) {
    // 0 = pre-versioned (same layout as v1) → claim it. 0 < uv < current = a real forward
    // migration. The branch and its registry exist BEFORE the first bump on purpose: the moment a
    // payload shape changes is the worst possible moment to also be inventing the mechanism.
    // One transaction for the whole climb: a migration interrupted halfway must leave the rows AND
    // user_version untouched, or every reopen inherits a half-renumbered store it re-fails on.
    db.transaction(() => {
      for (const step of migrationsBetween(uv, SCHEMA_VERSION)) step(db);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }

  const q = {
    eventByCmd: db.prepare("SELECT seq, event_type, aggregate_id, payload FROM change_event WHERE command_id = ?"),
    seq: db.prepare("SELECT COALESCE(MAX(seq),0) AS v FROM change_event"),
    settingsSeq: db.prepare("SELECT COALESCE(MAX(seq),0) AS v FROM change_event WHERE json_extract(payload,'$.collection') = 'settings'"),
    // Per-COLLECTION high-water mark, served by idx_event_collection. This is the precision the ack
    // needs: a widget holding collection X asks "was the state I have the one this write happened
    // on top of?", and a GLOBAL seq answers no every time an unrelated collection was written —
    // turning every concurrent write anywhere into a spurious refresh here.
    collSeq: db.prepare("SELECT COALESCE(MAX(seq),0) AS v FROM change_event WHERE json_extract(payload,'$.collection') = ?"),
    appendEvent: db.prepare(
      `INSERT INTO change_event (aggregate_id, command_id, event_type, payload, actor, principal, host, ts)
       VALUES (@aggregate_id, @command_id, @event_type, @payload, @actor, @principal, @host, @ts)`),

    // Ledger reads for delta reporting. Ordered seq ASC + LIMIT: the window is the CONTIGUOUS run
    // right after `since`, never a sample with a gap. That ordering is what makes a caller-held mark
    // sound — next_since is the last event you actually saw, and everything you have not seen is
    // still strictly after it. (The old shape served the NEWEST window and skipped the middle; a
    // mark advanced over a skipped event lost it forever — read-plane audit D4.)
    changesSince: db.prepare(
      `SELECT seq, aggregate_id, event_type, payload, actor, principal, host, ts FROM change_event
       WHERE json_extract(payload, '$.collection') = @c AND seq > @since
       ORDER BY seq ASC LIMIT @n`),
    countChangesSince: db.prepare(
      "SELECT COUNT(*) AS n FROM change_event WHERE json_extract(payload,'$.collection') = @c AND seq > @since"),

    itemById: db.prepare("SELECT * FROM item WHERE id = ?"),
    itemsByCollection: db.prepare("SELECT * FROM item WHERE collection = ? ORDER BY grp, position, created_at"),
    itemsByCollGrp: db.prepare("SELECT * FROM item WHERE collection = ? AND grp = ? ORDER BY position, created_at"),
    maxPos: db.prepare("SELECT COALESCE(MAX(position),0) AS p FROM item WHERE collection = ? AND grp = ?"),

    // Paged read path (queryItems) — keyset pagination over (grp, position, id), served by
    // idx_item_coll_grp_pos so a page never sorts the whole collection. id is the uniqueness
    // tiebreaker (position collisions are legal).
    countColl: db.prepare("SELECT COUNT(*) AS n FROM item WHERE collection = ?"),
    countCollGrp: db.prepare("SELECT COUNT(*) AS n FROM item WHERE collection = ? AND grp = ?"),
    pageAllFirst: db.prepare("SELECT * FROM item WHERE collection = @c ORDER BY grp, position, id LIMIT @n"),
    pageAllAfter: db.prepare(
      `SELECT * FROM item WHERE collection = @c AND (grp > @g OR (grp = @g AND (position > @p OR (position = @p AND id > @id))))
       ORDER BY grp, position, id LIMIT @n`),
    pageGrpFirst: db.prepare("SELECT * FROM item WHERE collection = @c AND grp = @g ORDER BY position, id LIMIT @n"),
    pageGrpAfter: db.prepare(
      `SELECT * FROM item WHERE collection = @c AND grp = @g AND (position > @p OR (position = @p AND id > @id))
       ORDER BY position, id LIMIT @n`),

    // Manifest lookup: no in-memory cache staleness across N processes sharing one db — the cache
    // key is a cheap aggregate that changes whenever any manifest-bearing component row changes.
    manifestKey: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(version),0) AS sv, COALESCE(MAX(updated_at),'') AS u FROM component WHERE manifest IS NOT NULL"),
    manifestRows: db.prepare("SELECT name, manifest FROM component WHERE manifest IS NOT NULL ORDER BY updated_at ASC, name ASC"),
    // `version` is passed in, never computed here: it is the ledger seq of the event that made this
    // row, so the number has to come from the append. Every write below appends FIRST for that
    // reason — the reverse of the old order, and the one detail this merge lives or dies on.
    insItem: db.prepare(
      `INSERT INTO item (id, collection, grp, position, fields, version, created_at, updated_at)
       VALUES (@id, @collection, @grp, @position, @fields, @version, @ts, @ts)`),
    updFields: db.prepare("UPDATE item SET fields = @fields, version = @version, updated_at = @ts WHERE id = @id"),
    updPlace: db.prepare("UPDATE item SET grp = @grp, position = @position, version = @version, updated_at = @ts WHERE id = @id"),
    delItem: db.prepare("DELETE FROM item WHERE id = @id"),

    collections: db.prepare(
      "SELECT collection, COUNT(*) AS items, MAX(updated_at) AS last_activity FROM item GROUP BY collection ORDER BY last_activity DESC"
    ),
    compByName: db.prepare("SELECT * FROM component WHERE name = ?"),
    // Ownership evidence for deleteDisposition. Manifests are read whole (the registry is small and
    // a manifest is one JSON blob); via is dug out of the event payload because change_event has no
    // via column — it rides inside the payload, by design (the shadow edge is not a schema field).
    allCompManifests: db.prepare("SELECT name, manifest FROM component WHERE manifest IS NOT NULL"),
    viaByCollection: db.prepare(
      `SELECT DISTINCT json_extract(payload, '$.collection') AS collection,
                       json_extract(payload, '$.via.component') AS via
         FROM change_event
        WHERE event_type LIKE 'item_%'
          AND json_extract(payload, '$.via.component') IS NOT NULL
          AND json_extract(payload, '$.collection') IS NOT NULL`),
    countSettingsGroup: db.prepare("SELECT COUNT(*) AS n FROM item WHERE collection = 'settings' AND grp = ?"),
    // "Did this collection exist before this app did?" — the cheap question that separates the
    // app's own rows from rows that were already there when an app of the same name showed up.
    // Both answers come off the ledger, which never goes backwards.
    // ⚠️ THIS ONE ASSUMES THE LEDGER IS COMPLETE, and pruneLedger() can make that false. It drops a
    // collection's OLDEST events, so a collection that predates its app can come out looking newer
    // than it — and cascade would then judge the user's older rows "created for this app". Harmless
    // today and verified so: retention defaults to unbounded, pruneLedger is never automatic, and
    // the only callers in the tree are tests. It stops being harmless the day retention ships, so
    // whoever wires that has to bring an ownership answer that survives a pruned tail (a claim
    // recorded on the ROW, not re-derived from history). Tracked as N9.
    firstCollEvent: db.prepare("SELECT COALESCE(MIN(seq), 0) AS v FROM change_event WHERE json_extract(payload,'$.collection') = ?"),
    // WHERE THIS COMPONENT'S CURRENT LIFE BEGINS — 0 if it has only ever had one.
    //
    // A delete is a tombstone, so the ledger and component_history keep everything the PREVIOUS
    // holder of a name left behind, and a name can be reused. Two destructive decisions were
    // reading those leftovers as if they described the app that bears the name now (see
    // deleteDisposition and componentHistory). Both need the same question answered, so it is
    // asked once, here.
    //
    // "The most recent delete that was FOLLOWED BY a save." The `EXISTS` is what makes the
    // tombstone case come out right: an app that was deleted and never recreated has no save after
    // its final delete, so that delete does not start a new life and the app still owns the life it
    // had — which is exactly the promise `component_history` makes ("history survives delete").
    lifeStart: db.prepare(
      `SELECT COALESCE(MAX(d.seq), 0) AS v
         FROM change_event d
        WHERE d.aggregate_id = ? AND d.event_type = 'component_deleted'
          AND EXISTS (SELECT 1 FROM change_event s
                       WHERE s.aggregate_id = d.aggregate_id
                         AND s.event_type = 'component_saved' AND s.seq > d.seq)`),
    firstCompEvent: db.prepare("SELECT COALESCE(MIN(seq), 0) AS v FROM change_event WHERE aggregate_id = ? AND event_type = 'component_saved' AND seq > ?"),
    histSince: db.prepare("SELECT version, ts, length(html) AS html_size FROM component_history WHERE name = ? AND version > ? ORDER BY version DESC"),
    delSettingsGroup: db.prepare("DELETE FROM item WHERE collection = 'settings' AND grp = @grp"),
    delCollectionRows: db.prepare("DELETE FROM item WHERE collection = @collection"),
    // "Is there a component outside this set?" — EXISTS stops at the first row instead of scanning
    // the registry, and json_each keeps ONE prepared statement for any set, so the store never has
    // to know WHICH components are the engine's own. That stays an engine-level concept.
    hasCompOutside: db.prepare(
      "SELECT EXISTS(SELECT 1 FROM component WHERE name NOT IN (SELECT value FROM json_each(?))) AS v"
    ),
    allComps: db.prepare("SELECT name, version, description, author, json_extract(scene, '$.category_id') AS category_id, CASE WHEN manifest IS NULL THEN 0 ELSE 1 END AS has_manifest, kind, visibility, kit_version, updated_at, length(html) AS html_size FROM component ORDER BY name"),
    insComp: db.prepare(
      `INSERT INTO component (name, version, html, description, author, scene, manifest, kind, visibility, updated_at)
       VALUES (@name, @version, @html, @description, @author, @scene, @manifest,
               COALESCE(@kind, 'app'), COALESCE(@visibility, 'listed'), @ts)
       ON CONFLICT(name) DO UPDATE SET version = @version, html = @html,
         description = CASE WHEN @description = '' THEN component.description ELSE @description END,
         author = @author,
         scene = CASE WHEN @scene_set = 1 THEN @scene ELSE component.scene END,
         manifest = CASE WHEN @manifest_set = 1 THEN @manifest ELSE component.manifest END,
         -- three-state, like scene/manifest: absent keeps what is there, present replaces it. A
         -- plain re-save must never silently reset a component's kind or visibility.
         kind = COALESCE(@kind, component.kind),
         visibility = COALESCE(@visibility, component.visibility),
         updated_at = @ts`),
    insCompHist: db.prepare("INSERT OR REPLACE INTO component_history (name, version, html, ts) VALUES (@name, @version, @html, @ts)"),
    compHist: db.prepare("SELECT version, ts, length(html) AS html_size FROM component_history WHERE name = ? ORDER BY version DESC"),
    compVersion: db.prepare("SELECT name, version, html, ts FROM component_history WHERE name = ? AND version = ?"),
    delComp: db.prepare("DELETE FROM component WHERE name = ?"),
    setCompVisibility: db.prepare("UPDATE component SET visibility = @visibility, version = @version, updated_at = @ts WHERE name = @name"),

    // File plane — ref index only (bytes are the backend's job). All reads are component-scoped.
    fileByKey: db.prepare("SELECT * FROM file WHERE component = ? AND path = ?"),
    filesByComponent: db.prepare("SELECT component, path, sha256, size, mime, version, backend, created_at, updated_at FROM file WHERE component = ? ORDER BY path"),
    fileUsageStmt: db.prepare("SELECT COALESCE(SUM(size),0) AS bytes, COUNT(*) AS count FROM file WHERE component = ?"),
    fileUsageTotalStmt: db.prepare("SELECT COALESCE(SUM(size),0) AS bytes, COUNT(*) AS count FROM file"),
    blobRefcountStmt: db.prepare("SELECT COUNT(*) AS n FROM file WHERE component = ? AND sha256 = ?"),
    filesSeq: db.prepare("SELECT COALESCE(MAX(seq),0) AS v FROM change_event WHERE event_type = 'file_written' OR event_type = 'file_deleted'"),
    insFile: db.prepare(
      `INSERT INTO file (component, path, sha256, size, mime, version, backend, created_at, updated_at)
       VALUES (@component, @path, @sha256, @size, @mime, @version, @backend, @ts, @ts)
       ON CONFLICT(component, path) DO UPDATE SET sha256 = @sha256, size = @size, mime = @mime,
         version = @version, backend = @backend, updated_at = @ts`),
    delFile: db.prepare("DELETE FROM file WHERE component = @component AND path = @path"),

    // Undo/retention reads. lastEventFor is served by the PK index on seq (DESC scan, LIMIT 1).
    lastEventFor: db.prepare("SELECT seq, aggregate_id, event_type, payload FROM change_event WHERE aggregate_id = ? ORDER BY seq DESC LIMIT 1"),
    // Data-pane ledger window (newest first) — the internal read that keeps `via`.
    recentEventsAll: db.prepare("SELECT seq, event_type, aggregate_id, actor, principal, host, ts, payload FROM change_event ORDER BY seq DESC LIMIT @n"),
    recentEventsColl: db.prepare("SELECT seq, event_type, aggregate_id, actor, principal, host, ts, payload FROM change_event WHERE json_extract(payload,'$.collection') = @c ORDER BY seq DESC LIMIT @n"),
    compHistory: db.prepare("SELECT version, html FROM component_history WHERE name = ? ORDER BY version DESC"),
    settingByKey: db.prepare("SELECT fields FROM item WHERE collection = 'settings' AND json_extract(fields,'$.key') = ?"),
    // Keep the newest @keep events of a collection; delete what is older. Written as a NOT IN over
    // the kept window rather than an OFFSET delete so it is one statement and one plan.
    pruneColl: db.prepare(`DELETE FROM change_event WHERE json_extract(payload,'$.collection') = @c
      AND seq NOT IN (SELECT seq FROM change_event WHERE json_extract(payload,'$.collection') = @c ORDER BY seq DESC LIMIT @keep)`),
    // The mark pruning leaves behind, and the one read that consumes it. MAX() so a second prune
    // can only ever move the boundary FORWARD — a truncation is not undone by a later, smaller one.
    markTruncated: db.prepare(`INSERT INTO ledger_truncation (collection, before_seq, ts)
      VALUES (@c, @seq, @ts)
      ON CONFLICT(collection) DO UPDATE SET before_seq = MAX(before_seq, @seq), ts = @ts`),
    truncatedAt: db.prepare("SELECT before_seq AS v FROM ledger_truncation WHERE collection = ?"),
    oldestCollEvent: db.prepare("SELECT COALESCE(MIN(seq),0) AS v FROM change_event WHERE json_extract(payload,'$.collection') = ?"),
  };

  const rowToItem = (r) => ({
    id: r.id, group: r.grp, position: r.position,
    fields: JSON.parse(r.fields), version: r.version,
  });

  // collection → { components, spec } from declared manifests. Cached, but the cache key is a
  // per-call aggregate query so N processes sharing this db never validate against stale rules.
  //
  // Collections are SHARED substrate: N components may steward the same one (a parent embedding a
  // child that reads it, an app exposing a function another app calls, several views of one dataset).
  // So declarations UNION rather than overwrite: the field set is the union, a key declared twice
  // resolves to the LAST declaration in updated_at order (deterministic) and is reported in
  // `conflicts`, and `strict` holds only if EVERY declarer asked for it — one component tightening
  // its own view must not start rejecting a sibling's writes. `components` lists every declarer, so
  // a violation names the whole contract, not whichever row happened to be saved last.
  let mCacheKey = null, mMap = null;
  function manifestFor(collection) {
    const k = q.manifestKey.get();
    const key = `${k.n}:${k.sv}:${k.u}`;
    if (key !== mCacheKey) {
      mMap = new Map();
      for (const r of q.manifestRows.all()) {
        let m; try { m = JSON.parse(r.manifest); } catch { continue; }
        if (!m || typeof m !== "object" || !m.collections || typeof m.collections !== "object") continue;
        for (const [coll, spec] of Object.entries(m.collections)) {
          if (!spec || typeof spec !== "object") continue;
          const prev = mMap.get(coll);
          if (!prev) {
            mMap.set(coll, { components: [r.name], spec: { ...spec }, conflicts: [] });
            continue;
          }
          prev.components.push(r.name);
          if (spec.fields) {
            const merged = prev.spec.fields ? { ...prev.spec.fields } : {};
            for (const [fname, f] of Object.entries(spec.fields)) {
              if (fname in merged) prev.conflicts.push(`${fname} (redeclared by ${r.name})`);
              merged[fname] = f;   // later declaration wins
            }
            prev.spec.fields = merged;
          }
          // strict = conjunction; label_field = last non-empty declaration
          prev.spec.strict = Boolean(prev.spec.strict) && Boolean(spec.strict);
          if (spec.label_field) prev.spec.label_field = spec.label_field;
        }
      }
      mCacheKey = key;
    }
    return mMap.get(collection) || null;
  }

  // Read transaction, same doctrine as aggregate(): the version stamped on a snapshot and the rows
  // beside it must describe ONE instant, or a write landing between two statements hands out a
  // torn read (the cross-process tear the redesign charter recorded).
  const snapshot = db.transaction((collection) => ({
    collection,
    items: q.itemsByCollection.all(collection).map(rowToItem),
    version: q.seq.get().v,
    settings_version: q.settingsSeq.get().v,
    files_version: q.filesSeq.get().v,
  }));

  /** Aggregate over a collection WITHOUT sending the rows anywhere.
   *
   *  This exists because of a measurement, not a hunch: asked for a per-category total, two
   *  different models on two different hosts each pulled the rows into their context, copied them
   *  out into a sandbox file, and ran python — roughly 145,000 tokens and four minutes apiece, with
   *  a transcription step in the middle that could silently mis-copy a number. They were right to
   *  outsource the arithmetic; they just had no server-side place to outsource it TO.
   *
   *  So the answer travels instead of the data, and it travels with its own audit trail: `matched`
   *  says how many rows went into the number, which is the one fact that makes an aggregate checkable
   *  by the reader rather than trusted blindly.
   */
  function aggregate(collection, { group, match, group_by, metrics } = {}) {
    const coll = String(collection);
    const grp = group != null ? String(group) : null;
    const wantMatch = match && typeof match === "object" && !Array.isArray(match) && Object.keys(match).length ? match : null;
    if (wantMatch) { const bad = unknownOps(wantMatch); if (bad.length) return { error: "unknown_operator", detail: bad.join(", ") }; }
    const specs = Array.isArray(metrics) && metrics.length ? metrics : [{ op: "count" }];
    for (const m of specs) {
      if (!["count", "sum", "min", "max", "avg"].includes(m.op)) return { error: "unknown_metric", detail: String(m.op) };
      if (m.op !== "count" && !m.field) return { error: "metric_needs_field", detail: m.op };
    }

    const buckets = new Map();
    let scanned = 0, matched = 0;
    // Read transaction, so a bucket count and the `matched` total describe the SAME instant. Without
    // it a concurrent write lands between two statements and the audit number stops adding up.
    const walk = db.transaction(() => {
      for (const row of (grp != null ? q.itemsByCollGrp.all(coll, grp) : q.itemsByCollection.all(coll))) {
        scanned++;
        const fields = JSON.parse(row.fields);
        if (wantMatch && !itemMatches(fields, wantMatch)) continue;
        matched++;
        const key = group_by ? String(fields[group_by] ?? "") : "";
        let b = buckets.get(key);
        if (!b) { b = { key, n: 0, acc: specs.map(() => ({ n: 0, sum: 0, min: null, max: null })) }; buckets.set(key, b); }
        b.n++;
        specs.forEach((m, i) => {
          const a = b.acc[i];
          if (m.op === "count") { a.n++; return; }
          const v = asNumExport(fields[m.field]);
          if (v == null) return;                       // a non-numeric value is not counted, and `n` says so
          a.n++; a.sum += v;
          a.min = a.min == null ? v : Math.min(a.min, v);
          a.max = a.max == null ? v : Math.max(a.max, v);
        });
      }
    });
    walk();

    const shape = (b) => {
      const out = { ...(group_by ? { [group_by]: b.key } : {}), count: b.n };
      specs.forEach((m, i) => {
        const a = b.acc[i];
        if (m.op === "count") return;
        const name = `${m.op}_${m.field}`;
        out[name] = m.op === "sum" ? a.sum : m.op === "avg" ? (a.n ? a.sum / a.n : null) : m.op === "min" ? a.min : a.max;
        // How many rows actually carried a number for this metric. A sum over 3 of 40 rows is a
        // different fact from a sum over 40, and only this number tells them apart.
        if (a.n !== b.n) out[`${name}_from`] = a.n;
      });
      return out;
    };
    const rows = [...buckets.values()].map(shape);
    // Biggest bucket first: a grouped answer is nearly always read as a ranking.
    rows.sort((x, y) => y.count - x.count);
    return { collection: coll, ...(grp != null ? { group: grp } : {}), scanned, matched, groups: rows };
  }

  // Validate a command's `via` stamp into the frozen object form, or drop it. Component names
  // follow the registry rule; `function` (write-set F's second key) is carried when present so
  // the shape never has to change again once function writes start stamping it.
  const VIA_COMPONENT_RE = /^[a-z][a-z0-9-]{0,31}$/;
  const viaOf = (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const component = String(v.component ?? "");
    if (!VIA_COMPONENT_RE.test(component)) return undefined;
    const fn = v.function != null ? String(v.function).slice(0, 64) : null;
    return fn ? { component, function: fn } : { component };
  };

  function core(command, privileged) {
    const { type, command_id, actor = "agent", host = null, principal = null } = command;
    // `actor` means two different things, and only one of them is a closed set.
    //   · on a DATA write it is the class that wrote (E13b) — closed, so an anonymous write can
    //     never land labelled "human" and become permanently unattributable in the ledger;
    //   · on save_component it becomes the component's `author`, which tierOf() reads as
    //     PROVENANCE — an unrecognised author is precisely how a third-party component earns the
    //     'unreviewed' tier. Closing that set would make every component local-tier by
    //     construction and quietly delete the trust model.
    // Fail loudly on the first, stay open on the second.
    if (!AUTHORSHIP_COMMANDS.has(type) && !ACTORS.has(actor)) return { ok: false, error: "unknown_actor" };
    if (!command_id) throw new Error("command_id required (idempotency key)");

    const seen = q.eventByCmd.get(command_id);
    const collection = command.collection ?? (command.id ? q.itemById.get(command.id)?.collection : undefined);
    if (seen) {
      // A replay only short-circuits for the SAME command: the prior event must match this
      // command's type and — when the command names a target — its aggregate. A recycled
      // command_id on a DIFFERENT command must not false-succeed ("already deleted" while
      // doing nothing); it errs instead (UNIQUE(command_id) makes proceeding impossible).
      const COMPONENT_CMDS = type === "save_component" || type === "delete_component" || type === "archive_component";
      const target = COMPONENT_CMDS
        ? String(command.name || "").trim()
        : type === "write_file" || type === "delete_file"
        ? String(command.component || "") + "/" + String(command.path || "")
        : command.id; // add_item without an explicit id has no verifiable target → type-only
      if (seen.event_type === EVENT_TYPES[type] && (target == null || seen.aggregate_id === target)) {
        // The replay's receipt is the ORIGINAL receipt, recovered from the ledger row that made the
        // command idempotent. A retry fires precisely when the first response was lost — which is
        // when the receipt matters most — so a bare {ok} here would defeat the retry it exists for.
        // (The pre-envelope shape returned a whole collection snapshot; the tool layer dropped it
        // and the model read "Already added item undefined".)
        let payload = {};
        try { payload = JSON.parse(seen.payload) || {}; } catch {}
        const out = { ok: true, idempotent: true, event_type: seen.event_type, seq: seen.seq };
        if (COMPONENT_CMDS) {
          out.name = seen.aggregate_id;
          if (type !== "delete_component") out.version = seen.seq;
          // WHICH delete this was. `delete_component` has two dispositions and only one of them is
          // irreversible, so "yes, that command ran" is not a sufficient answer to a retry: a
          // command_id previously used for a KEEP delete answered yes to a cascade retry, and the
          // caller was told its irreversible act had completed while every row was still on disk.
          // The original payload already records it — a cascade stamps `cascaded`, a keep does not.
          if (type === "delete_component" && payload.cascaded) out.cascaded = payload.cascaded;
          // The ORIGINAL flip's outcome, not the current column — an archive replayed after a later
          // unarchive must describe what the archive did, or the retry reads current state as its own.
          if (type === "archive_component" && payload.to) out.visibility = payload.to;
        } else if (type === "write_file" || type === "delete_file") {
          out.component = String(command.component || "");
          out.path = String(command.path || "");
        } else {
          out.id = seen.aggregate_id;
          const coll = payload.collection ?? collection;
          if (coll) out.collection = coll;
          if (type === "delete_item") out.deleted = true;
          else { const row = q.itemById.get(seen.aggregate_id); if (row) out.item = rowToItem(row); }
        }
        return out;
      }
      return { ok: false, error: "command_id_reused" };
    }

    const ts = new Date().toISOString();
    // The shadow `via` edge (write-set D, row #8 — object form frozen with this first stamp):
    // advisory provenance the runtime/runner stamps on WIDGET writes, {component[, function]}.
    // Same trust class as `actor` (caller-chosen, forgeable); consumed ONLY by the Data pane's
    // internal read (recentEvents) — changesSince strips it from every AI-facing event, and it
    // never enters export/publish closures. Invalid shapes are DROPPED, never refused: a write
    // must not fail over its shadow. Item writes only; every other command ignores it.
    const via = viaOf(command.via);
    // Every ledger payload carries `sv` (SCHEMA_VERSION) — the migration-format pin export/import
    // and SaaS sync key off. `collection`-derived indexes are unaffected (sv is a sibling key).
    // `emit` returns the pair a write's receipt is built from: the collection's mark BEFORE this
    // event and the seq OF it. A holder of `prev` had the state this write was applied to, and can
    // apply the row locally; anyone else has to re-read. Captured here, inside the command's single
    // transaction, because asking afterwards would race the next writer.
    //
    // `extraId` exists for the one command that legitimately produces MORE THAN ONE event: a
    // cascading delete has to leave a receipt in each collection it cleared, and
    // change_event.command_id is UNIQUE, so the extra rows need ids of their own.
    //
    // They used to be DERIVED from the command's — `${command_id}#rows:${coll}` — on the reasoning
    // that a derived id is as idempotent as the command it came from. True, and beside the point:
    // command_id is a CALLER-SUPPLIED string, so the derived space is one the caller may already
    // occupy. A prior write whose id happened to have that exact shape made the whole cascade die
    // on a UNIQUE violation — a destructive tool taken out by a stranger's earlier choice of name.
    //
    // The idempotence was never load-bearing here: a replay short-circuits at the command level and
    // never reaches this function, so these receipts are emitted exactly once per real execution.
    // An opaque id therefore costs nothing and removes the shared namespace entirely.
    const emit = (aggregate_id, event_type, payload, extraReceipt) => {
      const prev = payload.collection != null ? q.collSeq.get(payload.collection).v : q.seq.get().v;
      const info = q.appendEvent.run({ aggregate_id, command_id: extraReceipt ? randomUUID() : command_id, event_type, payload: JSON.stringify({ ...payload, sv: SCHEMA_VERSION }), actor, principal, host, ts });
      return { seq: Number(info.lastInsertRowid), prev_collection_seq: prev };
    };

    if (type === "add_item") {
      const coll = String(command.collection || "").trim();
      if (!coll) return { ok: false, error: "collection_required" };
      const grp = String(command.group ?? "");
      if (grp.length > MAX_GROUP_CHARS) return { ok: false, error: "group_too_long", limit: MAX_GROUP_CHARS };
      const fields = command.fields && typeof command.fields === "object" ? command.fields : {};
      if (coll === SETTINGS_COLLECTION && !privileged && RESERVED_KEY_RE.test(String(fields.key ?? "")))
        return { ok: false, error: "reserved_key" };
      const fieldsJson = JSON.stringify(fields);
      if (fieldsJson.length > MAX_ITEM_FIELDS_BYTES) return { ok: false, error: "fields_too_large" };
      const man = manifestFor(coll);
      if (man) {
        const violations = fieldViolations(man.spec, fields);
        if (violations.length) return { ok: false, error: "schema_violation", violations, collection: coll, manifest_component: man.components.join(", ") };
      }
      const id = command.id || randomUUID();
      const position = command.position ?? q.maxPos.get(coll, grp).p + 1;
      // Append FIRST: the row's version IS this event's seq, so the number cannot exist before the
      // append does. (One transaction, so a reader never sees the event without the row.)
      const m = emit(id, "item_added", { collection: coll, group: grp, position, fields, ...(via ? { via } : {}) });
      q.insItem.run({ id, collection: coll, grp, position, fields: fieldsJson, version: m.seq, ts });
      // A write's receipt is the row it wrote, never the collection it landed in. The caller has
      // the collection already; re-sending it is the cost that scaled with the data instead of
      // with the action (measured: 1,711 tk -> 33 tk on a 500-item collection).
      return { ok: true, id, collection: coll, ...m, item: rowToItem(q.itemById.get(id)) };
    }

    if (type === "update_item") {
      const row = q.itemById.get(command.id);
      if (!row) return { ok: false, error: "not_found" };
      // The CURRENT row, not the collection: it is what the retry needs, and it is one row whether
      // the collection holds three items or thirty thousand.
      if (command.expected_version != null && command.expected_version !== row.version)
        return { ok: false, conflict: true, expected: row.version, id: row.id, collection: row.collection, item: rowToItem(row) };
      if (row.collection === SETTINGS_COLLECTION && !privileged) {
        const existingKey = String(JSON.parse(row.fields).key ?? "");
        const newKey = command.fields && "key" in command.fields ? String(command.fields.key ?? "") : "";
        if (RESERVED_KEY_RE.test(existingKey) || RESERVED_KEY_RE.test(newKey))
          return { ok: false, error: "reserved_key" };
      }
      const merged = { ...JSON.parse(row.fields), ...(command.fields || {}) };
      for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k]; // null deletes a key
      const mergedJson = JSON.stringify(merged);
      if (mergedJson.length > MAX_ITEM_FIELDS_BYTES) return { ok: false, error: "fields_too_large" };
      const man = manifestFor(row.collection);
      if (man) {
        // DELTA validation: judge the post-merge state, but only reject violations this update
        // INTRODUCES. A manifest added (or tightened) after items exist must not strand the
        // legacy rows — they stay editable, they just can never get WORSE against the contract.
        const before = new Set(fieldViolations(man.spec, JSON.parse(row.fields)));
        const violations = fieldViolations(man.spec, merged).filter((v) => !before.has(v));
        if (violations.length) return { ok: false, error: "schema_violation", violations, id: row.id, collection: row.collection, item: rowToItem(row), manifest_component: man.components.join(", ") };
      }
      // PRE-IMAGE: the previous value of exactly the keys this write touches. It is what makes undo
      // possible at all — without it the ledger records that something changed and not what it was,
      // so "put it back" has no source. Scoped to the touched keys on purpose: storing the whole row
      // on every edit would make the ledger grow with the DATA rather than with the history, and the
      // untouched keys are already recoverable from the row.
      const before = JSON.parse(row.fields);
      const was = {};
      for (const k of Object.keys(command.fields || {})) was[k] = before[k] ?? null;
      const m = emit(row.id, "item_updated", { collection: row.collection, fields: command.fields, was, ...(via ? { via } : {}) });
      q.updFields.run({ id: row.id, fields: mergedJson, version: m.seq, ts });
      return { ok: true, id: row.id, collection: row.collection, ...m, item: rowToItem(q.itemById.get(row.id)) };
    }

    if (type === "move_item") {
      const row = q.itemById.get(command.id);
      if (!row) return { ok: false, error: "not_found" };
      // The CURRENT row, not the collection: it is what the retry needs, and it is one row whether
      // the collection holds three items or thirty thousand.
      if (command.expected_version != null && command.expected_version !== row.version)
        return { ok: false, conflict: true, expected: row.version, id: row.id, collection: row.collection, item: rowToItem(row) };
      const grp = command.group != null ? String(command.group) : row.grp;
      if (command.group != null && grp.length > MAX_GROUP_CHARS) return { ok: false, error: "group_too_long", limit: MAX_GROUP_CHARS };
      const position = command.position ?? q.maxPos.get(row.collection, grp).p + 1;
      // `from_position` is the pre-image half of `position`: without it an undo can only put the
      // item back at the END of its old group, which is a different place than where it left.
      const m = emit(row.id, "item_moved", { collection: row.collection, from: row.grp, from_position: row.position, to: grp, position, ...(via ? { via } : {}) });
      q.updPlace.run({ id: row.id, grp, position, version: m.seq, ts });
      return { ok: true, id: row.id, collection: row.collection, ...m, item: rowToItem(q.itemById.get(row.id)) };
    }

    if (type === "delete_item") {
      const row = q.itemById.get(command.id);
      if (!row) return { ok: false, error: "not_found" };
      // The CURRENT row, not the collection: it is what the retry needs, and it is one row whether
      // the collection holds three items or thirty thousand.
      if (command.expected_version != null && command.expected_version !== row.version)
        return { ok: false, conflict: true, expected: row.version, id: row.id, collection: row.collection, item: rowToItem(row) };
      if (row.collection === SETTINGS_COLLECTION && !privileged && RESERVED_KEY_RE.test(String(JSON.parse(row.fields).key ?? "")))
        return { ok: false, error: "reserved_key" };
      q.delItem.run({ id: row.id });
      // On a delete the WHOLE row is the pre-image: nothing else survives to reconstruct it from.
      const m = emit(row.id, "item_deleted", { collection: row.collection, was: JSON.parse(row.fields), group: row.grp, position: row.position, ...(via ? { via } : {}) });
      // No `item`: it is gone. The id is what the caller needs to drop it locally.
      return { ok: true, id: row.id, collection: row.collection, ...m, deleted: true };
    }

    if (type === "save_component") {
      const name = String(command.name || "").trim();
      if (!COMPONENT_NAME_RE.test(name)) return { ok: false, error: "bad_name" };
      const html = String(command.html || "");
      // Every atom has a face. `empty_html` is a VALIDITY rule, not a size floor: an app is
      // something a person opens, so a component with nothing to render is malformed — while a
      // 1-char component is merely small, and small is reversible. The old 50-char floor caught
      // neither case honestly (a 74-char stub sailed through it); the real defence against a stub
      // overwriting a live component is that every save is recoverable (history + undo) and the
      // ack reports its size delta out loud. There is no exemption and no flag: "code with no UI"
      // is what a plain sandbox already does, and a plain sandbox is not this product.
      if (!html.trim()) return { ok: false, error: "empty_html" };
      if (html.length > MAX_COMPONENT_HTML) return { ok: false, error: "html_too_large" };
      // OCC before any declaration work: the conflict answer carries the version it actually found,
      // which is everything a retry needs. Same contract as an item write — one vocabulary.
      const existing = q.compByName.get(name);
      // Fail CLOSED against a missing row too: the token said "on top of vN" and the row is gone —
      // recreating would resurrect a deletion behind the caller's back. Deletion is recoverable
      // (history + undo), so a conflict here loses nothing and protects intent.
      if (command.expected_version != null && !existing)
        return { ok: false, conflict: true, expected: null, deleted: true, name };
      if (command.expected_version != null && existing && existing.version !== command.expected_version)
        return { ok: false, conflict: true, expected: existing.version, name, size: existing.html.length };
      // PROVENANCE IS NOT OVERWRITABLE. The row's `author` column is what tierOf() reads to decide
      // whether a component runs DIRECT with the AI's own trust or behind the sandboxed runner, and
      // the insert below stamps it from this command's actor. Without this line a save on top of an
      // existing row silently RE-STAMPS provenance — measured: a component stored by "guest"
      // (tier unreviewed, call_tools []) became author "agent" (tier local, call_tools ["*"]) after
      // one save_component carrying the right expected_version. Full escalation, one call.
      //
      // It sits HERE, in the store, because six paths write component html and every one of them
      // would need its own copy of the check otherwise: save_component, edit_component,
      // restore_component, the render-health auto-revert, install_from_library, and undo — the last
      // one from inside this file. install_from_library already carries the tool-level twin of this
      // rule ("already exists as a %s-authored app"); this is the wall the other five were missing.
      //
      // The rule is SYMMETRIC (tier must not change), not just anti-escalation: a demotion cannot
      // grant capability, but it is still one actor rewriting another's provenance, and one sentence
      // is cheaper to hold than a direction. Consequence to know when a third-party ingress lands:
      // a non-local component is managed by the path that installed it — the AI cannot edit it, and
      // undo/restore/auto-revert (all local actors) will not touch it either. Renaming or deleting
      // it stays available, and a same-tier ingress can overwrite it normally.
      if (existing && tierOf(existing.author) !== tierOf(actor))
        return { ok: false, error: "provenance_locked", name, author: existing.author, tier: tierOf(existing.author) };
      // ── the declaration face ───────────────────────────────────────────────────────────────────
      // Read from the DOCUMENT, here, in the command handler — not in the tool. Four paths write
      // html without ever touching the save_component tool (restore_component, the render-health
      // auto-revert, install_from_library, and later edit_component); extracting anywhere else
      // would let those paths leave the materialised column describing a source that no longer
      // exists, which is exactly the decoupling this design removes.
      const decl = readDeclaration(html);
      let manifestSet = 0, manifestJson = null, sceneSet = 0, scene = null, declNote = null;
      let kind = null;
      if (decl.state === "bad") {
        // Tiered ON PURPOSE. An author who wrote a broken declaration must hear about it loudly —
        // silence here means "I declared something and nothing happened", the worst outcome. But a
        // REPLAY (rollback, auto-revert, library install) is a rescue path: the render-health revert
        // is the only thing standing between a user and a permanently broken component, so it must
        // not be blockable by the content of the html it is trying to restore. Salvage there:
        // clear the declaration, keep the rescue, and say so.
        if ((command.declaration_policy || "strict") === "strict")
          return { ok: false, error: decl.error, detail: decl.detail };
        // Clearing means ALL of it: the projections (scene, kind) must not outlive the declaration
        // they project, or the Library keeps filing a document that no longer says anything.
        manifestSet = 1; sceneSet = 1; kind = "app";
        declNote = `The restored document's declaration could not be read (${decl.error}) — it was cleared (scene and kind reset too). The html was restored anyway.`;
      } else if (decl.state === "present") {
        const err = manifestShapeError(decl.value);
        if (err) {
          if ((command.declaration_policy || "strict") === "strict") return { ok: false, error: "bad_manifest", detail: err };
          manifestSet = 1; sceneSet = 1; kind = "app";
          declNote = `The restored document's declaration was not valid (${err}) — it was cleared (scene and kind reset too).`;
        } else {
          manifestSet = 1;
          manifestJson = JSON.stringify(decl.value);
          // `scene` and `kind` live in the declaration but keep their own columns: the Library reads
          // scene, list_components filters on kind, and neither should have to parse JSON to do it.
          // The column is a projection of the declaration, never a second source for it.
          if (decl.value.scene !== undefined) { sceneSet = 1; scene = decl.value.scene && typeof decl.value.scene === "object" ? JSON.stringify(decl.value.scene) : null; }
          if (decl.value.kind !== undefined) kind = String(decl.value.kind);
        }
      } else if (decl.state === "empty") {
        // An empty block ("" or {}) is a statement, not an omission: clear what was declared —
        // the column, the scene filing, and kind back to its default. Leaving any projection
        // behind would have the Library describing a declaration that no longer exists.
        manifestSet = 1; sceneSet = 1; kind = "app";
      } else {
        // absent: the document says nothing about its declaration, so we say nothing either — the
        // stored declaration stays. Callers are told, because "my edit dropped my settings" and
        // "my edit kept settings I deleted from the file" are both surprises worth one sentence.
        if (existing && existing.manifest) declNote = "This document has no #oma-manifest block, so the stored declaration was kept. Add an empty block to clear it.";
      }
      const existed = existing;
      const visibility = command.visibility === undefined ? null : String(command.visibility);
      if (kind !== null && !COMPONENT_KINDS.has(kind)) return { ok: false, error: "unknown_kind" };
      if (visibility !== null && !VISIBILITIES.has(visibility)) return { ok: false, error: "unknown_visibility" };
      // Append first, then stamp the row with this event's seq — same rule as an item write. It also
      // retires the old "continue from the tombstoned history's MAX(version)" dance: version
      // continuity across delete/recreate is now free, because the ledger never goes backwards.
      const m = emit(name, "component_saved", { name, size: html.length, created: !existed });
      const version = m.seq;
      q.insComp.run({ name, version, html, description: String(command.description || ""), author: actor, scene, scene_set: sceneSet, manifest: manifestJson, manifest_set: manifestSet, kind, visibility, ts });
      const comp = q.compByName.get(name);
      q.insCompHist.run({ name, version: comp.version, html, ts });
      const notes = declNote ? [declNote] : [];
      // Declaration-quality notes ride the ack and are computed AFTER the row is written, because
      // both need the saved state: the union a shared collection now resolves to, and whether this
      // label_field names a declared field. Warnings, not rejections — a shared collection stays
      // shared, and a fuzzy label falls back to the heuristic instead of blocking the save.
      if (decl.state === "present" && decl.value.collections && typeof decl.value.collections === "object") {
        for (const [coll, spec] of Object.entries(decl.value.collections)) {
          if (!spec || typeof spec !== "object") continue;
          if (spec.label_field && spec.fields && !(spec.label_field in spec.fields))
            notes.push(`Collection "${coll}": label_field "${spec.label_field}" is not among its declared fields — summaries will fall back to the built-in heuristic.`);
          const man = manifestFor(coll);
          if (man && man.components.length > 1 && man.conflicts.length)
            notes.push(`Collection "${coll}" is declared by ${man.components.join(" and ")} — conflicting key(s): ${man.conflicts.join(", ")}; the most recently saved declaration wins.`);
        }
      }
      // The size pair travels on EVERY save, unconditionally — that is what makes a suspicious
      // shrink (82,623 → 74 chars) announce itself instead of waiting to be asked. Reporting it
      // only past some threshold would put the interesting case behind a guess.
      return { ok: true, name, version: comp.version, created: !existed, size: html.length,
        prev_size: existed ? existed.html.length : null,
        declaration: decl.state, ...(notes.length ? { note: notes.join(" ") } : {}) };
    }

    if (type === "delete_component") {
      const name = String(command.name || "").trim();
      const existed = q.compByName.get(name);
      if (!existed) return { ok: false, error: "not_found" };
      // Two dispositions, and the caller has to have said which (the tool defaults to "keep", i.e.
      // exactly the behaviour that shipped before this existed).
      //
      //   keep    — tombstone semantics: only the registry row goes. component_history rows are
      //             RETAINED (the delete stays auditable, the html recoverable) and so are the
      //             settings items; the settings app's Orphaned section is the janitor.
      //   cascade — "delete means delete" (Leo 2026-07-28). Takes the rows this app is provably
      //             the only user of, plus its own settings group. NOT undoable, and that is not a
      //             gap: component_deleted has no undo branch today either (it falls through to
      //             not_undoable), so this widens what a permanent act removes, it does not make a
      //             reversible act irreversible. Archive is the "keep everything" verb.
      //
      // 🔴 The eligible set is RECOMPUTED here and the caller's list is only used to INTERSECT it.
      // A list that arrives naming a shared collection cannot widen the blast radius — the worst a
      // stale or hostile plan can do is delete less than it claimed.
      const cascade = command.cascade === true;
      const removed = [];
      let settingsRemoved = 0;
      if (cascade) {
        const asked = Array.isArray(command.cascade_collections) ? new Set(command.cascade_collections.map(String)) : null;
        for (const coll of computeDisposition(name).exclusive) {
          if (asked && !asked.has(coll)) continue;
          const n = q.countColl.get(coll).n;
          q.delCollectionRows.run({ collection: coll });
          removed.push({ collection: coll, rows: n });
          // A receipt IN THAT COLLECTION'S STREAM. component_deleted alone was not enough: the
          // per-collection ledger reads filter on payload.collection, so a widget or a
          // data_changes call scoped to this collection was told "nothing changed" while every
          // row in it had just been destroyed. One event per cleared collection keeps the cascade
          // one decision while making each collection's own history tell the truth.
          if (n) emit(coll, "rows_cleared", { collection: coll, rows: n, component: name }, true);
        }
        settingsRemoved = q.countSettingsGroup.get(name).n;
        if (settingsRemoved) {
          q.delSettingsGroup.run({ grp: name });
          // Same for the settings collection — and this one also has to land, because
          // settings_version is derived from events carrying collection:"settings".
          emit(SETTINGS_COLLECTION, "rows_cleared", { collection: SETTINGS_COLLECTION, group: name, rows: settingsRemoved, component: name }, true);
        }
      }
      q.delComp.run(name);
      // ONE event for the whole act — the ledger's aggregate_id has always been documented as
      // "item id | component name | collection name", and a cascade is one decision, not N.
      // What it took is IN the payload, so the audit trail can answer "where did those rows go".
      emit(name, "component_deleted", { name, version: existed.version,
        ...(cascade ? { cascaded: { collections: removed, settings_keys: settingsRemoved } } : {}) });
      return { ok: true, name, version: existed.version,
        ...(cascade ? { cascaded: removed, settings_keys: settingsRemoved } : {}) };
    }

    if (type === "archive_component") {
      // A lifecycle FLIP, not a save: no new html, no history row — but it is still a mutation, so
      // it is still an event, and the row's version still becomes that event's seq (one axis, no
      // exceptions). The public verb is archived:true|false; `visibility` is the internal override
      // the undo path uses to restore a value the flip cannot spell (featured, unlisted) — the tool
      // schema never declares it, so an outside caller cannot reach it.
      const name = String(command.name || "").trim();
      const existed = q.compByName.get(name);
      if (!existed) return { ok: false, error: "not_found" };
      const to = command.visibility != null ? String(command.visibility)
        : command.archived ? "archived" : "listed";
      if (!VISIBILITIES.has(to)) return { ok: false, error: "unknown_visibility" };
      if (existed.visibility === to)
        return { ok: true, name, visibility: to, version: existed.version, unchanged: true };
      const m = emit(name, "component_archived", { name, to, was: existed.visibility });
      q.setCompVisibility.run({ name, visibility: to, version: m.seq, ts });
      return { ok: true, name, visibility: to, was: existed.visibility, version: m.seq, seq: m.seq };
    }

    // ---- File plane: bytes are handled by the channel/backend BEFORE this tx; here we only
    // manage the ref index (idempotency + OCC + authoritative in-tx quota + versioning + ledger).
    if (type === "write_file") {
      const component = String(command.component || ""); // NO trim — keep it raw so the stored key, the emitted aggregate_id, the idempotency replay-target, and statFile/listFiles all agree; COMPONENT_NAME_RE rejects whitespace anyway
      const path = String(command.path || "");
      if (!COMPONENT_NAME_RE.test(component)) return { ok: false, error: "bad_component" };
      if (path.includes("..") || !FILE_PATH_RE.test(path)) return { ok: false, error: "bad_path" };
      const sha256 = String(command.sha256 || "");
      if (!/^[0-9a-f]{64}$/.test(sha256)) return { ok: false, error: "bad_sha256" };
      const size = Number(command.size);
      if (!Number.isInteger(size) || size < 0) return { ok: false, error: "bad_size" };
      if (size > MAX_FILE_BYTES) return { ok: false, error: "file_too_large" };
      const mime = String(command.mime || "application/octet-stream").slice(0, 255);
      const backend = String(command.backend || "local");
      const existing = q.fileByKey.get(component, path);
      // OCC must fail closed against a MISSING row too — else a guarded write silently RESURRECTS a file
      // another actor deleted between the caller's read and this write (a lost-delete). expected:0 = "no such version".
      if (command.expected_version != null && (!existing || command.expected_version !== existing.version))
        return { ok: false, conflict: true, expected: existing ? existing.version : 0 };
      // Authoritative in-tx quota, fail-closed, on LOGICAL bytes (dedup cannot bypass).
      const appU = q.fileUsageStmt.get(component);
      const oldSize = existing ? existing.size : 0;
      if (appU.bytes - oldSize + size > MAX_APP_FILE_BYTES) return { ok: false, error: "quota_exceeded" };
      if (appU.count + (existing ? 0 : 1) > MAX_APP_FILE_COUNT) return { ok: false, error: "too_many_files" };
      const totalU = q.fileUsageTotalStmt.get();
      if (totalU.bytes - oldSize + size > MAX_TOTAL_FILE_BYTES) return { ok: false, error: "total_quota_exceeded" };
      if (totalU.count + (existing ? 0 : 1) > MAX_TOTAL_FILE_COUNT) return { ok: false, error: "total_too_many_files" };
      // Same rule as items and components: append first, stamp the row with this event's seq.
      const m = emit(component + "/" + path, "file_written", { component, path, sha256, size, mime });
      q.insFile.run({ component, path, sha256, size, mime, version: m.seq, backend, ts });
      const row = q.fileByKey.get(component, path);
      const meta = { component, path, sha256, size, mime, version: row.version, backend, created_at: row.created_at, updated_at: row.updated_at };
      return { ok: true, meta, created: !existing, freed_sha: existing && existing.sha256 !== sha256 ? existing.sha256 : null };
    }

    if (type === "delete_file") {
      const component = String(command.component || ""); // NO trim (mirror write_file — keys + replay-target agree)
      const path = String(command.path || "");
      const row = q.fileByKey.get(component, path);
      if (!row) return { ok: false, error: "not_found" };
      if (command.expected_version != null && command.expected_version !== row.version)
        return { ok: false, conflict: true, expected: row.version };
      q.delFile.run({ component, path });
      emit(component + "/" + path, "file_deleted", { component, path, sha256: row.sha256, version: row.version });
      return { ok: true, deleted: true, freed_sha: row.sha256 };
    }

    throw new Error(`unknown command type: ${type}`);
  }

  // Keyset-paged, optionally filtered read (the AI's data_list path; widget snapshots stay full).
  // cursor is opaque (base64url of the last row's sort key) and only meaningful for the SAME
  // (collection, group) query it came from. `match` is the MATCH_OPS grammar (bare value = equals,
  // object value = operator set); filtering happens on scanned pages so limit counts MATCHING items.
  // A read transaction for the same reason snapshot has one: `total` and the pages must describe
  // one instant.
  const encCursor = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  const decCursor = (s) => { try { const o = JSON.parse(Buffer.from(String(s), "base64url").toString("utf8")); return o && typeof o === "object" ? o : null; } catch { return null; } };
  const queryItems = db.transaction((collection, { group, match, limit, cursor } = {}) => {
    const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
    // The version trio is stamped INSIDE this transaction: a version fetched by a second call can
    // postdate the rows beside it, and a page claiming a version newer than its rows makes every
    // poller believe it already has what it is missing (torn read, the M2 class at the tool layer).
    const stamp = { version: q.seq.get().v, settings_version: q.settingsSeq.get().v, files_version: q.filesSeq.get().v };
    let after = null;
    if (cursor != null && cursor !== "") { after = decCursor(cursor); if (!after) return { error: "bad_cursor" }; }
    const grp = group != null ? String(group) : null;
    const total = grp != null ? q.countCollGrp.get(collection, grp).n : q.countColl.get(collection).n;
    const wantMatch = match && typeof match === "object" && !Array.isArray(match) && Object.keys(match).length ? match : null;
    // A typo'd operator is a message, not an empty result. {greaterThan: 5} silently matching
    // nothing reads as "you have none" — a wrong ANSWER, where data_query's identical grammar
    // already gives a named error. One grammar, one refusal.
    if (wantMatch) { const bad = unknownOps(wantMatch); if (bad.length) return { error: "unknown_operator", detail: bad.join(", ") }; }
    const items = [];
    const BATCH = 400;
    for (;;) {
      const rows = grp != null
        ? (after ? q.pageGrpAfter.all({ c: collection, g: grp, p: after.p, id: after.id, n: BATCH })
                 : q.pageGrpFirst.all({ c: collection, g: grp, n: BATCH }))
        : (after ? q.pageAllAfter.all({ c: collection, g: after.g ?? "", p: after.p, id: after.id, n: BATCH })
                 : q.pageAllFirst.all({ c: collection, n: BATCH }));
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        after = { g: r.grp, p: r.position, id: r.id };
        if (wantMatch && !itemMatches(JSON.parse(r.fields), wantMatch)) continue;
        items.push(rowToItem(r));
        if (items.length >= lim)
          // Exact-fit peek (measured, redesign §8.1): a full page that ends at the collection's
          // last row used to hand out a cursor whose next page was empty — one paid round trip
          // for nothing. If this batch is the final one and holds no further rows, say so now.
          return { items, total, ...stamp, next_cursor: i === rows.length - 1 && rows.length < BATCH ? null : encCursor(after) };
      }
      if (rows.length < BATCH) return { items, total, ...stamp, next_cursor: null };
    }
  });

  // execute = normal path (reserved-key guard ON). executePrivileged = the out-of-band
  // privilege carrier used by security_set ONLY. Privilege is a SEPARATE entry point, never a
  // command field — an injected {privileged:true} on a data_* call reaches core() as false.
  //
  // Change notifications: `events` emits "change" AFTER the transaction commits (never inside it),
  // carrying the new ledger seq. In-process subscribers (the SSE /events route) get push latency;
  // OTHER processes sharing this db can't hear it — they fall back to seq polling (dataVersion).
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const txExecute = db.transaction((command) => core(command, false));
  const txExecutePrivileged = db.transaction((command) => core(command, true));

  // A read transaction, for exactly the reason queryItems has one: the events, the count and
  // `latest_seq` must describe ONE instant. Unwrapped, another process could commit between the
  // row query and the seq read — the caller would then get a window that does not contain that
  // write next to a latest_seq that is already past it, take the empty-window branch, and advance
  // its mark over a change it never saw. That is a permanent silent loss, not a delayed one:
  // the mark only ever moves forward, so nothing later goes back for it.
  const txChangesSince = db.transaction((collection, since = 0, limit = 50) => {
    const c = String(collection);
    const from = Number(since) || 0;
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    const total = q.countChangesSince.get({ c, since: from }).n;
    // The CONTIGUOUS run right after `since` — never a sample with a gap. That property is the
    // whole caller-held-mark contract: next_since is the last event the caller actually saw, and
    // every event it has not seen is still strictly after it, so nothing can be skipped over.
    const rows = q.changesSince.all({ c, since: from, n });
    return {
      collection: c,
      since: from,
      latest_seq: q.seq.get().v,
      total,
      next_since: rows.length ? rows.at(-1).seq : from,
      dropped: Math.max(0, total - rows.length),
      events: rows.map((r) => {
        const payload = JSON.parse(r.payload);
        // collection is the query, sv is the format pin — and `via` is the shadow edge, which
        // never rides an AI-facing read (row #8: the ledger's attribution stays internal; the
        // Data pane reads it through recentEvents on the /rpc internal path instead).
        const { collection: _c, sv: _sv, via: _via, ...rest } = payload;
        return { seq: r.seq, type: r.event_type, id: r.aggregate_id, actor: r.actor, principal: r.principal ?? undefined, host: r.host, ts: r.ts, ...rest };
      }),
    };
  });
  const notify = (result, command) => {
    if (result && result.ok) {
      try { events.emit("change", { seq: q.seq.get().v, type: command?.type }); } catch {}
    }
    return result;
  };
  const execute = (command) => notify(txExecute(command), command);
  const executePrivileged = (command) => notify(txExecutePrivileged(command), command);

  // N commands, ONE transaction, and a ledger event PER command. The event-per-command part is the
  // load-bearing half: a batch that appended one event for the whole thing would make undo and OCC
  // coarser than the writes they describe — you could no longer put back one row of fifty, and a
  // row's version would stop being the seq of the write that touched it. Cheapness is not worth
  // either. What a batch actually saves is round trips, and round trips are all it saves.
  //
  // All-or-nothing: the first failure rolls the whole thing back, because a half-applied batch is a
  // state no caller asked for and none can describe. The failure says WHICH command failed, so a
  // fifty-row seed that trips on row 31 is one fix away rather than a bisection.
  const txBatch = db.transaction((commands, privileged) => {
    const results = [];
    for (let i = 0; i < commands.length; i++) {
      const r = core(commands[i], privileged);
      if (!r || r.ok !== true) { const e = new Error("batch_failed"); e.index = i; e.result = r; throw e; }
      results.push(r);
    }
    return results;
  });
  // The batch VOCABULARY is the four item commands and nothing else, enforced HERE so every
  // transport hits the same wall. Without this list a batch is a second door to every command
  // core() understands — save_component, write_file, delete_file, … — a parallel command grammar
  // carrying none of the per-tool guards, which is the exact disease test/tool-surface.mjs names.
  // Same wall for arguments: a command carries what the single-write tools publish plus the
  // envelope keys the tool layer derives, never whatever core() happens to read — an unpublished
  // key reaching core() through a batch (principal, declaration_policy, an explicit add id, …)
  // is the same door ajar.
  const BATCH_COMMANDS = ITEM_WRITE_KEYS;
  const BATCH_ENVELOPE = BATCH_ENVELOPE_KEYS;
  const executeBatch = (commands, { privileged = false } = {}) => {
    if (!Array.isArray(commands) || !commands.length) return { ok: false, error: "empty_batch" };
    if (commands.length > MAX_BATCH_COMMANDS) return { ok: false, error: "batch_too_large", limit: MAX_BATCH_COMMANDS, given: commands.length };
    const cleaned = [];
    for (let i = 0; i < commands.length; i++) {
      const c = commands[i] || {};
      const allowed = BATCH_COMMANDS[c.type];
      if (!allowed) return { ok: false, error: "batch_failed", index: i, applied: 0,
        failure: { ok: false, error: "unknown_batch_command", detail: `a batch command's type is one of: ${Object.keys(BATCH_COMMANDS).join(", ")}` } };
      // Same actor set the single-write tools publish (their zod enum), not the ledger's full one:
      // seed/library/anon are write CLASSES other paths mint, and a batch must not mint them.
      if (c.actor != null && c.actor !== "human" && c.actor !== "agent")
        return { ok: false, error: "batch_failed", index: i, applied: 0,
          failure: { ok: false, error: "unknown_actor" } };
      const cmd = { type: c.type };
      for (const k of allowed) if (c[k] !== undefined) cmd[k] = c[k];
      for (const k of BATCH_ENVELOPE) if (c[k] !== undefined) cmd[k] = c[k];
      cleaned.push(cmd);
    }
    let results;
    try { results = txBatch(cleaned, privileged); }
    catch (e) {
      if (e && e.message === "batch_failed") return { ok: false, error: "batch_failed", index: e.index, failure: e.result, applied: 0 };
      throw e;
    }
    notify({ ok: true }, commands[0]);
    return { ok: true, count: results.length, results };
  };

  function computeDisposition(name) {
        const comp = String(name || "").trim();
        // Who ELSE claims a collection by declaring it? (Parsed defensively: a manifest is data.)
        const claimants = new Map();   // collection -> Set(component)
        const claim = (coll, by) => {
          if (!coll) return;
          if (!claimants.has(coll)) claimants.set(coll, new Set());
          claimants.get(coll).add(by);
        };
        for (const row of q.allCompManifests.all()) {
          if (!row.manifest) continue;
          try {
            const cols = JSON.parse(row.manifest).collections;
            if (cols && typeof cols === "object") for (const c of Object.keys(cols)) claim(c, row.name);
          } catch { /* an unparseable manifest claims nothing */ }
        }
        // Who has WRITTEN through a widget? via lives inside the event payload (no column), which is
        // fine at registry scale and is exactly why this is a read and not an index.
        for (const row of q.viaByCollection.all()) claim(row.collection, row.via);

        // Sharing a NAME is not evidence of owning the ROWS. A user whose "notes" collection has
        // been filling for months, who then installs an app called "notes", must not lose those rows
        // because the two are spelled alike — and since the AI writes most rows with no `via`,
        // "nobody else wrote here" is not evidence either. The ledger answers what actually
        // matters: a collection whose first event predates the component's first save was not
        // created for it, whatever it is called.
        //
        // …and "the component's first save" has to mean THIS component's. A name can be reused, and
        // the tombstone keeps the previous holder's events, so an unscoped MIN reached back into a
        // life this app never had: delete the app, let the user write rows into the same-named
        // collection while nothing owned it, recreate an app under that name, and those rows were
        // judged "created after the app" and deleted. Scoping to the current life makes the sentence
        // the user is shown true again — it claims the collection was created FOR THIS APP.
        const life = q.lifeStart.get(comp).v;
        const compBorn = q.firstCompEvent.get(comp, life).v;
        const bornAfterTheApp = (c) => {
          // A TRUNCATED HISTORY CANNOT ANSWER THIS QUESTION, and must say so rather than answer it
          // wrongly. Retention deletes a collection's oldest events — exactly the ones proving it
          // predates the app that shares its name — so after pruning the earliest SURVIVING event
          // can sit after the app's first save while the collection itself is far older. The reading
          // would be "created for this app": provably wrong, and the direction that deletes data.
          // The asymmetry decides it (docs/wo/delete-cascade-design.md): deleting too little leaves
          // rows a user can remove again; deleting too much breaks a second app and the data is gone.
          // So an unaccounted-for gap makes this UNKNOWABLE, and unknowable means kept.
          if (q.truncatedAt.get(c)) return false;
          const collBorn = q.firstCollEvent.get(c).v;
          return compBorn > 0 && collBorn > 0 && collBorn > compBorn;
        };

        const candidates = new Set();
        if (q.countColl.get(comp).n > 0 || q.collections.all().some((c) => c.collection === comp)) candidates.add(comp);
        for (const [coll, who] of claimants) if (who.has(comp)) candidates.add(coll);

        const collections = [];
        for (const coll of [...candidates].sort()) {
          const others = [...(claimants.get(coll) || new Set())].filter((w) => w !== comp).sort();
          const rows = q.countColl.get(coll).n;
          // `seq` is the collection's position on the ledger, and it is here so that CONFIRMING a
          // plan can mean what the two-step promised: "the world still looks like what you were
          // shown". The plan's token is a hash of this list, and a list carrying only a row COUNT
          // pins the wrong thing — delete two rows and add two others between the plan and the
          // confirmation and the token still matched, so cascade destroyed rows that had never
          // appeared in any plan a human read. Between those two calls there is a whole
          // conversational turn, and a widget can write in it. One number closes it, because the
          // ledger never goes backwards: any write to this collection moves it.
          const seq = q.collSeq.get(coll).v;
          if (others.length) {
            collections.push({ collection: coll, verdict: "shared", rows, seq,
              why: `also used by ${others.join(", ")} — kept, so deleting this app cannot break another one` });
          } else if (coll === comp && bornAfterTheApp(coll)) {
            collections.push({ collection: coll, verdict: "exclusive", rows, seq,
              why: "named after this app, created after it, and no other app declares it or has written to it" });
          } else if (coll === comp && q.truncatedAt.get(coll)) {
            // Say WHICH unknowable this is. "Nothing proves it is the only one" would be a wrong
            // explanation here: the evidence existed and was discarded by a retention policy.
            collections.push({ collection: coll, verdict: "unknown", rows, seq,
              why: "named after this app, but this collection's early history has been pruned — whether it predates the app can no longer be established, so it is kept" });
          } else {
            collections.push({ collection: coll, verdict: "unknown", rows, seq,
              why: "this app uses it, but nothing proves it is the only one — kept" });
          }
        }
        return {
          collections,
          settings_keys: q.countSettingsGroup.get(comp).n,
          // The settings collection gets the same treatment: settings_keys is a count too.
          settings_seq: q.collSeq.get(SETTINGS_COLLECTION).v,
          exclusive: collections.filter((c) => c.verdict === "exclusive").map((c) => c.collection),
        };
  }

  return {
    db,
    execute,
    executePrivileged,
    executeBatch,
    events,
    snapshot,
    queryItems,
    aggregate,
    // One cheap read answering "did anything change?" — the adaptive-poll / SSE-fallback probe.
    dataVersion: () => ({ seq: q.seq.get().v, settings_version: q.settingsSeq.get().v, files_version: q.filesSeq.get().v, schema_version: SCHEMA_VERSION }),
    getComponent: (name) => q.compByName.get(name) || null,
    // No arguments = every row, exactly as before: the registry's own consumers (the settings
    // library pane, tool re-registration on boot) want the whole truth. Filtering is the CALLER's
    // choice, and the model-facing tool is the caller that has a default.
    listComponents: ({ kinds, visibilities, name } = {}) => {
      let rows = q.allComps.all();
      if (name) rows = rows.filter((c) => c.name === name);
      if (kinds) rows = rows.filter((c) => kinds.includes(c.kind));
      if (visibilities) rows = rows.filter((c) => visibilities.includes(c.visibility));
      return rows;
    },
    /** Any component whose name is not in `names`. The engine passes its own seeded set and reads
     *  this as "the user has something of their own" — see buildInstructions in engine.mjs. */
    hasComponentOutside: (names) => q.hasCompOutside.get(JSON.stringify([...names])).v === 1,
    /** [{version, ts, html_size, checkpoint}] — never raw html.
     *
     *  `checkpoint` is this component's OWN 1..N counter, derived here and stored nowhere. It
     *  exists because `version` IS the ledger seq (save_component stamps the row with the event's
     *  seq — one ordinal axis, deliberately), and that axis is global: it advances for every write
     *  in the store. A user who edited one app twice sees v5 then v43 and reasonably asks what
     *  happened to the other 38. Nothing did — those were their groceries.
     *
     *  So the number a PERSON reads is the checkpoint; `version` stays exactly as it was for the
     *  machine (it is the OCC token, the restore target, and the history key). Presentation change,
     *  not a renumbering — the axis is load-bearing and stays. */
    componentHistory: (name) => {
      // …and only THIS app's checkpoints. A name can be reused, and a delete keeps everything the
      // previous holder saved, so an unscoped read let "restore checkpoint 1" of a budget tracker
      // hand back a deleted recipe app's source — a silent whole-app swap with nothing on screen to
      // mark the boundary. Rows before this life still sit in the table (the tombstone is intact and
      // was never overwritten); they simply are not this app's to roll back to.
      const rows = q.histSince.all(name, q.lifeStart.get(name).v);
      // newest-first; checkpoint 1 is the oldest save OF THIS LIFE.
      const n = rows.length;
      return rows.map((r, i) => ({ ...r, checkpoint: n - i }));
    },
    getComponentVersion: (name, version) => q.compVersion.get(name, version) || null, // {name, version, html, ts} | null — the ONE path that reads OLD html (for restore/diff)

    listCollections: () => q.collections.all(),

    /** What changed in `collection` after `since`, newest-relevant window first-to-last.
     *
     *  Lossless by construction: every event in the window is returned whole (id, actor, and the
     *  event's own payload), and when the window cannot hold everything the result SAYS SO —
     *  `total` and `dropped` are what let the caller tell the model "412 changes, here are the
     *  most recent 50" instead of handing it a silent sample it would read as the whole story.
     *
     *  `actor` is the product point, not bookkeeping: 'human' events are what the user did in the
     *  widget without the model ever seeing it. */
    changesSince: txChangesSince,


    /** The receipt a prior command with this command_id produced, or null — the READ-ONLY twin of
     *  core()'s replay branch, for callers that must answer "did this already happen?" BEFORE
     *  spending real work (the chunked-upload commit: its upload is consumed on success, so a
     *  retried commit must be answerable without the upload it no longer has). */
    priorReceipt(command_id) {
      const seen = q.eventByCmd.get(String(command_id || ""));
      if (!seen) return null;
      // The payload rides along because the ORIGINAL receipt is built from it — never from the
      // current row, which a later write may have moved on (a replayed commit must describe what
      // that commit did, not what the path holds today).
      let payload = {};
      try { payload = JSON.parse(seen.payload) || {}; } catch {}
      return { event_type: seen.event_type, aggregate_id: seen.aggregate_id, seq: seen.seq, payload };
    },

    /** How many items a collection holds — the zero-row open's honest companion: the model learns
     *  the size without a single row travelling. */
    countItems: (collection) => q.countColl.get(String(collection)).n,

    /** What deleting `name` would take with it, and — just as important — what it would LEAVE.
     *
     *  This exists because the honest answer to "which collections belong to this app" is
     *  "we cannot always tell", and the shape of a destructive tool has to say so out loud rather
     *  than guess. The three signals, with their measured strength (2026-07-28, docs/wo/
     *  delete-cascade-design.md):
     *    · the manifest's `collections` key — the GUIDE calls this THE lifecycle claim, and its
     *      real-world adoption is ZERO: 19 of our own components declare settings and uses_shared,
     *      none declares a collection. Used here to find OTHER claimants, never to grant one.
     *    · the ledger's `via.component` — stamped only on writes that came through a widget. The
     *      model's own writes (the dominant path) carry none, so its ABSENCE proves nothing. Used
     *      here in one direction only: someone else's via is evidence of sharing.
     *    · the name — a collection called exactly like the component. Weak on its own, which is
     *      why it only produces `exclusive` when BOTH of the above find no other claimant.
     *
     *  The asymmetry is the whole design: deleting too little leaves rows a user can delete again;
     *  deleting too much silently breaks a SECOND app and the data is gone. So `shared` and
     *  `unknown` are kept, always, and the caller is told what was kept and why.
     *
     *  Returns { collections: [{collection, verdict, rows, why}], settings_keys, exclusive: [names] }
     *  where verdict is "exclusive" | "shared" | "unknown". Read-only. */
    deleteDisposition: computeDisposition,

    /** The keyset cursor that continues AFTER this item — exposed so a caller that shrinks a page
     *  to fit a budget can hand out a cursor that matches the rows it actually kept. */
    cursorAfter: (item) => encCursor({ g: item.group ?? "", p: item.position, id: item.id }),

    // File plane — ref index + quota accounting the channel (src/files.mjs) builds on. Bytes NEVER
    // pass through here; the store stays fs-free beyond the existing mkdirSync. `dataDir` is where the
    // backend puts files/<component>/<sha256>.blob — derived from the ACTUAL db path so it honors
    // OMA_DB / an explicit path (test isolation) and sits beside whatever db is open.
    statFile: (component, path) => {
      const r = q.fileByKey.get(component, path);
      return r ? { component, path, sha256: r.sha256, size: r.size, mime: r.mime, version: r.version, backend: r.backend, created_at: r.created_at, updated_at: r.updated_at } : null;
    },
    listFiles: (component, prefix) => {
      const rows = q.filesByComponent.all(component);
      return prefix ? rows.filter((r) => r.path.startsWith(prefix)) : rows;
    },
    fileUsage: (component) => q.fileUsageStmt.get(component),
    fileUsageTotal: () => q.fileUsageTotalStmt.get(),
    filesVersion: () => q.filesSeq.get().v, // the monotonic file-activity gate (rides tool results, like settings_version)
    blobRefcount: (component, sha256) => q.blobRefcountStmt.get(component, sha256).n,
    dataDir: dirname(dbPath),

    /** UNDO — one verb, and it is deliberately not a tool.
     *
     *  "Put it back" is the same action on every plane, so it is one function: read the last event
     *  for a target, and apply its pre-image. Items carry `was` (§ the write path above), components
     *  carry their previous html in component_history, files carry a content address that is still
     *  on disk until the sweep reclaims it — so each plane answers the same question with what it
     *  already keeps, and none of them needed a new table.
     *
     *  NOT an MCP tool (Leo 2026-07-26): the ledger is internal. The model reads current data and
     *  writes commands; the history it never sees, so it never needs a verb for it. The human does —
     *  through the Data pane. Undo is therefore reachable from the UI and from any embedder, and
     *  absent from tools/list, which is also why it costs no resident bytes.
     *
     *  Reversal is itself a WRITE: it appends its own event rather than erasing the one it undoes.
     *
     *  ONE transaction around read-and-reverse (write-set D): between "what was the last event?"
     *  and the reversing write nothing else may land, or the button reverses a different event
     *  than the one the human read. The change notification still fires AFTER the commit, like
     *  every other write. */
    undoLast(target, { expectedSeq } = {}) {
      const txUndo = db.transaction((t) => {
        const ev = q.lastEventFor.get(String(t));
        if (!ev) return { done: { ok: false, error: "nothing_to_undo" } };
        // The Data pane renders an Undo button beside the event it SHOWS. Between render and
        // click another write can advance the same target, and undoing the *current* last event
        // would silently revert a write the user never saw (reproduced: a field went 2→1). When
        // the caller pins the seq it saw, a mismatch refuses loudly instead of reversing the
        // wrong thing.
        if (expectedSeq != null && ev.seq !== Number(expectedSeq))
          return { done: { ok: false, error: "stale_undo", latest_seq: ev.seq } };
        const payload = JSON.parse(ev.payload);
        const cid = randomUUID();
        if (ev.event_type === "item_added") {
          // Reversing a creation is deletion. The delete event's `was` carries the row's current
          // fields, so undo-of-undo restores it — the ledger stays append-only in both directions.
          if (!q.itemById.get(ev.aggregate_id)) return { done: { ok: false, error: "already_gone" } };
          return { type: "delete_item", result: core({ type: "delete_item", command_id: cid, id: ev.aggregate_id, actor: "human" }, true) };
        }
        if (ev.event_type === "item_updated") {
          // Restore exactly the keys the update touched. A key whose pre-image was absent goes back to
          // absent — `null` is how this store spells "remove this key", so the round trip is exact.
          return { type: "update_item", result: core({ type: "update_item", command_id: cid, id: ev.aggregate_id, fields: payload.was || {}, actor: "human" }, true) };
        }
        if (ev.event_type === "item_deleted") {
          // Refuse when the id lives again (someone re-created it since): resurrecting the OLD row
          // over the new one would be a silent clobber — and the primary key would throw mid-undo
          // anyway. A named refusal, not an exception.
          if (q.itemById.get(ev.aggregate_id)) return { done: { ok: false, error: "target_exists" } };
          return { type: "add_item", result: core({ type: "add_item", command_id: cid, id: ev.aggregate_id, collection: payload.collection,
            group: payload.group, position: payload.position, fields: payload.was || {}, actor: "human" }, true) };
        }
        if (ev.event_type === "item_moved") {
          return { type: "move_item", result: core({ type: "move_item", command_id: cid, id: ev.aggregate_id, group: payload.from, position: payload.from_position, actor: "human" }, true) };
        }
        if (ev.event_type === "component_archived") {
          // The flip's pre-image is `was`, and it may be a value the public verb cannot spell
          // (featured, unlisted) — the privileged visibility override exists for exactly this line.
          return { type: "archive_component", result: core({ type: "archive_component", command_id: cid, name: ev.aggregate_id,
            visibility: payload.was, actor: "human" }, true) };
        }
        if (ev.event_type === "component_saved") {
          // The previous version's html is the pre-image, and rolling FORWARD to it (rather than
          // deleting the current row) is what keeps history honest: you can undo the undo.
          // The event's own seq IS the version it created (one ordinal axis), so the payload does not
          // carry one and does not need to — "the version before this event" is just "below its seq".
          const hist = q.compHistory.all(ev.aggregate_id);
          const prev = hist.find((h) => h.version < ev.seq);
          if (!prev) return { done: { ok: false, error: "no_previous_version" } };
          return { type: "save_component", result: core({ type: "save_component", declaration_policy: "salvage", command_id: cid, name: ev.aggregate_id, html: prev.html, actor: "human" }, true) };
        }
        return { done: { ok: false, error: "not_undoable", event_type: ev.event_type } };
      });
      const out = txUndo(target);
      if (out.done) return out.done;
      return notify(out.result, { type: out.type });
    },

    /** Newest-first ledger window for the DATA PANE — the one read that keeps `via` (the shadow
     *  edge exists for the human's ownership view; every AI-facing read strips it). Deliberately
     *  NOT a tool: served only by the /rpc internal path (`_ledger_recent`), which sandboxed
     *  children can't reach either (`_` is control-plane by prefix). `undoable` marks rows that
     *  are their aggregate's LATEST event — the only ones undoLast would actually reverse. */
    recentEvents({ collection, limit } = {}) {
      const n = Math.max(1, Math.min(200, Number(limit) || 50));
      const rows = collection != null
        ? q.recentEventsColl.all({ c: String(collection), n })
        : q.recentEventsAll.all({ n });
      return rows.map((r) => {
        let payload = {};
        try { payload = JSON.parse(r.payload) || {}; } catch {}
        const { sv: _sv, ...rest } = payload;
        const last = q.lastEventFor.get(r.aggregate_id);
        return { seq: r.seq, type: r.event_type, id: r.aggregate_id, actor: r.actor,
          principal: r.principal ?? undefined, host: r.host, ts: r.ts,
          undoable: !!(last && last.seq === r.seq), ...rest };
      });
    },

    /** How much history to keep, as a POLICY VALUE rather than a feature: `policy:retention.events`
     *  in the settings collection, writable only through the privileged path. The engine's default is
     *  the smallest honest one — keep everything, prune nothing — because an OSS install has no one
     *  to bill for storage and a silent pruner is the worst kind of data loss. A deployment that
     *  wants a bound sets the key; a tier that sells a longer one sets it higher. No code branches
     *  on which product this is.
     *
     *  Returns null for "unbounded", a positive integer for "keep this many events per collection". */
    retentionEvents() {
      const row = q.settingByKey.get("policy:retention.events");
      if (!row) return null;
      const n = Number(JSON.parse(row.fields).value);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    },

    /** Apply the retention policy: drop the OLDEST events of a collection beyond the kept window.
     *  Explicit, never automatic on write — pruning inside a write transaction would make the cost
     *  of one user's edit depend on how much history someone else made. The caller (a maintenance
     *  pass, the Data pane) decides when. */
    pruneLedger(collection) {
      const keep = this.retentionEvents();
      if (!keep) return { ok: true, pruned: 0, policy: "unbounded" };
      const c = String(collection);
      const info = q.pruneColl.run({ c, keep });
      // WRITE DOWN THAT HISTORY WAS LOST, in the same breath as losing it.
      //
      // deleteDisposition decides whether a collection was created FOR an app by comparing earliest
      // events, and the events this just deleted are the ones that prove a collection is OLDER than
      // the app sharing its name. Without a note, the judge reads a truncated history as a complete
      // one and concludes the user's own older rows belong to the app — then cascade deletes them.
      // The gap is invisible from the inside, so it has to be recorded from here, where it is made.
      // Only when something was actually removed: a no-op prune truncates nothing.
      if (info.changes > 0) {
        q.markTruncated.run({ c, seq: q.oldestCollEvent.get(c).v, ts: new Date().toISOString() });
      }
      return { ok: true, pruned: info.changes, policy: `keep ${keep}` };
    },

    close: () => db.close(),
  };
}
