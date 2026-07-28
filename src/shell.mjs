// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// shell.mjs — wraps a stored component's HTML with the oma shell at ui:// serve time.
// Injects (1) the bundled shell runtime (window.oma + MCP bridge) and (2) a design-token
// fallback stylesheet, so components can use var(--color-*) etc. and look right on any host.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { kitStyle } from "./runner.mjs";
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
  --color-border-primary: color-mix(in srgb, CanvasText 14%, Canvas);
  --color-border-secondary: color-mix(in srgb, CanvasText 9%, Canvas);
  --color-ring-primary: #3b6cf6; --color-ring-info: #3b6cf6;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-text-sm-size: 12.5px; --font-text-md-size: 14px; --font-heading-sm-size: 18px;
  --border-radius-sm: 7px; --border-radius-md: 10px; --border-radius-lg: 14px; --border-radius-full: 999px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.06), 0 2px 8px rgba(0,0,0,.05);
}
body { font-family: var(--font-sans); color: var(--color-text-primary); }
`;

// The system UI kit — 25 component classes (.k-btn .k-card .k-chip .k-field .k-tab …), all of
// them token-derived. It used to be inlined at SEED time into the three system components via a
// marker, which made it invisible to every OTHER author: measured across four real components
// (three model-written, one hand-written) the `k-` usage was ZERO and the guide never named it,
// while CSS was 32-47% of every component. So the kit is now INJECTED into every rendered
// document — the author gets it for free, and the guide (get_component_guide) teaches it.
//
// It stays in components/ and stays MIT (components/LICENSE names "the design-kit CSS"
// explicitly); this module only READS it, so the licence of the bytes is unchanged.
// Read once at first use, like the runtime bundle above.
let kitCss = null;
export function KIT_CSS() {
  if (kitCss == null) kitCss = readFileSync(join(HERE, "..", "components", "_system.css"), "utf-8");
  return kitCss;
}

// The universal loader: mounts ANY registry component at runtime. This is what makes a
// just-saved component openable IMMEDIATELY via the static open_component tool, without
// waiting for the host to refresh its tool list (Claude Desktop propagates listChanged
// slowly). It fetches the component HTML over the bridge and, for tier "local" (or an old
// engine whose component_html carries no tier), mounts it into this document exactly as
// before. Any OTHER tier is untrusted and runs behind the sandboxed runner — which since
// write-set D is the ONE enforcement piece in src/runner.mjs, reached through oma.embed
// (the loader document carries the bundled runtime, so the machine ships with it; nothing
// is interpolated into this string anymore). Scripts parsed via DOMParser never execute, so
// mount() rebuilds them as fresh <script> nodes.
// NOTE this string lives inside a template literal: no backticks, no ${, and never the
// literal script close tag.
const LOADER_JS = `
function show(msg) { document.body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--color-text-tertiary);font-family:var(--font-sans)">' + msg + "</div>"; }
function mount(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const scripts = [...doc.querySelectorAll("script")].map((s) => ({ type: s.type, text: s.textContent }));
  for (const s of doc.querySelectorAll("script")) s.remove();
  for (const el of doc.querySelectorAll("head style")) document.head.appendChild(el.cloneNode(true));
  document.body.innerHTML = doc.body.innerHTML;
  for (const sp of scripts) {
    const el = document.createElement("script");
    if (sp.type) el.type = sp.type;
    el.textContent = sp.text;
    document.body.appendChild(el);
  }
}

