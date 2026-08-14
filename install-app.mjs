// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// install-app.mjs — install an app you wrote YOURSELF into this registry, from a file.
//
//   node install-app.mjs ./my-app.html                 install (name = the file's basename)
//   node install-app.mjs ./my-app.html --name tracker  choose the registry name
//   node install-app.mjs ./my-app.html --update        overwrite an app of the same name
//   node install-app.mjs ./my-app.html --sandboxed     install as UNTRUSTED (runs behind the runner)
//   node install-app.mjs --list                        what is installed, and under whose provenance
//   node install-app.mjs ./my-app.html --dry-run       validate only — write nothing
//   (--db <path> targets a specific store; OMA_DB does the same. Default: the shared per-user store.)
//
// WHY THIS EXISTS. Every other way into this registry goes through the AI: it writes the html and
// save_app stores it. That is the right default — but it makes the AI's context window the
// upper bound on what an app can BE. An app you build in your own editor, with your own bundler,
// against your own libraries, has no such ceiling. The trade you accept by using this door is that
// the AI can no longer iterate on it: your file is the source of truth, you rebuild and re-install.
// (It can still READ your source, and it still shares your data — an installed app is an app.)
//
// WHAT AN APP MUST BE. One self-contained html document, ≤200,000 bytes, no network requests.
// Bundle whatever you like into it; the engine injects the kit CSS, the host's design tokens and
// `window.oma`, and renders it in a sandboxed iframe. Declarations (collection, settings, kind)
// are the separate manifest slot — a legacy in-document `#oma-manifest` block is extracted and
// stripped on install. The full contract: `node -e 'import("./src/guide.mjs").then(m =>
// console.log(m.GUIDE))'`, or ask the AI for get_app_guide.
//
// PROVENANCE, AND WHY THE DEFAULT IS "TRUSTED". An app's author decides whether it runs
// direct — holding the real window.oma, co-equal with the AI — or behind the sandboxed runner with
// caps. This door installs as `human`, i.e. DIRECT: on your own machine, a file you wrote is
// exactly as trustworthy as you are, and anything stricter would be theater (the same argument the
// engine makes for AI-authored apps). `--sandboxed` installs as `guest` instead, which is
// what a hosted ingress will have to do by default — there the author and the operator are not the
// same person. Use it to see what your app can still do with no capabilities at all.
//
// Provenance is not overwritable in either direction (test/provenance.mjs): once installed
// sandboxed, an app stays sandboxed until you delete it, and the AI cannot save over it.

import { readFileSync, existsSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore, MAX_APP_HTML } from "./src/store.mjs";
import { tierOf, TIER_CAPS, RESERVED_APP_NAMES, LOCKED_APPS } from "./src/contracts.mjs";
import { readDeclaration, stripDeclarationBlock } from "./src/manifest-block.mjs";
import { OMA_REFERENCE_RE } from "./src/tools/apps.mjs";

// Same shape the store enforces — stated here so the CLI can explain a bad name before the write.
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes("--" + n);
const val = (n) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf("--" + n);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const die = (msg) => { console.error("✗ " + msg); process.exit(1); };

