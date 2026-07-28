// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// seed.mjs — load the built-in SYSTEM components (components/*.html) into a registry.
// CLI: node seed.mjs   (idempotent per content: re-seeding same html just bumps version)
// Library: import { seedSystemComponents } from "open-mcp-apps" — embedders (e.g. a hosted
// data-plane provisioning a fresh per-tenant store) call it after openStore(); idempotent,
// so calling on every open is safe and cheap (content-hash command_id + unchanged check).
import { openStore } from "./src/store.mjs";
import { SEEDED_COMPONENTS } from "./src/contracts.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));

const DESCRIPTIONS = {
  settings: "Settings — preferences (poll intervals etc, stored in the settings collection), usage guide, About stats, Library placeholder",
  dashboard: "Everything dashboard — meta component: overview cards for ALL collections (counts, groups, previews), Open buttons ask the AI to bring up the full board",
  library: "Library — browse the built-in library of ready-made first-party apps (live previews with sample data) and install them into your registry with one click",
};

// Library scene categories for the seeds (design-system §7.5). System components carry no scene;
// library entries get their taxonomy at install time if ever needed.
const SCENES = {};

// Only SYSTEM components are installed on seed. The other components/*.html are the LIBRARY —
// browsable in the `library` app and installed on demand (install_from_library), NOT auto-
// installed; a fresh registry stays clean so onboarding builds apps tailored to the user
// instead of presenting a pre-filled catalog.
// Defined in contracts.mjs — engine.mjs needs the same set to tell a first-time user apart.
const SYSTEM = SEEDED_COMPONENTS;

/**
 * Seed the system components into `store`. Returns [{name, action: "seeded"|"unchanged"|"skipped"|"conflict"|"error", version?, error?}].
 * Stored bytes are the file's bytes. The kit used to be spliced in HERE, at seed time, through a
 * per-file marker; it is now injected by the engine into every rendered document (src/shell.mjs
 * KIT_CSS), so splicing it in as well would give exactly these three components two copies.
 * That also means a kit edit no longer needs a re-seed to take effect anywhere.
 */
export function seedSystemComponents(store, { log = () => {} } = {}) {
  const out = [];
  for (const file of readdirSync(join(HERE, "components")).filter((f) => f.endsWith(".html"))) {
    const name = basename(file, ".html");
    if (!SYSTEM.has(name)) { log(`· ${name} — library entry, not auto-installed (browse the library app)`); out.push({ name, action: "skipped" }); continue; }
    const html = readFileSync(join(HERE, "components", file), "utf-8");
    const scene = SCENES[name] ? { category_id: SCENES[name] } : null;
    const sceneJson = scene ? JSON.stringify(scene) : null; // must match the store's own serialization
    const existing = store.getComponent(name);
    // A system NAME occupied by a component this seeder did not write is the USER'S property —
    // a v0.2.0 store may legally hold an app called "library" (the name was not reserved then).
    // Seed without expected_version would silently clobber it, so this is the one hard refusal:
    // leave the user's row untouched, say so loudly, and ship degraded (that browse surface simply
    // isn't installed) — the user frees the slot by renaming their app.
    if (existing && existing.author !== "seed") {
      log(`✗ ${name} — name taken by a non-seed component (author=${existing.author}); left untouched`);
      out.push({ name, action: "conflict", author: existing.author });
      continue;
    }
    // Unchanged-check covers html AND scene: a scene-only change must bump, so it is folded into
    // both the compare and the command_id hash (else eventByCmd idempotency swallows it). Seed only
    // ever passes scene:null for scene-less system components (settings/dashboard), where the store's
    // "explicit null = clear" is a no-op equal to preserve, so the compare stays html-only for them.
    if (existing && existing.html === html && (sceneJson === null || existing.scene === sceneJson)) { log(`= ${name} unchanged (v${existing.version})`); out.push({ name, action: "unchanged", version: existing.version }); continue; }
    // command_id derived from FINAL (post-inline) content hash → re-running the same seed is a no-op even across dbs
    const command_id = "seed-" + name + "-" + createHash("sha256").update(html + "\n@scene:" + (sceneJson ?? "")).digest("hex").slice(0, 16);
    // salvage, not strict: seeding is a rescue/replay path (§9-1's list), and a malformed block in
    // ONE shipped component must degrade to "that declaration cleared, loudly" — never to an engine
    // that fails to boot its own UI.
    const r = store.execute({ type: "save_component", command_id, name, html, description: DESCRIPTIONS[name] || "", scene, actor: "seed", declaration_policy: "salvage" });
    log(r.ok ? `✓ ${name} → v${r.version ?? "?"}${r.idempotent ? " (idempotent)" : ""}${scene ? ` [${scene.category_id}]` : ""}` : `✗ ${name}: ${r.error}`);
    out.push(r.ok ? { name, action: "seeded", version: r.version } : { name, action: "error", error: r.error });
  }
  return out;
}

// CLI entry (node seed.mjs): seed the fixed per-user db — OMA_DB overrides (see store.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = openStore();
  seedSystemComponents(store, { log: console.log });
  store.close();
}
