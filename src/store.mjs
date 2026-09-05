// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// store.mjs — the generic persistent store behind open-mcp-apps.
//
// Two things live here, both versioned, both MCP-independent:
//   1. DATA:      collections of items ({id, group, position, fields, version})
//   2. APPS: the UI registry ({name, version, html}) — what the AI creates & reuses
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
import { mkdirSync, existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { readDeclaration, stripDeclarationBlock, mentionsDeclarationTag } from "./manifest-block.mjs";
import { functionsJoinError, FN_NAME_RE, MAX_FUNCTIONS, FN_TIME_TIMER_MAX_MS, SECRETS_RESERVED_NOTE } from "./functions.mjs";
// The other half of a two-way import (assets.mjs reads FILE_PATH_RE from here). Both directions
// are used only inside function bodies, so neither module reads a binding that is still being
// initialised — see the note at the top of assets.mjs for why one scanner, not two.
import { hasAssetReferences, assetSyntaxError } from "./assets.mjs";
// tierOf only, and deliberately from the module that owns the security model rather than a second
// copy of the author→tier partition living here: the disease this codebase watches for is DIALECTS,
// and two places deciding what "local" means is exactly one. contracts.mjs imports nothing but zod,
// so this direction adds no cycle.
import { tierOf } from "./contracts.mjs";
import { CONFIRMATION_CLASSES, createRequestStateCodec, deletePreview, storeSecret } from "./confirmation.mjs";
// The renderer's own value coercion — see confirmPrefOn (one answer to "what does this row mean").
import { coercePref, latestPref } from "./runtime-core.mjs";

// Migration-format pin: stamped into PRAGMA user_version AND every change_event payload (`sv`).
// Export/import + SaaS sync read this to know which event shape they are looking at — bump it on
// any breaking payload/schema change and translate old values on read. Never reuse a number.
export const SCHEMA_VERSION = 7;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS item (
  id         TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  grp        TEXT NOT NULL DEFAULT '',
  position   REAL NOT NULL DEFAULT 0,
  fields     TEXT NOT NULL DEFAULT '{}',   -- JSON object, app-defined shape
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_collection ON item(collection);
-- Serves the paged/filtered read path (queryItems): WHERE collection [AND grp] with an
-- ORDER BY that matches the index columns, so pages never sort the whole collection.
CREATE INDEX IF NOT EXISTS idx_item_coll_grp_pos ON item(collection, grp, position);

CREATE TABLE IF NOT EXISTS app (
  name        TEXT PRIMARY KEY,             -- [a-z][a-z0-9-]*; with OMA_DYNAMIC_TOOLS=1 it also surfaces as an open_<name> tool (flag defaults OFF — cache)
  version     INTEGER NOT NULL DEFAULT 1,
  ui          TEXT NOT NULL,                -- the ui SLOT: a complete HTML document (v6: no embedded declaration block)
  description TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT 'agent',
  scene       TEXT,                         -- projection of manifest.scene (App Store taxonomy) — derived, rebuildable
  manifest    TEXT,                         -- JSON | NULL — the AUTHORITATIVE declaration (v6/W-N: no longer a projection of an in-document block)
  kind        TEXT NOT NULL DEFAULT 'app',  -- projection of manifest.kind — lets list_apps filter without parsing JSON
  visibility  TEXT NOT NULL DEFAULT 'listed', -- featured | listed | unlisted | archived (archive, curation and the long tail, in one field)
  updated_at  TEXT NOT NULL
);
-- The REVISION table (v6): every save snapshots BOTH slots, so a restore/undo target is always a
-- coherent (ui, manifest) pair — never a document from one save paired with a declaration from
-- another. version = the writing event's ledger seq, exactly as before.
CREATE TABLE IF NOT EXISTS app_history (
  name     TEXT NOT NULL,
  version  INTEGER NOT NULL,
  ui       TEXT NOT NULL,
  manifest TEXT,                            -- JSON | NULL — this revision's declaration, verbatim
  ts       TEXT NOT NULL,
  PRIMARY KEY (name, version)
);

-- File plane (scope b — user files). Bytes live on disk beside the db (src/files.mjs — a local
-- content-addressed folder), NEVER here; this table is the
-- per-app ref index that drives quota + versioning + audit. Isolation is a KEY, not a convention:
-- PRIMARY KEY (app, path) + WHERE app=? on every read make cross-app addressing impossible.
CREATE TABLE IF NOT EXISTS file (
  app  TEXT NOT NULL,               -- owning app = isolation namespace (APP_NAME_RE)
  path       TEXT NOT NULL,               -- app-chosen logical name; a DB VALUE, never a fs path segment
  sha256     TEXT NOT NULL,               -- content address → files/<app>/<sha256>.blob in the backend
  size       INTEGER NOT NULL,            -- LOGICAL bytes (drives quota; content-addressed dedup cannot bypass)
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  version    INTEGER NOT NULL DEFAULT 1,  -- the writing event's ledger seq (OCC token, mirrors item.version — it JUMPS, never +1)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app, path)
);
CREATE INDEX IF NOT EXISTS idx_file_app ON file(app);
CREATE INDEX IF NOT EXISTS idx_file_sha       ON file(app, sha256);

CREATE TABLE IF NOT EXISTS change_event (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_id TEXT NOT NULL,               -- item id | app name | collection name
  command_id   TEXT NOT NULL UNIQUE,        -- idempotency key
  event_type   TEXT NOT NULL,               -- item_added|item_updated|item_moved|item_deleted|component_saved|component_deleted
  payload      TEXT NOT NULL,               -- JSON (app html NOT included — it's in app_history)
  actor        TEXT NOT NULL,             -- see ACTORS: the CLASS that wrote this (E13b closed set — the wall that keeps anonymous writes from ever landing mislabelled)
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

-- THE LIVE POINTER (v7): which app was opened last — the whole state of a wall display.
-- A VOLATILE FIELD, NOT HISTORY, and the CHECK is what says so: exactly one row, overwritten in
-- place, no ledger event, no seq. "What is on screen now" has one value and no past, and appending
-- an event per open would bury the record of what the user and the AI actually DID under a stream
-- of glances (Leo 2026-08-14). Losing this table costs a display its first frame and nothing
-- else — which is why it is created by plain additive DDL and read with a COALESCE default.
-- The n column is a monotonic counter, NOT a seq: it is how a process that cannot hear another's
-- in-process "live" emit still notices a switch (see dataVersion().live_n and the /events probe).
CREATE TABLE IF NOT EXISTS live_pointer (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  app TEXT NOT NULL,
  ts  TEXT NOT NULL,
  n   INTEGER NOT NULL
);

`;

// The CLASS that performed a write. Closed on purpose (E13b): `actor` used to be free text, so an
// anonymous write could silently land labelled "human" and the ledger would never be able to tell
// the owner's edits from a stranger's. The ledger only grows, so that mislabelling is permanent —
// this is the one reservation that cannot be fixed after the fact. 'guest' and 'anon' are reserved
// NOW and rejected nowhere: no code path produces them yet, and when one does it must say so.
// The pre-v4 migration ladder (eraNames / MIGRATIONS 2-4 / renameLegacyTables /
// migrationsBetween, ~220 lines) retired 2026-08-04 (elegance A1): no store older than the last
// public release exists outside tests, and those steps were manufactured solely by tests. Two
// rungs remain, chained in openStore — v4 (v0.4.2, the last released store) → v5 → v6. Anything
// older refuses with the way forward named.

export const ACTORS = new Set(["agent", "human", "seed", "library", "guest", "anon"]);

// What an app IS (drives what list_apps will eventually bother listing) and how visible
// it is. Closed sets for the same reason ACTORS is: a typo'd value would be indistinguishable from
// a real one, and these decide what the model gets to see.
// Commands where `actor` is authorship provenance rather than a write class — see execute().
const AUTHORSHIP_COMMANDS = new Set(["save_app", "delete_app"]);

export const APP_KINDS = new Set(["app", "visual", "primitive"]);
export const VISIBILITIES = new Set(["featured", "listed", "unlisted", "archived"]);

export const APP_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
// There is no `MAX_APP_HTML` any more. A document had a 200,000-unit write-side ceiling until
// v0.6.0; it was removed because the READ side already carries the only cap that was ever load-
// bearing — `get_app` windows the source (RESULT_BUDGET), so a big app costs windows, not a
// refusal. A write-side ceiling only decided who was allowed to exist, and the engine has no
// business deciding that: an app built by a bundler outside the chat is a first-class app.
// What stays is `empty_ui` below — a VALIDITY rule (an app is something a person opens), never a
// size floor. The advice about staying lean now lives where advice belongs, in the guide.

// Security v0.1 content-rules (docs/security-model.md §4–§5), enforced in the store so they
// bind EVERY caller and transport (the AI, the browser /rpc, a widget) — the engine cannot
// tell an AI tool-call from a widget tool-call, so these are the rules that hold for all.
export const SETTINGS_COLLECTION = "settings";
// Reserved policy namespaces: writable ONLY via executePrivileged (the security_set tool).
// The colon prefix is outside the settings-design declared-key charset, so it never collides
// with an app's own preference keys.
// `secret:` joined them 2026-08-16 and is the odd one out: it is reserved against EVERYONE,
// including the privileged writer (see tools/settings.mjs). Functions gained the network that
// day, so the next question an app asks is "where do I put the API key" — and the answer has to
// exist as a refusal before it exists as a feature, or the namespace gets squatted by a
// well-meaning app storing a token in plaintext under whatever key it invented.
export const RESERVED_KEY_RE = /^(?:security|policy|secret):/;
export const SECRET_KEY_RE = /^secret:/;
// …and it carries its own sentence, because a bare "reserved_key" would send a model to
// security_set, which refuses it too. Note this refusal ignores `privileged`: security:* and
// policy:* have a legitimate writer, secret:* has none yet, and a namespace nobody may write is
// the only kind that is still empty when its release arrives.
const secretKeyRefusal = (key) =>
  ({ ok: false, error: "reserved_key", detail: `"${key}" is in the secret: namespace — ${SECRETS_RESERVED_NOTE}` });
// Per-item DoS floor: no single item's fields JSON may exceed this, for anyone.
export const MAX_ITEM_FIELDS_BYTES = 32_768;
// A group is a LANE NAME, not a data field: it rides every event, every cursor and every receipt
// for its rows, so it must not be essay-sized. The cap is also what keeps a SINGLE row structurally
// unable to outgrow the result budget (fields have their own cap; group was the uncapped hole).
export const MAX_GROUP_CHARS = 500;
// ─────────────────────────────────────────── one key table, two write paths (both need the wall)
// WHICH keys a caller may set on an item write, per command. Everything else it sends is dropped
// rather than forwarded — "unpublished keys are dropped, not honored", which apply_data_writes has always
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
  delete_item: ["id", "expected_version", "request_state", "require_confirmation"],
};
/** Envelope keys a batch command may carry — the historical set, unchanged. */
export const BATCH_ENVELOPE_KEYS = ["command_id", "actor", "host"];
/** The SHAPE each published key must have — the value half of ITEM_WRITE_KEYS.
 *
 *  Filtering key NAMES was only ever half a wall. `fields: []` and `fields: "text"` carry published
 *  names and unpublished shapes, and the single-write tools refuse both (their zod says
 *  `z.record(...)`) while a batch waved them through: the array landed in the row and made
 *  data_list fail output validation for the WHOLE collection, and the string was coerced to `{}`
 *  and vanished while the caller read `ok:true`. The second is the worse one — nothing ever
 *  reports it.
 *
 *  The tool layer publishes these same shapes in zod and cannot import from here (nor this from
 *  there). So the two are held together by a TEST that hands both doors the same bad values and
 *  requires the same verdict — behaviour, not a shared definition neither side can reach. */
const plainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const finiteNumber = (v) => typeof v === "number" && Number.isFinite(v);
export const ITEM_WRITE_SHAPES = {
  collection: (v) => typeof v === "string",
  id: (v) => typeof v === "string",
  group: (v) => typeof v === "string",
  fields: plainObject,
  position: finiteNumber,
  expected_version: finiteNumber,
  request_state: (v) => typeof v === "string",
  require_confirmation: (v) => v === true || v === false,
};
/** …and the SINGLE-tool envelope, which adds `via`: the widget's shadow provenance stamp is the
 *  reason those four schemas are passthrough at all, so the wall has to let it through. Kept apart
 *  from the batch's set deliberately — `apply_data_writes` is the model's bulk verb, never a widget's
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
export const MAX_TOTAL_FILE_COUNT = 200_000;                 // global file-count floor — bounds zero-byte/deduped rows + inodes the byte caps can't (every regex-valid app name is otherwise a fresh per-app budget)

// How long a HUMAN-authored app's superseded revisions are kept (Leo 2026-08-16, §7-4). An app
// pushed from a build pipeline has its history in that pipeline's VCS; keeping every push here
// stores a full bundle per push in `app_history` forever, for a rollback the author would do in
// their own repo. Seven days is a window for "I pushed the wrong build", not an archive — and the
// CURRENT revision is never swept, at any age, because it is the app.
export const HUMAN_HISTORY_KEEP_DAYS = 7;

// App schema manifests: an app declares WHICH collections it stewards and, optionally,
// field contracts for them. Validation lives HERE (not the engine) so it binds EVERY caller — AI
// tool, widget mutation, /rpc. Manifest-less collections behave exactly as before.
//
// `fields` is OPTIONAL: a bare `{collections: {trips: {}}}` is a pure STEWARDSHIP declaration —
// it claims the collection for the lifecycle plane (export/archive view/retention/Data pane) and
// validates nothing. That split is the point: stewardship is declared, access is decided by caps,
// and neither implies the other. Requiring `fields` is what made stewardship unaffordable to
// declare, which is why the collection↔app edge appeared not to exist at all.
export const MANIFEST_FIELD_TYPES = new Set(["string", "number", "boolean", "object", "array"]);
// ONE spec grammar for a declared value — collection fields and function params speak it
// identically (ruled: no second schema language). `where` names the seat in the refusal.
function fieldSpecError(f, where) {
  if (!f || typeof f !== "object" || Array.isArray(f)) return `${where} must be an object`;
  if (!MANIFEST_FIELD_TYPES.has(f.type)) return `${where}.type must be one of ${[...MANIFEST_FIELD_TYPES].join("|")}`;
  if (f.required != null && typeof f.required !== "boolean") return `${where}.required must be a boolean`;
  if (f.enum != null && (!Array.isArray(f.enum) || f.enum.length === 0)) return `${where}.enum must be a non-empty array`;
  return null;
}
// ────────────────────────────────────────────────────── the network declaration (MCP Apps spec)
// The four keys of `McpUiResourceCsp` (@modelcontextprotocol/ext-apps spec.types.d.ts), spelled
// EXACTLY as the spec spells them — the engine relays this declaration to the host verbatim, so a
// private synonym here would be a dialect only we can read. Order is the order the spec lists them.
export const CSP_DOMAIN_KEYS = ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"];
// An origin, or a wildcard-subdomain origin: scheme://host[:port] / scheme://*.host[:port].
// SHAPE only, never policy — the engine does not judge WHERE an app wants to connect (that is the
// host's call, and the user's). What it does judge is whether the string is an origin at all, and
// that check is load-bearing twice over:
//   · a value that is not an origin cannot mean anything to a host, so it would fail silently there
//     rather than at the door where the author can still read the message;
//   · these strings are CONCATENATED into a CSP header/meta by runnerCspFor/viewCspFor, so a value
//     carrying `;` or whitespace — "https://x.example; script-src *" — is DIRECTIVE INJECTION into
//     our own two policies. Refusing anything but an origin is what keeps that impossible, which is
//     why the regex forbids those characters rather than stripping them.
// `wss://` and `ws://` are deliberately allowed: the spec's own connectDomains example is a
// WebSocket origin. A trailing path is not — CSP source expressions match by origin.
const CSP_ORIGIN_RE = /^[a-z][a-z0-9+.-]*:\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::[0-9]{1,5})?$/i;
/** Shape of a `csp` declaration, in one sentence — for whoever refuses it. ONE definition, three
 *  callers: the save door (manifestShapeError), the user's own additions (security_set), and the
 *  merge that assembles them (contracts.mjs cspFor, which re-filters because a settings row may
 *  predate this gate — the gate belongs on the road the value leaves by, not only on the way in).
 *  `where` names the seat in the refusal. Returns null when the shape is good. */
export function cspShapeError(c, where = "manifest.csp") {
  if (!c || typeof c !== "object" || Array.isArray(c)) return `${where} must be an object`;
  for (const k of CSP_DOMAIN_KEYS) {
    if (c[k] == null) continue;   // an omitted key is the secure default (no origins), never an error
    if (!Array.isArray(c[k])) return `${where}.${k} must be an array of origins (e.g. ["https://api.example.com"])`;
    for (const v of c[k]) {
      if (typeof v !== "string" || !CSP_ORIGIN_RE.test(v))
        return `${where}.${k}: ${JSON.stringify(v)} is not an origin — write scheme://host[:port] ` +
          `(e.g. "https://api.example.com", "wss://live.example.com:8443", or "https://*.example.com" for subdomains). No path, no trailing slash.`;
    }
  }
  // Unknown keys are IGNORED, not refused — same rule the rest of this function follows: a document
  // written for a newer engine (a fifth spec key) must still save on this one.
  return null;
}

/** One source's contribution to the merge, or null when it cannot be read. A settings row is a
 *  STRING (security_set stores strings), and a row that predates this gate — or one written by an
 *  older engine sharing the same SQLite file — can hold anything. Fail CLOSED and whole: a source
 *  that does not parse, or whose shape is bad, contributes NOTHING rather than its good half. A
 *  half-applied network policy is the failure mode that looks like it worked. */
function cspSource(v) {
  if (v == null) return null;
  let o = v;
  if (typeof o === "string") { try { o = JSON.parse(o); } catch { return null; } }
  return cspShapeError(o) ? null : o;
}

/** WHERE THIS APP MAY REACH, as one merged declaration: what the app declared ∪ what the user
 *  added for it (`policy:csp:<app>`) ∪ what the user added for everything (`policy:csp:*`).
 *
 *  THE ENGINE DOES NOT ADJUDICATE — it merges and relays (Leo, 2026-08-16). This is not an
 *  allowlist the engine enforces against the app; it is the app's own statement of need plus the
 *  user's own additions, handed to the host, which is the party the MCP Apps spec puts in charge of
 *  enforcement. The OSS engine sets no egress ceiling of its own.
 *
 *  It lives HERE, not in contracts.mjs, for one hard reason: store.mjs imports `tierOf` from
 *  contracts.mjs, so contracts.mjs may never import store.mjs (the cycle that file's header exists
 *  to prevent) — and both of this function's inputs are store-shaped, the app row's manifest and
 *  the settings collection.
 *
 *  Order is fixed so the output is too: declaration, then per-app, then global; first occurrence
 *  wins a duplicate. Empty keys are OMITTED — an omitted key IS the spec's secure default, and a
 *  caller that needs the empty array on the wire (the resource `_meta`, whose two legacy keys have
 *  always been present) shapes that itself rather than making every caller carry it. */
export function cspFor(comp, store) {
  let declared = null;
  try { declared = comp?.manifest ? JSON.parse(comp.manifest).csp : null; } catch { declared = null; }
  const sources = [cspSource(declared)];
  if (store && comp?.name) {
    // Last row wins per key — the same scan computeCaps and the pref merge use. Duplicate settings
    // rows are ordinary (nothing forbids a second data_add_item under a key), and a reader that
    // took the FIRST would answer with the row the settings UI does not update.
    const byKey = new Map();
    for (const it of store.snapshot(SETTINGS_COLLECTION).items) {
      const k = String(it.fields?.key ?? "");
      if (k) byKey.set(k, it.fields.value);
    }
    sources.push(cspSource(byKey.get(`policy:csp:${comp.name}`)), cspSource(byKey.get("policy:csp:*")));
  }
  const out = {};
  for (const key of CSP_DOMAIN_KEYS) {
    const seen = [];
    for (const s of sources) for (const v of (s?.[key] || [])) if (!seen.includes(v)) seen.push(v);
    if (seen.length) out[key] = seen;
  }
  return out;
}
/** THE LOADER'S DECLARATION: every app's merged declaration (cspFor) folded into one, plus the
 *  user's global additions. Exists for the one resource that serves EVERY app — the universal
 *  loader `open_app` points hosts at — which structurally cannot carry any single app's `csp`, and
 *  before this carried nobody's (Leo 2026-08-16, plan §7-8, option A): the host is asked to allow
 *  the UNION, and the runner child inside the loader is narrowed back to its own app by
 *  composeChildDoc — a srcdoc frame runs under parent ∩ own, so the outer wall has to be at least
 *  as wide as the widest app or the inner declaration means nothing. Same merge rule as cspFor,
 *  same omitted-empty-key shape; a store with no declarations anywhere yields `{}`, and the loader
 *  then serves the exact bytes it served in 0.5.9. */
export function cspUnion(store) {
  const sources = [];
  for (const row of store.listApps({})) sources.push(cspFor(store.getApp(row.name), store));
  const out = {};
  for (const key of CSP_DOMAIN_KEYS) {
    const seen = [];
    for (const src of sources) for (const v of (src?.[key] || [])) if (!seen.includes(v)) seen.push(v);
    if (seen.length) out[key] = seen;
  }
  return out;
}
export function manifestShapeError(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "manifest must be an object";
  // `collections` is OPTIONAL at the top level. An app's declaration is mostly about itself —
  // its settings, which shared prefs it honours, later its functions and what it embeds — and most
  // real apps declare no collection contract at all. Demanding one made the whole declaration
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
        const err2 = fieldSpecError(f, `field ${coll}.${fname}`);
        if (err2) return err2;
      }
    }
  }
  // The function roster (W3). Signatures only — the BODY lives in the document and the two are
  // joined at the save door (functionsJoinError), so a declaration here is never a silent no-op.
  // `public` is validated and stored but consumed by NOTHING yet: it is the reserved shape for the
  // anonymous-write gate (B2 wave) — a declared-public function is the ONLY thing that face will
  // ever expose, so the word has to exist before the wave that reads it.
  if (m.functions != null) {
    if (typeof m.functions !== "object" || Array.isArray(m.functions)) return "manifest.functions must be an object";
    const names = Object.keys(m.functions);
    if (names.length > MAX_FUNCTIONS) return `manifest.functions declares ${names.length} functions, limit ${MAX_FUNCTIONS}`;
    for (const [fname, spec] of Object.entries(m.functions)) {
      if (!FN_NAME_RE.test(fname)) return `function name "${fname}" — lowercase letters, digits and underscores, starting with a letter (max 64 chars)`;
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) return `functions.${fname} must be an object`;
      if (spec.description != null && typeof spec.description !== "string") return `functions.${fname}.description must be a string`;
      if (spec.public != null && typeof spec.public !== "boolean") return `functions.${fname}.public must be a boolean`;
      // A per-function wall clock, declared where the signature is. The engine sets NO policy
      // ceiling — the real limit is the host's own tool-call timeout (see functions.mjs). What is
      // checked here is only sanity: a positive whole number of milliseconds the timer can actually
      // hold. FN_TIME_TIMER_MAX_MS is setTimeout's 32-bit bound, not a policy cap — past it the timer
      // would silently re-arm at 1 ms and break the deadline. A foot-gun floor, learned once at save.
      if (spec.timeout_ms != null && (!Number.isInteger(spec.timeout_ms) || spec.timeout_ms < 1 || spec.timeout_ms > FN_TIME_TIMER_MAX_MS))
        return `functions.${fname}.timeout_ms must be a whole number of milliseconds ≥ 1 (upper bound is the JS timer's, not a policy cap)`;
      if (spec.params != null) {
        if (typeof spec.params !== "object" || Array.isArray(spec.params)) return `functions.${fname}.params must be an object`;
        for (const [pname, p] of Object.entries(spec.params)) {
          const err2 = fieldSpecError(p, `functions.${fname}.params.${pname}`);
          if (err2) return err2;
        }
      }
    }
  }
  // The rest of the declaration face. Shape only — what each key MEANS is enforced by whoever reads
  // it (the settings app renders `settings`, list_apps filters on `kind`), which is why a key
  // this build does not know yet is IGNORED rather than rejected: a document written for a newer
  // engine must still save on an older one, or the declaration stops being safe to grow.
  if (m.manifest_version != null && ![1, 2].includes(m.manifest_version)) return "manifest_version must be 1 or 2";
  if (m.settings != null && !Array.isArray(m.settings)) return "manifest.settings must be an array";
  if (m.uses_shared != null && !Array.isArray(m.uses_shared)) return "manifest.uses_shared must be an array";
  if (m.kind != null && !APP_KINDS.has(m.kind)) return `manifest.kind must be one of ${[...APP_KINDS].join("|")}`;
  if (m.scene != null && (typeof m.scene !== "object" || Array.isArray(m.scene))) return "manifest.scene must be an object";
  // `stage` — how the app wants to sit on a screen ({width: "column"|"wide"|"fluid"}, read by
  // contracts.mjs stageWidthFor). SHAPE only, and deliberately no enum on `width`: a track name
  // this build has never heard of is exactly the "written for a newer engine" case the paragraph
  // above promises to keep saveable, and the reader falls back to the default rather than break.
  if (m.stage != null && (typeof m.stage !== "object" || Array.isArray(m.stage))) return "manifest.stage must be an object";
  if (m.stage?.width != null && typeof m.stage.width !== "string") return "manifest.stage.width must be a string";
  // `stage.display` — "this app is a surface that shows OTHER apps" (contracts.mjs
  // stageDisplayFor). Same shape-only treatment as width, one axis narrower: a boolean has no
  // vocabulary to grow, so the type IS the whole check, and the reader still demands `true`
  // rather than truthiness.
  if (m.stage?.display != null && typeof m.stage.display !== "boolean") return "manifest.stage.display must be a boolean";
  // `csp` — WHERE THIS APP REACHES. Declared by the app, relayed by the engine, enforced by the
  // host (MCP Apps spec). Validated by shape only, and by the one function that owns that question:
  // the user may add origins of their own through `policy:csp:*`, and two graders would eventually
  // disagree about what an origin is.
  if (m.csp != null) {
    const err = cspShapeError(m.csp);
    if (err) return err;
  }
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
  delete_item: "item_deleted", save_app: "component_saved", delete_app: "component_deleted",
  archive_app: "component_archived",
  write_file: "file_written", delete_file: "file_deleted",
};

