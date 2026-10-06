// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// shell.mjs — wraps a stored app's HTML with the oma shell at ui:// serve time.
// Injects (1) the bundled shell runtime (window.oma + MCP bridge) and (2) a design-token
// fallback stylesheet, so apps can use var(--color-*) etc. and look right on any host.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { baseStyle, SELF_HEIGHT_UNPIN_SCRIPT } from "./runner.mjs";
import { TOKEN_NAME_RE, TOKEN_VALUE_RE } from "./runtime-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let runtimeJs = null;
function runtime() {
  if (runtimeJs == null) {
    runtimeJs = readFileSync(join(HERE, "..", "dist", "shell.js"), "utf-8")
      .replace(/<\/script>/gi, "<\\/script>");
  }
  return runtimeJs;
}

// Fallbacks for the host style variables (Claude overwrites these via applyHostStyleVariables).
// Exported for embedding shells (hosted /library preview): the canonical no-host token
// fallbacks — a server composing preview documents has no live computed styles to read.
//
// warning/info and the three shadow steps were added 2026-08-13: apps across the whole store were
// already naming them (RUNTIME.md teaches the accent as `--color-text-info`, and runner.mjs
// forwards all five to embedded children), but no layer here ever defined them, so every one of
// those references fell through to whatever literal the author had written after the comma —
// i.e. exactly the hardcoded colour this token layer exists to prevent. The values are chosen so
// the common fallbacks resolve to the SAME paint they already showed: info equals the ring
// colour every app fell back to, warning equals the `#b98200` apps carry as their literal. Light/dark is
// handled the way the neighbours handle it — system colours and scheme-neutral literals, no
// media query.
export const TOKEN_FALLBACK_CSS = `
:root { color-scheme: light dark; }
:root {
  --color-background-primary: Canvas; --color-background-secondary: color-mix(in srgb, CanvasText 5%, Canvas);
  --color-background-tertiary: color-mix(in srgb, CanvasText 10%, Canvas);
  --color-background-inverse: CanvasText; --color-background-danger: color-mix(in srgb, #e5484d 14%, Canvas);
  --color-background-success: color-mix(in srgb, #2e9e5b 14%, Canvas);
  --color-text-primary: CanvasText; --color-text-secondary: color-mix(in srgb, CanvasText 62%, Canvas);
  --color-text-tertiary: color-mix(in srgb, CanvasText 42%, Canvas);
  --color-text-inverse: Canvas; --color-text-danger: #e5484d; --color-text-success: #2e9e5b;
  --color-text-warning: #b98200; --color-text-info: #3b6cf6;
  --color-border-primary: color-mix(in srgb, CanvasText 14%, Canvas);
  --color-border-secondary: color-mix(in srgb, CanvasText 9%, Canvas);
  --color-ring-primary: #3b6cf6; --color-ring-info: #3b6cf6;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-text-sm-size: 12.5px; --font-text-md-size: 14px; --font-heading-sm-size: 18px;
  --border-radius-sm: 7px; --border-radius-md: 10px; --border-radius-lg: 14px; --border-radius-full: 999px;
  --shadow-xs: 0 1px 2px rgba(0,0,0,.05);
  --shadow-sm: 0 1px 2px rgba(0,0,0,.06), 0 2px 8px rgba(0,0,0,.05);
  --shadow-md: 0 2px 4px rgba(0,0,0,.07), 0 8px 20px rgba(0,0,0,.07);
  --shadow-lg: 0 4px 10px rgba(0,0,0,.08), 0 18px 44px rgba(0,0,0,.09);
}
body { font-family: var(--font-sans); color: var(--color-text-primary); }
`;

