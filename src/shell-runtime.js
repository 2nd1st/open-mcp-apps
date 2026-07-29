// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// shell-runtime.js — the browser-side runtime injected into EVERY app.
//
// This is the whole reason AI-written apps work: an app never touches the MCP
// bridge, uuids, versions, or persistence. It only calls the tiny `window.oma` API and
// re-renders on change. The shell owns the ui/initialize handshake, tool calls, idempotency
// keys, optimistic-concurrency versions, and host theming.
//
// Write-set D: every RULE this file lives by (the 0-RTT continuity decision, the adoption
// gate, the paged walk, the poll decisions, via) is a pure function in runtime-core.mjs,
// pinned by node tests; this file is the wiring. The sandbox machine (child doc composition,
// mini-bridge, caps chokepoint) lives ONCE in runner.mjs and is reached here as oma.embed.
//
// NOT a security boundary (docs/security-model.md §2): this runtime shares the document with
// the app's own scripts, so nothing here can gate a hostile app. Untrusted
// (non-local) apps run one level down behind the runner, never in direct mode.
//
// Bundled by build.mjs into dist/shell.js and inlined by shell.mjs when serving ui://.

import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from "@modelcontextprotocol/ext-apps";
import { isControlPlaneTool as _isControlPlaneTool } from "./tool-policy.mjs";
import { decideAck, applyAck, canAdopt, walkPages, decideProbe, decideChanges, viaOf, themeVars, childPreviewSnapshot, THEME_KEY_PREFIX, WALK_LIMIT, RUNTIME_CONTRACT } from "./runtime-core.mjs";
import { makeGuard, composeChildDoc, tokenCSS, BRIDGE, readFileParts } from "./runner.mjs";

// Standalone mode: set by the browser viewer (http.mjs /view/<name>) when there is NO MCP
// host — tool calls go over plain fetch to the local /rpc endpoint instead of the bridge.
const SA = typeof window !== "undefined" ? window.__OMA_STANDALONE__ : undefined;

// DECLARE NOTHING WE DO NOT IMPLEMENT (SPEC-26).
//
// This second argument is the widget's capability declaration, sent on every `ui/initialize`.
// It said `{ tools: {} }` — "this view serves tools" — while `oncalltool`, `onlisttools` and any
// view-side registerTool are ZERO hits across src/. ext-apps draft apps.mdx makes that two MUST
// violations (:1281, :1324): a declared capability has to be backed.
//
// Changed to `{}` — an honest empty declaration. We have NO reading on what a host does when a
// capability it saw yesterday is absent today, which is exactly why this rides alone in its own
// commit: if a host reacts badly it reverts as one line, tangled with nothing.
const hostApp = new App({ name: "open-mcp-apps", version: "0.1.0" }, {});

// `version` is the GLOBAL ledger seq of the last adopted read (stamped in the read's own
// transaction server-side); `total`/`truncated` are the walk's honesty marks — an app
// can render "N of M" instead of pretending a capped projection is the collection.
// The direct-embed (per-app resource) document carries its binding as an injected global:
// on hosts whose toolinput/toolresult pushes never deliver a collection (measured on Claude
// Desktop 1.24012.9 dynamic-tools mode), the widget otherwise reaches interactivity unbound and
// every write bounces off the server as collection:null.
const BOUND_HINT = (typeof window !== "undefined" && window.__OMA_COLLECTION_HINT__) || null;
// The SAME stamp, for the same reason, and it was missing. wrapApp injects both globals
// before the runtime evaluates, so a per-app document knows its own name at t=0 — but `app`
// started at null anyway, which left the first-wins rule in ontoolresult to be won by whoever
// spoke first. On a host that hands a widget another call's envelope (measured, ChatGPT web) or in
// a turn that opens two apps at once, that first speaker can be a DIFFERENT app, and this document
// would then answer with a name that is not its own. A document that was stamped with its identity
// should never have to be told what it is.
// Null on the universal loader, correctly: it is stamped only after it resolves and mounts.
const BAKED_NAME = (typeof window !== "undefined" && window.__OMA_APP__) || null;
let state = { collection: BOUND_HINT, items: [], version: 0, total: 0, truncated: false, app: BAKED_NAME, host: null };
let toolInput = {};
let readyDeadline = null;
let ready = false;
const readyCbs = [];
const changeCbs = [];
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

function emit() {
  for (const cb of changeCbs) { try { cb(state); } catch (e) { console.error("[oma] onChange handler threw", e); } }
}
let readying = false;
// The first ready() AND the first onChange() fire only after the pref cache is warm (or the
// 1000 ms cap expired — a late successful fetch then triggers a notifying re-ingest). First
// paint is pref-warm or deliberately fallback-only, never half-warm.
function markReady() {
  if (ready || readying) return;
  readying = true;
  const flush = () => {
    lastMerged = currentMerged();   // diff baseline — app identity is known by now
    // …and so is the PER-APP theme layer, which is why it is re-applied here. Prefs are fetched at
    // connect, in parallel with the host's ontoolinput, so ingestPrefs can (and on the universal
    // loader path usually does) run while compName() is still null — computing a theme with the
    // global layer only and no hook to revisit it. `pref()` is immune because it resolves the name
    // at every call; the theme is not, because it writes into the DOM once. Same hazard the line
    // above exists for. Idempotent: applyThemeVars diffs against what it last stamped.
    applyThemeVars(themeVars(currentMerged()));
    ready = true;
    for (const cb of readyCbs.splice(0)) { try { cb(state); } catch (e) { console.error("[oma] ready handler threw", e); } }
    emit();                         // ONE warm first paint — covers onChange-only apps
  };
  Promise.race([
    prefsPromise ?? (prefsPromise = syncPrefs()),
    new Promise((r) => setTimeout(r, 1000)),
  ]).then(flush, flush);
}

/** The adoption gate, wired: un-adoptable ⇒ keep the old projection. Skip the repaint when
 *  nothing changed (version + row count + binding) — background walks must not clobber
 *  in-progress user input with an identical repaint. */
function adopt(snap) {
  if (!canAdopt(state, snap)) return false;
  const unchanged = ready && snap.version === state.version && snap.items.length === state.items.length
    && (snap.collection ?? state.collection) === state.collection;
  state = {
    collection: snap.collection ?? state.collection,
    items: snap.items,
    version: snap.version ?? state.version,
    total: typeof snap.total === "number" ? snap.total : snap.items.length,
    truncated: !!snap.truncated,
    app: snap.app ?? state.app,
    host: snap.host ?? state.host,
  };
  if (!unchanged && ready) emit();                            // pre-ready emits deferred to flush
  if (ready && typeof snap.settings_version === "number" && snap.settings_version !== lastSettingsVersion) {
    lastSettingsVersion = snap.settings_version;              // refetch prefs only when settings changed
    schedulePrefSync();
  }
  markReady();
  return true;
}

// A shell-owned error banner: AI-written apps rarely handle failures, so persistence
// problems must be visible without their cooperation. Attached to <html>, not <body> —
// apps commonly rewrite body.innerHTML on render.
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

// A bridge request the host silently DROPS must reject, never hang: the ext-apps SDK has no
// timeout of its own, and an unsettled await here wedges whatever subsystem issued it for the
// widget's whole life — the poll chain never reschedules, syncPrefs' busy latch never clears,
// a walk never releases its single-flight slot. Observed on Claude Desktop 1.24012.9 (and
// Claude Code, same bridge stack): calls sent in an early post-mount window vanish — the
// renderer logs "oncalltool handler replaced" and requests on the replaced handler are lost.
// Ten seconds is far beyond any real engine round-trip; the rejection flows through the same
// tagged-error path as any transport failure, so render-health never blames the app.
const BRIDGE_DEADLINE_MS = 10_000;
function withDeadline(p, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(what + ": no reply in " + BRIDGE_DEADLINE_MS + "ms — the host may have dropped the request")), BRIDGE_DEADLINE_MS);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
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
    return await withDeadline(hostApp.callServerTool({ name, arguments: args }), name);
  } catch (e) {
    // Tag every failure that originates from a TOOL CALL (host declined, bridge blip, transport
    // error). The render-health reporter must never mistake these for a broken app — a
    // transient environment failure would otherwise auto-revert a perfectly healthy version.
    if (e && typeof e === "object") { try { e.omaToolCallError = true; } catch {} }
    throw e;
  }
}

// ---- the paged walk: how this widget reads its collection (write-set D) -------------------
// Reads are PAGES now (data_list, limit 500, cursor) and a widget owns its own walk: merge
// pages pinned to one version, restart when a write moves the stamp mid-walk, mark the
// projection truncated past the page cap instead of silently stopping. Mounting ALWAYS
// walks — a host may replay a CACHED tool result on re-mount, and the zero-row open carries
// no rows by design, so the walk (not the pushed result) is what the first paint stands on.

