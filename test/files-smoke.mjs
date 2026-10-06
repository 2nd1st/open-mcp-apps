// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/files-smoke.mjs — the FILE channel end-to-end (real bytes on disk): content-addressed dedup,
// blob-first/ref-second GC, read-time integrity, orphan sweep, per-app isolation. Store-plane invariants
// (quota/OCC/idempotency) live in server-smoke §23; this proves the src/files.mjs backend + channel.
// Run: node test/files-smoke.mjs
import { existsSync, readdirSync, writeFileSync, rmSync, mkdirSync, utimesSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openStore } from "../src/store.mjs";
import { openFileChannel } from "../src/files.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, "test", "filestore-tmp");
rmSync(TMP, { recursive: true, force: true });

const store = openStore(join(TMP, "open-mcp-apps.db")); // store.dataDir = TMP → files under TMP/files
const ch = openFileChannel(store);
const filesRoot = join(TMP, "files");
const blobCount = (app) => { try { return readdirSync(join(filesRoot, app)).filter((f) => f.endsWith(".blob")).length; } catch { return 0; } };

let pass = 0, fail = 0;
const ok = (name, cond) => (cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name)));

console.log("1. put → get roundtrip + on-disk blob");
const w = await ch.put("notes", "hello.txt", "hello world", { mime: "text/plain" });
ok("put returns ok + v1 meta", w.ok && w.created && w.meta.version === 1 && w.meta.size === 11);
ok("blob landed on disk under files/notes/", blobCount("notes") === 1);
const g = await ch.get("notes", "hello.txt");
ok("get returns the exact bytes", g && Buffer.isBuffer(g.bytes) && g.bytes.toString() === "hello world");
ok("get on a missing path → null", (await ch.get("notes", "ghost.txt")) === null);

console.log("2. content-addressed dedup — same bytes, two paths, ONE blob");
await ch.put("notes", "copy.txt", "hello world", { mime: "text/plain" });
ok("second identical put reuses the blob (still 1 on disk)", blobCount("notes") === 1);
ok("within-app refcount is 2", store.blobRefcount("notes", g.meta.sha256) === 2);

console.log("3. overwrite + GC — freed sha collected only when unreferenced");
await ch.put("notes", "hello.txt", "different content", { mime: "text/plain" }); // hello.txt → new sha
ok("overwrite wrote a second distinct blob", blobCount("notes") === 2);
ok("old sha survives — still referenced by copy.txt", store.blobRefcount("notes", g.meta.sha256) === 1 && existsSync(join(filesRoot, "notes", g.meta.sha256 + ".blob")));
// GC honors the AGE GUARD: only blobs older than the guard window are unlinked inline (a fresh
// unreferenced blob may belong to a racing writer). Backdate it → the delete's GC reclaims it.
{ const bp = join(filesRoot, "notes", g.meta.sha256 + ".blob"); const old = new Date(Date.now() - 2 * 60_000); utimesSync(bp, old, old); }
const d = await ch.del("notes", "copy.txt");
ok("delete frees the now-unreferenced (aged) old blob (GC)", d.ok && blobCount("notes") === 1 && !existsSync(join(filesRoot, "notes", g.meta.sha256 + ".blob")));
ok("deleted path reads back null", (await ch.get("notes", "copy.txt")) === null);

console.log("4. read-time integrity — corrupt a blob on disk → get fails closed");
const iw = await ch.put("vault", "secret.bin", "trustworthy bytes");
writeFileSync(join(filesRoot, "vault", iw.meta.sha256 + ".blob"), "tampered!!"); // corrupt under the same name
let threw = false;
try { await ch.get("vault", "secret.bin"); } catch { threw = true; }
ok("get throws on sha256 mismatch (tamper/bit-rot)", threw);

console.log("5. per-app isolation on disk + in the ref index");
await ch.put("app-a", "shared-name.txt", "A's data");
await ch.put("app-b", "shared-name.txt", "B's data");
ok("same path in two apps → separate dirs + separate content", existsSync(join(filesRoot, "app-a")) && existsSync(join(filesRoot, "app-b")) && (await ch.get("app-a", "shared-name.txt")).bytes.toString() === "A's data" && (await ch.get("app-b", "shared-name.txt")).bytes.toString() === "B's data");
ok("stat is app-scoped (each app resolves its OWN content)", ch.stat("app-a", "shared-name.txt") !== null && ch.stat("app-a", "shared-name.txt").sha256 !== ch.stat("app-b", "shared-name.txt").sha256);

