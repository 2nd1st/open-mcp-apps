// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// runner.mjs — THE enforcement piece for sandboxed app children (write-set D).
//
// Before this module there were three hand-kept copies of the same machine — the loader's
// runnerMount (shell.mjs), settings.html's thumbnail bridge, settings.html's drawer bridge —
// plus library.html's inert stub as a fourth variant, and they had measurably drifted (three
// divergent rules found in the write-set D survey). Every future gap between copies is a
// cross-app escape seam (adversarial review F2: "one missing line = escape"), so the machine
// now exists ONCE: document composition (CSP-first), the child mini-bridge, and the caps
// chokepoint live here, parameterized by a PRESET instead of re-implemented per consumer.
//
//   preset "live"      caps-driven read/write (the loader, oma.embed, settings' drawer)
//   preset "readonly"  reads only, writes refused (settings' library thumbnails)
//   preset "inert"     zero host IO — snapshot/fixture-fed (library previews)
//
// NOT a security boundary against the EMBEDDER (it runs in the embedder's document); it is
// the boundary around the CHILD: sandbox="allow-scripts" (no allow-same-origin) makes the
// child an opaque origin whose only working channel is postMessage to the embedder document,
// and every call funnels through the guard built by makeGuard() — the single chokepoint
// where caps are enforced (docs/security-model.md §2.3, §4.2b).
//
// Consumed by: shell-runtime.js (oma.embed + the loader path — bundled into dist/shell.js),
// and exported through index.mjs for embedding shells (the hosted /library preview) so no
// out-of-repo mirror has to exist.

import { isControlPlaneTool } from "./tool-policy.mjs";
import { viaOf, RUNTIME_CONTRACT } from "./runtime-core.mjs";

// CSP goes FIRST in the child head: no network at all (connect-src 'none', no remote
// script/img/font sources) — closes exfiltration on every host, incl. the browser viewer.
// The bare POLICY string is exported separately so a server that serves preview documents
// can send the same policy as an HTTP header (the authoritative copy; the meta is self-defence).
//
// `form-action` is listed EXPLICITLY because it is the one outbound shape that does NOT fall
// back to `default-src`: a form posting to an attacker's URL is a navigation, not a fetch, so
// every other directive here misses it. It was closed anyway — by the sandbox lacking
// `allow-forms` (measured 2026-07-28, docs/spec-conformance.md §8) — but that made a whole
// exfiltration channel depend on ONE attribute staying absent. Depth costs nothing here, and
// third-party apps arriving by share link (T19 P-c) is exactly when single points stop being fine.
export const RUNNER_CSP_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'";
export const RUNNER_CSP = '<meta http-equiv="Content-Security-Policy" content="' + RUNNER_CSP_POLICY + '">';

// The child is a separate document, so host-injected design tokens don't reach it. Read the
// COMPUTED values from the embedder document's root and re-emit them as :root CSS for the
// child (the proven settings.html tokenCSS pattern, now the only copy).
export const TOKEN_NAMES = [
  ...["background", "text", "border"].flatMap((k) => ["primary", "secondary", "tertiary", "inverse", "ghost", "info", "danger", "success", "warning", "disabled"].map((v) => "--color-" + k + "-" + v)),
  ...["primary", "secondary", "inverse", "info", "danger", "success", "warning"].map((v) => "--color-ring-" + v),
  "--font-sans", "--font-mono", "--font-weight-normal", "--font-weight-medium", "--font-weight-semibold", "--font-weight-bold",
  ...["xs", "sm", "md", "lg"].flatMap((s) => ["--font-text-" + s + "-size", "--font-text-" + s + "-line-height"]),
  ...["xs", "sm", "md", "lg", "xl", "2xl", "3xl"].flatMap((s) => ["--font-heading-" + s + "-size", "--font-heading-" + s + "-line-height"]),
  ...["xs", "sm", "md", "lg", "xl", "full"].map((s) => "--border-radius-" + s),
  "--border-width-regular", "--shadow-hairline", "--shadow-sm", "--shadow-md", "--shadow-lg",
];

/** The system UI kit as a head <style>. ONE definition of the tag, shared by every composer
 *  (this file's two, plus shell.mjs's wrapApp/wrapLoader) so the data-oma marker that
 *  identifies it — and that shell-runtime reads it back by — cannot drift between them.
 *  The CSS text itself is supplied by the caller: it lives in components/_system.css (MIT)
 *  and only a node-side reader (shell.mjs KIT_CSS) can reach the file. */
export function kitStyle(css) {
  return css ? '<style data-oma="kit">' + css + "</style>" : "";
}

/** :root token style computed from a live document (browser-only caller).
 *
 *  `substitute` repairs a scope leak inherent to reading COMPUTED values: the embedder's own
 *  per-app theme is stamped as inline custom properties on its <html>, so it is part of what
 *  getComputedStyle reports — and copying that into the child baked one app's private theme into
 *  every app it embeds (reproduced: a token scoped to `settings` tinted all eight of its
 *  thumbnails). The embedder passes {name: valueBelowTheTheme | null}; null means "emit nothing
 *  for this one", leaving the child's own fallback layer to answer. The child's LEGITIMATE theme
 *  arrives separately, through the themeVars push, already merged for the child. */