// The page BASE — the whole of what the engine adds to an app's document besides the tokens
// above. An app writes its own CSS (or Tailwind, or a library from the allowed CDNs); the engine
// draws nothing and lays nothing out. What is left here is what a page needs before any of that
// to come out right on every host:
//   · box-sizing — the reset every modern stylesheet (Tailwind's preflight included) assumes;
//   · body margin, font and colour from the host tokens, so an unstyled page already reads as
//     part of the host instead of as Times on white;
//   · `[hidden]` that stays hidden — the UA rule has the lowest weight there is, so ANY author
//     rule setting `display` outranks it, and `el.hidden = true` then leaves the element on screen
//     with no error anywhere;
//   · the safe-area variables defined everywhere: the runtime stamps the host's real insets onto
//     <html> (shell-runtime.js stampSafeArea), and a document it does not run in — a sandboxed
//     child, a gallery preview — still resolves var(--oma-safe-*) to 0 instead of to nothing.
// No padding, no width, no frame: those are the app's.
export const BASE_CSS =
  "*{box-sizing:border-box}" +
  ":root{--oma-safe-top:0px;--oma-safe-right:0px;--oma-safe-bottom:0px;--oma-safe-left:0px}" +
  "body{margin:0;font-family:var(--font-sans);font-size:var(--font-text-md-size,14px);color:var(--color-text-primary)}" +
  "[hidden]{display:none!important}";

// The universal loader: mounts ANY registry app at runtime. This is what makes a
// just-saved app openable IMMEDIATELY via the static open_app tool, without
// waiting for the host to refresh its tool list (Claude Desktop propagates listChanged
// slowly). It fetches the app HTML over the bridge and, for tier "local" (or an old
// engine whose get_app_html carries no tier), mounts it into this document exactly as
// before. Any OTHER tier is untrusted and runs behind the sandboxed runner — which since
// write-set D is the ONE enforcement piece in src/runner.mjs, reached through oma.embed
// (the loader document carries the bundled runtime, so the machine ships with it; nothing
// is interpolated into this string anymore). Scripts parsed via DOMParser never execute, so
// mount() rebuilds them as fresh <script> nodes.
// NOTE this string lives inside a template literal: no backticks, no ${, and never the
// literal script close tag.
// THE FAILURE SURFACE THAT DOES NOT DEPEND ON THE RUNTIME.
//
// Everything the loader can say — the retry ladder, "the host did not answer", "not found" —
// lives inside `oma.ready(...)`. That was fine until the premise failed: if the bridge never
// delivers its first state, or window.oma does not exist at all (the module graph failed, the
// runtime threw), the callback is never invoked and NOTHING speaks. The user sits on the static
// "Loading app…" forever — measured on a page refresh in prod and stg, with no retry
// counter, no error, and no get_app_html call ever reaching the server.
//
// So the last line of defence cannot be built on the thing that might be broken:
//   · a CLASSIC script, not type="module" — a module is deferred and dies with the module graph
//   · placed BEFORE the runtime, so it is already armed if the runtime throws on evaluation
//   · it only asks one question — "did the loader ever start?" — and never touches window.oma
//
// 12s, chosen against two measured numbers rather than taste: the runtime's own bridge deadline
// is 10s per call, and oma.ready now releases at 8s. So by 12s a healthy host has long since
// answered, a slow one has already been released, and anything still silent is not coming.
// Once the loader starts it owns the surface: its ladder ends in its own human sentence.
const LOADER_WATCHDOG = `(function(){
  window.__OMA_LOADER_STARTED__ = false;
  setTimeout(function () {
    if (window.__OMA_LOADER_STARTED__) return;
    document.body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--color-text-tertiary);font-family:var(--font-sans)">'
      + "Couldn't reach the app host. Ask your assistant to open this app again."
      + "</div>";
    try { console.warn("[oma] loader never started — window.oma present:", typeof window.oma !== "undefined"); } catch (e) {}
  }, 12000);
})();`;

