// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// files.mjs — the per-app FILE channel: unstructured user files (scope b) that are too big or too
// binary for the 32 KiB item `fields` JSON. Design: scratchpad/FILE-STORAGE-design.md.
//
// SEPARATION OF CONCERNS (this is the whole security point):
//   - store.mjs owns the REF INDEX (the `file` table): idempotency, OCC, quota, versioning, the ledger.
//     It never touches file bytes and imports no fs beyond the existing mkdirSync.
//   - THIS module owns the BYTES, behind a swappable FileBackend keyed by (component, sha256). It is the
//     SOLE importer of node:fs for blobs. Content-addressing is PER-APP (files/<component>/<sha>.blob),
//     which keeps within-app dedup + is traversal-immune by construction (the on-disk name is a validated
//     hex hash — user input NEVER becomes a path segment) AND eliminates the cross-app content-existence
//     oracle a global CAS would need to hide.
//   - makeFileChannel() orchestrates the two: blob-first, ref-second, so a crash between leaves a harmless
//     orphan blob (swept later) rather than a dangling ref. Reads re-hash and fail closed (tamper/bit-rot).
//
// The local backend ships in OSS. A remote/SaaS backend implements the SAME 5-method interface over HTTPS
// with ZERO change above the seam — that is what makes app files remote-reachable later.

import { promises as fsp } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { COMPONENT_NAME_RE, FILE_PATH_RE, MAX_FILE_BYTES } from "./store.mjs";

const SHA_RE = /^[0-9a-f]{64}$/;
const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

// ------------------------------------------------------------------ the swappable seam
// FileBackend interface (documented, not enforced — plain JS). Every method is keyed by
// (component, sha256) and is async, so a remote HTTP implementation fits unchanged:
//   putBlob(component, sha, bytes) -> {size}   // content-idempotent: no-op if the blob already exists
//   getBlob(component, sha)        -> Buffer | null
//   hasBlob(component, sha)        -> boolean   // the sync-diff primitive (remote upload + within-app dedup)
//   statBlob(component, sha)       -> {size} | null
//   deleteBlob(component, sha)     -> void      // GC ONLY; refcounting is enforced ABOVE, in the ref index
// The local backend also exposes an OPTIONAL async *enumerate() for orphan sweeping (fs-specific; a remote
// backend sweeps server-side and omits it).