function pageFetcher(collection, opts = {}) {
  return async (cursor) => {
    const r = await rawCall("data_list", {
      collection,
      limit: opts.limit || WALK_LIMIT,
      ...(opts.group != null ? { group: opts.group } : {}),
      ...(opts.match ? { match: opts.match } : {}),
      ...(cursor ? { cursor } : {}),
    });
    return r && !r.isError ? r.structuredContent : null;
  };
}

/** Full paged read of ANY collection. Never touches widget state (the foreign-collection
 *  rebind class of bugs is structurally out). `filtered` marks group/match reads so the
 *  adoption gate never applies a completeness check they can't satisfy. */
async function readCollection(collection, opts = {}) {
  const coll = String(collection);
  const out = await walkPages(pageFetcher(coll, opts), opts.maxPages ? { maxPages: opts.maxPages } : undefined);
  if (out.error) throw new Error("read failed: " + out.error);
  return {
    collection: coll,
    items: out.items,
    version: out.version,
    settings_version: out.settings_version,
    files_version: out.files_version,
    total: out.total,
    truncated: !!out.truncated,
    ...(opts.group != null || opts.match ? { filtered: true } : {}),
    ...(out.torn ? { torn: true } : {}),
  };
}

let walking = null;   // single-flight: concurrent walk triggers share one pass
let walkAgain = false;
function walk() {
  if (!state.collection) return Promise.resolve();
  // Sharing an in-flight pass is right for two triggers that want the SAME answer, and wrong for a
  // trigger that appeared after that pass started reading: an in-flight walk that began before a
  // write cannot contain it, and handing it back as the write's reconciliation let a pre-write
  // snapshot adopt and take the optimistically-painted rows away again (they came back on the next
  // poll, so it read as a flicker of vanishing edits). A later request therefore queues ONE re-run
  // instead of being answered with a stale promise. Bounded to one: under sustained writes this
  // must converge, not chase.
  if (walking) { walkAgain = true; return walking; }
  walking = (async () => {
    try {
      const snap = await readCollection(state.collection);
      snap.host = state.host;
      adopt(snap);
      if (snap.torn) markActivity();   // writes kept landing mid-walk — converge on the fast poll
    } catch (e) {
      console.error("[oma] walk failed", e);
    } finally {
      walking = null;
    }
    if (walkAgain) { walkAgain = false; await walk(); }
  })();
  return walking;
}

// ---- writes: the continuity rule (0-RTT redraw) -------------------------------------------
// A write returns an ACK with the row it wrote, never the collection. decideAck's inequality
// (prev_collection_seq ≤ our read stamp) says whether applying just that row locally loses
// anything; when it can't, the click paints with ZERO extra round trips. The old text-regex
// conflict sniffing is dead — conflicts are structured (ok:false + note + current row).
let pendingWrites = 0;   // in-flight own writes: the SSE/probe change-check must not race the ack
let burstNeedsWalk = false;   // some ack in this burst could not be fully trusted — walk once, at the end
async function call(name, args) {
  pendingWrites++;
  try {
    // Any widget WRITE marks activity → the poll goes fast, so a burst of edits (and the AI's
    // replies to them) streams in at ~2s latency instead of the base cadence.
    if (name.indexOf("data_") === 0 && name !== "data_list") markActivity();
    const result = await rawCall(name, args);
    if (result && result.isError) {
      const t = (result.content || []).find((c) => c.type === "text");
      omaNotify("⚠ " + ((t && t.text) || "Action failed."));
      return result;
    }
    const sc = result && result.structuredContent;
    const d = decideAck(state, sc);
    if (d.kind === "conflict") {
      omaNotify("⚠ " + ((sc && sc.note) || "Write refused (" + ((sc && sc.reason) || "conflict") + ") — refreshed."));
      burstNeedsWalk = true;
    } else if (d.kind === "apply" || d.kind === "apply-refresh") {
      const rows = applyAck(state.items, sc);
      // The mark may only step to this ack's seq when NO sibling write is still in flight. An
      // overlapping write sits BELOW that seq and has not been applied yet, so advancing here
      // claimed a position our items did not hold — and the probe, seeing nothing move, never
      // went back for it. Sequential clicks (the common burst: each ack lands before the next
      // click) are still sole-in-flight, so the 0-RTT path is untouched; genuinely concurrent
      // writes pay exactly one walk, at the end of the burst.
      const advance = d.kind === "apply" && pendingWrites === 1;
      if (rows) {
        state = {
          ...state, items: rows,
          version: advance ? Math.max(Number(state.version) || 0, Number(sc.seq) || 0) : state.version,
          total: state.total + (rows.length - state.items.length),
        };
        if (state.collection === "settings") {
          if (advance) lastSettingsVersion = state.version;
          // ingestPrefs only emits when the MERGED map moved, and a settings widget writing ANOTHER
          // app's group (exactly what the settings app does) moves nothing of its own — so the
          // app that just wrote a row never re-rendered its own list, and the watermark had already
          // advanced so no poll would repair it. The bound state DID change: emit for it, and let
          // ingestPrefs handle the pref-cache side without owning the repaint.
          // notify:true keeps onPrefChange working; it returns whether it already repainted, so the
          // bound-state repaint happens exactly once either way.
          if (!ingestPrefs(rows, true)) emit();
        } else emit();
      }
      if (!advance || !rows) burstNeedsWalk = true;   // pick the concurrent write up
    } else if (d.kind === "stale") {
      // A receipt at or behind our watermark: the read we hold already contains it. Nothing to
      // paint, and — deliberately — no walk: paying for one would confirm what we already know.
    } else if (sc && sc.ok === true && sc.collection === "settings" && state.collection !== "settings") {
      schedulePrefSync();   // a cross-collection settings write (rare) — pref cache is stale
    }
    return result;
  } catch (e) {
    omaNotify("⚠ Not saved: " + ((e && e.message) || e) + " — the host may have blocked the call; try again or reopen the widget.");
    console.error("[oma] tool call failed", name, e);
    throw e;
  } finally {
    pendingWrites--;
    // One walk per BURST, not per ack: N overlapping writes would otherwise queue N walks that all
    // read the same thing. Deferring to the end also means the walk sees the whole burst landed.
    if (pendingWrites === 0 && burstNeedsWalk) { burstNeedsWalk = false; walk(); }
  }
}

// ---- preferences: prefetched at boot, group-indexed (app-name-INDEPENDENT),
// merged lazily per read — identity may not be known yet when the data arrives.
// Resolver evaluated at EVERY use, never cached into data structures: the loader path
// learns the name only via ontoolinput/ontoolresult (guaranteed by ready()-flush time).
// WHO WE ARE, most trustworthy first.
//
// `__OMA_APP__` is OURS: a per-app document is stamped with it at serve time by
// wrapApp, and on the loader path the loader writes it only after it has resolved and
// mounted the app. Either way it is a fact about the document we are running in. The other two
// come from the host, and the host can hand a widget another call's envelope — measured on
// ChatGPT web, both modes. It ranked LAST, so the one channel that cannot be misdelivered was
// the one we consulted only when the misdeliverable ones were empty.
const compName = () =>
  (typeof window !== "undefined" && window.__OMA_APP__) ||
  state.app || (toolInput && toolInput.app) || null;

// Exact coercion, shared verbatim with the mini-bridge (docs/settings-design.md §2.1):
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
function currentMerged() {                         // merged view for THIS app, NOW
  const m = new Map(prefGlobal), g = prefByGroup.get(compName());
  if (g) for (const [k, v] of g) m.set(k, v);
  return m;
}
function rawPref(key) {                            // O(1), name resolved per call
  const g = prefByGroup.get(compName());
  if (g && g.has(key)) return g.get(key);
  return prefGlobal.has(key) ? prefGlobal.get(key) : undefined;
}
/** Returns TRUE when it emitted, so a caller whose own state also changed can avoid a second
 *  repaint without having to guess (see call()'s settings branch). */