const LOADER_JS = `
function show(msg) { document.body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--color-text-tertiary);font-family:var(--font-sans)">' + msg + "</div>"; }

// WHAT THE HOST ACTUALLY HANDED US — the failure surface for "this document does not know
// which app it is".
//
// This ONE document serves every app, so its identity can only ever arrive from the host. When a
// host re-renders a cached widget without replaying the call that opened it, the loader genuinely
// cannot know — and the old sentence, "No app specified.", named none of the channels it had
// checked, which is precisely what anyone diagnosing it needs. There is no cheaper answer available
// to us: the MCP Apps spec has no widget-state persistence, and resourceUri exists only on a TOOL
// or a RESOURCE (McpUiToolMeta / McpUiResourceMeta) — never on a tool RESULT — so one tool cannot
// hand back a per-app document. The only per-instance handle a host can return is
// hostContext.toolInfo, and whether a given host replays it is a MEASUREMENT, not a guess.
// So: check every channel, say which ones were empty, and make the raw record copyable.
// WHICH CALL DID THE HOST BIND THIS RENDER TO — the one signal that says whether waiting can work.
//
// Measured (ChatGPT web, 2026-07-29, from this loader's own dump): a re-render replays the TURN'S
// FIRST tool call verbatim, arguments and tool definition together. A turn that ran get_app
// or list_data_collections before open_app therefore hands us an envelope addressed to that other
// call — toolInput = {"name":"dev-probe"} with toolInfo.tool = get_app's definition.
// Returns that tool's name only when it is positively NOT one of ours; anything unknown returns
// null, because guessing wrong here would blame the host for our own failure to know.
function boundToolName() {
  try {
    var t = (window.__OMA_HOST_CONTEXT__ || {}).toolInfo;
    var n = t && t.tool && t.tool.name;
    // Every door that opens an app is open_…: the universal opener, and the per-app tools
    // pinned apps get. Anything else cannot be carrying our name.
    return typeof n === "string" && n && n.indexOf("open_") !== 0 ? n : null;
  } catch (e) { return null; }
}

// WHICH APP AM I — answered by the runtime's __OMA_IDENTITY__:
//
//   1. did someone just tell us (the live tool input / N11's state.app)?
//   2. did the host replay a note we wrote on a previous mount?
//      This is the one that survives a re-render bound to another call.
//   3. neither yet — wait for the input a bounded while (awaitAppName), then say so.
//
// The wait was removed once, on the premise that ready implies identity ("identity arriving is what
// triggers the walk that makes ready true"). Opt-in data broke that premise: this document never
// subscribes, so it is ready when prefs are warm, which can be before the host's input arrives.
// A re-render bound to ANOTHER call still ends in lost(): that envelope never names us, so the
// wait simply runs out.
function appName() {
  try { return window.__OMA_IDENTITY__() || null; } catch (e) { return null; }
}
// Ready is not identity any more (data is opt-in, and this document subscribes to nothing), so a
// name still in flight gets a bounded wait — the same 8s the runtime gives a silent host.
async function awaitAppName() {
  const now = appName();
  if (now || typeof window.__OMA_AWAIT_IDENTITY__ !== "function") return now;
  try { return (await window.__OMA_AWAIT_IDENTITY__(8000)) || null; } catch (e) { return null; }
}

// The identity-loss screen, cut to what changes the OUTCOME (elegance A15, 2026-08-04): once
// live identity and the remembered-note recovery have both come up empty, no amount of host
// forensics changes what happens next — the user reopens the app. What survives of the old
// 93-line evidence console: the one actionable sentence (naming the call the host DID bind,
// when toolInfo says), and a compact console record for anyone diagnosing a host.
function lost() {
  var d = {};
  try { var st = oma.state || {}; d.state = { app: st.app, collection: st.collection }; } catch (e) {}
  try { d.toolName = boundToolName(); } catch (e) {}
  try { console.warn("[oma] identity lost — the host re-rendered without replaying the opening call:", d); } catch (e) {}
  var other = d.toolName;
  document.body.innerHTML = "";
  var wrap = document.createElement("div");
  wrap.style.cssText = "padding:20px;font-family:var(--font-sans);color:var(--color-text-secondary);font-size:13px;line-height:1.55";
  var h = document.createElement("p");
  h.style.cssText = "margin:0 0 8px;color:var(--color-text-primary);font-weight:600";
  h.textContent = "This widget lost track of which app it is.";
  var p = document.createElement("p");
  p.style.cssText = "margin:0";
  p.textContent = other
    ? "The host bound this re-render to a different call — " + other + ", not the one that opened this app — so it never learned which app it is. Ask your assistant to open the app again; your data is untouched."
    : "The host re-rendered it without replaying the call that opened it. Ask your assistant to open the app again — your data is untouched.";
  wrap.appendChild(h); wrap.appendChild(p);
  document.body.appendChild(wrap);
}
// MOUNT = THE APP'S DOCUMENT, AS ITS AUTHOR WROTE IT, INSIDE THIS ONE.
//
// An app may load libraries from the allowed CDNs (React from cdnjs, Tailwind's play script, a
// font stylesheet), so this has to reproduce what a browser does with the app's own document, not
// just its inline code: the title, the head's stylesheets and links, the html/body attributes, and
// every script in DOCUMENT ORDER. Scripts parsed by DOMParser never run, so each is rebuilt; an
// external one is awaited before the next is inserted, because a dynamically inserted script is
// async and the inline code after a <script src=react> expects React to exist when it runs.
// Attributes carry over except data-oma-*, which belong to this runtime (display mode and friends).
function carryAttributes(from, to) {
  for (const a of [...from.attributes]) {
    if (a.name.indexOf("data-oma") === 0) continue;
    if (a.name === "class") { for (const c of from.classList) to.classList.add(c); continue; }
    to.setAttribute(a.name, a.value);
  }
}
function runScript(s) {
  const el = document.createElement("script");
  for (const a of [...s.attributes]) el.setAttribute(a.name, a.value);
  if (!s.src) { el.textContent = s.textContent; document.body.appendChild(el); return Promise.resolve(); }
  return new Promise(function (done) {
    el.onload = el.onerror = function () { done(); };
    document.body.appendChild(el);
  });
}
async function mount(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const scripts = [...doc.querySelectorAll("script")];
  for (const s of scripts) s.remove();
  if (doc.title) document.title = doc.title;
  for (const el of doc.head.querySelectorAll("style, link")) document.head.appendChild(el.cloneNode(true));
  carryAttributes(doc.documentElement, document.documentElement);
  carryAttributes(doc.body, document.body);
  document.body.innerHTML = doc.body.innerHTML;
  for (const s of scripts) await runScript(s);
}

// First paint hangs on this ONE read, and a host can discard, with no reply, bridge calls sent in an
// early post-mount window (observed on Claude Desktop 1.24012.9 / Claude Code: the dropped
// request never settles — no reply, no timeout). So each attempt is a FRESH idempotent read
// raced against its own growing window; a dropped attempt is abandoned, never awaited forever.
// A REJECTION inside a window is a real host answer (denied, tool error) and is terminal —
// every window sits under the runtime's own 10s bridge deadline, so a deadline rejection can
// only belong to an attempt already abandoned here (and the settled flag discards it).
function fetchAppHtml(name) {
  const WINDOWS = [3000, 5000, 7000, 9000];
  return new Promise(function (resolve, reject) {
    let attempt = 0;
    function go() {
      const n = attempt++;
      if (n > 0) show("Loading app… (retry " + n + " of " + (WINDOWS.length - 1) + ")");
      let settled = false;
      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        if (attempt < WINDOWS.length) go();
        else reject(new Error("the host did not answer " + WINDOWS.length + " attempts — close and reopen this widget"));
      }, WINDOWS[n]);
      // \`mount: true\` — this document is the universal loader, and the app it is about to put on
      // screen is a thing only IT knows: the loader ui:// resource is one document for every app,
      // so the resource read that records a per-app render cannot happen here. The claim is made
      // on this call and nowhere else; a refetch of the same source, and the \`@live\` brick reading
      // the app it FRAMES, both leave it unset — they are reads that follow the pointer, and a
      // reader that elected itself would keep the wall pointed at whatever it is already showing.
      oma.callTool("get_app_html", { name: name, mount: true }).then(function (r) {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(r);
      }, function (e) {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(e);
      });
    }
    go();
  });
}

oma.ready(async (state) => {
  // We are alive: from here the ladder below owns the failure surface, so stand the watchdog down.
  try { window.__OMA_LOADER_STARTED__ = true; } catch (e) {}
  try {
    const name = await awaitAppName();
    if (!name) return lost();
    const r = await fetchAppHtml(name);
    const sc = (r && r.structuredContent) || {};
    if (!sc.html) return show('App "' + name + '" not found in the registry.');
    // BIND FROM THE ANSWER WE ALREADY HAVE. This one document serves every app, so it cannot be
    // baked with a binding the way a per-app document is — which left state.collection waiting on a
    // host push that a refresh does not always replay, and every write going out as collection:null.
    // The server computed it and sent it back with the html; do not re-derive it from the name here
    // (a second copy of "what does this app open on" is a second answer waiting to disagree). An
    // older engine sends none, and then we bind nothing rather than guess.
    if (sc.collection) window.__OMA_BIND__(sc.collection);
    // The host label rides this payload now, not the read tools' snapshots — hand it to the
    // runtime the same way the binding is handed over (oma.state.host, RUNTIME.md §3).
    if (sc.host && window.__OMA_HOST__) window.__OMA_HOST__(sc.host);
    // Tier branch (security-model §2.3): "local" — or a result carrying no tier at all, from
    // an engine predating tiers — mounts same-document (direct mode) exactly as before.
    // Anything else is untrusted and runs behind the sandboxed runner with engine-computed
    // caps, through the runtime's own embed (src/runner.mjs — the single chokepoint).
    if (sc.tier == null || sc.tier === "local") {
      // Identity for the runtime's broken-mount notice: on this loader path the runtime module
      // has already evaluated, so the global is simply read later at error time.
      //
      // NOTE, for anyone chasing "my app declared connectDomains and still cannot fetch": a local
      // app mounts HERE, in this document, and this document's network policy is whatever the host
      // set from the LOADER resource's _meta — which serves every app and therefore carries the
      // UNION of every app's declaration (src/tools/apps.mjs, the loader registration; Leo
      // 2026-08-16). So a declared origin is reachable here on hosts that honour that _meta — and
      // a host that cached the loader picks a new declaration up on its next read, not mid-session.
      window.__OMA_APP__ = name;
      return await mount(sc.html);
    }
    document.body.innerHTML = "";
    await oma.embed(name, {
      into: document.body,
      html: sc.html,
      caps: sc.caps || {},
      tier: sc.tier,
      // Handed down with the rest of what this fetch already answered (embed would otherwise
      // re-ask). It sets the CHILD's ceiling; the host's policy on this document is still the
      // outer wall, and a srcdoc frame inherits it.
      csp: sc.csp || null,
      collection: sc.collection || state.collection || name,
    });
  } catch (e) { show("Failed to load app: " + (e && e.message ? e.message : e)); }
});
`;

