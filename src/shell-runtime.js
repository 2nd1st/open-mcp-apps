// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// shell-runtime.js — the browser-side runtime injected into EVERY component.
//
// This is the whole reason AI-written components work: a component never touches the MCP
// bridge, uuids, versions, or persistence. It only calls the tiny `window.oma` API and
// re-renders on change. The shell owns the ui/initialize handshake, tool calls, idempotency
// keys, optimistic-concurrency versions, and host theming.
//
// NOT a security boundary (docs/security-model.md §2): this runtime shares the document with
// the component's own scripts, so nothing here can gate a hostile component. Untrusted
// (non-local) components run one level down behind the runner, never in direct mode.
//
// Bundled by build.mjs into dist/shell.js and inlined by shell.mjs when serving ui://.

import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from "@modelcontextprotocol/ext-apps";
import { isControlPlaneTool as _isControlPlaneTool } from "./tool-policy.mjs";

// Standalone mode: set by the browser viewer (http.mjs /view/<name>) when there is NO MCP
// host — tool calls go over plain fetch to the local /rpc endpoint instead of the bridge.
const SA = typeof window !== "undefined" ? window.__OMA_STANDALONE__ : undefined;

const app = new App({ name: "open-mcp-apps", version: "0.1.0" }, { tools: {} });

let state = { collection: null, items: [], version: 0, component: null, host: null };
let toolInput = {};
let ready = false;
const readyCbs = [];
const changeCbs = [];
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

function emit() {
  for (const cb of changeCbs) { try { cb(state); } catch (e) { console.error("[oma] onChange handler threw", e); } }
}
let refetchedOnMount = false;
let readying = false;
// The first ready() AND the first onChange() fire only after the pref cache is warm (or the
// 1000 ms cap expired — a late successful fetch then triggers a notifying re-ingest). First
// paint is pref-warm or deliberately fallback-only, never half-warm.
function markReady() {
  if (ready || readying) return;
  readying = true;
  const flush = () => {
    lastMerged = currentMerged();   // diff baseline — component identity is known by now
    ready = true;
    for (const cb of readyCbs.splice(0)) { try { cb(state); } catch (e) { console.error("[oma] ready handler threw", e); } }
    emit();                         // ONE warm first paint — covers onChange-only components
    // refetch-on-mount: the first snapshot may be a HOST-CACHED tool result replayed on
    // re-mount (e.g. after an app restart) — always pull fresh state once. The DB is the
    // truth; the widget is stateless.
    if (!refetchedOnMount) { refetchedOnMount = true; if (state.collection) window.oma.refresh().catch(() => {}); }
  };
  Promise.race([
    prefsPromise ?? (prefsPromise = syncPrefs()),
    new Promise((r) => setTimeout(r, 1000)),
  ]).then(flush, flush);
}
function applySnapshot(sc) {
  if (sc && Array.isArray(sc.items)) {
    // Skip the re-render when nothing changed (version is the global ledger seq) — background
    // refreshes must not clobber in-progress user input with an identical repaint.
    const unchanged = ready && sc.version === state.version && sc.collection === state.collection;
    state = {
      collection: sc.collection ?? state.collection,
      items: sc.items,
      version: sc.version ?? state.version,
      component: sc.component ?? state.component,
      host: sc.host ?? state.host,
    };
    if (!unchanged && ready) emit();                            // pre-ready emits deferred to flush
    if (ready && sc.settings_version !== lastSettingsVersion) { // refetch prefs only when settings changed
      lastSettingsVersion = sc.settings_version;
      schedulePrefSync();
    }
    markReady();
  }
}

// A shell-owned error banner: AI-written components rarely handle failures, so persistence
// problems must be visible without their cooperation. Attached to <html>, not <body> —
// components commonly rewrite body.innerHTML on render.
function omaNotify(msg) {
  let el = document.getElementById("__oma_notice");
  if (!el) {
    el = document.createElement("div");
    el.id = "__oma_notice";
    el.style.cssText = "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
      "background:#e5484d;color:#fff;padding:6px 14px;border-radius:8px;max-width:92%;" +
      "font:12.5px/1.45 -apple-system,system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3);display:none;";
    document.documentElement.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = "none"; }, 6000);
}

