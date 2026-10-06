// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// app-store.mjs — the APP STORE: ready-made apps, browsable via the `app-store` system app and
// installable into the user's registry with install_from_app_store. This module is the ONE place
// that reads store entries from disk (engine.mjs stays fs-free). Store content is FIRST-PARTY:
// installs are saved with actor "library" (provenance + update detection — the stamp is a
// persisted store value and keeps its v0.4 spelling) and run at the local tier, direct, like the
// user's own apps.
//
// SOURCES. The store apps are NOT in this repo: they live in the `@openmcp-app/oma-store` package
// (github.com/openmcp-app/oma-store), a dependency of the engine, read from its `apps/` dir. The
// store reads an ordered list of directories, each laid out like that `apps/` dir: every dir named
// in OMA_APP_STORE_DIRS (path-delimiter separated, read per call so a running engine and the tests
// see the same thing), then the package's `apps/` last. The first source that has a name wins it,
// so an outside dir can replace a package app by shipping the same name. If the package is not
// installed the store is just the env dirs.
//
// SYSTEM APPS (settings · dashboard · app-store) are the engine's own UI and the only apps in this
// repo's components/. They are seeded (seed.mjs → readSystemApp), never app-store entries: read
// only from components/, never listed, never installable, and no store source can shadow them.
//
// Entry layout (W-N, wn-manifest-commit-2026-08-05.md — the package boundary):
//   <source>/<name>/
//     ui.html        the ui slot — a complete document, NO embedded declaration block
//     manifest.json  the manifest slot (optional — an app may declare nothing)
//     skill.md       the skill slot (optional): SKILL.md text — how an AI uses the app. Its
//                    frontmatter description IS the entry's description (it outranks the
//                    document's <meta name="description">), so the card and the guide cannot disagree
//     fixtures.json  preview-only mock rows (optional; never installed, never versioned):
//                    {"as_of": "YYYY-MM-DD", "items": [...]} — as_of is the "today" the rows were
//                    written for; previews slide every date forward so the data is always current
//     fixtures.zh.json  the same, for a Chinese reader (optional; en is the fallback)
// The directory IS the future multi-file shape: a second source slot arrives as a sibling
// file, not a format change.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { APP_NAME_RE } from "./store.mjs";
import { parseSkill } from "./skill.mjs";

const SYSTEM_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "components");
const PACKAGE_DIR = (() => {
  try { return join(dirname(createRequire(import.meta.url).resolve("@openmcp-app/oma-store/package.json")), "apps"); }
  catch { return null; }   // not installed: the store is just the env dirs
})();
const storeDirs = () => [
  ...(process.env.OMA_APP_STORE_DIRS || "").split(delimiter).filter(Boolean).map((d) => resolve(d)),
  ...(PACKAGE_DIR ? [PACKAGE_DIR] : []),
];
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
 *  can never traverse out of a source dir. Bad JSON in manifest/fixtures → null'd field, never
 *  a throw: a broken optional file must not take the whole entry (or the whole list) down. */
function readEntry(name, { system = false } = {}) {
  if (!APP_NAME_RE.test(String(name))) return null;
  if (!system && SYSTEM_APPS.has(name)) return null;
  for (const root of system ? [SYSTEM_DIR] : storeDirs()) {
    const e = readEntryAt(join(root, name), name);
    if (e) return e;
  }
  return null;
}

