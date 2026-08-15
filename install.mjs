// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// install.mjs — discovery installer for open-mcp-apps.
//
// Detects the AI hosts on this machine, lets you pick which to register into (an interactive
// checkbox TUI when a terminal is attached; auto-select otherwise), migrates any old clone-local
// db into the shared per-user store, then registers the server idempotently into each host.
//
//   node install.mjs                 interactive: pick hosts + permission pref, then install/update
//   node install.mjs --yes           non-interactive: install into ALL detected hosts (CI / pipes)
//   node install.mjs --host codex    non-interactive: only the named host(s); comma-ok: claude,codex,claude-code
//   node install.mjs --fresh         start a clean shared store (skip migrating clone-local data)
//   node install.mjs --check         read-only: print per-host fresh|current|stale (no writes, no build)
//
// Registering is idempotent: a re-run with nothing changed writes nothing. It also fixes a stale
// entry (old clone path / old node) and removes a pre-rename entry if one lingers.
// Node built-ins only, so it runs before `npm install`.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, openSync, closeSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { emitKeypressEvents } from "node:readline";
import { ReadStream } from "node:tty";

// Fail here, legibly, rather than three minutes later inside `npm install`: better-sqlite3
// declares engines >=22 but npm treats that as advisory, so an older Node gets past the install
// and then segfaults building the native binding. Keep this in sync with package.json engines.
const MIN_NODE = 22;
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!(nodeMajor >= MIN_NODE)) {
  console.error(
    `✗ Node ${MIN_NODE}+ is required — this is Node ${process.versions.node}.\n` +
      `  The SQLite binding this engine stores your apps in does not build on older versions.\n` +
      `  Install Node ${MIN_NODE} or newer, then re-run the same command.`,
  );
  process.exit(1);
}

const ROOT = dirname(fileURLToPath(import.meta.url));
// Pin node only as far as identity requires: better-sqlite3 is a native addon, so the registered
// node must be THE binary it was built for — but a Homebrew execPath is a VERSIONED cellar path
// (…/Cellar/node/26.5.0/bin/node) that vanishes on the next `brew upgrade node`, silently
// bricking every host entry (live-test 2026-07-28). When a stable launcher resolves to the same
// binary, register THAT: identical node today, and patch/minor upgrades (same ABI) keep working.
// A major upgrade still needs `npm rebuild`, and better-sqlite3's own error says so.
const NODE = (() => {
  for (const cand of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/home/linuxbrew/.linuxbrew/bin/node"]) {
    try { if (realpathSync(cand) === realpathSync(process.execPath)) return cand; } catch { /* not this machine's layout */ }
  }
  return process.execPath;
})();
const SERVER = resolve(ROOT, "src", "server.mjs");
const NAME = "open-mcp-apps";
const LEGACY = "open-mcp-app";                          // pre-rename name; remove if found

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const YES = argv.includes("--yes") || argv.includes("-y");
const FRESH = argv.includes("--fresh");
const hostArg = (argv.find((a) => a.startsWith("--host=")) || "").split("=")[1]
  || (argv.includes("--host") ? argv[argv.indexOf("--host") + 1] : null);

// 2026-07-28 → 2026-08-16. For three weeks the Claude Desktop and Claude Code registrations carried
// `OMA_DYNAMIC_TOOLS=1`, and this is where it was written: Desktop 1.24012.9 silently dropped the
// loader widget's boot-time bridge calls, so `open_app` hung at "Loading app…" forever, while the
// per-app `open_<name>` tools' direct-embed path rendered and operated correctly. The price was one
// approval prompt per app. Re-measured 2026-08-16 on Desktop 1.30096.5: a second registration
// carrying NO flag renders through `open_app`, its clicks write, and the writes survive a full
// quit — so the symptom the workaround existed for is gone on that build, and all three hosts are
// registered the same way again. (What we measured is that this build no longer shows it; nobody
// here can declare an upstream fix.) `OMA_DYNAMIC_TOOLS` remains a supported opt-in — README →
// Configuration — what ended is the installer choosing it on your behalf.
//
// Deleting the code cannot un-write the configs already on disk, which is what the next three
// constants are for. An entry still carrying the retired key reads STALE (so `--check` says so, and
// a re-run cleans it) — but ONLY at the exact value we wrote: a `0` is the user's own opt-out, and
// agreeing with the default is not a reason to touch someone's file. All three adapters apply this
// rule, including Codex: entries out there carry the key too, whoever put it there.
const STALE_ENV_KEY = "OMA_DYNAMIC_TOOLS";
const carriesStaleEnv = (e) => e?.env?.[STALE_ENV_KEY] === "1";
const stripStaleEnv = (env) => Object.fromEntries(
  Object.entries(env || {}).filter(([k, v]) => !(k === STALE_ENV_KEY && v === "1")));