function ingestPrefs(items, notify) {
  indexPrefs(items);
  applyThemeVars(themeVars(currentMerged()));   // the theme layer rides the SAME rows and merge
  if (!notify) return false;
  const next = currentMerged(), prev = lastMerged;
  lastMerged = next;
  const changed = [];
  const scopeOf = (k) => prefByGroup.get(compName())?.has(k) ? "app" : "global";
  for (const [k, v] of next) if (!prev.has(k) || prev.get(k) !== v)
    changed.push({ key: k, value: v, oldValue: prev.get(k), scope: scopeOf(k) });
  for (const [k, v] of prev) if (!next.has(k))
    changed.push({ key: k, value: undefined, oldValue: v, scope: "global" });
  if (changed.length) {
    for (const c of changed) for (const cb of prefCbs) { try { cb(c); } catch (e) { console.error("[oma] onPrefChange handler threw", e); } }
    emit();   // render-from-state apps repaint with the new pref values for free
    return true;
  }
  return false;
}
async function syncPrefs() {
  if (prefSyncBusy) { prefSyncQueued = true; return; }
  prefSyncBusy = true;
  try {
    if (state.collection === "settings" && ready) ingestPrefs(state.items, true);  // settings app post-ready: no extra call
    else {
      const sc = await readCollection("settings");                                 // full walk — >100 pref rows must not half-load
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
let hostVars = null;              // the host's own variable map, kept so a removed theme token
                                  // can be RESTORED to it rather than merely dropped
// The host context is not only paint. `McpUiHostContext.toolInfo` carries the JSON-RPC id and the
// tool definition of THE CALL THAT INSTANTIATED THIS WIDGET (ext-apps spec.types.d.ts
// McpUiHostContext), and the type ends in `[key: string]: unknown`, so a host may put more there.
// We read this object for colours and dropped everything else on the floor — the same shape of
// mistake as taking identity from the tool-result channel alone (see ontoolresult below): the host
// may already be saying who we are through a door nobody opened. It is kept WHOLE and MERGED,
// because host-context-changed delivers PARTIAL updates, and exposed read-only so the loader's
// failure surface can report what it was actually handed instead of guessing.
// REMEMBERING WHO WE ARE, ACROSS A RE-RENDER THE HOST GETS WRONG.
//
// Measured on ChatGPT web, 2026-07-29, with the loader's own diagnostic dump. When an assistant
// turn contains more than one tool call, the FIRST mount is bound correctly — and a later
// re-render replays the FIRST call of that turn instead of the one that opened the app:
//
//   turn: get_app{name:"dev-probe"} → open_app{app:"dev-probe"}
//   after refresh the widget was handed  toolInput = {name:"dev-probe"}
//                                        toolInfo.tool = get_app's definition
//   turn: data_collections{} → open_app{...}
//   after refresh                        toolInput = {}   toolInfo.tool = data_collections
//
// Both are verbatim the OTHER call's arguments, so this is not "the host sent nothing" — it is the
// host confidently sending the wrong envelope. No amount of waiting fixes that, and no guard can
// tell a wrong envelope from a right one. The MCP Apps spec has no clause on which call a view
// belongs to when a turn has several (lane D checked the draft in full), so this is host
// discretion, not a violation — Codex gets it right on the same build.
//
// The way out is not to be told twice: the FIRST mount does know, so write it down somewhere the
// host itself carries across renders. ChatGPT exposes exactly that as `window.openai` —
// `setWidgetState` / `widgetState`, per-widget-instance and replayed on re-render. It is vendor
// API, so it is feature-detected and namespaced under one key; a host without it loses nothing it
// had. This also covers the case a binding fix never could: a re-render that replays NOTHING.
const STATE_KEY = "__oma";
function rememberIdentity() {
  try {
    const oai = window.openai;
    if (!oai || typeof oai.setWidgetState !== "function") return;
    const name = toolInput.app || state.app;
    if (!name) return;
    const prev = oai.widgetState || {};
    const mine = prev[STATE_KEY] || {};
    if (mine.app === name && mine.collection === state.collection && mine.host === state.host) return;
    // Preserve whatever the app itself keeps here — we are a guest in this object. `host` rides
    // along because it has the same shape of problem: it can only arrive on a channel a mis-bound
    // re-render never delivers, which is why a refreshed widget reported host:null all week. This
    // is not a second derivation of it — it is the one we were told, written down.
    oai.setWidgetState({ ...prev, [STATE_KEY]: {
      app: name, collection: state.collection || null, host: state.host || null } });
  } catch (_) { /* a host that rejects the write leaves us exactly where we were */ }
}
/** What the host replayed to us about ourselves, if it kept anything. Read-only. */
function recallIdentity() {
  try { return (window.openai?.widgetState || {})[STATE_KEY] || null; } catch (_) { return null; }
}

// Internal, for the same reason as the host context below: the ONE caller is the loader document,
// and an app that had to ask which app it is would be a bug in the app, not a missing API.
//
// This was a SUBSCRIPTION until 2026-07-29 — hand it a callback and it would fire when identity
// eventually arrived. It never could, in the one case it was written for: a re-render bound to
// another call is handed that call's envelope, which carries no name, so the announcement below
// returned early and the subscriber waited out its whole window for a message that was never
// coming. It is a plain question now, answered from what we know and what the host kept for us.
try {
  window.__OMA_IDENTITY__ = () => {
    const name = toolInput.app || state.app;
    if (name) return name;
    // Nothing live — but the host may be carrying the note we wrote on a previous mount. This is
    // what survives a re-render the host binds to the wrong call.
    const kept = recallIdentity();
    if (!kept || !kept.app) return null;
    if (!state.app) state.app = kept.app;
    if (!state.collection && kept.collection) state.collection = kept.collection;
    if (!state.host && kept.host) state.host = kept.host;
    return kept.app;
  };
} catch (_) { /* no window (test rig): the loader is the only caller and it has one */ }

// Deliberately NOT on window.oma: RUNTIME.md is a promise to app authors, and `toolInfo` — a
// JSON-RPC id plus a tool definition — is engine plumbing, not something an app should be built
// on. Whether authors should get the useful half (platform, displayMode, locale, timeZone) is a
// separate API decision that deserves its own thinking, not a passenger on this one. So it rides
// the same internal __OMA_* channel the loader already uses for app identity.
function applyTheme(ctx) {
  if (!ctx) return;
  try {
    const prev = window.__OMA_HOST_CONTEXT__;
    window.__OMA_HOST_CONTEXT__ = prev ? { ...prev, ...ctx } : { ...ctx };
  } catch (_) { /* a frozen window is not worth failing paint over */ }
  try {
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles && ctx.styles.variables) { hostVars = ctx.styles.variables; applyHostStyleVariables(ctx.styles.variables); }
    const css = ctx.styles && ctx.styles.css;
    if (css && typeof css.fontFaces === "string") applyHostFonts(css.fontFaces);
  } catch (_) { /* theming is best-effort */ }
  // The host writes its variables as INLINE properties on <html>, which outranks any stylesheet.
  // The user's theme is the layer ABOVE the host's, so it has to be re-stamped through the same
  // door afterwards — and host context can arrive at any time, including after a pref change.
  applyThemeVars(themeVars(currentMerged()));
}

// The user theme layer: `theme:--*` settings rows, merged per oma.pref's own rule (this
// app's group overrides global), stamped as inline custom properties. Values were already
// charset-checked by themeVars; nothing here can carry a selector or escape a declaration.
let themeApplied = new Map();
/** The token names our theme stamped that are scoped to THIS app only. A child embedded by
 *  us must not inherit them (see tokenCSS's `substitute`): global theme tokens apply to the child
 *  too and are fine to pass down, a per-app one is by definition not the child's. */
function ownThemeNames() {
  const g = prefByGroup.get(compName());
  const out = [];
  if (!g) return out;
  for (const k of g.keys()) {
    if (typeof k !== "string" || k.slice(0, THEME_KEY_PREFIX.length) !== THEME_KEY_PREFIX) continue;
    out.push(k.slice(THEME_KEY_PREFIX.length));
  }
  return out;
}
/** What the child should see instead of our per-app value: the host's own value where the host gave
 *  one (the layer directly beneath the theme), else nothing — the child's fallback sheet answers. */
function childTokenSubstitutes() {
  const out = {};
  for (const n of ownThemeNames()) out[n] = hostVars && hostVars[n] != null ? hostVars[n] : null;
  return out;
}
function applyThemeVars(pairs) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const next = new Map(pairs);
  for (const name of themeApplied.keys()) {
    if (next.has(name)) continue;                       // still themed — the set below rewrites it
    if (hostVars && hostVars[name] != null) root.style.setProperty(name, hostVars[name]);
    else root.style.removeProperty(name);               // …falling back to the injected stylesheet
  }
  for (const [name, value] of next) root.style.setProperty(name, value);
  themeApplied = next;
}

// ---- files (read side): list / bytes / object URL — the knowledge-card render path --------
const fileUrlCache = new Map();   // path -> {sha256, url}
async function fileBytes(app, path) {
  const { parts, mime, sha256 } = await readFileParts(rawCall, app, path);
  // Decode per window and concatenate BYTES (windows are raw byte ranges; base64 strings of
  // adjacent windows are not concatenation-safe unless 3-aligned, so we never assume it).
  const chunks = parts.map((p) => { const s = atob(p); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; });
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  // Whole-file hash check, best-effort: subtle is absent in some sandboxed contexts.
  if (sha256 && globalThis.crypto?.subtle) {
    try {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (hex !== sha256) throw new Error("file bytes failed the sha256 check — try again");
    } catch (e) { if (e && /sha256 check/.test(String(e.message))) throw e; }
  }
  return { bytes, mime, sha256 };
}

// The child is a separate document, so it inherits none of our CSS — the system UI kit has to
// travel with it. We take it from OUR OWN head rather than bundling a second copy: every
// document that runs this runtime was composed by wrapApp/wrapLoader, and both inject
// the kit under the same data-oma marker. One copy of the bytes, no build step, no drift.
// The neutral token FALLBACK sheet, read the same way and for the same reason as the kit. The child
// had no fallback layer at all before: every token it saw was whatever the parent's computed value
// happened to be, so a name we now deliberately omit (the per-app theme repair above) would resolve
// to nothing. With the fallbacks underneath, omitting is safe and the child's cascade matches the
// parent's shape: fallbacks → host/substituted tokens → kit → theme (pushed) → its own <style>.
let fallbackCache = null;
function ownFallbackCss() {
  if (fallbackCache == null) {
    const el = document.querySelector('style[data-oma="tokens"]');
    fallbackCache = el ? el.textContent : "";
  }
  return fallbackCache;
}

let kitCache = null;
function ownKitCss() {
  if (kitCache == null) {
    const el = document.querySelector('style[data-oma="kit"]');
    kitCache = el ? el.textContent : "";
  }
  return kitCache;
}

// ---- live embeds: parent-side registry so embedded children stay fresh --------------------
// The embedder's own poll watches ONE collection; embedded children bound elsewhere ride the
// same probe — on a moved global seq each live embed checks its own collection with one
// data_changes call and re-walks only when something actually happened there.
const liveEmbeds = new Set();

// ---- the public API apps are written against ----
window.oma = {
  /** Current snapshot: { collection, items: [{id, group, position, fields, version}], version,
   *  total, truncated } — total/truncated let an app say "N of M" honestly. */
  get state() { return state; },
  /** cb(state) once the bridge is connected and initial data has arrived — or, if that never
   *  happens, AFTER A DEADLINE with whatever state we have.
   *
   *  It used to wait forever. That is the shape of every silent failure: the caller has no way to
   *  tell "still coming" from "never coming", so an app whose first paint hangs on ready() shows a
   *  spinner for the rest of the session. Measured on a page refresh (prod and stg): the bridge
   *  never delivered, so the loader's entire retry ladder — which lives inside this callback —
   *  never started, and not one request reached the server.
   *
   *  Releasing late with empty state is not a great answer, but it is an ANSWER: the caller runs,
   *  discovers there is nothing, and can say so. onChange still fires if data arrives afterwards.
   *  8s is deliberately under the runtime's own 10s per-call bridge deadline, so a callback
   *  released here still gets a full window for its first call, and above every measured healthy
   *  handshake (sub-second on all hosts we have readings for). */
  ready(cb) {
    if (ready) return cb(state);
    readyCbs.push(cb);
    // ONE timer at a time, and a new one after each firing. The first version only ever armed one:
    // it checked `readyDeadline == null`, and the handle was never cleared, so once the deadline had
    // fired with `ready` still false, every LATER ready(cb) queued behind a spent timer and waited
    // forever — the exact silent hang this deadline exists to end, reintroduced for anyone
    // registering after the first 8 seconds. Clearing the handle inside the callback restores the
    // guarantee to every caller: if the host is still silent, the next registration gets its own
    // window rather than inheriting an expired one.
    if (readyDeadline == null) readyDeadline = setTimeout(() => {
      readyDeadline = null;
      if (ready) return;
      const waiting = readyCbs.splice(0);
      console.warn("[oma] ready deadline: the host never delivered initial state; releasing " +
        waiting.length + " callback(s) with an empty snapshot");
      for (const fn of waiting) { try { fn(state); } catch (e) { console.error("[oma] ready callback failed", e); } }
    }, 8000);
  },
  /** cb(state) after every data change (including your own mutations). */
  onChange(cb) { changeCbs.push(cb); },
  // actor:"human" in the writes below is enum-constrained AUDIT metadata, never authorization:
  // it is caller-chosen and forgeable in direct mode (security-model §1.4); only a
  // runner-stamped app identity is trustworthy write provenance. `via` is the same
  // class of metadata — the app's shadow edge for the Data pane, stripped from every
  // AI-facing read.
  /** Add an item. fields is any JSON object your app defines. */
  addItem({ group = "", fields = {}, position } = {}) {
    // Direct-embed mode can reach interactivity before any toolinput/toolresult has delivered a
    // binding; sending collection:null just bounces off the server as -32602. Fail loudly and
    // locally instead — the next poll/toolresult binds and the user's retry succeeds.
    if (!state.collection) {
      omaNotify("⚠ No collection bound yet — try again in a moment.");
      return Promise.reject(new Error("no collection bound yet"));
    }
    return call("data_add_item", { command_id: uuid(), collection: state.collection, group, fields, position, actor: "human", via: viaOf(compName()) });
  },
  // Widget mutations are LAST-WRITE-WINS (no expected_version) — the same choice setPref makes and
  // for the same reason. A live widget is the user rapidly clicking their OWN UI; sending
  // expected_version made two fast clicks on one item race — the 2nd carried the pre-echo STALE
  // version, so the store returned a spurious "Version conflict" that surfaced as an error banner
  // and blocked the interaction. The user is the single writer they can see; their click should
  // just apply. The rare AI-vs-user race converges via the ack continuity rule + the poll, and the
  // AI can still request OCC explicitly through the data_* tools when it genuinely needs it.
  /** Shallow-merge fields into an item (set a key to null to delete it). */
  updateItem(id, fields) {
    return call("data_update_item", { command_id: uuid(), id, fields, actor: "human", via: viaOf(compName()) });
  },
  /** Move an item to another group (and/or position). */
  moveItem(id, group, position) {
    return call("data_move_item", { command_id: uuid(), id, group, position, actor: "human", via: viaOf(compName()) });
  },
  /** Delete an item. */
  deleteItem(id) {
    return call("data_delete_item", { command_id: uuid(), id, actor: "human", via: viaOf(compName()) });
  },
  /** Re-read the bound collection (a full paged walk; adopted through the gate). */
  refresh() { return walk(); },
  /**
   * Read ANY collection as a full paged walk — items/version/total/truncated — WITHOUT
   * touching this widget's own bound state. opts: {group, match, limit, maxPages}.
   */
  readCollection(collection, opts) { return readCollection(collection, opts); },
  /**
   * SYNC merged preference read: own app override ▸ global ▸ fallback, computed
   * lazily at call time. The fallback's TYPE drives coercion (junk values → fallback).
   */
  pref(key, fallback) { return coercePref(rawPref(key), fallback); },
  /** cb({key, value, oldValue, scope}) — fired once per key whose EFFECTIVE (merged) value changed. */
  onPrefChange(cb) { prefCbs.push(cb); },
  /**
   * Persist one of THIS app's own settings (scalar values only). Own group only —
   * API-layer scoping, not a security boundary (docs/settings-design.md §8).
   */
  setPref(key, value) {
    const me = compName();
    if (!me) return Promise.reject(new Error("setPref: unknown app scope"));
    if (typeof key !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(key) || /^(security_|_)/.test(key))
      return Promise.reject(new Error("setPref: invalid or reserved key"));
    const t = typeof value;
    if (t !== "string" && t !== "number" && t !== "boolean")
      return Promise.reject(new Error("setPref: value must be a scalar"));
    if (t === "string" && value.length > 4096) return Promise.reject(new Error("setPref: value too long"));
    // LAST-WRITE-WINS on purpose: no expected_version (a scalar pref has no merge to protect).
    // Must bypass call(): its ack handling is scoped to the BOUND collection, and a pref write
    // targets settings. The ack's own row is ingested locally instead — a settings event's seq
    // IS the settings_version, so the pref cache stays exact with zero extra reads.
    const existing = [...prefItems].reverse().find((it) => it.group === me && it.fields && it.fields.key === key);
    const via = viaOf(me);
    const add = () => rawCall("data_add_item",
      { command_id: uuid(), collection: "settings", group: me, fields: { key, value }, actor: "human", via });
    const p = existing
      ? rawCall("data_update_item", { command_id: uuid(), id: existing.id, fields: { value }, actor: "human", via })
          .then((r) => (r && r.isError ? add() : r))   // not_found (concurrent reset deleted it) → re-create
      : add();
    return p.then((r) => {
      const sc = r && r.structuredContent;
      if (r && r.isError || (sc && sc.ok === false)) { omaNotify("⚠ Preference not saved."); return r; }
      // Staleness is a PER-ROW question, not a per-collection one. Dropping the whole ack because
      // some other key's write landed first threw away this key's value until the next full
      // settings sync — and two setPref calls in flight is the ordinary case (a settings form).
      // applyAck refuses only the rows that are actually superseded (row.version > ack.seq), and
      // the watermark takes the max, so a late-but-lower ack can never rewind it.
      if (sc && sc.item) {
        const rows = applyAck(prefItems, sc);
        if (rows) {
          // Merging the row is always safe; MOVING THE WATERMARK is not. lastSettingsVersion is
          // what data_version's settings_version is compared against, so claiming this write's seq
          // asserts we have seen everything up to it — and a concurrent write by another actor sits
          // below it, unread. Then the probe finds settings_version equal to what we hold and never
          // syncs, so that key stays missing until some later settings event. Same inequality the
          // bound collection uses: only a receipt whose `prev` is inside our mark may advance it.
          const prev = Number(sc.prev_collection_seq);
          const held = Number(lastSettingsVersion) || 0;
          if (Number.isFinite(prev) && prev <= held) lastSettingsVersion = Math.max(held, Number(sc.seq) || 0);
          else schedulePrefSync();   // something else touched settings first — go read it
          ingestPrefs(rows, true);
        }
      }
      return r;
    });
  },
  /**
   * Escape hatch: call any tool on the server. SECURITY (security-model §5 v0.3): a full,
   * unmediated passthrough to every registered MCP tool — tolerable ONLY because direct mode
   * is local-authored-only; untrusted apps run behind the runner, which filters calls.
   */
  callTool(name, args) { return rawCall(name, args || {}); },
  /** Per-app FILES, read side: list(), read(path) → Uint8Array, url(path) → object URL you can
   *  put straight into <img src>/<a href>. Files are written by the AI (file_write); this is
   *  how an app renders them. */
  files: {
    list() {
      const me = compName();
      return rawCall("file_list", { app: me }).then((r) => (r && r.structuredContent) || { files: [] });
    },
    read(path) {
      return fileBytes(compName(), String(path)).then((f) => f.bytes);
    },
    url(path) {
      const p = String(path);
      const hit = fileUrlCache.get(p);
      return fileBytes(compName(), p).then((f) => {
        if (hit && hit.sha256 === f.sha256) return hit.url;
        if (hit) { try { URL.revokeObjectURL(hit.url); } catch {} }
        const url = URL.createObjectURL(new Blob([f.bytes], { type: f.mime || "application/octet-stream" }));
        fileUrlCache.set(p, { sha256: f.sha256, url });
        return url;
      });
    },
  },
  /**
   * Call one of THIS app's own #oma-manifest functions (data in → data out; functions
   * never touch UI — the data change comes back through the normal reactive loop). The callee
   * is always this app: cross-app calls arrive with the function pillar's
   * callable caps, not before.
   */
  callFunction(fn, args) {
    const me = compName();
    return rawCall("call_function", { app: me, function: String(fn), args: args || {}, command_id: uuid(), via: viaOf(me) });
  },
  /**
   * Mount another app INSIDE this one (sandboxed, caps-enforced — the same runner
   * machine the loader uses; depth 1: an embedded child cannot embed further).
   * opts: { into: Element (required), preset: "live"|"readonly"|"inert", collection, html,
   *         snapshot, heights: {min,max}|false }.
   * Returns { el, unmount, refresh }.
   */
  async embed(name, opts = {}) {
    const n = String(name);
    if (!opts.into || typeof opts.into.appendChild !== "function") throw new Error("embed: opts.into element required");
    const preset = opts.preset || "live";
    let html = opts.html, caps = opts.caps, tier = opts.tier;
    // Inert children never call anything, so provided html is all they need; every other
    // preset resolves the engine truth (source + tier + caps) unless the caller provided it.
    if ((html == null || caps == null) && !(preset === "inert" && html != null)) {
      const r = await rawCall("app_html", { name: n });
      const sc = (r && r.structuredContent) || {};
      if (!sc.html) throw new Error('embed: app "' + n + '" not found');
      if (html == null) html = sc.html;
      if (caps == null) caps = sc.caps || {};
      if (tier == null) tier = sc.tier == null ? "local" : sc.tier;
    }
    if (caps == null) caps = {};
    if (tier == null) tier = "local";
    // A caller-supplied snapshot is a SHARED one: the embedder fetched every collection once and
    // hands each child its share. childPreviewSnapshot cuts that share and picks the binding by the
    // engine's own rule — kept there so the embedder does not have to know either, and so the two
    // preview machines (this one and composePreviewDoc's) cannot drift apart again. An explicit
    // opts.collection still wins: a caller that names a binding means it.
    const share = opts.snapshot
      ? childPreviewSnapshot(opts.snapshot.items, { app: n, declaration: opts.declaration, apps: opts.snapshot.apps, tier })
      : null;
    const coll = String(opts.collection || (share && share.collection) || (opts.snapshot && opts.snapshot.collection) || n);
    let childSnap = share
      ? { collection: coll, items: share.items, apps: share.apps, version: opts.snapshot.version || 0, app: n, host: state.host }
      : { collection: coll, items: [], version: 0, app: n, host: state.host };

    let prefMap = null, compKeys = {}, settingsIds = new Set();
    let prefVersion = -1;     // settings_version behind prefMap — a slow read must not rewind it
    let dead = false;         // set by unmount(); every in-flight boot/read result checks it
    function rebuildPrefs(rows, ver) {
      if (dead) return;
      if (typeof ver === "number") {
        if (ver < prefVersion) return;   // a boot read that finished LATE is not newer information
        prefVersion = ver;
      }
      settingsIds = new Set(rows.map((i) => i.id));
      const base = {}, over = {};
      for (const it of rows) {
        const k = it.fields && it.fields.key;
        if (typeof k !== "string") continue;
        if (it.group === "") base[k] = it.fields.value;
        else if (it.group === n) over[k] = it.fields.value;
      }
      compKeys = {};
      for (const k in over) compKeys[k] = 1;
      prefMap = Object.assign(base, over);
    }

    const guard = makeGuard({
      name: n, coll, caps, tier, preset,
      io: {
        callTool: rawCall,
        sendMessage: (t) => window.oma.sendMessage(t),
        updateContext: (t) => window.oma.updateContext(t),
        snapshot: () => childSnap,
        settingsIds: () => settingsIds,
        readCollection,
        readFile: (app, path) => fileBytes(app, path).then((f) => {
          let s = ""; const b = f.bytes;
          for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
          return { base64: btoa(s), mime: f.mime };
        }),
        notify: omaNotify,
        confirm: (m) => { try { return typeof window.confirm === "function" && window.confirm(m) === true; } catch { return false; } },
        uuid,
      },
    });

    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    // heights:false hands ALL sizing to the embedder's own CSS (scaled thumbnails, preview
    // fit) — no inline size properties to out-specificity a stylesheet.
    const H = opts.heights === false ? null : opts.heights || { min: 60, max: 20000 };
    frame.style.cssText = "display:block;border:0;" + (H ? "width:100%;height:" + Math.max(H.min, 140) + "px" : "");

    // `changed` exists for the apply-refresh case: an optimistic local apply deliberately does NOT
    // move childSnap.version, so an UPDATE (same row count, same version) was invisible to the
    // bridge's own change test and the child's successful click stayed on screen as the old value
    // until a refresh landed — indefinitely if it failed. The parent knows it just mutated rows;
    // it says so, instead of the child having to infer it.
    function push(changed) {
      if (!frame.contentWindow) return;
      frame.contentWindow.postMessage({
        omaRunSnapshot: true,
        ...(changed ? { changed: true } : {}),
        snapshot: { collection: childSnap.collection || coll, items: childSnap.items || [], version: childSnap.version || 0, app: n, host: state.host },
        toolInput: { app: n, collection: coll },
        prefs: prefMap || {},
        compKeys,
        // The theme layer for THIS child, resolved here: prefMap already merged global with the
        // child's own group, and themeVars already dropped anything failing the token charsets.
        // The child applies the pairs verbatim — no second copy of the rule inside the bridge.
        themeVars: themeVars(prefMap || {}),
      }, "*");
    }

    // Prefs + first data, per preset: live walks both in full; readonly reads prefs plus ONE
    // first page of the bound collection (a thumbnail is a picture, not a full projection);
    // inert touches nothing — its snapshot came with the fixtures.
    let boot = Promise.resolve();
    if (preset === "live" || preset === "readonly") {
      // Boot results are the OLDEST information this embed will ever have, but they can arrive
      // LAST (a slow first read racing a fast child write). Both legs therefore adopt the same way
      // every other path does — version-monotonically, and never after unmount.
      boot = Promise.allSettled([
        readCollection("settings").then((s) => rebuildPrefs(s.items || [], s.settings_version))
          .catch(() => { if (prefMap === null) prefMap = {}; }),
        opts.snapshot ? Promise.resolve()
          : readCollection(coll, preset === "readonly" ? { maxPages: 1 } : undefined)
              .then((s) => {
                if (dead) return;
                if ((s.version || 0) >= (childSnap.version || 0)) childSnap = { ...s, app: n, host: state.host };
              }).catch(() => {}),
      ]).then(() => { if (!dead) push(); });
    } else { prefMap = {}; }

    const onMessage = async (ev) => {
      if (ev.source !== frame.contentWindow) return;   // source-authenticated: only OUR child
      const d = ev.data || {};
      if (d.omaRunHeight && typeof d.h === "number") { if (H) frame.style.height = Math.min(Math.max(d.h + 4, H.min), H.max) + "px"; return; }
      if (!d.omaRun) return;
      try {
        const result = await guard(d.method, d.args || {});
        if (!frame.contentWindow) return;
        frame.contentWindow.postMessage({ omaRunResult: true, id: d.id, result }, "*");
        // Keep the child's projection fresh from what just crossed the chokepoint:
        // a settings snapshot rebuilds prefs/settingsIds; an own-collection snapshot is
        // adopted version-monotonically; a write ACK applies through the same continuity
        // rule the top-level widget uses (child clicks redraw with zero extra reads too).
        const sc = (result && result.structuredContent) || (d.method === "refresh" || d.method === "readCollection" ? result : null);
        if (sc && Array.isArray(sc.items)) {
          // NOTHING a child asked for rebuilds prefs or settingsIds. A child with
          // cross_collection_read can read `settings` with a {group}/{match} that matches nothing;
          // taking that as the settings snapshot emptied settingsIds — the set the guard uses to
          // recognise a foreign settings row — and the next update_item on a remembered row then
          // walked straight past settings_write:false. The parent already keeps this fresh from
          // its OWN full walks: boot, the post-ack re-walk below, and onParentPref.
          // (Same shape as the childSnap rule right underneath: only OUR reads may restate state.)
          // ONLY a refresh restates the child's own projection. readCollection is the child's
          // free-form read: it may carry {group}/{match} — a FILTERED subset that happens to name
          // the bound collection — and adopting it as the snapshot deleted every row outside the
          // filter, with no poll able to bring them back (the version had already advanced).
          if (d.method === "refresh" && sc.collection === coll && (sc.version || 0) >= (childSnap.version || 0))
            childSnap = { ...childSnap, items: sc.items, version: sc.version || 0 };
          push();
        } else if (sc && "ok" in sc) {
          // Child writes go through the SAME continuity rule as the top-level widget's — this used
          // to apply every ok:true ack unconditionally, which skipped any concurrent write that had
          // touched the collection since the child's read (prev_collection_seq was never consulted).
          const cd = decideAck({ collection: coll, version: childSnap.version || 0 }, sc);
          if (cd.kind === "apply" || cd.kind === "apply-refresh") {
            const rows = applyAck(childSnap.items || [], sc);
            if (rows) {
              childSnap = { ...childSnap, items: rows,
                version: cd.kind === "apply" ? Math.max(childSnap.version || 0, Number(sc.seq) || 0) : (childSnap.version || 0) };
              push(true);   // a write landed — say so, the version may not have moved
            }
            if (cd.kind === "apply-refresh" || !rows) refreshChild();
          } else if (cd.kind === "conflict") refreshChild();
        }
        if (sc && sc.ok === true && sc.collection === "settings")
          readCollection("settings").then((s) => { rebuildPrefs(s.items || [], s.settings_version); if (!dead) push(); }).catch(() => {});
      } catch (e) {
        if (frame.contentWindow) frame.contentWindow.postMessage({ omaRunResult: true, id: d.id, error: String((e && e.message) || e) }, "*");
      }
    };
    window.addEventListener("message", onMessage);

    let refreshing = null;
    function refreshChild() {
      if (preset !== "live") return Promise.resolve();
      if (refreshing) return refreshing;
      refreshing = readCollection(coll).then((s) => {
        if (dead) return;
        if ((s.version || 0) >= (childSnap.version || 0)) { childSnap = { ...s, app: n, host: state.host }; push(); }
      }).catch(() => {}).finally(() => { refreshing = null; });
      return refreshing;
    }

    // Liveness: ride the embedder's probe. Same collection → the parent's own walk + onChange
    // already covers it; a foreign collection checks its own ledger slice first.
    const handle = {
      el: frame,
      coll,
      refresh: refreshChild,
      async tick() {
        if (preset !== "live") return;
        if (coll === state.collection) return;   // parent onChange path covers us
        try {
          const r = await rawCall("data_changes", { collection: coll, since: childSnap.version || 0 });
          const d = r && !r.isError ? r.structuredContent : null;
          const verdict = decideChanges(d);
          if (verdict.kind === "walk") await refreshChild();
          else if (verdict.kind === "advance") childSnap = { ...childSnap, version: verdict.to };
        } catch { /* next probe retries */ }
      },
      unmount() {
        dead = true;   // in-flight boot/refresh results resolve into a frame that is already gone
        liveEmbeds.delete(handle);
        window.removeEventListener("message", onMessage);
        const ci = changeCbs.indexOf(onParentChange);
        if (ci !== -1) changeCbs.splice(ci, 1);
        const pi = prefCbs.indexOf(onParentPref);
        if (pi !== -1) prefCbs.splice(pi, 1);
        clearTimeout(prefT);
        try { frame.remove(); } catch {}
      },
    };
    // Parent onChange feeds the child two ways: (1) the embedder bound to the SAME collection
    // hands its adopted walks straight through (the loader case — no double fetch); (2) an
    // embedder bound to the SETTINGS collection (the settings app itself) keeps every child's
    // pref map fresh as the user flips switches (§2.7 parity, without a second fetch).
    const onParentChange = (s) => {
      if (preset === "inert" || !Array.isArray(s.items)) return;
      // `lastSettingsVersion`, not s.version: prefVersion is on the SETTINGS axis, and s.version is
      // the global ledger seq (always ≥ it). Mixing the two would pin prefVersion above every real
      // settings_version and freeze the child's pref map. adopt() just set this from the same walk.
      if (s.collection === "settings") { rebuildPrefs(s.items, lastSettingsVersion); push(); }
      if (preset !== "live" || s.collection !== coll) return;
      if ((s.version || 0) < (childSnap.version || 0)) return;   // never rewind past a child-write snapshot
      childSnap = { ...childSnap, items: s.items, version: s.version };
      push();
    };
    changeCbs.push(onParentChange);
    // Parent pref changes (any embedder, not just the settings app): the child's merged map
    // may have moved — re-walk settings once, debounced across a burst of changed keys.
    let prefT = 0;
    const onParentPref = () => {
      if (preset === "inert") return;
      clearTimeout(prefT);
      prefT = setTimeout(() => {
        readCollection("settings").then((s2) => { rebuildPrefs(s2.items || [], s2.settings_version); if (!dead) push(); }).catch(() => {});
      }, 250);
    };
    prefCbs.push(onParentPref);
    if (preset === "live") liveEmbeds.add(handle);

    frame.onload = () => { Promise.race([boot, new Promise((r) => setTimeout(r, 1200))]).then(push, push); };
    frame.srcdoc = composeChildDoc(html, { tokenCss: tokenCSS(document, childTokenSubstitutes()), kitCss: ownKitCss(), fallbackCss: ownFallbackCss(), bridge: BRIDGE });
    opts.into.appendChild(frame);
    return handle;
  },
  /** Runtime contract version (RUNTIME.md). Same number in direct mode and behind the runner —
   *  what differs between them is enforcement, not the shape of this object. An app shipped from
   *  outside this repo feature-detects with it; one written by the AI never needs to. */
  get contract() { return RUNTIME_CONTRACT; },
  /** Arguments of the tool call that mounted this widget (e.g. {app, collection}). */
  get toolInput() { return toolInput; },
  /** Which host this widget is running in ("claude-ai", "chatgpt", "browser-viewer", …). */
  get host() { return state.host; },
  /** True when running in a plain browser page (no chat attached — sendMessage unavailable). */
  get standalone() { return !!SA; },
  /**
   * Base path for app→app links (e.g. `oma.viewBase + name`). Defaults to the
   * engine viewer's "/view/"; an embedding shell sets standalone.viewBase to its own mount
   * base so links resolve there. Single source of truth — apps never hardcode "/view/".
   */
  get viewBase() { return (SA && typeof SA.viewBase === "string" && SA.viewBase) || "/view/"; },
  /**
   * True if `name` is a control-plane tool no app may call via callTool (registry /
   * security-policy mutation, and every internal `_`-prefixed RPC). The single source of
   * truth (tool-policy.mjs) — a preview bridge MUST gate on this rather than hand-maintain
   * its own denylist.
   */
  isControlPlaneTool(name) { return _isControlPlaneTool(name); },
  /**
   * Bind this runtime to a collection, once, from an answer the SERVER computed.
   *
   * DIRECT MODE ONLY, and it exists for exactly one caller: the universal loader. A per-app
   * document is baked with its binding at serve time (`__OMA_COLLECTION_HINT__`), but the loader is
   * ONE document serving every app, so it cannot be — leaving `state.collection` with a single
   * source, a host push, and `open_app`'s `collection` input optional and usually omitted.
   * The result of the `app_html` call the loader already makes carries the binding, so the
   * loader hands it over here instead of the runtime waiting to be told.
   *
   * It does NOT recompute anything, and callers must not either: "what does this app open on" has
   * one owner (contracts.mjs defaultCollectionFor, which /view mounts by too), and a second copy is
   * a second answer waiting to disagree.
   *
   * FIRST WINS, like every other writer of this field — a late call cannot rebind a widget that is
   * already bound and reading. Sandboxed children never see this method (the guard's surface is an
   * allowlist), which is deliberate: a child that could rebind itself could read another app's rows.
   */
  bind(collection) {
    if (typeof collection === "string" && collection && !state.collection) state.collection = collection;
    return state.collection;
  },
  /**
   * PROPOSE a message into the chat (ui/message). Call ONLY from an explicit user click
   * (e.g. a "Send to AI" button) — never automatically.
   *
   * ⚠️ The resolved value means THE HOST ACCEPTED THE REQUEST. It does NOT mean the user sent
   * anything, and an app must never render "done" on the strength of it. Both hosts we have
   * first-hand readings for MEDIATE it (Leo, live, 2026-07-28):
   *   · Claude  — the text is placed in the composer, UNSENT. The user still presses send, and
   *               may never do so; this promise resolved long before that.
   *   · ChatGPT — a system modal appears ("An app wants to send this prompt", editable, with
   *               Cancel/Send); pressing Send delivers it with no further confirmation.
   * Either way the outcome happens after we are done, and nothing on the wire reports it (see
   * docs/wo/proposal-trusted-user-action.md), so the honest thing an app can do is point the
   * user at the chat — which this does, once, on the caller's behalf.
   */
  sendMessage(text) {
    const t = String(text);
    // GLOBAL degradation: when the chat channel is unavailable (standalone page) or the host
    // rejects/fails the call (Codex widget-proxy -32000, openai/codex#28912), fall back to the
    // CLIPBOARD — the user pastes the text to their AI. Apps just call sendMessage and
    // never need their own fallback; the success path (Claude Desktop) is untouched. The
    // degraded result is NOT an exception (isError + degraded tag), so apps don't crash.
    const degrade = (why) => {
      let p;
      try { p = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(t) : Promise.reject(new Error("no clipboard")); }
      catch (e) { p = Promise.reject(e); }
      return p.then(
        () => { omaNotify("Copied to clipboard — paste it to your AI (" + why + ")."); return { isError: true, degraded: "clipboard" }; },
        () => { console.warn("[oma] sendMessage degraded (" + why + "); text:", t); omaNotify("Couldn't reach the chat (" + why + ") — the text is in the console."); return { isError: true, degraded: "console" }; });
    };
    if (SA) return degrade("no chat attached");
    // NOTHING IS SAID ON THE SUCCESS PATH, and that is a decision, not an omission.
    //
    // A notice used to fire here on every accepted call: "Check the chat — you may need to confirm
    // or send it." It was defended as true on every host, on the reasoning that it "still reads
    // correctly if some host does deliver it straight away". That was an inference, and live testing
    // (Leo, 2026-07-29) falsified it in both directions at once:
    //   · desktop — the message had ALREADY been delivered and the banner fired anyway, so the
    //     healthy path cried wolf;
    //   · mobile — the banner fired and what arrived in the chat was an EMPTY message, so the one
    //     sentence the user got was the only part that worked.
    // A notice that appears when nothing needs doing teaches people to ignore it, which costs more
    // than the silence it replaced.
    //
    // The honest position is that the protocol gives us no completion signal at all — `ui/message`
    // resolves when the HOST accepts the request, and what the user does next never comes back on
    // any wire (docs/wo/proposal-trusted-user-action.md). A runtime-level guess cannot be right on
    // every host, so it is the CALLER's to decide what, if anything, to show; the JSDoc above says
    // what the resolved value does and does not mean. Known consequence, recorded in KNOWN-ISSUES:
    // call sites are fire-and-forget again, so on a host that only stages the text a click can look
    // like nothing happened.
    return hostApp.sendMessage({ role: "user", content: [{ type: "text", text: t }] })
      .then((r) => (r && r.isError ? degrade("host declined") : r))
      .catch((e) => degrade((e && e.message) || "send failed"));
  },
  /**
   * Open a URL through the host (ui/open-link). The direct counterpart to sendMessage: where
   * sendMessage PROPOSES something for the AI to maybe do, this DOES the thing — no model, no
   * authority question, no host trust decision about app-authored text.
   *
   * It exists because the alternative kept failing in both directions. A widget cannot navigate
   * (the sandbox has no allow-top-navigation and no allow-popups — measured, KNOWN-ISSUES), so
   * anything link-shaped got routed through "ask the AI to do it", and on ChatGPT the AI then
   * declines because app-authored text is untrusted tool content (measured 2026-07-28). Both ends
   * were weak for the same reason, and neither was going to be fixed by trying harder.
   *
   * Resolves { ok } rather than throwing: a caller decides what to show, and "the host will not
   * open links" is a normal answer on some surfaces, not an error the user should read about.
   */
  openLink(url) {
    const u = String(url || "");
    if (!u) return Promise.resolve({ ok: false });
    // Standalone (browser viewer): no host to ask, and no sandbox in the way either.
    // Standalone: check what window.open RETURNED. A blocked popup does not throw — it hands back
    // null — so reporting {ok:true} on "did not throw" told the caller a tab had opened when none
    // had, and the caller then suppressed its own fallback. `ok` has to mean the thing happened.
    if (SA) { try { return Promise.resolve({ ok: !!window.open(u, "_blank", "noopener") }); } catch (e) { return Promise.resolve({ ok: false }); } }
    return hostApp.openLink({ url: u })
      .then((r) => ({ ok: !(r && r.isError) }))
      .catch(() => ({ ok: false }));
  },
  /**
   * Silently update the AI's context (ui/update-model-context) — no chat message is
   * produced; the AI sees it on its next turn. Each call REPLACES the previous context.
   */
  updateContext(text) {
    if (SA) return Promise.resolve();
    return hostApp.updateModelContext({ content: [{ type: "text", text: String(text) }] })
      .catch((e) => { console.error("[oma] updateContext failed", e); });
  },
};

// Staleness: the AI (or another host — CLI, another chat) can write via data_* while this
// widget sits on screen. ADAPTIVE poll while visible: each tick asks the cheap data_version
// probe; a moved GLOBAL seq is then confirmed against OUR collection with one data_changes
// call — a foreign collection's write costs a probe + one tiny check, never a full walk
// (and safely advances our mark, so it doesn't re-fire). settings changes are caught from
// the probe's settings_version — write acks no longer carry settings snapshots. After user
// activity (a click/keystroke/any widget write) or an observed remote change, the cadence
// drops to 2s and decays ×1.6 per quiet tick back to the base `widget_poll_seconds`.
const pollMs = () => {
  const s = window.oma.pref("widget_poll_seconds", 20);   // coercePref handles junk
  return (s >= 5 && s <= 300 ? s : 20) * 1000;
};
const FAST_MS = 2000;
let pollDelay = 0;                                        // 0 = base cadence
function markActivity() { pollDelay = FAST_MS; }
async function checkOwnChanges() {
  // Our own write is in flight: the commit's SSE/probe signal RACES the ack, and checking now
  // would walk for a change the ack is about to apply locally (a spurious refresh on the exact
  // path the 0-RTT rule exists for). The ack advances the mark; a genuinely foreign change
  // still surfaces on the next tick.
  if (pendingWrites > 0) return;
  const r = await rawCall("data_changes", { collection: state.collection, since: state.version });
  const d = r && !r.isError ? r.structuredContent : null;
  const verdict = decideChanges(d);
  if (verdict.kind === "walk") { await walk(); pollDelay = FAST_MS; }  // hot: keep streaming
  else if (verdict.kind === "advance") state = { ...state, version: verdict.to };  // all elsewhere — silent
}
async function pollTick() {
  if (ready && document.visibilityState === "visible" && state.collection) {
    try {
      const r = await rawCall("data_version", {});
      const sc = r && !r.isError ? r.structuredContent : null;
      if (!sc || typeof sc.seq !== "number") await walk();  // engine predates data_version → old behavior
      else {
        const p = decideProbe(state.version, lastSettingsVersion, sc);
        if (p.syncPrefs) schedulePrefSync();
        if (p.checkChanges) await checkOwnChanges();
        else if (pollDelay) { pollDelay = Math.round(pollDelay * 1.6); if (pollDelay >= pollMs()) pollDelay = 0; }
        if (p.checkChanges) for (const h of liveEmbeds) h.tick();   // embedded children ride the same probe
      }
    } catch { /* transient bridge failure — next tick retries */ }
  }
  setTimeout(pollTick, pollDelay || pollMs());
}
setTimeout(pollTick, pollMs());
document.addEventListener("visibilitychange", () => {
  if (ready && document.visibilityState === "visible") { markActivity(); walk(); }
});
document.addEventListener("pointerdown", markActivity, { capture: true, passive: true });
document.addEventListener("keydown", markActivity, { capture: true, passive: true });

// ---- render-health: report a broken mount so the engine can AUTO-REVERT to the last good
// version (local tier only — the engine enforces that plus a per-run budget). Identity comes
// from the injected globals (__OMA_APP__/__OMA_APP_VERSION__ via wrapApp, or
// set by the loader before mount); no identity/version → no report. First error only, within
// the initial window; earlier parse-time errors arrive via the __OMA_EARLY_ERRORS__ buffer
// (a classic script installed before any app code runs).
let bridgeReady;                                          // resolves when rawCall is usable
const bridgeReadyP = new Promise((r) => { bridgeReady = r; });
{
  const REPORT_WINDOW_MS = 8000;
  const t0 = Date.now();
  let reported = false;
  const report = (msg) => {
    if (reported) return;
    const app = compName();
    const version = typeof window !== "undefined" ? window.__OMA_APP_VERSION__ : undefined;
    if (!app || typeof version !== "number") return;
    reported = true;
    bridgeReadyP.then(() => rawCall("render_health", { app, version, ok: false, error: String(msg).slice(0, 300) }))
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
    if (r && r.omaToolCallError) return;   // environment/tool failure, NOT broken app code — never a revert trigger
    if (Date.now() - t0 < REPORT_WINDOW_MS) report((r && r.message) || r || "unhandled rejection");
  });
}

