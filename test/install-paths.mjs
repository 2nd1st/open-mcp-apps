// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/install-paths.mjs — the four install-path defects found by walking the PUBLIC surface, v0.4.2.
//
// What these four have in common is not a wrong computation. Every one of them RAN correctly and
// then said something untrue about what it had done: a dry run that migrated, a re-install that
// deleted env while reporting `unchanged`, a failed registration that exited 0 printing ✅, and a
// half-finished migration that a doc comment called "harmless". So each assertion below checks the
// STATE the command left behind against the SENTENCE it printed — never one of them alone.
//
// The migration cases use a v3 fixture built here rather than a checked-in database: what makes
// the v0.4 window dangerous is the shape (v4 tables stamped v3), and the shape is what a fixture
// has to carry. Host-config cases run against a sandbox HOME — install.mjs resolves every path
// through homedir(), so a fake HOME is a complete isolation boundary.
//
// Run: node test/install-paths.mjs

import Database from "better-sqlite3";
import { existsSync, unlinkSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { openStore, renameLegacyTables, SCHEMA_VERSION } from "../src/store.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, "test", "tmp-install-paths");
const rm = (p) => { for (const f of [p, p + "-wal", p + "-shm"]) if (existsSync(f)) unlinkSync(f); };

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// install.mjs installs deps as part of a real install, and `npm install` rewrites package-lock.json
// as a side effect. A test suite must not leave the working tree dirty, so the lockfile is restored
// byte-for-byte on the way out — including when an assertion above has already thrown.
const LOCK = join(ROOT, "package-lock.json");
const LOCK_BEFORE = readFileSync(LOCK);
const restoreLock = () => { if (!readFileSync(LOCK).equals(LOCK_BEFORE)) writeFileSync(LOCK, LOCK_BEFORE); };
process.on("exit", restoreLock);

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const uv = (p) => { const d = new Database(p, { readonly: true }); const v = d.pragma("user_version", { simple: true }); d.close(); return v; };
const tables = (p) => { const d = new Database(p, { readonly: true }); const t = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name); d.close(); return t; };

