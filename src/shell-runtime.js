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
  if (SA) {
    const res = await fetch(SA.endpoint || "/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json(); // a CallToolResult
  }
  return app.callServerTool({ name, arguments: args });
}

async function call(name, args) {
  try {
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
const versionOf = (id) => { const it = state.items.find((i) => i.id === id); return it ? it.version : undefined; };

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
  /** Shallow-merge fields into an item (set a key to null to delete it). */
  updateItem(id, fields) {
    return call("data_update_item", { command_id: uuid(), id, fields, expected_version: versionOf(id), actor: "human" });
  },
  /** Move an item to another group (and/or position). */
  moveItem(id, group, position) {
    return call("data_move_item", { command_id: uuid(), id, group, position, expected_version: versionOf(id), actor: "human" });
  },
  /** Delete an item. */
  deleteItem(id) {
    return call("data_delete_item", { command_id: uuid(), id, expected_version: versionOf(id), actor: "human" });
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
   * Send a message into the chat AS THE USER (ui/message). Call ONLY from an explicit
   * user click (e.g. a "Send to AI" button) — never automatically.
   */
  sendMessage(text) {
    if (SA) {
      omaNotify("This page isn't attached to a chat — your data is saved; the AI will see it next time it looks.");
      return Promise.resolve({ isError: true });
    }
    return app.sendMessage({ role: "user", content: [{ type: "text", text: String(text) }] })
      .then((r) => { if (r && r.isError) omaNotify("⚠ The host declined to send the message."); return r; })
      .catch((e) => { omaNotify("⚠ Could not send: " + ((e && e.message) || e)); throw e; });
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
// widget sits on screen. Poll while visible; version-gated emit above makes this free when
// nothing changed. Also pull on tab-refocus for instant catch-up.
// Per-tick read so `widget_poll_seconds` honors the merge rule (per-component override
// under group=<component>) and reacts to changes without a restart.
const pollMs = () => {
  const s = window.oma.pref("widget_poll_seconds", 20);   // coercePref handles junk
  return (s >= 5 && s <= 300 ? s : 20) * 1000;
};
(function schedulePoll() {
  setTimeout(() => {
    if (ready && document.visibilityState === "visible") window.oma.refresh().catch(() => {});
    schedulePoll();
  }, pollMs());
})();
document.addEventListener("visibilitychange", () => {
  if (ready && document.visibilityState === "visible") window.oma.refresh().catch(() => {});
});

if (SA) {
  // Browser viewer: no MCP host, no bridge — bind directly and pull.
  state.collection = SA.collection || null;
  state.component = SA.component || null;
  state.host = "browser-viewer";
  prefsPromise = syncPrefs();  // SA.component is already set — even eager consumers are safe
  window.oma.refresh().catch((e) => omaNotify("Failed to load: " + ((e && e.message) || e)));
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
    // Fallback: if the host didn't push a tool result shortly after connect, pull once.
    setTimeout(() => { if (!ready && state.collection) window.oma.refresh(); }, 800);
  }).catch((e) => console.error("[oma] connect failed", e));
}
