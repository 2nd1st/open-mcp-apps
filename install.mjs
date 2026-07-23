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
// entry (old clone path / old node) and removes the pre-rename `open-mcp-app` entry if it lingers.
// Node built-ins only, so it runs before `npm install`.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, openSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { emitKeypressEvents } from "node:readline";
import { ReadStream } from "node:tty";

const ROOT = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;                          // pin the exact node (native SQLite ABI)
const SERVER = resolve(ROOT, "src", "server.mjs");
const NAME = "open-mcp-apps";
const LEGACY = "open-mcp-app";                          // pre-rename name; remove if found

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const YES = argv.includes("--yes") || argv.includes("-y");
const FRESH = argv.includes("--fresh");
const hostArg = (argv.find((a) => a.startsWith("--host=")) || "").split("=")[1]
  || (argv.includes("--host") ? argv[argv.indexOf("--host") + 1] : null);

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
const DB_NAME = "open-mcp-app.db";

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
    return { p, cfg, prev, legacy, status: !prev ? "fresh" : sameEntry(prev) ? "current" : "stale" };
  },
  apply(st) {
    const changed = [];
    st.cfg.mcpServers = st.cfg.mcpServers || {};
    if (st.legacy) { delete st.cfg.mcpServers[LEGACY]; changed.push(["removed legacy", LEGACY, "—"]); }
    if (st.status === "stale") {
      if (st.prev.command !== NODE) changed.push(["node", st.prev.command, NODE]);
      if (JSON.stringify(st.prev.args) !== JSON.stringify([SERVER])) changed.push(["server", st.prev.args?.[0], SERVER]);
    } else if (st.status === "fresh") changed.push(["added", "—", SERVER]);
    if (!existsSync(dirname(st.p))) mkdirSync(dirname(st.p), { recursive: true });
    st.cfg.mcpServers[NAME] = { command: NODE, args: [SERVER] };
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
    return { command, args: argsLine ? argsLine.split(/\s+/) : [] };
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
    return { prev, legacy, status: !prev ? "fresh" : sameEntry(prev) ? "current" : "stale" };
  },
  apply(st) {
    const changed = [];
    const cc = (a) => execFileSync("claude", a, { stdio: "inherit" });
    if (st.legacy) { try { cc(["mcp", "remove", LEGACY, "-s", "user"]); changed.push(["removed legacy", LEGACY, "—"]); } catch {} }
    if (st.status === "stale") {
      try { cc(["mcp", "remove", NAME, "-s", "user"]); } catch {}
      changed.push(["updated", `${st.prev.command} ${(st.prev.args || []).join(" ")}`, `${NODE} ${SERVER}`]);
      cc(["mcp", "add", NAME, "-s", "user", "--", NODE, SERVER]);
    } else if (st.status === "fresh") {
      changed.push(["added", "—", SERVER]);
      cc(["mcp", "add", NAME, "-s", "user", "--", NODE, SERVER]);
    }
    return { changed, configLoc: "~/.claude.json (user scope)", note: null };
  },
};

// ---- Codex (codex mcp CLI — covers the ChatGPT app AND the CLI, one config) ---
function codexAvailable() {
  try { execFileSync("codex", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
function codexGet(name) {
  try {
    const out = execFileSync("codex", ["mcp", "get", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const command = (out.match(/^\s*command:\s*(.+)$/m) || [])[1]?.trim();
    if (!command) return null;
    const argsLine = (out.match(/^\s*args:\s*(.+)$/m) || [])[1]?.trim();
    return { command, args: argsLine && argsLine !== "-" ? argsLine.split(/\s+/) : [] };
  } catch { return null; }
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
    return { prev, legacy, status: !prev ? "fresh" : sameEntry(prev) ? "current" : "stale", featuresOk: codexFeaturesOk() };
  },
  apply(st) {
    const changed = [];
    const cx = (a) => execFileSync("codex", a, { stdio: "inherit" });
    if (st.legacy) { try { cx(["mcp", "remove", LEGACY]); changed.push(["removed legacy", LEGACY, "—"]); } catch {} }
    if (st.status === "stale") {
      try { cx(["mcp", "remove", NAME]); } catch {}
      changed.push(["updated", `${st.prev.command} ${(st.prev.args || []).join(" ")}`, `${NODE} ${SERVER}`]);
      cx(["mcp", "add", NAME, "--", NODE, SERVER]);
    } else if (st.status === "fresh") {
      changed.push(["added", "—", SERVER]);
      cx(["mcp", "add", NAME, "--", NODE, SERVER]);
    }
    // MCP-apps rendering flags — ensure once (append a minimal [features] block when absent).
    let note = null;
    const p = join(homedir(), ".codex", "config.toml");
    if (!codexFeaturesOk()) {
      const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
      if (!/^\s*\[features\]/m.test(cur)) {
        writeFileSync(p, cur + (cur.endsWith("\n") || cur === "" ? "" : "\n") + "\n[features]\napps = true\nenable_mcp_apps = true\n");
        changed.push(["enabled", "MCP-apps rendering", "apps + enable_mcp_apps"]);
      } else {
        note = 'A [features] block exists but lacks the apps flags. Run:  codex --enable apps --enable enable_mcp_apps';
      }
    }
    return { changed, configLoc: p, note };
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
  const src = resolve(ROOT, DB_NAME);                     // old default location: <clone>/open-mcp-app.db
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
for (const a of selected) {
  const st = a.state();
  if (st.error) { console.error(`\n✗ ${a.label}: ${st.error}\n  Fix or remove it, then re-run. (Not touching it — your other servers matter.)`); continue; }
  const res = resultOf(a, st);
  const out = a.apply(st);
  applied.push({ a, res, out });
}

// ---- summary ----
console.log(`\n✅ open-mcp-apps — done. store: ${join(dataDir(), DB_NAME)}`);
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
console.log(`\nNew here? In your host, ask the AI: "I just installed open-mcp-apps — show me how to use it with a couple of examples, and suggest a few apps that fit how I work."`);
