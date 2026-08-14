// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/files-smoke.mjs — the FILE channel end-to-end (real bytes on disk): content-addressed dedup,
// blob-first/ref-second GC, read-time integrity, orphan sweep, per-app isolation. Store-plane invariants
// (quota/OCC/idempotency) live in server-smoke §23; this proves the src/files.mjs backend + channel.
// Run: node test/files-smoke.mjs
import { createHash } from "node:crypto";
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
// Chunked-upload staging gets the LONG grace (upload TTL + slack): a 10-min-idle upload is
// contractually alive and must survive any process's sweep; a 40-min one is truly dead.
const midUpload = join(filesRoot, ".tmp", "mid-idle.upload");
const deadUpload = join(filesRoot, ".tmp", "long-dead.upload");
writeFileSync(midUpload, "10 minutes idle — still inside the 30-min TTL");
writeFileSync(deadUpload, "40 minutes idle — past TTL + slack");
const tenMinAgo = new Date(Date.now() - 10 * 60_000);
const fortyMinAgo = new Date(Date.now() - 40 * 60_000);
utimesSync(midUpload, tenMinAgo, tenMinAgo);
utimesSync(deadUpload, fortyMinAgo, fortyMinAgo);
await ch.sweepOrphans();
ok("stale .tmp leftover reclaimed, fresh one preserved", !existsSync(staleTmp) && existsSync(freshTmp));
ok(".upload staging honors the LONG grace: 10-min-idle survives, 40-min-idle reclaimed", existsSync(midUpload) && !existsSync(deadUpload));
rmSync(midUpload, { force: true });

console.log("10. chunked channel — begin/append/commit roundtrip, dedup, abort cleanup, expiry, OCC orphan GC");
// Staging-file removal (dropStaging) is fire-and-forget inside the channel, so counts are polled.
const tmpUploads = () => { try { return readdirSync(join(filesRoot, ".tmp")).filter((f) => f.endsWith(".upload")); } catch { return []; } };
const waitUploads = async (n) => { for (let i = 0; i < 200 && tmpUploads().length !== n; i++) await new Promise((r) => setTimeout(r, 10)); return tmpUploads().length === n; };
const bu = await ch.beginUpload("chunky");
ok("beginUpload hands back an upload_id", bu.ok && typeof bu.upload_id === "string");
await ch.appendUpload(bu.upload_id, "chunk-one ");
const ap = await ch.appendUpload(bu.upload_id, "chunk-two");
ok("appends accumulate the running size", ap.ok && ap.bytes === 19);
const cm = await ch.commitUpload(bu.upload_id, "streamed.txt", { mime: "text/plain" });
ok("commit lands the ref (stamped with its ledger position, size 19, mime kept)", cm.ok && cm.meta.version > 0 && cm.meta.size === 19 && cm.meta.mime === "text/plain");
const gotChunky = await ch.get("chunky", "streamed.txt");
ok("get returns the exact assembled bytes", gotChunky && gotChunky.bytes.toString() === "chunk-one chunk-two" && gotChunky.meta.size === 19);
// dedup: a chunked commit of bytes an earlier put() already stored → same sha, no second blob
await ch.put("chunky", "orig.bin", "dedup my bytes");
const blobsBefore = blobCount("chunky");
const bu2 = await ch.beginUpload("chunky");
await ch.appendUpload(bu2.upload_id, "dedup my bytes");
const cm2 = await ch.commitUpload(bu2.upload_id, "copy-via-chunks.bin");
ok("identical content dedups (same sha256, blob count unchanged)", cm2.ok && cm2.meta.sha256 === ch.stat("chunky", "orig.bin").sha256 && blobCount("chunky") === blobsBefore);
ok("commits consumed their staging files", await waitUploads(0));
// abortUpload retired (elegance A12): an abandoned upload's staging is owned by the TTL sweep
// (sweepTmp), exercised below via the swept-underneath path.
// upload_expired: the staging file vanishes underneath a live upload (e.g. swept) → clean error, not truncation
const bu4 = await ch.beginUpload("chunky");
await ch.appendUpload(bu4.upload_id, "first half ");
for (const f of tmpUploads()) rmSync(join(filesRoot, ".tmp", f));
const ap4 = await ch.appendUpload(bu4.upload_id, "second half");
ok("append after the staging file was swept → upload_expired", !ap4.ok && ap4.error === "upload_expired");
// OCC mismatch on commit: conflict; the freshly-linked NEW blob is left in place by the GC AGE
// GUARD (a fresh unreferenced blob may be a racing writer's — only OLD orphans are unlinked),
// and a later sweep reclaims it once it ages past the guard.
const occFirst = await ch.put("occ-chunk", "target.txt", "version one");
const bu5 = await ch.beginUpload("occ-chunk");
await ch.appendUpload(bu5.upload_id, "brand new content never stored before");
const cm5 = await ch.commitUpload(bu5.upload_id, "target.txt", { expected_version: 99 });
ok("commit with a stale expected_version → conflict", !cm5.ok && cm5.conflict === true && cm5.expected === occFirst.meta.version);
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

