// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// install-app.mjs — install an app you wrote YOURSELF into this registry, from a file.
//
//   node install-app.mjs ./my-app.html                 install (name = the file's basename)
//   node install-app.mjs ./my-app.html --name tracker  choose the registry name
//   node install-app.mjs ./my-app.html --description "…"   the one line the AI's app index shows
//   node install-app.mjs ./my-app.html --update        overwrite an app of the same name
//   node install-app.mjs ./my-app.html --sandboxed     install as UNTRUSTED (runs behind the runner)
//   node install-app.mjs ./ui.html --manifest ./manifest.json    declaration as its own file
//   node install-app.mjs ./ui.html --asset ./dist/app.js --asset ./dist/app.css   push the bundle
//   node install-app.mjs ./ui.html --asset … --prune-assets   …and drop the files this build left behind
//   node install-app.mjs --list                        what is installed, and under whose provenance
//   node install-app.mjs ./my-app.html --dry-run       validate only — write nothing
//   (--db <path> targets a specific store; OMA_DB does the same. Default: the shared per-user store.)
//
// WHY THIS EXISTS. Every other way into this registry goes through the AI: it writes the html and
// save_app stores it. That is the right default — but it makes the AI's context window the
// upper bound on what an app can BE. An app you build in your own editor, with your own bundler,
// against your own libraries, has no such ceiling. The trade you accept by using this door is that
// the AI can no longer iterate on it: your file is the source of truth, you rebuild and re-install.
// (It still shares your data — an installed app is an app.)
//
// TWO SHAPES COME THROUGH THIS DOOR.
//
//   1. ONE SELF-CONTAINED DOCUMENT — everything inlined. The AI reads it with get_app like any
//      other app, and this door is simply the way a file on your disk becomes one.
//   2. A TEMPLATE PLUS A BUNDLE — for anything a framework built. The html you push is a readable
//      mount point that references its own build output (`<script type="module"
//      src="oma-asset:app.js">`, `<link rel="stylesheet" href="oma-asset:app.css">` — the engine
//      keeps the tag you wrote and drops only the fetch attributes, so `type="module"` is what
//      puts your bundle after the runtime and after your mount point); `--asset` pushes those
//      files into this app's file plane, and the engine inlines them every time it serves it.
//      The AI reads the TEMPLATE; the bundle is yours. Because the source of a compiled bundle is
//      not in this store, the engine makes that literal: an app with asset references refuses
//      edit_app and refuses the AI's save_app — re-running this command IS the edit.
//
// `--prune-assets` IS OPT-IN, AND THAT IS THE DESIGN. A file plane is keyed (app, path), so a
// build that renames its output — every content-hashed bundler by default — leaves the previous
// build's file behind forever: nothing references it, nothing serves it, nothing collects it, and
// it is a full bundle per build (measured: two pushes of one app, 30,914 B stored, both files
// still listed). The flag deletes the files of THIS app that this push neither carried nor
// referenced. It is not the default because the plane is not only the bundler's: an app may hold
// images, exports, anything the AI wrote there with file_write, and a build step that swept those
// away would be destroying data it never owned. Say the word and it prunes; stay silent and it
// keeps. --dry-run prints the list either way.
//
// Either shape: no size cap, no network requests. The engine injects the kit CSS, the host's
// design tokens and `window.oma`, and renders it in a sandboxed iframe. Declarations (collection,
// settings, kind, functions) are the separate manifest slot — pass `--manifest ./manifest.json`,
// or leave a legacy in-document `#oma-manifest` block to be extracted and stripped on install.
// A bundler will EAT a function body it does not know is code, so `<script type="text/oma-function"
// data-fn="…">` blocks must be emitted into the template, not bundled. The full contract:
// `node -e 'import("./src/guide.mjs").then(m => console.log(m.GUIDE))'`, RUNTIME.md §6.1, or ask
// the AI for get_app_guide.
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
import { openStore, FILE_PATH_RE } from "./src/store.mjs";
import { openFileChannel } from "./src/files.mjs";
import { tierOf, TIER_CAPS, RESERVED_APP_NAMES, LOCKED_APPS } from "./src/contracts.mjs";
import { readDeclaration, stripDeclarationBlock } from "./src/manifest-block.mjs";
import { OMA_REFERENCE_RE } from "./src/tools/apps.mjs";
import { scanAssets } from "./src/assets.mjs";

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
// …and the plural of val(), for the one option a build genuinely repeats: a bundle is several
// files, and `--asset a.js --asset a.css` has to collect both rather than answer with the first.
const vals = (n) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith(`--${n}=`)) out.push(argv[i].slice(n.length + 3));
    else if (argv[i] === "--" + n && argv[i + 1] && !argv[i + 1].startsWith("--")) out.push(argv[++i]);
  }
  return out;
};
const die = (msg) => { console.error("✗ " + msg); process.exit(1); };
// Every "N B" this door prints is a count of BYTES, so it is measured in bytes. A JS string
// `.length` is UTF-16 code units, which agrees with the byte count only for pure ASCII — and an
// app is a document with a person's prose in it. Measured on a 185-byte fixture with Chinese and
// emoji in the body: `html.length` said 153. The number is the one thing this line exists to
// say, and the shortfall grows with exactly the content that makes a document worth looking at.
// The asset lines never had this: `--asset` bytes are read as a Buffer, whose `.length` IS bytes.
const bytes = (s) => Buffer.byteLength(s, "utf8").toLocaleString();

