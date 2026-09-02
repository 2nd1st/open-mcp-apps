// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// assets.mjs — `oma-asset:` references, and what makes an app "built outside this store".
//
// An app written in the chat is one document: the AI holds the whole source and edits it in place.
// An app built by a FRAMEWORK is not — its source is a project on someone's disk and what comes out
// of the bundler is a blob no one reads. Storing that blob as the `ui` slot would make the registry
// hold a compiled artefact and call it source, and every read tool (get_app, edit_app) would then
// be offering to edit machine output.
//
// So a built-outside app stores a READABLE TEMPLATE — a mount point plus references to its own
// bundle — and the bundle itself lives in that app's file plane (one file per asset, the same
// plane file_write/file_read already serve). Two tag forms carry a reference:
//
//     <script type="module" src="oma-asset:app.js"></script>
//     <link rel="stylesheet" href="oma-asset:app.css">
//
// The engine inlines them at SERVE time, in every seam that turns a stored `ui` into a document.
// It has to inline rather than link, twice over: the widget CSP forbids external subresources, and
// a host iframe could not reach this machine's loopback port even if it were allowed to try.
//
// INLINING KEEPS THE TAG THE AUTHOR WROTE — only the fetch attributes go (keptAttrs, below). The
// tag is not a placeholder for its bytes; `type="module"` is a statement about WHEN the bytes run,
// and a bundler's default output is unrunnable without it.
//
// ONE SCANNER, THREE CONSUMERS. "Does this app have references at all" (the built-outside test),
// "is this reference well formed" (the save gate) and "replace it with its bytes" (serve time) are
// the same question asked three ways. They share `scanAssets` on purpose: two parsers over one
// document is the failure this repo keeps writing comments about — the two disagree, and the
// disagreement is invisible until something serves a document nobody validated.
//
// A MISSING ASSET IS LOUD. Silence would mean a blank widget and no sentence anywhere: the
// author's bundle simply never runs, and the only symptom is nothing. So an unresolvable reference
// becomes a visible banner plus a console.error, in the document, at the position the reference
// held. It is a classic <script> rather than a <div> because a stylesheet reference lives in
// <head>, where a stray <div> would implicitly close the head and push every element after it into
// the body — a rendering bug reported in place of the error it was trying to report.

import { FILE_PATH_RE } from "./store.mjs";

// One direction of a two-way import (store.mjs reads `hasAssetReferences` for its save gate).
// Safe because NEITHER module touches the other's binding while it is being evaluated — both uses
// are inside function bodies, so by call time both modules are fully initialised. The alternative
// (a second copy of FILE_PATH_RE here) is the drift the header warns about: a reference this file
// accepted that the file plane could never store would resolve to nothing, forever.

export const ASSET_SCHEME = "oma-asset:";

// `<script …>…</script>` (the inner text of a src-carrying script is ignored by HTML itself, so it
// is dropped with the tag) and `<link …>`. Attributes are read from the captured attribute text
// rather than matched inline, so attribute ORDER never decides whether a reference is seen.
const TAG_RE = /<script\b([^>]*)>[\s\S]*?<\/script\s*>|<link\b([^>]*?)\/?>/gi;
const ATTR_RE = (name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
const SRC_RE = ATTR_RE("src");
const HREF_RE = ATTR_RE("href");
const REL_RE = ATTR_RE("rel");
const attr = (attrs, re) => { const m = re.exec(attrs); return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null; };

/** Every `oma-asset:` reference in a ui document, in source order.
 *
 *  Each entry: {kind: "script"|"style", path, start, end, error}. `error` is a sentence when the
 *  reference is malformed (empty path, traversal, characters the file plane cannot store) and null
 *  otherwise — a malformed reference is still a reference, because an app that MEANT to load a
 *  bundle must not silently read as a hand-written app just because it spelled the path wrong.
 *
 *  Only the two documented tag forms are recognised. The literal text `oma-asset:` anywhere else —
 *  a code sample, a comment, a data attribute — is left exactly as written. */
export function scanAssets(ui) {
  const src = String(ui ?? "");
  const out = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(src)) !== null) {
    const isScript = m[1] !== undefined;
    const attrs = isScript ? m[1] : m[2];
    const raw = attr(attrs, isScript ? SRC_RE : HREF_RE);
    if (raw == null || !raw.startsWith(ASSET_SCHEME)) continue;
    // A <link> that is not a stylesheet is not one of the two forms. An ABSENT rel counts as one:
    // it is the commonest way to write the tag, and refusing to see it would leave the author with
    // a dead reference and no message — the exact silence this module exists to prevent.
    if (!isScript) {
      const rel = attr(attrs, REL_RE);
      if (rel != null && !/\bstylesheet\b/i.test(rel)) continue;
    }
    out.push({ kind: isScript ? "script" : "style", path: raw.slice(ASSET_SCHEME.length),
      // The tag's own attribute text, carried so the inliner can keep what the author wrote
      // (see stripLinkAttrs). Captured HERE because TAG_RE already has it: a second parse at
      // serve time is the two-parsers-one-document failure this module's header warns about.
      attrs, start: m.index, end: m.index + m[0].length, error: pathError(raw.slice(ASSET_SCHEME.length)) });
  }
  return out;
}

