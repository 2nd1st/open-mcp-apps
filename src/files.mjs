// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// files.mjs — the per-app FILE channel: unstructured user files (scope b) that are too big or too
// binary for the 32 KiB item `fields` JSON. Design: scratchpad/FILE-STORAGE-design.md.
//
// SEPARATION OF CONCERNS (this is the whole security point):
//   - store.mjs owns the REF INDEX (the `file` table): idempotency, OCC, quota, versioning, the ledger.
//     It never touches file bytes and imports no fs beyond the existing mkdirSync.
//   - THIS module owns the BYTES: a local content-addressed folder keyed by (app, sha256). It is
//     the SOLE importer of node:fs for blobs. Content-addressing is PER-APP (files/<app>/<sha>.blob),
//     which keeps within-app dedup + is traversal-immune by construction (the on-disk name is a validated
//     hex hash — user input NEVER becomes a path segment) AND eliminates the cross-app content-existence
//     oracle a global CAS would need to hide.
//   - makeFileChannel() orchestrates the two: blob-first, ref-second, so a crash between leaves a harmless
//     orphan blob (swept later) rather than a dangling ref. Reads re-hash and fail closed (tamper/bit-rot).
//
// (The "swappable remote backend" seam retired 2026-08-04, elegance A3: one implementation, one
// instantiation, zero remote code — a future remote store is a future problem, added with its caller.)

import { promises as fsp } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { APP_NAME_RE, FILE_PATH_RE, MAX_FILE_BYTES, CONFIRM_ALWAYS, SHARED_WRITE } from "./store.mjs";

const SHA_RE = /^[0-9a-f]{64}$/;
const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

// ------------------------------------------------------------------ the byte store
// Every method is keyed by (app, sha256) and async. deleteBlob is GC ONLY; refcounting is
// enforced ABOVE, in the ref index.

export class LocalFileBackend {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filesRoot = join(dataDir, "files");
    this.tmpDir = join(this.filesRoot, ".tmp");
  }

  // Build the on-disk path AFTER validating both segments — defense in depth. The content-addressed
  // name means user input is never a path segment, so this is a belt over the structural suspenders.
  _paths(app, sha) {
    if (!APP_NAME_RE.test(String(app))) throw new Error("bad_app");
    if (!SHA_RE.test(String(sha))) throw new Error("bad_sha256");
    const dir = join(this.filesRoot, app);
    const p = join(dir, sha + ".blob");
    if (!resolve(p).startsWith(resolve(dir) + sep)) throw new Error("path_escape");
    return { dir, p };
  }

  async statBlob(app, sha) {
    const { p } = this._paths(app, sha);
    try { const st = await fsp.stat(p); return { size: st.size }; }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }

  async hasBlob(app, sha) {
    return (await this.statBlob(app, sha)) !== null;
  }

  async getBlob(app, sha) {
    const { p } = this._paths(app, sha);
    try { return await fsp.readFile(p); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }

  // Atomic + content-idempotent: skip if present; else stage in .tmp, fsync, then rename into place so a
  // reader never observes a partial blob and a crash never leaves a torn file at the content address.
  // opts.force skips the exists-check and ALWAYS re-writes (same content by definition of the address;
  // rename is atomic) — used by the channel's post-commit re-assert, where the point is to land bytes
  // with a FRESH mtime after any straggler GC unlink, not to save a write.
  async putBlob(app, sha, bytes, opts = {}) {
    const { dir, p } = this._paths(app, sha);
    if (!opts.force) {
      const existing = await this.statBlob(app, sha);
      if (existing) return { size: existing.size };
    }
    await fsp.mkdir(dir, { recursive: true });
    await fsp.mkdir(this.tmpDir, { recursive: true });
    const tmp = join(this.tmpDir, randomUUID());
    try {
      const fh = await fsp.open(tmp, "w");
      try { await fh.writeFile(bytes); await fh.sync(); }
      finally { await fh.close(); }
      await fsp.rename(tmp, p);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {}); // never leak the staging file on write/sync/rename failure (ENOSPC/EIO)
      throw e;
    }
    return { size: bytes.length };
  }

  // opts.ifOlderThanMs — the GC AGE GUARD: skip the unlink when the blob's mtime is fresher than
  // the window. A refcount-0 read races the writer that is about to (re)commit a ref: the writer
  // always (re)writes its blob with a fresh mtime, so "old enough" ≈ "genuinely unreferenced".
  // Fresh orphans that slip through are reclaimed by the next sweep once they age past the guard.
  async deleteBlob(app, sha, opts = {}) {
    const { p } = this._paths(app, sha);
    try {
      if (opts.ifOlderThanMs) {
        const st = await fsp.stat(p);
        if (Date.now() - st.mtimeMs < opts.ifOlderThanMs) return;
      }
      await fsp.unlink(p);
    }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }

  // Yield every stored blob as {app, sha} so the channel can GC ones with no ref row. Local-only.
  async *enumerate() {
    let comps;
    try { comps = await fsp.readdir(this.filesRoot, { withFileTypes: true }); }
    catch (e) { if (e.code === "ENOENT") return; throw e; }
    for (const c of comps) {
      if (!c.isDirectory() || c.name === ".tmp") continue;
      let blobs;
      try { blobs = await fsp.readdir(join(this.filesRoot, c.name)); }
      catch (e) { if (e.code === "ENOENT") continue; throw e; }
      for (const f of blobs) if (f.endsWith(".blob")) yield { app: c.name, sha: f.slice(0, -5) };
    }
  }

  // Reclaim staging files left by an interrupted/failed write (enumerate() skips .tmp, so the sweep handles
  // it here). Only touch files older than the grace so an in-flight write's staging file is never unlinked.
  // (A "<id>.upload" file left by a pre-0.8.1 chunked upload is just another stale temp file now.)
  async sweepTmp(graceMs) {
    let entries;
    try { entries = await fsp.readdir(this.tmpDir); }
    catch (e) { if (e.code === "ENOENT") return 0; throw e; }
    let n = 0;
    const now = Date.now();
    for (const name of entries) {
      const f = join(this.tmpDir, name);
      try { const st = await fsp.stat(f); if (now - st.mtimeMs >= graceMs) { await fsp.unlink(f); n++; } }
      catch { /* raced away — fine */ }
    }
    return n;
  }
}

