// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// seed.mjs — load the built-in SYSTEM components (components/*.html) into a registry.
// CLI: node seed.mjs   (idempotent per content: re-seeding same html just bumps version)
// Library: import { seedSystemComponents } from "open-mcp-apps" — embedders (e.g. a hosted
// data-plane provisioning a fresh per-tenant store) call it after openStore(); idempotent,
// so calling on every open is safe and cheap (content-hash command_id + unchanged check).
import { openStore } from "./src/store.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));

const DESCRIPTIONS = {
  settings: "Settings — preferences (poll intervals etc, stored in the settings collection), usage guide, About stats, Library placeholder",
  dashboard: "Everything dashboard — meta component: overview cards for ALL collections (counts, groups, previews), Open buttons ask the AI to bring up the full board",
  gallery: "Gallery — browse the built-in library of ready-made first-party apps (live previews with sample data) and install them into your registry with one click",
};

// Library scene categories for the seeds (design-system §7.5). System components carry no scene;
// gallery entries get their taxonomy at install time if ever needed.
const SCENES = {};

// Only SYSTEM components are installed on seed. The other components/*.html are the GALLERY —
// browsable in the `gallery` app and installed on demand (install_from_gallery), NOT auto-
// installed; a fresh registry stays clean so onboarding builds apps tailored to the user
// instead of presenting a pre-filled catalog.
const SYSTEM = new Set(["settings", "dashboard", "gallery"]);

/**
 * Seed the system components into `store`. Returns [{name, action: "seeded"|"unchanged"|"skipped"|"error", version?, error?}].
 * seed-time inlining (design-system §6.1 option A): marker → kit, then compare+hash the FINAL bytes.
 * Ordering is load-bearing: a kit-only change must alter html BEFORE the hash, else the command_id
 * repeats and store.execute()'s eventByCmd idempotency silently swallows the update.
 */
export function seedSystemComponents(store, { log = () => {} } = {}) {
  const KIT = readFileSync(join(HERE, "components", "_system.css"), "utf-8");
  const KIT_TAG = `<style data-oma="system">\n${KIT}</style>`;
  const MARKER = "<!-- @OMA_SYSTEM_CSS -->";
  const out = [];
  for (const file of readdirSync(join(HERE, "components")).filter((f) => f.endsWith(".html"))) {
    const name = basename(file, ".html");
    if (!SYSTEM.has(name)) { log(`· ${name} — gallery entry, not auto-installed (browse the gallery app)`); out.push({ name, action: "skipped" }); continue; }
    const raw = readFileSync(join(HERE, "components", file), "utf-8");
    const html = raw.includes(MARKER) ? raw.replace(MARKER, () => KIT_TAG) : raw; // inline kit FIRST; function replacement — $-patterns in the kit must stay literal
    const scene = SCENES[name] ? { category_id: SCENES[name] } : null;
    const sceneJson = scene ? JSON.stringify(scene) : null; // must match the store's own serialization
    const existing = store.getComponent(name);
    // Unchanged-check covers html AND scene: a scene-only change must bump, so it is folded into
    // both the compare and the command_id hash (else eventByCmd idempotency swallows it). Seed only
    // ever passes scene:null for scene-less system components (settings/dashboard), where the store's
    // "explicit null = clear" is a no-op equal to preserve, so the compare stays html-only for them.
    if (existing && existing.html === html && (sceneJson === null || existing.scene === sceneJson)) { log(`= ${name} unchanged (v${existing.version})`); out.push({ name, action: "unchanged", version: existing.version }); continue; }
    // command_id derived from FINAL (post-inline) content hash → re-running the same seed is a no-op even across dbs
    const command_id = "seed-" + name + "-" + createHash("sha256").update(html + "\n@scene:" + (sceneJson ?? "")).digest("hex").slice(0, 16);
    const r = store.execute({ type: "save_component", command_id, name, html, description: DESCRIPTIONS[name] || "", scene, actor: "seed" });
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
