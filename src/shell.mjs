// shell.mjs — wraps a stored component's HTML with the oma shell at ui:// serve time.
// Injects (1) the bundled shell runtime (window.oma + MCP bridge) and (2) a design-token
// fallback stylesheet, so components can use var(--color-*) etc. and look right on any host.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
const TOKEN_FALLBACK_CSS = `
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

// The universal loader: mounts ANY registry component at runtime. This is what makes a
// just-saved component openable IMMEDIATELY via the static open_component tool, without
// waiting for the host to refresh its tool list (Claude Desktop propagates listChanged
// slowly). It fetches the component HTML over the bridge and, for tier "local" (or an old
// engine whose component_html carries no tier), mounts it into this document exactly as
// before. Any OTHER tier is untrusted and gets runner-wrapped instead (security-model §2.3):
// the component runs one level down in a sandbox="allow-scripts" srcdoc iframe while THIS
// document — first-party, holding the real window.oma — enforces the engine-computed caps at
// the postMessage chokepoint. Scripts parsed via DOMParser never execute, so mount() rebuilds
// them as fresh <script> nodes.
// NOTE this string lives inside a template literal: write \\n for a loader-source "\n",
// \\" for a loader-source escaped quote, and never the literal script close tag.
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

// ---- runner mode (every non-"local" tier; security-model §2.3 + §5 v0.2) ----
// CSP goes FIRST in the child head: no network at all (connect-src 'none', no remote
// script/img/font sources) — closes exfiltration on every host, incl. the browser viewer.
const RUNNER_CSP = "<meta http-equiv=\\"Content-Security-Policy\\" content=\\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'\\">";

// Control-plane denylist (security-model §4.2b): tools NO runner child may EVER reach via
// callTool — any tier, allowlisted, wildcarded, whatever. Policy, component save/delete, and
// (future) library_* installs belong to the first-party shell alone; a rendered/previewed
// child must never rewrite policy or overwrite/delete components. Any future library_* tool
// is covered by the prefix rule at the callTool chokepoint. settings.html and the tests
// mirror this list conceptually — keep them in sync.
const CONTROL_PLANE_DENY = ["security_set", "save_component", "delete_component", "library_install"];

// The child is a separate document, so host-injected design tokens don't reach it. Read the
// COMPUTED values from this document's root and re-emit them as :root CSS for the child
// (the proven settings.html tokenCSS pattern).
const TOKEN_NAMES = [
  ...["background", "text", "border"].flatMap((k) => ["primary", "secondary", "tertiary", "inverse", "ghost", "info", "danger", "success", "warning", "disabled"].map((v) => "--color-" + k + "-" + v)),
  ...["primary", "secondary", "inverse", "info", "danger", "success", "warning"].map((v) => "--color-ring-" + v),
  "--font-sans", "--font-mono", "--font-weight-normal", "--font-weight-medium", "--font-weight-semibold", "--font-weight-bold",
  ...["xs", "sm", "md", "lg"].flatMap((s) => ["--font-text-" + s + "-size", "--font-text-" + s + "-line-height"]),
  ...["xs", "sm", "md", "lg", "xl", "2xl", "3xl"].flatMap((s) => ["--font-heading-" + s + "-size", "--font-heading-" + s + "-line-height"]),
  ...["xs", "sm", "md", "lg", "xl", "full"].map((s) => "--border-radius-" + s),
  "--border-width-regular", "--shadow-hairline", "--shadow-sm", "--shadow-md", "--shadow-lg",
];
function tokenCSS() {
  const cs = getComputedStyle(document.documentElement);
  let vars = "";
  for (const n of TOKEN_NAMES) { const v = cs.getPropertyValue(n).trim(); if (v) vars += n + ":" + v + ";"; }
  return '<style data-oma="tokens">:root{' + vars + "}html{color-scheme:" + (cs.colorScheme || "light dark") + '}body{font-family:var(--font-sans);color:var(--color-text-primary)}</style>';
}

// Mini-bridge injected into the sandboxed child: exposes the window.oma surface and proxies
// every call to this document over postMessage (message keys omaRun*, distinct from the
// settings preview's omaPv*). coercePref mirrors src/shell-runtime.js — the runtime's copy is
// bundled out of reach of this static string; keep the two in sync.
const BRIDGE = [
  '<script>(function(){',
  'var S={collection:null,items:[],version:0,component:null,host:null},TI={};',
  'var readyCbs=[],changeCbs=[],prefCbs=[],isReady=false,seq=0,pending={},P=null;',
  'function coercePref(v,f){var t=typeof f;',
  'if(t==="boolean"){if(v===true||v==="true"||v===1)return true;if(v===false||v==="false"||v===0)return false;return f;}',
  'if(t==="number"){if(typeof v==="number"&&Number.isFinite(v))return v;if(typeof v==="string"&&v.trim()!==""&&Number.isFinite(Number(v)))return Number(v);if(typeof v==="boolean")return v?1:0;return f;}',
  'if(t==="string"){if(typeof v==="string")return v;if(typeof v==="number"||typeof v==="boolean")return String(v);return f;}',
  'return v===undefined?f:v;}',
  'function firePref(k,v,o,s){prefCbs.forEach(function(cb){try{cb({key:k,value:v,oldValue:o,scope:s})}catch(e){}})}',
  'function req(m,a){return new Promise(function(res,rej){var id=++seq;pending[id]=[res,rej];parent.postMessage({omaRun:true,id:id,method:m,args:a},"*");})}',
  'window.addEventListener("message",function(ev){var d=ev.data||{};',
  'if(d.omaRunResult&&pending[d.id]){var p=pending[d.id];delete pending[d.id];d.error?p[1](new Error(d.error)):p[0](d.result);}',
  'if(d.omaRunSnapshot&&d.snapshot){',
  'if(d.toolInput)TI=d.toolInput;',
  'var pc=false;',
  'if(d.prefs&&typeof d.prefs==="object"){var CK=d.compKeys||{};',
  'if(P===null){P=d.prefs;}',
  'else{var old=P;P=d.prefs;var k;',
  'for(k in P)if(!(k in old)||old[k]!==P[k]){firePref(k,P[k],old[k],CK[k]?"component":"global");pc=true;}',
  'for(k in old)if(!(k in P)){firePref(k,undefined,old[k],"global");pc=true;}}}',
  'var ch=d.snapshot.version!==S.version||pc;S=Object.assign(S,d.snapshot);',
  'if(!isReady){isReady=true;readyCbs.splice(0).forEach(function(cb){try{cb(S)}catch(e){}});}',
  'else if(ch){changeCbs.forEach(function(cb){try{cb(S)}catch(e){}});}}',
  '});',
  'window.oma={ get state(){return S}, ready:function(cb){isReady?cb(S):readyCbs.push(cb)}, onChange:function(cb){changeCbs.push(cb)},',
  'addItem:function(o){return req("addItem",o||{})}, updateItem:function(id,f){return req("updateItem",{id:id,fields:f})},',
  'moveItem:function(id,g,p){return req("moveItem",{id:id,group:g,position:p})}, deleteItem:function(id){return req("deleteItem",{id:id})},',
  'refresh:function(){return req("refresh",{})}, callTool:function(n,a){return req("callTool",{name:n,args:a})},',
  'pref:function(k,f){return (P&&k in P)?coercePref(P[k],f):f},',
  'onPrefChange:function(cb){prefCbs.push(cb)},',
  'setPref:function(k,v){return req("setPref",{key:k,value:v})},',
  'sendMessage:function(t){return req("sendMessage",{text:t})}, updateContext:function(t){return req("updateContext",{text:t})},',
  'get toolInput(){return TI}, get host(){return S.host}, get standalone(){return false} };',
  'var ro=new ResizeObserver(function(){parent.postMessage({omaRunHeight:true,h:document.documentElement.scrollHeight},"*")});',
  'window.addEventListener("load",function(){ro.observe(document.body)});',
  '})();<\\/script>',
].join("\\n");

// Transient loader-shown notice for refused child calls (mirrors the shell's omaNotify).
function note(msg) {
  let el = document.getElementById("__oma_run_notice");
  if (!el) {
    el = document.createElement("div");
    el.id = "__oma_run_notice";
    el.style.cssText = "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#e5484d;color:#fff;padding:6px 14px;border-radius:8px;max-width:92%;font:12.5px/1.45 -apple-system,system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3);display:none;";
    document.documentElement.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = "none"; }, 6000);
}

// The runner: sandbox="allow-scripts" (NO allow-same-origin) makes the child an opaque origin —
// a hand-rolled MCP bridge message from it is dropped by the host (source mismatch), so its
// only working channel is postMessage to THIS document, and every call funnels through
// handleChildCall, the single chokepoint where caps are enforced. caps shape (engine-computed):
// { call_tools, send_message, update_context, delete_items, cross_collection_read,
//   cross_collection_write, settings_write, read_source }. Absent fields mean DENY (strictest).
function runnerMount(name, html, caps) {
  const callAllow = Array.isArray(caps.call_tools) ? caps.call_tools : [];
  // "*" bypasses only the tool-NAME allowlist (the engine's local-tier passthrough marker —
  // local never reaches the runner); the explicit deny caps below still apply.
  const wildcard = callAllow.indexOf("*") !== -1;
  const coll = (oma.state && oma.state.collection) || name;
  let snap = oma.state && Array.isArray(oma.state.items)
    ? { collection: oma.state.collection, items: oma.state.items, version: oma.state.version }
    : { collection: coll, items: [], version: 0 };
  let prefMap = null, compKeys = {};
  // ids of rows KNOWN to live in the settings collection — seeded by the runner's own prefs
  // fetch, refreshed by every settings snapshot that crosses the chokepoint (incl. the child's
  // own cross-collection data_list, its only in-band way to learn those ids). Lets the
  // settings guard hold on id-addressed writes even when cross_collection_write passes
  // foreign ids through unresolved.
  let settingsIds = new Set();
  const cid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
  const inScope = (id) => (snap.items || []).some((i) => i.id === id);
  // mirror of shell-runtime.js versionOf(): id-addressed writes carry the version this runner
  // last showed the child, so a stale sandbox can't silently clobber a concurrent change (OCC).
  const versionOf = (id) => { const it = (snap.items || []).find((i) => i.id === id); return it ? it.version : undefined; };

  // sliding-window rate counters (research thresholds); exceeding one refuses with a notice
  const stamps = { writes: [], refresh: [], messages: [] };
  function rate(kind, limit, win) {
    const now = Date.now(), arr = stamps[kind];
    while (arr.length && now - arr[0] > win) arr.shift();
    if (arr.length >= limit) { note('Component "' + name + '" hit its ' + kind + ' rate limit.'); throw new Error(kind + " rate limit exceeded"); }
    arr.push(now);
  }
  const rateWrite = () => rate("writes", 60, 60000);

  // settings-collection writes are refused unless caps.settings_write === true
  function settingsGuard(target) {
    if (String(target == null ? "" : target).trim() === "settings" && caps.settings_write !== true) throw new Error("settings write denied");
  }

  function confirmDelete() {
    if (caps.delete_items === "allow") return;
    if (caps.delete_items === "confirm") {
      // v0.2: a loader-rendered native confirm(); some hosts suppress dialogs inside widget
      // iframes (confirm missing or auto-false) — then we degrade to DENY with a notice.
      let okd = false;
      try { okd = typeof window.confirm === "function" && window.confirm('Component "' + name + '" wants to delete an item. Allow?') === true; } catch (e) { okd = false; }
      if (okd) return;
      note("Delete refused (not confirmed, or confirmation unavailable in this host).");
      throw new Error("delete not confirmed");
    }
    note('Component "' + name + '" tried to delete an item — denied by policy.');
    throw new Error("delete denied");
  }

  function rebuildPrefs(items) {
    settingsIds = new Set(items.map((i) => i.id));
    const base = {}, over = {};
    for (const it of items) {
      const k = it.fields && it.fields.key;
      if (typeof k !== "string") continue;
      if (it.group === "") base[k] = it.fields.value;
      else if (it.group === name) over[k] = it.fields.value;
    }
    compKeys = {};
    for (const k in over) compKeys[k] = 1;
    prefMap = Object.assign(base, over);
  }

  async function proxySetPref(a) {
    const key = a.key, value = a.value;
    if (typeof key !== "string" || !KEY_RE.test(key) || /^(security_|_)/.test(key)) throw new Error("setPref: invalid or reserved key");
    const t = typeof value;
    if (t !== "string" && t !== "number" && t !== "boolean") throw new Error("setPref: value must be a scalar");
    if (t === "string" && value.length > 4096) throw new Error("setPref: value too long");
    const r0 = await oma.callTool("data_list", { collection: "settings" });
    const rows = ((r0 && r0.structuredContent) || {}).items || [];
    const it = rows.slice().reverse().find((i) => i.group === name && i.fields && i.fields.key === key);
    const add = () => oma.callTool("data_add_item", { command_id: cid(), collection: "settings", group: name, fields: { key: key, value: value }, actor: "human" });
    let r;
    if (it) {
      r = await oma.callTool("data_update_item", { command_id: cid(), id: it.id, fields: { value: value }, actor: "human" });
      if (r && r.isError) r = await add();   // concurrently deleted → re-create
    } else r = await add();
    const sc = r && r.structuredContent;
    if (sc && Array.isArray(sc.items)) { rebuildPrefs(sc.items); push(); }
    return r;
  }

  async function handleChildCall(method, a) {
    switch (method) {
      case "addItem":
        rateWrite(); settingsGuard(coll);
        // collection FORCED to the bound one; actor stamped "human" by the runner
        return oma.callTool("data_add_item", { command_id: cid(), collection: coll, group: a.group || "", fields: a.fields || {}, position: a.position, actor: "human" });
      case "updateItem":
        rateWrite(); settingsGuard(coll);
        if (!inScope(a.id)) throw new Error("out of scope");   // id must live in the bound collection
        return oma.callTool("data_update_item", { command_id: cid(), id: a.id, fields: a.fields, expected_version: versionOf(a.id), actor: "human" });
      case "moveItem":
        rateWrite(); settingsGuard(coll);
        if (!inScope(a.id)) throw new Error("out of scope");
        return oma.callTool("data_move_item", { command_id: cid(), id: a.id, group: a.group, position: a.position, expected_version: versionOf(a.id), actor: "human" });
      case "deleteItem":
        rateWrite(); settingsGuard(coll);
        if (!inScope(a.id)) throw new Error("out of scope");
        confirmDelete();
        return oma.callTool("data_delete_item", { command_id: cid(), id: a.id, expected_version: versionOf(a.id), actor: "human" });
      case "refresh": {
        rate("refresh", 6, 60000);
        const r = await oma.callTool("data_list", { collection: coll });
        return (r && r.structuredContent) || null;
      }
      case "setPref":
        // setPref writes the child's OWN group in the settings collection — still a settings
        // WRITE. v0.2 gates it behind caps.settings_write (unreviewed default: DENY); a
        // narrower own-group-only allowance is a v1 candidate. Denying is the honest default.
        if (caps.settings_write !== true) throw new Error("setPref denied by policy");
        rateWrite();
        return proxySetPref(a || {});
      case "callTool": {
        const tn = String(a.name || "").trim();
        const ta = Object.assign({}, a.args || {});
        // Control-plane tools are NEVER forwarded from a child (CONTROL_PLANE_DENY above);
        // checked BEFORE the allowlist/wildcard so no cap combination can reach them. Compare
        // on the normalized (trimmed, case-folded) name so a padded or re-cased variant can't
        // slip past the equality check — defense in depth on top of MCP dispatch.
        const tl = tn.toLowerCase();
        if (CONTROL_PLANE_DENY.indexOf(tl) !== -1 || tl.indexOf("library_") === 0) throw new Error('tool "' + tn + '" is not available to components');
        if (!wildcard && callAllow.indexOf(tn) === -1) throw new Error('tool "' + tn + '" not allowed');
        if ((tn === "component_html" || tn === "get_component") && caps.read_source !== true) throw new Error("component source read denied");
        if (tn === "data_collections" && caps.cross_collection_read !== true) throw new Error("cross-collection read denied");
        if (tn === "data_list") {
          rate("refresh", 6, 60000);
          if (caps.cross_collection_read !== true) ta.collection = coll;   // force the bound collection
        }
        if (tn === "data_add_item" || tn === "data_update_item" || tn === "data_move_item" || tn === "data_delete_item") {
          rateWrite();
          ta.actor = "human";   // runner-stamped provenance
          if (tn === "data_add_item") {
            if (caps.cross_collection_write !== true) ta.collection = coll;
            settingsGuard(ta.collection);
          } else {
            // id-addressed: the settings guard applies on EVERY write path, independent of
            // cross_collection_write — caps overlay independently, so settings_write must be
            // enforced here, never assumed co-granted. Bound-collection rows are guarded via
            // coll; foreign ids that match a known settings row are guarded via settingsIds.
            settingsGuard(coll);
            if (settingsIds.has(ta.id)) settingsGuard("settings");
            if (caps.cross_collection_write !== true && !inScope(ta.id)) throw new Error("out of scope");
          }
          if (tn === "data_delete_item") confirmDelete();
        }
        return oma.callTool(tn, ta);
      }
      case "sendMessage":
        if (caps.send_message !== true) {
          note('Component "' + name + '" tried to send a chat message — denied by policy.');
          return { isError: true, content: [{ type: "text", text: "sendMessage denied by policy" }] };
        }
        rate("messages", 3, 10000);
        return oma.sendMessage(a.text);
      case "updateContext":
        if (caps.update_context !== true) return null;   // silent deny by design (§5 v0.2)
        rate("messages", 3, 10000);
        return oma.updateContext(a.text);
      default:
        throw new Error("unknown " + method);
    }
  }

  // child document: WE build the outer document — the component's own <head> is NEVER trusted
  // as an injection anchor. Anchoring on it lets a hostile component emit a <script> BEFORE
  // its <head>; per HTML parsing that pre-head script runs before the injected CSP meta is
  // parsed, so its network egress escapes the policy entirely (reproduced in Chrome). So the
  // untrusted markup goes wholesale inside OUR <body>: its doctype/head degrade to tag-soup
  // there, its scripts still execute — but only AFTER the CSP (the FIRST element of OUR
  // <head>) is in force, which is the whole point.
  const src = "<!doctype html><html><head>" + RUNNER_CSP + '<meta charset="utf-8">' + tokenCSS() + BRIDGE + "</head><body>" + html + "</body></html>";

  document.body.innerHTML = "";
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.cssText = "display:block;width:100%;border:0;height:140px";

  function push() {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage({
      omaRunSnapshot: true,
      snapshot: { collection: snap.collection || coll, items: snap.items || [], version: snap.version || 0, component: name, host: oma.host },
      toolInput: { component: name, collection: coll },
      prefs: prefMap || {},
      compKeys: compKeys,
    }, "*");
  }

  // merged pref map (global rows overlaid by the child's own group) — pushed with every
  // snapshot so the child's pref() stays a sync read
  const prefsReady = oma.callTool("data_list", { collection: "settings" })
    .then((r) => rebuildPrefs(((r && r.structuredContent) || {}).items || []))
    .catch(() => { if (prefMap === null) prefMap = {}; });
  prefsReady.then(() => push());

  // the loader shell keeps polling the bound collection — adopt every fresher emit
  oma.onChange((s) => {
    if (s.collection !== coll || !Array.isArray(s.items)) return;
    if ((s.version || 0) < (snap.version || 0)) return;   // never rewind past a child-write snapshot
    snap = { collection: s.collection, items: s.items, version: s.version };
    push();
  });
  // effective merged pref changes for THIS component (the loader's own pref scope IS the child's name)
  oma.onPrefChange((c) => {
    if (prefMap === null) return;
    if (c.value === undefined) { delete prefMap[c.key]; delete compKeys[c.key]; }
    else { prefMap[c.key] = c.value; if (c.scope === "component") compKeys[c.key] = 1; else delete compKeys[c.key]; }
    push();
  });

  window.addEventListener("message", async (ev) => {
    if (ev.source !== frame.contentWindow) return;   // source-authenticated: only OUR child
    const d = ev.data || {};
    if (d.omaRunHeight && typeof d.h === "number") { frame.style.height = Math.min(Math.max(d.h + 4, 60), 20000) + "px"; return; }
    if (!d.omaRun) return;
    try {
      const result = await handleChildCall(d.method, d.args || {});
      if (!frame.contentWindow) return;
      frame.contentWindow.postMessage({ omaRunResult: true, id: d.id, result: result }, "*");
      const sc = (result && result.structuredContent) || (d.method === "refresh" ? result : null);
      if (sc && Array.isArray(sc.items) && sc.collection === "settings") rebuildPrefs(sc.items);   // keep settingsIds + prefs current
      if (sc && Array.isArray(sc.items) && sc.collection === coll && (sc.version || 0) >= (snap.version || 0)) snap = sc;
      push();   // push {snapshot, prefs} after every proxied child call
    } catch (e) {
      if (frame.contentWindow) frame.contentWindow.postMessage({ omaRunResult: true, id: d.id, error: String((e && e.message) || e) }, "*");
    }
  });

  frame.onload = () => { Promise.race([prefsReady, new Promise((r) => setTimeout(r, 1000))]).then(push, push); };
  frame.srcdoc = src;
  document.body.appendChild(frame);
}

oma.ready(async (state) => {
  try {
    const name = (oma.toolInput && oma.toolInput.component) || state.component;
    if (!name) return show("No component specified.");
    const r = await oma.callTool("component_html", { name });
    const sc = (r && r.structuredContent) || {};
    const html = sc.html;
    if (!html) return show('Component "' + name + '" not found in the registry.');
    // Tier branch (security-model §2.3): "local" — or a result carrying no tier at all, from
    // an engine predating tiers — mounts same-document (direct mode) exactly as before.
    // Anything else is untrusted and runs behind the sandboxed runner with engine-computed caps.
    if (sc.tier == null || sc.tier === "local") return mount(html);
    runnerMount(name, html, sc.caps || {});
  } catch (e) { show("Failed to load component: " + (e && e.message ? e.message : e)); }
});
`;

