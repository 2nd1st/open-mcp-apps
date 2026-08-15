// SPDX-License-Identifier: MIT
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
import { openStore, SCHEMA_VERSION } from "../src/store.mjs";

// Where Claude Desktop's config lives, per platform — the same three-way rule install.mjs uses
// (`claudeCfgPath()`, install.mjs ~:91). Restated rather than imported because install.mjs is a
// CLI that runs its work on import; the duplication is self-checking, since every assertion below
// reads the file the installer actually wrote — a rule that drifted would fail these tests, not
// hide behind them. Hard-coding the macOS shape is what kept this suite from EVER passing on
// Linux CI: the installer looked under ~/.config, found no host at all, and exited 1 — which on a
// fail-fast chain also hid every suite behind it (measured 2026-08-16 on a Linux container).
const claudeCfgFor = (home) =>
  process.platform === "darwin"
    ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : process.platform === "win32"
      ? join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json")
      : join(home, ".config", "Claude", "claude_desktop_config.json");

// A fake HOME is only a complete boundary on macOS. Elsewhere the installer honours XDG_CONFIG_HOME
// and APPDATA, which point at the REAL user on a developer machine — so the sandbox has to name
// them too, or a test run would write into the person running it.
const sandboxEnv = (home) => ({
  ...process.env, HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  APPDATA: join(home, "AppData", "Roaming"),
});


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