async function rawCall(name, args) {
  try {
    if (SA) {
      const res = await fetch(SA.endpoint || "/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, arguments: args }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json(); // a CallToolResult
    }
    return await app.callServerTool({ name, arguments: args });
  } catch (e) {
    // Tag every failure that originates from a TOOL CALL (host declined, bridge blip, transport
    // error). The render-health reporter must never mistake these for a broken component — a
    // transient environment failure would otherwise auto-revert a perfectly healthy version.
    if (e && typeof e === "object") { try { e.omaToolCallError = true; } catch {} }
    throw e;
  }
}

async function call(name, args) {
  try {
    // Any widget WRITE marks activity → the poll goes fast, so a burst of edits (and the AI's
    // replies to them) streams in at ~2s latency instead of the base cadence.
    if (name.indexOf("data_") === 0 && name !== "data_list") markActivity();
    const result = await rawCall(name, args);
    if (result && result.isError) {
      const t = (result.content || []).find((c) => c.type === "text");
      omaNotify("⚠ " + ((t && t.text) || "Action failed."));
    } else {
      const t = result && (result.content || []).find((c) => c.type === "text");
      if (t && /conflict|no longer exists/i.test(t.text)) omaNotify("⚠ " + t.text.split("\n")[0]);
    }
    applySnapshot(result && result.structuredContent);
    return result;
  } catch (e) {
    omaNotify("⚠ Not saved: " + ((e && e.message) || e) + " — the host may have blocked the call; try again or reopen the widget.");
    console.error("[oma] tool call failed", name, e);
    throw e;
  }
}

// ---- preferences: prefetched at boot, group-indexed (component-name-INDEPENDENT),
// merged lazily per read — identity may not be known yet when the data arrives.
// Resolver evaluated at EVERY use, never cached into data structures: the loader path
// learns the name only via ontoolinput/ontoolresult (guaranteed by ready()-flush time).
const compName = () =>
  state.component || (toolInput && toolInput.component) ||
  (typeof window !== "undefined" && window.__OMA_COMPONENT__) || null;

// Exact coercion, shared verbatim with the mini-bridges (docs/settings-design.md §2.1):
// the FALLBACK's type drives it, so junk stored values degrade to the fallback safely.
function coercePref(v, fallback) {
  const t = typeof fallback;
  if (t === "boolean") {
    if (v === true  || v === "true"  || v === 1) return true;
    if (v === false || v === "false" || v === 0) return false;
    return fallback;                                   // "25", "yes", {…} → fallback
  }
  if (t === "number") {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    if (typeof v === "boolean") return v ? 1 : 0;
    return fallback;                                   // "abc", "", {…} → fallback
  }
  if (t === "string") {
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return fallback;                                   // objects only via raw rows → fallback
  }
  return v === undefined ? fallback : v;               // exotic fallback type: raw pass-through
}

let prefItems = [];                  // raw settings rows, snapshot order (last wins)
let prefGlobal = new Map();          // key -> value           (group === "")
let prefByGroup = new Map();         // group -> Map(key -> value)
let lastMerged = new Map();          // diff baseline for onPrefChange
let lastSettingsVersion;             // gate: refetch only when settings actually changed
let prefsPromise = null, prefSyncTimer = null, prefSyncBusy = false, prefSyncQueued = false;
const prefCbs = [];

function indexPrefs(items) {
  prefItems = items; prefGlobal = new Map(); prefByGroup = new Map();
  for (const it of items) {                        // snapshot order ⇒ later rows overwrite
    const k = it.fields && it.fields.key;
    if (typeof k !== "string") continue;           // ignore junk rows
    if (it.group === "") prefGlobal.set(k, it.fields.value);
    else {
      if (!prefByGroup.has(it.group)) prefByGroup.set(it.group, new Map());
      prefByGroup.get(it.group).set(k, it.fields.value);
    }
  }
}
function currentMerged() {                         // merged view for THIS component, NOW
  const m = new Map(prefGlobal), g = prefByGroup.get(compName());
  if (g) for (const [k, v] of g) m.set(k, v);
  return m;
}
function rawPref(key) {                            // O(1), name resolved per call
  const g = prefByGroup.get(compName());
  if (g && g.has(key)) return g.get(key);
  return prefGlobal.has(key) ? prefGlobal.get(key) : undefined;
}
function ingestPrefs(items, notify) {
  indexPrefs(items);
  if (!notify) return;
  const next = currentMerged(), prev = lastMerged;
  lastMerged = next;
  const changed = [];
  const scopeOf = (k) => prefByGroup.get(compName())?.has(k) ? "component" : "global";
  for (const [k, v] of next) if (!prev.has(k) || prev.get(k) !== v)
    changed.push({ key: k, value: v, oldValue: prev.get(k), scope: scopeOf(k) });
  for (const [k, v] of prev) if (!next.has(k))
    changed.push({ key: k, value: undefined, oldValue: v, scope: "global" });
  if (changed.length) {
    for (const c of changed) for (const cb of prefCbs) { try { cb(c); } catch (e) { console.error("[oma] onPrefChange handler threw", e); } }
    emit();   // render-from-state components repaint with the new pref values for free
  }
}
async function syncPrefs() {
  if (prefSyncBusy) { prefSyncQueued = true; return; }
  prefSyncBusy = true;
  try {
    if (state.collection === "settings" && ready) ingestPrefs(state.items, true);  // settings app post-ready: no extra call
    else {
      const r = await rawCall("data_list", { collection: "settings" });            // rawCall: must NOT applySnapshot
      const sc = r && r.structuredContent;
      // monotonic gate: a slow fetch must never rewind a fresher setPref ingest
      if (sc && !(typeof lastSettingsVersion === "number" && sc.settings_version < lastSettingsVersion)) { lastSettingsVersion = sc.settings_version; ingestPrefs(sc.items || [], ready); }
    }        //                        notify = ready — silent only when it beat the flush
  } catch { /* defaults are fine; retried on the next settings_version change */ }
  finally {
    prefSyncBusy = false;
    if (prefSyncQueued) { prefSyncQueued = false; schedulePrefSync(); }
  }
}
function schedulePrefSync() {                      // debounced (250 ms)
  if (prefSyncTimer) return;
  prefSyncTimer = setTimeout(() => { prefSyncTimer = null; syncPrefs(); }, 250);
}

// ---- theming: adopt the host's design tokens (Claude light/dark, fonts, radii) ----
function applyTheme(ctx) {
  if (!ctx) return;
  try {
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles && ctx.styles.variables) applyHostStyleVariables(ctx.styles.variables);
    const css = ctx.styles && ctx.styles.css;
    if (css && typeof css.fontFaces === "string") applyHostFonts(css.fontFaces);
  } catch (_) { /* theming is best-effort */ }
}