export function tokenCSS(doc, substitute) {
  const cs = doc.defaultView.getComputedStyle(doc.documentElement);
  const has = (n) => substitute && Object.prototype.hasOwnProperty.call(substitute, n);
  let vars = "";
  for (const n of TOKEN_NAMES) {
    if (has(n) && substitute[n] == null) continue;
    const v = String(has(n) ? substitute[n] : cs.getPropertyValue(n)).trim();
    if (v) vars += n + ":" + v + ";";
  }
  return '<style data-oma="tokens">:root{' + vars + "}html{color-scheme:" + (cs.colorScheme || "light dark") + '}body{font-family:var(--font-sans);color:var(--color-text-primary)}</style>';
}

// Mini-bridge injected into the sandboxed child: exposes the window.oma surface and proxies
// every call over postMessage (message keys omaRun*). This is the CHILD half of the machine;
// the guard below is the parent half. Kept as one string so the whole child-facing API has
// one definition. The closing tag is split so this file can travel inside HTML safely.
export const BRIDGE = [
  "<script>(function(){",
  'var S={collection:null,items:[],version:0,app:null,host:null},TI={};',
  'var readyCbs=[],changeCbs=[],prefCbs=[],isReady=false,seq=0,pending={},P=null,urlCache={},TA=[];',
  // coercePref mirrors runtime-core semantics: the FALLBACK's type drives coercion.
  'function coercePref(v,f){var t=typeof f;',
  'if(t==="boolean"){if(v===true||v==="true"||v===1)return true;if(v===false||v==="false"||v===0)return false;return f;}',
  'if(t==="number"){if(typeof v==="number"&&Number.isFinite(v))return v;if(typeof v==="string"&&v.trim()!==""&&Number.isFinite(Number(v)))return Number(v);if(typeof v==="boolean")return v?1:0;return f;}',
  'if(t==="string"){if(typeof v==="string")return v;if(typeof v==="number"||typeof v==="boolean")return String(v);return f;}',
  'return v===undefined?f:v;}',
  'function firePref(k,v,o,s){prefCbs.forEach(function(cb){try{cb({key:k,value:v,oldValue:o,scope:s})}catch(e){}})}',
  'function req(m,a){return new Promise(function(res,rej){var id=++seq;pending[id]=[res,rej];parent.postMessage({omaRun:true,id:id,method:m,args:a},"*");})}',
  // SOURCE-AUTHENTICATED, both halves. The parent already refused messages that aren't from
  // its own child; without the mirror image here a hostile sibling could walk parent.frames[],
  // hold another child's WindowProxy, and postMessage it a forged omaRunSnapshot (rewriting its
  // projection) or an early omaRunResult (resolving its pending request with attacker data).
  // `parent` is the ONLY legitimate peer a sandboxed child ever has.
  'window.addEventListener("message",function(ev){if(ev.source!==parent)return;var d=ev.data||{};',
  'if(d.omaRunResult&&pending[d.id]){var p=pending[d.id];delete pending[d.id];d.error?p[1](new Error(d.error)):p[0](d.result);}',
  'if(d.omaRunSnapshot&&d.snapshot){',
  'if(d.toolInput)TI=d.toolInput;',
  // User theme layer, already merged and charset-checked by the parent (runtime-core themeVars):
  // apply verbatim as inline custom properties, and restore anything dropped since the last push
  // to the token <style> underneath. No rule is re-implemented here — only the assignment.
  'if(d.themeVars){var TV=d.themeVars,st=document.documentElement.style,ti,tk={};',
  'for(ti=0;ti<TV.length;ti++){st.setProperty(TV[ti][0],TV[ti][1]);tk[TV[ti][0]]=1;}',
  'for(ti=0;ti<TA.length;ti++)if(!tk[TA[ti]])st.removeProperty(TA[ti]);',
  'TA=Object.keys(tk);}',
  'var pc=false;',
  'if(d.prefs&&typeof d.prefs==="object"){var CK=d.compKeys||{};',
  'if(P===null){P=d.prefs;}',
  'else{var old=P;P=d.prefs;var k;',
  'for(k in P)if(!(k in old)||old[k]!==P[k]){firePref(k,P[k],old[k],CK[k]?"app":"global");pc=true;}',
  'for(k in old)if(!(k in P)){firePref(k,undefined,old[k],"global");pc=true;}}}',
  // Item count is part of "changed" (the zero-row-open lesson, write-set C): a fresh walk can
  // share a version with an earlier empty push, and eating that repaint leaves the child blank.
  'var ch=d.changed===true||d.snapshot.version!==S.version||d.snapshot.items.length!==S.items.length||pc;S=Object.assign(S,d.snapshot);',
  'if(!isReady){isReady=true;readyCbs.splice(0).forEach(function(cb){try{cb(S)}catch(e){}});}',
  'else if(ch){changeCbs.forEach(function(cb){try{cb(S)}catch(e){}});}}',
  "});",
  'function b64bytes(b){var s=atob(b),u=new Uint8Array(s.length);for(var i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u;}',
  'window.oma={ get state(){return S}, ready:function(cb){isReady?cb(S):readyCbs.push(cb)}, onChange:function(cb){changeCbs.push(cb)},',
  'addItem:function(o){return req("addItem",o||{})}, updateItem:function(id,f){return req("updateItem",{id:id,fields:f})},',
  'moveItem:function(id,g,p){return req("moveItem",{id:id,group:g,position:p})}, deleteItem:function(id){return req("deleteItem",{id:id})},',
  'refresh:function(){return req("refresh",{})}, callTool:function(n,a){return req("callTool",{name:n,args:a})},',
  'readCollection:function(c,o){return req("readCollection",{collection:c,opts:o||{}})},',
  'callFunction:function(f,a){return req("callFunction",{function:f,args:a||{}})},',
  'files:{ list:function(){return req("filesList",{})},',
  'read:function(p){return req("filesRead",{path:p}).then(function(r){return b64bytes(r.base64)})},',
  'url:function(p){if(urlCache[p])return Promise.resolve(urlCache[p]);return req("filesRead",{path:p}).then(function(r){var u=URL.createObjectURL(new Blob([b64bytes(r.base64)],{type:r.mime||"application/octet-stream"}));urlCache[p]=u;return u;})} },',
  'pref:function(k,f){return (P&&k in P)?coercePref(P[k],f):f},',
  'onPrefChange:function(cb){prefCbs.push(cb)},',
  'setPref:function(k,v){return req("setPref",{key:k,value:v})},',
  'sendMessage:function(t){return req("sendMessage",{text:t})}, updateContext:function(t){return req("updateContext",{text:t})},',
  // Same contract number the direct runtime reports — the whole point of oma.contract is that an
  // app cannot tell which runtime it landed in by reading it, only which VOCABULARY it may use.
  'get contract(){return ' + RUNTIME_CONTRACT + '},',
  'get toolInput(){return TI}, get host(){return S.host}, get standalone(){return false} };',
  'var ro=new ResizeObserver(function(){parent.postMessage({omaRunHeight:true,h:document.documentElement.scrollHeight},"*")});',
  'window.addEventListener("load",function(){ro.observe(document.body)});',
  "})();</scr" + "ipt>",
].join("\n");