// Totality check for the confirmation policy (W-S): the two tables must cover each other
// EXACTLY, at module load. A new command added without deciding whether it needs the user's
// confirmation is a boot failure, not a silent exemption — that turn-the-question-around is
// the whole point of the policy layer (§2.5-A: "forgot" must mean "refused", never "lost data").
for (const t of Object.keys(EVENT_TYPES))
  if (!CONFIRMATION_CLASSES[t]) throw new Error(`store command "${t}" is not classified in CONFIRMATION_CLASSES (confirmation.mjs) — every command must state whether it needs user confirmation`);
for (const t of Object.keys(CONFIRMATION_CLASSES))
  if (!EVENT_TYPES[t]) throw new Error(`CONFIRMATION_CLASSES entry "${t}" matches no store command — remove it or add the command`);

// The store lives in a FIXED per-user data dir, decoupled from the clone location, so every
// host (Claude Desktop, Claude Code, Codex) and every clone opens the SAME db — apps and
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

// ─────────────────────────────────────────────────────── v4 → v5: the reservations leave the shape
// The v4 shape carried reservations nothing ever consumed: `principal` on item and change_event,
// `kit_version` and `server_script` on app, `backend` on file, and the ledger_truncation /
// report_watermark side tables, whose only readers retired with retention and the server-held
// watermark. This step removes exactly those and touches nothing else — no row is read, no value is
// rewritten, so every row crosses the line byte-identical and the step cannot fail on data.
//
// DROP COLUMN is admissible for precisely these five: none appears in a primary key, a unique
// constraint, a CHECK, or any index — including the partial and expression indexes over
// change_event, which name only `seq`, `event_type` and json_extract(payload, …). The pragma guard
// is not defensive dressing: SQLite has no DROP COLUMN IF EXISTS, and a v4 store hand-repaired with
// a later build can legitimately be missing one.
//
// Runs inside openStore's single immediate transaction, ahead of the v5 → v6 step: a v4 store
// climbs both rungs in one open, and an interruption at either leaves it whole at v4.
function migrateV4toV5(db) {
  for (const [t, c] of [["item", "principal"], ["change_event", "principal"],
    ["app", "kit_version"], ["app", "server_script"], ["file", "backend"]])
    if (db.pragma(`table_info(${t})`).some((x) => x.name === c)) db.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
  db.exec("DROP TABLE IF EXISTS ledger_truncation");
  db.exec("DROP TABLE IF EXISTS report_watermark");
}