function readEntryAt(dir, name) {
  let ui;
  try { ui = readFileSync(join(dir, "ui.html"), "utf8"); } catch { return null; }
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")); } catch { /* optional */ }
  if (manifest && (typeof manifest !== "object" || Array.isArray(manifest) || !Object.keys(manifest).length)) manifest = null;
  // The skill travels as written, valid or not: an entry whose skill.md does not parse still LISTS
  // (with the document's description) and its install is refused by the save door by name — a
  // broken optional file must not take the entry down, and must not install as if it were absent.
  let skill = null;
  try { skill = readFileSync(join(dir, "skill.md"), "utf8"); } catch { /* optional */ }
  const parsed = skill != null ? parseSkill(skill) : null;
  const fixtures = readFixtures(join(dir, "fixtures.json"));
  const fixturesZh = readFixtures(join(dir, "fixtures.zh.json"));
  return { name, ui, manifest, skill, fixtures, fixturesZh, title: titleOf(ui, name),
    description: parsed?.ok ? parsed.description : descOf(ui), category: categoryOf(ui) };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function readFixtures(file) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (!j || !Array.isArray(j.items)) return null;
    return ISO_DAY.test(j.as_of ?? "") ? { as_of: j.as_of, items: j.items } : { items: j.items };
  } catch { return null; }   // optional
}

// A fixture is written for one day — the week it shows, the streak it counts, the bill due "in 3
// days" — and an absolute date in it goes stale the day after it ships (measured: meal-planner's
// own fixtures showed an empty current week, its meals were all dated two weeks before the pinned
// preview day). So a fixture names its `as_of`, and a preview slides every date in it by
// (today − as_of): the data is always "as of today", relative gaps intact, and no consumer has to
// fake a clock. Only fields are touched — ids and positions carry no dates. A value is a date only
// if it LOOKS like one ("YYYY-MM-DD", or that followed by "T…"): a price or a name never matches.
const DATE_LIKE = /^(\d{4}-\d{2}-\d{2})(T.*)?$/;
const dayNum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5;
const isoOf = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
function slide(v, by) {
  if (typeof v === "string") { const m = DATE_LIKE.exec(v); return m ? isoOf(dayNum(m[1]) + by) + (m[2] ?? "") : v; }
  if (Array.isArray(v)) return v.map((x) => slide(x, by));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, slide(x, by)]));
  return v;
}

/** The rows a preview shows for `entry`: the reader's locale if the entry ships one (en otherwise),
 *  with every date slid from the fixture's as_of to `today` ("YYYY-MM-DD", default: the UTC date).
 *  {items} or null. Never mutates the entry. */
export function previewFixtures(entry, { locale = "en", today = new Date().toISOString().slice(0, 10) } = {}) {
  const f = (locale === "zh" && entry?.fixturesZh) || entry?.fixtures;
  if (!f) return null;
  if (!f.as_of || !ISO_DAY.test(today)) return { items: f.items };
  const by = dayNum(today) - dayNum(f.as_of);
  return { items: by ? f.items.map((it) => ({ ...it, fields: slide(it.fields, by) })) : f.items };
}

/** List the installable app-store entries:
 *  [{name, title, description, category, ui_size, has_manifest, has_skill, has_preview}] (never system apps). */
export function listAppStore() {
  const names = new Set();
  for (const root of storeDirs()) {
    let here;
    try { here = readdirSync(root); } catch { continue; }   // a missing outside dir is just empty
    for (const n of here) {
      if (SYSTEM_APPS.has(n) || !APP_NAME_RE.test(n)) continue;
      try { if (statSync(join(root, n)).isDirectory()) names.add(n); } catch { /* raced away */ }
    }
  }
  const out = [];
  for (const n of names) {
    const e = readEntry(n);
    if (!e) continue;
    out.push({ name: e.name, title: e.title, description: e.description, category: e.category,
      ui_size: e.ui.length, has_manifest: e.manifest !== null, has_skill: e.skill !== null, has_preview: e.fixtures !== null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one app-store entry (all three slots + preview fixtures), or null. System apps are not readable here. */
export function readAppStoreApp(name) {
  return readEntry(name);
}

/** Read a SYSTEM app's entry for seeding (seed.mjs) — the one caller allowed past the system wall. */
export function readSystemApp(name) {
  return SYSTEM_APPS.has(name) ? readEntry(name, { system: true }) : null;
}

export { SYSTEM_APPS };