/** Why this reference path cannot name a file — or null when it can.
 *  The rule is the file plane's own (store.mjs FILE_PATH_RE + the traversal check the write
 *  command applies), read from there rather than restated: a path this gate accepts must be a path
 *  file_write can actually store, or the reference is unresolvable by construction. */
function pathError(path) {
  if (!path) return "empty path after oma-asset:";
  if (path.includes("..")) return `"${path}" contains ".." — asset paths are logical file names, not filesystem paths`;
  if (!FILE_PATH_RE.test(path)) return `"${path}" is not a valid file-plane path (letters, digits, dot, dash, underscore, slash and space; max 256 chars)`;
  return null;
}

/** Was this app built outside this store? — i.e. is its ui a template rather than the source.
 *  Deliberately structural: the answer comes from the document, not from an `author` string a
 *  caller chooses. An app with no references is an ordinary app whoever installed it. */
export function hasAssetReferences(ui) {
  return scanAssets(ui).length > 0;
}

/** The SAVE gate: syntax only. Returns a sentence, or null.
 *
 *  Existence is deliberately NOT checked here. A push is two writes — the template and its assets —
 *  and neither order may be the wrong one: a gate demanding the file first would forbid
 *  "template, then bundle", and a gate demanding the app first is a rule the file plane does not
 *  have (write_file validates the app NAME, never that the app exists). Existence is answered at
 *  serve time, where the answer can be shown to the person looking at the app. */
export function assetSyntaxError(ui) {
  for (const ref of scanAssets(ui)) if (ref.error) return ref.error;
  return null;
}

// One attribute of a tag: name, and the value when it has one. Used to REBUILD an inlined tag's
// attribute text rather than to find a particular attribute (ATTR_RE above does that) — the value
// forms are HTML's three, and a bare name (`defer`) is an attribute with no value at all.
const ATTR_TOKEN_RE = /([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g;

// The attributes an inlined tag must NOT keep, because every one of them describes HOW TO FETCH
// the thing that is no longer being fetched. EVERYTHING ELSE THE AUTHOR WROTE IS KEPT, and
// `type="module"` is why this function exists: until 2026-08-16 the tag was rebuilt from scratch
// with our two markers and nothing else, so a bundler's `<script type="module" src="oma-asset:…">`
// arrived in the browser as a CLASSIC script. Measured consequences, both fatal and both silent:
// an ESM bundle is a SyntaxError (`Unexpected token 'export'`), and one that happens to parse runs
// at PARSE time — before the deferred runtime module, so `window.oma` is undefined, and before the
// mount point is parsed when the bundler put the tag in <head>. A module keeps both promises for
// free: it is deferred, and deferred scripts run in document order, after the runtime module the
// shell injects at the top of <head>.
//
// `rel` is dropped on the style side alone: it means nothing on `<style>`, and keeping it would be
// a claim about a link that no longer exists. `media` and the rest ride along, because a stylesheet
// that was conditional stays conditional.
function keptAttrs(attrs, kind) {
  const drop = kind === "script"
    ? new Set(["src", "crossorigin", "integrity"])
    : new Set(["href", "rel", "crossorigin", "integrity"]);
  let out = "";
  ATTR_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_TOKEN_RE.exec(String(attrs ?? ""))) !== null)
    if (!drop.has(m[1].toLowerCase())) out += " " + m[0].trim();
  return out;
}

