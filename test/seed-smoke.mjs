// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/seed-smoke.mjs — proves seed.mjs stores the FILE's bytes and is idempotent across runs,
// and that the system UI kit reaches apps by INJECTION rather than by being baked into
// stored source. The kit used to be spliced in at seed time through a per-file marker, which
// meant (a) only the three marker-bearing system apps ever had it and (b) a kit edit
// needed a re-seed to land. Both properties are inverted now and pinned below.
// Uses its OWN temp OMA_DB and restores components/_system.css byte-exact in a finally block.
// Run: node test/seed-smoke.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openStore } from "../src/store.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "seed-smoke.db");
const CSS = join(ROOT, "components", "_system.css");
const rmdb = () => { for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f); };

let pass = 0, fail = 0;
const ok = (name, cond) => (cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name)));
const seed = () => execFileSync("node", [join(ROOT, "seed.mjs")], { env: { ...process.env, OMA_DB: DB }, encoding: "utf-8" });
const versions = () => {
  const s = openStore(DB);
  const v = Object.fromEntries(s.listApps().map((c) => [c.name, c.version]));
  s.close();
  return v;
};
// KIT_CSS caches on first read, so every kit observation runs in a FRESH process.
const wrapped = () => execFileSync("node", ["-e",
  'import("./src/shell.mjs").then(m=>{const d=m.wrapApp("<p>x</p>");process.stdout.write(JSON.stringify({kit:/<style data-oma="kit">/.test(d),probe:d.includes("SEED_SMOKE_KIT_PROBE"),loader:/<style data-oma="kit">/.test(m.wrapLoader())}))})',
], { cwd: ROOT, encoding: "utf-8" });

// The kit as a WIDGET receives it — same fresh-process rule as wrapped(), since KIT_CSS caches.
const kitDoc = () => execFileSync("node", ["-e",
  'import("./src/shell.mjs").then(m=>process.stdout.write(m.wrapApp("<p>x</p>")))',
], { cwd: ROOT, encoding: "utf-8" });

// Capture the ORIGINAL bytes; restore them ONLY if the file still holds our probe write —
// a concurrent editor's change must never be clobbered by the restore.
const cssOriginal = readFileSync(CSS, "utf-8");
const cssProbed = cssOriginal + "\n/* SEED_SMOKE_KIT_PROBE */\n";
rmdb();
try {
  console.log("1. seed is idempotent across runs (same temp db)");
  seed();
  const v1 = versions();
  seed();
  const v2 = versions();
  ok("first seed produced apps", Object.keys(v1).length > 0);
  ok("second seed is a no-op (all versions unchanged)", Object.keys(v1).every((n) => v1[n] === v2[n]));

  console.log("1b. only SYSTEM apps are installed; library entries are NOT");
  const installed = Object.keys(v1);
  ok("settings + dashboard + library installed", ["settings", "dashboard", "library"].every((n) => installed.includes(n)));
  ok("library entries (habit-streaks/meal-planner/bill-calendar) NOT auto-installed", ["habit-streaks", "meal-planner", "bill-calendar"].every((n) => !installed.includes(n)));

  console.log("2. stored bytes are the FILE's bytes — the kit is not baked in");
  const stored = (() => { const s = openStore(DB); const h = s.getApp("settings").html; s.close(); return h; })();
  ok("a seeded app's stored html equals its source file byte-for-byte",
    stored === readFileSync(join(ROOT, "components", "settings.html"), "utf-8"));
  ok("no stored app carries a kit <style> or the retired marker",
    !stored.includes('data-oma="kit"') && !stored.includes("@OMA_SYSTEM_CSS"));
  ok("the marker is gone from every shipped app file",
    readdirSync(join(ROOT, "components")).filter((f) => f.endsWith(".html"))
      .every((f) => !readFileSync(join(ROOT, "components", f), "utf-8").includes("@OMA_SYSTEM_CSS")));

  console.log("3. the kit reaches EVERY document by injection, with no re-seed");
  const before = JSON.parse(wrapped());
  ok("wrapApp injects the kit for any app", before.kit);
  ok("wrapLoader injects it too (the universal-loader document)", before.loader);
  ok("…and does not yet contain the probe", !before.probe);
  writeFileSync(CSS, cssProbed);            // edit the kit — nothing re-seeded, nothing rebuilt
  const after = JSON.parse(wrapped());
  ok("a kit edit is live in the very next rendered document", after.probe);

  // The kit sets `display` on ten classes, and each of them silently outranks the UA's
  // [hidden]{display:none} — so `el.hidden = true` on a .k-btn left the button on screen with no
  // error to see. Read off the CSS that ACTUALLY REACHES a widget, not the file on disk: a rule
  // that does not ship is not a fix. The first assertion is the detector proving it can find
  // something, so a regex that stops matching reads as broken instead of as clean.
  const kit = /<style data-oma="kit">([\s\S]*?)<\/style>/.exec(kitDoc())?.[1] || "";
  const setsDisplay = [...kit.matchAll(/([^{}]+)\{[^}]*display\s*:/g)]
    .map((m) => m[1].trim()).filter((sel) => !sel.includes("[hidden]"));
  ok(`the shipped kit really does set display (${setsDisplay.length} selector(s)) — detector is non-vacuous`,
    setsDisplay.length > 0);
  ok("…and `hidden` beats every one of them", /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(kit));
  seed();
  const v3 = versions();
  ok("…and moves NO app version (the kit is not part of stored source)",
    Object.keys(v2).every((n) => v3[n] === v2[n]));

  console.log("4. seed never overwrites a NON-SEED app that holds a system name");
  {
    // Turn the seeded 'library' row into what a migrated v0.2.0 store can legally contain: a
    // user-authored app that took the name before it was reserved. The seeder must refuse the
    // slot loudly and leave the user's bytes alone — degraded ship, never a clobber.
    const s = openStore(DB);
    s.db.prepare("UPDATE app SET author='agent', html='<p>the user built this</p>' WHERE name='library'").run();
    s.close();
    const log4 = seed();
    const s2 = openStore(DB);
    const row = s2.getApp("library");
    s2.close();
    ok("the seeder refused the occupied name and said so", /library — name taken by a non-seed app/.test(log4));
    ok("the user's bytes and authorship survived the seed run", row.html === "<p>the user built this</p>" && row.author === "agent");
  }
} finally {
  const now = readFileSync(CSS, "utf-8");
  if (now === cssProbed) writeFileSync(CSS, cssOriginal); // undo only OUR probe write
  else if (now !== cssOriginal) console.log("  ! _system.css changed externally mid-test — left untouched");
  rmdb();
}
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