// ------------------------------------------------------------------ the orchestrating channel
// Wires the ref index (store) to the byte backend. This is what the engine's file_* tools call.
export function makeFileChannel({ store, backend }) {
  // put: durable blob FIRST, then the ref (idempotent + OCC + quota) in the store's sync tx, then GC any
  // sha the overwrite freed. If the ref write fails, a freshly-written blob is an orphan → left for sweep.
  // `shared` is the sharing facade's: a collaborator's write, which meets the per-app ceilings too.
  async function put(app, path, data, { mime = "application/octet-stream", command_id, expected_version, shared = false } = {}) {
    if (!APP_NAME_RE.test(String(app))) return { ok: false, error: "bad_app" };
    if (String(path).includes("..") || !FILE_PATH_RE.test(String(path))) return { ok: false, error: "bad_path" };
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: "file_too_large" };
    const sha = sha256hex(bytes);
    const had = await backend.hasBlob(app, sha);
    if (!had) await backend.putBlob(app, sha, bytes);
    const r = store.execute({
      type: "write_file", command_id: command_id || randomUUID(),
      app, path, sha256: sha, size: bytes.length, mime, expected_version,
      ...(shared ? { [SHARED_WRITE]: true } : {}),
    });
    if (!r.ok) {
      // The store rejected (quota / OCC / bad input): a blob WE just wrote is now an unreferenced orphan.
      // The GC AGE GUARD skips it while fresh (a concurrent dedup-put may be about to reference it); the
      // next sweep reclaims it once it ages out — disk hygiene is eventual, correctness is immediate.
      if (!had && store.blobRefcount(app, sha) === 0) await backend.deleteBlob(app, sha, { ifOlderThanMs: GC_AGE_GUARD_MS }).catch(() => {});
      return r;
    }
    // Ref committed (refcount ≥ 1). A concurrent delete/overwrite GC may have unlinked the blob between our
    // hasBlob check and the commit — the classic content-addressed TOCTOU. Close it BOTH ways:
    //   - dedup path (had=true, we never wrote bytes): FORCE-rewrite unconditionally. A stat-then-write
    //     re-assert can lose to a straggler unlink landing after the stat (reproduced ~2/1000); the forced
    //     write lands fresh bytes with a fresh mtime, and every GC delete honors the AGE GUARD, so a
    //     straggler can no longer remove them.
    //   - fresh path (had=false): our own write is the newest thing at that address; the age guard already
    //     protects it. Re-check + rewrite only if somehow missing.
    if (had) await backend.putBlob(app, sha, bytes, { force: true });
    else if (!(await backend.hasBlob(app, sha))) await backend.putBlob(app, sha, bytes, { force: true });
    if (r.freed_sha && store.blobRefcount(app, r.freed_sha) === 0) await backend.deleteBlob(app, r.freed_sha, { ifOlderThanMs: GC_AGE_GUARD_MS }).catch(() => {});
    if (!r.meta) r.meta = store.statFile(app, path); // idempotent replay short-circuits before meta is built
    return r;
  }

  // get: read the ref, fetch bytes, RE-HASH and fail closed on mismatch (tamper / bit-rot).
  async function get(app, path) {
    const meta = store.statFile(app, path);
    if (!meta) return null;
    const bytes = await backend.getBlob(app, meta.sha256);
    if (!bytes) return null;
    if (sha256hex(bytes) !== meta.sha256) throw new Error(`file integrity check failed: ${app}/${path}`);
    return { meta, bytes };
  }

  function stat(app, path) { return store.statFile(app, path); }
  function list(app, prefix) { return { files: store.listFiles(app, prefix), usage: store.fileUsage(app) }; }
  function usage(app) { return store.fileUsage(app); }

  // `actor` / `via` / `request_state` ride through because the confirmation gate lives in the
  // store and reads all three. Dropping them here is what made delete_file "classified but not
  // protected": the table said a file delete needs the user's yes, and the only channel to the
  // store could not express who was asking (codex review).
  // `confirmAlways` is the sharing facade's: a delete through a share asks whatever actor it claims.
  async function del(app, path, { command_id, expected_version, actor, via, request_state, confirmAlways = false } = {}) {
    const r = store.execute({ type: "delete_file", command_id: command_id || randomUUID(), app, path, expected_version, actor, via, request_state,
      ...(confirmAlways ? { [CONFIRM_ALWAYS]: true } : {}) });
    if (r.ok && r.freed_sha && store.blobRefcount(app, r.freed_sha) === 0) await backend.deleteBlob(app, r.freed_sha, { ifOlderThanMs: GC_AGE_GUARD_MS });
    return r;
  }

  const GC_AGE_GUARD_MS = 60 * 1000;      // never GC-unlink a blob fresher than this (see deleteBlob)

  // Unlink any stored blob with no ref row (the harmless orphans blob-first/ref-second can leave, plus any
  // left by an interrupted write). Startup + periodic.
  async function sweepOrphans() {
    let swept = 0;
    {
      for await (const { app, sha } of backend.enumerate()) {
        // AGE GUARD: a refcount-0 read can race a writer about to commit a ref for this sha; that
        // writer always (re)writes the blob with a fresh mtime, so only OLD unreferenced blobs are
        // truly orphans. Fresh ones get another look on the next sweep.
        if (store.blobRefcount(app, sha) === 0) { await backend.deleteBlob(app, sha, { ifOlderThanMs: GC_AGE_GUARD_MS }); swept++; }
      }
    }
    // putBlob temp files live for seconds; 5 minutes is slack for a slow disk.
    await backend.sweepTmp(5 * 60 * 1000).catch(() => {});
    return { swept };
  }

  return { put, get, stat, list, usage, del, sweepOrphans };
}

// Convenience wiring for the engine: pick the backend from the store's own data dir + build the channel.
// MEMOIZED PER STORE: the stateless /mcp transport builds a FRESH engine per request over ONE shared
// store, and the startup orphan sweep below should run once per store/process, not once per request.
// (It used to matter more: the chunked-upload table lived here until 0.8.1 removed that path.)
const channelByStore = new WeakMap();
export function openFileChannel(store) {
  let ch = channelByStore.get(store);
  if (!ch) {
    ch = makeFileChannel({ store, backend: new LocalFileBackend(store.dataDir) });
    channelByStore.set(store, ch);
    ch.sweepOrphans().catch(() => {});   // fire-and-forget crash recovery, once per store/process
  }
  return ch;
}