// A v5 store: the shape one rung down — html column, no revision manifest. Built by taking a real
// current store and reversing the v6 step, then stamping user_version=5; that rung is exactly the
// reverse of this construction. (v4, the last RELEASED shape, is drilled in ledger-smoke §7b.)
const makeV5 = (p) => {
  rm(p);
  openStore(p).close();                                  // a real store at the current schema
  const d = new Database(p);
  const now = new Date().toISOString();
  d.exec("ALTER TABLE app RENAME COLUMN ui TO html");
  d.exec("ALTER TABLE app_history RENAME COLUMN ui TO html");
  d.exec("ALTER TABLE app_history DROP COLUMN manifest");
  d.prepare(`INSERT INTO app (name,version,html,description,author,kind,visibility,updated_at)
             VALUES (?,?,?,?,?,?,?,?)`).run("my-tracker", 1, "<html>three years of it</html>", "", "human", "app", "listed", now);
  const ins = d.prepare(`INSERT INTO item (id,collection,grp,position,fields,version,created_at,updated_at)
                         VALUES (?,?,?,?,?,?,?,?)`);
  for (let i = 1; i <= 3; i++) ins.run("i" + i, "my-tracker", "", i, JSON.stringify({ t: "row" + i }), 1, now, now);
  d.pragma("user_version = 5");
  d.close();
  return p;
};

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n1. W-3 — a command that only LOOKS writes nothing, INCLUDING the schema");
// The old shape opened the store for write before it looked at --dry-run, so the one-way v3→v4
// climb ran and the command then printed "nothing written". A dry run that cannot be undone is
// the worst kind of lie a --dry-run flag can tell.
{
  const db = makeV5(join(TMP, "dry-v5.db"));
  const before = { uv: uv(db), sha: sha(db) };
  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath, [join(ROOT, "install-app.mjs"), join(ROOT, "components", "habit-streaks", "ui.html"), "--dry-run"],
      { env: { ...process.env, OMA_DB: db }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { code = e.status; out = (e.stdout || "") + (e.stderr || ""); }

  ok("an old store is left at its own schema version", uv(db) === 5, `user_version is ${uv(db)}, was ${before.uv}`);
  ok("not one byte of it changed", sha(db) === before.sha);
  ok("and it SAYS it cannot do this, instead of doing it silently", code === 1 && /read-only open/.test(out), out.trim().slice(0, 160));

  // The other half of the same bug: with no store at all, a dry run used to CREATE one.
  const fresh = join(TMP, "nowhere", "store.db");
  const o2 = execFileSync(process.execPath, [join(ROOT, "install-app.mjs"), join(ROOT, "components", "habit-streaks", "ui.html"), "--dry-run"],
    { env: { ...process.env, OMA_DB: fresh }, encoding: "utf8" });
  ok("with no store at all, a dry run creates none", !existsSync(fresh));
  ok("and says so rather than implying it looked", /nothing written/.test(o2) && /no store exists yet/.test(o2), o2.trim());

  // --list is the SAME defect through a second entrance, and takes the same door. Shipping the
  // dry-run fix alone would have put a release note in front of users that says "a dry run no
  // longer migrates your store" while `--list` still did.
  const listDb = makeV5(join(TMP, "list-v5.db"));
  const listBefore = sha(listDb);
  let listOut = "", listCode = 0;
  try {
    listOut = execFileSync(process.execPath, [join(ROOT, "install-app.mjs"), "--list"],
      { env: { ...process.env, OMA_DB: listDb }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { listCode = e.status; listOut = (e.stdout || "") + (e.stderr || ""); }
  ok("--list leaves an old store at its own schema version", uv(listDb) === 5, `user_version is ${uv(listDb)}`);
  ok("--list changes not one byte of it", sha(listDb) === listBefore);
  ok("…and says so instead of migrating to answer", listCode === 1 && /read-only open/.test(listOut), listOut.trim().slice(0, 140));

  const listFresh = join(TMP, "list-nowhere", "store.db");
  const lo = execFileSync(process.execPath, [join(ROOT, "install-app.mjs"), "--list"],
    { env: { ...process.env, OMA_DB: listFresh }, encoding: "utf8" });
  ok("--list on a machine with no store creates none", !existsSync(listFresh));
  ok("…and still answers the question it was asked", /no apps installed/.test(lo), lo.trim());

  // Regression: the ordinary install must still climb the ladder (v5 → v6 here). A fix
  // that froze the door would pass every assertion above and break the product.
  execFileSync(process.execPath, [join(ROOT, "install-app.mjs"), join(ROOT, "components", "habit-streaks", "ui.html")],
    { env: { ...process.env, OMA_DB: db }, encoding: "utf8" });
  ok("a REAL install still migrates the same store", uv(db) === SCHEMA_VERSION, `user_version is ${uv(db)}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n2. anything older than v4 refuses through the INSTALLER too, naming the way forward");
// (W-1's v3→v4 atomicity/wreckage drills retired 2026-08-04 with the pre-v4 ladder itself,
// elegance A1 — the states they manufactured can no longer be produced or repaired, only refused.
// The door's own semantics — fresh/v4/v5/v6 open, older refuses untouched — are pinned in
// ledger-smoke §7b/§8. What this section keeps is the INSTALLER's behavior at that refusal.)
{
  const oldDb = join(TMP, "ancient.db");
  rm(oldDb);
  const d = new Database(oldDb);
  d.exec("CREATE TABLE item (id TEXT PRIMARY KEY, collection TEXT NOT NULL, grp TEXT NOT NULL DEFAULT '', position REAL NOT NULL DEFAULT 0, fields TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  d.pragma("user_version = 2");
  d.close();
  const before = sha(oldDb);
  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath, [join(ROOT, "install-app.mjs"), join(ROOT, "components", "habit-streaks", "ui.html")],
      { env: { ...process.env, OMA_DB: oldDb }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { code = e.status; out = (e.stdout || "") + (e.stderr || ""); }
  ok("a pre-v4 store fails the install with a non-zero exit", code !== 0, `exit ${code}`);
  ok("…naming the recovery path instead of guessing at history", /migrates v4/.test(out), out.trim().slice(0, 200));
  ok("…and not one byte of the store changed", sha(oldDb) === before);
}

console.log("\n3. W-2 — a re-install keeps what the user put in the entry, and `unchanged` means it");
{
  const HOME = join(TMP, "home2");
  const cfg = claudeCfgFor(HOME);
  mkdirSync(dirname(cfg), { recursive: true });
  writeFileSync(cfg, JSON.stringify({ mcpServers: {} }));
  const run = () => execFileSync(process.execPath, [join(ROOT, "install.mjs"), "--host", "claude", "--yes"],
    { env: sandboxEnv(HOME), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
  const cfg = claudeCfgFor(HOME);
  mkdirSync(dirname(cfg), { recursive: true });
  writeFileSync(cfg, '{ "mcpServers": { "open-mcp-apps": <<<not json>>> ');

  let code = 0, stdout = "";
  try {
    stdout = execFileSync(process.execPath, [join(ROOT, "install.mjs"), "--host", "claude", "--yes"],
      { env: sandboxEnv(HOME), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
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
      { env: sandboxEnv(HOME), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) { code2 = e.status; }
  ok("a healthy run still exits 0 and still says ✅", code2 === 0 && out2.includes("✅"));
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