// ---- the public API components are written against ----
window.oma = {
  /** Current snapshot: { collection, items: [{id, group, position, fields, version}], version } */
  get state() { return state; },
  /** cb(state) once the bridge is connected and initial data has arrived. */
  ready(cb) { if (ready) cb(state); else readyCbs.push(cb); },
  /** cb(state) after every data change (including your own mutations). */
  onChange(cb) { changeCbs.push(cb); },
  // actor:"human" in the writes below is enum-constrained AUDIT metadata, never authorization:
  // it is caller-chosen and forgeable in direct mode (security-model §1.4); only a
  // runner-stamped component identity is trustworthy write provenance.
  /** Add an item. fields is any JSON object your component defines. */
  addItem({ group = "", fields = {}, position } = {}) {
    return call("data_add_item", { command_id: uuid(), collection: state.collection, group, fields, position, actor: "human" });
  },
  // Widget mutations are LAST-WRITE-WINS (no expected_version) — the same choice setPref makes and
  // for the same reason. A live widget is the user rapidly clicking their OWN UI; sending
  // expected_version made two fast clicks on one item race — the 2nd carried the pre-echo STALE
  // version, so the store returned a spurious "Version conflict" that surfaced as an error banner
  // and blocked the interaction. The user is the single writer they can see; their click should
  // just apply. The rare AI-vs-user race converges via the mutation echo + the ~20s poll, and the
  // AI can still request OCC explicitly through the data_* tools when it genuinely needs it.
  /** Shallow-merge fields into an item (set a key to null to delete it). */
  updateItem(id, fields) {
    return call("data_update_item", { command_id: uuid(), id, fields, actor: "human" });
  },
  /** Move an item to another group (and/or position). */
  moveItem(id, group, position) {
    return call("data_move_item", { command_id: uuid(), id, group, position, actor: "human" });
  },
  /** Delete an item. */
  deleteItem(id) {
    return call("data_delete_item", { command_id: uuid(), id, actor: "human" });
  },
  /** Re-fetch the collection from the server. */
  refresh() { return state.collection ? call("data_list", { collection: state.collection }) : Promise.resolve(); },
  /**
   * SYNC merged preference read: own component override ▸ global ▸ fallback, computed
   * lazily at call time. The fallback's TYPE drives coercion (junk values → fallback).
   */
  pref(key, fallback) { return coercePref(rawPref(key), fallback); },
  /** cb({key, value, oldValue, scope}) — fired once per key whose EFFECTIVE (merged) value changed. */
  onPrefChange(cb) { prefCbs.push(cb); },
  /**
   * Persist one of THIS component's own settings (scalar values only). Own group only —
   * API-layer scoping, not a security boundary (docs/settings-design.md §8).
   */
  setPref(key, value) {
    const me = compName();
    if (!me) return Promise.reject(new Error("setPref: unknown component scope"));
    if (typeof key !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(key) || /^(security_|_)/.test(key))
      return Promise.reject(new Error("setPref: invalid or reserved key"));
    const t = typeof value;
    if (t !== "string" && t !== "number" && t !== "boolean")
      return Promise.reject(new Error("setPref: value must be a scalar"));
    if (t === "string" && value.length > 4096) return Promise.reject(new Error("setPref: value too long"));
    // LAST-WRITE-WINS on purpose: no expected_version (store.mjs skips the OCC check when it
    // is null). A scalar pref has no merge to protect, and OCC here would SILENTLY LOSE the
    // write: engine.mjs returns version conflicts as non-isError results whose only signal
    // is the "Version conflict" text that call() sniffs — and setPref must bypass call()
    // (its returned snapshot is the settings collection and must never reach applySnapshot).
    const existing = [...prefItems].reverse().find((it) => it.group === me && it.fields && it.fields.key === key);
    const add = () => rawCall("data_add_item",
      { command_id: uuid(), collection: "settings", group: me, fields: { key, value }, actor: "human" });
    const p = existing
      ? rawCall("data_update_item", { command_id: uuid(), id: existing.id, fields: { value }, actor: "human" })
          .then((r) => (r && r.isError ? add() : r))   // not_found (concurrent reset deleted it) → re-create
      : add();
    return p.then((r) => {
      if (r && r.isError) { omaNotify("⚠ Preference not saved."); return r; }
      const sc = r && r.structuredContent;
      if (sc && Array.isArray(sc.items) && !(typeof lastSettingsVersion === "number" && sc.settings_version < lastSettingsVersion)) { lastSettingsVersion = sc.settings_version; ingestPrefs(sc.items, true); }
      return r;
    });
  },
  /**
   * Escape hatch: call any tool on the server. SECURITY (security-model §5 v0.3): a full,
   * unmediated passthrough to every registered MCP tool — tolerable ONLY because direct mode
   * is local-authored-only; untrusted components run behind the runner, which filters calls.
   */
  callTool(name, args) { return rawCall(name, args || {}); },
  /** Arguments of the tool call that mounted this widget (e.g. {component, collection}). */
  get toolInput() { return toolInput; },
  /** Which host this widget is running in ("claude-ai", "chatgpt", "browser-viewer", …). */
  get host() { return state.host; },
  /** True when running in a plain browser page (no chat attached — sendMessage unavailable). */
  get standalone() { return !!SA; },
  /**
   * Base path for component→component links (e.g. `oma.viewBase + name`). Defaults to the
   * engine viewer's "/view/"; an embedding shell sets standalone.viewBase to its own mount
   * base so links resolve there. Single source of truth — components never hardcode "/view/".
   */
  get viewBase() { return (SA && typeof SA.viewBase === "string" && SA.viewBase) || "/view/"; },
  /**
   * True if `name` is a control-plane tool no component may call via callTool (registry /
   * security-policy mutation). The single source of truth (tool-policy.mjs) — a preview bridge
   * (e.g. settings.html) MUST gate on this rather than hand-maintaining its own denylist.
   */
  isControlPlaneTool(name) { return _isControlPlaneTool(name); },
  /**
   * Send a message into the chat AS THE USER (ui/message). Call ONLY from an explicit
   * user click (e.g. a "Send to AI" button) — never automatically.
   */
  sendMessage(text) {
    const t = String(text);
    // GLOBAL degradation: when the chat channel is unavailable (standalone page) or the host
    // rejects/fails the call (Codex widget-proxy -32000, openai/codex#28912), fall back to the
    // CLIPBOARD — the user pastes the text to their AI. Components just call sendMessage and
    // never need their own fallback; the success path (Claude Desktop) is untouched. The
    // degraded result is NOT an exception (isError + degraded tag), so components don't crash.
    const degrade = (why) => {
      let p;
      try { p = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(t) : Promise.reject(new Error("no clipboard")); }
      catch (e) { p = Promise.reject(e); }
      return p.then(
        () => { omaNotify("Copied to clipboard — paste it to your AI (" + why + ")."); return { isError: true, degraded: "clipboard" }; },
        () => { console.warn("[oma] sendMessage degraded (" + why + "); text:", t); omaNotify("Couldn't reach the chat (" + why + ") — the text is in the console."); return { isError: true, degraded: "console" }; });
    };
    if (SA) return degrade("no chat attached");
    return app.sendMessage({ role: "user", content: [{ type: "text", text: t }] })
      .then((r) => (r && r.isError ? degrade("host declined") : r))
      .catch((e) => degrade((e && e.message) || "send failed"));
  },
  /**
   * Silently update the AI's context (ui/update-model-context) — no chat message is
   * produced; the AI sees it on its next turn. Each call REPLACES the previous context.
   */
  updateContext(text) {
    if (SA) return Promise.resolve();
    return app.updateModelContext({ content: [{ type: "text", text: String(text) }] })
      .catch((e) => { console.error("[oma] updateContext failed", e); });
  },
};