/** The universal-loader ui:// document served for the static open_component tool. */
export function wrapLoader() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style data-oma="tokens">${TOKEN_FALLBACK_CSS}</style>
<script type="module" data-oma="runtime">${runtime()}</script>
<script type="module" data-oma="loader">${LOADER_JS}</script>
</head><body><div style="padding:24px;text-align:center;color:var(--color-text-tertiary);font-family:var(--font-sans)">Loading component…</div></body></html>`;
}

/**
 * Wrap component HTML into the final document.
 * opts.standalone — {endpoint, collection, component}: browser-viewer mode (no MCP host);
 * the config global must be defined BEFORE the runtime module evaluates.
 * opts.component — component name, injected as window.__OMA_COMPONENT__ so the runtime knows
 * its identity on the dynamic-tools resource path (the generic loader cannot carry it).
 */
export function wrapComponent(componentHtml, opts = {}) {
  const inject =
    (opts.standalone ? `<script data-oma="standalone">window.__OMA_STANDALONE__=${JSON.stringify(opts.standalone)}</script>\n` : "") +
    (opts.component ? `<script data-oma="component">window.__OMA_COMPONENT__=${JSON.stringify(opts.component)}</script>\n` : "") +
    `<style data-oma="tokens">${TOKEN_FALLBACK_CSS}</style>\n` +
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