export class LocalFileBackend {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filesRoot = join(dataDir, "files");
    this.tmpDir = join(this.filesRoot, ".tmp");
  }

  // Build the on-disk path AFTER validating both segments — defense in depth. The content-addressed
  // name means user input is never a path segment, so this is a belt over the structural suspenders.
  _paths(component, sha) {
    if (!COMPONENT_NAME_RE.test(String(component))) throw new Error("bad_component");
    if (!SHA_RE.test(String(sha))) throw new Error("bad_sha256");
    const dir = join(this.filesRoot, component);
    const p = join(dir, sha + ".blob");
    if (!resolve(p).startsWith(resolve(dir) + sep)) throw new Error("path_escape");
    return { dir, p };
  }

  async statBlob(component, sha) {
    const { p } = this._paths(component, sha);
    try { const st = await fsp.stat(p); return { size: st.size }; }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }

  async hasBlob(component, sha) {
    return (await this.statBlob(component, sha)) !== null;
  }

  async getBlob(component, sha) {
    const { p } = this._paths(component, sha);
    try { return await fsp.readFile(p); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }

  // Atomic + content-idempotent: skip if present; else stage in .tmp, fsync, then rename into place so a
  // reader never observes a partial blob and a crash never leaves a torn file at the content address.
  // opts.force skips the exists-check and ALWAYS re-writes (same content by definition of the address;
  // rename is atomic) — used by the channel's post-commit re-assert, where the point is to land bytes
  // with a FRESH mtime after any straggler GC unlink, not to save a write.
  async putBlob(component, sha, bytes, opts = {}) {
    const { dir, p } = this._paths(component, sha);
    if (!opts.force) {
      const existing = await this.statBlob(component, sha);
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
  async deleteBlob(component, sha, opts = {}) {
    const { p } = this._paths(component, sha);
    try {
      if (opts.ifOlderThanMs) {
        const st = await fsp.stat(p);
        if (Date.now() - st.mtimeMs < opts.ifOlderThanMs) return;
      }
      await fsp.unlink(p);
    }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }

  // Yield every stored blob as {component, sha} so the channel can GC ones with no ref row. Local-only.
  async *enumerate() {
    let comps;
    try { comps = await fsp.readdir(this.filesRoot, { withFileTypes: true }); }
    catch (e) { if (e.code === "ENOENT") return; throw e; }
    for (const c of comps) {
      if (!c.isDirectory() || c.name === ".tmp") continue;
      let blobs;
      try { blobs = await fsp.readdir(join(this.filesRoot, c.name)); }
      catch (e) { if (e.code === "ENOENT") continue; throw e; }
      for (const f of blobs) if (f.endsWith(".blob")) yield { component: c.name, sha: f.slice(0, -5) };
    }
  }

  // ---- staged (chunked) writes — the large-file path. A staging file accumulates appends in .tmp,
  // then LINKS into the content address (hard-link, copy fallback) so the staging copy SURVIVES until
  // the channel has committed the ref and re-verified the blob — the same anti-dangling guarantee
  // put() gets from holding the bytes in memory, without buffering 250 MiB.
  _stagingPath(id) {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) throw new Error("bad_staging_id");
    return join(this.tmpDir, id + ".upload");
  }

  async openStaging() {
    await fsp.mkdir(this.tmpDir, { recursive: true });
    const id = randomUUID();
    const fh = await fsp.open(this._stagingPath(id), "wx");
    await fh.close();
    return id;
  }

  async appendStaging(id, bytes) {
    await fsp.appendFile(this._stagingPath(id), bytes);
  }

  async statStaging(id) {
    try { const st = await fsp.stat(this._stagingPath(id)); return { size: st.size }; }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }

  // Materialize the staged bytes at the content address WITHOUT consuming the staging file.
  // Content-idempotent: an existing blob wins (identical content by definition of the address).
  async linkStaging(id, component, sha) {
    const { dir, p } = this._paths(component, sha);
    const src = this._stagingPath(id);
    await fsp.mkdir(dir, { recursive: true });
    try { await fsp.link(src, p); }
    catch (e) {
      if (e.code === "EEXIST") return;                    // dedup — blob already present
      if (e.code === "EXDEV" || e.code === "EPERM" || e.code === "ENOTSUP") {
        // Filesystem won't hard-link: fall back to an atomic copy via the normal .tmp→rename dance.
        const tmp = join(this.tmpDir, randomUUID());
        try { await fsp.copyFile(src, tmp); await fsp.rename(tmp, p); }
        catch (e2) { await fsp.unlink(tmp).catch(() => {}); if (e2.code !== "EEXIST") throw e2; }
        return;
      }
      throw e;
    }
  }

  async dropStaging(id) {
    try { await fsp.unlink(this._stagingPath(id)); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }

  // Reclaim staging files left by an interrupted/failed write (enumerate() skips .tmp, so the sweep handles
  // it here). Only touch files older than the applicable grace so an in-flight write's staging file is never
  // unlinked. TWO graces: plain UUID temp files (putBlob staging, seconds-lived) use graceMs; "<id>.upload"
  // chunked-upload staging files are contractually alive for UPLOAD_TTL idle minutes and every process over a
  // shared store runs sweeps, so they get the LONGER uploadGraceMs — a mid-flight upload must never be swept
  // out from under its channel within the promised window.
  async sweepTmp(graceMs, uploadGraceMs = graceMs) {
    let entries;
    try { entries = await fsp.readdir(this.tmpDir); }
    catch (e) { if (e.code === "ENOENT") return 0; throw e; }
    let n = 0;
    const now = Date.now();
    for (const name of entries) {
      const f = join(this.tmpDir, name);
      const grace = name.endsWith(".upload") ? uploadGraceMs : graceMs;
      try { const st = await fsp.stat(f); if (now - st.mtimeMs >= grace) { await fsp.unlink(f); n++; } }
      catch { /* raced away — fine */ }
    }
    return n;
  }
}

// ------------------------------------------------------------------ backend selection
export function selectBackend({ dataDir }) {
  const kind = process.env.OMA_FILE_BACKEND || "local";
  if (kind === "local") return new LocalFileBackend(dataDir);
  // The remote/SaaS backend implements the SAME FileBackend interface over HTTPS. Deferred in OSS; the
  // seam is here so it drops in with no change to the channel, the engine tools, or the widget API.
  throw new Error(`OMA_FILE_BACKEND="${kind}" is not implemented yet (OSS ships "local" only).`);
}

// ------------------------------------------------------------------ the orchestrating channel
// Wires the ref index (store) to the byte backend. This is what the engine's file_* tools call.
export function makeFileChannel({ store, backend }) {
  // put: durable blob FIRST, then the ref (idempotent + OCC + quota) in the store's sync tx, then GC any
  // sha the overwrite freed. If the ref write fails, a freshly-written blob is an orphan → left for sweep.
  async function put(component, path, data, { mime = "application/octet-stream", command_id, expected_version } = {}) {
    if (!COMPONENT_NAME_RE.test(String(component))) return { ok: false, error: "bad_component" };
    if (String(path).includes("..") || !FILE_PATH_RE.test(String(path))) return { ok: false, error: "bad_path" };
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: "file_too_large" };
    const sha = sha256hex(bytes);
    const had = await backend.hasBlob(component, sha);
    if (!had) await backend.putBlob(component, sha, bytes);
    const r = store.execute({
      type: "write_file", command_id: command_id || randomUUID(),
      component, path, sha256: sha, size: bytes.length, mime, expected_version,
    });
    if (!r.ok) {
      // The store rejected (quota / OCC / bad input): a blob WE just wrote is now an unreferenced orphan.
      // The GC AGE GUARD skips it while fresh (a concurrent dedup-put may be about to reference it); the
      // next sweep reclaims it once it ages out — disk hygiene is eventual, correctness is immediate.
      if (!had && store.blobRefcount(component, sha) === 0) await backend.deleteBlob(component, sha, { ifOlderThanMs: GC_AGE_GUARD_MS }).catch(() => {});
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
    if (had) await backend.putBlob(component, sha, bytes, { force: true });
    else if (!(await backend.hasBlob(component, sha))) await backend.putBlob(component, sha, bytes, { force: true });
    if (r.freed_sha && store.blobRefcount(component, r.freed_sha) === 0) await backend.deleteBlob(component, r.freed_sha, { ifOlderThanMs: GC_AGE_GUARD_MS }).catch(() => {});
    if (!r.meta) r.meta = store.statFile(component, path); // idempotent replay short-circuits before meta is built
    return r;
  }

  // get: read the ref, fetch bytes, RE-HASH and fail closed on mismatch (tamper / bit-rot).
  async function get(component, path) {
    const meta = store.statFile(component, path);
    if (!meta) return null;
    const bytes = await backend.getBlob(component, meta.sha256);
    if (!bytes) return null;
    if (sha256hex(bytes) !== meta.sha256) throw new Error(`file integrity check failed: ${component}/${path}`);
    return { meta, bytes };
  }

  function stat(component, path) { return store.statFile(component, path); }
  function list(component, prefix) { return { files: store.listFiles(component, prefix), usage: store.fileUsage(component) }; }
  function usage(component) { return store.fileUsage(component); }

  async function del(component, path, { command_id, expected_version } = {}) {
    const r = store.execute({ type: "delete_file", command_id: command_id || randomUUID(), component, path, expected_version });
    if (r.ok && r.freed_sha && store.blobRefcount(component, r.freed_sha) === 0) await backend.deleteBlob(component, r.freed_sha, { ifOlderThanMs: GC_AGE_GUARD_MS });
    return r;
  }

  // ---- chunked upload: begin → append× → commit. The channel keeps ONLY {staging id, running size,
  // incremental sha256} in memory — bytes go straight to the backend's staging area, so a 250 MiB file
  // never lives in RAM. A lost process loses the Map: staging files age out via sweepTmp, and the
  // append-time size cross-check below turns any swept-underneath staging file into a clean error
  // instead of silent truncation (appendFile would otherwise happily recreate an unlinked file).
  const UPLOAD_TTL_MS = 30 * 60 * 1000;   // idle time (since last append) before an upload expires
  const MAX_ACTIVE_UPLOADS = 16;          // DoS floor — concurrent staged uploads across all apps
  const GC_AGE_GUARD_MS = 60 * 1000;      // never GC-unlink a blob fresher than this (see deleteBlob)
  const uploads = new Map();              // upload_id → {component, stagingId, bytes, hash, touched, busy}

  function dropUpload(u, id) { uploads.delete(id); backend.dropStaging(u.stagingId).catch(() => {}); }
  function liveUpload(id) {
    const u = uploads.get(String(id));
    if (!u) return null;
    if (Date.now() - u.touched > UPLOAD_TTL_MS) { dropUpload(u, String(id)); return null; }
    return u;
  }

  async function beginUpload(component) {
    if (!COMPONENT_NAME_RE.test(String(component))) return { ok: false, error: "bad_component" };
    if (typeof backend.openStaging !== "function") return { ok: false, error: "backend_no_staging" };
    for (const [id, u] of uploads) if (Date.now() - u.touched > UPLOAD_TTL_MS) dropUpload(u, id); // lazy expiry
    if (uploads.size >= MAX_ACTIVE_UPLOADS) return { ok: false, error: "too_many_uploads" };
    const stagingId = await backend.openStaging();
    const upload_id = randomUUID();
    uploads.set(upload_id, { component: String(component), stagingId, bytes: 0, hash: createHash("sha256"), touched: Date.now(), busy: false });
    return { ok: true, upload_id, bytes: 0 };
  }

  async function appendUpload(upload_id, data) {
    const u = liveUpload(upload_id);
    if (!u) return { ok: false, error: "upload_not_found" };
    if (u.busy) return { ok: false, error: "upload_busy" };
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (u.bytes + bytes.length > MAX_FILE_BYTES) { dropUpload(u, String(upload_id)); return { ok: false, error: "file_too_large" }; }
    u.busy = true;
    try {
      // Cross-check the staging file is exactly as long as we think — catches a swept/tampered file
      // BEFORE appending would silently recreate it and commit a truncated blob.
      const st = await backend.statStaging(u.stagingId);
      if (!st || st.size !== u.bytes) { dropUpload(u, String(upload_id)); return { ok: false, error: "upload_expired" }; }
      await backend.appendStaging(u.stagingId, bytes);
      u.hash.update(bytes);
      u.bytes += bytes.length;
      u.touched = Date.now();
      return { ok: true, bytes: u.bytes };
    } catch (e) {
      dropUpload(u, String(upload_id));
      throw e;
    } finally { u.busy = false; }
  }

  async function commitUpload(upload_id, path, { mime = "application/octet-stream", command_id, expected_version } = {}) {
    const u = liveUpload(upload_id);
    if (!u) return { ok: false, error: "upload_not_found" };
    if (u.busy) return { ok: false, error: "upload_busy" };
    if (String(path).includes("..") || !FILE_PATH_RE.test(String(path))) return { ok: false, error: "bad_path" };
    u.busy = true;
    try {
      const st = await backend.statStaging(u.stagingId);
      if (!st || st.size !== u.bytes) { dropUpload(u, String(upload_id)); return { ok: false, error: "upload_expired" }; }
      const sha = u.hash.digest("hex");
      const had = await backend.hasBlob(u.component, sha);
      try { if (!had) await backend.linkStaging(u.stagingId, u.component, sha); }
      catch (e) { dropUpload(u, String(upload_id)); if (e.code === "ENOENT") return { ok: false, error: "upload_expired" }; throw e; } // staging swept/aborted underneath → clean error, not a crash
      const r = store.execute({
        type: "write_file", command_id: command_id || randomUUID(),
        component: u.component, path, sha256: sha, size: u.bytes, mime, expected_version,
      });
      if (!r.ok) {
        if (!had && store.blobRefcount(u.component, sha) === 0) await backend.deleteBlob(u.component, sha, { ifOlderThanMs: GC_AGE_GUARD_MS }).catch(() => {});
        dropUpload(u, String(upload_id)); // the store said no — the upload is spent either way (hash is consumed)
        return r;
      }
      // Same TOCTOU close as put(): re-link UNCONDITIONALLY (EEXIST is a cheap no-op; a GC'd blob is
      // re-materialized from the still-held staging file), then GC the freed sha behind the age guard.
      try { await backend.linkStaging(u.stagingId, u.component, sha); } catch { /* EEXIST handled inside; anything else → sweep reconciles */ }
      if (r.freed_sha && store.blobRefcount(u.component, r.freed_sha) === 0) await backend.deleteBlob(u.component, r.freed_sha, { ifOlderThanMs: GC_AGE_GUARD_MS }).catch(() => {});
      if (!r.meta) r.meta = store.statFile(u.component, path);
      dropUpload(u, String(upload_id));
      return r;
    } catch (e) {
      dropUpload(u, String(upload_id));
      throw e;
    } finally { u.busy = false; }
  }

  async function abortUpload(upload_id) {
    const u = uploads.get(String(upload_id));
    if (u && u.busy) return { ok: false, error: "upload_busy" };   // never yank staging out from under an in-flight append/commit
    if (u) dropUpload(u, String(upload_id));
    return { ok: true };
  }

  // Unlink any stored blob with no ref row (the harmless orphans blob-first/ref-second can leave, plus any
  // left by an interrupted write). Startup + periodic. No-op on backends without enumerate().
  async function sweepOrphans() {
    let swept = 0;
    if (typeof backend.enumerate === "function") {
      for await (const { component, sha } of backend.enumerate()) {
        // AGE GUARD: a refcount-0 read can race a writer about to commit a ref for this sha; that
        // writer always (re)writes the blob with a fresh mtime, so only OLD unreferenced blobs are
        // truly orphans. Fresh ones get another look on the next sweep.
        if (store.blobRefcount(component, sha) === 0) { await backend.deleteBlob(component, sha, { ifOlderThanMs: GC_AGE_GUARD_MS }); swept++; }
      }
    }
    // Plain putBlob temp files: 5-min grace. Chunked ".upload" staging: the contractual idle TTL
    // plus slack — other processes over the same store run this sweep too and must never destroy a
    // mid-flight upload inside its promised window.
    if (typeof backend.sweepTmp === "function") await backend.sweepTmp(5 * 60 * 1000, UPLOAD_TTL_MS + 5 * 60 * 1000).catch(() => {});
    return { swept };
  }

  return { put, get, stat, list, usage, del, sweepOrphans, beginUpload, appendUpload, commitUpload, abortUpload };
}

// Convenience wiring for the engine: pick the backend from the store's own data dir + build the channel.
// MEMOIZED PER STORE: chunked-upload sessions live in the channel's in-memory Map, and the stateless
// /mcp transport builds a FRESH engine per request over ONE shared store — without memoization every
// request got its own empty Map and file_write_begin/chunk could never pair up (reproduced: chunked
// upload was 100% dead over /mcp). One store → one channel → one upload table; the startup orphan
// sweep runs once per channel, not once per request.
const channelByStore = new WeakMap();
export function openFileChannel(store) {
  let ch = channelByStore.get(store);
  if (!ch) {
    ch = makeFileChannel({ store, backend: selectBackend({ dataDir: store.dataDir }) });
    channelByStore.set(store, ch);
    ch.sweepOrphans().catch(() => {});   // fire-and-forget crash recovery, once per store/process
  }
  return ch;
}