/** Child document composition. WE build the outer document — the app's own <head> is
 *  NEVER trusted as an injection anchor: anchoring on it lets a hostile app emit a
 *  <script> BEFORE its <head>, which per HTML parsing runs before an injected CSP meta is
 *  parsed, so its network egress escapes the policy entirely (reproduced in Chrome). The
 *  untrusted markup goes wholesale inside OUR <body>: its doctype/head degrade to tag-soup,
 *  its scripts still execute — but only AFTER the CSP (the FIRST element of OUR <head>). */
export function composeChildDoc(html, { tokenCss = "", kitCss = "", fallbackCss = "", bridge = BRIDGE } = {}) {
  // Layer order is the cascade: neutral fallbacks, then the embedder's (substituted) tokens, then
  // the kit, then the app's own markup and <style>. The child's THEME arrives at runtime as
  // inline custom properties on its <html>, which outrank all of these — same as in the parent.
  return "<!doctype html><html><head>" + RUNNER_CSP + '<meta charset="utf-8">' +
    (fallbackCss ? '<style data-oma="token-fallback">' + fallbackCss + "</style>" : "") +
    tokenCss + kitStyle(kitCss) + bridge + "</head><body>" + html + "</body></html>";
}

// Sliding-window rate limits (research thresholds — one table, no more per-copy literals).
export const RATES = { writes: [60, 60000], refresh: [6, 60000], messages: [3, 10000] };

// Tool-name families the guard routes by. WRITE_TOOLS get actor+via stamping and the writes
// rate; the file families gate on file caps with app binding.
const DATA_WRITE_TOOLS = new Set(["data_add_item", "data_update_item", "data_move_item", "data_delete_item"]);
const FILE_READ_TOOLS = new Set(["file_read", "file_list"]);
const FILE_WRITE_TOOLS = new Set(["file_write", "file_write_begin", "file_write_chunk", "file_write_commit", "file_write_abort", "file_delete"]);
const FILE_BIND_TOOLS = new Set(["file_write", "file_write_begin", "file_delete"]);   // carry `app` — forced to the caller
// The chunked family carries NO app, only an upload_id, so there is nothing to force:
// binding has to be by WHICH ids this guard opened (see myUploads in makeGuard). They were
// previously assumed to "inherit begin's binding", which is not a thing the wire supports.
const UPLOAD_ID_TOOLS = new Set(["file_write_chunk", "file_write_commit", "file_write_abort"]);
const READONLY_LOCAL_TOOLS = new Set(["data_list", "data_collections", "list_apps"]); // thumbnail allowance (system apps preview richly)

