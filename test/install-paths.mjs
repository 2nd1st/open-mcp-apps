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
import { existsSync, unlinkSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync } from "node:fs";
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
// them too, or a test run would write into the person running it. CODEX_HOME is the same hole one
// process further out: the installer resolves `~/.codex` from homedir(), but the `codex` CLI it
// shells out to prefers CODEX_HOME when that is set — and it is set, in the environment Codex's own
// app hands its children. Unnamed, the Codex drill below would register into the real config.
const sandboxEnv = (home, extra) => ({
  ...process.env, HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  APPDATA: join(home, "AppData", "Roaming"),
  CODEX_HOME: join(home, ".codex"),
  ...extra,
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
  j.mcpServers["open-mcp-apps"].env = { HTTPS_PROXY: "http://corp-proxy:8080" };
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
  // The canonical entry sets NO env of our own — all three hosts are registered the same way since
  // the chat-surface workaround came off (2026-08-16). §5 covers what happens to configs that were
  // written while it was still on.
  ok("…and we add no env of our own to it", read()["open-mcp-apps"].env.OMA_DYNAMIC_TOOLS === undefined,
    JSON.stringify(read()["open-mcp-apps"].env));
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

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n5. the retired workaround key is cleaned out of entries that already have it — and ONLY it");
// From 2026-07-28 to 2026-08-16 this installer wrote `OMA_DYNAMIC_TOOLS=1` into the Claude Desktop
// and Claude Code entries, to route around a chat-surface bridge regression at the cost of one
// approval prompt per app. Deleting that code does nothing for the configs already on disk: they
// keep the key, keep the prompts, and keep them forever. So the retirement is only real if a re-run
// takes the key back out — and that is a re-run EDITING SOMEBODY'S SETTINGS, which is why the three
// things below have to hold together. It removes our key. It removes nothing else. And it says so
// out loud, with the way back, because a setting that changes silently is indistinguishable from a
// bug — somebody may have wanted this one on.
{
  const HOME = join(TMP, "home5");
  const cfg = claudeCfgFor(HOME);
  mkdirSync(dirname(cfg), { recursive: true });
  writeFileSync(cfg, JSON.stringify({ mcpServers: {} }));
  const install = () => execFileSync(process.execPath, [join(ROOT, "install.mjs"), "--host", "claude", "--yes"],
    { env: sandboxEnv(HOME), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // `--check` takes no --host: it walks every adapter, so on a machine that has the real `claude`
  // or `codex` CLI those lines are whatever that machine says. Only the Claude Desktop line is
  // this test's business, and it is read out by name rather than matched against the whole block.
  const checkLine = () => (execFileSync(process.execPath, [join(ROOT, "install.mjs"), "--check"],
    { env: sandboxEnv(HOME), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\n").find((l) => /Claude Desktop/.test(l)) || "");
  const read = () => JSON.parse(readFileSync(cfg, "utf8")).mcpServers["open-mcp-apps"];

  // Build the pre-2026-08-16 shape the way it was really produced — let the installer write a
  // canonical entry, then put the old key back by hand beside one of the user's own. Hand-writing
  // `command` instead would mean restating how install.mjs resolves node (a Homebrew launcher here,
  // `process.execPath` in a CI container), and a second copy of that rule is a rule that drifts.
  install();
  ok("a fresh registration carries no OMA_DYNAMIC_TOOLS at all", read().env?.OMA_DYNAMIC_TOOLS === undefined,
    JSON.stringify(read()));
  const j = JSON.parse(readFileSync(cfg, "utf8"));
  j.mcpServers["open-mcp-apps"].env = { OMA_DYNAMIC_TOOLS: "1", HTTPS_PROXY: "http://corp-proxy:8080" };
  writeFileSync(cfg, JSON.stringify(j, null, 2));

  ok("an entry still carrying the retired key reads `stale`, not `already current`", /stale/.test(checkLine()),
    `--check said: ${checkLine().trim()} — a user with no signal to re-run keeps paying a prompt per app`);

  const out = install();
  ok("a re-run takes the retired key out", read().env?.OMA_DYNAMIC_TOOLS === undefined, JSON.stringify(read().env));
  ok("…and takes nothing else with it", read().env?.HTTPS_PROXY === "http://corp-proxy:8080", JSON.stringify(read().env));
  ok("…and the entry is otherwise intact", read().args?.[0].endsWith("src/server.mjs"), JSON.stringify(read()));
  ok("…and the run SAYS which key it removed", /removed env: OMA_DYNAMIC_TOOLS=1/.test(out),
    "a run that edits your settings and reports nothing is the defect this whole file is about");
  ok("…and points at how to put it back", /README/.test(out) && /Configuration/.test(out), out.slice(-400));
  // Matched against the host's own summary line, not the whole run: `seed.mjs` prints `= <app>
  // unchanged` for every app it did not need to reseed, so a bare search for that word answers a
  // different question than the one being asked.
  ok("…and reports THAT HOST as `updated`, not `unchanged`",
    /Claude Desktop: updated/.test(out) && !/Claude Desktop: unchanged/.test(out), out.slice(-500));

  ok("once cleaned, the entry is current again", /already current/.test(checkLine()), checkLine().trim());
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The Codex half of §5, which §5 could not reach. `codex mcp get` prints an entry's env as
// `KEY=*****` — keys real, every value masked — and for three weeks the installer parsed only
// `command` and `args` out of it. So a Codex entry carrying the retired key came back looking
// exactly like a clean one, `--check` said `already current`, and the conclusion drawn from that
// reading was that Codex had never been given the key at all. It had (this repo's own machine,
// measured 2026-08-16). The defect is not the miss, it is the shape of the miss: a probe that
// cannot see a thing must report that it could not see, never that the thing is absent. Which is
// why the two sections below split along what can be OBSERVED, not along what is convenient —
// §6 drives the readings a real codex on this machine cannot produce, §7 checks that the real one
// still answers the way §6 assumes.
console.log("\n6. a probe that cannot read a value says so — it does not call the entry clean");
// A stand-in `codex`, backed by a JSON file this test writes. It exists for the two readings the
// real binary cannot give us: a build too old for `codex mcp get --json` (0.147.0 has it), and an
// env laid out in a shape the config.toml fallback cannot parse. Both land on "unknown", and
// unknown is precisely the side that used to be reported as clean. It also puts this section on
// CI, where there is no codex binary at all — the coverage is worth most exactly where the real
// one is missing.
const writeShim = (dir) => {
  mkdirSync(dir, { recursive: true });
  const mjs = join(dir, "codex-shim.mjs");
  writeFileSync(mjs, String.raw`
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const STATE = join(process.env.HOME, ".codex", "shim-state.json");
const s = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { json: true, servers: {} };
const save = () => writeFileSync(STATE, JSON.stringify(s, null, 2));
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("codex-cli 0.0.0-shim"); process.exit(0); }
if (a[0] !== "mcp") process.exit(1);
const name = a[2];
const e = s.servers[name];
if (a[1] === "get") {
  if (!e) { console.error("Error: No MCP server named '" + name + "' found."); process.exit(1); }
  const keys = Object.keys(e.env || {});
  if (a.includes("--json")) {
    if (!s.json) { console.error("error: unexpected argument '--json' found"); process.exit(2); }
    console.log(JSON.stringify({ name, enabled: true, disabled_reason: null,
      transport: { type: "stdio", command: e.command, args: e.args, env: keys.length ? e.env : null, env_vars: [], cwd: null },
      enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null }));
    process.exit(0);
  }
  console.log([name, "  enabled: true", "  transport: stdio",
    "  command: " + e.command, "  args: " + (e.args.join(" ") || "-"), "  cwd: -",
    "  env: " + (keys.length ? keys.map((k) => k + "=*****").join(", ") : "-"),
    "  remove: codex mcp remove " + name].join("\n"));
  process.exit(0);
}
if (a[1] === "remove") { delete s.servers[name]; save(); process.exit(0); }
if (a[1] === "add") {
  const rest = a.slice(3), dash = rest.indexOf("--"), env = {};
  for (let i = 0; i < (dash < 0 ? rest.length : dash); i++)
    if (rest[i] === "--env") { const kv = rest[++i]; env[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1); }
  const cmd = dash < 0 ? [] : rest.slice(dash + 1);
  s.servers[name] = { command: cmd[0], args: cmd.slice(1), env };
  save();
  console.log("Added global MCP server '" + name + "'.");
  process.exit(0);
}
process.exit(1);
`);
  const bin = join(dir, "codex");
  writeFileSync(bin, "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(mjs) + ' "$@"\n');
  chmodSync(bin, 0o755);
};

if (process.platform === "win32") {
  console.log("  ⚠ SKIPPED — the stand-in is a /bin/sh wrapper; this section has not run on Windows.");
} else {
  const HOME = join(TMP, "home6");
  const BIN = join(TMP, "bin6");
  const cdir = join(HOME, ".codex");                     // the Codex adapter detects on this directory
  mkdirSync(cdir, { recursive: true });
  writeShim(BIN);
  const env = sandboxEnv(HOME, { PATH: BIN + ":" + process.env.PATH });
  const toml = join(cdir, "config.toml");
  const statePath = join(cdir, "shim-state.json");
  const FEATURES = "[features]\napps = true\nenable_mcp_apps = true\n";
  const PROXY = "http://corp-proxy:8080";
  writeFileSync(toml, FEATURES);
  writeFileSync(statePath, JSON.stringify({ json: true, servers: {} }));

  const install = () => execFileSync(process.execPath, [join(ROOT, "install.mjs"), "--host", "codex", "--yes"],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const checkLine = () => (execFileSync(process.execPath, [join(ROOT, "install.mjs"), "--check"],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\n").find((l) => /^\s*Codex\s/.test(l)) || "");
  const entry = () => JSON.parse(readFileSync(statePath, "utf8")).servers["open-mcp-apps"];

  // The registration is written by the INSTALLER — the stand-in just records the `mcp add` it was
  // handed. Writing the entry by hand here would mean restating how install.mjs resolves node and
  // the server path, and a second copy of that rule is a copy that drifts.
  install();
  ok("a fresh Codex registration carries no OMA_DYNAMIC_TOOLS", !entry().env?.OMA_DYNAMIC_TOOLS, JSON.stringify(entry()));
  ok("…and reads current straight afterwards", /already current/.test(checkLine()), checkLine().trim());

  // shape: what the entry's env looks like to each of the two readings.
  //   json     — `codex mcp get --json` answers, values and all (a current codex)
  //   subtable — no --json; the value is in the `[mcp_servers.…env]` sub-table codex writes
  //   inline   — no --json; the value is laid out some other way, so nothing can read it
  const dirty = (shape, value = "1") => {
    const s = JSON.parse(readFileSync(statePath, "utf8"));
    s.json = shape === "json";
    s.servers["open-mcp-apps"].env = { OMA_DYNAMIC_TOOLS: value, HTTPS_PROXY: PROXY };
    writeFileSync(statePath, JSON.stringify(s, null, 2));
    writeFileSync(toml, FEATURES + (shape === "subtable"
      ? `\n[mcp_servers.open-mcp-apps.env]\nOMA_DYNAMIC_TOOLS = "${value}"\nHTTPS_PROXY = "${PROXY}"\n`
      : shape === "inline"
        ? `\n[mcp_servers.open-mcp-apps]\nenv = { OMA_DYNAMIC_TOOLS = "${value}", HTTPS_PROXY = "${PROXY}" }\n`
        : ""));
  };

  // A `0` is somebody's own opt-out. Agreeing with today's default is not a reason to edit a file.
  dirty("json", "0");
  ok("the key at a value we never wrote is left alone", /already current/.test(checkLine()), checkLine().trim());

  dirty("subtable");
  ok("no --json, but the file can be read: the retired key still reads `stale`", /stale/.test(checkLine()), checkLine().trim());
  ok("…and it is the plain kind of stale — the value WAS read", !/could not be read/.test(checkLine()), checkLine().trim());

  dirty("inline");
  ok("no --json and a layout we cannot parse reads `stale`, never `already current`",
    /stale/.test(checkLine()) && !/already current/.test(checkLine()), checkLine().trim());
  ok("…and says the value is what it could not read, rather than implying the key is gone",
    /could not be read/.test(checkLine()), checkLine().trim());

  // The other half of not-knowing: re-registering hands every env key back BY VALUE, and the values
  // are the thing that could not be read. Rewriting anyway would destroy settings in order to
  // remove one of them — so the run has to leave it alone AND not claim it fixed anything.
  const blocked = install();
  ok("a value it cannot read is a value it does not overwrite", entry().env.HTTPS_PROXY === PROXY, JSON.stringify(entry().env));
  ok("…so the retired key is still there, untouched", entry().env.OMA_DYNAMIC_TOOLS === "1", JSON.stringify(entry().env));
  ok("…and the summary does NOT say `updated` over a run that changed nothing",
    !/Codex: updated/.test(blocked) && /Codex: needs a hand/.test(blocked), blocked.slice(-700));
  ok("…and it prints the commands that finish the job by hand", /codex mcp add open-mcp-apps --env/.test(blocked), blocked.slice(-700));

  // And with a codex that can answer, the whole thing goes through.
  dirty("json");
  ok("a readable entry carrying the retired key reads `stale`", /stale/.test(checkLine()), checkLine().trim());
  const out = install();
  ok("a re-run takes the retired key out", entry().env.OMA_DYNAMIC_TOOLS === undefined, JSON.stringify(entry().env));
  ok("…and hands the user's own key straight back", entry().env.HTTPS_PROXY === PROXY, JSON.stringify(entry().env));
  ok("…and the entry still points at this clone", /server\.mjs/.test(entry().args.join(" ")), JSON.stringify(entry()));
  ok("…and the run SAYS which key it removed", /removed env: OMA_DYNAMIC_TOOLS=1/.test(out), out.slice(-700));
  ok("…and points at how to put it back", /README/.test(out) && /Configuration/.test(out), out.slice(-700));
  ok("…and reports THAT HOST as `updated`", /Codex: updated/.test(out) && !/Codex: unchanged/.test(out), out.slice(-700));
  ok("once cleaned, the entry is current again", /already current/.test(checkLine()), checkLine().trim());
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n7. …and the real `codex` still answers the way §6's stand-in assumes");
// §6 proves the installer's side against a stand-in that encodes OUR belief about the CLI: that
// `mcp add` takes `--env KEY=VALUE`, that a second add replaces the entry whole, that `mcp get
// --json` prints values unmasked. A belief is not a contract. This section is the only thing here
// that would notice codex changing its mind, so when it does not run, that has to be audible.
{
  const haveCodex = (() => { try { execFileSync("codex", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
  if (!haveCodex) {
    console.log("  ⚠ SKIPPED — no `codex` on PATH, so nothing here checked the real CLI's flags or output.");
    console.log("    §6 still ran: the installer's own logic is covered, its assumptions about codex are not.");
  } else {
    const HOME = join(TMP, "home7");
    const cdir = join(HOME, ".codex");
    mkdirSync(cdir, { recursive: true });
    const toml = join(cdir, "config.toml");
    const env = sandboxEnv(HOME);
    const install = () => execFileSync(process.execPath, [join(ROOT, "install.mjs"), "--host", "codex", "--yes"],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const checkLine = () => (execFileSync(process.execPath, [join(ROOT, "install.mjs"), "--check"],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n").find((l) => /^\s*Codex\s/.test(l)) || "");
    const read = () => readFileSync(toml, "utf8");

    install();
    ok("the real CLI accepts the registration we hand it", /server\.mjs/.test(read()), read());
    ok("…and it carries no OMA_DYNAMIC_TOOLS", !/OMA_DYNAMIC_TOOLS/.test(read()), read());

    // The 2026-07-28 shape, reproduced where it really lives: the entry's own env sub-table, the
    // retired key beside a key of the user's. (Byte-for-byte what `sed -n '773,780p' ~/.codex/
    // config.toml` shows on this repo's machine.)
    writeFileSync(toml, read() + `\n[mcp_servers.open-mcp-apps.env]\nOMA_DYNAMIC_TOOLS = "1"\nHTTPS_PROXY = "http://corp-proxy:8080"\n`);
    ok("an entry carrying the retired key reads `stale`, not `already current`",
      /stale/.test(checkLine()), `--check said: ${checkLine().trim()} — the reading that hid this for three weeks`);

    const out = install();
    ok("a re-run takes the retired key out", !/OMA_DYNAMIC_TOOLS/.test(read()), read());
    ok("…and hands the user's own key back through the real `--env`", /HTTPS_PROXY = "http:\/\/corp-proxy:8080"/.test(read()), read());
    ok("…and the entry still points at this clone", /server\.mjs/.test(read()), read());
    ok("…and the run SAYS which key it removed", /removed env: OMA_DYNAMIC_TOOLS=1/.test(out), out.slice(-700));
    ok("…and reports THAT HOST as `updated`", /Codex: updated/.test(out) && !/Codex: unchanged/.test(out), out.slice(-700));
    ok("once cleaned, the entry is current again", /already current/.test(checkLine()), checkLine().trim());
  }
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