console.log("6. bad input fails closed BEFORE touching the backend");
ok("bad app rejected", (await ch.put("Bad Comp!", "x.txt", "y")).error === "bad_app");
ok("traversal path rejected", (await ch.put("notes", "../escape", "y")).error === "bad_path");

console.log("7. sweepOrphans — unlink AGED blobs with no ref row, keep referenced + fresh ones");
await ch.put("sweep", "keep.txt", "referenced");
const strayPath = join(filesRoot, "sweep", "d".repeat(64) + ".blob");
writeFileSync(strayPath, "orphan with no ref row"); // stray blob
ok("stray blob present before sweep", blobCount("sweep") === 2);
await ch.sweepOrphans();
ok("FRESH orphan survives the sweep (age guard — may be a racing writer's)", blobCount("sweep") === 2);
{ const old = new Date(Date.now() - 2 * 60_000); utimesSync(strayPath, old, old); } // age it past the guard
const swept = await ch.sweepOrphans();
ok("aged orphan removed, referenced blob kept", blobCount("sweep") === 1 && ch.stat("sweep", "keep.txt") !== null && !existsSync(strayPath));

console.log("8. concurrency — a dedup-put racing a delete of the same content must NOT dangle the ref (finding 1)");
let raceOk = true;
for (let i = 0; i < 15; i++) {
  const c = "shared racing bytes " + i;               // fresh content each round → fresh sha, refcount 1 via a+i
  await ch.put("race", "a" + i, c);
  const [pRes] = await Promise.all([ch.put("race", "b" + i, c), ch.del("race", "a" + i)]); // b+i dedups on the sha del a+i frees
  const g = await ch.get("race", "b" + i);
  if (!pRes.ok || !g || g.bytes.toString() !== c) raceOk = false;
}
ok("committed writes keep their bytes under put/del races (no dangling ref, no data loss)", raceOk);

console.log("9. sweepOrphans reclaims STALE .tmp staging leftovers, keeps in-flight ones (finding 6)");
mkdirSync(join(filesRoot, ".tmp"), { recursive: true });
const staleTmp = join(filesRoot, ".tmp", "stale-leftover");
const freshTmp = join(filesRoot, ".tmp", "fresh-inflight");
writeFileSync(staleTmp, "remnant of an interrupted write");
writeFileSync(freshTmp, "an in-flight write's staging file");
const hourAgo = new Date(Date.now() - 3600_000);
utimesSync(staleTmp, hourAgo, hourAgo);                       // backdate past the 5-min grace
await ch.sweepOrphans();
ok("stale .tmp leftover reclaimed, fresh one preserved", !existsSync(staleTmp) && existsSync(freshTmp));

console.log("10. OCC conflict on put — the fresh orphan blob is age-guarded, then swept");
// (The chunked begin/append/commit channel this section used to cover was removed in 0.8.1 —
// zero callers. The orphan-GC half it shared with put() is what remains, now driven by put().)
// OCC mismatch: conflict; the freshly-written NEW blob is left in place by the GC AGE GUARD (a
// fresh unreferenced blob may be a racing writer's — only OLD orphans are unlinked), and a later
// sweep reclaims it once it ages past the guard.
const occFirst = await ch.put("occ-chunk", "target.txt", "version one");
const cm5 = await ch.put("occ-chunk", "target.txt", "brand new content never stored before", { expected_version: 99 });
ok("put with a stale expected_version → conflict", !cm5.ok && cm5.conflict === true && cm5.expected === occFirst.meta.version);
ok("the fresh orphan blob is AGE-GUARDED (still on disk right after the conflict)", blobCount("occ-chunk") === 2);
ok("the target file's bytes are untouched", (await ch.get("occ-chunk", "target.txt")).bytes.toString() === "version one");
{ // age the orphan past the guard → the sweep reclaims exactly it
  const dir = join(filesRoot, "occ-chunk");
  const refSha = ch.stat("occ-chunk", "target.txt").sha256;
  const old = new Date(Date.now() - 2 * 60_000);
  for (const f of readdirSync(dir)) if (!f.startsWith(refSha)) utimesSync(join(dir, f), old, old);
  await ch.sweepOrphans();
  ok("aged orphan reclaimed by the sweep; the referenced blob survives", blobCount("occ-chunk") === 1);
}

store.close();
rmSync(TMP, { recursive: true, force: true });
console.log(fail ? `FAILURES: ${pass} passed, ${fail} failed` : `ALL PASS: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