// ───────────────────────────────────────────────── v5 → v6: the declaration leaves the document
// W-N (wn-manifest-commit-2026-08-05.md). Before v6 an app declared itself in an embedded
// #oma-manifest block and the manifest column was a projection of it; from v6 the column IS the
// declaration and documents carry no block. This step moves every stored revision across that
// line: derive each revision's manifest by replaying the OLD reader's four-state semantics over
// the app's history (absent = inherit the previous revision — so a revision without a block does
// NOT mean "no manifest", and the walk must restart at nothing across a delete→recreate boundary),
// then strip the block bytes out of every document, head rows included.
//
// STRICT ON PURPOSE: any revision whose block cannot be read cleanly (bad JSON, duplicate,
// shape-invalid — all reachable via the old salvage paths) fails the WHOLE migration and the file
// stays v5, byte-identical, with the offending revisions listed. Quarantining or auto-clearing
// would decide what the author meant; with no installed base, refusing is both safe and honest.
// Runs inside openStore's single immediate transaction — user_version is stamped after, by the
// caller, so an interruption anywhere rolls the store back to v5 whole.
//
// STRICT ABOUT WHAT, THOUGH — the line moved once, on evidence. A rehearsal against a read-only
// copy of six real v0.4.2 stores refused five of them, and not one refusal was corruption: the
// step was strict about its own ASSUMPTIONS (that a revision is addressed by (aggregate_id, seq),
// that the manifest column is a faithful projection) rather than about the data. Both assumptions
// are now checked against the store instead of presumed, and the two REAL refusals — a save event
// with no revision anywhere, and two sides that both declare and disagree — are untouched. The
// rule that survived: refuse what is ambiguous, never what is merely unfamiliar.
function migrateV5toV6(db) {
  // Shape first: rename the slot column, add the revision manifest. ALTERs, not a table rebuild —
  // every other column, index and rowid is untouched by construction.
  db.exec("ALTER TABLE app RENAME COLUMN html TO ui");
  db.exec("ALTER TABLE app_history RENAME COLUMN html TO ui");
  db.exec("ALTER TABLE app_history ADD COLUMN manifest TEXT");
  db.exec(SCHEMA);
  // Oversize guard in SQL before anything is pulled into JS — a hand-edited row cannot force the
  // migration to hold an unbounded string just to refuse it.
  // 800,000 bytes is a FROZEN HISTORICAL number: 4x the 200,000-unit document cap this engine
  // enforced while any v5 store could have been written. It guards hand-edited history rows in a
  // store from that era, so it must not track today's policy — there is no document cap now, and
  // relaxing this one would only let a corrupt v5 row pull an unbounded string into JS to refuse it.
  const big = db.prepare("SELECT name, version FROM app_history WHERE length(CAST(ui AS BLOB)) > 800000").all();
  if (big.length) throw new Error(`v5→v6 migration refused — oversized history revision(s): ${big.map((b) => `${b.name}@${b.version}`).join(", ")}`);

  const failures = [];
  const events = db.prepare(
    "SELECT seq, aggregate_id AS name, event_type, ts FROM change_event WHERE event_type IN ('component_saved','component_deleted') ORDER BY seq ASC").all();
  const saves = events.filter((e) => e.event_type === "component_saved");
  const revisions = db.prepare("SELECT name, version, ts FROM app_history").all();
  const { revisionOf, alias } = resolveRevisions(saves, revisions);

  const readRev = db.prepare("SELECT ui FROM app_history WHERE name = ? AND version = ?");
  const writeRev = db.prepare("UPDATE app_history SET ui = @ui, manifest = @manifest WHERE name = @name AND version = @version");
  const setRevManifest = db.prepare("UPDATE app_history SET manifest = @manifest WHERE name = @name AND version = @version");
  const inherit = new Map();      // name → manifest JSON string | null, within the CURRENT life
  const lastSaved = new Map();    // name → manifest of the newest save seen (head cross-check)
  const headRev = new Map();      // name → the revision row the newest save wrote
  for (const ev of events) {
    if (ev.event_type === "component_deleted") { inherit.delete(alias.get(ev.name) ?? ev.name); continue; }
    const at = revisionOf.get(ev.seq);
    if (!at) { failures.push({ name: ev.name, version: ev.seq, error: "save_event_without_revision" }); continue; }
    const rev = readRev.get(at.name, at.version);
    const m = deriveLegacyManifest(rev.ui, inherit.has(at.name) ? inherit.get(at.name) : null);
    if (m.error) { failures.push({ name: at.name, version: at.version, error: m.error }); continue; }
    inherit.set(at.name, m.manifest);
    lastSaved.set(at.name, m.manifest);
    headRev.set(at.name, at);
    writeRev.run({ name: at.name, version: at.version, ui: stripDeclarationBlock(rev.ui).html, manifest: m.manifest });
  }
  // Head rows: strip the block, and cross-check the derived head manifest against the projection
  // the old engine materialised. Where the two disagree, reconcileHead decides whether one side is
  // simply the only one that ever spoke — refusal is reserved for the case where BOTH speak.
  const setHead = db.prepare("UPDATE app SET ui = @ui, manifest = @manifest WHERE name = @name");
  for (const a of db.prepare("SELECT name, ui, manifest FROM app").all()) {
    // An app row with no save event in the ledger cannot be replayed — derive from the row itself
    // (same four states; absent keeps the materialised column, which is all the truth there is).
    const derived = lastSaved.has(a.name)
      ? { manifest: lastSaved.get(a.name) }
      : deriveLegacyManifest(a.ui, a.manifest ?? null);
    if (derived.error) { failures.push({ name: a.name, version: "head", error: derived.error }); continue; }
    const want = derived.manifest ?? null, have = a.manifest ?? null;
    let adopted = have;             // agreement: the column's own bytes cross the line untouched
    if (!manifestsAgree(want, have)) {
      const r = reconcileHead(want, have);
      if (r.error) { failures.push({ name: a.name, version: "head", error: r.error }); continue; }
      adopted = r.manifest;
      // The column won, so the newest REVISION must carry it too. Not cosmetics: an omitted
      // manifest slot inherits from the head revision (see the save command), so leaving that row
      // null would make the app's next ui-only edit silently clear a declaration this very step
      // just decided to keep. Older revisions stay as derived — what they declared is not knowable.
      if (r.fromColumn && headRev.has(a.name))
        setRevManifest.run({ manifest: adopted, ...headRev.get(a.name) });
    }
    setHead.run({ name: a.name, ui: stripDeclarationBlock(a.ui).html, manifest: adopted });
  }
  if (failures.length)
    throw new Error("v5→v6 migration refused — revision(s) with unreadable declarations (fix or delete these apps " +
      "with the previous release, then retry; the store is untouched):\n" +
      failures.map((f) => `  ${f.name}@${f.version}: ${f.error}`).join("\n"));
}

// ────────────────────────────────────────────────────────── v6 → v7: the live pointer arrives
// One additive CREATE TABLE (live_pointer, see SCHEMA) and nothing else: no row is read, no row is
// rewritten, and an interruption leaves a v6 store exactly as it was.
//
// So why a RUNG at all, when the idempotent DDL every open runs would create the table anyway?
// Because the ladder is the only place that states which builds may WRITE this file, and that is
// the property a wall display depends on. Several hosts share one store; a v0.5.0 process would
// not refuse — it would happily keep serving open_app and never move a pointer it has never heard
// of, and the display would sit on a stale app while the AI opened three others. A silently wrong
// answer is worse than a refusal that names the fix, so the version gate is the mechanism and this
// rung is where it is declared. The table itself stays disposable (see SCHEMA).
function migrateV6toV7(db) {
  db.exec(SCHEMA);
}

/** Which app_history row did each save event write?
 *
 *  The primary key is (aggregate_id, seq): from v0.4.x a save stamps the app's version with the
 *  event's own seq and writes the revision under it, so the pair is exact. It is not exact all the
 *  way back, and a v4 FILE can be much older than the v4 SHAPE — the ladder migrates the file it is
 *  handed, whatever engine started it. Two drifts appear in real v0.4.2 stores, both in seed-era
 *  rows: revisions numbered by a per-app counter (settings@1, settings@2) instead of the seq, and
 *  the system app renamed in place (the ledger still says `gallery`, the tables say `library`).
 *
 *  So when the key misses, fall back to the one thing the two rows provably share: the event and
 *  its revision are written in ONE transaction from ONE clock read, so the timestamps are equal to
 *  the millisecond. That is a JOIN KEY, not a tolerance — it finds a row that exists and never
 *  invents one. It is consulted only after the primary key misses, it must land on exactly one
 *  revision bearing that timestamp, and that revision must not already belong to another event.
 *  Anything else stays unresolved, and an unresolved save event is still fatal.
 *
 *  Returns {revisionOf: Map(seq → {name, version}), alias: Map(ledgerName → tableName)} — the alias
 *  is how a `component_deleted` for the old name still cuts the inheritance chain of the new one. */