/**
 * Build the parent-side chokepoint. Every child call — typed method or generic callTool —
 * funnels through the returned async guard(method, args). Throws (or returns an isError
 * result) on refusal; the mount layer relays either to the child.
 *
 * cfg:
 *   name       child app name (the binding target for collection/file/function forcing)
 *   coll       bound collection
 *   caps       engine-computed caps (absent fields mean DENY — strictest)
 *   tier       child tier ("local" | ...) — the readonly preset's allowance nuance
 *   preset     "live" | "readonly" | "inert"
 *   io         { callTool, sendMessage, updateContext, snapshot, settingsIds, readCollection,
 *                readFile(app, path) → {base64, mime}, notify, confirm, uuid } — ALL
 *                effects go through io, so the whole policy is node-testable with fakes.
 */
export function makeGuard(cfg) {
  const { name, coll, preset = "live", tier, io } = cfg;
  const caps = cfg.caps || {};
  const callAllow = Array.isArray(caps.call_tools) ? caps.call_tools : [];
  // "*" bypasses only the tool-NAME allowlist (the engine's local-tier passthrough marker);
  // the explicit deny caps below still apply.
  const wildcard = callAllow.indexOf("*") !== -1;
  const uuid = io.uuid || (() => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()));
  const snap = () => io.snapshot() || { collection: coll, items: [], version: 0 };
  const notify = (m) => { try { io.notify && io.notify(m); } catch {} };

  // Chunked-upload ids THIS guard opened. Per-guard (so per mounted child), which is the whole
  // point: an id another app holds is not in this set and cannot be appended to.
  const myUploads = new Set();

  // The other half of the control-plane instrument (the server half is in engine.mjs). A refusal
  // here never reaches a server — this guard runs in the embedder's document — so the only place
  // it can be recorded is the widget console. Name, tier and preset only: enough to answer "was it
  // us?", nothing that could carry a user's data.
  const refuseControlPlane = (tn) => {
    try { console.warn(`[oma] control-plane refused: ${tn} (app=${name} tier=${tier || "?"} preset=${preset})`); } catch {}
    throw new Error('tool "' + tn + '" is not available to apps');
  };

  const stamps = { writes: [], refresh: [], messages: [] };
  // One notice per saturation EPISODE, not per refused call. Cleared as soon as a call gets
  // through again, so a second genuine episode is still reported.
  const saturated = { writes: false, refresh: false, messages: false };
  function rate(kind) {
    const [limit, win] = RATES[kind];
    const now = Date.now(), arr = stamps[kind];
    while (arr.length && now - arr[0] > win) arr.shift();
    if (arr.length >= limit) {
      // WHOSE budget this was, said correctly. These stamps are PER-GUARD, i.e. per mounted
      // child, so a preview is starving its own allowance and not the app's — but the notice
      // named the app alone, which made settings' Installed grid report
      // 'App "dashboard" hit its refresh rate limit' while the real dashboard was
      // untouched (measured 2026-07-28: a thumbnail fans out one data_list per collection on
      // mount and runs out at six). The user cannot tell a starved thumbnail from a throttled
      // app unless the sentence says which one it is.
      //
      // And it said it FOUR times for that one episode — every refused call notified. Ten
      // installed apps would have made that a toast storm, so the notice is now deduped.
      if (!saturated[kind]) {
        saturated[kind] = true;
        notify(preset === "live"
          ? 'App "' + name + '" hit its ' + kind + " rate limit."
          : 'Preview of "' + name + '" hit its ' + kind + " rate limit — the app itself is unaffected.");
      }
      throw new Error(kind + " rate limit exceeded");
    }
    arr.push(now);
    saturated[kind] = false;
  }

  const inScope = (id) => (snap().items || []).some((i) => i.id === id);
  // NO expected_version on the typed writes — LAST-WRITE-WINS, the same policy direct mode chose
  // and for the same reason (shell-runtime's long note: a widget write is the user rapid-clicking
  // their OWN UI, and sending the version they were last SHOWN made the second click carry a
  // pre-echo stale one). Here it was worse than a visible error: the guard hands the conflict back
  // as an isError result, the child bridge RESOLVES with it, and an app that doesn't inspect
  // the return value loses the write with nothing on screen. Two policies for one verb, split by
  // tier, is also exactly the drift seam this module exists to remove (Leo 2026-07-27).
  // Explicit OCC is still reachable: a caller that genuinely needs it passes expected_version
  // through the generic callTool path, where it is the caller's own stated intent.
  // Every proxied write is stamped with the child's identity — the shadow via edge (row #8,
  // object form, frozen). FORCED, never taken from the child's own args.
  const via = () => viaOf(name);

  function settingsGuard(target) {
    if (String(target == null ? "" : target).trim() === "settings" && caps.settings_write !== true) throw new Error("settings write denied");
  }

  function confirmDelete() {
    if (caps.delete_items === "allow") return;
    if (caps.delete_items === "confirm") {
      let okd = false;
      try { okd = io.confirm ? io.confirm('App "' + name + '" wants to delete an item. Allow?') === true : false; } catch { okd = false; }
      if (okd) return;
      notify("Delete refused (not confirmed, or confirmation unavailable in this host).");
      throw new Error("delete not confirmed");
    }
    notify('App "' + name + '" tried to delete an item — denied by policy.');
    throw new Error("delete denied");
  }

  async function proxySetPref(a) {
    const key = a.key, value = a.value;
    if (typeof key !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(key) || /^(security_|_)/.test(key)) throw new Error("setPref: invalid or reserved key");
    const t = typeof value;
    if (t !== "string" && t !== "number" && t !== "boolean") throw new Error("setPref: value must be a scalar");
    if (t === "string" && value.length > 4096) throw new Error("setPref: value too long");
    const rows = (await io.readCollection("settings")).items || [];
    const it = rows.slice().reverse().find((i) => i.group === name && i.fields && i.fields.key === key);
    const add = () => io.callTool("data_add_item", { command_id: uuid(), collection: "settings", group: name, fields: { key, value }, actor: "human", via: via() });
    let r;
    if (it) {
      r = await io.callTool("data_update_item", { command_id: uuid(), id: it.id, fields: { value }, actor: "human", via: via() });
      if (r && r.isError) r = await add();   // concurrently deleted → re-create
    } else r = await add();
    return r;
  }

  // ---- generic callTool path: control-plane wall → allowlist → per-tool gates ----
  async function guardCallTool(a) {
    const tn = String(a.name || "").trim();
    const ta = Object.assign({}, a.args || {});
    const tl = tn.toLowerCase();
    // Control-plane tools and internal `_` RPC names are NEVER forwarded from a child —
    // checked BEFORE the allowlist/wildcard so no cap combination can reach them.
    if (isControlPlaneTool(tl)) refuseControlPlane(tn);
    if (!wildcard && callAllow.indexOf(tn) === -1) throw new Error('tool "' + tn + '" not allowed');
    if ((tn === "app_html" || tn === "get_app") && caps.read_source !== true) throw new Error("app source read denied");
    if (FILE_READ_TOOLS.has(tn)) {
      if (caps.file_read !== true) throw new Error("file read denied by policy");
      ta.app = name;   // a child reaches its OWN files only
    }
    if (FILE_WRITE_TOOLS.has(tn)) {
      if (caps.file_write !== true) throw new Error("file write denied by policy");
      if (FILE_BIND_TOOLS.has(tn)) ta.app = name;
      else if (UPLOAD_ID_TOOLS.has(tn) && !myUploads.has(String(ta.upload_id == null ? "" : ta.upload_id))) throw new Error("upload_id was not opened by this app");
    }
    if (tn === "data_collections" && caps.cross_collection_read !== true) throw new Error("cross-collection read denied");
    // Every collection-addressed READ is bound the same way. data_changes was the one left out,
    // and it is the RICHEST of the three — full events, fields and item ids for any collection
    // the child names (the "one missing line = cross-app escape" shape, again).
    if (tn === "data_list" || tn === "data_query" || tn === "data_changes") {
      rate("refresh");
      if (caps.cross_collection_read !== true) ta.collection = coll;   // force the bound collection
    }
    // A batch is the model's bulk verb, not a widget's: forwarding it would need every
    // per-command rule above re-implemented inside the batch — one missed line is a
    // cross-app escape (adversarial F2). Children write one command at a time.
    if (tn === "data_batch") { notify('App "' + name + '" tried data_batch — not available to apps.'); throw new Error("data_batch is not available to apps"); }
    // A child may call ONLY its own app's functions (the designed free path); the
    // callee is forced, so a second hop through another app is unreachable by shape.
    if (tn === "call_function") {
      rate("writes");
      ta.app = name;
      ta.via = via();
      if (!ta.command_id) ta.command_id = uuid();
    }
    if (DATA_WRITE_TOOLS.has(tn)) {
      rate("writes");
      ta.actor = "human";   // runner-stamped provenance
      ta.via = via();       // shadow edge — forced, never child-supplied
      if (tn === "data_add_item") {
        if (caps.cross_collection_write !== true) ta.collection = coll;
        settingsGuard(ta.collection);
      } else {
        // id-addressed: the settings guard applies on EVERY write path, independent of
        // cross_collection_write. Bound-collection rows are guarded via coll; foreign ids
        // that match a known settings row are guarded via the settingsIds set.
        settingsGuard(coll);
        if (io.settingsIds && io.settingsIds().has(ta.id)) settingsGuard("settings");
        if (caps.cross_collection_write !== true && !inScope(ta.id)) throw new Error("out of scope");
      }
      if (tn === "data_delete_item") confirmDelete();
    }
    const r = await io.callTool(tn, ta);
    // Upload-id bookkeeping rides the RESULT, because the id is minted server-side. commit/abort
    // consume the upload either way (files.mjs contract), so the id is retired on both.
    if (tn === "file_write_begin") { const id = r && r.structuredContent && r.structuredContent.upload_id; if (id) myUploads.add(String(id)); }
    else if (tn === "file_write_commit" || tn === "file_write_abort") myUploads.delete(String(ta.upload_id == null ? "" : ta.upload_id));
    return r;
  }

  // ---- the three presets share one skeleton ----
  async function live(method, a) {
    switch (method) {
      case "addItem":
        rate("writes"); settingsGuard(coll);
        return io.callTool("data_add_item", { command_id: uuid(), collection: coll, group: a.group || "", fields: a.fields || {}, position: a.position, actor: "human", via: via() });
      case "updateItem":
        rate("writes"); settingsGuard(coll);
        if (!inScope(a.id)) throw new Error("out of scope");
        return io.callTool("data_update_item", { command_id: uuid(), id: a.id, fields: a.fields, actor: "human", via: via() });
      case "moveItem":
        rate("writes"); settingsGuard(coll);
        if (!inScope(a.id)) throw new Error("out of scope");
        return io.callTool("data_move_item", { command_id: uuid(), id: a.id, group: a.group, position: a.position, actor: "human", via: via() });
      case "deleteItem":
        rate("writes"); settingsGuard(coll);
        if (!inScope(a.id)) throw new Error("out of scope");
        confirmDelete();
        return io.callTool("data_delete_item", { command_id: uuid(), id: a.id, actor: "human", via: via() });
      case "refresh":
        rate("refresh");
        return io.readCollection(coll);
      case "readCollection": {
        rate("refresh");
        const c = caps.cross_collection_read === true ? String(a.collection || coll) : coll;
        return io.readCollection(c, a.opts);
      }
      case "filesList":
        if (caps.file_read !== true) throw new Error("file read denied by policy");
        rate("refresh");
        return io.callTool("file_list", { app: name });
      case "filesRead":
        if (caps.file_read !== true) throw new Error("file read denied by policy");
        rate("refresh");
        return io.readFile(name, String(a.path || ""));
      case "callFunction":
        return guardCallTool({ name: "call_function", args: { function: a.function, args: a.args } });
      case "setPref":
        // setPref writes the child's OWN group in the settings collection — still a settings
        // WRITE, gated on caps.settings_write (unreviewed default: DENY).
        if (caps.settings_write !== true) throw new Error("setPref denied by policy");
        rate("writes");
        return proxySetPref(a || {});
      case "callTool":
        return guardCallTool(a || {});
      case "sendMessage":
        if (caps.send_message !== true) {
          notify('App "' + name + '" tried to send a chat message — denied by policy.');
          return { isError: true, content: [{ type: "text", text: "sendMessage denied by policy" }] };
        }
        rate("messages");
        return io.sendMessage(a.text);
      case "updateContext":
        if (caps.update_context !== true) return null;   // silent deny by design (§5 v0.2)
        rate("messages");
        return io.updateContext(a.text);
      default:
        throw new Error("unknown " + method);
    }
  }

  // Read-only preview (library thumbnails): reads answer from the cached snapshot or a
  // narrow allowlist; every write path refuses. Local-tier children keep the three-tool
  // browse allowance (system apps preview richly); everything else gets exactly a
  // bound data_list.
  async function readonly(method, a) {
    switch (method) {
      case "refresh":
        return snap();
      case "readCollection": {
        rate("refresh");
        if (tier === "local") return io.readCollection(String(a.collection || coll), a.opts);
        return io.readCollection(coll, a.opts);
      }
      case "callTool": {
        const tn = String((a && a.name) || "").trim();
        const tl = tn.toLowerCase();
        if (isControlPlaneTool(tl)) refuseControlPlane(tn);
        if (tier === "local" && READONLY_LOCAL_TOOLS.has(tn)) { rate("refresh"); return io.callTool(tn, Object.assign({}, a.args || {})); }
        if (tn === "data_list") { rate("refresh"); const ta = Object.assign({}, a.args || {}); ta.collection = coll; return io.callTool(tn, ta); }
        throw new Error('tool "' + tn + '" not available in a read-only preview');
      }
      case "sendMessage":
      case "updateContext":
        return null;   // silent no-op — previews must not reach the chat
      default:
        throw new Error("read-only preview");
    }
  }

  // Inert (library fixtures): ZERO host IO. Writes pretend to succeed so demo apps
  // animate; reads answer from the fixed snapshot; everything else resolves empty.
  //
  // Multi-collection apps made "answer from the snapshot" load-bearing: they self-fetch every
  // collection they render (data_list via callTool / readCollection — the GUIDE's canonical
  // pattern), and the old empty-envelope callTool answer read as corrupt data — five of the
  // library's sixteen previews opened on their own error banner. Fixture rows carry a
  // `collection` key (the multi-collection fixtures convention); serve each read the rows it
  // asked for, in the real item shape (raw fixtures ship {collection, group, fields} only).
  const fxRows = (c) => {
    const s = snap();
    const bound = s.collection;
    const want = c == null ? bound : String(c);
    const rows = (s.items || []).filter((it) => ((it && it.collection) || bound) === want);
    const items = rows.map((it, i) => ({ id: "fx-" + i, group: (it && it.group) || "", position: i + 1,
      fields: (it && it.fields) || {}, version: 1 }));
    return { collection: want, items, version: s.version || 1, returned: items.length, total: items.length };
  };
  async function inert(method, a) {
    switch (method) {
      case "addItem": case "updateItem": case "moveItem": case "deleteItem": case "setPref":
        return { ok: true };
      case "refresh": case "readCollection":
        return fxRows(a && a.collection);
      case "callTool": {
        const tn = a && a.name;
        const ta = (a && a.args) || {};
        if (tn === "data_list") return { content: [], structuredContent: fxRows(ta.collection) };
        if (tn === "data_version") return { content: [], structuredContent: { seq: snap().version || 1 } };
        // Meta apps ask WHICH collections exist before they ask for rows (dashboard draws a
        // card per collection). Answering that with an empty envelope makes the preview of an app
        // whose whole job is "show me everything" render as though the user owns nothing — the same
        // failure the multi-collection fxRows work already fixed one call earlier. Derive it from
        // the snapshot the preview was handed: same rows, same truth, still zero host IO.
        // #10: an installed app with an EMPTY collection is invisible to a row-derived answer, so a
        // preview of a meta app lost it entirely when thumbnails moved from readonly (which
        // could read the registry) to inert (which cannot). The snapshot carries the roster when the
        // embedder has one; absent, the honest answer is still an empty list.
        if (tn === "list_apps") return { content: [], structuredContent: { apps: snap().apps || [] } };
        if (tn === "data_collections") {
          const bound = snap().collection;
          const counts = new Map();
          for (const it of snap().items || []) {
            const c = (it && it.collection) || bound;
            counts.set(c, (counts.get(c) || 0) + 1);
          }
          return { content: [], structuredContent: { collections: [...counts].map(([collection, items]) => ({ collection, items })) } };
        }
        return { content: [], structuredContent: {} };
      }
      case "sendMessage": case "updateContext":
        return null;
      default:
        return { isError: true, content: [{ type: "text", text: "not available in this preview" }] };
    }
  }

  return preset === "inert" ? inert : preset === "readonly" ? readonly : live;
}

