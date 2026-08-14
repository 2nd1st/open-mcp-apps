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

  console.log("1b. only SYSTEM apps are installed; App Store entries are NOT");
  const installed = Object.keys(v1);
  ok("settings + dashboard + app-store installed", ["settings", "dashboard", "app-store"].every((n) => installed.includes(n)));
  ok("App Store entries (habit-streaks/meal-planner/bill-calendar) NOT auto-installed", ["habit-streaks", "meal-planner", "bill-calendar"].every((n) => !installed.includes(n)));

  console.log("2. stored bytes are the FILE's bytes — the kit is not baked in");
  const stored = (() => { const s = openStore(DB); const h = s.getApp("settings").ui; s.close(); return h; })();
  ok("a seeded app's stored ui equals its source file byte-for-byte",
    stored === readFileSync(join(ROOT, "components", "settings", "ui.html"), "utf-8"));
  ok("no stored app carries a kit <style> or the retired marker",
    !stored.includes('data-oma="kit"') && !stored.includes("@OMA_SYSTEM_CSS"));
  ok("the marker is gone from every shipped app file",
    readdirSync(join(ROOT, "components")).filter((n) => existsSync(join(ROOT, "components", n, "ui.html")))
      .every((n) => !readFileSync(join(ROOT, "components", n, "ui.html"), "utf-8").includes("@OMA_SYSTEM_CSS")));

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
    // Turn the seeded 'app-store' row into what a migrated v0.2.0 store can legally contain: a
    // user-authored app that took the name before it was reserved. The seeder must refuse the
    // slot loudly and leave the user's bytes alone — degraded ship, never a clobber.
    const s = openStore(DB);
    s.db.prepare("UPDATE app SET author='agent', ui='<p>the user built this</p>' WHERE name='app-store'").run();
    s.close();
    const log4 = seed();
    const s2 = openStore(DB);
    const row = s2.getApp("app-store");
    s2.close();
    ok("the seeder refused the occupied name and said so", /app-store — name taken by a non-seed app/.test(log4));
    ok("the user's bytes and authorship survived the seed run", row.ui === "<p>the user built this</p>" && row.author === "agent");
  }

  console.log("5. a system app RENAMED away is retired from an upgraded store");
  {
    // What a v0.4.x store actually holds: the seeder of that era installed a system app named
    // `library`, and the v0.5.0 rename to `app-store` never touched that row. Left alone it is an
    // orphan — still installed, no longer in SEEDED_APPS or LOCKED_APPS, showing a page the engine
    // stopped shipping, wired to four tool names that now answer "unknown tool". Rebuild the row
    // the way the old seeder made it (author "seed" — measured off a store seeded at 953af1e^, not
    // assumed) and run today's seed over it.
    rmdb();
    { const s = openStore(DB);
      s.execute({ type: "save_app", command_id: "old-seeder-library", name: "library",
                  ui: "<p>the v0.4 library page</p>", description: "Library", actor: "seed" });
      s.close(); }
    const log5 = seed();
    const s = openStore(DB);
    const names = s.listApps().map((a) => a.name);
    const ledger = s.recentEvents({ limit: 200 });
    s.close();
    ok("the orphaned `library` row is gone", !names.includes("library"));
    ok("…and `app-store` is installed by the same run", names.includes("app-store"));
    ok("…and the seeder said which app replaced it", /library retired \(replaced by app-store\)/.test(log5));
    // Through store.execute, not around it: the delete is an ordinary event, so the act is
    // auditable and the bytes stay recoverable from app_history. Raw SQL would leave no trace.
    ok("the retirement is in the ledger as a normal delete",
      ledger.some((e) => e.type === "component_deleted" && e.id === "library" && e.actor === "seed"));
  }

  console.log("5b. an app the USER named `library` is left alone");
  {
    rmdb();
    { const s = openStore(DB);
      s.execute({ type: "save_app", command_id: "user-library", name: "library",
                  ui: "<p>my own library</p>", description: "", actor: "agent" });
      s.close(); }
    const log5b = seed();
    const s = openStore(DB);
    const row = s.getApp("library");
    s.close();
    ok("a non-seed `library` keeps its bytes and its author",
      row != null && row.ui === "<p>my own library</p>" && row.author === "agent");
    ok("…and the seeder said it left it untouched", /library — not ours \(author=agent\)/.test(log5b));
  }
} finally {
  const now = readFileSync(CSS, "utf-8");
  if (now === cssProbed) writeFileSync(CSS, cssOriginal); // undo only OUR probe write
  else if (now !== cssOriginal) console.log("  ! _system.css changed externally mid-test — left untouched");
  rmdb();
}
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