// Staleness: the AI (or another host — CLI, another chat) can write via data_* while this
// widget sits on screen. ADAPTIVE poll while visible: each tick asks the server the cheap
// data_version probe and only a moved seq pays for a full data_list — so the idle cost is one
// tiny read per interval. After user activity (a click/keystroke/any widget write) or an
// observed remote change, the cadence drops to 2s and decays ×1.6 per quiet tick back to the
// base `widget_poll_seconds` — effective latency while someone is working is seconds.
// Per-tick pref read so `widget_poll_seconds` honors the merge rule (per-component override
// under group=<component>) and reacts to changes without a restart.
const pollMs = () => {
  const s = window.oma.pref("widget_poll_seconds", 20);   // coercePref handles junk
  return (s >= 5 && s <= 300 ? s : 20) * 1000;
};
const FAST_MS = 2000;
let pollDelay = 0;                                        // 0 = base cadence
function markActivity() { pollDelay = FAST_MS; }
async function pollTick() {
  if (ready && document.visibilityState === "visible" && state.collection) {
    try {
      const r = await rawCall("data_version", {});
      const sc = r && !r.isError ? r.structuredContent : null;
      const seq = sc && typeof sc.seq === "number" ? sc.seq : null;
      if (seq == null) await window.oma.refresh();        // engine predates data_version → old behavior
      else if (seq !== state.version) { await window.oma.refresh(); pollDelay = FAST_MS; } // hot: keep streaming
      else if (pollDelay) { pollDelay = Math.round(pollDelay * 1.6); if (pollDelay >= pollMs()) pollDelay = 0; }
    } catch { /* transient bridge failure — next tick retries */ }
  }
  setTimeout(pollTick, pollDelay || pollMs());
}
setTimeout(pollTick, pollMs());
document.addEventListener("visibilitychange", () => {
  if (ready && document.visibilityState === "visible") { markActivity(); window.oma.refresh().catch(() => {}); }
});
document.addEventListener("pointerdown", markActivity, { capture: true, passive: true });
document.addEventListener("keydown", markActivity, { capture: true, passive: true });