// First paint hangs on this ONE read, and a host can silently drop bridge calls sent in an
// early post-mount window (observed on Claude Desktop 1.24012.9 / Claude Code: the dropped
// request never settles — no reply, no timeout). So each attempt is a FRESH idempotent read
// raced against its own growing window; a dropped attempt is abandoned, never awaited forever.
// A REJECTION inside a window is a real host answer (denied, tool error) and is terminal —
// every window sits under the runtime's own 10s bridge deadline, so a deadline rejection can
// only belong to an attempt already abandoned here (and the settled flag discards it).
function fetchComponentHtml(name) {
  const WINDOWS = [3000, 5000, 7000, 9000];
  return new Promise(function (resolve, reject) {
    let attempt = 0;
    function go() {
      const n = attempt++;
      if (n > 0) show("Loading component… (retry " + n + " of " + (WINDOWS.length - 1) + ")");
      let settled = false;
      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        if (attempt < WINDOWS.length) go();
        else reject(new Error("the host did not answer " + WINDOWS.length + " attempts — close and reopen this widget"));
      }, WINDOWS[n]);
      oma.callTool("component_html", { name }).then(function (r) {
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
  try {
    const name = (oma.toolInput && oma.toolInput.component) || state.component;
    if (!name) return show("No component specified.");
    const r = await fetchComponentHtml(name);
    const sc = (r && r.structuredContent) || {};
    if (!sc.html) return show('Component "' + name + '" not found in the registry.');
    // Tier branch (security-model §2.3): "local" — or a result carrying no tier at all, from
    // an engine predating tiers — mounts same-document (direct mode) exactly as before.
    // Anything else is untrusted and runs behind the sandboxed runner with engine-computed
    // caps, through the runtime's own embed (src/runner.mjs — the single chokepoint).
    if (sc.tier == null || sc.tier === "local") {
      // Identity for the runtime's render-health reporter (auto-revert): on this loader path the
      // runtime module has already evaluated, so the globals are simply read later at error time.
      window.__OMA_COMPONENT__ = name;
      if (sc.version != null) window.__OMA_COMPONENT_VERSION__ = sc.version;
      return mount(sc.html);
    }
    document.body.innerHTML = "";
    await oma.embed(name, {
      into: document.body,
      html: sc.html,
      caps: sc.caps || {},
      tier: sc.tier,
      collection: state.collection || name,
    });
  } catch (e) { show("Failed to load component: " + (e && e.message ? e.message : e)); }
});
`;

// JSON destined for an inline <script> block: escape "<" so a string that came from a URL
// (e.g. /view's ?collection=) can never spell "</script>" or "<!--" and break out of the tag.
// Still valid JSON — JSON.parse and the JS parser both read < as "<".
const scriptJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

// Host design tokens supplied by the EMBEDDER. Components are written against the host's
// token layer (var(--color-text-info, …)); a chat host provides it, but an embedder that
// renders widgets in its own product — the hosted shell, any other integration — has to
// supply one or every component falls back to the neutral defaults above and looks foreign
// inside it.
//
// Deliberately a MAP, not a CSS string. The removed brandCss option took a raw blob and a
// "</style>" inside it broke straight out of the tag; a map lets both halves be validated,
// and anything outside these charsets is a hard error rather than a silent partial write.
// The charsets themselves live in runtime-core (one definition) because the user-writable
// THEME layer is the same class of data arriving through a different door.
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

/** The universal-loader document: the ONE page that knows how to open a component of any tier.
 *
 *  opts.standalone — {endpoint, collection, component, …}: browser-viewer mode, the same shape
 *  wrapComponent takes, and it must be defined BEFORE the runtime module evaluates for the same
 *  reason. Passing it is what lets the local /view route reuse this document instead of keeping a
 *  second copy of the tier branch: a non-local component has no direct-mount path anywhere, so the
 *  route that used to fail closed now serves THIS, and the loader does what it does under a host —
 *  read component_html (over /rpc here), see a non-local tier, hand the source to oma.embed and
 *  let the runner enforce caps. One tier branch, two transports.
 *
 *  The loader carries `component` in `standalone` rather than as its own global: __OMA_COMPONENT__
 *  is the identity of the document's OWN component (render-health reports it), and the loader is
 *  not the component — it mounts one. state.component is where the loader reads the name. */
export function wrapLoader(opts = {}) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
${opts.standalone ? `<script data-oma="standalone">window.__OMA_STANDALONE__=${scriptJson(opts.standalone)}</script>\n` : ""}<style data-oma="tokens">${TOKEN_FALLBACK_CSS}</style>
${kitStyle(KIT_CSS())}
<script type="module" data-oma="runtime">${runtime()}</script>
<script type="module" data-oma="loader">${LOADER_JS}</script>
</head><body><div style="padding:24px;text-align:center;color:var(--color-text-tertiary);font-family:var(--font-sans)">Loading component…</div></body></html>`;
}

/**
 * Wrap component HTML into the final document.
 * opts.standalone — {endpoint, events, collection, component, chrome, viewBase}: browser-viewer
 * mode (no MCP host); the config global must be defined BEFORE the runtime module evaluates.
 * endpoint/events default to "/rpc" and "/events"; an embedding front door (hosted shell)
 * points them at its own same-origin proxy paths. chrome:false renders the BARE widget —
 * no viewer bar, no stage framing — for shells that own the surrounding chrome. viewBase is
 * the base path for component→component links (window.oma.viewBase, default "/view/"); an
 * embedding shell points it at its own mount base. It flows through window.__OMA_STANDALONE__
 * to the runtime as-is — no other engine code change is needed for it to reach oma.viewBase.
 * opts.component — component name, injected as window.__OMA_COMPONENT__ so the runtime knows
 * its identity on the dynamic-tools resource path (the generic loader cannot carry it).
 */
export function wrapComponent(componentHtml, opts = {}) {
  // The early-error buffer is a CLASSIC script and goes FIRST: component classic inline scripts
  // run at parse time BEFORE the (deferred) runtime module, so only a parse-time hook can see
  // their errors. The runtime drains this buffer for the render-health report (auto-revert).
  const inject =
    `<script data-oma="early-errors">window.__OMA_EARLY_ERRORS__=[];(function(b){function p(m){if(b.length<5)b.push(String(m).slice(0,300))}window.addEventListener("error",function(e){p((e&&e.message)||"script error")});window.addEventListener("unhandledrejection",function(e){p((e&&e.reason&&e.reason.message)||e.reason||"unhandled rejection")});})(window.__OMA_EARLY_ERRORS__)</script>\n` +
    (opts.standalone ? `<script data-oma="standalone">window.__OMA_STANDALONE__=${scriptJson(opts.standalone)}</script>\n` : "") +
    (opts.component ? `<script data-oma="component">window.__OMA_COMPONENT__=${scriptJson(opts.component)}</script>\n` : "") +
    (opts.collection ? `<script data-oma="collection">window.__OMA_COLLECTION_HINT__=${scriptJson(opts.collection)}</script>\n` : "") +
    (opts.version != null ? `<script data-oma="component-version">window.__OMA_COMPONENT_VERSION__=${scriptJson(opts.version)}</script>\n` : "") +
    `<style data-oma="tokens">${TOKEN_FALLBACK_CSS}</style>\n` +
    hostTokenStyle(opts.tokens) + // after the fallbacks, so the embedder's values win
    kitStyle(KIT_CSS()) + "\n" + // …and after the tokens, since every kit colour reads one
    `<script type="module" data-oma="runtime">${runtime()}</script>\n`;

  // Put the shell BEFORE the component's own markup/scripts so window.oma exists first
  // (module scripts execute in document order).
  if (/<head[^>]*>/i.test(componentHtml)) {
    return componentHtml.replace(/<head[^>]*>/i, (m) => m + "\n" + inject);
  }
  if (/<html[^>]*>/i.test(componentHtml)) {
    return componentHtml.replace(/<html[^>]*>/i, (m) => m + "\n<head>" + inject + "</head>");
  }
  // Fragment: build a full document around it.
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">${inject}</head><body>${componentHtml}</body></html>`;
}