// Removing a setting silently would be its own defect — somebody may have wanted it. Both adapters
// print this next to what they removed, so the change is visible and reversible by hand.
const STALE_ENV_UNDO = `set "${STALE_ENV_KEY}": "1" under env yourself to keep per-app open_<name> tools (README → Configuration)`;
const STALE_ENV_WAS = `${STALE_ENV_KEY}=1 — the 2026-07-28 chat-surface workaround, retired`;
const sameEntry = (e) => !!e && e.command === NODE && JSON.stringify(e.args) === JSON.stringify([SERVER]);
const cmd = (bin) => (platform() === "win32" && bin === "npm") ? "npm.cmd" : bin;

// The shared store lives in a FIXED per-user data dir — MUST mirror store.mjs `defaultDbDir()`.
// Every host + every clone opens this one db, so components/data never fork per install.
function dataDir() {
  const h = homedir();
  if (platform() === "darwin") return join(h, "Library", "Application Support", "open-mcp-apps");
  if (platform() === "win32") return join(process.env.APPDATA || join(h, "AppData", "Roaming"), "open-mcp-apps");
  return join(process.env.XDG_DATA_HOME || join(h, ".local", "share"), "open-mcp-apps");
}
const DB_NAME = "open-mcp-apps.db";

// ================================================================ HOST ADAPTERS
// Each adapter: { id, label, hint, detect(), state(), apply(state), restart, perm }
//   state() → { status:'fresh'|'current'|'stale', legacy, error?, ...host-specifics }
//   apply(state) → { changed:[[what,from,to]], configLoc, note }