// ─────────────────────────────────────────────────────────── one scanner for structural tags
/** The first `<name …>` START TAG in a document — the ELEMENT, not the characters.
 *
 *  Whole `<script>` and `<style>` elements are alternatives ahead of the tag itself, so a match
 *  inside script or style TEXT is consumed as part of that element and never returned. That is the
 *  same idiom assets.mjs's TAG_RE already uses. It matters because an app built outside the chat
 *  has its bundle inlined into the template before this runs, and a bundle's string literals
 *  mention tags: React's development build says "<body>" in an error message, and a FRAGMENT
 *  template (the shape RUNTIME.md §6.1 prints) has no <head> of its own — so the first `<head>`
 *  in the raw characters is inside that bundle, and injecting the shell there splits a JS string
 *  (`Invalid or unexpected token`, blank card — measured on a 1.5 MB document).
 *
 *  Not for finding a `<script>` (the alternation would eat it) — for the structural tags only,
 *  which is every use there is: head, html. */
const TAG_SCANNERS = new Map();
export function firstTag(html, name) {
  let re = TAG_SCANNERS.get(name);
  if (!re) {
    re = new RegExp(`<script\\b[^>]*>[\\s\\S]*?<\\/script\\s*>|<style\\b[^>]*>[\\s\\S]*?<\\/style\\s*>|<${name}\\b([^>]*)>`, "gi");
    TAG_SCANNERS.set(name, re);
  }
  const src = String(html ?? "");
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[1] === undefined) continue;            // a script/style element — stepped over
    return { start: m.index, end: m.index + m[0].length, attrs: m[1], tag: m[0] };
  }
  return null;
}

