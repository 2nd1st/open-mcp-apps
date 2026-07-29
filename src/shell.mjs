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
// THE FAILURE SURFACE THAT DOES NOT DEPEND ON THE RUNTIME.
//
// Everything the loader can say — the retry ladder, "the host did not answer", "not found" —
// lives inside `oma.ready(...)`. That was fine until the premise failed: if the bridge never
// delivers its first state, or window.oma does not exist at all (the module graph failed, the
// runtime threw), the callback is never invoked and NOTHING speaks. The user sits on the static
// "Loading component…" forever — measured on a page refresh in prod and stg, with no retry
// counter, no error, and no component_html call ever reaching the server.
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
// cannot know — and the old sentence, "No component specified.", named none of the channels it had
// checked, which is precisely what anyone diagnosing it needs. There is no cheaper answer available
// to us: the MCP Apps spec has no widget-state persistence, and resourceUri exists only on a TOOL
// or a RESOURCE (McpUiToolMeta / McpUiResourceMeta) — never on a tool RESULT — so one tool cannot
// hand back a per-app document. The only per-instance handle a host can return is
// hostContext.toolInfo, and whether a given host replays it is a MEASUREMENT, not a guess.
// So: check every channel, say which ones were empty, and make the raw record copyable.
// WHICH CALL DID THE HOST BIND THIS RENDER TO — the one signal that says whether waiting can work.
//
// Measured (ChatGPT web, 2026-07-29, from this loader's own dump): a re-render replays the TURN'S
// FIRST tool call verbatim, arguments and tool definition together. A turn that ran get_component
// or data_collections before open_component therefore hands us an envelope addressed to that other
// call — toolInput = {"name":"dev-probe"} with toolInfo.tool = get_component's definition.
// Returns that tool's name only when it is positively NOT one of ours; anything unknown returns
// null, because guessing wrong here would blame the host for our own failure to know.
function boundToolName() {
  try {
    var t = (window.__OMA_HOST_CONTEXT__ || {}).toolInfo;
    var n = t && t.tool && t.tool.name;
    // Every door that opens an app is open_…: the universal opener, and the per-app tools
    // OMA_DYNAMIC_TOOLS registers. Anything else cannot be carrying our name.
    return typeof n === "string" && n && n.indexOf("open_") !== 0 ? n : null;
  } catch (e) { return null; }
}

// WHICH APP AM I — three questions, all answerable now, and then we stop.
//
//   1. did someone just tell us (live toolInput / N11's state.component)?
//   2. did the host replay a note we wrote on a previous mount (__OMA_IDENTITY__)?
//      This is the one that survives a re-render bound to another call.
//   3. neither — so say so, immediately.
//
// There USED to be a fourth step: wait 12s in case the answer was still in flight. It is gone, and
// it was never justified. The premise was a "race" between the host's delivery and oma.ready's 8s
// deadline — but the deadline only fires when NOTHING arrived, because identity arriving is itself
// what triggers the walk that makes ready true. Being released by the deadline therefore already
// means the answer is not coming, and waiting another 12s only bought the user a spinner in front
// of the one screen that explains what happened. Measured, too: every re-render that failed was
// handed another call's envelope verbatim — an envelope that will never name us, no matter how
// long we hold it.
function componentName(state) {
  var live = (oma.toolInput && oma.toolInput.component) || state.component;
  if (live) return live;
  try { return window.__OMA_IDENTITY__() || null; } catch (e) { return null; }
}