// A v3 store: the era before the component → app rename, with one app and three items in it.
// Built by taking a REAL current store and renaming it BACKWARDS, rather than by hand-writing the
// old DDL. A hand-written fixture drifts — the first attempt at this file omitted a column the
// engine needs and failed the fixture instead of the code — and the only thing v3 means for the
// code under test is the naming, which is exactly what the reverse rename reproduces.
const makeV3 = (p) => {
  rm(p);
  openStore(p).close();                                  // a real store at the current schema
  const d = new Database(p);
  const now = new Date().toISOString();
  d.prepare(`INSERT INTO app (name,version,html,description,author,kind,visibility,updated_at)
             VALUES (?,?,?,?,?,?,?,?)`).run("my-tracker", 1, "<html>three years of it</html>", "", "human", "app", "listed", now);
  const ins = d.prepare(`INSERT INTO item (id,collection,grp,position,fields,version,created_at,updated_at)
                         VALUES (?,?,?,?,?,?,?,?)`);
  for (let i = 1; i <= 3; i++) ins.run("i" + i, "my-tracker", "", i, JSON.stringify({ t: "row" + i }), 1, now, now);
  d.exec("ALTER TABLE app RENAME TO component");
  d.exec("ALTER TABLE app_history RENAME TO component_history");
  d.exec("ALTER TABLE file RENAME COLUMN app TO component");
  d.exec("DROP INDEX IF EXISTS idx_file_app");
  d.exec("CREATE INDEX IF NOT EXISTS idx_file_component ON file(component)");
  d.pragma("user_version = 3");
  d.close();
  return p;
};

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n1. W-3 — a command that only LOOKS writes nothing, INCLUDING the schema");
// The old shape opened the store for write before it looked at --dry-run, so the one-way v3→v4
// climb ran and the command then printed "nothing written". A dry run that cannot be undone is
// the worst kind of lie a --dry-run flag can tell.
{
  const db = makeV3(join(TMP, "dry-v3.db"));
  const before = { uv: uv(db), sha: sha(db) };
  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath, [join(ROOT, "install-app.mjs"), join(ROOT, "components", "habit-streaks.html"), "--dry-run"],
      { env: { ...process.env, OMA_DB: db }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { code = e.status; out = (e.stdout || "") + (e.stderr || ""); }

  ok("an old store is left at its own schema version", uv(db) === 3, `user_version is ${uv(db)}, was ${before.uv}`);
  ok("not one byte of it changed", sha(db) === before.sha);
  ok("it still has its v3 tables", tables(db).includes("component"), tables(db).join(","));
  ok("and it SAYS it cannot do this, instead of doing it silently", code === 1 && /read-only open/.test(out), out.trim().slice(0, 160));

  // The other half of the same bug: with no store at all, a dry run used to CREATE one.
  const fresh = join(TMP, "nowhere", "store.db");
  const o2 = execFileSync(process.execPath, [join(ROOT, "install-app.mjs"), join(ROOT, "components", "habit-streaks.html"), "--dry-run"],
    { env: { ...process.env, OMA_DB: fresh }, encoding: "utf8" });
  ok("with no store at all, a dry run creates none", !existsSync(fresh));
  ok("and says so rather than implying it looked", /nothing written/.test(o2) && /no store exists yet/.test(o2), o2.trim());

  // --list is the SAME defect through a second entrance, and takes the same door. Shipping the
  // dry-run fix alone would have put a release note in front of users that says "a dry run no
  // longer migrates your store" while `--list` still did.
  const listDb = makeV3(join(TMP, "list-v3.db"));
  const listBefore = sha(listDb);
  let listOut = "", listCode = 0;
  try {
    listOut = execFileSync(process.execPath, [join(ROOT, "install-app.mjs"), "--list"],
      { env: { ...process.env, OMA_DB: listDb }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { listCode = e.status; listOut = (e.stdout || "") + (e.stderr || ""); }
  ok("--list leaves an old store at its own schema version", uv(listDb) === 3, `user_version is ${uv(listDb)}`);
  ok("--list changes not one byte of it", sha(listDb) === listBefore);
  ok("…and says so instead of migrating to answer", listCode === 1 && /read-only open/.test(listOut), listOut.trim().slice(0, 140));

  const listFresh = join(TMP, "list-nowhere", "store.db");
  const lo = execFileSync(process.execPath, [join(ROOT, "install-app.mjs"), "--list"],
    { env: { ...process.env, OMA_DB: listFresh }, encoding: "utf8" });
  ok("--list on a machine with no store creates none", !existsSync(listFresh));
  ok("…and still answers the question it was asked", /no apps installed/.test(lo), lo.trim());

  // Regression: the ordinary install must still migrate. A fix that froze the ladder would pass
  // every assertion above and break the product.
  execFileSync(process.execPath, [join(ROOT, "install-app.mjs"), join(ROOT, "components", "habit-streaks.html")],
    { env: { ...process.env, OMA_DB: db }, encoding: "utf8" });
  ok("a REAL install still migrates the same store", uv(db) === SCHEMA_VERSION, `user_version is ${uv(db)}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n2. W-1 — the v3→v4 window is all-or-nothing, and its wreckage repairs itself");
{
  // 2a. An interrupted migration leaves the store fully v3 — table shape AND version, not one
  // without the other. The half state (v4 tables stamped v3) is what an older build turns into a
  // store neither build will open, so the fix is that it cannot exist, not that it is survivable.
  const db = makeV3(join(TMP, "atomic.db"));
  const d = new Database(db);
  d.exec(`CREATE TRIGGER boom BEFORE UPDATE ON component WHEN NEW.author = 'library'
          BEGIN SELECT RAISE(ABORT, 'injected mid-climb failure'); END;`);
  d.pragma("user_version = 1");                    // climb 1→4 so a migration step runs and throws
  d.prepare("UPDATE component SET author = 'gallery'").run();
  d.close();

  let threw = false;
  try { openStore(db).close(); } catch { threw = true; }
  ok("an interrupted migration throws", threw);
  ok("…and leaves the v3 table names, not the v4 ones", tables(db).includes("component") && !tables(db).includes("app"), tables(db).join(","));
  ok("…and leaves user_version where it was", uv(db) === 1, `user_version is ${uv(db)}`);

  const d2 = new Database(db); d2.exec("DROP TRIGGER boom"); d2.close();
  openStore(db).close();
  ok("removing the cause lets the same store migrate cleanly", uv(db) === SCHEMA_VERSION && tables(db).includes("app"));

  // 2b. The wreckage that already exists in the wild: v4 tables plus the empty v3 tables an older
  // build re-created beside them. One side is empty, so which is residue is a fact, not a guess.
  const wreck = makeV3(join(TMP, "wreck.db"));
  const w = new Database(wreck);
  renameLegacyTables(w);                          // half migration: tables renamed…
  w.pragma("user_version = 3");                   // …version never stamped
  // …and then an older build opens it: its CREATE TABLE IF NOT EXISTS re-makes the v3 tables
  // (empty) beside the v4 ones before it dies on an index. Only existence and emptiness matter to
  // the code under test, so these stand in for that pass without re-stating the whole v3 DDL.
  w.exec("CREATE TABLE component (name TEXT PRIMARY KEY, html TEXT)");
  w.exec("CREATE TABLE component_history (name TEXT, version INTEGER)");
  w.close();
  ok("the wreck really has both table sets before we start",
    tables(wreck).includes("app") && tables(wreck).includes("component"), tables(wreck).join(","));

  // Caught, not left to throw: a regression here is the ORIGINAL defect coming back, and this
  // suite has to report that as one red line rather than die on a stack trace mid-run.
  let app = null, wreckErr = "";
  try { const s = openStore(wreck); app = s.getApp("my-tracker"); s.close(); }
  catch (e) { wreckErr = e.message; }
  ok("0.4.2 opens it instead of refusing forever", !!app, wreckErr);
  ok("the user's app came back intact", app?.html === "<html>three years of it</html>");
  ok("the empty residue is gone", !tables(wreck).includes("component"), tables(wreck).join(","));
  ok("and the store finished its migration", uv(wreck) === SCHEMA_VERSION);
  let reopened = true;
  try { openStore(wreck).close(); } catch { reopened = false; }
  ok("reopening changes nothing", reopened && uv(wreck) === SCHEMA_VERSION && !tables(wreck).includes("component"));

  // 2c. Two POPULATED sides stay a refusal — that one really is ambiguous — but the refusal now
  // carries the way out, and the section it names has to exist.
  const ambig = makeV3(join(TMP, "ambiguous.db"));
  const a = new Database(ambig);
  a.exec("CREATE TABLE app (name TEXT PRIMARY KEY, version INTEGER, html TEXT, description TEXT, author TEXT, updated_at TEXT)");
  a.prepare("INSERT INTO app (name,version,html,description,author,updated_at) VALUES (?,?,?,?,?,?)")
    .run("other-side", 1, "<p>b</p>", "", "human", new Date().toISOString());
  a.close();
  let msg = "";
  try { openStore(ambig).close(); } catch (e) { msg = e.message; }
  ok("two populated sides are still refused", /BOTH hold rows/.test(msg), msg.slice(0, 120));
  const anchor = 'A store that neither build will open';
  ok("the refusal names a recovery procedure", msg.includes(anchor), msg);
  ok("…and that section actually exists in KNOWN-ISSUES.md",
    readFileSync(join(ROOT, "KNOWN-ISSUES.md"), "utf8").includes(`## ${anchor}`),
    "the error points at a section that is not there — a pointer that lies is worse than none");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n3. W-2 — a re-install keeps what the user put in the entry, and `unchanged` means it");
{
  const HOME = join(TMP, "home2");
  const cfgDir = join(HOME, "Library", "Application Support", "Claude");
  mkdirSync(cfgDir, { recursive: true });
  const cfg = join(cfgDir, "claude_desktop_config.json");
  writeFileSync(cfg, JSON.stringify({ mcpServers: {} }));
  const run = () => execFileSync(process.execPath, [join(ROOT, "install.mjs"), "--host", "claude", "--yes"],
    { env: { ...process.env, HOME }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const read = () => JSON.parse(readFileSync(cfg, "utf8")).mcpServers;

  run();
  const entry = read()["open-mcp-apps"];
  ok("the first run registers the server", !!entry?.args?.[0]);

  // The user edits their own entry — a proxy, a feature flag, a sibling field — and adds another
  // server. Then they re-run the installer for an unrelated reason.
  const j = JSON.parse(readFileSync(cfg, "utf8"));
  j.mcpServers["open-mcp-apps"].env.HTTPS_PROXY = "http://corp-proxy:8080";
  j.mcpServers["open-mcp-apps"].timeout = 60000;
  j.mcpServers["other"] = { command: "node", args: ["/tmp/o.mjs"], env: { OTHER_SECRET: "keep-me" } };
  writeFileSync(cfg, JSON.stringify(j, null, 2));
  const beforeSha = sha(cfg);
  const out = run();

  ok("a run that changes nothing reports `unchanged`", /unchanged/.test(out), out.slice(0, 200));
  ok("…and `unchanged` means the file was not rewritten", sha(cfg) === beforeSha,
    "the summary said unchanged while the bytes moved — that is the defect, not a cosmetic one");
  ok("the user's env survives", read()["open-mcp-apps"].env.HTTPS_PROXY === "http://corp-proxy:8080");
  ok("so does a field we do not own", read()["open-mcp-apps"].timeout === 60000);
  ok("and another server is untouched", read().other.env.OTHER_SECRET === "keep-me");

  // The harder half: an entry that IS stale must be corrected — and still keep what is the user's.
  const k = JSON.parse(readFileSync(cfg, "utf8"));
  k.mcpServers["open-mcp-apps"].command = "/usr/local/bin/node";
  k.mcpServers["open-mcp-apps"].args = ["/old/path/server.mjs"];
  writeFileSync(cfg, JSON.stringify(k, null, 2));
  const out2 = run();
  ok("a stale entry is reported as `updated`, not `unchanged`", /updated/.test(out2), out2.slice(0, 200));
  ok("…and is actually corrected", read()["open-mcp-apps"].args[0].endsWith("src/server.mjs"));
  ok("…while the user's env still survives the rewrite", read()["open-mcp-apps"].env.HTTPS_PROXY === "http://corp-proxy:8080");
  ok("…and our own key is still set", read()["open-mcp-apps"].env.OMA_DYNAMIC_TOOLS === "1");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n4. W-4 — a host that could not be registered fails the run, on stdout and in the exit code");
{
  const HOME = join(TMP, "home4");
  const cfgDir = join(HOME, "Library", "Application Support", "Claude");
  mkdirSync(cfgDir, { recursive: true });
  const cfg = join(cfgDir, "claude_desktop_config.json");
  writeFileSync(cfg, '{ "mcpServers": { "open-mcp-apps": <<<not json>>> ');

  let code = 0, stdout = "";
  try {
    stdout = execFileSync(process.execPath, [join(ROOT, "install.mjs"), "--host", "claude", "--yes"],
      { env: { ...process.env, HOME }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) { code = e.status; stdout = e.stdout || ""; }

  ok("the process exits non-zero", code !== 0, `exit code was ${code}`);
  // stdio here captures STDOUT ONLY, on purpose: that is what a coding agent following install.md
  // sees, and the whole defect was that stdout carried a ✅ while the ✗ went to stderr.
  ok("stdout does not claim success", !stdout.includes("✅"), stdout.slice(0, 200));
  ok("stdout names the host that was not registered", /NOT registered/.test(stdout) && /Claude Desktop/.test(stdout), stdout.slice(0, 300));
  ok("…and does not invite the user to go look for it", !/New here\?/.test(stdout));

  // install.md is executed by an agent, so the doc has to give the same answer as the code.
  const md = readFileSync(join(ROOT, "install.md"), "utf8");
  ok("install.md says the run exits non-zero", /exits non-zero/.test(md),
    "install.md still promises behaviour the installer does not have");

  // A healthy config must be unaffected by all of the above.
  writeFileSync(cfg, JSON.stringify({ mcpServers: {} }));
  let code2 = 0, out2 = "";
  try {
    out2 = execFileSync(process.execPath, [join(ROOT, "install.mjs"), "--host", "claude", "--yes"],
      { env: { ...process.env, HOME }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) { code2 = e.status; }
  ok("a healthy run still exits 0 and still says ✅", code2 === 0 && out2.includes("✅"));
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