// ---- render-health: report a broken mount so the engine can AUTO-REVERT to the last good
// version (local tier only — the engine enforces that plus a per-run budget). Identity comes
// from the injected globals (__OMA_COMPONENT__/__OMA_COMPONENT_VERSION__ via wrapComponent, or
// set by the loader before mount); no identity/version → no report. First error only, within
// the initial window; earlier parse-time errors arrive via the __OMA_EARLY_ERRORS__ buffer
// (a classic script installed before any component code runs).
let bridgeReady;                                          // resolves when rawCall is usable
const bridgeReadyP = new Promise((r) => { bridgeReady = r; });
{
  const REPORT_WINDOW_MS = 8000;
  const t0 = Date.now();
  let reported = false;
  const report = (msg) => {
    if (reported) return;
    const component = compName();
    const version = typeof window !== "undefined" ? window.__OMA_COMPONENT_VERSION__ : undefined;
    if (!component || typeof version !== "number") return;
    reported = true;
    bridgeReadyP.then(() => rawCall("render_health", { component, version, ok: false, error: String(msg).slice(0, 300) }))
      .then((r) => {
        const sc = r && r.structuredContent;
        if (sc && sc.reverted) {
          omaNotify("This app's latest change broke it — rolled back to the previous working version. Reopen it to load the fix.");
          if (SA) setTimeout(() => { try { location.reload(); } catch {} }, 1200);  // /view refetches; host iframes need a reopen
        }
      }).catch(() => {});
  };
  for (const m of (typeof window !== "undefined" && window.__OMA_EARLY_ERRORS__) || []) report(m);
  window.addEventListener("error", (e) => { if (Date.now() - t0 < REPORT_WINDOW_MS) report((e && e.message) || "script error"); });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e && e.reason;
    if (r && r.omaToolCallError) return;   // environment/tool failure, NOT broken component code — never a revert trigger
    if (Date.now() - t0 < REPORT_WINDOW_MS) report((r && r.message) || r || "unhandled rejection");
  });
}