// Options that consume the NEXT argument. Named once, because the html file is found by "the
// argument that is not a flag and not a flag's value" — a list that goes stale silently turns an
// option's value into the document being installed.
const VALUE_FLAGS = new Set(["name", "description", "db", "manifest", "asset"]);
const KNOWN = new Set(["list", "update", "sandboxed", "dry-run", "help", "prune-assets", ...VALUE_FLAGS]);
for (const a of argv) {
  if (!a.startsWith("--")) continue;
  const k = a.slice(2).split("=")[0];
  if (!KNOWN.has(k)) die(`unknown option --${k}. Run with --help.`);
}
if (flag("help") || (!argv.length)) {
  // The help text is this file's HEADER — the contiguous comment block at the top, minus the two
  // licence lines. It used to be "every line in the file that starts with //", which is a filter,
  // not a boundary: 25 lines of internal commentary about argv parsing and the read-only store
  // door were printed to anyone who typed --help, under the same margin as the usage. A block that
  // ENDS at the first line of code cannot drift that way, however the body is commented.
  const head = [];
  for (const l of readFileSync(new URL(import.meta.url), "utf-8").split("\n")) {
    if (!l.startsWith("//")) break;
    head.push(l);
  }
  console.log(head.slice(2).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
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
// The document is the first bare argument that is not some option's value. The predecessor is
// found by POSITION, not by indexOf: indexOf answers for the first occurrence of a string, so two
// identical arguments (`--asset app.js --name app.js`) made this ask about the wrong one.
const file = argv.find((a, i) => !a.startsWith("--")
  && !(i > 0 && argv[i - 1].startsWith("--") && VALUE_FLAGS.has(argv[i - 1].slice(2))));
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
// No size gate here any more, deliberately: this door exists FOR the bundle the chat cannot write,
// so a ceiling at this door contradicted the door. The store has none either (v0.6.0).

// Warnings, never refusals: this door's job is to install what you wrote, and a document that
// happens not to call the API is still a document. But both of these are silent failures at
// RUNTIME — a missing declaration means no collection binding, and no oma reference means the app
// can never see its data — so they are worth one line each before the write, not after.
const warn = [];
// Asset references decide what this document IS, so they are read before anything judges it.
// A malformed one DIES rather than warns: the store refuses it anyway (bad_asset_ref), and a
// reference the file plane can never satisfy is a typo, not a choice.
const refs = scanAssets(html);
for (const r of refs) if (r.error) die(`bad oma-asset reference — ${r.error}.`);
// …and the oma-reference warning does not apply to a template: the calls live in the bundle, which
// is a file this document points AT. Firing it there would be a linter crying wolf at the one
// shape this door was extended for.
if (!OMA_REFERENCE_RE.test(html) && !refs.length)
  warn.push("this document never references `window.oma`, so it cannot read or write any data. If that is intended, it is a static page, not an app.");
// v6 (W-N): the declaration is a separate slot, not an in-document block. This door is the one
// HUMAN ingress, so a legacy block is EXTRACTED here as a convenience — parsed, lifted into the
// manifest slot, stripped from the document — instead of the loud refusal the tool face gives a
// model (a human re-running a CLI is cheaper than a human editing bytes out of a file).
const decl = readDeclaration(html);
if (decl.state === "bad")
  die(`the #oma-manifest block could not be read (${decl.error}${decl.detail ? ": " + decl.detail : ""}) — fix it (or delete it and re-run).`);
// --manifest is the shape a build pipeline has: the declaration is a file it emits beside the
// html, not something it has to splice into markup. It WINS over a legacy in-document block —
// stated out loud, because two declarations arriving at one save is exactly the situation where
// silently picking one is the worst answer. The block is stripped either way; the store refuses a
// document that still carries one.
const manifestFile = val("manifest");
let manifest = decl.state === "present" ? decl.value : null;
if (manifestFile) {
  const mp = resolve(manifestFile);
  if (!existsSync(mp) || !statSync(mp).isFile()) die(`no such manifest file: ${mp}`);
  let parsed;
  try { parsed = JSON.parse(readFileSync(mp, "utf-8")); }
  catch (e) { die(`${mp} is not valid JSON: ${e.message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    die(`${mp} must contain a JSON OBJECT (the declaration: kind, collections, settings, functions…).`);
  if (decl.state === "present")
    warn.push("--manifest and an in-document #oma-manifest block are both present — the FILE wins; the block is stripped from the document either way.");
  manifest = parsed;
}
const ui = decl.state === "present" || decl.state === "empty" ? stripDeclarationBlock(html).html : html;
if (decl.state === "present" && !manifestFile)
  warn.push("legacy #oma-manifest block found — extracted into the manifest slot and stripped from the document (v6 stores them separately).");
else if (decl.state === "absent" && !manifestFile)
  warn.push("no declaration: the app will bind to a collection named after itself and declare no fields. Ship a manifest to name your collection.");

// --asset: the files the template points at. The plane path is the file's BASENAME, because that
// is what the reference in the template spells — the build's directory layout is the build's
// business and stops at this door. Everything is read and validated BEFORE any write, so a typo in
// the third asset does not leave the first two half-pushed.
const MIME_BY_EXT = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".woff2": "font/woff2", ".woff": "font/woff", ".html": "text/html", ".txt": "text/plain" };
const assets = vals("asset").map((a) => {
  const p = resolve(a);
  if (!existsSync(p) || !statSync(p).isFile()) die(`no such asset file: ${p}`);
  const planePath = basename(p);
  if (planePath.includes("..") || !FILE_PATH_RE.test(planePath))
    die(`"${planePath}" cannot be a file-plane path (letters, digits, dot, dash, underscore, slash and space; max 256 chars) — rename the file.`);
  return { src: p, path: planePath, bytes: readFileSync(p), mime: MIME_BY_EXT[extname(p).toLowerCase()] || "application/octet-stream" };
});
{
  const seen = new Set();
  for (const a of assets) {
    if (seen.has(a.path)) die(`two --asset files are both called "${a.path}" — the file plane keys on that name, so one would silently replace the other.`);
    seen.add(a.path);
  }
}

const actor = flag("sandboxed") ? "guest" : "human";
const tier = tierOf(actor);
const caps = TIER_CAPS[tier];
const existing = store ? store.getApp(name) : null;   // null store = dry run with no store yet

// A reference with nothing behind it renders a visible error block instead of the app. It is not
// fatal here — the two writes may legitimately arrive in either order, and the missing file can be
// pushed next — but this door is where a person can still fix it in one keystroke, so it is said.
{
  const pushing = new Set(assets.map((a) => a.path));
  for (const r of refs)
    if (!pushing.has(r.path) && !(store && store.statFile(name, r.path)))
      warn.push(`the template references "${r.path}" and nothing is pushing it — until it is stored the app renders a visible error block in its place (add --asset <path to ${r.path}>).`);
}
// Clearing a declaration by omission is the store's rule for this slot and it is unchanged; what
// is new is how easy it now is to hit, since a manifest that used to live inside the document now
// lives in a file that can simply be left off the command line.
if (existing && existing.manifest && manifest === null)
  warn.push(`"${name}" currently HAS a declaration and this push carries none, which CLEARS it. Pass --manifest ./manifest.json to keep it.`);

console.log(`  file      ${path}`);
console.log(`  name      ${name}`);
console.log(`  size      ${bytes(html)} B` + (existing ? `  (replacing ${bytes(existing.ui)} B at v${existing.version})` : ""));
if (manifestFile) console.log(`  manifest  ${resolve(manifestFile)}`);
for (const a of assets) console.log(`  asset     ${a.path}  ← ${a.src}  (${a.bytes.length.toLocaleString()} B, ${a.mime})`);
if (refs.length) console.log(`  shape     TEMPLATE + BUNDLE — ${refs.length} asset reference(s); the AI reads this template, not the bundle, and cannot edit either`);
console.log(`  runs as   ${actor} → tier ${tier}` + (tier === "local"
  ? "  (DIRECT: the real window.oma, every capability)"
  : `  (SANDBOXED: call_tools ${JSON.stringify(caps.call_tools)}, cross-collection ${caps.cross_collection_read ? "read" : "no reads"}, delete_items "${caps.delete_items}")`));
for (const w of warn) console.log(`  ⚠ ${w}`);

// What --prune-assets would remove, worked out BEFORE anything is written so --dry-run can say it.
// Kept and re-derived rather than computed once at delete time: the answer must be the same
// sentence a dry run printed, or the flag is a promise the real run does not keep.
const pruneCandidates = (flag("prune-assets") && store)
  ? (() => {
      const keep = new Set([...assets.map((a) => a.path), ...refs.map((r) => r.path)]);
      return (openFileChannel(store).list(name).files || []).filter((f) => !keep.has(f.path));
    })()
  : [];
if (flag("prune-assets")) {
  if (!store || !existing) console.log("  prune     nothing stored for this app yet — nothing to prune");
  else if (!pruneCandidates.length) console.log("  prune     no orphans — every stored file is pushed or referenced");
  else console.log(`  prune     ${pruneCandidates.length} file(s) neither pushed nor referenced: ` +
    pruneCandidates.map((f) => `${f.path} (${f.size.toLocaleString()} B)`).join(", "));
}

if (existing && !flag("update")) {
  console.error(`\n✗ "${name}" already exists (v${existing.version}, ${bytes(existing.ui)} B, by ${existing.author}). ` +
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
// ASSETS FIRST, then the app row. Two planes cannot be written in one transaction (file bytes live
// beside the database, not in it), so one of the two orders has to be chosen and said:
//   · installing a NEW app, the row does not exist yet — nothing can be served mid-flight at all;
//   · UPDATING one, the bundle lands first and a single transaction then swaps the template onto it.
// The file plane never asks whether the app exists (write_file validates the app NAME and nothing
// else), which is what makes this order legal at all.
if (assets.length) {
  const channel = openFileChannel(store);
  for (const a of assets) {
    const fr = await channel.put(name, a.path, a.bytes, { mime: a.mime, command_id: randomUUID() });
    if (!fr.ok) die(`could not store asset "${a.path}": ${fr.error || (fr.conflict ? "version conflict" : "unknown")}. ` +
      `The app itself was NOT written — re-run when the file plane has room.`);
    console.log(`  ✓ asset "${a.path}" v${fr.meta.version} (${fr.meta.size.toLocaleString()} B)`);
  }
}

const r = store.execute({
  type: "save_app", command_id: randomUUID(), name, ui, manifest,
  description: val("description") || "", actor, host: "install-app",
  ...(existing ? { expected_version: existing.version } : {}),
});

if (!r.ok) {
  if (r.error === "provenance_locked")
    die(`"${name}" is already installed by ${r.author} (tier ${r.tier}) and provenance is not overwritable — ` +
        `an app keeps the trust it was installed with. Delete it first (ask the AI, or use the Data pane) or use --name.`);
  // Reached only if a template is spelled wrong in a way scanAssets called fatal above; kept
  // because the store is the authority and this door must not translate its refusals into a
  // stack-trace-shaped `undefined`.
  if (r.error === "bad_asset_ref") die(`bad oma-asset reference — ${r.detail}.`);
  if (r.conflict) die(`"${name}" changed while this ran (now v${r.expected}) — re-run.`
    + (assets.length ? ` Its ${assets.length} asset(s) WERE stored; re-running is safe (same names, same bytes).` : ""));
  die(`${r.error}${r.detail ? " — " + r.detail : ""}`);
}

// ── prune ─────────────────────────────────────────────────────────────────────────────────────
// AFTER the save, never before: a template that failed to land is a template whose references are
// still the old ones, and deleting against a build that did not ship would break the app that is
// actually installed. By here the new template IS the app, so "not referenced" is finally true.
//
// The delete travels the ORDINARY door (store delete_file), not the privileged one, which means it
// meets the same confirmation gate a widget's delete meets — `actor: "human"` with confirm_delete
// on. Answering our own demand is not a way around the gate, it is what the gate is for: the
// user typed --prune-assets, having just been shown the list above, which is precisely the "the
// user saw this and said yes" the request_state encodes. Going privileged instead would have made
// this the one file delete in the system with no confirmation record behind it.
if (flag("prune-assets") && pruneCandidates.length) {
  const channel = openFileChannel(store);
  for (const f of pruneCandidates) {
    let d = await channel.del(name, f.path, { actor: "human", command_id: randomUUID() });
    if (d && d.confirmation_required)
      d = await channel.del(name, f.path,
        { actor: "human", command_id: randomUUID(), request_state: d.request_state });
    if (d && d.ok) console.log(`  ✓ pruned "${f.path}" (${f.size.toLocaleString()} B)`);
    // A failed prune is a WARNING, not a death: the app and its bundle are already installed and
    // correct, and a leftover file costs disk, not correctness.
    else console.log(`  ⚠ could not prune "${f.path}": ${(d && (d.error || d.reason)) || "unknown"} — it is still stored`);
  }
}

console.log(`\n✓ installed "${name}" v${r.version}${r.created ? "" : ` (was v${existing.version})`}`);
if (r.note) console.log(`  note: ${r.note}`);
// The dynamic per-app tool (open_<name>) is registered by the running server when IT does the
// save. This door writes underneath a server that may already be up, so say the one thing that
// would otherwise read as "my app did not install": open_app works immediately either way.
console.log(`  open it: ask the AI to open "${name}" (open_app). A server that was already running`);
console.log(`           picks it up on its next restart if you use per-app tools.`);
if (refs.length)
  console.log(`  built outside: the AI can READ this template and cannot edit it — edit_app and its save_app\n` +
    `           both refuse. Re-run this command with --update to ship a new build.`);
if (tier !== "local")
  console.log(`  sandboxed: it can read and write its OWN collection through the runner bridge, and nothing else.`);

store.close();