// Escaping, per embedding context. Case-insensitive and on the PREFIX, because `</ScRiPt` closes a
// script element just as `</script>` does — the tag name's case and whatever follows it are not
// what terminates the element. The original spelling is preserved (only a backslash is inserted),
// so the bytes an author shipped inside a string literal survive the trip.
const escapeInScript = (js) => String(js).replace(/<\/(script)/gi, (m, tag) => "<\\/" + tag);
const escapeInStyle = (css) => String(css).replace(/<\/(style)/gi, (m, tag) => "<\\/" + tag);

// The visible failure. One classic <script>: it runs wherever it is parsed (head or body), it
// cannot be deferred out of existence by a module graph that never loads, and it says the same
// thing twice — once to the console for whoever is debugging, once on screen for whoever is
// looking. `data-oma` marks it as ours, the same convention every other injected node follows.
function assetErrorBlock(message) {
  const js = escapeInScript(JSON.stringify(String(message)));
  return `<script data-oma="asset-error">(function(){var m=${js};try{console.error("[oma] "+m)}catch(e){}` +
    `function paint(){var d=document.createElement("div");d.setAttribute("data-oma","asset-error");` +
    `d.style.cssText="margin:8px;padding:12px 14px;border:1px solid var(--color-text-danger,#e5484d);` +
    `border-radius:var(--border-radius-md,10px);color:var(--color-text-danger,#e5484d);` +
    `font:13px/1.5 var(--font-mono,monospace);white-space:pre-wrap";d.textContent="[oma] "+m;` +
    `(document.body||document.documentElement).appendChild(d)}` +
    `if(document.body)paint();else document.addEventListener("DOMContentLoaded",paint)})()</script>`;
}

/** Inline every `oma-asset:` reference in `ui`, returning the document to serve.
 *
 *  `readAsset(path)` returns the file's text, or null when there is no such file; a throw (the
 *  file plane's integrity check is one) is caught and reported in place. A document with no
 *  references comes back BYTE-IDENTICAL — that is what keeps every app written before this
 *  existed exactly as it was, through every seam. */
export async function resolveAssets(ui, readAsset) {
  const src = String(ui ?? "");
  const refs = scanAssets(src);
  if (!refs.length) return src;
  let out = "";
  let at = 0;
  for (const ref of refs) {
    out += src.slice(at, ref.start);
    at = ref.end;
    if (ref.error) { out += assetErrorBlock(`asset reference is malformed — ${ref.error}`); continue; }
    let text = null, thrown = null;
    try { text = await readAsset(ref.path); }
    catch (e) { thrown = (e && e.message) || String(e); }
    if (thrown != null) { out += assetErrorBlock(`asset "${ref.path}" could not be read — ${thrown}`); continue; }
    if (text == null) {
      out += assetErrorBlock(`asset "${ref.path}" is not in this app's files — push it with ` +
        `install-app.mjs --asset ${ref.path} (file_list shows what is stored)`);
      continue;
    }
    // Our two markers go FIRST and the author's attributes after: HTML keeps the first of any
    // duplicated attribute, so a template that also spells `data-oma` cannot overwrite the mark
    // that says these bytes came from the file plane.
    out += ref.kind === "script"
      ? `<script data-oma="asset" data-oma-asset="${ref.path}"${keptAttrs(ref.attrs, "script")}>${escapeInScript(text)}</script>`
      : `<style data-oma="asset" data-oma-asset="${ref.path}"${keptAttrs(ref.attrs, "style")}>${escapeInStyle(text)}</style>`;
  }
  return out + src.slice(at);
}

/** The reader every serve-time seam hands to resolveAssets: this app's file plane, as text.
 *  One definition so the three seams cannot disagree about which app's files a document may reach
 *  (they may only ever reach their OWN — the file plane is keyed (app, path) and this closes over
 *  the app name the seam already resolved). */
export function appAssetReader(fileChannel, app) {
  return async (path) => {
    const got = await fileChannel.get(app, path);
    return got ? got.bytes.toString("utf-8") : null;
  };
}