if (SA) {
  // Browser viewer: no MCP host, no bridge — bind directly and pull.
  state.collection = SA.collection || null;
  state.component = SA.component || null;
  state.host = "browser-viewer";
  prefsPromise = syncPrefs();  // SA.component is already set — even eager consumers are safe
  window.oma.refresh().catch((e) => omaNotify("Failed to load: " + ((e && e.message) || e)));
  bridgeReady();
  // Viewer SHELL (standalone pages only — host chats render the bare widget): a slim fixed top
  // bar so a browser-opened app has navigation and identity instead of floating raw in the tab.
  // Attached to <html> like omaNotify (components rewrite body.innerHTML), body pushed down via
  // an injected style so no component content hides underneath.
  // SA.chrome === false → skip bar AND stage: an embedding shell (hosted /app) owns the chrome,
  // and the widget renders bare exactly as it does inside a chat host iframe.
  if (SA.chrome !== false) try {
    const bar = document.createElement("div");
    bar.id = "__oma_viewer_bar";
    const st = document.createElement("style");
    // The STAGE: a quiet page background with the app centered on one elevated card, so every
    // component gets the same framing in the browser regardless of its own internal chrome.
    st.textContent = "#__oma_viewer_bar{position:fixed;top:0;left:0;right:0;z-index:2147483646;display:flex;align-items:center;gap:12px;height:46px;padding:0 16px;box-sizing:border-box;font:13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:var(--color-text-primary,CanvasText);background:color-mix(in srgb,var(--color-background-primary,Canvas) 82%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--color-border-secondary,color-mix(in srgb,CanvasText 12%,Canvas))}" +
      "#__oma_viewer_bar a{color:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px}" +
      "#__oma_viewer_bar a:hover{background:color-mix(in srgb,CanvasText 7%,transparent)}" +
      "#__oma_viewer_bar .oma-vb-name{font-weight:650}" +
      "#__oma_viewer_bar .oma-vb-brand{margin-left:auto;font-size:11.5px;letter-spacing:.02em;color:var(--color-text-tertiary,color-mix(in srgb,CanvasText 45%,Canvas))}" +
      "html{background:color-mix(in srgb,CanvasText 4%,var(--color-background-secondary,Canvas)) !important;min-height:100%}" +
      "body{max-width:1240px;box-sizing:border-box;margin:66px auto 48px !important;padding:22px !important;background:var(--color-background-primary,Canvas) !important;border:1px solid var(--color-border-secondary,color-mix(in srgb,CanvasText 12%,Canvas));border-radius:18px;box-shadow:0 16px 44px color-mix(in srgb,CanvasText 10%,transparent)}" +
      "@media (max-width:1320px){body{margin:58px 12px 28px !important;border-radius:14px}}";
    const back = document.createElement("a");
    back.href = "/";
    back.textContent = "← All apps";
    const name = document.createElement("span");
    name.className = "oma-vb-name";
    name.textContent = SA.component || "";
    const brand = document.createElement("span");
    brand.className = "oma-vb-brand";
    brand.textContent = "open-mcp-apps · browser view";
    bar.append(back, name, brand);
    const mountBar = () => { document.head.appendChild(st); document.documentElement.appendChild(bar); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountBar);
    else mountBar();
  } catch { /* the bar is cosmetic — never let it break the app */ }
  // Local realtime (SSE): /events pushes ledger seqs the moment anything commits; a moved seq
  // triggers the same refresh the poll would. Any failure just leaves the adaptive poll as the
  // fallback (EventSource auto-reconnects on transient drops).
  if (typeof EventSource === "function") {
    try {
      const es = new EventSource(SA.events || "/events");
      es.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (typeof d.seq === "number" && d.seq !== state.version) { markActivity(); window.oma.refresh().catch(() => {}); }
        } catch {}
      };
    } catch {}
  }
} else {
  // The host pushes the mounting tool's input + result after ui/initialize.
  app.ontoolinput = (params) => {
    const a = (params && (params.arguments || params)) || {};
    toolInput = a;
    if (typeof a.collection === "string" && a.collection) state.collection = a.collection;
  };
  app.ontoolresult = (result) => applySnapshot(result && result.structuredContent);
  app.onhostcontextchanged = (ctx) => applyTheme(ctx);
  app.onerror = (e) => console.error("[oma] bridge error", e);

  app.connect().then(() => {
    applyTheme(app.getHostContext());
    prefsPromise = syncPrefs();  // bridge must be connected before callServerTool works
    bridgeReady();               // render-health reports queued before connect can flush now
    // Fallback: if the host didn't push a tool result shortly after connect, pull once.
    // .catch is load-bearing: this was the one un-caught refresh — its rejection on a slow host
    // landed in the reporter's window and auto-reverted healthy components (review finding #1).
    setTimeout(() => { if (!ready && state.collection) window.oma.refresh().catch(() => {}); }, 800);
  }).catch((e) => console.error("[oma] connect failed", e));
}