function resolveRevisions(saves, revisions) {
  const key = (name, version) => `${name}\u0000${version}`;   // NUL separator: an app name can never hold one, so the pair is unambiguous
  const known = new Set(), byTs = new Map();
  for (const r of revisions) {
    known.add(key(r.name, r.version));
    const at = byTs.get(r.ts);
    if (at) at.push(r); else byTs.set(r.ts, [r]);
  }
  const revisionOf = new Map(), alias = new Map(), claimed = new Set();
  // Exact matches first, ALL of them: a timestamp fallback must never take a row that the primary
  // key already addresses, whichever order the events happen to be in.
  for (const ev of saves)
    if (known.has(key(ev.name, ev.seq))) {
      revisionOf.set(ev.seq, { name: ev.name, version: ev.seq });
      claimed.add(key(ev.name, ev.seq));
    }
  for (const ev of saves) {
    if (revisionOf.has(ev.seq)) continue;
    const cand = byTs.get(ev.ts) || [];
    if (cand.length !== 1 || claimed.has(key(cand[0].name, cand[0].version))) continue;
    revisionOf.set(ev.seq, { name: cand[0].name, version: cand[0].version });
    claimed.add(key(cand[0].name, cand[0].version));
    if (cand[0].name !== ev.name) alias.set(ev.name, cand[0].name);
  }
  return { revisionOf, alias };
}

/** Do the document's declaration and the materialised column say the SAME thing? Both are JSON
 *  strings; key order and whitespace are not a disagreement. A column that will not parse is not a
 *  statement at all — it says "no" here and reconcileHead gives it the refusal, rather than
 *  throwing out of the middle of a migration. */
function manifestsAgree(want, have) {
  if (want === have) return true;
  if (want == null || have == null) return false;
  try { return JSON.stringify(JSON.parse(want)) === JSON.stringify(JSON.parse(have)); }
  catch { return false; }
}

/** The head slot's value when the document and the column disagree.
 *
 *  v0.4.2 materialised the column as a PROJECTION of the document's block, and the projection had
 *  gaps in BOTH directions — neither of which is a corrupt store:
 *
 *    · document declares, column NULL. v0.4.2 never projected a declaration carrying no
 *      `collections` key — the `uses_shared`-only form every App Store app ships. Any store that ever
 *      installed one has this, which is to say nearly every real one.
 *    · document silent, column set. The old upsert's CASE could carry a previous projection forward
 *      across a save whose document dropped the block.
 *
 *  Under the v5 rules the block is the authority and the column is its view, so where only ONE side
 *  ever spoke, that side IS the declaration and refusing would delete a real one. Where BOTH speak
 *  and differ, no rule can elect a winner without deciding what the author meant — that stays fatal,
 *  and it is the case the cross-check was written for. "Refuse rather than guess" applies to genuine
 *  ambiguity; a one-sided statement is not ambiguous. */
function reconcileHead(want, have) {
  if (have == null) return { manifest: want };     // the projection gap: the document declared, the column never caught it
  if (want != null) return { error: "projection_mismatch" };   // both speak, and they differ
  // The column is the only record that this app ever declared anything. It is adopted at the HEAD
  // slot alone — what the older revisions declared cannot be recovered from here, and inventing it
  // is the one thing this step must not do. Evidence has to be well-formed to count: a value this
  // build would refuse at the save door is not a declaration to keep.
  let v;
  try { v = JSON.parse(have); } catch { return { error: "projection_mismatch" }; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "projection_mismatch" };
  if (Object.keys(v).length === 0) return { manifest: null };   // `{}` and NULL are one statement ("nothing declared"), not a disagreement
  if (manifestShapeError(v)) return { error: "projection_mismatch" };
  return { manifest: have, fromColumn: true };
}

/** One legacy revision's manifest, by the OLD four-state reading. Returns {manifest: string|null}
 *  (JSON, ready for the revision column) or {error}. `inherited` is the previous revision's value
 *  within the same life — what `absent` resolves to. */
function deriveLegacyManifest(ui, inherited) {
  const decl = readDeclaration(ui);
  if (decl.state === "bad") return { error: decl.error };
  if (decl.state === "present") {
    const err = manifestShapeError(decl.value);
    if (err) return { error: `bad_manifest: ${err}` };
    return { manifest: JSON.stringify(decl.value) };
  }
  if (decl.state === "empty") return { manifest: null };
  return { manifest: inherited };   // absent — the document says nothing, the previous value stands
}

