// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// uninstall.mjs — remove open-mcp-apps from the AI hosts on this machine (the reverse of install.mjs).
//
//   node uninstall.mjs              interactive: confirm, then unregister from every host that has it
//   node uninstall.mjs --yes        non-interactive: unregister from all detected hosts (no confirm)
//   node uninstall.mjs --host codex  only the named host(s); comma-ok: claude,codex,claude-code
//   node uninstall.mjs --check       read-only: print which hosts currently have it (+ store location)
//   node uninstall.mjs --purge       ALSO delete the shared store — your apps + data + files. Irreversible.
//
// By default the shared store is KEPT, so a later re-install restores every app and all data
// untouched. Only --purge deletes it. Node built-ins only, so it runs without npm install.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync, openSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { emitKeypressEvents } from "node:readline";
import { ReadStream } from "node:tty";

const ROOT = dirname(fileURLToPath(import.meta.url));
const NAME = "open-mcp-apps";
const LEGACY = "open-mcp-app";                          // pre-rename name; remove if found

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const YES = argv.includes("--yes") || argv.includes("-y");
const PURGE = argv.includes("--purge");
const hostArg = (argv.find((a) => a.startsWith("--host=")) || "").split("=")[1]
  || (argv.includes("--host") ? argv[argv.indexOf("--host") + 1] : null);

// The shared store — MUST mirror store.mjs defaultDbDir() / install.mjs dataDir().
function dataDir() {
  const h = homedir();
  if (platform() === "darwin") return join(h, "Library", "Application Support", "open-mcp-apps");
  if (platform() === "win32") return join(process.env.APPDATA || join(h, "AppData", "Roaming"), "open-mcp-apps");
  return join(process.env.XDG_DATA_HOME || join(h, ".local", "share"), "open-mcp-apps");
}
const DB_NAME = "open-mcp-apps.db";

