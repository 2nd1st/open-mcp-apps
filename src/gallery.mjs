// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// gallery.mjs — the built-in component LIBRARY: the high-quality components shipped in this
// repo's components/ dir, browsable via the `gallery` system app and installable into the
// user's registry with install_from_gallery. This module is the ONE place that reads library
// html from disk (engine.mjs stays fs-free). Gallery content is FIRST-PARTY: installs are
// saved with actor "gallery" (provenance + update detection) and run at the local tier,
// direct, like the user's own apps. A remote hosted gallery can later replace this dir as
// the source with the same contract (review + sandboxing arrive with third-party content).

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPONENT_NAME_RE } from "./store.mjs";

const GALLERY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "components");
// System components are the engine's own UI — they are seeded, not gallery entries.
const SYSTEM_COMPONENTS = new Set(["settings", "dashboard", "gallery"]);

const titleOf = (html, name) => (html.match(/<title>([^<]*)<\/title>/i)?.[1] || name).trim();
const descOf = (html) =>
  (html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)?.[1] || "").trim();
const categoryOf = (html) =>
  (html.match(/<meta\s+name=["']oma-category["']\s+content=["']([^"']*)["']/i)?.[1] || "Apps").trim();
// Embedded mock snapshot for the gallery's LIVE PREVIEW cards: a component may carry
// <script type="application/json" id="oma-fixtures">{"items":[…]}</script>. Malformed → null.
function fixturesOf(html) {
  const m = html.match(/<script\s+type=["']application\/json["']\s+id=["']oma-fixtures["']\s*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    return j && Array.isArray(j.items) ? { items: j.items } : null;
  } catch { return null; }
}

/** List the installable library entries: [{name, title, description, category, size, has_preview}]
 *  (never system comps). */
export function listGallery() {
  let files;
  try { files = readdirSync(GALLERY_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".html")) continue;
    const name = f.slice(0, -5);
    if (SYSTEM_COMPONENTS.has(name) || !COMPONENT_NAME_RE.test(name)) continue;
    let html;
    try { html = readFileSync(join(GALLERY_DIR, f), "utf8"); } catch { continue; }
    out.push({ name, title: titleOf(html, name), description: descOf(html), category: categoryOf(html), size: html.length, has_preview: fixturesOf(html) !== null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one library entry's html (+ metadata + preview fixtures), or null. Name is validated by
 *  COMPONENT_NAME_RE (no dots or slashes), so it can never traverse out of the gallery dir.
 *  System comps are not readable here. */
export function readGalleryComponent(name) {
  if (!COMPONENT_NAME_RE.test(String(name)) || SYSTEM_COMPONENTS.has(name)) return null;
  try {
    const html = readFileSync(join(GALLERY_DIR, name + ".html"), "utf8");
    return { name, html, title: titleOf(html, name), description: descOf(html), category: categoryOf(html), fixtures: fixturesOf(html) };
  } catch { return null; }
}