// ---- Claude Desktop (JSON config merge) --------------------------------------
function claudeCfgPath() {
  const h = homedir();
  if (platform() === "darwin") return join(h, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform() === "win32") return join(process.env.APPDATA || join(h, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(process.env.XDG_CONFIG_HOME || join(h, ".config"), "Claude", "claude_desktop_config.json");
}
const claude = {
  id: "claude", label: "Claude Desktop", hint: "merges into claude_desktop_config.json",
  restart: "Claude Desktop",
  perm: "can't be pre-set (lives in IndexedDB) — after restart: Settings → Connectors → open-mcp-apps → Tool permissions → Always allow.",
  detect: () => existsSync(dirname(claudeCfgPath())),
  state() {
    const p = claudeCfgPath();
    let cfg = {};
    if (existsSync(p)) {
      try { cfg = JSON.parse(readFileSync(p, "utf8")); }
      catch { return { error: `${p} exists but is not valid JSON` }; }
    }
    if (cfg.mcpServers && typeof cfg.mcpServers !== "object") return { error: `${p} has a non-object "mcpServers"` };
    const prev = cfg.mcpServers?.[NAME];
    const legacy = !!cfg.mcpServers?.[LEGACY];
    return { p, cfg, prev, legacy, status: !prev ? "fresh" : sameEntry(prev) && !carriesStaleEnv(prev) ? "current" : "stale" };
  },
  apply(st) {
    const changed = [];
    st.cfg.mcpServers = st.cfg.mcpServers || {};
    if (st.legacy) { delete st.cfg.mcpServers[LEGACY]; changed.push(["removed legacy", LEGACY, "—"]); }
    if (st.status === "stale") {
      if (st.prev.command !== NODE) changed.push(["node", st.prev.command, NODE]);
      if (JSON.stringify(st.prev.args) !== JSON.stringify([SERVER])) changed.push(["server", st.prev.args?.[0], SERVER]);
      if (carriesStaleEnv(st.prev)) changed.push(["removed env", STALE_ENV_WAS, STALE_ENV_UNDO]);
    } else if (st.status === "fresh") changed.push(["added", "—", SERVER]);
    // `unchanged` has to MEAN unchanged. This used to rewrite the entry on every run regardless of
    // status, which is how a re-install silently deleted env the user had added to it — while the
    // summary said `unchanged` and listed nothing under `changed:`. Nothing to do → touch nothing.
    if (st.status === "current" && !st.legacy) return { changed, configLoc: st.p, note: null };
    if (!existsSync(dirname(st.p))) mkdirSync(dirname(st.p), { recursive: true });
    // MERGE, never replace: the entry is the user's too. Their env keys and any sibling fields they
    // added survive; ours win on the keys we own. (The other two adapters never had this bug —
    // they only touch the entry when it is `fresh` or `stale`.)
    // The one key we now REMOVE is the retired workaround, and removing it takes a deliberate step:
    // spreading `st.prev` carries the old `env` object back in wholesale, so the object has to be
    // dropped and rebuilt from the stripped copy. A fresh entry gets no `env` at all — the same
    // shape the Codex adapter writes.
    const prevEnv = st.prev?.env && typeof st.prev.env === "object" && !Array.isArray(st.prev.env) ? st.prev.env : null;
    const entry = { ...(st.prev && typeof st.prev === "object" && !Array.isArray(st.prev) ? st.prev : {}) };
    delete entry.env;
    Object.assign(entry, { command: NODE, args: [SERVER] });
    if (prevEnv) entry.env = stripStaleEnv(prevEnv);
    st.cfg.mcpServers[NAME] = entry;
    writeFileSync(st.p, JSON.stringify(st.cfg, null, 2) + "\n");
    const back = JSON.parse(readFileSync(st.p, "utf8"));
    if (!back.mcpServers?.[NAME]) { console.error("✗ wrote config but the open-mcp-apps entry is missing on re-read."); process.exit(1); }
    return { changed, configLoc: st.p, note: null };
  },
};

// ---- Claude Code (claude mcp CLI, user scope) --------------------------------
function claudeCodeAvailable() {
  try { execFileSync("claude", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
function ccGet(name) {
  try {
    const out = execFileSync("claude", ["mcp", "get", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const command = (out.match(/^\s*Command:\s*(.+)$/m) || [])[1]?.trim();
    if (!command) return null;                            // present but not stdio / unparseable → treat as absent
    const argsLine = (out.match(/^\s*Args:\s*(.+)$/m) || [])[1]?.trim();
    // `claude mcp get` doesn't reliably print env — read it from the user-scope config file,
    // which is where user-scope stdio entries actually live.
    let env;
    try { env = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")).mcpServers?.[name]?.env; } catch {}
    return { command, args: argsLine ? argsLine.split(/\s+/) : [], ...(env ? { env } : {}) };
  } catch { return null; }                                // "No MCP server named …" exits non-zero → absent
}
const claudeCode = {
  id: "claude-code", label: "Claude Code", hint: "claude mcp add (user scope, all projects)",
  restart: null,                                          // picks up MCP servers on next run — no restart needed
  perm: "approve on first tool call, or add to the allowlist in your settings.",
  detect: claudeCodeAvailable,
  state() {
    const prev = ccGet(NAME);
    const legacy = !!ccGet(LEGACY);
    return { prev, legacy, status: !prev ? "fresh" : sameEntry(prev) && !carriesStaleEnv(prev) ? "current" : "stale" };
  },
  apply(st) {
    const changed = [];
    const cc = (a) => execFileSync("claude", a, { stdio: "inherit" });
    // `claude mcp` has no verb for unsetting ONE env key, and `mcp add` on a name that already
    // exists is not an edit — so dropping the retired key means re-adding the entry, which is the
    // door a stale entry already went through. Every OTHER key the user has is handed back as its
    // own `-e`, or this cleanup would quietly cost them their proxy. (argv, not a shell — a value
    // with spaces in it survives.)
    const add = (env) => cc(["mcp", "add", NAME, "-s", "user",
      ...Object.entries(env || {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "--", NODE, SERVER]);
    if (st.legacy) { try { cc(["mcp", "remove", LEGACY, "-s", "user"]); changed.push(["removed legacy", LEGACY, "—"]); } catch {} }
    if (st.status === "stale") {
      const keep = stripStaleEnv(st.prev.env);
      try { cc(["mcp", "remove", NAME, "-s", "user"]); } catch {}
      changed.push(["updated", `${st.prev.command} ${(st.prev.args || []).join(" ")}`, `${NODE} ${SERVER}`]);
      if (carriesStaleEnv(st.prev)) changed.push(["removed env", STALE_ENV_WAS, STALE_ENV_UNDO]);
      add(keep);
    } else if (st.status === "fresh") {
      changed.push(["added", "—", SERVER]);
      add(null);
    }
    return { changed, configLoc: "~/.claude.json (user scope)", note: null };
  },
};

// ---- Codex (codex mcp CLI — covers the ChatGPT app AND the CLI, one config) ---
function codexAvailable() {
  try { execFileSync("codex", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
// `codex mcp get` prints an entry's env as `KEY=*****` — every value redacted. This probe used to
// parse only `command` and `args`, so a Codex entry carrying the retired `OMA_DYNAMIC_TOOLS=1` came
// back looking identical to a clean one and `--check` called it `already current` (measured
// 2026-08-16 on this repo's own registration, which has the key). Worse than the miss was what the
// miss licensed: "Codex never got this key" was concluded from a reading that could not have shown
// it either way. A probe that cannot see a thing reports that it could not see, never that the
// thing is absent — so env is read in two passes with two different jobs. The masked line settles
// which keys EXIST, and that much it settles conclusively. The VALUE comes from `codex mcp get
// --json`: codex's own resolution of its own config, which beats re-parsing the file by hand
// (quoting, layering and the `-c` overrides are already applied). Neither pass may fail into
// "clean".
function codexJson(name) {
  try {
    const out = execFileSync("codex", ["mcp", "get", name, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const j = JSON.parse(out);
    return j && typeof j === "object" && j.transport && typeof j.transport === "object" ? j : null;
  } catch { return null; }                                // no `--json` on this build → unknown, NOT empty
}
const REDACTED = /^\*+$/;                                 // codex's own masking — unreadable ≠ unset
function codexEnvFromJson(j) {                            // → {k:v} · {} when there is none · null = unknown
  const e = j.transport.env;
  if (e === null || e === undefined) return {};           // codex stating this entry has no env is a fact
  if (typeof e !== "object" || Array.isArray(e)) return null;
  const env = {};
  for (const [k, v] of Object.entries(e)) {
    if (typeof v !== "string" || REDACTED.test(v)) return null;   // masked here too → still unknown
    env[k] = v;
  }
  return env;
}
// Fallback for a codex too old for `--json`: read the file codex itself reads. Only the shape codex
// writes is recognised — a `[mcp_servers.<name>.env]` sub-table of `KEY = "value"` lines, wherever
// in the file it sits (it may be appended far from its parent table and still be that entry's env).
// The caller then checks the keys found here against the keys the masked line proved are there, so
// an env written some other way — an inline table, say — comes back short and counts as unknown.
function codexTomlEnv(name) {
  let lines;
  try { lines = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8").split("\n"); }
  catch { return null; }
  const heads = [`[mcp_servers.${name}.env]`, `[mcp_servers."${name}".env]`, `[mcp_servers.'${name}'.env]`];
  const at = lines.findIndex((l) => heads.includes(l.trim()));
  if (at < 0) return null;
  const env = {};
  for (const raw of lines.slice(at + 1)) {
    const line = raw.trim();
    if (line.startsWith("[")) break;                      // the next table ends ours
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/);
    if (!m) return null;                                  // a line we cannot read is a value we do not have
    env[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return env;
}
// `codex mcp add` writes command, args and env — nothing else — and a second add REPLACES the whole
// entry. So any other field the user set on it comes back missing from a re-registration. Name them
// beside the change instead of dropping them in silence; a disabled entry silently re-enabled is
// the loudest of these.
function codexExtras(j) {
  const x = [];
  if (j.enabled === false) x.push("enabled = false");
  if (j.transport.cwd) x.push("cwd");
  if (Array.isArray(j.transport.env_vars) && j.transport.env_vars.length) x.push("env_vars");
  for (const k of ["startup_timeout_sec", "tool_timeout_sec", "enabled_tools", "disabled_tools"])
    if (j[k] !== null && j[k] !== undefined) x.push(k);
  return x;
}
function codexGet(name) {
  try {
    const out = execFileSync("codex", ["mcp", "get", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const command = (out.match(/^\s*command:\s*(.+)$/m) || [])[1]?.trim();
    if (!command) return null;
    const argsLine = (out.match(/^\s*args:\s*(.+)$/m) || [])[1]?.trim();
    const envLine = (out.match(/^\s*env:\s*(.+)$/m) || [])[1]?.trim();
    const e = {
      command,
      args: argsLine && argsLine !== "-" ? argsLine.split(/\s+/) : [],
      // Key names only: `KEY=*****, KEY2=*****`. Existence is the whole of what this line can say.
      envKeys: !envLine || envLine === "-" ? [] : envLine.split(",").map((s) => s.split("=")[0].trim()).filter(Boolean),
      extras: [],
    };
    const j = codexJson(name);
    if (j) {
      if (Array.isArray(j.transport.args)) e.args = j.transport.args;   // exact — and survives a space in a path
      e.extras = codexExtras(j);
      const env = codexEnvFromJson(j);
      if (env) e.env = env;
    } else {
      const env = codexTomlEnv(name);
      if (env && e.envKeys.every((k) => k in env)) e.env = env;
      else if (!e.envKeys.length) e.env = {};             // the masked line already said: no env at all
    }
    return e;                                             // NO `env` property ⇒ the values are unknown
  } catch { return null; }                                // "No MCP server named …" exits non-zero → absent
}
function codexFeaturesOk() {
  const p = join(homedir(), ".codex", "config.toml");
  if (!existsSync(p)) return false;
  const t = readFileSync(p, "utf8");
  return /^\s*enable_mcp_apps\s*=\s*true/m.test(t) && /^\s*apps\s*=\s*true/m.test(t);
}
const codex = {
  id: "codex", label: "Codex", hint: "codex mcp add (the app + the CLI share one config)",
  restart: "the Codex / ChatGPT app",
  perm: "approve on first use; a config-level auto-allow may be possible later.",
  detect: () => existsSync(join(homedir(), ".codex")) && codexAvailable(),
  state() {
    const prev = codexGet(NAME);
    const legacy = !!codexGet(LEGACY);
    // Three answers, not two. The key is not there → clean, and the masked line settles that by
    // itself. Its value is readable → judge it, and a `0` is the user's opt-out that stays. Its
    // value is NOT readable → `stale`, never `current`: a re-run the user did not need costs a
    // minute, while `already current` over an entry that is still dirty costs a prompt per app for
    // as long as they keep the install.
    const envUnreadable = !!prev && !prev.env;            // keys we can see, values we cannot
    const staleEnv = prev?.env ? carriesStaleEnv(prev)
      : envUnreadable && prev.envKeys.includes(STALE_ENV_KEY);
    return {
      prev, legacy, envUnreadable,
      status: !prev ? "fresh" : sameEntry(prev) && !staleEnv ? "current" : "stale",
      featuresOk: codexFeaturesOk(),
    };
  },
  apply(st) {
    const changed = [];
    const notes = [];
    let result = null;                                    // set only when the summary word must differ
    const cx = (a) => execFileSync("codex", a, { stdio: "inherit" });
    // A second `codex mcp add` replaces the entry whole — env included (measured 2026-08-16). So
    // every key that is not ours is handed back as its own `--env`, or this cleanup would be the
    // W-2 defect again with a different host's name on it. (argv, not a shell: a value with spaces
    // in it survives. Codex spells the flag `--env`; Claude Code spells the same thing `-e`.)
    const add = (env) => cx(["mcp", "add", NAME,
      ...Object.entries(env || {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]), "--", NODE, SERVER]);
    if (st.legacy) { try { cx(["mcp", "remove", LEGACY]); changed.push(["removed legacy", LEGACY, "—"]); } catch {} }
    if (st.status === "stale" && st.envUnreadable) {
      // Correcting this entry means re-adding it, and re-adding it means handing every env key back
      // BY VALUE — and the values are the one thing that could not be read. Rewriting anyway would
      // destroy settings to remove one of them. So: change nothing, say exactly that, and hand over
      // the two commands that do it by hand. Reporting `updated` here is the lie this installer is
      // built not to tell — hence the result override.
      result = "needs a hand";
      notes.push(`this entry's env values could not be read (keys: ${st.prev.envKeys.join(", ")}), and re-registering`
        + ` would drop them — so NOTHING was changed here. To do it yourself:\n`
        + `             codex mcp get ${NAME} --json          → shows the real values\n`
        + `             codex mcp add ${NAME} --env KEY=VALUE … -- ${NODE} ${SERVER}\n`
        + `           …keeping every key except ${STALE_ENV_KEY} if that one reads "1".`);
    } else if (st.status === "stale") {
      try { cx(["mcp", "remove", NAME]); } catch {}
      changed.push(["updated", `${st.prev.command} ${(st.prev.args || []).join(" ")}`, `${NODE} ${SERVER}`]);
      if (carriesStaleEnv(st.prev)) changed.push(["removed env", STALE_ENV_WAS, STALE_ENV_UNDO]);
      add(stripStaleEnv(st.prev.env));
      if (st.prev.extras.length)
        notes.push(`codex mcp add writes command/args/env only — re-check ${st.prev.extras.join(", ")} on this entry.`);
    } else if (st.status === "fresh") {
      changed.push(["added", "—", SERVER]);
      add(null);
    }
    // MCP-apps rendering flags — ensure once (append a minimal [features] block when absent).
    const p = join(homedir(), ".codex", "config.toml");
    if (!codexFeaturesOk()) {
      const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
      if (!/^\s*\[features\]/m.test(cur)) {
        writeFileSync(p, cur + (cur.endsWith("\n") || cur === "" ? "" : "\n") + "\n[features]\napps = true\nenable_mcp_apps = true\n");
        changed.push(["enabled", "MCP-apps rendering", "apps + enable_mcp_apps"]);
      } else {
        notes.push('A [features] block exists but lacks the apps flags. Run:  codex --enable apps --enable enable_mcp_apps');
      }
    }
    return { changed, configLoc: p, note: notes.join("\n     note: ") || null, result };
  },
};

const ADAPTERS = [claude, claudeCode, codex];
const safeDetect = (a) => { try { return a.detect(); } catch { return false; } };
const resultOf = (a, st) =>
  st.status === "fresh" ? "installed"
  : st.status === "stale" ? "updated"
  : st.legacy ? "updated"
  : (a.id === "codex" && !st.featuresOk) ? "updated"
  : "unchanged";

// ================================================================ migration (pre-build, file-copy, zero-dep)
function migrate() {
  const dest = join(dataDir(), DB_NAME);
  if (existsSync(dest)) return null;                      // shared store already exists → never overwrite
  const src = resolve(ROOT, DB_NAME);                     // old default location: a clone-local db
  if (!existsSync(src)) return null;
  mkdirSync(dataDir(), { recursive: true });
  for (const suf of ["", "-wal", "-shm"]) if (existsSync(src + suf)) copyFileSync(src + suf, dest + suf);
  return { from: src, to: dest };
}

// ================================================================ build (skipped in --check)
function build() {
  const run = (c, a) => { console.log(`\n$ ${c} ${a.join(" ")}`); execFileSync(c, a, { cwd: ROOT, stdio: "inherit" }); };
  run(cmd("npm"), ["install"]);
  run(NODE, ["build.mjs"]);
  run(NODE, ["seed.mjs"]);
}

// Count open-mcp-apps server processes running RIGHT NOW. After an update a GUI host keeps its OLD
// child process (bound to the OLD code + OLD db) until it is FULLY quit — closing the window is not
// enough — which is exactly what makes two hosts look out of sync. We surface the count so the user
// knows a full Cmd-Q is required, not optional. (macOS/Linux; skipped on Windows.)
function runningServers() {
  if (platform() === "win32") return null;
  try {
    const out = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
    return out.split("\n").filter((l) => /server\.mjs/.test(l) && /open-mcp-apps/.test(l)).length;
  } catch { return null; }
}

// ================================================================ interactive checkbox TUI (zero-dep)
function inputTTY() {
  // A terminal invocation has a TTY on stdin. Under `curl … | sh` stdin is the pipe, so read the
  // controlling terminal directly via /dev/tty; output still goes to stdout (the real terminal).
  if (process.stdin.isTTY) {
    return { stream: process.stdin, cleanup: () => { try { process.stdin.setRawMode(false); } catch {} process.stdin.pause(); } };
  }
  try {
    const fd = openSync("/dev/tty", "r");
    const stream = new ReadStream(fd);
    if (!stream.isTTY) { try { stream.destroy(); } catch {} try { closeSync(fd); } catch {} return null; }
    return { stream, cleanup: () => { try { stream.setRawMode(false); } catch {} try { stream.destroy(); } catch {} try { closeSync(fd); } catch {} } };
  } catch { return null; }                                // no controlling terminal → caller falls back
}
async function pickSelection(detected, cloneDbFound) {
  const io = inputTTY();
  if (!io) return null;
  const { stream, cleanup } = io;
  const out = process.stdout;
  const hosts = detected.map((a) => ({ a, checked: true }));       // default: all detected checked
  const perms = [
    { v: "ask", label: "Ask me each time (safest, most transparent)" },
    { v: "auto", label: "Auto-allow this server's tools where the host allows it" },
  ];
  let step = 0, cursor = 0, permSel = 0, hint = "";
  const STEPS = 3;                                        // 0=hosts · 1=permissions · 2=confirm

  emitKeypressEvents(stream);
  try { stream.setRawMode(true); } catch {}
  stream.resume?.();

  let prev = 0;
  const draw = () => {
    const L = ["", `  \x1b[1mopen-mcp-apps · installer\x1b[0m   \x1b[2m(${step + 1}/${STEPS})\x1b[0m`, ""];
    if (step === 0) {
      L.push("  \x1b[1mWhich hosts should it register into?\x1b[0m");
      hosts.forEach((h, i) => {
        const cur = cursor === i ? "\x1b[36m❯\x1b[0m" : " ";
        const box = h.checked ? "\x1b[32m◉\x1b[0m" : "◯";
        L.push(`  ${cur} ${box} ${h.a.label.padEnd(15)} \x1b[2m${h.a.hint}\x1b[0m`);
      });
      L.push("", "  \x1b[2m↑↓ move · space toggle · enter next · ctrl-c cancel\x1b[0m");
    } else if (step === 1) {
      L.push("  \x1b[1mTool permissions\x1b[0m");
      perms.forEach((p, i) => {
        const cur = cursor === i ? "\x1b[36m❯\x1b[0m" : " ";
        const dot = permSel === i ? "\x1b[32m◉\x1b[0m" : "◯";
        L.push(`  ${cur} ${dot} ${p.label}`);
      });
      L.push("", "  \x1b[2m↑↓ move · space select · enter next · ← back\x1b[0m");
    } else {
      const picked = hosts.filter((h) => h.checked);
      L.push("  \x1b[1mReady to install\x1b[0m", "");
      L.push(`    hosts:  ${picked.map((h) => h.a.label).join(", ") || "\x1b[31m(none)\x1b[0m"}`);
      L.push(`    perms:  ${perms[permSel].label}`);
      L.push(`    data:   ${cloneDbFound ? (FRESH ? "fresh start (--fresh)" : "migrate your existing store") : "fresh store"}`);
      L.push(`    store:  ${join(dataDir(), DB_NAME)}`);
      L.push("", "  \x1b[36menter\x1b[0m install   \x1b[2m· ← back · ctrl-c cancel\x1b[0m");
    }
    if (hint) L.push("", `  \x1b[33m${hint}\x1b[0m`);
    if (prev) out.write(`\x1b[${prev}A\x1b[0J`);
    out.write(L.join("\n") + "\n");
    prev = L.length;
  };

  return await new Promise((resolve) => {
    const finish = (result) => {
      try { stream.removeListener("keypress", onKey); } catch {}
      cleanup(); out.write("\n"); resolve(result);
    };
    const onKey = (_str, key = {}) => {
      if (key.ctrl && key.name === "c") { cleanup(); out.write("\n✗ cancelled — nothing was changed.\n"); process.exit(130); }
      hint = "";
      const opts = step === 0 ? hosts.length : step === 1 ? perms.length : 0;   // navigable rows this step
      if (opts && (key.name === "up" || key.name === "k")) { cursor = (cursor - 1 + opts) % opts; return draw(); }
      if (opts && (key.name === "down" || key.name === "j")) { cursor = (cursor + 1) % opts; return draw(); }
      if (key.name === "space") {
        if (step === 0) hosts[cursor].checked = !hosts[cursor].checked;
        else if (step === 1) permSel = cursor;
        return draw();
      }
      if (key.name === "left" || key.name === "backspace") { if (step > 0) { step--; cursor = 0; } return draw(); }
      if (key.name === "return" || key.name === "enter") {
        // enter ADVANCES; only the final confirm step installs — so a habitual enter never
        // installs straight from the host list, it just steps forward to the summary.
        if (step === 0 && !hosts.some((h) => h.checked)) { hint = "pick at least one host — space to toggle"; return draw(); }
        if (step < STEPS - 1) { step++; cursor = 0; return draw(); }
        return finish({ hosts: hosts.filter((h) => h.checked).map((h) => h.a), perm: perms[permSel].v });
      }
    };
    stream.on("keypress", onKey);
    draw();
  });
}

// ================================================================ main
// Validate --host early so a typo fails fast in every mode (including --check).
if (hostArg) {
  const unknown = hostArg.split(",").map((s) => s.trim()).filter((h) => !ADAPTERS.some((a) => a.id === h));
  if (unknown.length) { console.error(`✗ unknown --host: ${unknown.join(", ")} (use claude | claude-code | codex)`); process.exit(1); }
}

// --check: read-only per-host status, no writes, no build.
if (CHECK) {
  console.log("open-mcp-apps — status (read-only):");
  for (const a of ADAPTERS) {
    if (!safeDetect(a)) { console.log(`  ${a.label.padEnd(15)} not found`); continue; }
    const st = a.state();
    const label = st.error ? `error: ${st.error}`
      : st.status === "current" ? (resultOf(a, st) === "unchanged" ? "already current" : "needs a fix-up")
      // `stale` is the same word the other hosts get, because it asks for the same thing — a re-run.
      // But an unreadable env is a different reason for it, and a status that hides WHY would repeat
      // the mistake this whole probe exists to fix.
      : st.status === "stale" && st.envUnreadable ? "stale (its env could not be read — assuming the worst)"
      : st.status;
    console.log(`  ${a.label.padEnd(15)} ${label}`);
  }
  process.exit(0);
}

const detected = ADAPTERS.filter(safeDetect);
if (!detected.length) {
  console.error("✗ No supported host found (Claude Desktop, Claude Code, or Codex). Install one, then re-run.");
  process.exit(1);
}

// Decide which hosts to install into: --host filter, --yes (all), else the interactive TUI.
let selected, perm = "ask";
if (hostArg) {
  const ids = hostArg.split(",").map((s) => s.trim());
  selected = detected.filter((a) => ids.includes(a.id));
  if (!selected.length) { console.error(`✗ --host ${hostArg} matched no detected host (found: ${detected.map((a) => a.id).join(", ")}).`); process.exit(1); }
} else if (YES) {
  selected = detected;
} else {
  const cloneDbFound = existsSync(resolve(ROOT, DB_NAME)) && !existsSync(join(dataDir(), DB_NAME));
  let pick = null;
  try { pick = await pickSelection(detected, cloneDbFound); } catch { pick = null; }
  if (pick) { selected = pick.hosts; perm = pick.perm; }
  else {
    console.log(`(no interactive terminal — installing into all detected: ${detected.map((a) => a.label).join(", ")}. Use --host to narrow.)`);
    selected = detected;
  }
}

// Migrate any clone-local db into the shared store BEFORE build/seed (so seed lands in the right db).
const mig = FRESH ? null : migrate();
if (mig) console.log(`↪ migrated existing store into the shared location:\n    ${mig.from}\n  → ${mig.to}`);

build();

const applied = [];
const failed = [];
for (const a of selected) {
  const st = a.state();
  if (st.error) {
    failed.push({ a, error: st.error });
    console.error(`\n✗ ${a.label}: ${st.error}\n  Fix or remove it, then re-run. (Not touching it — your other servers matter.)`);
    continue;
  }
  const res = resultOf(a, st);
  const out = a.apply(st);
  // An adapter that deliberately did NOT carry out what its state implied overrides the word. The
  // summary line is the only thing most people read; `updated` over a run that changed nothing is
  // the same defect as `unchanged` over a run that changed something.
  applied.push({ a, res: out.result || res, out });
}

// ---- summary ----
// A host we could not register into is a FAILED install, not a footnote. install.md tells a coding
// agent to relay this summary, and the ✗ detail above goes to STDERR — so an agent that captures
// only stdout used to see a lone ✅ while nothing had been registered, and told the user to restart
// their host and look for a connector that was never there. Three things fix that, and they have to
// travel together: the verdict line names the failures, it repeats them on STDOUT, and the process
// exits non-zero (install.md §Stage 2 promises exactly that).
if (failed.length) {
  console.log(`\n✗ open-mcp-apps — ${applied.length} host(s) registered, ${failed.length} FAILED. store: ${join(dataDir(), DB_NAME)}`);
  for (const { a, error } of failed) console.log(`\n  ${a.label}: NOT registered — ${error}`);
} else {
  console.log(`\n✅ open-mcp-apps — done. store: ${join(dataDir(), DB_NAME)}`);
}
for (const { a, res, out } of applied) {
  console.log(`\n  ${a.label}: ${res}`);
  for (const [k, from, to] of out.changed) console.log(`     ${k}: ${from}  →  ${to}`);
  console.log(`     config: ${out.configLoc}`);
  if (out.note) console.log(`     note: ${out.note}`);
}
const restarts = [...new Set(applied.map(({ a }) => a.restart).filter(Boolean))];
if (restarts.length) {
  console.log(`\n→ FULLY QUIT ${restarts.join(" and ")} — Cmd-Q, or right-click the Dock icon → Quit; NOT just closing the window — then reopen.`);
  console.log(`  Closing the window leaves the OLD server process running on the OLD store, so hosts look out of sync until each is fully restarted.`);
  const n = runningServers();
  if (n) console.log(`  (${n} open-mcp-apps server process${n === 1 ? " is" : "es are"} live right now — a full quit clears ${n === 1 ? "it" : "them"}.)`);
}
console.log(`\nPermissions (${perm === "auto" ? "auto-allow where possible" : "ask each time"}):`);
for (const { a } of applied) console.log(`  · ${a.label}: ${a.perm}`);
if (applied.length)
  console.log(`\nNew here? In your host, ask the AI: "I just installed open-mcp-apps — show me how to use it with a couple of examples, and suggest a few apps that fit how I work."`);

// Non-zero when any host was left unregistered. exitCode (not exit()) so nothing above is cut off.
if (failed.length) process.exitCode = 1;