// `readOnly` opens an EXISTING store to look at, and is the door a caller takes when it has
// promised to write nothing. It is not a convenience: opening for write runs the migration ladder,
// and the v3→v4 climb is ONE-WAY, so `install-app --dry-run` and `install-app --list` both used to
// upgrade the very store they said they would only look at — and on a machine with no store yet,
// create one. A read-only open therefore creates nothing (returns null when the file is absent)
// and migrates nothing (throws when the schema is not the one this build speaks, naming the way
// forward). Any command that claims to be read-only belongs on this door; that is the whole rule.
export function openStore(path, { readOnly = false } = {}) {
  const dbPath = path || process.env.OMA_DB || defaultDbPath();
  if (readOnly && !existsSync(dbPath)) return null;
  if (!readOnly) mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, readOnly ? { readonly: true } : {});
  db.pragma("busy_timeout = 5000");   // N hosts share ONE db → wait out a busy writer instead of throwing SQLITE_BUSY
  // The version gate runs BEFORE the WAL switch: a refusal must leave the file byte-identical,
  // and `journal_mode = WAL` rewrites the header even when nothing else is ever written.
  if (!readOnly) {
    const uvGate = db.pragma("user_version", { simple: true });
    const hasTables = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='item'").get();
    if (uvGate > SCHEMA_VERSION) {
      db.close();
      throw new Error(`store schema is v${uvGate}, this build understands up to v${SCHEMA_VERSION} — update open-mcp-apps`);
    }
    if (hasTables && uvGate !== 4 && uvGate !== 5 && uvGate !== 6 && uvGate !== SCHEMA_VERSION) {
      db.close();
      throw new Error(`store schema is v${uvGate} — this build migrates v4 (v0.4.2), v5 and v6 (v0.5.0), and opens v${SCHEMA_VERSION}. ` +
        `For an older store: read what matters out with the release that wrote it, then start fresh. ` +
        `(Nothing is touched by this refusal — the file is exactly as it was.)`);
    }
    db.pragma("journal_mode = WAL");
  }
  if (readOnly) {
    // The read-only door stops here: no rename, no DDL, no climb. A schema this build does not
    // speak is a refusal with the way forward in it, never a silent one-way upgrade.
    const uv = db.pragma("user_version", { simple: true });
    if (uv !== SCHEMA_VERSION) {
      db.close();
      throw new Error(`store schema is v${uv}, this build speaks v${SCHEMA_VERSION} — a read-only open ` +
        `does not migrate it. Install an app (any command that writes) to upgrade the store, once and one-way.`);
    }
  } else {
    // ONE transaction for the whole open: DDL, the retained migrations and the user_version stamp
    // live or die together — an interrupted open leaves rows, table shape AND version alike
    // untouched, at whichever version the file arrived. Five states are spoken here, and only five:
    //   · a FRESH file (no tables) gets the current schema;
    //   · v4 — the store v0.4.2 released — climbs v4→v5→v6→v7 in this one open;
    //   · v5 — released by nobody, but the shape a mid-development store carries — takes v5→v6→v7;
    //   · v6 — the store v0.5.0 released, so the rung with real users behind it — takes v6→v7;
    //   · v7 — current — runs the idempotent DDL and proceeds.
    // Anything older refuses with the way forward named. The ladder reaches back to the last public
    // release and no further: that is the whole compatibility promise, and it is a CHAIN — a rung
    // is written once and every older store climbs through it, never one direct step per origin.
    // `.immediate()` takes the write lock up front: the v5→v6 step reads before it writes, and a
    // deferred transaction could observe another process's writes between the two.
    db.transaction(() => {
      // The gate above already refused everything but fresh / v4 / v5 / v6 / v7 — re-read, don't re-judge.
      const uv = db.pragma("user_version", { simple: true });
      const fresh = !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='item'").get();
      if (fresh) {
        db.exec(SCHEMA);
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (uv === 4 || uv === 5 || uv === 6) {
        try {
          if (uv === 4) migrateV4toV5(db);
          if (uv <= 5) migrateV5toV6(db);
          migrateV6toV7(db);
        } catch (e) {
          // A v4 reader has never heard of v5 — name the store they actually have before the
          // rung's own verdict. The refusal semantics stay the rung's; only the address is added.
          if (uv === 4) e.message = `your store is v4 (written by v0.4.2), which climbs v4→v5→v6→v7 in one open — the v5→v6 rung refused: ${e.message}`;
          throw e;
        }
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else {
        db.exec(SCHEMA);
      }
    }).immediate();
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
      `INSERT INTO change_event (aggregate_id, command_id, event_type, payload, actor, host, ts)
       VALUES (@aggregate_id, @command_id, @event_type, @payload, @actor, @host, @ts)`),

    // Ledger reads for delta reporting. Ordered seq ASC + LIMIT: the window is the CONTIGUOUS run
    // right after `since`, never a sample with a gap. That ordering is what makes a caller-held mark
    // sound — next_since is the last event you actually saw, and everything you have not seen is
    // still strictly after it. (The old shape served the NEWEST window and skipped the middle; a
    // mark advanced over a skipped event lost it forever — read-plane audit D4.)
    changesSince: db.prepare(
      `SELECT seq, aggregate_id, event_type, payload, actor, host, ts FROM change_event
       WHERE json_extract(payload, '$.collection') = @c AND seq > @since
       ORDER BY seq ASC LIMIT @n`),
    countChangesSince: db.prepare(
      "SELECT COUNT(*) AS n FROM change_event WHERE json_extract(payload,'$.collection') = @c AND seq > @since"),

    itemById: db.prepare("SELECT * FROM item WHERE id = ?"),
    // ONE total order for a collection's rows: (grp, position, id), shared with the paged read
    // (queryItems) and with runtime-core's local apply. Rows sharing a position are ordinary in
    // `settings`, and the confirm_delete resolver reads last-wins — so any divergence here is a
    // UI-says-ask / engine-doesn't-ask split.
    itemsByCollection: db.prepare("SELECT * FROM item WHERE collection = ? ORDER BY grp, position, id"),
    maxPos: db.prepare("SELECT COALESCE(MAX(position),0) AS p FROM item WHERE collection = ? AND grp = ?"),

    // Paged read path (queryItems) — keyset pagination over (grp, position, id), served by
    // idx_item_coll_grp_pos so a page never sorts the whole collection. id is the uniqueness
    // tiebreaker (position collisions are legal).
    countColl: db.prepare("SELECT COUNT(*) AS n FROM item WHERE collection = ?"),
    // Ownership evidence for deleteDisposition (cascade — elegance B1's return, W1). Manifests
    // are read whole (the registry is small, a manifest is one JSON blob); via is dug out of the
    // event payload because change_event has no via column — it rides inside the payload, by
    // design (the shadow edge is not a schema field).
    allCompManifests: db.prepare("SELECT name, manifest FROM app WHERE manifest IS NOT NULL"),
    viaByCollection: db.prepare(
      `SELECT DISTINCT json_extract(payload, '$.collection') AS collection,
                       json_extract(payload, '$.via.app') AS via
         FROM change_event
        WHERE event_type LIKE 'item_%'
          AND json_extract(payload, '$.via.app') IS NOT NULL
          AND json_extract(payload, '$.collection') IS NOT NULL`),
    countSettingsGroup: db.prepare("SELECT COUNT(*) AS n FROM item WHERE collection = 'settings' AND grp = ?"),
    // "Did this collection exist before this app did?" — the cheap question that separates the
    // app's own rows from rows that were already there when an app of the same name showed up.
    // Both answers come off the ledger, which never goes backwards — and since retention/prune
    // retired (elegance A2, append-only unbounded), the ledger is COMPLETE, so the old
    // truncation-makes-this-unknowable branch (N9) has nothing left to guard.
    firstCollEvent: db.prepare("SELECT COALESCE(MIN(seq), 0) AS v FROM change_event WHERE json_extract(payload,'$.collection') = ?"),
    firstCompEvent: db.prepare("SELECT COALESCE(MIN(seq), 0) AS v FROM change_event WHERE aggregate_id = ? AND event_type = 'component_saved' AND seq > ?"),
    delSettingsGroup: db.prepare("DELETE FROM item WHERE collection = 'settings' AND grp = @grp"),
    delCollectionRows: db.prepare("DELETE FROM item WHERE collection = @collection"),
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
    // key is a cheap aggregate that changes whenever any manifest-bearing app row changes.
    manifestKey: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(version),0) AS sv, COALESCE(MAX(updated_at),'') AS u FROM app WHERE manifest IS NOT NULL"),
    manifestRows: db.prepare("SELECT name, manifest FROM app WHERE manifest IS NOT NULL ORDER BY updated_at ASC, name ASC"),
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
    compByName: db.prepare("SELECT * FROM app WHERE name = ?"),
    // WHERE THIS APP'S CURRENT LIFE BEGINS — 0 if it has only ever had one.
    //
    // A delete is a tombstone, so the ledger and app_history keep everything the PREVIOUS
    // holder of a name left behind, and a name can be reused. Two destructive decisions were
    // reading those leftovers as if they described the app that bears the name now (see
    // deleteDisposition and appHistory). Both need the same question answered, so it is
    // asked once, here.
    //
    // "The most recent delete that was FOLLOWED BY a save." The `EXISTS` is what makes the
    // tombstone case come out right: an app that was deleted and never recreated has no save after
    // its final delete, so that delete does not start a new life and the app still owns the life it
    // had — which is exactly the promise `app_history` makes ("history survives delete").
    lifeStart: db.prepare(
      `SELECT COALESCE(MAX(d.seq), 0) AS v
         FROM change_event d
        WHERE d.aggregate_id = ? AND d.event_type = 'component_deleted'
          AND EXISTS (SELECT 1 FROM change_event s
                       WHERE s.aggregate_id = d.aggregate_id
                         AND s.event_type = 'component_saved' AND s.seq > d.seq)`),
    histSince: db.prepare("SELECT version, ts, length(ui) AS ui_size FROM app_history WHERE name = ? AND version > ? ORDER BY version DESC"),
    // "Is there an app outside this set?" — EXISTS stops at the first row instead of scanning
    // the registry, and json_each keeps ONE prepared statement for any set, so the store never has
    // to know WHICH apps are the engine's own. That stays an engine-level concept.
    hasCompOutside: db.prepare(
      "SELECT EXISTS(SELECT 1 FROM app WHERE name NOT IN (SELECT value FROM json_each(?))) AS v"
    ),
    // `fn_count` is COUNTED IN SQL on purpose: the row set feeds list_apps, and pulling every
    // manifest document into JS to count one key would make the cheapest read in the registry
    // scale with the size of every declaration in it. json_type guards the NULL/absent cases so
    // json_each is only reached for a real object.
    allComps: db.prepare("SELECT name, version, description, author, json_extract(scene, '$.category_id') AS category_id, CASE WHEN manifest IS NULL THEN 0 ELSE 1 END AS has_manifest, CASE WHEN json_type(manifest, '$.functions') = 'object' THEN (SELECT COUNT(*) FROM json_each(app.manifest, '$.functions')) ELSE 0 END AS fn_count, kind, visibility, updated_at, length(ui) AS ui_size FROM app ORDER BY name"),
    // v6: the slots resolve BEFORE this statement runs (save_app's tri-state manifest and slot
    // inheritance live in the command handler), so every column here is written outright — the
    // old scene_set/manifest_set three-state and the kind COALESCE retired with the block:
    // projections are recomputed from the resolved manifest on every save, never carried.
    insComp: db.prepare(
      `INSERT INTO app (name, version, ui, description, author, scene, manifest, kind, visibility, updated_at)
       VALUES (@name, @version, @ui, @description, @author, @scene, @manifest, @kind,
               COALESCE(@visibility, 'listed'), @ts)
       ON CONFLICT(name) DO UPDATE SET version = @version, ui = @ui,
         description = CASE WHEN @description = '' THEN app.description ELSE @description END,
         author = @author, scene = @scene, manifest = @manifest, kind = @kind,
         visibility = COALESCE(@visibility, app.visibility),
         updated_at = @ts`),
    insCompHist: db.prepare("INSERT OR REPLACE INTO app_history (name, version, ui, manifest, ts) VALUES (@name, @version, @ui, @manifest, @ts)"),
    // Human-push retention (HUMAN_HISTORY_KEEP_DAYS). Scoped to ONE app and to revisions strictly
    // BELOW the row just written, so the head survives however old the app is.
    pruneAppHist: db.prepare("DELETE FROM app_history WHERE name = @name AND version < @head AND ts < @cutoff"),
    compHist: db.prepare("SELECT version, ts, length(ui) AS ui_size FROM app_history WHERE name = ? ORDER BY version DESC"),
    compVersion: db.prepare("SELECT name, version, ui, manifest, ts FROM app_history WHERE name = ? AND version = ?"),
    // Head revision — what an omitted slot inherits (W-N). From the REVISION table, never the
    // projection columns: projections are rebuildable caches, and inheriting from one would
    // quietly promote it to a second source.
    headRev: db.prepare("SELECT ui, manifest FROM app_history WHERE name = ? ORDER BY version DESC LIMIT 1"),
    delComp: db.prepare("DELETE FROM app WHERE name = ?"),
    setCompVisibility: db.prepare("UPDATE app SET visibility = @visibility, version = @version, updated_at = @ts WHERE name = @name"),

    // File plane — ref index only (bytes live on disk, the channel's job). All reads are app-scoped.
    fileByKey: db.prepare("SELECT * FROM file WHERE app = ? AND path = ?"),
    filesByApp: db.prepare("SELECT app, path, sha256, size, mime, version, created_at, updated_at FROM file WHERE app = ? ORDER BY path"),
    fileUsageStmt: db.prepare("SELECT COALESCE(SUM(size),0) AS bytes, COUNT(*) AS count FROM file WHERE app = ?"),
    fileUsageTotalStmt: db.prepare("SELECT COALESCE(SUM(size),0) AS bytes, COUNT(*) AS count FROM file"),
    blobRefcountStmt: db.prepare("SELECT COUNT(*) AS n FROM file WHERE app = ? AND sha256 = ?"),
    filesSeq: db.prepare("SELECT COALESCE(MAX(seq),0) AS v FROM change_event WHERE event_type = 'file_written' OR event_type = 'file_deleted'"),
    insFile: db.prepare(
      `INSERT INTO file (app, path, sha256, size, mime, version, created_at, updated_at)
       VALUES (@app, @path, @sha256, @size, @mime, @version, @ts, @ts)
       ON CONFLICT(app, path) DO UPDATE SET sha256 = @sha256, size = @size, mime = @mime,
         version = @version, updated_at = @ts`),
    delFile: db.prepare("DELETE FROM file WHERE app = @app AND path = @path"),

    // The live pointer (see SCHEMA). ONE statement writes it, and it is an UPSERT rather than a
    // read-then-write: two hosts opening apps at the same instant must produce two different
    // values of `n`, never the same one twice, or a display sitting on the losing write would
    // see a counter that never moved and stay on the app nobody is looking at.
    touchLive: db.prepare(
      `INSERT INTO live_pointer (id, app, ts, n) VALUES (1, @app, @ts, 1)
       ON CONFLICT(id) DO UPDATE SET app = @app, ts = @ts, n = n + 1`),
    liveGet: db.prepare("SELECT app, ts, n FROM live_pointer WHERE id = 1"),
    liveN: db.prepare("SELECT COALESCE((SELECT n FROM live_pointer WHERE id = 1), 0) AS v"),

    // Undo reads. lastEventFor is served by the PK index on seq (DESC scan, LIMIT 1).
    lastEventFor: db.prepare("SELECT seq, aggregate_id, event_type, payload FROM change_event WHERE aggregate_id = ? ORDER BY seq DESC LIMIT 1"),
    // Data-pane ledger window (newest first) — the internal read that keeps `via`.
    recentEventsAll: db.prepare("SELECT seq, event_type, aggregate_id, actor, host, ts, payload FROM change_event ORDER BY seq DESC LIMIT @n"),
    recentEventsColl: db.prepare("SELECT seq, event_type, aggregate_id, actor, host, ts, payload FROM change_event WHERE json_extract(payload,'$.collection') = @c ORDER BY seq DESC LIMIT @n"),
    compHistory: db.prepare("SELECT version, ui, manifest FROM app_history WHERE name = ? ORDER BY version DESC"),
    settingByKey: db.prepare("SELECT fields FROM item WHERE collection = 'settings' AND json_extract(fields,'$.key') = ?"),
  };

  const rowToItem = (r) => ({
    id: r.id, group: r.grp, position: r.position,
    fields: JSON.parse(r.fields), version: r.version,
  });

  // collection → { apps, spec } from declared manifests. Cached, but the cache key is a
  // per-call aggregate query so N processes sharing this db never validate against stale rules.
  //
  // Collections are SHARED substrate: N apps may steward the same one (a parent embedding a
  // child that reads it, an app exposing a function another app calls, several views of one dataset).
  // So declarations UNION rather than overwrite: the field set is the union, a key declared twice
  // resolves to the LAST declaration in updated_at order (deterministic) and is reported in
  // `conflicts`, and `strict` holds only if EVERY declarer asked for it — one app tightening
  // its own view must not start rejecting a sibling's writes. `apps` lists every declarer, so
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
            mMap.set(coll, { apps: [r.name], spec: { ...spec }, conflicts: [] });
            continue;
          }
          prev.apps.push(r.name);
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

  // Validate a command's `via` stamp into the frozen object form, or drop it. App names
  // follow the registry rule; `function` (write-set F's second key) is carried when present so
  // the shape never has to change again once function writes start stamping it.
  const VIA_APP_RE = /^[a-z][a-z0-9-]{0,31}$/;
  const viaOf = (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const app = String(v.app ?? "");
    if (!VIA_APP_RE.test(app)) return undefined;
    const fn = v.function != null ? String(v.function).slice(0, 64) : null;
    return fn ? { app, function: fn } : { app };
  };

  // ---- confirmation-policy gate (W-S, §2.5-A/B — the chokepoint every destructive command hits).
  // Lives INSIDE the store because the store is the only layer every write path shares: the tool
  // face, the batch, the runner bridge and any future caller all pass through core(), so there is
  // no route around it and no second copy of the rule anywhere. `privileged` (the ledger-reverse /
  // undo path and security_set) is exempt: a reversal is itself the user's explicit act on a fact
  // the ledger holds. Agent-actor commands are exempt in W-S — the conversation is the model's
  // confirmation channel today; W1 pilots delivering the same demand over MRTR.
  const requestState = createRequestStateCodec({ secret: storeSecret(dbPath, { readOnly }) });
  // The user's answer to "ask me before deleting", resolved from the SAME rows in the SAME
  // order with the SAME coercion the renderer uses — deliberately reusing the snapshot query
  // rather than asking SQL a cleverer question. A resolver of its own is how the store came to
  // read `"FALSE"` as off, and rowid order as precedence, while the settings UI showed the
  // opposite: the UI promising a confirmation the engine had already decided not to ask for
  // (codex review, both halves reproduced). Merge order is oma.pref's: app override ▸ global
  // ▸ catalog default, later rows winning inside each layer.
  //
  // PRESENCE and VALUE are tracked apart, because the renderer's Map keeps them apart: it does
  // `map.set(key, row.fields.value)`, so a row whose `value` is missing still makes `has(key)`
  // true and OVERRIDES the global layer. Collapsing the two into `value !== undefined` made a
  // valueless app row fall through to a global `false` while the UI showed the app's own layer
  // resolving to the default ON — a second UI-says-ask / engine-doesn't-ask split (codex review,
  // reproduced). Merge order is oma.pref's: app override ▸ global ▸ catalog default.
  const confirmPrefOn = (viaApp) => {
    const rows = q.itemsByCollection.all(SETTINGS_COLLECTION).map(rowToItem);
    const own = viaApp ? latestPref(rows, "confirm_delete", viaApp) : undefined;
    const global = latestPref(rows, "confirm_delete");
    return coercePref(own ? own.fields.value : global ? global.fields.value : undefined, true);
  };
  function confirmationGate(command, privileged, via, { target, version, preview, collection }) {
    if (privileged || !CONFIRMATION_CLASSES[command.type].confirm || command.actor !== "human") return null;
    const viaApp = (via && via.app) || "";
    // `require_confirmation` is how a CALLER raises the bar on itself — the embedder's
    // `delete_items: "confirm"` tier speaks through it. It can only ever add a confirmation,
    // never remove one, which is why it is safe to accept from an untrusted child.
    if (command.require_confirmation !== true && !confirmPrefOn(viaApp)) return null;
    const binding = { type: command.type, caller: command.actor + "|" + viaApp, target, version };
    if (command.request_state != null) {
      const v = requestState.verify(String(command.request_state), binding);
      // Verified = the user saw THIS row at THIS version and said yes. Consumption is the
      // execution itself: versions are ledger seqs and never recur (see confirmation.mjs).
      if (v.ok) return null;
      return { ok: false, error: v.error, id: target, collection };
    }
    const issued = requestState.issue(binding);
    // A DEMAND, not an error — so it carries a boolean discriminator and no `error` name, exactly
    // the shape `conflict` has had all along (store says `conflict: true`; the tool layer mints the
    // wire word "version_conflict"). It briefly carried BOTH, which made one fact answer to three
    // names — `error`, the boolean, and the wire `reason` — with the `error` one also claiming
    // something untrue. An unverifiable state IS a failure and keeps its `error`.
    return { ok: false, confirmation_required: true, id: target, collection,
             request_state: issued.state, expires_at: issued.expires_at, preview: preview() };
  }

  function core(command, privileged) {
    const { type, command_id, actor = "agent", host = null } = command;
    // `actor` means two different things, and only one of them is a closed set.
    //   · on a DATA write it is the class that wrote (E13b) — closed, so an anonymous write can
    //     never land labelled "human" and become permanently unattributable in the ledger;
    //   · on save_app it becomes the app's `author`, which tierOf() reads as
    //     PROVENANCE — an unrecognised author is precisely how a third-party app earns the
    //     'unreviewed' tier. Closing that set would make every app local-tier by
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
      const APP_CMDS = type === "save_app" || type === "delete_app" || type === "archive_app";
      const target = APP_CMDS
        ? String(command.name || "").trim()
        : type === "write_file" || type === "delete_file"
        ? String(command.app || "") + "/" + String(command.path || "")
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
        if (APP_CMDS) {
          out.name = seen.aggregate_id;
          if (type !== "delete_app") out.version = seen.seq;
          // A replayed cascade must describe what THAT delete took (cascade retired 2026-08-04,
          // returned in W1) — the payload records it, and a keep-delete's replay must NOT answer
          // yes to a cascade retry. Echoed in the LIVE receipt's shape (cascaded = the collection
          // list, settings_keys beside it), so a retry and its original read identically.
          if (type === "delete_app" && payload.cascaded) {
            out.cascaded = payload.cascaded.collections || payload.cascaded;
            if (payload.cascaded.settings_keys !== undefined) out.settings_keys = payload.cascaded.settings_keys;
          }
          // The ORIGINAL flip's outcome, not the current column — an archive replayed after a later
          // unarchive must describe what the archive did, or the retry reads current state as its own.
          if (type === "archive_app" && payload.to) out.visibility = payload.to;
        } else if (type === "write_file" || type === "delete_file") {
          out.app = String(command.app || "");
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
    // advisory provenance the runtime/runner stamps on WIDGET writes, {app[, function]}.
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
      const info = q.appendEvent.run({ aggregate_id, command_id: extraReceipt ? randomUUID() : command_id, event_type, payload: JSON.stringify({ ...payload, sv: SCHEMA_VERSION }), actor, host, ts });
      return { seq: Number(info.lastInsertRowid), prev_collection_seq: prev };
    };

    if (type === "add_item") {
      const coll = String(command.collection || "").trim();
      if (!coll) return { ok: false, error: "collection_required" };
      const grp = String(command.group ?? "");
      if (grp.length > MAX_GROUP_CHARS) return { ok: false, error: "group_too_long", limit: MAX_GROUP_CHARS };
      const fields = command.fields && typeof command.fields === "object" ? command.fields : {};
      if (coll === SETTINGS_COLLECTION) {
        const k = String(fields.key ?? "");
        if (SECRET_KEY_RE.test(k)) return secretKeyRefusal(k);
        if (!privileged && RESERVED_KEY_RE.test(k)) return { ok: false, error: "reserved_key" };
      }
      const fieldsJson = JSON.stringify(fields);
      if (fieldsJson.length > MAX_ITEM_FIELDS_BYTES) return { ok: false, error: "fields_too_large" };
      const man = manifestFor(coll);
      if (man) {
        const violations = fieldViolations(man.spec, fields);
        if (violations.length) return { ok: false, error: "schema_violation", violations, collection: coll, manifest_app: man.apps.join(", ") };
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
      if (row.collection === SETTINGS_COLLECTION) {
        const existingKey = String(JSON.parse(row.fields).key ?? "");
        const newKey = command.fields && "key" in command.fields ? String(command.fields.key ?? "") : "";
        if (SECRET_KEY_RE.test(existingKey)) return secretKeyRefusal(existingKey);
        if (SECRET_KEY_RE.test(newKey)) return secretKeyRefusal(newKey);
        if (!privileged && (RESERVED_KEY_RE.test(existingKey) || RESERVED_KEY_RE.test(newKey)))
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
        if (violations.length) return { ok: false, error: "schema_violation", violations, id: row.id, collection: row.collection, item: rowToItem(row), manifest_app: man.apps.join(", ") };
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
      if (row.collection === SETTINGS_COLLECTION) {
        const k = String(JSON.parse(row.fields).key ?? "");
        if (SECRET_KEY_RE.test(k)) return secretKeyRefusal(k);
        if (!privileged && RESERVED_KEY_RE.test(k)) return { ok: false, error: "reserved_key" };
      }
      // Last check before execution, first-refusal order preserved: a stale caller learns about
      // the conflict, a forbidden caller about the policy, and only a permitted, current delete
      // is asked to confirm. The gate binds row.version, so verifying IS re-authorizing.
      const demand = confirmationGate(command, privileged, via,
        { target: row.id, collection: row.collection, version: row.version, preview: () => deletePreview(JSON.parse(row.fields)) });
      if (demand) return demand;
      q.delItem.run({ id: row.id });
      // On a delete the WHOLE row is the pre-image: nothing else survives to reconstruct it from.
      const m = emit(row.id, "item_deleted", { collection: row.collection, was: JSON.parse(row.fields), group: row.grp, position: row.position, ...(via ? { via } : {}) });
      // No `item`: it is gone. The id is what the caller needs to drop it locally.
      return { ok: true, id: row.id, collection: row.collection, ...m, deleted: true };
    }

    if (type === "save_app") {
      const name = String(command.name || "").trim();
      if (!APP_NAME_RE.test(name)) return { ok: false, error: "bad_name" };
      // OCC before any slot work: the conflict answer carries the version it actually found,
      // which is everything a retry needs. Same contract as an item write — one vocabulary.
      const existing = q.compByName.get(name);
      // Fail CLOSED against a missing row too: the token said "on top of vN" and the row is gone —
      // recreating would resurrect a deletion behind the caller's back. Deletion is recoverable
      // (history + undo), so a conflict here loses nothing and protects intent.
      if (command.expected_version != null && !existing)
        return { ok: false, conflict: true, expected: null, deleted: true, name };
      if (command.expected_version != null && existing && existing.version !== command.expected_version)
        return { ok: false, conflict: true, expected: existing.version, name, size: existing.ui.length };
      // PROVENANCE IS NOT OVERWRITABLE. The row's `author` column is what tierOf() reads to decide
      // whether an app runs DIRECT with the AI's own trust or behind the sandboxed runner, and
      // the insert below stamps it from this command's actor. Without this line a save on top of an
      // existing row silently RE-STAMPS provenance — measured: an app stored by "guest"
      // (tier unreviewed, call_tools []) became author "agent" (tier local, call_tools ["*"]) after
      // one save_app carrying the right expected_version. Full escalation, one call.
      //
      // It sits HERE, in the store, because six paths write app html and every one of them
      // would need its own copy of the check otherwise: save_app, edit_app,
      // restore_app, the render-health auto-revert, install_from_app_store, and undo — the last
      // one from inside this file. install_from_app_store already carries the tool-level twin of this
      // rule ("already exists as a %s-authored app"); this is the wall the other five were missing.
      //
      // The rule is SYMMETRIC (tier must not change), not just anti-escalation: a demotion cannot
      // grant capability, but it is still one actor rewriting another's provenance, and one sentence
      // is cheaper to hold than a direction. Consequence to know when a third-party ingress lands:
      // a non-local app is managed by the path that installed it — the AI cannot edit it, and
      // undo/restore/auto-revert (all local actors) will not touch it either. Renaming or deleting
      // it stays available, and a same-tier ingress can overwrite it normally.
      if (existing && tierOf(existing.author) !== tierOf(actor))
        return { ok: false, error: "provenance_locked", name, author: existing.author, tier: tierOf(existing.author) };
      // BUILT OUTSIDE ⇒ READ-ONLY TO THE MODEL. An app whose ui references its own bundle
      // (`oma-asset:`) is a TEMPLATE, not a source: the thing an edit would have to change lives in
      // a project on someone's disk. Rewriting the template from here does not change the app, it
      // desynchronises it from the build that produced it — and the model has no way to notice,
      // because the template renders fine either way.
      //
      // Structural, not a name: the test is what the stored document IS, never an `author` string
      // (which is why `human` could be reused for this door at all — provenance answers "how much
      // trust", this answers "where is the source"). Keyed on the ACTOR because the human running
      // the CLI is the one holding that project: re-pushing is the supported edit.
      //
      // It sits HERE for the same reason provenance_locked does — six paths write app html, and a
      // rule that lives in one tool is a rule five other doors do not have. Two of those doors are
      // refused as a deliberate consequence rather than an accident:
      //   · restore_app — rolling the template back pairs an old mount point with the CURRENT
      //     bundle in the file plane, a state no build ever produced;
      //   · promote_app — it touches only the manifest, but the manifest of a built app is a FILE
      //     in that build (install-app.mjs --manifest), so flipping `kind` here is the same
      //     desynchronisation one slot over. Change it in the project and push again.
      // (install_from_app_store needs no branch here: it already refuses any app it did not author.)
      if (existing && actor === "agent" && hasAssetReferences(existing.ui))
        return { ok: false, error: "built_outside", name };
      // ── the two slots (W-N) ────────────────────────────────────────────────────────────────────
      // A save addresses the app's slots — `ui` (the document) and `manifest` (the declaration,
      // now a structured value and the AUTHORITY, not a projection of anything). Slot semantics,
      // frozen in wn-manifest-commit-2026-08-05.md:
      //   · an omitted slot INHERITS the head revision's value — read from app_history, never from
      //     the projection columns, which are rebuildable caches and must not become a second source;
      //   · manifest is tri-state: omitted = inherit, null = clear, object = replace whole;
      //     {} is refused — it reads as both "a legal empty declaration" and the legacy
      //     "empty block clears", and one spelling must not carry two meanings;
      //   · creating needs a ui; touching neither slot on an overwrite is a no-op asked wrongly.
      // This lives HERE, in the command handler, because six paths write apps without the save_app
      // tool (edit_app, restore_app, install_from_app_store, undo, seed) and every one of them gets
      // the same slot contract by construction.
      const hasUi = command.ui !== undefined;
      const hasManifest = "manifest" in command;
      if (!existing && !hasUi) return { ok: false, error: "ui_required_on_create" };
      if (existing && !hasUi && !hasManifest) return { ok: false, error: "no_slots_provided" };
      const head = existing ? q.headRev.get(name) : null;

      let ui;
      if (hasUi) {
        ui = String(command.ui || "");
        // Every atom has a face. `empty_ui` is a VALIDITY rule, not a size floor: an app is
        // something a person opens, so an app with nothing to render is malformed — while a
        // 1-char app is merely small, and small is reversible. The real defence against a stub
        // overwriting a live app is that every save is recoverable (history + undo) and the
        // ack reports its size delta out loud.
        if (!ui.trim()) return { ok: false, error: "empty_ui" };
        // A document still carrying the legacy #oma-manifest block is a caller transcribing pre-v6
        // examples. Refused LOUDLY: accepted as inert bytes it would be "I declared something and
        // nothing happened" — the worst outcome the old reader was built to prevent.
        if (mentionsDeclarationTag(ui)) return { ok: false, error: "embedded_manifest_block" };
        // Asset references are checked for SYNTAX only, and deliberately not for existence: a push
        // is two writes (template + bundle) and neither order may be the wrong one. What is refused
        // is a reference the file plane could never satisfy — a path with "..", or one outside
        // FILE_PATH_RE — because that one is unresolvable no matter what is uploaded afterwards.
        const assetErr = assetSyntaxError(ui);
        if (assetErr) return { ok: false, error: "bad_asset_ref", detail: assetErr };
      } else {
        if (!head) return { ok: false, error: "no_revision" };   // existing without history — impossible by construction, refuse over guessing
        ui = head.ui;
      }

      let manifestJson, manifestAction;
      if (hasManifest) {
        const mv = command.manifest;
        if (mv === null) { manifestJson = null; manifestAction = "cleared"; }
        else if (typeof mv === "object" && !Array.isArray(mv)) {
          if (Object.keys(mv).length === 0) return { ok: false, error: "empty_manifest_use_null" };
          const err = manifestShapeError(mv);
          if (err) return { ok: false, error: "bad_manifest", detail: err };
          manifestJson = JSON.stringify(mv);
          manifestAction = "replaced";
        } else return { ok: false, error: "bad_manifest", detail: "manifest must be a JSON object or null" };
      } else {
        manifestJson = head ? (head.manifest ?? null) : null;
        manifestAction = "inherited";
      }
      // Projections — recomputed from the resolved manifest on EVERY save, never carried forward
      // by column-level COALESCE: the columns exist so the App Store and list_apps need not parse
      // JSON, and staying derived is what keeps them rebuildable instead of a second source.
      const mObj = manifestJson ? JSON.parse(manifestJson) : null;
      // The function JOIN, on the RESOLVED pair — either slot may be inherited, and the invariant
      // is about what the app IS after this save: every declared function has its body block,
      // every body block is declared. Both directions refuse loudly (functions.mjs header: each
      // is the same silence wearing a different hat). Validated here in the command so all six
      // app-writing paths (save_app, edit_app, restore, install, undo, seed) get the same door.
      const fnErr = functionsJoinError(mObj, ui);
      if (fnErr) return { ok: false, error: "bad_functions", detail: fnErr };
      const kind = mObj && mObj.kind != null ? String(mObj.kind) : "app";
      if (!APP_KINDS.has(kind)) return { ok: false, error: "unknown_kind" };
      const scene = mObj && mObj.scene && typeof mObj.scene === "object" ? JSON.stringify(mObj.scene) : null;
      const existed = existing;
      const visibility = command.visibility === undefined ? null : String(command.visibility);
      if (visibility !== null && !VISIBILITIES.has(visibility)) return { ok: false, error: "unknown_visibility" };
      // Append first, then stamp the row with this event's seq — same rule as an item write. It also
      // retires the old "continue from the tombstoned history's MAX(version)" dance: version
      // continuity across delete/recreate is now free, because the ledger never goes backwards.
      const m = emit(name, "component_saved", { name, size: ui.length, created: !existed, manifest_action: manifestAction });
      const version = m.seq;
      q.insComp.run({ name, version, ui, description: String(command.description || ""), author: actor, scene, manifest: manifestJson, kind, visibility, ts });
      const comp = q.compByName.get(name);
      q.insCompHist.run({ name, version: comp.version, ui, manifest: manifestJson, ts });
      // …and then sweep this app's stale revisions — but only when a human push lands on a HUMAN
      // APP (HUMAN_HISTORY_KEEP_DAYS). Both halves are load-bearing, and keying on the actor alone
      // was WRONG: `undoLast` re-saves an app's previous revision with actor "human" (this file,
      // the component_saved branch), and agent↔human are the same tier so provenance_locked does
      // not separate them. One click of Undo in the Data pane, on an AI-authored app with weeks of
      // checkpoints, would have permanently deleted every checkpoint older than the window — a
      // recovery action destroying the recovery points, irreversibly. The rule Leo stated is about
      // the APP ("a pushed app keeps no version stock"), so the app is what it asks about.
      // The comparison is against a cutoff computed in JS, NOT SQLite's datetime('now'): `ts` is an
      // ISO-8601 string with a T and a Z, datetime() renders a space-separated one, and the two sort
      // against each other silently and wrongly. Same-format strings compare exactly like the
      // instants they name, which is the whole reason this column is ISO.
      // `version < head` is what makes the current revision unsweepable at any age — the head row
      // IS the app (headRev reads it for slot inheritance), so an empty-handed sweep must be
      // impossible rather than merely unlikely.
      if (actor === "human" && existing && existing.author === "human") {
        const cutoff = new Date(Date.now() - HUMAN_HISTORY_KEEP_DAYS * 86_400_000).toISOString();
        q.pruneAppHist.run({ name, head: comp.version, cutoff });
      }
      const notes = [];
      // Declaration-quality notes ride the ack and are computed AFTER the row is written, because
      // both need the saved state: the union a shared collection now resolves to, and whether this
      // label_field names a declared field. Warnings, not rejections — a shared collection stays
      // shared, and a fuzzy label falls back to the heuristic instead of blocking the save.
      if (manifestAction === "replaced" && mObj.collections && typeof mObj.collections === "object") {
        for (const [coll, spec] of Object.entries(mObj.collections)) {
          if (!spec || typeof spec !== "object") continue;
          if (spec.label_field && spec.fields && !(spec.label_field in spec.fields))
            notes.push(`Collection "${coll}": label_field "${spec.label_field}" is not among its declared fields — summaries will fall back to the built-in heuristic.`);
          const man = manifestFor(coll);
          if (man && man.apps.length > 1 && man.conflicts.length)
            notes.push(`Collection "${coll}" is declared by ${man.apps.join(" and ")} — conflicting key(s): ${man.conflicts.join(", ")}; the most recently saved declaration wins.`);
        }
      }
      // The size pair travels on EVERY save, unconditionally — that is what makes a suspicious
      // shrink (82,623 → 74 chars) announce itself instead of waiting to be asked. `manifest`
      // rides back so tool-side diagnostics (suggested_kind) read the RESOLVED declaration
      // instead of re-deriving inheritance.
      return { ok: true, name, version: comp.version, created: !existed, size: ui.length,
        prev_size: existed ? existing.ui.length : null, kind: comp.kind,
        manifest_action: manifestAction, manifest: manifestJson,
        ...(notes.length ? { note: notes.join(" ") } : {}) };
    }

    if (type === "delete_app") {
      const name = String(command.name || "").trim();
      const existed = q.compByName.get(name);
      if (!existed) return { ok: false, error: "not_found" };
      // Two dispositions, caller-stated (the tool defaults to "keep"):
      //   keep    — tombstone semantics: only the registry row goes. app_history rows are
      //             RETAINED (the delete stays auditable, the ui recoverable) and so are the data
      //             rows and settings items; the settings app's Orphaned section is the janitor.
      //   cascade — "delete means delete" (Leo 2026-07-28, delete-cascade-design.md; returned in
      //             W1 after elegance B1 removed the bespoke plan_token protocol). Takes the rows
      //             this app is PROVABLY the only user of, plus its own settings group. NOT
      //             undoable, and that is not a gap: component_deleted has no undo branch either,
      //             so this widens what a permanent act removes — it does not make a reversible
      //             act irreversible. Archive is the "keep everything" verb.
      const disposition = command.data == null ? "keep" : String(command.data);
      if (disposition !== "keep" && disposition !== "cascade") return { ok: false, error: "bad_data_disposition" };
      let cascaded = null;
      if (disposition === "cascade") {
        const plan = computeDisposition(name);
        if (!privileged) {
          // Cascade demands confirmation UNCONDITIONALLY — every actor, regardless of the
          // confirm_delete preference. The pref tunes friction on recoverable row deletes; this
          // destroys whole collections with no undo, and the demand doubles as the channel that
          // carries the disposition plan to whoever faces the user. Delivery is W-S branch ②
          // (fail-closed two-step) — the request_state codec, not a bespoke plan token: the
          // binding's `version` is the WORLD the user was shown (app version + every candidate
          // collection's ledger position + the settings stream), so any write that could change
          // the plan invalidates the answer. verify() failing here means "the world moved" —
          // the caller re-sends WITHOUT the state and gets a fresh plan (plan_changed, two steps).
          const world = existed.version + "|" +
            plan.collections.map((c) => c.collection + ":" + c.seq).join(",") + "|s:" + plan.settings_seq;
          const binding = { type: "delete_app#cascade", caller: actor + "|" + ((via && via.app) || ""), target: name, version: world };
          if (command.request_state != null) {
            const v = requestState.verify(String(command.request_state), binding);
            if (!v.ok) return { ok: false, error: v.error, name };
          } else {
            const issued = requestState.issue(binding);
            const rows = plan.collections.filter((c) => c.verdict === "exclusive").reduce((s, c) => s + c.rows, 0);
            return { ok: false, confirmation_required: true, name,
                     request_state: issued.state, expires_at: issued.expires_at,
                     preview: name + " and its data — " + plan.exclusive.length + " collection(s), " + rows + " row(s), " + plan.settings_keys + " setting(s); shared/unknown collections are kept",
                     plan: plan.collections, settings_keys: plan.settings_keys };
          }
        }
        // 🔴 The eligible set is what computeDisposition says NOW — recomputed in this very
        // transaction, never taken from the caller. `shared` and `unknown` are always kept: the
        // asymmetry decides it — deleting too little leaves rows a user can remove again;
        // deleting too much silently breaks a second app and the data is gone.
        const removed = [];
        for (const coll of plan.exclusive) {
          const n = q.countColl.get(coll).n;
          q.delCollectionRows.run({ collection: coll });
          removed.push({ collection: coll, rows: n });
          // A receipt IN THAT COLLECTION'S STREAM. component_deleted alone was not enough: the
          // per-collection ledger reads filter on payload.collection, so a data_changes call
          // scoped to this collection would be told "nothing changed" while every row in it had
          // just been destroyed. One event per cleared collection keeps the cascade one decision
          // while making each collection's own history tell the truth.
          if (n) emit(coll, "rows_cleared", { collection: coll, rows: n, app: name }, true);
        }
        const settingsRemoved = q.countSettingsGroup.get(name).n;
        if (settingsRemoved) {
          q.delSettingsGroup.run({ grp: name });
          // Same for the settings collection — and this one also has to land, because
          // settings_version is derived from events carrying collection:"settings".
          emit(SETTINGS_COLLECTION, "rows_cleared", { collection: SETTINGS_COLLECTION, group: name, rows: settingsRemoved, app: name }, true);
        }
        cascaded = { collections: removed, settings_keys: settingsRemoved };
      }
      q.delComp.run(name);
      // ONE event for the whole act — a cascade is one decision, not N. What it took is IN the
      // payload, so the audit trail can answer "where did those rows go".
      emit(name, "component_deleted", { name, version: existed.version, ...(cascaded ? { cascaded } : {}) });
      return { ok: true, name, version: existed.version,
               ...(cascaded ? { cascaded: cascaded.collections, settings_keys: cascaded.settings_keys } : {}) };
    }

    if (type === "archive_app") {
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

    // ---- File plane: bytes are handled by the channel BEFORE this tx; here we only
    // manage the ref index (idempotency + OCC + authoritative in-tx quota + versioning + ledger).
    if (type === "write_file") {
      const app = String(command.app || ""); // NO trim — keep it raw so the stored key, the emitted aggregate_id, the idempotency replay-target, and statFile/listFiles all agree; APP_NAME_RE rejects whitespace anyway
      const path = String(command.path || "");
      if (!APP_NAME_RE.test(app)) return { ok: false, error: "bad_app" };
      if (path.includes("..") || !FILE_PATH_RE.test(path)) return { ok: false, error: "bad_path" };
      const sha256 = String(command.sha256 || "");
      if (!/^[0-9a-f]{64}$/.test(sha256)) return { ok: false, error: "bad_sha256" };
      const size = Number(command.size);
      if (!Number.isInteger(size) || size < 0) return { ok: false, error: "bad_size" };
      if (size > MAX_FILE_BYTES) return { ok: false, error: "file_too_large" };
      const mime = String(command.mime || "application/octet-stream").slice(0, 255);
      const existing = q.fileByKey.get(app, path);
      // OCC must fail closed against a MISSING row too — else a guarded write silently RESURRECTS a file
      // another actor deleted between the caller's read and this write (a lost-delete). expected:0 = "no such version".
      if (command.expected_version != null && (!existing || command.expected_version !== existing.version))
        return { ok: false, conflict: true, expected: existing ? existing.version : 0 };
      // Authoritative in-tx quota, fail-closed, on LOGICAL bytes (dedup cannot bypass).
      const appU = q.fileUsageStmt.get(app);
      const oldSize = existing ? existing.size : 0;
      if (appU.bytes - oldSize + size > MAX_APP_FILE_BYTES) return { ok: false, error: "quota_exceeded" };
      if (appU.count + (existing ? 0 : 1) > MAX_APP_FILE_COUNT) return { ok: false, error: "too_many_files" };
      const totalU = q.fileUsageTotalStmt.get();
      if (totalU.bytes - oldSize + size > MAX_TOTAL_FILE_BYTES) return { ok: false, error: "total_quota_exceeded" };
      if (totalU.count + (existing ? 0 : 1) > MAX_TOTAL_FILE_COUNT) return { ok: false, error: "total_too_many_files" };
      // Same rule as items and apps: append first, stamp the row with this event's seq.
      const m = emit(app + "/" + path, "file_written", { app, path, sha256, size, mime });
      q.insFile.run({ app, path, sha256, size, mime, version: m.seq, ts });
      const row = q.fileByKey.get(app, path);
      const meta = { app, path, sha256, size, mime, version: row.version, created_at: row.created_at, updated_at: row.updated_at };
      return { ok: true, meta, created: !existing, freed_sha: existing && existing.sha256 !== sha256 ? existing.sha256 : null };
    }

    if (type === "delete_file") {
      const app = String(command.app || ""); // NO trim (mirror write_file — keys + replay-target agree)
      const path = String(command.path || "");
      const row = q.fileByKey.get(app, path);
      if (!row) return { ok: false, error: "not_found" };
      if (command.expected_version != null && command.expected_version !== row.version)
        return { ok: false, conflict: true, expected: row.version };
      // Classified destructive, gate wired, actor face dormant — the file tools publish no
      // `actor`, so this can only fire once file deletes carry human provenance (confirmation.mjs).
      const demand = confirmationGate(command, privileged, via,
        { target: app + "/" + path, collection: null, version: row.version, preview: () => path });
      if (demand) return demand;
      q.delFile.run({ app, path });
      emit(app + "/" + path, "file_deleted", { app, path, sha256: row.sha256, version: row.version });
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
        return { seq: r.seq, type: r.event_type, id: r.aggregate_id, actor: r.actor, host: r.host, ts: r.ts, ...rest };
      }),
    };
  });
  const notify = (result, command) => {
    if (result && result.ok) {
      // `name` rides for the APP-plane commands: the invalidation bridge needs to say WHICH
      // ui:// resource went stale, and the command is the only place that knows.
      try { events.emit("change", { seq: q.seq.get().v, type: command?.type, name: command?.name }); } catch {}
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
  // core() understands — save_app, write_file, delete_file, … — a parallel command grammar
  // carrying none of the per-tool guards, which is the exact disease test/tool-surface.mjs names.
  // Same wall for arguments: a command carries what the single-write tools publish plus the
  // envelope keys the tool layer derives, never whatever core() happens to read — an unpublished
  // key reaching core() through a batch (declaration_policy, an explicit add id, …)
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
      for (const k of allowed) {
        if (c[k] === undefined) continue;
        const shape = ITEM_WRITE_SHAPES[k];
        if (shape && !shape(c[k])) return { ok: false, error: "batch_failed", index: i, applied: 0,
          failure: { ok: false, error: "bad_batch_argument",
            detail: `\`${k}\` has the wrong type — a batch command carries exactly what the matching single-write tool takes` } };
        cmd[k] = c[k];
      }
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

  /** What deleting `name` would take with it, and — just as important — what it would LEAVE.
   *
   *  This exists because the honest answer to "which collections belong to this app" is
   *  "we cannot always tell", and the shape of a destructive act has to say so out loud rather
   *  than guess. Three signals, measured strength in delete-cascade-design.md §1:
   *    · the manifest's `collections` key — the GUIDE's lifecycle claim; used here to find
   *      OTHER claimants, never to grant one (real-world adoption was zero);
   *    · the ledger's `via.app` — stamped only on widget writes; its ABSENCE proves nothing
   *      (the model's own writes carry none), so it too only counts in one direction:
   *      someone else's via is evidence of sharing;
   *    · the name — a collection called exactly like the app, and PROVABLY born after it
   *      (ledger order, scoped to this app's current life so a reused name cannot inherit a
   *      previous holder's claim). Produces `exclusive` only when the other two find nobody.
   *  The asymmetry is the whole design: deleting too little leaves rows a user can delete
   *  again; deleting too much silently breaks a SECOND app and the data is gone. So `shared`
   *  and `unknown` are kept, always, and the caller is told what was kept and why. */
  function computeDisposition(name) {
    const comp = String(name || "").trim();
    // Who ELSE claims a collection by declaring it? (Parsed defensively: a manifest is data.)
    const claimants = new Map();   // collection -> Set(app)
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
    // because the two are spelled alike. The ledger answers what actually matters: a collection
    // whose first event predates THIS APP'S first save (this life — a name can be reused, and
    // the tombstone keeps the previous holder's events) was not created for it.
    const life = q.lifeStart.get(comp).v;
    const compBorn = q.firstCompEvent.get(comp, life).v;
    const bornAfterTheApp = (c) => {
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
      // plan can mean what the two-step promises: "the world still looks like what you were
      // shown". A row COUNT pins the wrong thing — delete two rows and add two others between
      // the plan and the confirmation and the count still matches. One ledger number closes it,
      // because the ledger never goes backwards: any write to this collection moves it.
      const seq = q.collSeq.get(coll).v;
      if (others.length) {
        collections.push({ collection: coll, verdict: "shared", rows, seq,
          why: `also used by ${others.join(", ")} — kept, so deleting this app cannot break another one` });
      } else if (coll === comp && bornAfterTheApp(coll)) {
        collections.push({ collection: coll, verdict: "exclusive", rows, seq,
          why: "named after this app, created after it, and no other app declares it or has written to it" });
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
    // One cheap read answering "did anything change?" — the adaptive-poll / SSE-fallback probe.
    // `live_n` rides ALONG this read rather than in one of its own: the /events probe already pays
    // for this call every 2s, and "did the display's app change?" is the same question about a
    // different axis. It is NOT on the get_data_version TOOL face — see src/tools/data.mjs, which
    // projects the four declared keys (opening an app is not a data change, and the model must
    // not start reading one as if it were).
    dataVersion: () => ({ seq: q.seq.get().v, settings_version: q.settingsSeq.get().v, files_version: q.filesSeq.get().v, schema_version: SCHEMA_VERSION, live_n: q.liveN.get().v }),
    /** Remember which app was opened LAST — the entire state of every `@live` brick on screen.
     *
     *  Deliberately not a ledger event (2026-08-14: "it does not need the ledger — that would
     *  only make it dirty"). The ledger is the
     *  record of what HAPPENED and it only grows; this is one field describing what is ON SCREEN,
     *  and it has no past worth keeping. Writing an event per open would also make every glance
     *  move the global seq — which every widget in every host polls — so opening an app would
     *  spuriously refresh every other one.
     *
     *  Emits "live" AFTER the write, like notify() does for "change": in-process subscribers (the
     *  SSE /events route) get push latency, and anyone else compares dataVersion().live_n.
     *  Returns the new {app, ts, n}, or null when the name is not one (the caller has already
     *  checked the app exists; this only keeps a malformed value out of the column). */
    touchLiveApp(name) {
      const app = String(name ?? "");
      if (!APP_NAME_RE.test(app)) return null;
      const ts = new Date().toISOString();
      q.touchLive.run({ app, ts });
      const row = q.liveGet.get();
      try { events.emit("live", { app: row.app, ts: row.ts, n: row.n }); } catch {}
      return row;
    },
    /** {app, ts, n} — or null when no app has been opened yet (a fresh store, or one whose
     *  pointer row was never written). Null is an ANSWER: an `@live` brick renders its wait. */
    livePointer: () => q.liveGet.get() || null,
    getApp: (name) => q.compByName.get(name) || null,
    // No arguments = every row, exactly as before: the registry's own consumers (the settings
    // App Store pane, tool re-registration on boot) want the whole truth. Filtering is the CALLER's
    // choice, and the model-facing tool is the caller that has a default.
    listApps: ({ kinds, visibilities, name } = {}) => {
      let rows = q.allComps.all();
      if (name) rows = rows.filter((c) => c.name === name);
      if (kinds) rows = rows.filter((c) => kinds.includes(c.kind));
      if (visibilities) rows = rows.filter((c) => visibilities.includes(c.visibility));
      return rows;
    },
    /** Any app whose name is not in `names`. The engine passes its own seeded set and reads
     *  this as "the user has something of their own" — see buildInstructions in engine.mjs. */
    hasAppOutside: (names) => q.hasCompOutside.get(JSON.stringify([...names])).v === 1,
    /** [{version, ts, ui_size, checkpoint}] — never the raw document.
     *
     *  `checkpoint` is this app's OWN 1..N counter, derived here and stored nowhere. It
     *  exists because `version` IS the ledger seq (save_app stamps the row with the event's
     *  seq — one ordinal axis, deliberately), and that axis is global: it advances for every write
     *  in the store. A user who edited one app twice sees v5 then v43 and reasonably asks what
     *  happened to the other 38. Nothing did — those were their groceries.
     *
     *  So the number a PERSON reads is the checkpoint; `version` stays exactly as it was for the
     *  machine (it is the OCC token, the restore target, and the history key). Presentation change,
     *  not a renumbering — the axis is load-bearing and stays. */
    appHistory: (name) => {
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
    getAppVersion: (name, version) => q.compVersion.get(name, version) || null, // {name, version, ui, manifest, ts} | null — the ONE path that reads an OLD revision (for restore/diff)

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

    /** Read-only twin of the cascade plan — { collections: [{collection, verdict, rows, seq,
     *  why}], settings_keys, settings_seq, exclusive } where verdict is "exclusive" | "shared"
     *  | "unknown". The delete_app command recomputes this inside its own transaction; this
     *  export exists for previews and tests, never as an input to the delete. */
    deleteDisposition: computeDisposition,


    /** The keyset cursor that continues AFTER this item — exposed so a caller that shrinks a page
     *  to fit a budget can hand out a cursor that matches the rows it actually kept. */
    cursorAfter: (item) => encCursor({ g: item.group ?? "", p: item.position, id: item.id }),

    // File plane — ref index + quota accounting the channel (src/files.mjs) builds on. Bytes NEVER
    // pass through here; the store stays fs-free beyond the existing mkdirSync. `dataDir` is where the
    // backend puts files/<app>/<sha256>.blob — derived from the ACTUAL db path so it honors
    // OMA_DB / an explicit path (test isolation) and sits beside whatever db is open.
    statFile: (app, path) => {
      const r = q.fileByKey.get(app, path);
      return r ? { app, path, sha256: r.sha256, size: r.size, mime: r.mime, version: r.version, created_at: r.created_at, updated_at: r.updated_at } : null;
    },
    listFiles: (app, prefix) => {
      const rows = q.filesByApp.all(app);
      return prefix ? rows.filter((r) => r.path.startsWith(prefix)) : rows;
    },
    fileUsage: (app) => q.fileUsageStmt.get(app),
    fileUsageTotal: () => q.fileUsageTotalStmt.get(),
    filesVersion: () => q.filesSeq.get().v, // the monotonic file-activity gate (rides tool results, like settings_version)
    blobRefcount: (app, sha256) => q.blobRefcountStmt.get(app, sha256).n,
    dataDir: dirname(dbPath),

    /** UNDO — one verb, and it is deliberately not a tool.
     *
     *  "Put it back" is the same action on every plane, so it is one function: read the last event
     *  for a target, and apply its pre-image. Items carry `was` (§ the write path above), apps
     *  carry their previous html in app_history, files carry a content address that is still
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
          return { type: "archive_app", result: core({ type: "archive_app", command_id: cid, name: ev.aggregate_id,
            visibility: payload.was, actor: "human" }, true) };
        }
        if (ev.event_type === "component_saved") {
          // The previous REVISION is the pre-image — BOTH slots, verbatim, because a revision is a
          // coherent (ui, manifest) pair and restoring one without the other would manufacture a
          // state that never existed. Rolling FORWARD to it (rather than deleting the current row)
          // is what keeps history honest: you can undo the undo.
          // The event's own seq IS the version it created (one ordinal axis), so the payload does not
          // carry one and does not need to — "the version before this event" is just "below its seq".
          const hist = q.compHistory.all(ev.aggregate_id);
          const prev = hist.find((h) => h.version < ev.seq);
          if (!prev) return { done: { ok: false, error: "no_previous_version" } };
          return { type: "save_app", result: core({ type: "save_app", command_id: cid, name: ev.aggregate_id,
            ui: prev.ui, manifest: prev.manifest ? JSON.parse(prev.manifest) : null, actor: "human" }, true) };
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
          host: r.host, ts: r.ts,
          undoable: !!(last && last.seq === r.seq), ...rest };
      });
    },

    // retention/pruneLedger retired 2026-08-04 (elegance A2): zero production callers — the
    // ledger is append-only and unbounded until a real maintenance caller exists. (Its one
    // structural consumer, cascade's ownership judge, retired the same day.)

    close: () => db.close(),
  };
}