// ================================================================ HOST ADAPTERS
// Each: { id, label, restart, detect(), present() → bool, remove() → { changed:[[what,name]], configLoc, note? } }
function claudeCfgPath() {
  const h = homedir();
  if (platform() === "darwin") return join(h, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform() === "win32") return join(process.env.APPDATA || join(h, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(process.env.XDG_CONFIG_HOME || join(h, ".config"), "Claude", "claude_desktop_config.json");
}
const claude = {
  id: "claude", label: "Claude Desktop", restart: "Claude Desktop",
  detect: () => existsSync(dirname(claudeCfgPath())),
  present() {
    const p = claudeCfgPath();
    if (!existsSync(p)) return false;
    try { const cfg = JSON.parse(readFileSync(p, "utf8")); return !!(cfg.mcpServers && (cfg.mcpServers[NAME] || cfg.mcpServers[LEGACY])); }
    catch { return false; }
  },
  remove() {
    const p = claudeCfgPath();
    const changed = [];
    let cfg;
    try { cfg = JSON.parse(readFileSync(p, "utf8")); }
    catch { return { changed, configLoc: p, note: "config missing or unreadable — left untouched" }; }
    // Only ever touch our OWN keys — never rewrite or drop another server's entry.
    for (const n of [NAME, LEGACY]) if (cfg.mcpServers && cfg.mcpServers[n]) { delete cfg.mcpServers[n]; changed.push(["removed", n]); }
    if (changed.length) writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    return { changed, configLoc: p };
  },
};

function claudeCodeAvailable() {
  try { execFileSync("claude", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
function ccPresent(name) {
  try { execFileSync("claude", ["mcp", "get", name], { stdio: ["ignore", "ignore", "ignore"] }); return true; }
  catch { return false; }   // "No MCP server named …" exits non-zero
}
const claudeCode = {
  id: "claude-code", label: "Claude Code", restart: null,   // picks up MCP changes on next run
  detect: claudeCodeAvailable,
  present() { return ccPresent(NAME) || ccPresent(LEGACY); },
  remove() {
    const changed = [];
    for (const n of [NAME, LEGACY]) {
      if (!ccPresent(n)) continue;
      try { execFileSync("claude", ["mcp", "remove", n, "-s", "user"], { stdio: "ignore" }); changed.push(["removed", n]); } catch {}
    }
    return { changed, configLoc: "~/.claude.json (user scope)" };
  },
};

function codexAvailable() {
  try { execFileSync("codex", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
function codexPresent(name) {
  try { execFileSync("codex", ["mcp", "get", name], { stdio: ["ignore", "ignore", "ignore"] }); return true; }
  catch { return false; }
}
const codex = {
  id: "codex", label: "Codex", restart: "the Codex / ChatGPT app",
  detect: () => existsSync(join(homedir(), ".codex")) && codexAvailable(),
  present() { return codexPresent(NAME) || codexPresent(LEGACY); },
  remove() {
    const changed = [];
    for (const n of [NAME, LEGACY]) {
      if (!codexPresent(n)) continue;
      try { execFileSync("codex", ["mcp", "remove", n], { stdio: "ignore" }); changed.push(["removed", n]); } catch {}
    }
    // Leave the [features] apps/enable_mcp_apps flags — they are harmless and shared by any other MCP-apps server.
    return { changed, configLoc: join(homedir(), ".codex", "config.toml"), note: "left the [features] apps flags (harmless; other MCP-apps servers rely on them)" };
  },
};

const ADAPTERS = [claude, claudeCode, codex];
const safeDetect = (a) => { try { return a.detect(); } catch { return false; } };
const safePresent = (a) => { try { return a.present(); } catch { return false; } };

// Count live open-mcp-apps server processes — a GUI host keeps its child running until FULLY quit, so
// after unregistering the user still needs a Cmd-Q for the server to actually stop. (macOS/Linux.)
function runningServers() {
  if (platform() === "win32") return null;
  try {
    const out = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
    return out.split("\n").filter((l) => /server\.mjs/.test(l) && /open-mcp-apps/.test(l)).length;
  } catch { return null; }
}

// Minimal y/N confirm on the controlling terminal (works under `curl … | sh` via /dev/tty).
function inputTTY() {
  if (process.stdin.isTTY) return { stream: process.stdin, cleanup: () => { try { process.stdin.setRawMode(false); } catch {} process.stdin.pause(); } };
  try {
    const fd = openSync("/dev/tty", "r");
    const stream = new ReadStream(fd);
    if (!stream.isTTY) { try { stream.destroy(); } catch {} try { closeSync(fd); } catch {} return null; }
    return { stream, cleanup: () => { try { stream.setRawMode(false); } catch {} try { stream.destroy(); } catch {} try { closeSync(fd); } catch {} } };
  } catch { return null; }
}
async function confirm(prompt) {
  const io = inputTTY();
  if (!io) return false;                                  // no terminal + no --yes → refuse to remove
  process.stdout.write(prompt);
  emitKeypressEvents(io.stream);
  try { io.stream.setRawMode(true); } catch {}
  io.stream.resume?.();
  return await new Promise((res) => {
    const onKey = (str, key = {}) => {
      io.stream.removeListener("keypress", onKey);
      io.cleanup(); process.stdout.write("\n");
      if (key.ctrl && key.name === "c") process.exit(130);
      res(!!str && /^y$/i.test(str));
    };
    io.stream.on("keypress", onKey);
  });
}

// ================================================================ main
if (hostArg) {
  const unknown = hostArg.split(",").map((s) => s.trim()).filter((h) => !ADAPTERS.some((a) => a.id === h));
  if (unknown.length) { console.error(`✗ unknown --host: ${unknown.join(", ")} (use claude | claude-code | codex)`); process.exit(1); }
}

const db = join(dataDir(), DB_NAME);
const storeExists = existsSync(db);

// Declared BEFORE any path that can call purgeStore(): the "nothing registered + --purge" early
// path below runs purgeStore() first, and a later `let` would still be in its temporal dead zone
// (real crash: ReferenceError AFTER the store was already deleted, so the summary never printed).
let purged = null;
function purgeStore() {
  const dir = dataDir();
  for (const suf of ["", "-wal", "-shm"]) { const f = join(dir, DB_NAME + suf); if (existsSync(f)) rmSync(f, { force: true }); }
  const filesDir = join(dir, "files"); if (existsSync(filesDir)) rmSync(filesDir, { recursive: true, force: true });
  purged = dir;
}

// --check: read-only status, no writes.
if (CHECK) {
  console.log("open-mcp-apps — uninstall status (read-only):");
  for (const a of ADAPTERS) {
    if (!safeDetect(a)) { console.log(`  ${a.label.padEnd(15)} not found`); continue; }
    console.log(`  ${a.label.padEnd(15)} ${safePresent(a) ? "installed → would be unregistered" : "not registered"}`);
  }
  console.log(`  ${"shared store".padEnd(15)} ${storeExists ? db + (PURGE ? "  → would be DELETED (--purge)" : "  (kept — pass --purge to delete)") : "none"}`);
  process.exit(0);
}

const detected = ADAPTERS.filter(safeDetect);
let selected = detected.filter(safePresent);
if (hostArg) {
  const ids = hostArg.split(",").map((s) => s.trim());
  selected = selected.filter((a) => ids.includes(a.id));
}

if (!selected.length) {
  console.log(`open-mcp-apps is not registered in any${hostArg ? " matching" : " detected"} host — nothing to unregister.`);
  if (PURGE && storeExists) {
    if (!YES && !(await confirm(`Still DELETE the shared store (all apps + data + files) at\n  ${dataDir()}\n? [y/N] `))) { console.log("✗ cancelled."); process.exit(0); }
    purgeStore();
    console.log(`\n  shared store DELETED: ${purged}`);
  } else if (storeExists) {
    console.log(`(the shared store at ${db} is untouched — pass --purge to delete it.)`);
  }
  process.exit(0);
}

// Confirm (unless --yes).
if (!YES) {
  const line = `Remove open-mcp-apps from: ${selected.map((a) => a.label).join(", ")}` +
    (PURGE ? "\nand DELETE the shared store (all apps + data + files)" : "  (the shared store is KEPT)");
  const ok = await confirm(line + "\nProceed? [y/N] ");
  if (!ok) { console.log("✗ cancelled — nothing was changed."); process.exit(0); }
}

// Unregister.
const applied = [];
for (const a of selected) applied.push({ a, out: a.remove() });

// Purge the store if asked.
if (PURGE) purgeStore();

// ---- summary ----
console.log(`\n✅ open-mcp-apps — unregistered.`);
for (const { a, out } of applied) {
  console.log(`\n  ${a.label}:`);
  if (out.changed.length) for (const [k, n] of out.changed) console.log(`     ${k}: ${n}`);
  else console.log(`     nothing to remove`);
  console.log(`     config: ${out.configLoc}`);
  if (out.note) console.log(`     note: ${out.note}`);
}
console.log(purged ? `\n  shared store DELETED: ${purged}` : `\n  shared store kept: ${db}${storeExists ? "  (re-install restores every app + all data)" : ""}`);

const restarts = [...new Set(applied.map(({ a }) => a.restart).filter(Boolean))];
if (restarts.length) {
  console.log(`\n→ FULLY QUIT ${restarts.join(" and ")} — Cmd-Q, or right-click the Dock icon → Quit; NOT just closing the window — then reopen.`);
  console.log(`  Until fully quit, the OLD server child keeps running even though the config no longer lists it.`);
  const n = runningServers();
  if (n) console.log(`  (${n} open-mcp-apps server process${n === 1 ? " is" : "es are"} live right now — a full quit clears ${n === 1 ? "it" : "them"}.)`);
}