function identityChannels() {
  var ch = [];
  var ti = null, st = null, hc = null;
  try { ti = oma.toolInput || null; } catch (e) {}
  try { st = oma.state || null; } catch (e) {}
  try { hc = window.__OMA_HOST_CONTEXT__ || null; } catch (e) {}
  ch.push(["toolInput.component", ti && ti.component ? ti.component : null]);
  ch.push(["state.component", st && st.component ? st.component : null]);
  ch.push(["state.collection", st && st.collection ? st.collection : null]);
  var info = hc && hc.toolInfo;
  ch.push(["hostContext.toolInfo.id", info && info.id != null ? String(info.id) : null]);
  ch.push(["hostContext.toolInfo.tool.name", info && info.tool && info.tool.name ? info.tool.name : null]);
  // The channel that does not depend on the host binding this render to the right call.
  var kept = null;
  try { kept = (window.openai && window.openai.widgetState && window.openai.widgetState.__oma) || null; } catch (e) {}
  ch.push(["openai.widgetState.__oma", kept && kept.component ? kept.component : null]);
  return ch;
}
function lost() {
  var d = { channels: {} };
  var ch = identityChannels();
  for (var i = 0; i < ch.length; i++) d.channels[ch[i][0]] = ch[i][1];
  try { d.toolInput = oma.toolInput || null; } catch (e) { d.toolInput = "READ FAILED: " + e; }
  try {
    var s = oma.state || {};
    d.state = { component: s.component, collection: s.collection, host: s.host, version: s.version, total: s.total, items: (s.items || []).length };
  } catch (e) { d.state = "READ FAILED: " + e; }
  try { d.hostContext = window.__OMA_HOST_CONTEXT__ === undefined ? "undefined (bridge never connected — host sent no context)" : window.__OMA_HOST_CONTEXT__; } catch (e) { d.hostContext = "READ FAILED: " + e; }
  try { d.url = location.href; d.referrer = document.referrer || null; d.frameName = window.name || null; } catch (e) {}
  try { d.hostGlobals = Object.keys(window).filter(function (k) { return /openai|oai|widget|mcp|host|anthropic|claude/i.test(k); }); } catch (e) {}
  // A vendor state channel is the only thing that survives a re-render the host binds to the wrong
  // call, so when one exists we need to see BOTH what it offers and what we managed to keep in it.
  try {
    var oai = window.openai;
    d.openai = oai
      ? { keys: Object.keys(oai), canPersist: typeof oai.setWidgetState === "function", widgetState: oai.widgetState || null }
      : "absent";
  } catch (e) { d.openai = "READ FAILED: " + e; }
  try { localStorage.setItem("__oma_probe", "1"); localStorage.removeItem("__oma_probe"); d.localStorage = "available"; }
  catch (e) { d.localStorage = "blocked: " + (e && e.name); }
  var json;
  try { json = JSON.stringify(d, null, 2); } catch (e) { json = "DUMP FAILED: " + e; }
  try { console.warn("[oma] identity lost — every channel the host could have used:", d); } catch (e) {}

  var found = [];
  for (var j = 0; j < ch.length; j++) found.push(ch[j][0].replace("hostContext.", "") + (ch[j][1] ? " ✓ " + ch[j][1] : " ✗"));

  document.body.innerHTML = "";
  var wrap = document.createElement("div");
  wrap.style.cssText = "padding:20px;font-family:var(--font-sans);color:var(--color-text-secondary);font-size:13px;line-height:1.55";
  var h = document.createElement("p");
  h.style.cssText = "margin:0 0 8px;color:var(--color-text-primary);font-weight:600";
  h.textContent = "This widget lost track of which app it is.";
  var p = document.createElement("p");
  p.style.cssText = "margin:0 0 12px";
  // NAME THE ACTUAL CAUSE WHEN WE KNOW IT. "The host re-rendered without replaying the call" is
  // true but generic; when toolInfo says which call this render WAS bound to, that is the whole
  // diagnosis in one sentence — and it is the sentence that turns a mystery into a host bug
  // someone can report. Measured shape: a turn with several tool calls replays its FIRST one.
  var other = boundToolName();
  p.textContent = other
    ? "The host bound this re-render to a different call — " + other + ", not the one that opened this app — so it never learned which app it is. Ask your assistant to open the app again; your data is untouched."
    : "The host re-rendered it without replaying the call that opened it. Ask your assistant to open the app again — your data is untouched.";
  var sig = document.createElement("p");
  sig.style.cssText = "margin:0 0 12px;font-family:var(--font-mono);font-size:11.5px;color:var(--color-text-tertiary);word-break:break-word";
  sig.textContent = found.join("  ·  ");
  var det = document.createElement("details");
  var sum = document.createElement("summary");
  sum.style.cssText = "cursor:pointer;color:var(--color-text-tertiary);font-size:12px";
  sum.textContent = "What the host handed us";
  var pre = document.createElement("pre");
  pre.style.cssText = "margin:8px 0 0;padding:10px;overflow:auto;max-height:340px;background:var(--color-background-secondary);border-radius:var(--border-radius-sm);font-family:var(--font-mono);font-size:11px;white-space:pre-wrap;word-break:break-word";
  pre.textContent = json;
  var btn = document.createElement("button");
  btn.className = "k-btn";
  btn.style.cssText = "margin-top:8px";
  btn.textContent = "Copy";
  btn.onclick = function () {
    var fallback = function () {
      try {
        var r = document.createRange(); r.selectNodeContents(pre);
        var sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        btn.textContent = "Selected — press Cmd-C";
      } catch (e) { btn.textContent = "Select the text above"; }
    };
    try {
      navigator.clipboard.writeText(json).then(function () { btn.textContent = "Copied"; }, fallback);
    } catch (e) { fallback(); }
  };
  det.appendChild(sum); det.appendChild(pre); det.appendChild(btn);
  wrap.appendChild(h); wrap.appendChild(p); wrap.appendChild(sig); wrap.appendChild(det);
  document.body.appendChild(wrap);
}
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
  // We are alive: from here the ladder below owns the failure surface, so stand the watchdog down.
  try { window.__OMA_LOADER_STARTED__ = true; } catch (e) {}
  try {
    const name = componentName(state);
    if (!name) return lost();
    const r = await fetchComponentHtml(name);
    const sc = (r && r.structuredContent) || {};
    if (!sc.html) return show('Component "' + name + '" not found in the registry.');
    // BIND FROM THE ANSWER WE ALREADY HAVE. This one document serves every app, so it cannot be
    // baked with a binding the way a per-app document is — which left state.collection waiting on a
    // host push that a refresh does not always replay, and every write going out as collection:null.
    // The server computed it and sent it back with the html; do not re-derive it from the name here
    // (a second copy of "what does this app open on" is a second answer waiting to disagree). An
    // older engine sends none, and then we bind nothing rather than guess.
    if (sc.collection) oma.bind(sc.collection);
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
      collection: sc.collection || state.collection || name,
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
<script data-oma="watchdog">${LOADER_WATCHDOG}</script>
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
