// seed.mjs — load the built-in components (components/*.html) into the registry.
// Run: node seed.mjs   (idempotent per content: re-seeding same html just bumps version)
import { openStore } from "./src/store.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const store = openStore(); // fixed per-user data dir (see store.mjs) — OMA_DB overrides

const DESCRIPTIONS = {
  settings: "Settings — preferences (poll intervals etc, stored in the settings collection), usage guide, About stats, Library placeholder",
  dashboard: "Everything dashboard — meta component: overview cards for ALL collections (counts, groups, previews), Open buttons ask the AI to bring up the full board",
  kanban: "Kanban board — columns from item.group (To Do/Doing/Done + custom), drag & drop cards, fields: {title}",
  todo: "Todo list with progress bar — fields: {title, done}",
  pomodoro: "Pomodoro focus timer — local timer, persistent session log (fields: {label, minutes, completed_at}), daily totals, click-to-report to AI",
  notes: "Sticky notes board — colored notes grid, inline add, click-to-edit, fields: {text, color}",
  "expense-split": "Shared expense tracker — columns per person (group), totals + settlement line, fields: {desc, amount}",
  "reading-list": "Three-stage reading queue (toread/reading/done groups) — links, notes, move buttons, fields: {title, url, note}",
};

// Library scene categories for the seeds (slugs verified against the shared scenario
// taxonomy). settings/dashboard = system tier → no scene.
const SCENES = {
  kanban: "input-cocreate", todo: "input-cocreate", notes: "input-cocreate",
  pomodoro: "local-tools", "expense-split": "local-tools",
  "reading-list": "browse-compare",
};

// seed-time inlining (design-system §6.1 option A): marker → kit, then compare+hash the FINAL bytes.
// Ordering is load-bearing: a kit-only change must alter html BEFORE the hash, else the command_id
// repeats and store.execute()'s eventByCmd idempotency silently swallows the update.
const KIT = readFileSync(join(HERE, "components", "_system.css"), "utf-8");
const KIT_TAG = `<style data-oma="system">\n${KIT}</style>`;
const MARKER = "<!-- @OMA_SYSTEM_CSS -->";

// Only SYSTEM components are installed on seed. The other components/*.html are EXAMPLES —
// reference for humans / coding agents in the repo, NOT auto-installed; a fresh registry stays
// clean so onboarding builds apps tailored to the user instead of presenting a pre-filled catalog.
const SYSTEM = new Set(["settings", "dashboard"]);

for (const file of readdirSync(join(HERE, "components")).filter((f) => f.endsWith(".html"))) {
  const name = basename(file, ".html");
  if (!SYSTEM.has(name)) { console.log(`· ${name} — example, not installed`); continue; }
  const raw = readFileSync(join(HERE, "components", file), "utf-8");
  const html = raw.includes(MARKER) ? raw.replace(MARKER, () => KIT_TAG) : raw; // inline kit FIRST; function replacement — $-patterns in the kit must stay literal
  const scene = SCENES[name] ? { category_id: SCENES[name] } : null;
  const sceneJson = scene ? JSON.stringify(scene) : null; // must match the store's own serialization
  const existing = store.getComponent(name);
  // Unchanged-check covers html AND scene: a scene-only change must bump, so it is folded into
  // both the compare and the command_id hash (else eventByCmd idempotency swallows it). Seed only
  // ever passes scene:null for scene-less system components (settings/dashboard), where the store's
  // "explicit null = clear" is a no-op equal to preserve, so the compare stays html-only for them.
  if (existing && existing.html === html && (sceneJson === null || existing.scene === sceneJson)) { console.log(`= ${name} unchanged (v${existing.version})`); continue; }
  // command_id derived from FINAL (post-inline) content hash → re-running the same seed is a no-op even across dbs
  const command_id = "seed-" + name + "-" + createHash("sha256").update(html + "\n@scene:" + (sceneJson ?? "")).digest("hex").slice(0, 16);
  const r = store.execute({ type: "save_component", command_id, name, html, description: DESCRIPTIONS[name] || "", scene, actor: "seed" });
  console.log(r.ok ? `✓ ${name} → v${r.version ?? "?"}${r.idempotent ? " (idempotent)" : ""}${scene ? ` [${scene.category_id}]` : ""}` : `✗ ${name}: ${r.error}`);
}
store.close();
