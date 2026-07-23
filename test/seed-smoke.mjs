// test/seed-smoke.mjs — proves seed.mjs kit-propagation + cross-run idempotency
// (design-system §6.1 / D7: kit inlined via the @OMA_SYSTEM_CSS marker, then the FINAL
// bytes are hashed, so a kit-only edit yields a new version for every marker-bearing
// component and none of the others). Uses its OWN temp OMA_DB and restores
// components/_system.css byte-exact in a finally block. Run: node test/seed-smoke.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { openStore } from "../src/store.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "seed-smoke.db");
const CSS = join(ROOT, "components", "_system.css");
const MARKER = "<!-- @OMA_SYSTEM_CSS -->";
const rmdb = () => { for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f); };

let pass = 0, fail = 0;
const ok = (name, cond) => (cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name)));
const seed = () => execFileSync("node", [join(ROOT, "seed.mjs")], { env: { ...process.env, OMA_DB: DB }, encoding: "utf-8" });
const versions = () => {
  const s = openStore(DB);
  const v = Object.fromEntries(s.listComponents().map((c) => [c.name, c.version]));
  s.close();
  return v;
};

// Capture the ORIGINAL bytes; restore them ONLY if the file still holds our probe write —
// a concurrent editor's change must never be clobbered by the restore.
const cssOriginal = readFileSync(CSS, "utf-8");
const cssProbed = cssOriginal + "\n/* seed-smoke kit-edit probe */\n";
rmdb();
try {
  console.log("1. seed is idempotent across runs (same temp db)");
  seed();
  const v1 = versions();
  seed();
  const v2 = versions();
  ok("first seed produced components", Object.keys(v1).length > 0);
  ok("second seed is a no-op (all versions unchanged)", Object.keys(v1).every((n) => v1[n] === v2[n]));

  console.log("1b. only SYSTEM components are installed; example components are NOT");
  const installed = Object.keys(v1);
  ok("settings + dashboard installed", installed.includes("settings") && installed.includes("dashboard"));
  ok("example components (kanban/pomodoro/todo) NOT auto-installed", ["kanban", "pomodoro", "todo"].every((n) => !installed.includes(n)));

  console.log("2. a kit edit propagates to marker-bearing components ONLY");
  const files = readdirSync(join(ROOT, "components")).filter((f) => f.endsWith(".html"));
  const marker = [], plain = [];
  for (const f of files) (readFileSync(join(ROOT, "components", f), "utf-8").includes(MARKER) ? marker : plain).push(basename(f, ".html"));
  console.log(`   marker-bearing: [${marker.join(", ") || "none"}]   non-marker: [${plain.join(", ")}]`);
  // append one comment to the kit → the inlined bytes change for every marker-bearing component
  writeFileSync(CSS, cssProbed);
  seed();
  const v3 = versions();
  ok("every marker-bearing component bumped exactly one version", marker.every((n) => v3[n] === v2[n] + 1));
  ok("non-marker components did NOT bump (kit is inlined, never globally injected)", plain.every((n) => v3[n] === v2[n]));
} finally {
  const now = readFileSync(CSS, "utf-8");
  if (now === cssProbed) writeFileSync(CSS, cssOriginal); // undo only OUR probe write
  else if (now !== cssOriginal) console.log("  ! _system.css changed externally mid-test — left untouched");
  rmdb();
}
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