/** Stub window.oma for a STANDALONE inert preview document (no embedder, no bridge): a
 *  server composing public preview pages has no parent runtime to guard through, so the
 *  document carries an inert oma seeded with a fixture snapshot — reads answer from it,
 *  writes resolve harmlessly, callTool answers empty, and the CSP above kills the network.
 *  This is the parentless twin of the guard's "inert" preset, and the ONE copy of the stub
 *  (its predecessors lived in library.html and the hosted data plane, hand-synced).
 *  The close tag is split so this source never contains a literal one; JSON's "</" become
 *  "<\/" (an identity escape in JS strings) so fixture data can't break out of the tag. */
export function stubOmaScript(name, items, apps) {
  const snap = { collection: name, items: items || [], version: 1, app: name, host: "library-preview",
    ...(apps && apps.length ? { apps } : {}) };
  return "<script>window.oma=(function(){var S=" +
    JSON.stringify(snap).replace(/<\//g, "<\\/") +
    ";var ok=Promise.resolve({ok:true});" +
    // Serve the fetch paths from the SAME fixture rows the snapshot carries — the parentless
    // twin of the guard's fxRows, and for the identical reason. It used to answer every
    // readCollection with {items:[]} and every callTool with {}, on the theory that an app
    // reads its data from oma.state. Half of them don't: self-fetching per collection is the
    // GUIDE's canonical pattern, and the guard's inert preset had already learned that an empty
    // envelope reads as CORRUPT data rather than as "no rows". Measured 2026-07-28 on this
    // machine: training-log rendered "0/0 · No entries yet" plus "Refresh failed: training-plan
    // returned invalid data", elder-days "Could not refresh all three data sets" — both with
    // fixtures sitting right there in the document. That is the PUBLIC preview path (hosted
    // /library today, share pages later), i.e. the copy a stranger sees first.
    "function R(c){var b=S.collection,w=(c==null?b:String(c)),o=[];" +
    "for(var i=0;i<S.items.length;i++){var it=S.items[i]||{};if(((it.collection||b))!==w)continue;" +
    "o.push({id:'fx-'+o.length,group:it.group||'',position:o.length+1,fields:it.fields||{},version:1});}" +
    "return {collection:w,items:o,version:S.version||1,returned:o.length,total:o.length};}" +
    // Object.create(null), not {} — a collection name is USER DATA, and `__proto__` / `constructor`
    // are legal names the store accepts. In a bare object literal `m["__proto__"]=1` writes the
    // prototype instead of a key (the collection disappears from the answer) and
    // `m["constructor"]||0` reads the inherited function, so the count came back as
    // "function Object() { [native code] }1". The guard's twin uses a Map and was always right;
    // this is the copy that had to be told.
    "function C(){var b=S.collection,m=Object.create(null),o=[];" +
    "for(var i=0;i<S.items.length;i++){var c=(S.items[i]&&S.items[i].collection)||b;m[c]=(m[c]||0)+1;}" +
    "for(var k in m)o.push({collection:k,items:m[k]});return o;}" +
    "return {get state(){return S},ready:function(cb){try{cb(S)}catch(e){}},onChange:function(){},onPrefChange:function(){}," +
    "pref:function(k,f){return f},setPref:function(){return ok},addItem:function(){return ok},updateItem:function(){return ok},moveItem:function(){return ok}," +
    "deleteItem:function(){return ok},refresh:function(){return Promise.resolve(R())}," +
    // The same two answers the parented inert guard gives. This is the machine that composes
    // PUBLIC preview pages (hosted /library today, share pages next), and a meta app asks
    // "which collections exist" before it asks for rows — answering that with an empty envelope
    // renders an app whose whole job is "show me everything" as though the user owned nothing.
    "callTool:function(n,a){return Promise.resolve(n==='data_list'?{content:[],structuredContent:R(a&&a.collection)}" +
    ":n==='data_collections'?{content:[],structuredContent:{collections:C()}}" +
    ":n==='list_apps'?{content:[],structuredContent:{apps:S.apps||[]}}" +
    ":{content:[],structuredContent:{}})}," +
    "readCollection:function(c){return Promise.resolve(R(c))},callFunction:function(){return ok}," +
    "files:{list:function(){return Promise.resolve({files:[]})},read:function(){return Promise.reject(new Error(\"not available in this preview\"))},url:function(){return Promise.reject(new Error(\"not available in this preview\"))}}," +
    "sendMessage:function(){return ok},updateContext:function(){return ok},toolInput:{app:S.app,collection:S.collection},host:S.host,standalone:true};})();</scr" +
    "ipt>";
}

/** A complete, self-contained inert preview document: CSP-first, caller-supplied token CSS,
 *  the stub above, and the app markup wholesale in OUR body (same anchoring doctrine
 *  as composeChildDoc). Consumed by the hosted /library preview server — which used to keep
 *  a hand-synced copy of every piece of this. */
// A preview iframe is `sandbox="allow-scripts"` with no `allow-same-origin` — deliberately, so the
// embedder cannot read `contentDocument.scrollHeight` and must be TOLD the height. The live runner
// has said so since it existed (HEIGHT_BROADCAST below), and this document, which is the one every
// gallery and store page actually embeds, did not — so an embedder had no choice but to guess a
// fixed window, and a taller app got cut off with no way to know it had been. Same message, same
// shape, one source: an embedder that handles `omaRunHeight` handles both documents.
const HEIGHT_BROADCAST =
  "<scr" + "ipt>(function(){var s=function(){try{parent.postMessage({omaRunHeight:true," +
  'h:document.documentElement.scrollHeight},"*")}catch(e){}};' +
  "if(typeof ResizeObserver==='function'){var ro=new ResizeObserver(s);" +
  'window.addEventListener("load",function(){ro.observe(document.body);s()})}' +
  'else window.addEventListener("load",s);})();</scr' + "ipt>";

export function composePreviewDoc(html, { name, items = [], apps = [], tokenCss = "", kitCss = "" } = {}) {
  return "<!doctype html><html><head>" + RUNNER_CSP +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    tokenCss + kitStyle(kitCss) + stubOmaScript(String(name || ""), items, apps) + "</head><body>" + html +
    HEIGHT_BROADCAST + "</body></html>";
}

/** Walk file_read's byte windows and hand back the whole file as base64 parts + metadata.
 *  Parts are decoded/concatenated by the caller (byte-level, so no alignment assumption).
 *  Lives here because both the direct-mode oma.files and the guard's filesRead share it. */
export async function readFileParts(callTool, app, path) {
  const parts = [];
  let offset = 0, meta = null;
  for (;;) {
    const r = await callTool("file_read", { app, path, ...(offset ? { offset } : {}) });
    if (r && r.isError) { const t = (r.content || []).find((c) => c.type === "text"); throw new Error((t && t.text.split("\n")[0]) || "file read failed"); }
    const sc = r && r.structuredContent;
    if (!sc || typeof sc.data_base64 !== "string") throw new Error("file read returned no bytes");
    if (!meta) meta = { mime: sc.mime, sha256: sc.sha256, size: sc.size };
    parts.push(sc.data_base64);
    if (sc.next_offset == null) return { ...meta, parts };
    offset = sc.next_offset;
  }
}