// JSON destined for an inline <script> block: escape "<" so a string that came from a URL
// (e.g. /view's ?collection=) can never spell "</script>" or "<!--" and break out of the tag.
// Still valid JSON — JSON.parse and the JS parser both read < as "<".
const scriptJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

// Host design tokens supplied by the EMBEDDER. Apps are written against the host's
// token layer (var(--color-text-info, …)); a chat host provides it, but an embedder that
// renders widgets in its own product — the hosted shell, any other integration — has to
// supply one or every app falls back to the neutral defaults above and looks foreign
// inside it.
//
// Deliberately a MAP, not a CSS string. The removed brandCss option took a raw blob and a
// "</style>" inside it broke straight out of the tag; a map lets both halves be validated,
// and anything outside these charsets is a hard error rather than a silent partial write.
// The charsets themselves live in runtime-core (one definition) because the user-writable
// THEME layer is the same class of data arriving through a different door.
/** The engine's OWN browser viewer, stamped into a widget document as an absolute base ending in
 *  "/view/". A widget runs in an opaque origin, so the relative default (oma.viewBase → "/view/")
 *  resolves to nowhere and every link built on it is dead — the engine is the only party that
 *  knows the real URL, and this is the door it travels through. Absent when the engine has no
 *  viewer (bare stdio, OMA_VIEWER=0), which is exactly what makes the system badge's
 *  "Open in browser" item not exist rather than not work (D-13 ②). */
