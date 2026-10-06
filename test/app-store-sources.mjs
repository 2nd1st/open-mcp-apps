// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/app-store-sources.mjs — the App Store reads an ordered list of source folders:
// OMA_APP_STORE_DIRS first, the engine's own components/ last. First source with a name wins;
// system apps come only from components/ and cannot be listed or shadowed from outside.
//
// Run: node test/app-store-sources.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { listAppStore, readAppStoreApp, readSystemApp } from "../src/app-store.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

const root = mkdtempSync(join(tmpdir(), "oma-store-src-"));
const app = (dir, name, title) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "ui.html"), `<!doctype html><title>${title}</title><p>${title}</p>`);
};
const a = join(root, "a"), b = join(root, "b");
app(a, "outside-only", "From A");
app(a, "shared-name", "A wins");
app(b, "shared-name", "B loses");
app(b, "settings", "Fake settings");          // a system name from outside
app(a, "meeting-actions", "Outside meeting");  // shadows a built-in store app
mkdirSync(join(a, "Not_A_Name"));              // invalid app name: never listed
writeFileSync(join(a, "stray.txt"), "x");      // a file, not an app

const builtin = listAppStore();
const names = (l) => l.map((e) => e.name);
try {
  console.log("1. no outside source = the built-in store");
  delete process.env.OMA_APP_STORE_DIRS;
  ok("built-in apps listed", builtin.length > 0 && names(builtin).includes("meeting-actions"));
  ok("system apps never listed", !names(builtin).some((n) => ["settings", "dashboard", "app-store"].includes(n)));

  console.log("2. outside sources join the store, in order");
  process.env.OMA_APP_STORE_DIRS = [a, join(root, "missing"), b].join(delimiter);
  const l = listAppStore();
  ok("an outside app is listed", names(l).includes("outside-only"));
  ok("built-ins still listed", names(builtin).every((n) => names(l).includes(n)));
  ok("each name listed once", new Set(names(l)).size === l.length);
  ok("a missing source dir is just empty", l.length === builtin.length + 2, `got ${l.length}, built-in ${builtin.length}`);
  ok("first source wins a shared name", readAppStoreApp("shared-name")?.title === "A wins");
  ok("an outside app shadows a built-in of the same name", readAppStoreApp("meeting-actions")?.title === "Outside meeting");
  ok("the listing shows the winner", l.find((e) => e.name === "meeting-actions")?.title === "Outside meeting");
  ok("invalid names and stray files are ignored", !names(l).includes("Not_A_Name") && !names(l).includes("stray.txt"));

  console.log("3. system apps are the engine's own");
  ok("an outside 'settings' is not readable as a store app", readAppStoreApp("settings") === null);
  ok("seeding reads the built-in settings, not the outside one", readSystemApp("settings") && readSystemApp("settings").title !== "Fake settings");
  ok("an outside 'settings' is not listed", !names(l).includes("settings"));
} finally {
  delete process.env.OMA_APP_STORE_DIRS;
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
