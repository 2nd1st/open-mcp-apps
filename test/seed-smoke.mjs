// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/seed-smoke.mjs — proves seed.mjs stores the FILE's bytes and is idempotent across runs,
// that what the engine adds to every document is the page BASE only (the tokens' companion:
// reset, font, [hidden], safe-area defaults — no layout, no component classes), and that every
// shipped app carries the CSS for the classes it uses itself.
// Uses its OWN temp OMA_DB.
// Run: node test/seed-smoke.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openStore } from "../src/store.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "seed-smoke.db");
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
const { wrapApp, wrapLoader, BASE_CSS } = await import("../src/shell.mjs");
const baseOf = (doc) => /<style data-oma="base">([\s\S]*?)<\/style>/.exec(doc)?.[1] ?? null;
const appFiles = readdirSync(join(ROOT, "components")).filter((n) => existsSync(join(ROOT, "components", n, "ui.html")));
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
  ok("no stored app carries an engine <style> or the retired marker",
    !stored.includes('data-oma="base"') && !stored.includes('data-oma="kit"') && !stored.includes("@OMA_SYSTEM_CSS"));
  ok("the marker is gone from every shipped app file",
    appFiles.every((n) => !readFileSync(join(ROOT, "components", n, "ui.html"), "utf-8").includes("@OMA_SYSTEM_CSS")));

  console.log("3. the engine adds the page BASE to every document — and nothing that lays out");
  const appDoc = wrapApp("<p>x</p>");
  const loaderDoc = wrapLoader();
  ok("wrapApp injects the base, byte-for-byte BASE_CSS", baseOf(appDoc) === BASE_CSS);
  ok("wrapLoader injects it too (the universal-loader document)", baseOf(loaderDoc) === BASE_CSS);
  ok("no kit layer ships any more: no data-oma=\"kit\" tag, no .k-* selector in the base",
    ![appDoc, loaderDoc].some((d) => d.includes('data-oma="kit"') || /\.k-[a-z]/.test(baseOf(d) ?? "")));
  // Every declaration the base makes, by property. The allowed set IS the contract: a reset, the
  // host font and colour, [hidden], the safe-area defaults. A padding, a width, a frame — any
  // property outside it — is the engine laying out an app, which is the app's job.
  const declsOf = (css) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].flatMap(([, sel, body]) =>
    body.split(";").map((d) => d.trim()).filter(Boolean)
      .map((d) => [sel.trim(), d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]));
  const decls = declsOf(BASE_CSS);
  ok(`the base declares something (${decls.length} declarations) — the checks below are non-vacuous`, decls.length >= 6);
  const ALLOWED = new Set(["box-sizing", "margin", "font-family", "font-size", "color", "display",
    "--oma-safe-top", "--oma-safe-right", "--oma-safe-bottom", "--oma-safe-left"]);
  const stray = decls.filter(([, prop]) => !ALLOWED.has(prop));
  ok("…and only reset / font / colour / [hidden] / safe-area properties", stray.length === 0);
  if (stray.length) console.log("      stray: " + stray.map((d) => d.join(" ")).join(" | "));
  ok("…body margin is 0 and nothing pads it",
    decls.some(([sel, p, v]) => sel === "body" && p === "margin" && v === "0") &&
    !decls.some(([sel, p]) => sel === "body" && p.startsWith("padding")));
  ok("…display appears only to keep [hidden] hidden",
    decls.some(([, p]) => p === "display") &&
    decls.filter(([, p]) => p === "display").every(([sel, , v]) => sel === "[hidden]" && /none\s*!important/.test(v)));
  ok("…every --oma-safe-* side defaults to 0px", ["top", "right", "bottom", "left"]
    .every((side) => decls.some(([sel, p, v]) => sel === ":root" && p === `--oma-safe-${side}` && v === "0px")));

  console.log("3b. every shipped app carries the CSS for the k-* classes it uses");
  // The engine ships no component classes, so an app that names `.k-btn` in its markup and has no
  // rule for it renders that button as a bare browser default. Static markup only (class="…"),
  // which is where every one of these apps puts its frame.
  const unstyled = [];
  let classesSeen = 0;
  for (const n of appFiles) {
    const ui = readFileSync(join(ROOT, "components", n, "ui.html"), "utf-8");
    const css = [...ui.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
    const markup = ui.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
    const used = new Set([...markup.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => /^k-[a-z]/.test(c)));
    classesSeen += used.size;
    for (const c of used) if (!new RegExp(`\\.${c}(?![\\w-])`).test(css)) unstyled.push(`${n}: .${c}`);
  }
  ok(`k-* classes found in shipped markup (${classesSeen}) — the check below is non-vacuous`, classesSeen > 20);
  ok("…and each one has a rule in its own app's <style>", unstyled.length === 0);
  if (unstyled.length) console.log("      unstyled: " + unstyled.join(", "));
  seed();
  const v3 = versions();
  ok("…and re-seeding moves NO app version (nothing is baked into stored source)",
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
  rmdb();
}
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
