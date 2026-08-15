// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// app-store.mjs — the built-in APP STORE: the high-quality apps shipped in this
// repo's components/ dir, browsable via the `app-store` system app and installable into the
// user's registry with install_from_app_store. This module is the ONE place that reads store
// entries from disk (engine.mjs stays fs-free). Store content is FIRST-PARTY: installs are
// saved with actor "library" (provenance + update detection — the stamp is a persisted store
// value and keeps its v0.4 spelling) and run at the local tier, direct, like the user's own
// apps. A remote hosted store can later replace this dir as the source with the same contract
// (review + sandboxing arrive with third-party content).
//
// Entry layout (W-N, wn-manifest-commit-2026-08-05.md — the package boundary):
//   components/<name>/
//     ui.html        the ui slot — a complete document, NO embedded declaration block
//     manifest.json  the manifest slot (optional — a visual may declare nothing)
//     fixtures.json  preview-only mock rows (optional; never installed, never versioned)
// The directory IS the future multi-file shape: a second source slot arrives as a sibling
// file, not a format change.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME_RE } from "./store.mjs";

const APP_STORE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "components");
// System apps are the engine's own UI — they are seeded, not app-store entries.
const SYSTEM_APPS = new Set(["settings", "dashboard", "app-store"]);

const titleOf = (ui, name) => (ui.match(/<title>([^<]*)<\/title>/i)?.[1] || name).trim();
// The quote class is BACK-REFERENCED, not re-matched: `content="…"` holding an apostrophe (which
// English prose does constantly — "today's medicines") used to end the capture at that apostrophe
// and ship half a sentence to the App Store. Whichever quote opened the attribute is the only one
// that closes it.
const descOf = (ui) =>
  (ui.match(/<meta\s+name=["']description["']\s+content=(["'])(.*?)\1/i)?.[2] || "").trim();
const categoryOf = (ui) =>
  (ui.match(/<meta\s+name=["']oma-category["']\s+content=(["'])(.*?)\1/i)?.[2] || "Apps").trim();

/** Read one entry directory, or null. `name` is APP_NAME_RE-validated (no dots or slashes), so it
 *  can never traverse out of the app-store dir. Bad JSON in manifest/fixtures → null'd field, never
 *  a throw: a broken optional file must not take the whole entry (or the whole list) down. */
function readEntry(name, { system = false } = {}) {
  if (!APP_NAME_RE.test(String(name))) return null;
  if (!system && SYSTEM_APPS.has(name)) return null;
  const dir = join(APP_STORE_DIR, name);
  let ui;
  try { ui = readFileSync(join(dir, "ui.html"), "utf8"); } catch { return null; }
  let manifest = null, fixtures = null;
  try { manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")); } catch { /* optional */ }
  if (manifest && (typeof manifest !== "object" || Array.isArray(manifest) || !Object.keys(manifest).length)) manifest = null;
  try {
    const j = JSON.parse(readFileSync(join(dir, "fixtures.json"), "utf8"));
    if (j && Array.isArray(j.items)) fixtures = j;
  } catch { /* optional */ }
  return { name, ui, manifest, fixtures, title: titleOf(ui, name), description: descOf(ui), category: categoryOf(ui) };
}

/** List the installable app-store entries:
 *  [{name, title, description, category, ui_size, has_manifest, has_preview}] (never system apps). */
export function listAppStore() {
  let names;
  try { names = readdirSync(APP_STORE_DIR); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (SYSTEM_APPS.has(n) || !APP_NAME_RE.test(n)) continue;
    try { if (!statSync(join(APP_STORE_DIR, n)).isDirectory()) continue; } catch { continue; }
    const e = readEntry(n);
    if (!e) continue;
    out.push({ name: e.name, title: e.title, description: e.description, category: e.category,
      ui_size: e.ui.length, has_manifest: e.manifest !== null, has_preview: e.fixtures !== null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one app-store entry (both slots + preview fixtures), or null. System apps are not readable here. */
export function readAppStoreApp(name) {
  return readEntry(name);
}

/** Read a SYSTEM app's entry for seeding (seed.mjs) — the one caller allowed past the system wall. */
export function readSystemApp(name) {
  return SYSTEM_APPS.has(name) ? readEntry(name, { system: true }) : null;
}

export { SYSTEM_APPS };