if (SA) {
  // Browser viewer: no MCP host, no bridge — bind directly and pull. Mounting always walks:
  // there is no pushed tool result here at all.
  state.collection = SA.collection || null;
  state.app = SA.app || null;
  state.host = "browser-viewer";
  prefsPromise = syncPrefs();  // SA.app is already set — even eager consumers are safe
  walk().catch((e) => omaNotify("Failed to load: " + ((e && e.message) || e)));
  bridgeReady();
  // Viewer SHELL (standalone pages only — host chats render the bare widget): a slim fixed top
  // bar so a browser-opened app has navigation and identity instead of floating raw in the tab.
  // Attached to <html> like omaNotify (apps rewrite body.innerHTML), body pushed down via
  // an injected style so no app content hides underneath.
  // SA.chrome === false → skip bar AND stage: an embedding shell (hosted /app) owns the chrome,
  // and the widget renders bare exactly as it does inside a chat host iframe.
  if (SA.chrome !== false) try {
    const bar = document.createElement("div");
    bar.id = "__oma_viewer_bar";
    const st = document.createElement("style");
    // The STAGE: a quiet page background with the app centered on one elevated card, so every
    // app gets the same framing in the browser regardless of its own internal chrome.
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
    name.textContent = SA.app || "";
    const brand = document.createElement("span");
    brand.className = "oma-vb-brand";
    brand.textContent = "open-mcp-apps · browser view";
    bar.append(back, name, brand);
    const mountBar = () => { document.head.appendChild(st); document.documentElement.appendChild(bar); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountBar);
    else mountBar();
  } catch { /* the bar is cosmetic — never let it break the app */ }
  // Local realtime (SSE): /events pushes ledger seqs the moment anything commits; a moved seq
  // runs the same changes-check the poll would (walk only when OUR collection moved). Any
  // failure just leaves the adaptive poll as the fallback (EventSource auto-reconnects).
  if (typeof EventSource === "function") {
    try {
      const es = new EventSource(SA.events || "/events");
      es.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (typeof d.seq === "number" && d.seq !== state.version) {
            markActivity();
            if (ready && state.collection) checkOwnChanges().catch(() => {});
            for (const h of liveEmbeds) h.tick();
          }
        } catch {}
      };
    } catch {}
  }
} else {
  // The host pushes the mounting tool's input + result after ui/initialize. Neither is the
  // paint source anymore: the input BINDS the collection, the result (zero rows by design,
  // and possibly a stale HOST-CACHED replay) is adopted only if the gate lets it through —
  // the walk the binding triggers is what the first paint stands on.
  let connected = false;
  const startWalk = () => { if (connected && state.collection) walk(); };
  hostApp.ontoolinput = (params) => {
    const a = (params && (params.arguments || params)) || {};
    toolInput = a;
    // Unconditional, and deliberately so. A guard requiring the envelope to name its app was tried
    // and REVERTED on 2026-07-29: the reading it was built on turned out to be the model doing
    // exactly what it was asked ("bind dev-probe to habit-streaks and open it" — its own words),
    // not a host mis-delivering one. And the guard broke a documented feature on the way, because
    // the premise was wrong in both directions: the per-app tool `open_<name>` carries ONLY a
    // collection — its app is in the TOOL name, not the arguments — and its document is already
    // bound at serve time, so BOTH halves of that guard rejected a binding the AI had explicitly
    // asked for, silently. That path is live wherever install.mjs turns per-app tools on, i.e.
    // every Anthropic host.
    //
    // The hazard the guard aimed at is real in shape and UNDEMONSTRATED in fact: the host does
    // hand a widget another call's envelope (measured, verbatim), but every envelope observed
    // doing so carried no `collection` at all. If a foreign envelope carrying one is ever
    // measured, the discriminator must be "is this envelope from the tool that opened me"
    // (hostContext.toolInfo.tool.name) — asking the question directly — not "does it name an app",
    // which is a proxy that answers wrong for our own per-app opener.
    if (typeof a.collection === "string" && a.collection) state.collection = a.collection;
    rememberIdentity();          // this is THE channel a re-render replays — write it down
    startWalk();
  };
  hostApp.ontoolresult = (result) => {
    const sc = result && result.structuredContent;
    // IDENTITY IS NOT DATA — take the labels BEFORE the freshness gate gets a vote.
    //
    // state.app / state.host / state.collection used to be assigned only INSIDE adopt(),
    // past `canAdopt`. But canAdopt exists to stop STALE ROWS from overwriting painted rows
    // (out-of-order replays, truncation, rewinds), and one of its rules is
    // `items.length !== total ⇒ refuse`. open_app answers with ZERO rows and the
    // collection's REAL total — deliberately, the widget fetches its own data — so the moment an
    // app has a single row, its own opening result is refused and the widget can never learn
    // which app it is or which host it is on. Measured: `host: null` on ChatGPT web, DIRECT mode,
    // first open (Leo, 2026-07-29), and it is one half of the "No app specified." a refresh
    // produces. The host had delivered; we threw it away.
    //
    // A label has no "stale enough to be harmful" state: a widget's app identity does not change
    // for its whole life, and neither does the host it runs in. Binding them to `items` put the
    // freshness of the DATA in charge of whether the identity could be KNOWN.
    //
    // First-wins, like the collection rule this copies: a later result must never rebind a widget
    // that already knows what it is.
    if (sc && typeof sc.collection === "string" && !state.collection) state.collection = sc.collection;
    if (sc && typeof sc.app === "string" && !state.app) state.app = sc.app;
    if (sc && typeof sc.host === "string" && !state.host) state.host = sc.host;
    rememberIdentity();          // N11 may have just learned the name from this very result
    if (sc && Array.isArray(sc.items)) { if (!adopt(sc)) startWalk(); }
    else startWalk();
  };
  hostApp.onhostcontextchanged = (ctx) => applyTheme(ctx);
  hostApp.onerror = (e) => console.error("[oma] bridge error", e);

  hostApp.connect().then(() => {
    applyTheme(hostApp.getHostContext());
    prefsPromise = syncPrefs();  // bridge must be connected before callServerTool works
    bridgeReady();               // render-health reports queued before connect can flush now
    connected = true;
    startWalk();                 // binding may have arrived before connect — walk now
  }).catch((e) => console.error("[oma] connect failed", e));
}