const KNOWN = new Set(["list", "update", "sandboxed", "dry-run", "help", "name", "description", "db"]);
for (const a of argv) {
  if (!a.startsWith("--")) continue;
  const k = a.slice(2).split("=")[0];
  if (!KNOWN.has(k)) die(`unknown option --${k}. Run with --help.`);
}
if (flag("help") || (!argv.length)) {
  console.log(readFileSync(new URL(import.meta.url), "utf-8").split("\n")
    .filter((l) => l.startsWith("//")).slice(2).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

const dbPath = val("db") || undefined;
// The two commands that only LOOK take the READ-ONLY door. Opening for write runs the migration
// ladder, and the v3→v4 climb is one-way: the old shape of this line upgraded the user's store —
// irreversibly — while printing "nothing written" (--dry-run) or "(no apps installed)" (--list),
// and on a machine with no store yet it created one to say that about. Same defect, two entrances,
// one door. A read-only open returns null when there is nothing to read, which is the honest
// answer for both: no store means no collision and no apps, not a store that now exists.
const DRY = flag("dry-run");
const READ_ONLY = DRY || flag("list");
let store;
try {
  store = openStore(dbPath ? resolve(dbPath) : undefined, { readOnly: READ_ONLY });
} catch (e) {
  die(e.message);   // a schema this build cannot read is a sentence, not a stack trace
}

// ── --list ────────────────────────────────────────────────────────────────────────────────────
// Provenance is invisible everywhere else on the CLI, and it is the one thing that decides how an
// app runs. That makes "what is installed and whose is it" the natural companion to installing.
if (flag("list")) {
  const rows = store ? store.listApps() : [];   // null store = nothing installed anywhere yet
  if (!rows.length) console.log("(no apps installed)");
  else {
    const w = Math.max(...rows.map((r) => r.name.length));
    for (const r of rows) {
      const tier = tierOf(r.author);
      console.log(`  ${r.name.padEnd(w)}  v${String(r.version).padEnd(4)} ${String(r.ui_size).padStart(7)}B  ` +
        `by ${r.author.padEnd(7)} ${tier === "local" ? "direct" : tier}`);
    }
    console.log(`\n${rows.length} app(s). "direct" = holds the real window.oma; anything else runs behind the sandboxed runner.`);
  }
  store?.close();
  process.exit(0);
}

// ── read + validate ───────────────────────────────────────────────────────────────────────────
const file = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--name"
  && argv[argv.indexOf(a) - 1] !== "--description" && argv[argv.indexOf(a) - 1] !== "--db");
if (!file) die("no file given. usage: node install-app.mjs ./my-app.html");
const path = resolve(file);
if (!existsSync(path) || !statSync(path).isFile()) die(`no such file: ${path}`);

const html = readFileSync(path, "utf-8");
const name = (val("name") || basename(path, extname(path))).trim();

if (!NAME_RE.test(name))
  die(`"${name}" is not a valid app name (lowercase letters, digits and dashes, starting with a letter, max 32). Use --name.`);
if (RESERVED_APP_NAMES.has(name)) die(`"${name}" is a reserved namespace — pick another name.`);
if (LOCKED_APPS.has(name)) die(`"${name}" is a system app that ships with the engine — pick another name.`);
if (!html.trim()) die("that file is empty — an app is something a person opens.");
if (html.length > MAX_APP_HTML)
  die(`${html.length.toLocaleString()} bytes exceeds the ${MAX_APP_HTML.toLocaleString()}-byte limit for one document. ` +
      `An app is ONE self-contained file; if your bundle is bigger than this, ship less of it (the engine already provides the kit CSS and design tokens).`);

// Warnings, never refusals: this door's job is to install what you wrote, and a document that
// happens not to call the API is still a document. But both of these are silent failures at
// RUNTIME — a missing declaration means no collection binding, and no oma reference means the app
// can never see its data — so they are worth one line each before the write, not after.
const warn = [];
if (!OMA_REFERENCE_RE.test(html))
  warn.push("this document never references `window.oma`, so it cannot read or write any data. If that is intended, it is a static page, not an app.");
// v6 (W-N): the declaration is a separate slot, not an in-document block. This door is the one
// HUMAN ingress, so a legacy block is EXTRACTED here as a convenience — parsed, lifted into the
// manifest slot, stripped from the document — instead of the loud refusal the tool face gives a
// model (a human re-running a CLI is cheaper than a human editing bytes out of a file).
const decl = readDeclaration(html);
if (decl.state === "bad")
  die(`the #oma-manifest block could not be read (${decl.error}${decl.detail ? ": " + decl.detail : ""}) — fix it (or delete it and re-run).`);
const manifest = decl.state === "present" ? decl.value : null;
const ui = decl.state === "present" || decl.state === "empty" ? stripDeclarationBlock(html).html : html;
if (decl.state === "present")
  warn.push("legacy #oma-manifest block found — extracted into the manifest slot and stripped from the document (v6 stores them separately).");
else if (decl.state === "absent")
  warn.push("no declaration: the app will bind to a collection named after itself and declare no fields. Ship a manifest to name your collection.");

const actor = flag("sandboxed") ? "guest" : "human";
const tier = tierOf(actor);
const caps = TIER_CAPS[tier];
const existing = store ? store.getApp(name) : null;   // null store = dry run with no store yet

console.log(`  file      ${path}`);
console.log(`  name      ${name}`);
console.log(`  size      ${html.length.toLocaleString()} B` + (existing ? `  (replacing ${existing.ui.length.toLocaleString()} B at v${existing.version})` : ""));
console.log(`  runs as   ${actor} → tier ${tier}` + (tier === "local"
  ? "  (DIRECT: the real window.oma, every capability)"
  : `  (SANDBOXED: call_tools ${JSON.stringify(caps.call_tools)}, cross-collection ${caps.cross_collection_read ? "read" : "no reads"}, delete_items "${caps.delete_items}")`));
for (const w of warn) console.log(`  ⚠ ${w}`);

if (existing && !flag("update")) {
  console.error(`\n✗ "${name}" already exists (v${existing.version}, ${existing.ui.length.toLocaleString()} B, by ${existing.author}). ` +
    `Pass --update to replace it, or --name to install alongside it. Its history is kept either way.`);
  store.close();
  process.exit(1);
}
if (DRY) {
  console.log("\n(dry run — nothing written" + (store ? "" : "; no store exists yet, so nothing was read either") + ")");
  store?.close();
  process.exit(0);
}

// ── write ─────────────────────────────────────────────────────────────────────────────────────
const r = store.execute({
  type: "save_app", command_id: randomUUID(), name, ui, manifest,
  description: val("description") || "", actor, host: "install-app",
  ...(existing ? { expected_version: existing.version } : {}),
});

if (!r.ok) {
  if (r.error === "provenance_locked")
    die(`"${name}" is already installed by ${r.author} (tier ${r.tier}) and provenance is not overwritable — ` +
        `an app keeps the trust it was installed with. Delete it first (ask the AI, or use the Data pane) or use --name.`);
  if (r.conflict) die(`"${name}" changed while this ran (now v${r.expected}) — re-run.`);
  die(`${r.error}${r.detail ? " — " + r.detail : ""}`);
}

console.log(`\n✓ installed "${name}" v${r.version}${r.created ? "" : ` (was v${existing.version})`}`);
if (r.note) console.log(`  note: ${r.note}`);
// The dynamic per-app tool (open_<name>) is registered by the running server when IT does the
// save. This door writes underneath a server that may already be up, so say the one thing that
// would otherwise read as "my app did not install": open_app works immediately either way.
console.log(`  open it: ask the AI to open "${name}" (open_app). A server that was already running`);
console.log(`           picks it up on its next restart if you use per-app tools.`);
if (tier !== "local")
  console.log(`  sandboxed: it can read and write its OWN collection through the runner bridge, and nothing else.`);

store.close();
