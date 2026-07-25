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

// Migration-format pin: stamped into PRAGMA user_version AND every change_event payload (`sv`).
// Export/import + SaaS sync read this to know which event shape they are looking at — bump it on
// any breaking payload/schema change and translate old values on read. Never reuse a number.
export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS item (
  id         TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  grp        TEXT NOT NULL DEFAULT '',
  position   REAL NOT NULL DEFAULT 0,
  fields     TEXT NOT NULL DEFAULT '{}',   -- JSON object, component-defined shape
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_collection ON item(collection);
-- Serves the paged/filtered read path (queryItems): WHERE collection [AND grp] with an
-- ORDER BY that matches the index columns, so pages never sort the whole collection.
CREATE INDEX IF NOT EXISTS idx_item_coll_grp_pos ON item(collection, grp, position);

CREATE TABLE IF NOT EXISTS component (
  name        TEXT PRIMARY KEY,             -- [a-z][a-z0-9-]*, becomes the open_<name> tool
  version     INTEGER NOT NULL DEFAULT 1,
  html        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT 'agent',
  scene       TEXT,                         -- JSON {category_id, tags?} | NULL — Library taxonomy metadata
  manifest    TEXT,                         -- JSON {collections:{<coll>:{fields:{..},strict?}}} | NULL — declared field contracts, enforced in core()
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
  actor        TEXT NOT NULL,
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
`;

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

// Component schema manifests: a component may declare field contracts for the collections it owns.
// Validation lives HERE (not the engine) so it binds EVERY caller — AI tool, widget mutation, /rpc.
// Manifest-less collections behave exactly as before (backward compatible).
export const MANIFEST_FIELD_TYPES = new Set(["string", "number", "boolean", "object", "array"]);
export function manifestShapeError(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "manifest must be an object";
  if (!m.collections || typeof m.collections !== "object" || Array.isArray(m.collections)) return "manifest.collections must be an object";
  for (const [coll, spec] of Object.entries(m.collections)) {
    if (!coll) return "empty collection name";
    if (coll === SETTINGS_COLLECTION) return `manifest may not govern the reserved "${SETTINGS_COLLECTION}" collection`;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) return `collections.${coll} must be an object`;
    if (spec.strict != null && typeof spec.strict !== "boolean") return `collections.${coll}.strict must be a boolean`;
    if (!spec.fields || typeof spec.fields !== "object" || Array.isArray(spec.fields)) return `collections.${coll}.fields must be an object`;
    for (const [fname, f] of Object.entries(spec.fields)) {
      if (!f || typeof f !== "object" || Array.isArray(f)) return `field ${coll}.${fname} must be an object`;
      if (!MANIFEST_FIELD_TYPES.has(f.type)) return `field ${coll}.${fname}.type must be one of ${[...MANIFEST_FIELD_TYPES].join("|")}`;
      if (f.required != null && typeof f.required !== "boolean") return `field ${coll}.${fname}.required must be a boolean`;
      if (f.enum != null && (!Array.isArray(f.enum) || f.enum.length === 0)) return `field ${coll}.${fname}.enum must be a non-empty array`;
    }
  }
  return null;
}
// null/absent counts as "not set" (update_item uses null-to-delete; required catches it, type doesn't).
// Match is on JS primitives; enum membership is strict equality.
function fieldViolations(spec, fields) {
  const out = [];
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
  // Additive migration for pre-scene DBs: SQLite has no ADD COLUMN IF NOT EXISTS, so guard by pragma.
  const compCols = db.pragma("table_info(component)");
  if (!compCols.some((c) => c.name === "scene")) db.exec("ALTER TABLE component ADD COLUMN scene TEXT");
  if (!compCols.some((c) => c.name === "manifest")) db.exec("ALTER TABLE component ADD COLUMN manifest TEXT");
  // Stamp the migration-format version. 0 = pre-versioned db (same layout as v1) → claim it as v1.
  // A FUTURE-versioned db must not be opened by older code that would write old-shaped events into it.
  const uv = db.pragma("user_version", { simple: true });
  if (uv === 0) db.pragma(`user_version = ${SCHEMA_VERSION}`);
  else if (uv > SCHEMA_VERSION) throw new Error(`store schema is v${uv}, this build understands up to v${SCHEMA_VERSION} — update open-mcp-apps`);

  const q = {
    eventByCmd: db.prepare("SELECT seq, event_type, aggregate_id FROM change_event WHERE command_id = ?"),
    seq: db.prepare("SELECT COALESCE(MAX(seq),0) AS v FROM change_event"),
    settingsSeq: db.prepare("SELECT COALESCE(MAX(seq),0) AS v FROM change_event WHERE json_extract(payload,'$.collection') = 'settings'"),
    appendEvent: db.prepare(
      `INSERT INTO change_event (aggregate_id, command_id, event_type, payload, actor, host, ts)
       VALUES (@aggregate_id, @command_id, @event_type, @payload, @actor, @host, @ts)`),

    itemById: db.prepare("SELECT * FROM item WHERE id = ?"),
    itemsByCollection: db.prepare("SELECT * FROM item WHERE collection = ? ORDER BY grp, position, created_at"),
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
    insItem: db.prepare(
      `INSERT INTO item (id, collection, grp, position, fields, version, created_at, updated_at)
       VALUES (@id, @collection, @grp, @position, @fields, 1, @ts, @ts)`),
    updFields: db.prepare("UPDATE item SET fields = @fields, version = version + 1, updated_at = @ts WHERE id = @id"),
    updPlace: db.prepare("UPDATE item SET grp = @grp, position = @position, version = version + 1, updated_at = @ts WHERE id = @id"),
    delItem: db.prepare("DELETE FROM item WHERE id = @id"),

    collections: db.prepare(
      "SELECT collection, COUNT(*) AS items, MAX(updated_at) AS last_activity FROM item GROUP BY collection ORDER BY last_activity DESC"
    ),
    compByName: db.prepare("SELECT * FROM component WHERE name = ?"),
    allComps: db.prepare("SELECT name, version, description, author, json_extract(scene, '$.category_id') AS category_id, CASE WHEN manifest IS NULL THEN 0 ELSE 1 END AS has_manifest, updated_at, length(html) AS html_size FROM component ORDER BY name"),
    insComp: db.prepare(
      `INSERT INTO component (name, version, html, description, author, scene, manifest, updated_at)
       VALUES (@name, @version, @html, @description, @author, @scene, @manifest, @ts)
       ON CONFLICT(name) DO UPDATE SET version = version + 1, html = @html,
         description = CASE WHEN @description = '' THEN component.description ELSE @description END,
         author = @author,
         scene = CASE WHEN @scene_set = 1 THEN @scene ELSE component.scene END,
         manifest = CASE WHEN @manifest_set = 1 THEN @manifest ELSE component.manifest END,
         updated_at = @ts`),
    insCompHist: db.prepare("INSERT OR REPLACE INTO component_history (name, version, html, ts) VALUES (@name, @version, @html, @ts)"),
    maxHistVersion: db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM component_history WHERE name = ?"),
    compHist: db.prepare("SELECT version, ts, length(html) AS html_size FROM component_history WHERE name = ? ORDER BY version DESC"),
    compVersion: db.prepare("SELECT name, version, html, ts FROM component_history WHERE name = ? AND version = ?"),
    delComp: db.prepare("DELETE FROM component WHERE name = ?"),

    // File plane — ref index only (bytes are the backend's job). All reads are component-scoped.
    fileByKey: db.prepare("SELECT * FROM file WHERE component = ? AND path = ?"),
    filesByComponent: db.prepare("SELECT component, path, sha256, size, mime, version, backend, created_at, updated_at FROM file WHERE component = ? ORDER BY path"),
    fileUsageStmt: db.prepare("SELECT COALESCE(SUM(size),0) AS bytes, COUNT(*) AS count FROM file WHERE component = ?"),
    fileUsageTotalStmt: db.prepare("SELECT COALESCE(SUM(size),0) AS bytes, COUNT(*) AS count FROM file"),
    blobRefcountStmt: db.prepare("SELECT COUNT(*) AS n FROM file WHERE component = ? AND sha256 = ?"),
    filesSeq: db.prepare("SELECT COALESCE(MAX(seq),0) AS v FROM change_event WHERE event_type = 'file_written' OR event_type = 'file_deleted'"),
    insFile: db.prepare(
      `INSERT INTO file (component, path, sha256, size, mime, version, backend, created_at, updated_at)
       VALUES (@component, @path, @sha256, @size, @mime, 1, @backend, @ts, @ts)
       ON CONFLICT(component, path) DO UPDATE SET sha256 = @sha256, size = @size, mime = @mime,
         version = version + 1, backend = @backend, updated_at = @ts`),
    delFile: db.prepare("DELETE FROM file WHERE component = @component AND path = @path"),
  };

  const rowToItem = (r) => ({
    id: r.id, group: r.grp, position: r.position,
    fields: JSON.parse(r.fields), version: r.version,
  });

  // collection → { component, spec } from declared manifests. Cached, but the cache key is a
  // per-call aggregate query so N processes sharing this db never validate against stale rules.
  // If two components declare the same collection, the most recently saved declaration wins
  // (deterministic: rows are applied in updated_at order).
  let mCacheKey = null, mMap = null;
  function manifestFor(collection) {
    const k = q.manifestKey.get();
    const key = `${k.n}:${k.sv}:${k.u}`;
    if (key !== mCacheKey) {
      mMap = new Map();
      for (const r of q.manifestRows.all()) {
        let m; try { m = JSON.parse(r.manifest); } catch { continue; }
        if (!m || typeof m !== "object" || !m.collections || typeof m.collections !== "object") continue;
        for (const [coll, spec] of Object.entries(m.collections))
          if (spec && typeof spec === "object" && spec.fields) mMap.set(coll, { component: r.name, spec });
      }
      mCacheKey = key;
    }
    return mMap.get(collection) || null;
  }

  function snapshot(collection) {
    return {
      collection,
      items: q.itemsByCollection.all(collection).map(rowToItem),
      version: q.seq.get().v,
      settings_version: q.settingsSeq.get().v,
      files_version: q.filesSeq.get().v,
    };
  }

  function core(command, privileged) {
    const { type, command_id, actor = "agent", host = null } = command;
    if (!command_id) throw new Error("command_id required (idempotency key)");

    const seen = q.eventByCmd.get(command_id);
    const collection = command.collection ?? (command.id ? q.itemById.get(command.id)?.collection : undefined);
    if (seen) {
      // A replay only short-circuits for the SAME command: the prior event must match this
      // command's type and — when the command names a target — its aggregate. A recycled
      // command_id on a DIFFERENT command must not false-succeed ("already deleted" while
      // doing nothing); it errs instead (UNIQUE(command_id) makes proceeding impossible).
      const target = type === "save_component" || type === "delete_component"
        ? String(command.name || "").trim()
        : type === "write_file" || type === "delete_file"
        ? String(command.component || "") + "/" + String(command.path || "")
        : command.id; // add_item without an explicit id has no verifiable target → type-only
      if (seen.event_type === EVENT_TYPES[type] && (target == null || seen.aggregate_id === target))
        return { ok: true, idempotent: true, event_type: seen.event_type, snapshot: collection ? snapshot(collection) : undefined };
      return { ok: false, error: "command_id_reused" };
    }

    const ts = new Date().toISOString();
    // Every ledger payload carries `sv` (SCHEMA_VERSION) — the migration-format pin export/import
    // and SaaS sync key off. `collection`-derived indexes are unaffected (sv is a sibling key).
    const emit = (aggregate_id, event_type, payload) =>
      q.appendEvent.run({ aggregate_id, command_id, event_type, payload: JSON.stringify({ ...payload, sv: SCHEMA_VERSION }), actor, host, ts });

    if (type === "add_item") {
      const coll = String(command.collection || "").trim();
      if (!coll) return { ok: false, error: "collection_required" };
      const grp = String(command.group ?? "");
      const fields = command.fields && typeof command.fields === "object" ? command.fields : {};
      if (coll === SETTINGS_COLLECTION && !privileged && RESERVED_KEY_RE.test(String(fields.key ?? "")))
        return { ok: false, error: "reserved_key" };
      const fieldsJson = JSON.stringify(fields);
      if (fieldsJson.length > MAX_ITEM_FIELDS_BYTES) return { ok: false, error: "fields_too_large" };
      const man = manifestFor(coll);
      if (man) {
        const violations = fieldViolations(man.spec, fields);
        if (violations.length) return { ok: false, error: "schema_violation", violations, manifest_component: man.component };
      }
      const id = command.id || randomUUID();
      const position = command.position ?? q.maxPos.get(coll, grp).p + 1;
      q.insItem.run({ id, collection: coll, grp, position, fields: fieldsJson, ts });
      emit(id, "item_added", { collection: coll, group: grp, position, fields });
      return { ok: true, id, snapshot: snapshot(coll) };
    }

    if (type === "update_item") {
      const row = q.itemById.get(command.id);
      if (!row) return { ok: false, error: "not_found" };
      if (command.expected_version != null && command.expected_version !== row.version)
        return { ok: false, conflict: true, expected: row.version, snapshot: snapshot(row.collection) };
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
        if (violations.length) return { ok: false, error: "schema_violation", violations, manifest_component: man.component };
      }
      q.updFields.run({ id: row.id, fields: mergedJson, ts });
      emit(row.id, "item_updated", { collection: row.collection, fields: command.fields });
      return { ok: true, id: row.id, snapshot: snapshot(row.collection) };
    }

    if (type === "move_item") {
      const row = q.itemById.get(command.id);
      if (!row) return { ok: false, error: "not_found" };
      if (command.expected_version != null && command.expected_version !== row.version)
        return { ok: false, conflict: true, expected: row.version, snapshot: snapshot(row.collection) };
      const grp = command.group != null ? String(command.group) : row.grp;
      const position = command.position ?? q.maxPos.get(row.collection, grp).p + 1;
      q.updPlace.run({ id: row.id, grp, position, ts });
      emit(row.id, "item_moved", { collection: row.collection, from: row.grp, to: grp, position });
      return { ok: true, id: row.id, snapshot: snapshot(row.collection) };
    }

    if (type === "delete_item") {
      const row = q.itemById.get(command.id);
      if (!row) return { ok: false, error: "not_found" };
      if (command.expected_version != null && command.expected_version !== row.version)
        return { ok: false, conflict: true, expected: row.version, snapshot: snapshot(row.collection) };
      if (row.collection === SETTINGS_COLLECTION && !privileged && RESERVED_KEY_RE.test(String(JSON.parse(row.fields).key ?? "")))
        return { ok: false, error: "reserved_key" };
      q.delItem.run({ id: row.id });
      emit(row.id, "item_deleted", { collection: row.collection });
      return { ok: true, id: row.id, snapshot: snapshot(row.collection) };
    }

    if (type === "save_component") {
      const name = String(command.name || "").trim();
      if (!COMPONENT_NAME_RE.test(name)) return { ok: false, error: "bad_name" };
      const html = String(command.html || "");
      if (html.length < 50) return { ok: false, error: "html_too_small" };
      if (html.length > MAX_COMPONENT_HTML) return { ok: false, error: "html_too_large" };
      // scene is TRI-STATE (mirrors the engine): undefined → preserve the stored scene;
      // null → explicit CLEAR; object → set (stored as JSON). SQL NULL alone cannot carry
      // "clear vs keep", so a @scene_set flag rides along — COALESCE-preserve was the old
      // behavior and made clearing impossible. Category validation is the ENGINE's job
      // (invalid → warn + preserve); storage stays dumb.
      const sceneSet = command.scene !== undefined ? 1 : 0;
      const scene = command.scene && typeof command.scene === "object" ? JSON.stringify(command.scene) : null;
      // manifest is tri-state like scene: undefined → preserve, null → clear, object → validate + set.
      const manifestSet = command.manifest !== undefined ? 1 : 0;
      let manifestJson = null;
      if (command.manifest != null) {
        const err = manifestShapeError(command.manifest);
        if (err) return { ok: false, error: "bad_manifest", detail: err };
        manifestJson = JSON.stringify(command.manifest);
      }
      const existed = q.compByName.get(name);
      // Version continuity across delete/recreate (fresh INSERT only — the ON CONFLICT branch
      // bumps component.version and ignores @version): seed from the tombstoned history's
      // MAX(version) so a recreated component continues (v3, not v1). History stays monotonic
      // and insCompHist's OR REPLACE can never land on (and destroy) a prior tombstoned row.
      const version = q.maxHistVersion.get(name).v + 1;
      q.insComp.run({ name, version, html, description: String(command.description || ""), author: actor, scene, scene_set: sceneSet, manifest: manifestJson, manifest_set: manifestSet, ts });
      const comp = q.compByName.get(name);
      q.insCompHist.run({ name, version: comp.version, html, ts });
      emit(name, "component_saved", { name, version: comp.version, size: html.length, created: !existed });
      return { ok: true, name, version: comp.version, created: !existed };
    }

    if (type === "delete_component") {
      const name = String(command.name || "").trim();
      const existed = q.compByName.get(name);
      if (!existed) return { ok: false, error: "not_found" };
      // Tombstone semantics: only the registry row goes. component_history rows are RETAINED
      // (the delete stays auditable, the html recoverable) and settings items under the
      // component's group are RETAINED — no cascade; the settings app's Orphaned section is
      // the janitor (docs/settings-design.md §7).
      q.delComp.run(name);
      emit(name, "component_deleted", { name, version: existed.version });
      return { ok: true, name, version: existed.version };
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
      q.insFile.run({ component, path, sha256, size, mime, backend, ts });
      const row = q.fileByKey.get(component, path);
      const meta = { component, path, sha256, size, mime, version: row.version, backend, created_at: row.created_at, updated_at: row.updated_at };
      emit(component + "/" + path, "file_written", { component, path, sha256, size, mime, version: row.version });
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
  // (collection, group) query it came from. `match` is exact-equality on top-level field values
  // (primitives); filtering happens on scanned pages so limit counts MATCHING items.
  const encCursor = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  const decCursor = (s) => { try { const o = JSON.parse(Buffer.from(String(s), "base64url").toString("utf8")); return o && typeof o === "object" ? o : null; } catch { return null; } };
  function queryItems(collection, { group, match, limit, cursor } = {}) {
    const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
    let after = null;
    if (cursor != null && cursor !== "") { after = decCursor(cursor); if (!after) return { error: "bad_cursor" }; }
    const grp = group != null ? String(group) : null;
    const total = grp != null ? q.countCollGrp.get(collection, grp).n : q.countColl.get(collection).n;
    const wantMatch = match && typeof match === "object" && !Array.isArray(match) && Object.keys(match).length ? match : null;
    const items = [];
    const BATCH = 400;
    for (;;) {
      const rows = grp != null
        ? (after ? q.pageGrpAfter.all({ c: collection, g: grp, p: after.p, id: after.id, n: BATCH })
                 : q.pageGrpFirst.all({ c: collection, g: grp, n: BATCH }))
        : (after ? q.pageAllAfter.all({ c: collection, g: after.g ?? "", p: after.p, id: after.id, n: BATCH })
                 : q.pageAllFirst.all({ c: collection, n: BATCH }));
      for (const r of rows) {
        after = { g: r.grp, p: r.position, id: r.id };
        if (wantMatch) {
          const f = JSON.parse(r.fields);
          let hit = true;
          for (const [k, v] of Object.entries(wantMatch)) if (f[k] !== v) { hit = false; break; }
          if (!hit) continue;
        }
        items.push(rowToItem(r));
        if (items.length >= lim) return { items, total, next_cursor: encCursor(after) };
      }
      if (rows.length < BATCH) return { items, total, next_cursor: null };
    }
  }

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
  const notify = (result, command) => {
    if (result && result.ok) {
      try { events.emit("change", { seq: q.seq.get().v, type: command?.type }); } catch {}
    }
    return result;
  };
  const execute = (command) => notify(txExecute(command), command);
  const executePrivileged = (command) => notify(txExecutePrivileged(command), command);

  return {
    db,
    execute,
    executePrivileged,
    events,
    snapshot,
    queryItems,
    // One cheap read answering "did anything change?" — the adaptive-poll / SSE-fallback probe.
    dataVersion: () => ({ seq: q.seq.get().v, settings_version: q.settingsSeq.get().v, files_version: q.filesSeq.get().v, schema_version: SCHEMA_VERSION }),
    getComponent: (name) => q.compByName.get(name) || null,
    listComponents: () => q.allComps.all(),
    componentHistory: (name) => q.compHist.all(name), // [{version, ts, html_size}] — never raw html
    getComponentVersion: (name, version) => q.compVersion.get(name, version) || null, // {name, version, html, ts} | null — the ONE path that reads OLD html (for restore/diff)

    listCollections: () => q.collections.all(),

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

    close: () => db.close(),
  };
}