console.log("11. write-set C appends — chunk dedup and the commit that survives a lost reply");
{
  const enc = (s) => Buffer.from(s);
  const u1 = await ch.beginUpload("chunky");
  await ch.appendUpload(u1.upload_id, enc("AAAA"), { seq: 0 });
  const dup = await ch.appendUpload(u1.upload_id, enc("AAAA"), { seq: 0 });
  ok("a resent chunk index is acknowledged, not appended twice — the timeout-resend is now safe",
    dup.ok === true && dup.duplicate === true && dup.bytes === 4);
  const ooo = await ch.appendUpload(u1.upload_id, enc("BBBB"), { seq: 5 });
  ok("a future index names the one expected", ooo.ok === false && ooo.error === "chunk_out_of_order" && ooo.expected === 1);
  await ch.appendUpload(u1.upload_id, enc("BBBB"), { seq: 1 });
  const good = await ch.commitUpload(u1.upload_id, "c.bin", { command_id: "c15-commit" });
  ok("commit reports the staged bytes' true hash and size (expected_sha256 precheck retired — commit's own sha IS the receipt)",
    good.ok === true && good.meta.sha256 === createHash("sha256").update("AAAABBBB").digest("hex") && good.meta.size === 8);
  // THE adversarial-challenge pin: the reply to a successful commit is lost, the upload is
  // consumed, the host retries — and used to be told "start again with file_write_begin",
  // inducing a full re-upload. The ledger answers first now.
  const replay = await ch.commitUpload(u1.upload_id, "c.bin", { command_id: "c15-commit" });
  ok("a retried commit with the same command_id returns the ORIGINAL receipt — no re-upload demanded",
    replay.ok === true && replay.idempotent === true && replay.meta.sha256 === good.meta.sha256);
  const reused = await ch.commitUpload("no-such-upload", "other.bin", { command_id: "c15-commit" });
  ok("…while the same command_id aimed at a DIFFERENT path is refused",
    reused.ok === false && reused.error === "command_id_reused");

  // C-review residue: a duplicate index is only a duplicate if it carries the SAME bytes.
  const u2 = await ch.beginUpload("chunky");
  await ch.appendUpload(u2.upload_id, enc("AAA"), { seq: 0 });
  const lied = await ch.appendUpload(u2.upload_id, enc("BBB"), { seq: 0 });
  ok("a resend with DIFFERENT bytes is chunk_mismatch, never a false ack", lied.ok === false && lied.error === "chunk_mismatch");
  await ch.appendUpload(u2.upload_id, enc("CCC"), { seq: 1 });
  const old0 = await ch.appendUpload(u2.upload_id, enc("AAA"), { seq: 0 });
  ok("an older staged index cannot be re-verified and is refused", old0.ok === false && old0.error === "chunk_already_staged");
  // C-review residue: the replay receipt is the ORIGINAL commit's, never the current row's.
  const u3 = await ch.beginUpload("chunky");
  await ch.appendUpload(u3.upload_id, enc("first"));
  const k1 = await ch.commitUpload(u3.upload_id, "r.bin", { command_id: "c15-replay" });
  const u4 = await ch.beginUpload("chunky");
  await ch.appendUpload(u4.upload_id, enc("second-longer"));
  await ch.commitUpload(u4.upload_id, "r.bin", { command_id: "c15-other" });
  const kReplay = await ch.commitUpload(u3.upload_id, "r.bin", { command_id: "c15-replay" });
  ok("a commit replay after an overwrite reports the ORIGINAL bytes, not the row's current state",
    kReplay.ok === true && kReplay.idempotent === true && kReplay.meta.sha256 === k1.meta.sha256 && kReplay.meta.size === 5);
  const u5 = await ch.beginUpload("other-comp");
  await ch.appendUpload(u5.upload_id, enc("zzz"));
  const cross = await ch.commitUpload(u5.upload_id, "r.bin", { command_id: "c15-replay" });
  ok("a different app's live upload cannot ride an old command_id", cross.ok === false && cross.error === "command_id_reused");
}

store.close();
rmSync(TMP, { recursive: true, force: true });
console.log(fail ? `FAILURES: ${pass} passed, ${fail} failed` : `ALL PASS: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
