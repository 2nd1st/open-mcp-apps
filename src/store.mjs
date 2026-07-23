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

CREATE TABLE IF NOT EXISTS component (
  name        TEXT PRIMARY KEY,             -- [a-z][a-z0-9-]*, becomes the open_<name> tool
  version     INTEGER NOT NULL DEFAULT 1,
  html        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT 'agent',
  scene       TEXT,                         -- JSON {category_id, tags?} | NULL — Library taxonomy metadata
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS component_history (
  name    TEXT NOT NULL,
  version INTEGER NOT NULL,
  html    TEXT NOT NULL,
  ts      TEXT NOT NULL,
  PRIMARY KEY (name, version)
);

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

// command type → ledger event_type. Idempotency replays are matched against this: a seen
// command_id only short-circuits when the prior event is the SAME command (type + target).
const EVENT_TYPES = {
  add_item: "item_added", update_item: "item_updated", move_item: "item_moved",
  delete_item: "item_deleted", save_component: "component_saved", delete_component: "component_deleted",
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
export function defaultDbPath() { return join(defaultDbDir(), "open-mcp-app.db"); }

export function openStore(path) {
  const dbPath = path || process.env.OMA_DB || defaultDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");   // N hosts share ONE db → wait out a busy writer instead of throwing SQLITE_BUSY
  db.exec(SCHEMA);
  // Additive migration for pre-scene DBs: SQLite has no ADD COLUMN IF NOT EXISTS, so guard by pragma.
  if (!db.pragma("table_info(component)").some((c) => c.name === "scene"))
    db.exec("ALTER TABLE component ADD COLUMN scene TEXT");

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
    allComps: db.prepare("SELECT name, version, description, author, json_extract(scene, '$.category_id') AS category_id, updated_at, length(html) AS html_size FROM component ORDER BY name"),
    insComp: db.prepare(
      `INSERT INTO component (name, version, html, description, author, scene, updated_at)
       VALUES (@name, @version, @html, @description, @author, @scene, @ts)
       ON CONFLICT(name) DO UPDATE SET version = version + 1, html = @html,
         description = CASE WHEN @description = '' THEN component.description ELSE @description END,
         author = @author,
         scene = CASE WHEN @scene_set = 1 THEN @scene ELSE component.scene END,
         updated_at = @ts`),
    insCompHist: db.prepare("INSERT OR REPLACE INTO component_history (name, version, html, ts) VALUES (@name, @version, @html, @ts)"),
    maxHistVersion: db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM component_history WHERE name = ?"),
    compHist: db.prepare("SELECT version, ts, length(html) AS html_size FROM component_history WHERE name = ? ORDER BY version DESC"),
    delComp: db.prepare("DELETE FROM component WHERE name = ?"),
  };

  const rowToItem = (r) => ({
    id: r.id, group: r.grp, position: r.position,
    fields: JSON.parse(r.fields), version: r.version,
  });

  function snapshot(collection) {
    return {
      collection,
      items: q.itemsByCollection.all(collection).map(rowToItem),
      version: q.seq.get().v,
      settings_version: q.settingsSeq.get().v,
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
        : command.id; // add_item without an explicit id has no verifiable target → type-only
      if (seen.event_type === EVENT_TYPES[type] && (target == null || seen.aggregate_id === target))
        return { ok: true, idempotent: true, event_type: seen.event_type, snapshot: collection ? snapshot(collection) : undefined };
      return { ok: false, error: "command_id_reused" };
    }

    const ts = new Date().toISOString();
    const emit = (aggregate_id, event_type, payload) =>
      q.appendEvent.run({ aggregate_id, command_id, event_type, payload: JSON.stringify(payload), actor, host, ts });

    if (type === "add_item") {
      const coll = String(command.collection || "").trim();
      if (!coll) return { ok: false, error: "collection_required" };
      const grp = String(command.group ?? "");
      const fields = command.fields && typeof command.fields === "object" ? command.fields : {};
      if (coll === SETTINGS_COLLECTION && !privileged && RESERVED_KEY_RE.test(String(fields.key ?? "")))
        return { ok: false, error: "reserved_key" };
      const fieldsJson = JSON.stringify(fields);
      if (fieldsJson.length > MAX_ITEM_FIELDS_BYTES) return { ok: false, error: "fields_too_large" };
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
      const existed = q.compByName.get(name);
      // Version continuity across delete/recreate (fresh INSERT only — the ON CONFLICT branch
      // bumps component.version and ignores @version): seed from the tombstoned history's
      // MAX(version) so a recreated component continues (v3, not v1). History stays monotonic
      // and insCompHist's OR REPLACE can never land on (and destroy) a prior tombstoned row.
      const version = q.maxHistVersion.get(name).v + 1;
      q.insComp.run({ name, version, html, description: String(command.description || ""), author: actor, scene, scene_set: sceneSet, ts });
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

    throw new Error(`unknown command type: ${type}`);
  }

  // execute = normal path (reserved-key guard ON). executePrivileged = the out-of-band
  // privilege carrier used by security_set ONLY. Privilege is a SEPARATE entry point, never a
  // command field — an injected {privileged:true} on a data_* call reaches core() as false.
  const execute = db.transaction((command) => core(command, false));
  const executePrivileged = db.transaction((command) => core(command, true));

  return {
    db,
    execute,
    executePrivileged,
    snapshot,
    getComponent: (name) => q.compByName.get(name) || null,
    listComponents: () => q.allComps.all(),
    componentHistory: (name) => q.compHist.all(name), // [{version, ts, html_size}] — never raw html

    listCollections: () => q.collections.all(),
    close: () => db.close(),
  };
}