function viewBaseScript(viewBase) {
  if (typeof viewBase !== "string" || !/^https?:\/\//.test(viewBase)) return "";
  return `<script data-oma="viewbase">window.__OMA_VIEW_BASE__=${scriptJson(viewBase)}</script>\n`;
}

function hostTokenStyle(tokens) {
  if (tokens == null) return "";
  if (typeof tokens !== "object" || Array.isArray(tokens)) throw new TypeError("tokens must be an object");
  const decls = [];
  for (const [name, raw] of Object.entries(tokens)) {
    const value = String(raw).trim();
    if (!TOKEN_NAME_RE.test(name)) throw new TypeError(`invalid custom-property name: ${JSON.stringify(name)}`);
    if (!TOKEN_VALUE_RE.test(value)) throw new TypeError(`invalid value for ${name}: ${JSON.stringify(value)}`);
    decls.push(`${name}:${value}`);
  }
  return decls.length === 0 ? "" : `<style data-oma="host-tokens">:root{${decls.join(";")}}</style>\n`;
}

/** The universal-loader document: the ONE page that knows how to open an app of any tier.
 *
 *  opts.standalone — {endpoint, collection, app, …}: browser-viewer mode, the same shape
 *  wrapApp takes, and it must be defined BEFORE the runtime module evaluates for the same
 *  reason. Passing it is what lets the local /view route reuse this document instead of keeping a
 *  second copy of the tier branch: a non-local app has no direct-mount path anywhere, so the
 *  route that used to fail closed now serves THIS, and the loader does what it does under a host —
 *  read get_app_html (over /rpc here), see a non-local tier, hand the source to oma.embed and
 *  let the runner enforce caps. One tier branch, two transports.
 *
 *  The loader carries `app` in `standalone` rather than as its own global: __OMA_APP__
 *  is the identity of the document's OWN app (the broken-mount notice names it), and the loader
 *  is not the app — it mounts one. state.app is where the loader reads the name.
 *
 *  ONE app, once. This document briefly also carried a FOLLOW mode (`standalone.live`, the /live
 *  route) that swapped the mounted app whenever the AI opened another; that is an app's job now,
 *  not a route's — `oma.embed("@live")` is the brick, and a wall is an ordinary app that places
 *  it. Which is why the loader is a loader again: it mounts what it was told to mount. */
export function wrapLoader(opts = {}) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
${opts.standalone ? `<script data-oma="standalone">window.__OMA_STANDALONE__=${scriptJson(opts.standalone)}</script>\n` : ""}${viewBaseScript(opts.viewBase)}<style data-oma="tokens">${TOKEN_FALLBACK_CSS}</style>
${baseStyle(BASE_CSS)}
${SELF_HEIGHT_UNPIN_SCRIPT}
<script data-oma="watchdog">${LOADER_WATCHDOG}</script>
<script type="module" data-oma="runtime">${runtime()}</script>
<script type="module" data-oma="loader">${LOADER_JS}</script>
</head><body><div style="padding:24px;text-align:center;color:var(--color-text-tertiary);font-family:var(--font-sans)">Loading app…</div></body></html>`;
}

/**
 * Wrap app HTML into the final document.
 * opts.standalone — {endpoint, events, collection, app, chrome, viewBase}: browser-viewer
 * mode (no MCP host); the config global must be defined BEFORE the runtime module evaluates.
 * endpoint/events default to "/rpc" and "/events"; an embedding front door (hosted shell)
 * points them at its own same-origin proxy paths. chrome:false renders the BARE widget —
 * no viewer bar, no page framing — for shells that own the surrounding chrome. viewBase is
 * the base path for app→app links (window.oma.viewBase, default "/view/"); an
 * embedding shell points it at its own mount base. It flows through window.__OMA_STANDALONE__
 * to the runtime as-is — no other engine code change is needed for it to reach oma.viewBase.
 * opts.viewBase — the ENGINE's own viewer base (absolute, ".../view/"), for a document that has
 * no standalone config at all: a widget inside a chat host. Same destination (oma.viewBase),
 * different door; see viewBaseScript.
 * opts.app — app name, injected as window.__OMA_APP__ so the runtime knows
 * its identity on the dynamic-tools resource path (the generic loader cannot carry it).
 */
export function wrapApp(appHtml, opts = {}) {
  // The early-error buffer is a CLASSIC script and goes FIRST: app classic inline scripts
  // run at parse time BEFORE the (deferred) runtime module, so only a parse-time hook can see
  // their errors. The runtime drains this buffer for the broken-mount notice.
  const inject =
    `<script data-oma="early-errors">window.__OMA_EARLY_ERRORS__=[];(function(b){function p(m){if(b.length<5)b.push(String(m).slice(0,300))}window.addEventListener("error",function(e){p((e&&e.message)||"script error")});window.addEventListener("unhandledrejection",function(e){p((e&&e.reason&&e.reason.message)||e.reason||"unhandled rejection")});})(window.__OMA_EARLY_ERRORS__)</script>\n` +
    (opts.standalone ? `<script data-oma="standalone">window.__OMA_STANDALONE__=${scriptJson(opts.standalone)}</script>\n` : "") +
    viewBaseScript(opts.viewBase) +
    (opts.app ? `<script data-oma="app">window.__OMA_APP__=${scriptJson(opts.app)}</script>\n` : "") +
    (opts.collection ? `<script data-oma="collection">window.__OMA_COLLECTION_HINT__=${scriptJson(opts.collection)}</script>\n` : "") +
    `<style data-oma="tokens">${TOKEN_FALLBACK_CSS}</style>\n` +
    hostTokenStyle(opts.tokens) + // after the fallbacks, so the embedder's values win
    baseStyle(BASE_CSS) + "\n" + // …and after the tokens, since the base reads them
    // The same height unpin the loader and the runner's children carry: this document is the OTHER
    // top-level widget document (the per-app ui:// resource a pinned app's opener points at), and a host
    // sizes its frame from what its own shim measures here — so an app that pins html/body would
    // be measured at the frame height it already has and could never be seen to grow. It no-ops
    // when nothing is embedding us (the /view case this same function also serves) and when the
    // embedder is a shell that owns the frame — see SELF_HEIGHT_UNPIN_SOURCE.
    SELF_HEIGHT_UNPIN_SCRIPT + "\n" +
    `<script type="module" data-oma="runtime">${runtime()}</script>\n`;

  // Put the shell BEFORE the app's own markup/scripts so window.oma exists first
  // (module scripts execute in document order).
  //
  // firstTag, not a bare regex, and for the reason written above it: by here the app's assets are
  // already INLINED, so "the first <head>" over raw characters can be a string inside a bundle.
  // Measured on the §6.1 fragment shape + React's dev build — the whole shell went into the middle
  // of a JS string literal and the app never parsed.
  const src = String(appHtml ?? "");
  const head = firstTag(src, "head");
  if (head) return src.slice(0, head.end) + "\n" + inject + src.slice(head.end);
  const htmlTag = firstTag(src, "html");
  if (htmlTag) return src.slice(0, htmlTag.end) + "\n<head>" + inject + "</head>" + src.slice(htmlTag.end);
  // Fragment: build a full document around it.
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">${inject}</head><body>${src}</body></html>`;
}
