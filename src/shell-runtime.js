// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// shell-runtime.js — the browser-side runtime injected into EVERY app.
//
// An app never touches the MCP bridge, uuids, versions, or persistence: it calls the tiny
// `window.oma` API and re-renders on change. The shell owns the ui/initialize handshake, tool
// calls, idempotency keys, optimistic-concurrency versions, and host theming.
//
// Every RULE this file lives by (0-RTT continuity, the adoption gate, the paged walk, the poll
// decisions, via) is a pure function in runtime-core.mjs, pinned by node tests; this file is the
// wiring. The sandbox machine (child doc, mini-bridge, caps chokepoint) lives once in runner.mjs
// and is reached here as oma.embed.
//
// NOT a security boundary: this runtime shares the document with the app's own scripts, so it
// cannot gate a hostile app. Untrusted (non-local) apps run one level down, behind the runner.
//
// Bundled by build.mjs into dist/shell.js and inlined by shell.mjs when serving ui://.

// Must stay FIRST: it configures zod (jitless — no CSP eval violation) before ext-apps builds the
// schemas that read the setting.
import "./zod-jitless.js";
import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from "@modelcontextprotocol/ext-apps";
import { decideAck, applyAck, ackOf, canAdopt, walkPages, decideProbe, decideChanges, viaOf, themeVars, childPreviewSnapshot, coercePref, withConfirmation, afterAppScripts, fitFrame, createAppTools, serveAppTools, appToolText, THEME_KEY_PREFIX, WALK_LIMIT, APP_READER_META } from "./runtime-core.mjs";
import { makeGuard, composeChildDoc, tokenCSS, BRIDGE, readFileParts, unpinDocumentHeight } from "./runner.mjs";
import { STAMPED_TOOLS as STAMPED_LIST, DATA_BATCH_REFUSAL, canonicalToolName } from "./tool-policy.mjs";

// Standalone mode: set by the browser viewer (http.mjs /view/<name>) when there is NO MCP
// host — tool calls go over plain fetch to the local /rpc endpoint instead of the bridge.
const SA = typeof window !== "undefined" ? window.__OMA_STANDALONE__ : undefined;

// The widget's capability declaration, sent on every ui/initialize. Declare only what is backed
// (spec MUST): display modes are (oma.display / requestDisplay), and tools are — the app's own,
// registered with oma.tools.register and served by serveAppTools below (tools/list, tools/call,
// list_changed once the host has listed).
const DISPLAY_MODES = ["inline", "fullscreen"];
const hostApp = new App({ name: "open-mcp-apps", version: "0.1.0" }, { availableDisplayModes: DISPLAY_MODES, tools: { listChanged: true } });

// APP TOOLS (ext-apps draft "App-provided tools"): the app names what it can do —
// oma.tools.register({name, description, inputSchema, run}) — and the AI calls it by name instead
// of reading the screen and pressing. The page's alone: never persisted, gone on reload. Two roads
// to the model, chosen by what the host DOES, never by its name:
//   native — a host that implements the draft sends tools/list / tools/call to this view;
//   relay  — every other host (claude.ai and ChatGPT never asked, measured 2026-10-01): screen_read
//            lists the tools and screen_act {tool, input} runs one, over the screen long-poll.
// Both stay open: a host that lists our tools has not thereby shown them to its model.
const appTools = createAppTools();
serveAppTools(hostApp, appTools);

// THE SCREEN: the AI reads the screen
// and presses controls the way the user would, instead of calling functions the author exposed.
// Generic, and it reaches only what a person could (visible controls, dispatched clicks). Jobs
// arrive through the engine relay (screenRelay below) — hosts do not hand view tools to the model.
const ACTIONABLE = "button,a[href],input,select,textarea,summary,[role=button],[role=tab],[role=link],[role=checkbox],[role=switch],[role=option],[role=menuitem],[data-act]";
const screenRefs = new WeakMap();
const screenEls = new Map();
let screenSeq = 0;
const squash = (t, n = 90) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);
function screenVisible(el) {
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
function screenLabel(el) {
  const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
  return squash(el.getAttribute("aria-label") || (lab && lab.innerText) || el.innerText || el.placeholder || el.title || el.value || el.name);
}
function screenRead() {
  const out = [`app: ${document.title || "(untitled)"} · display: ${display} · viewport ${innerWidth}x${innerHeight}`];
  // The app's own tools come first and outside the screen budget: they are the better way in, and
  // a long page must not push them off the end.
  const own = appTools.describe();
  if (own) out.push("The app's own tools — call one with screen_act {tool, input}:", own, "", "Screen:");
  let chars = 0;
  const push = (line) => { if (chars < 6000) { out.push(line); chars += line.length + 1; } };
  const walkEl = (el) => {
    if (el.nodeType !== 1 || !screenVisible(el) || screenOff(el)) return;
    if (el.matches(ACTIONABLE) && !el.disabled) {
      let ref = screenRefs.get(el);
      if (!ref) { ref = "r" + ++screenSeq; screenRefs.set(el, ref); }
      screenEls.set(ref, new WeakRef(el));
      const kind = el.getAttribute("role") || (el.tagName === "INPUT" ? `input:${el.type}` : el.tagName.toLowerCase());
      const st = [];
      if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current") || el.getAttribute("aria-pressed") === "true") st.push("selected");
      if (el.checked) st.push("checked");
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== "checkbox") st.push(`value="${squash(el.value, 60)}"`);
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) st.push("off-screen");
      push(`[${ref}] ${kind} "${screenLabel(el)}"${st.length ? " (" + st.join(", ") + ")" : ""}`);
      return;
    }
    if (/^H[1-4]$/.test(el.tagName)) { push("#".repeat(+el.tagName[1]) + " " + squash(el.innerText, 120)); return; }
    for (const c of el.childNodes) {
      if (c.nodeType === 3) { const t = squash(c.textContent, 2000); if (t) push(t); }   // a paragraph whole; the screen budget caps the total
      else walkEl(c);
    }
  };
  walkEl(document.body);
  return out.join("\n");
}
// What the relay may press is exactly what screenRead lists: the engine's own chrome (the delete
// confirmation above all) and anything aria-hidden are not on the screen, by ref or by label.
const screenOff = (el) => !!el.closest("[data-oma-chrome],[aria-hidden=true]");
function screenFind(args) {
  const w = args.ref && screenEls.get(String(args.ref));
  const el = w && w.deref();
  if (el && el.isConnected && !screenOff(el)) return el;
  const want = squash(args.label).toLowerCase();
  if (!want) return null;
  const all = [...document.querySelectorAll(ACTIONABLE)].filter((e) => screenVisible(e) && !screenOff(e));
  return all.find((e) => screenLabel(e).toLowerCase() === want) || all.find((e) => screenLabel(e).toLowerCase().includes(want)) || null;
}
async function screenAct(args) {
  const el = screenFind(args);
  if (!el) return { isError: true, content: [{ type: "text", text: `No control "${args.ref || args.label}" on screen now. Read the screen again.\n\n` + screenRead() }] };
  const action = args.action || (/^(INPUT|TEXTAREA)$/.test(el.tagName) && el.type !== "checkbox" && el.type !== "radio" ? "fill" : el.tagName === "SELECT" ? "select" : "press");
  try { el.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch {}
  const ring = el.style.outline, off = el.style.outlineOffset;
  el.style.outline = "3px solid var(--k-accent, #2563eb)"; el.style.outlineOffset = "2px";
  setTimeout(() => { el.style.outline = ring; el.style.outlineOffset = off; }, 900);
  if (action === "fill" || action === "select") {
    const v = String(args.value ?? "");
    if (el.tagName === "SELECT") {
      const o = [...el.options].find((o) => o.value === v || squash(o.text).toLowerCase() === v.toLowerCase());
      if (o) el.value = o.value;
    } else {
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      set ? set.call(el, v) : (el.value = v);
    }
    el.focus?.();
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    el.click();
  }
  await new Promise((r) => setTimeout(r, 400));
  return { content: [{ type: "text", text: `Did ${action} on "${screenLabel(el)}". Screen now:\n\n` + screenRead() }] };
}
// Where the app is shown: "inline" (a card in the conversation) or "fullscreen" (the host has
// given the app the view, composer still attached). The browser viewer owns a whole page, so it
// IS fullscreen and cannot be anything else. Stamped on <html data-oma-display> so an app can
// adapt with CSS alone; onDisplayChange is for the ones that need to re-lay out in script.
let display = SA ? "fullscreen" : "inline";
let displayModes = SA ? ["fullscreen"] : ["inline"];
const displayCbs = [];
function stampDisplay() {
  try { document.documentElement.setAttribute("data-oma-display", display); } catch { /* no document (test rig) */ }
  // In a measuring host only (the unpin's own rule: an embedder that is not a standalone shell) —
  // fullscreen hands the frame's height back to the app, inline gives it back to the content.
  try {
    if (!SA && window.parent !== window && !window.__OMA_STANDALONE__ && document.body)
      fitFrame(display, [document.documentElement, document.body], unpinDocumentHeight);
  } catch { /* no document (test rig) */ }
}
function applyDisplay(ctx) {
  if (!ctx || SA) return;
  if (Array.isArray(ctx.availableDisplayModes)) displayModes = ctx.availableDisplayModes.filter((m) => DISPLAY_MODES.includes(m));
  syncTopbar();
  const m = ctx.displayMode;
  if (typeof m !== "string" || m === display) return;
  display = m;
  stampDisplay();
  for (const cb of displayCbs) { try { cb(display); } catch (e) { console.error("[oma] onDisplayChange", e); } }
}
stampDisplay();

// THE TOP BAR — the way into fullscreen, drawn for every app on a card whose host can go
// fullscreen. Top-left, where both hosts put their own control once fullscreen, so the gesture
// lives in one place in and out. There is no close button: in fullscreen the host's own ✕ is the
// way back, and the bar is hidden. Space is reserved above the app (padding on <html>), so it never
// covers the app's own top-left. Not marked chrome: the AI can press it too ("show it full screen").
let topbar = null;
function syncTopbar() {
  if (SA || typeof document === "undefined") return;
  const can = displayModes.includes("fullscreen");
  document.documentElement.toggleAttribute("data-oma-topbar", can);
  if (!can) return;
  if (!topbar) {
    const st = document.createElement("style");
    st.setAttribute("data-oma", "topbar");
    st.textContent =
      ":root[data-oma-topbar][data-oma-display=inline]{box-sizing:border-box;padding-top:40px!important}" +
      ".oma-topbar{display:none;position:fixed;top:0;left:0;right:0;height:40px;z-index:2147483644;" +
      "align-items:center;gap:8px;padding:0 10px;box-sizing:border-box;" +
      "background:var(--color-background-primary,Canvas);color:var(--color-text-primary,CanvasText);" +
      "border-bottom:1px solid var(--color-border-secondary,rgba(127,127,127,.18));" +
      "font:600 13px/1 -apple-system,system-ui,sans-serif}" +
      ":root[data-oma-topbar][data-oma-display=inline] .oma-topbar{display:flex}" +
      ".oma-topbar button{width:28px;height:28px;flex:none;display:grid;place-items:center;border:0;padding:0;" +
      "border-radius:8px;cursor:pointer;background:var(--color-background-inverse,CanvasText);color:var(--color-text-inverse,Canvas)}" +
      ".oma-topbar span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}";
    topbar = document.createElement("div");
    topbar.className = "oma-topbar";
    const open = document.createElement("button");
    open.type = "button";
    open.setAttribute("aria-label", "Open full screen");
    open.title = "Open full screen";
    open.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"/></svg>';
    open.onclick = () => window.oma.requestDisplay("fullscreen");
    topbar.append(open, document.createElement("span"));
    document.head.append(st);
  }
  // Inside <body>, first: outside it the accessibility tree (and screen_read) never sees it. The
  // loader mounts an app with body.innerHTML, and an app may do the same, so it is put back on
  // every change to the body's children.
  if (document.body && topbar.parentNode !== document.body) {
    if (!topbar.parentNode) new MutationObserver(syncTopbar).observe(document.body, { childList: true });
    document.body.prepend(topbar);
  }
  topbar.lastChild.textContent = document.title || compName() || "";
}

// What of the view is covered — a notch, a home bar, the host's own controls laid over the app.
// Stamped as --oma-safe-top/right/bottom/left on <html>: the larger of the host's report
// (hostContext.safeAreaInsets, MCP Apps) and the browser's own env(safe-area-inset-*), so an app
// pads with var(--oma-safe-top) and is right on either kind of host.
function stampSafeArea(ins) {
  try {
    for (const side of ["top", "right", "bottom", "left"]) {
      const px = ins && Number.isFinite(ins[side]) ? Math.max(0, ins[side]) : 0;
      document.documentElement.style.setProperty(`--oma-safe-${side}`, `max(${px}px, env(safe-area-inset-${side}, 0px))`);
    }
  } catch { /* no document (test rig) */ }
}
function applySafeArea(ctx) {
  if (ctx && ctx.safeAreaInsets && !SA) stampSafeArea(ctx.safeAreaInsets);
}
stampSafeArea();

// `version` is the GLOBAL ledger seq of the last adopted read; `total`/`truncated` let an app
// render "N of M" instead of pretending a capped projection is the collection.
// A per-app document carries its binding as an injected global: some hosts never deliver a
// collection through toolinput/toolresult, and an unbound widget's writes bounce as collection:null.
const BOUND_HINT = (typeof window !== "undefined" && window.__OMA_COLLECTION_HINT__) || null;
// …and its own name, so ontoolresult's first-wins rule cannot be won by another app's envelope
// (a host may hand a widget a foreign one; a turn may open two apps).
// Null on the universal loader: it is stamped only after it resolves and mounts.
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
    // Re-apply the theme for the same reason: prefs may have been ingested while compName() was
    // still null (the loader path), leaving the per-app layer out. pref() resolves the name per
    // call; the theme is written to the DOM once. Idempotent.
    applyThemeVars(themeVars(currentMerged()));
    syncTopbar();                   // the name is known by now (the loader mounts after connect)
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

// The shell's confirmation card: the ENGINE demands confirmation (server-side, so it cannot be
// forgotten), the SHELL renders it — app authors never write confirmation UI. Serves the top-level
// widget's deletes and every embedded child's (runner io.requestConfirm). Resolves true only on an
// explicit click; Escape or the earliest member's expiry resolves false — fail-closed.
//
// Demands arriving WHILE the card is open JOIN it (one intent over N rows → one card); each still
// re-sends with its own request_state. A demand after the card is answered opens a NEW card — an
// old answer is never spent on a new question.
let confirmCard = null;   // the open card's join(demand, resolve), or null
function shellConfirm(demand) {
  return new Promise((resolve) => {
    if (confirmCard) { confirmCard(demand, resolve); return; }
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;bottom:10px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
      "background:#23282b;color:#fff;padding:8px 8px 8px 14px;border-radius:10px;max-width:92%;" +
      "display:flex;gap:10px;align-items:center;font:12.5px/1.45 -apple-system,system-ui,sans-serif;" +
      "box-shadow:0 4px 14px rgba(0,0,0,.35);";
    const label = document.createElement("span");
    const mkBtn = (text, bg) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.cssText = "border:0;border-radius:7px;padding:5px 12px;font:inherit;cursor:pointer;color:#fff;background:" + bg + ";";
      return b;
    };
    const yes = mkBtn("Delete", "#e5484d"), no = mkBtn("Cancel", "rgba(255,255,255,.14)");
    // The person's answer, and only theirs: the screen relay never sees this card (data-oma-chrome),
    // and a click a script dispatched — the relay's, or an app's — is not a yes. Cancel needs no
    // such guard; declining is always safe. (Reproduced 2026-10-05 before the fix: screen_act
    // pressed "Remove", then pressed this card's "Delete", and the row was gone.)
    el.setAttribute("data-oma-chrome", "");
    el.append(label, no, yes);
    const members = [];   // [{demand, resolve}] — everyone this card answers for
    let timer;
    const ttlOf = (d) => Math.max(1000, Date.parse(d.expires_at || "") - Date.now() || 60_000);
    const done = (ok) => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKey, true);
      el.remove();
      if (confirmCard === join) confirmCard = null;
      for (const m of members) m.resolve(ok);
    };
    const join = (d, res) => {
      members.push({ demand: d, resolve: res });
      label.textContent = members.length === 1
        ? 'Delete "' + (members[0].demand.preview || "this item") + '"?'
        : "Delete " + members.length + ' items, including "' + (members[0].demand.preview || "this item") + '"?';
      // The answer must not outlive the shortest-lived credential it stands for.
      clearTimeout(timer);
      timer = setTimeout(() => done(false), Math.min(...members.map((m) => ttlOf(m.demand))));
    };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    yes.onclick = (e) => { if (e.isTrusted) done(true); };
    no.onclick = () => done(false);
    document.addEventListener("keydown", onKey, true);
    confirmCard = join;
    join(demand, resolve);
    document.documentElement.appendChild(el);
    no.focus();
  });
}

// A bridge request the host DROPS must reject, never hang: an unsettled await wedges its subsystem
// for the widget's life (the poll chain, syncPrefs' busy latch, a walk's single-flight slot). Some
// hosts drop calls sent in an early post-mount window. 10s is far beyond any real round-trip; the
// mechanism is the SDK's own request timeout.
const BRIDGE_DEADLINE_MS = 10_000;

// Every call this runtime makes says who will read the answer: the app (runtime-core
// READER_META_KEY). A read tool sizes its page for an app instead of for a model's context. Rides
// `_meta`, so it costs tools/list nothing; a host or front door that drops it leaves the read on
// the model's budget — more pages, same rows.
async function rawCall(name, args) {
  try {
    if (SA) {
      const res = await fetch(SA.endpoint || "/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, arguments: args, _meta: APP_READER_META }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json(); // a CallToolResult
    }
    return await hostApp.callServerTool({ name, arguments: args, _meta: APP_READER_META }, { timeout: BRIDGE_DEADLINE_MS });
  } catch (e) {
    // Tag every TOOL-CALL failure (host declined, bridge blip, transport error) so the broken-mount
    // reporter never mistakes an environment failure for a broken app.
    if (e && typeof e === "object") { try { e.omaToolCallError = true; } catch {} }
    throw e;
  }
}

// ---- the paged walk: how this widget reads its collection ---------------------------------
// Reads are PAGES (data_list, cursor) and a widget owns its walk: pages pinned to one version,
// restart when a write moves the stamp mid-walk, truncated (not silently stopped) past the page
// cap. Mounting ALWAYS walks — a host may replay a CACHED tool result, and the open result carries
// no rows by design, so the walk is what the first paint stands on.

function pageFetcher(collection) {
  return async (cursor) => {
    const r = await rawCall("data_list", { collection, limit: WALK_LIMIT, ...(cursor ? { cursor } : {}) });
    if (r && r.isError && isNotShared(r)) { noLongerShared(); throw new Error("not_shared"); }
    return r && !r.isError ? r.structuredContent : null;
  };
}

// ---- shared collections (`@owner/name`): another account's data, reached through a share ----
// The binding of a widget opened on a share is a HANDLE, and the engine routes by it — so every
// id-addressed write names it (a bare id would be looked up in the viewer's OWN store first) and
// the probe asks for that one collection's mark (the owner's global activity is not ours to see).
const isHandle = (c) => typeof c === "string" && c.charAt(0) === "@";
const sharedBinding = () => (isHandle(state.collection) ? { collection: state.collection } : {});
const isNotShared = (r) => !!(r && r.structuredContent && r.structuredContent.reason === "not_shared");
// The share ended (revoked, left, or the app deleted) while this widget was on screen: say so over
// the whole widget, once, and stop pretending the last rows are live. Attached to <html> like
// omaNotify, because apps rewrite body.innerHTML.
let sharedGone = false;
function noLongerShared() {
  if (sharedGone || typeof document === "undefined") return;
  sharedGone = true;
  try {
    const el = document.createElement("div");
    el.id = "__oma_unshared";
    el.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;" +
      "background:color-mix(in srgb,var(--color-background-primary,Canvas) 88%,transparent);backdrop-filter:blur(3px);" +
      "font:14px/1.5 -apple-system,system-ui,sans-serif;color:var(--color-text-secondary,CanvasText);text-align:center;padding:24px";
    el.textContent = "No longer shared with you.";
    document.documentElement.appendChild(el);
  } catch (e) { /* no document to draw on */ }
}

/** Full paged read of ANY collection. Never touches widget state. No options: an app that wants
 *  a slice filters the rows, or calls data_list through callTool. */
async function readCollection(collection) {
  const coll = String(collection);
  const out = await walkPages(pageFetcher(coll));
  if (out.error) throw new Error("read failed: " + out.error);
  return {
    collection: coll,
    items: out.items,
    version: out.version,
    settings_version: out.settings_version,
    files_version: out.files_version,
    total: out.total,
    truncated: !!out.truncated,
    ...(out.torn ? { torn: true } : {}),
  };
}

// DATA IS OPT-IN. An app subscribes with oma.onChange — every data app does — and only then does
// the runtime read its collection and watch it. One that never subscribes is a page: no reads, no
// polling, ready() as soon as the bridge is up. Decided after the app's own scripts have run, so
// a top-level subscription is never mistaken for a page.
const subscribed = () => changeCbs.length > 0;
let live = false;   // bridge up and the app's scripts have run — a later subscription walks at once
// Decided once the app's own scripts have run — see afterAppScripts (runtime-core) for why that is
// DOMContentLoaded plus a task, and never readyState. Armed here, at the runtime's first run, so the
// event cannot slip past before goLive asks.
const appScriptsRan = typeof document === "undefined" ? (cb) => cb() : afterAppScripts(document, window);
function goLive() {
  appScriptsRan(() => { live = true; if (subscribed()) walk(); else markReady(); });
}

let walking = null;   // single-flight: concurrent walk triggers share one pass
let walkAgain = false;
let walkedOnce = false;   // one full read has adopted — the paint has stood on real data at least once
function walk() {
  if (!state.collection || !subscribed()) return Promise.resolve();
  // A trigger arriving mid-walk queues ONE re-run instead of sharing the in-flight pass: a pass
  // that began before a write cannot contain it, and adopting it would take the optimistically
  // painted rows away again. Bounded to one so sustained writes converge.
  if (walking) { walkAgain = true; return walking; }
  walking = (async () => {
    try {
      const snap = await readCollection(state.collection);
      snap.host = state.host;
      adopt(snap);
      walkedOnce = true;
      hideRecoveryBadge();             // the state the badge exists for is over
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
// anything; when it can't, the click paints with ZERO extra round trips. Conflicts are structured
// (ok:false + note + current row).
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
      // The mark may step to this ack's seq only when NO sibling write is in flight: an overlapping
      // write sits BELOW that seq, unapplied, and the probe would never go back for it. Sequential
      // clicks stay 0-RTT; genuinely concurrent writes pay one walk at the end of the burst.
      const advance = d.kind === "apply" && pendingWrites === 1;
      if (rows) {
        state = {
          ...state, items: rows,
          version: advance ? Math.max(Number(state.version) || 0, Number(sc.seq) || 0) : state.version,
          total: state.total + (rows.length - state.items.length),
        };
        if (state.collection === "settings") {
          if (advance) lastSettingsVersion = state.version;
          // ingestPrefs emits only when this app's MERGED prefs moved, and the settings app writes
          // OTHER apps' groups — but the bound rows did change, so repaint exactly once either way.
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

/** Tool names a widget's own call must be STAMPED for — the writes where "who did this" is a
 *  fact about the user, not about whoever typed the tool name. Typed verbs and the generic
 *  callTool door both go through the stamp, so neither is a cheaper way to write. The membership
 *  lives in tool-policy.mjs, beside the runner guard's write set: one home for the list. */
const STAMPED_TOOLS = new Set(STAMPED_LIST);

/** The direct runtime's half of the same loop — same implementation, different transport. */
const confirmable = withConfirmation({ send: call, ask: shellConfirm });

// ---- preferences: prefetched at boot, group-indexed (app-name-INDEPENDENT), merged lazily per
// read — identity may not be known yet when the data arrives. The name is resolved at EVERY use,
// never cached into data structures (the loader learns it only by ready()-flush time).
//
// WHO WE ARE, most trustworthy first. `__OMA_APP__` is stamped by us (wrapApp at serve time, or
// the loader after it mounts the app); the other two come from the host, which can hand a widget
// another call's envelope.
const compName = () =>
  (typeof window !== "undefined" && window.__OMA_APP__) ||
  state.app || (toolInput && toolInput.app) || null;

// Value coercion (coercePref) lives in runtime-core: the engine's confirm_delete gate reads it too.

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
  updateSystemBadge();                          // the `system_badge` pref flips take effect live
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

// REMEMBERING WHO WE ARE across a re-render the host binds to the wrong call. A host may re-render
// a widget with ANOTHER tool call's envelope (ChatGPT web, multi-call turns: the turn's first call
// is replayed verbatim), or with none at all; no guard can tell a wrong envelope from a right one.
// The first mount does know, so it writes identity into the host's own per-instance state
// (`window.openai.setWidgetState` / `widgetState`, replayed on re-render). Vendor API:
// feature-detected and namespaced under one key; a host without it loses nothing.
const STATE_KEY = "__oma";
function rememberIdentity() {
  const known = toolInput.app || state.app;
  if (known) for (const w of identityWaiters.splice(0)) w(known);
  try {
    const oai = window.openai;
    if (!oai || typeof oai.setWidgetState !== "function") return;
    const name = toolInput.app || state.app;
    if (!name) return;
    const prev = oai.widgetState || {};
    const mine = prev[STATE_KEY] || {};
    if (mine.app === name && mine.collection === state.collection && mine.host === state.host) return;
    // Preserve whatever the app keeps here — we are a guest in this object. `host` rides along: it
    // too arrives only on a channel a mis-bound re-render never delivers.
    oai.setWidgetState({ ...prev, [STATE_KEY]: {
      app: name, collection: state.collection || null, host: state.host || null } });
  } catch (_) { /* a host that rejects the write leaves us exactly where we were */ }
}
/** What the host replayed to us about ourselves, if it kept anything. Read-only. */
function recallIdentity() {
  try { return (window.openai?.widgetState || {})[STATE_KEY] || null; } catch (_) { return null; }
}
/** Fill whatever `state` is missing from the note a previous mount wrote down. First-wins like
 *  every identity channel — a recovered value never overwrites one that arrived live. */
function recoverIdentity() {
  const kept = recallIdentity();
  if (!kept || !kept.app) return null;
  if (!state.app) state.app = kept.app;
  if (!state.collection && kept.collection) state.collection = kept.collection;
  if (!state.host && kept.host) state.host = kept.host;
  return kept.app;
}

/** Where app→app links point from THIS document, one resolution chain for every reader.
 *  `__OMA_STANDALONE__.viewBase` is the embedding shell's own mount base (browser viewer,
 *  hosted /app); `__OMA_VIEW_BASE__` is the engine's viewer, stamped into a WIDGET document by
 *  wrapApp/wrapLoader only when the engine has one (not under OMA_VIEWER=0). The relative default
 *  works only where page and viewer share an origin; absolute-or-nothing readers test for it. */
function linkBase() {
  const sa = SA && typeof SA.viewBase === "string" && SA.viewBase;
  if (sa) return sa;
  try { if (typeof window.__OMA_VIEW_BASE__ === "string" && window.__OMA_VIEW_BASE__) return window.__OMA_VIEW_BASE__; } catch (_) { /* no window */ }
  return "/view/";
}

// ---- the system badge + mount recovery ----------------------------------------------------
// ONE corner affordance on every widget, three states:
//   · hover (default)  — invisible until the pointer finds the corner; zero pixels taken
//   · always           — the shared `system_badge` preference keeps it visible
//   · forced           — recovery: the retry ladder ended and no walk has EVER succeeded, so the
//     badge stops waiting to be found. Any successful walk clears it.
// Recovery: a re-render handed another call's envelope carries no `collection`, so nothing walks
// and the widget paints with no data, forever — though the bridge and engine are fine. So ask
// again: the ladder rebinds from the identity note and walks, and the badge's tap does the same
// (it is also a user gesture, for a host that gates tool calls until one).
//
// The same row also reveals:
//   · ⚙ settings — oma.embed("settings") in place. As a sandboxed child it cannot call
//     control-plane tools or embed further: it edits preferences and data, not apps.
//   · ⧉ browser  — oma.openLink(viewer URL); the viewer origin is in this widget's
//     redirect_domains. Drawn only when there is an absolute viewer base (none under OMA_VIEWER=0).
const MOUNT_RETRY_MS = [800, 2500, 7000];
let sysBadge = null;        // the refresh <button> — the corner's first and default action
let sysBar = null;          // the corner row that holds it and the menu actions
let badgeForced = false;    // recovery state — outlives hover, cleared by any successful walk
let sysPanel = null;        // the open settings overlay {wrap, handle, onKey}, or null
/** The absolute viewer base, or null. Absolute-or-nothing: a host iframe is an opaque origin, so
 *  the relative default resolves to nowhere and a link built on it is a dead item. */
function viewerBase() {
  const b = linkBase();
  return typeof b === "string" && /^https?:\/\//.test(b) ? b : null;
}
function scheduleMountRecovery() {
  let rung = 0;
  const tick = () => {
    if (walkedOnce || !subscribed()) return;   // a page has nothing to recover
    recoverIdentity();
    if (state.collection) walk();
    rung++;
    if (rung < MOUNT_RETRY_MS.length) setTimeout(tick, MOUNT_RETRY_MS[rung]);
    else setTimeout(() => { if (!walkedOnce) showRecoveryBadge(); }, 1500);
  };
  setTimeout(tick, MOUNT_RETRY_MS[0]);
}
function sysButton(label, title) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "oma-sysbadge";
  b.textContent = label;
  b.title = title;
  b.setAttribute("aria-label", title);
  return b;
}
/** Settings, in place: an overlay panel with the settings app embedded in it. A TOGGLE — the same
 *  item closes it — and Escape closes it too, the same key shellConfirm's card answers to. */
function toggleSettingsPanel() {
  if (sysPanel) { closeSettingsPanel(); return; }
  const wrap = document.createElement("div");
  wrap.className = "oma-syspanel";
  const bar = document.createElement("div");
  bar.className = "oma-syspanel-bar";
  const title = document.createElement("span");
  title.textContent = "Settings";
  const x = document.createElement("button");
  x.type = "button";
  x.textContent = "Close";
  x.title = "Close settings";
  x.onclick = () => closeSettingsPanel();
  const body = document.createElement("div");
  body.className = "oma-syspanel-body";
  bar.append(title, x);
  wrap.append(bar, body);
  const onKey = (e) => { if (e.key === "Escape") closeSettingsPanel(); };
  document.addEventListener("keydown", onKey, true);
  document.documentElement.append(wrap);
  const mine = { wrap, handle: null, onKey };
  sysPanel = mine;
  // The ONE mount machine (oma.embed → the runner): caps-enforced, tokens inherited, kept fresh
  // off our own probe. No deep link — the settings app takes no "focus this app" argument.
  window.oma.embed("settings", { into: body, preset: "live", heights: { min: 320, max: 20000 } })
    .then((h) => { if (sysPanel === mine) mine.handle = h; else h.unmount(); })
    .catch((e) => { if (sysPanel === mine) body.textContent = "Couldn't open settings — " + ((e && e.message) || e); });
}
function closeSettingsPanel() {
  if (!sysPanel) return;
  const p = sysPanel;
  sysPanel = null;
  try { document.removeEventListener("keydown", p.onKey, true); } catch (_) { /* stub document */ }
  try { if (p.handle) p.handle.unmount(); } catch (_) { /* already gone */ }
  p.wrap.remove();
}
function ensureSystemBadge() {
  if (sysBadge || typeof document === "undefined") return;
  const st = document.createElement("style");
  st.setAttribute("data-oma", "sysbadge");
  st.textContent =
    ".oma-sysbar{position:fixed;bottom:10px;right:10px;z-index:2147483646;display:flex;gap:6px;align-items:center}" +
    ".oma-sysbadge{border:0;cursor:pointer;background:#23282b;color:#fff;padding:6px 12px;border-radius:9px;" +
    "font:12.5px/1.45 -apple-system,system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3);" +
    "opacity:0;transition:opacity .15s}" +
    ".oma-sysbar.oma-on .oma-sysbadge,.oma-sysbadge:focus-visible,.oma-sysbadge.oma-on{opacity:1}" +
    "@media (prefers-reduced-motion: reduce){.oma-sysbadge{transition:none}}" +
    // HIDDEN MEANS NOT THERE. The corner used to wait, invisible, for a hover — on top of the app's own
    // bottom-right control, which is exactly where apps put their main button: a click on a card's
    // "open full screen" hit refresh or settings instead (seen in Claude, 2026-10-04), and a touch
    // screen could never even reveal it. The engine does not cover the app: the corner shows when the
    // binding is lost (forced) or the user asked for it (system_badge=always), and keyboard focus can
    // still reach it; otherwise clicks go through to the app.
    ".oma-sysbar:not(.oma-on),.oma-sysbar:not(.oma-on) .oma-sysbadge:not(:focus-visible){pointer-events:none}" +
    ".oma-syspanel{position:fixed;inset:0;z-index:2147483645;display:flex;flex-direction:column;" +
    "background:var(--color-background-primary,Canvas)}" +
    ".oma-syspanel-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;background:#23282b;color:#fff;" +
    "font:12.5px/1.45 -apple-system,system-ui,sans-serif}" +
    ".oma-syspanel-bar button{margin-left:auto;border:0;cursor:pointer;background:rgba(255,255,255,.16);color:#fff;" +
    "border-radius:7px;padding:4px 10px;font:inherit}" +
    ".oma-syspanel-body{flex:1;min-height:0;overflow:auto}";
  const bar = document.createElement("div");
  bar.className = "oma-sysbar";
  const b = sysButton("↻", "Refresh this app's data");
  b.onclick = () => {
    b.disabled = true;
    recoverIdentity();
    if (!state.collection) {
      // The host kept no note for us (or never exposes one) — the engine-side rope ends here.
      omaNotify("Couldn't rebind this view — ask the assistant to open the app again.");
      b.disabled = false;
      return;
    }
    walk().finally(() => { b.disabled = false; });   // success clears the forced state from inside walk()
  };
  const gear = sysButton("⚙", "Open settings");
  gear.onclick = () => toggleSettingsPanel();
  bar.append(b, gear);
  // The item exists only when there is a viewer to send the user to.
  if (viewerBase()) {
    const out = sysButton("⧉", "Open in browser");
    out.onclick = async () => {
      const name = compName() || recoverIdentity();
      if (!name) { omaNotify("Couldn't tell which app this is — ask the assistant to open it again."); return; }
      out.disabled = true;
      const r = await window.oma.openLink(viewerBase() + encodeURIComponent(name));
      out.disabled = false;
      // openLink resolves {ok:false} on a host that will not open links — say so once, rather
      // than leaving a click that looks like nothing happened.
      if (!r || !r.ok) omaNotify("This host wouldn't open the link — the app lives at " + viewerBase() + name);
    };
    bar.append(out);
  }
  document.documentElement.append(st, bar);
  sysBar = bar;
  sysBadge = b;
  updateSystemBadge();
}
function updateSystemBadge() {
  if (!sysBadge) return;
  const always = coercePref(rawPref("system_badge"), "hover") === "always";
  // The row is shown or hidden as ONE affordance: the pref says "keep the corner visible",
  // not "keep the refresh button visible".
  if (sysBar) sysBar.classList.toggle("oma-on", badgeForced || always);
  sysBadge.classList.toggle("oma-on", badgeForced || always);
  sysBadge.textContent = badgeForced ? "↻ Load data" : "↻";
  sysBadge.title = badgeForced
    ? "This view lost its data binding when the page reloaded — tap to fetch it again."
    : "Refresh this app's data";
}
function showRecoveryBadge() {   // the ladder's terminal state — stop waiting to be hovered
  if (walkedOnce || badgeForced) return;
  // A slow first load is not a lost binding: if a walk is still in flight, judge it when it
  // lands, not while it flies.
  if (walking) { walking.finally(() => { if (!walkedOnce) showRecoveryBadge(); }); return; }
  badgeForced = true;
  ensureSystemBadge();
  updateSystemBadge();
}
function hideRecoveryBadge() {   // any successful walk ends the state the forcing exists for
  if (!badgeForced) return;
  badgeForced = false;
  updateSystemBadge();
}

// Internal (the loader is the one caller): which app is this document? A synchronous question,
// answered from what we know — and, for a document that is ready before it is told, a bounded wait.
// Ready no longer implies identity: data is opt-in, so a document that subscribes to nothing (the
// loader) is ready as soon as prefs are warm, and the host's tool input can land after that —
// measured 2026-10-02, a second open_app in one claude.ai conversation mounted, read settings, and
// reported "lost track" with the input still in flight. rememberIdentity() resolves the waiters.
const identityWaiters = [];
try {
  window.__OMA_IDENTITY__ = () => {
    const name = toolInput.app || state.app;
    if (name) return name;
    // Nothing live — the host may still carry the note a previous mount wrote.
    return recoverIdentity();
  };
  window.__OMA_AWAIT_IDENTITY__ = (ms) => new Promise((resolve) => {
    const now = window.__OMA_IDENTITY__();
    if (now) return resolve(now);
    const t = setTimeout(() => { const i = identityWaiters.indexOf(done); if (i >= 0) identityWaiters.splice(i, 1); resolve(null); }, ms);
    const done = (name) => { clearTimeout(t); resolve(name); };
    identityWaiters.push(done);
  });
} catch (_) { /* no window (test rig): the loader is the only caller and it has one */ }

// The host context is kept WHOLE and MERGED (host-context-changed delivers partial updates) on the
// internal __OMA_HOST_CONTEXT__, so the loader's failure surface can report what it was handed
// (toolInfo names the call that instantiated this widget). Deliberately NOT on window.oma:
// toolInfo is engine plumbing, not author API.
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

// A child document inherits none of our CSS, so the page base and the neutral token FALLBACK
// sheet travel with it — read from OUR OWN head (wrapApp/wrapLoader inject both under data-oma
// markers): one copy of the bytes, no drift. With the fallbacks underneath, a per-app token we
// withhold from the child is safe, and its cascade matches ours:
// fallbacks → host/substituted tokens → base → theme (pushed) → its own <style>.
let fallbackCache = null;
function ownFallbackCss() {
  if (fallbackCache == null) {
    const el = document.querySelector('style[data-oma="tokens"]');
    fallbackCache = el ? el.textContent : "";
  }
  return fallbackCache;
}

let baseCache = null;
function ownBaseCss() {
  if (baseCache == null) {
    const el = document.querySelector('style[data-oma="base"]');
    baseCache = el ? el.textContent : "";
  }
  return baseCache;
}

// ---- live embeds: parent-side registry so embedded children stay fresh --------------------
// The embedder's own poll watches ONE collection; embedded children bound elsewhere ride the
// same probe — on a moved global seq each live embed checks its own collection with one
// data_changes call and re-walks only when something actually happened there.
const liveEmbeds = new Set();

// ---- the live pointer: which app the AI last put in front of the user ---------------------
// Pushed on the SAME SSE frame as `seq` (http.mjs /events); the sole input of the `@live` brick
// below. Not on `window.oma`: a channel that decides what a page MOUNTS is not author API.
// It LATCHES and replays on subscribe: the frame sent AT CONNECT carries the app to mount, and a
// brick mounting just after it must not wait for the next open. A SET of subscribers, so a
// second brick on the same wall cannot take the feed from the first.
// SSE is the only carrier — no poll fallback, by design: EventSource reconnects by itself, and a
// display without a feed keeps showing the last app it was given.
let liveSeen = false, liveLast = null;
const liveCbs = new Set();
/** cb(pointer|null) on every pointer frame, replayed immediately if one already arrived.
 *  Returns an unsubscribe — a brick that unmounts must stop being called. */
function onLivePointer(cb) {
  liveCbs.add(cb);
  if (liveSeen) { try { cb(liveLast); } catch (e) { console.error("[oma] live handler threw", e); } }
  return () => liveCbs.delete(cb);
}
function pushLivePointer(p) {
  liveSeen = true;
  liveLast = p;
  for (const cb of [...liveCbs]) { try { cb(p); } catch (e) { console.error("[oma] live handler threw", e); } }
}

// ---- "@live": the display brick -----------------------------------------------------------
// `oma.embed("@live", {into})` — a region that shows whatever app the AI opened last, and swaps
// it by itself when the AI opens another. `@` is not a legal app name (store.mjs APP_NAME_RE
// starts at [a-z]), so the name space this borrows is one no app can ever reach.
const LIVE_NAME = "@live";

/** The brick's own quiet state: a title and a line under it. Built as DOM, never innerHTML —
 *  one of the strings is an app name off the wire, and textContent costs nothing. */
function liveTile(title, body) {
  const el = document.createElement("div");
  el.setAttribute("data-oma", "live-tile");
  el.style.cssText = "display:grid;align-content:center;justify-items:center;gap:5px;box-sizing:border-box;"
    + "min-height:120px;height:100%;padding:24px 20px;text-align:center;"
    + "font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif)";
  const h = document.createElement("div");
  h.style.cssText = "font-size:13px;font-weight:650;color:var(--color-text-secondary,color-mix(in srgb,CanvasText 65%,Canvas))";
  h.textContent = title;
  const p = document.createElement("div");
  p.style.cssText = "font-size:12px;line-height:1.5;max-width:34ch;color:var(--color-text-tertiary,color-mix(in srgb,CanvasText 45%,Canvas))";
  p.textContent = body;
  el.appendChild(h);
  el.appendChild(p);
  return el;
}

/** The `@live` branch of oma.embed. Returns the same {el, unmount, refresh} handle every embed
 *  returns, so an app treats it like any other child. */
function embedLive(opts) {
  const stage = document.createElement("div");
  stage.setAttribute("data-oma", "live-region");
  stage.style.cssText = "display:block;width:100%;height:100%";
  opts.into.appendChild(stage);

  // THE CHAT FACE — a tile, nothing else: inside a chat host there is no pointer stream to hear
  // (SSE lives on the engine's own origin), and a region swapping apps under a conversation would
  // be a page rewriting itself while being read. No pointer, no poll, no data.
  if (!SA) {
    stage.appendChild(liveTile("Live region", "Shows the last-opened app on a standalone display."));
    return {
      el: stage, coll: null,
      refresh: () => Promise.resolve(),
      async tick() {},
      unmount() { try { stage.remove(); } catch { /* already gone */ } },
    };
  }

  let mounted = null;          // {name, handle} — the app on screen
  let dead = false;            // unmount(); every in-flight fetch checks it
  let gen = 0;                 // an A→B switch can land while A's source is still in flight, and
                               // the late answer must abandon rather than mount over B
  const announce = (name) => { if (typeof opts.onApp === "function") try { opts.onApp(name); } catch (e) { console.error("[oma] onApp threw", e); } };
  const wait = (title, body) => { stage.textContent = ""; stage.appendChild(liveTile(title, body)); };
  const idle = () => { wait("Waiting for an app", "Ask your assistant to open one — it appears here."); announce(null); };
  const drop = () => {
    if (mounted) { try { mounted.handle.unmount(); } catch { /* already torn down */ } mounted = null; }
    stage.textContent = "";
  };

  // EVERY app is mounted through oma.embed, local ones included: a direct mount cannot be undone
  // (top-level const/class share the global lexical scope, so the next app dies on redeclaration;
  // listeners and timers leak). An iframe has an unmount. Local apps lose nothing to the runner:
  // TIER_CAPS.local grants every capability.
  const go = async (name) => {
    // The same app opened again is not a switch: its data path is already live, and remounting
    // would throw away a scroll position and any open editor for nothing.
    if (mounted && mounted.name === name) return;
    const mine = ++gen;
    try {
      const r = await rawCall("get_app_html", { name });
      const sc = (r && r.structuredContent) || {};
      if (dead || mine !== gen) return;
      if (!sc.html) { drop(); wait("Nothing to show", 'The app "' + name + '" is no longer in the registry.'); announce(null); return; }
      // A live frame never mounts a live frame (`manifest.live_frame`, contracts.mjs liveFrameFor).
      // The outer wall (tools/apps.mjs) keeps a frame's name out of the pointer; this one holds if
      // it got there anyway. Terminal, not retried.
      if (sc.declaration && sc.declaration.live_frame === true) { drop(); idle(); return; }
      drop();
      const handle = await window.oma.embed(name, {
        into: stage,
        html: sc.html,
        caps: sc.caps || {},
        tier: sc.tier == null ? "local" : sc.tier,
        // Already fetched: saves embed a second call. The FRAMED app's network declaration.
        csp: sc.csp || null,
        // The binding the ENGINE computed: embed's default is the app NAME, and an app whose rows
        // live in a differently named collection would mount blank.
        collection: sc.collection || name,
        // Sizing is the WALL's decision, not the brick's.
        ...(opts.heights === undefined ? {} : { heights: opts.heights }),
        ...(opts.fit ? { fit: opts.fit } : {}),
      });
      if (dead || mine !== gen) { try { handle.unmount(); } catch { /* nothing built */ } return; }
      mounted = { name, handle };
      announce(name);
    } catch (e) {
      if (dead || mine !== gen) return;
      drop();
      // KEEP TRYING: nobody is at this screen to press reload. Definitive answers (gone, a display)
      // do not retry; the next pointer change supersedes this loop by moving `gen`.
      wait("Couldn't load " + name, "Retrying…");
      announce(null);
      setTimeout(() => { if (!dead && mine === gen) go(name); }, 5000);
    }
  };

  idle();
  const off = onLivePointer((p) => {
    const name = p && p.app;
    if (name) go(name);   // null = nothing has ever been opened; the waiting state already says so
  });

  return {
    el: stage,
    get coll() { return mounted ? mounted.handle.coll : null; },
    refresh: () => (mounted ? mounted.handle.refresh() : Promise.resolve()),
    // The mounted child is its OWN entry in liveEmbeds (oma.embed put it there), so the
    // embedder's probe already reaches it. Nothing for the brick itself to poll.
    async tick() {},
    unmount() {
      dead = true;
      off();
      drop();
      try { stage.remove(); } catch { /* already gone */ }
    },
  };
}

// ---- the public API apps are written against ----
window.oma = {
  /** Current snapshot: { collection, items: [{id, group, position, fields, version}], version,
   *  total, truncated } — total/truncated let an app say "N of M" honestly. */
  get state() { return state; },
  /** cb(state) once the bridge is connected and initial data has arrived — or, if that never
   *  happens, AFTER A DEADLINE with whatever state we have: a late answer the caller can act on
   *  beats a spinner forever. onChange still fires if data arrives afterwards. 8s sits under the
   *  10s bridge deadline (a released callback still gets a full window for its first call) and
   *  above any healthy handshake. */
  ready(cb) {
    if (ready) return cb(state);
    readyCbs.push(cb);
    // ONE timer at a time, re-armed after each firing (the handle is cleared inside), so a
    // registration after an expired deadline gets its own window instead of waiting forever.
    if (readyDeadline == null) readyDeadline = setTimeout(() => {
      readyDeadline = null;
      if (ready) return;
      const waiting = readyCbs.splice(0);
      console.warn("[oma] ready deadline: the host never delivered initial state; releasing " +
        waiting.length + " callback(s) with an empty snapshot");
      for (const fn of waiting) { try { fn(state); } catch (e) { console.error("[oma] ready callback failed", e); } }
    }, 8000);
  },
  /** cb(state) after every data change (including your own mutations). Subscribing is what makes
   *  the app read its collection at all — without it the app is a page. */
  onChange(cb) { changeCbs.push(cb); if (changeCbs.length === 1 && live) walk(); },
  // actor:"human" in the writes below is enum-constrained AUDIT metadata, never authorization:
  // it is caller-chosen and forgeable in direct mode; only a runner-stamped app identity is
  // trustworthy write provenance. `via` is the same class of metadata — the app's shadow edge
  // for the Data pane, stripped from every AI-facing read.
  /** Add an item. fields is any JSON object your app defines. */
  addItem({ group = "", fields = {}, position } = {}) {
    // A widget can be interactive before any binding arrives; collection:null would bounce off
    // the server. Fail loudly and locally — the next poll/toolresult binds and a retry succeeds.
    if (!state.collection) {
      omaNotify("⚠ No collection bound yet — try again in a moment.");
      return Promise.reject(new Error("no collection bound yet"));
    }
    return call("data_add_item", { command_id: uuid(), collection: state.collection, group, fields, position, actor: "human", via: viaOf(compName()) }).then(ackOf);
  },
  // Widget mutations are LAST-WRITE-WINS (no expected_version), like setPref: two fast clicks on
  // one item would otherwise race on a stale version into a spurious conflict. AI-vs-user races
  // converge via the ack continuity rule + the poll; the AI can still request OCC via data_* tools.
  /** Shallow-merge fields into an item (set a key to null to delete it). */
  updateItem(id, fields) {
    return call("data_update_item", { command_id: uuid(), id, ...sharedBinding(), fields, actor: "human", via: viaOf(compName()) }).then(ackOf);
  },
  /** Move an item to another group (and/or position). */
  moveItem(id, group, position) {
    return call("data_move_item", { command_id: uuid(), id, ...sharedBinding(), group, position, actor: "human", via: viaOf(compName()) }).then(ackOf);
  },
  /** Delete an item. */
  deleteItem(id) {
    return confirmable("data_delete_item", { command_id: uuid(), id, ...sharedBinding(), actor: "human", via: viaOf(compName()) }).then(ackOf);
  },
  /** Re-read the bound collection (a full paged walk; adopted through the gate). */
  refresh() { return walk(); },
  /**
   * Read ANY collection as a full paged walk — items/version/total/truncated — WITHOUT
   * touching this widget's own bound state.
   */
  readCollection(collection) { return readCollection(collection); },
  /**
   * SYNC merged preference read: own app override ▸ global ▸ fallback, computed
   * lazily at call time. The fallback's TYPE drives coercion (junk values → fallback).
   */
  pref(key, fallback) { return coercePref(rawPref(key), fallback); },
  /** cb({key, value, oldValue, scope}) — fired once per key whose EFFECTIVE (merged) value changed. */
  onPrefChange(cb) { prefCbs.push(cb); },
  /**
   * Persist one of THIS app's own settings (scalar values only). Own group only —
   * API-layer scoping, not a security boundary.
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
      // Staleness is PER ROW: applyAck refuses only superseded rows, so concurrent setPref calls
      // (a settings form) each keep their value, and the watermark only takes the max.
      if (sc && sc.item) {
        const rows = applyAck(prefItems, sc);
        if (rows) {
          // Merging the row is always safe; MOVING THE WATERMARK is not — another actor's write may
          // sit below this seq, unread, and the probe would never sync it. Same inequality as the
          // bound collection: only a receipt whose `prev` is inside our mark may advance it.
          const prev = Number(sc.prev_collection_seq);
          const held = Number(lastSettingsVersion) || 0;
          if (Number.isFinite(prev) && prev <= held) lastSettingsVersion = Math.max(held, Number(sc.seq) || 0);
          else schedulePrefSync();   // something else touched settings first — go read it
          ingestPrefs(rows, true);
        }
      }
      return r;
    // Bypassing call() also bypasses its ack unwrap; setPref resolves an OmaAck like every write verb.
    }).then(ackOf);
  },
  /**
   * Escape hatch: call any tool on the server. SECURITY: a full, unmediated passthrough to every
   * registered MCP tool — tolerable ONLY because direct mode is local-authored-only; untrusted
   * apps run behind the runner, which filters calls.
   */
  callTool(rawName, args) {
    // Canonicalise FIRST (as the runner guard does): retired spellings still resolve, and both
    // rules below match on the name — the old spelling must not be a way around the stamp.
    const name = canonicalToolName(rawName);
    const a = args || {};
    // A widget's write is a widget's write, whichever door it used: stamped human and sent through
    // the same confirmation loop as oma.deleteItem — the rule the runner enforces for children.
    if (STAMPED_TOOLS.has(name)) {
      return confirmable(name, { command_id: uuid(), ...a, actor: "human", via: viaOf(compName()) });
    }
    // apply_data_writes is the MODEL's bulk verb, refused here as the runner refuses it to children.
    // Unstamped it would delete with no confirmation and record `agent` in an append-only ledger;
    // stamped, one demand inside the all-or-nothing batch fails the whole call. Apps loop
    // oma.deleteItem instead — shellConfirm coalesces the burst into ONE card.
    if (name === "apply_data_writes") {
      return Promise.reject(new Error(DATA_BATCH_REFUSAL));
    }
    return rawCall(name, a);
  },
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
   * Call a function THIS app declares (manifest.functions) — data in, data out, no UI touched.
   * The runner forces the callee to this app and stamps via/actor, so a widget can never reach
   * another app's functions through this door. Resolves the engine's ack body
   * ({ok, result?, writes}) or the typed failure body ({ok:false, reason, …}) — a refusal is an ANSWER here, not an exception, the
   * same contract every other data verb keeps.
   */
  callFunction(fn, args) {
    // Same self-stamped envelope as every direct-mode write (app forced to SELF, actor human,
    // via = this app); under a runner the guard re-forces all three, so the two doors agree.
    return rawCall("call_function", {
      command_id: uuid(), app: compName(), function: String(fn),
      ...(args == null ? {} : { args }), actor: "human", via: viaOf(compName()),
    }).then((r) => (r && r.structuredContent) || null);
  },
  /**
   * Mount another app INSIDE this one (sandboxed, caps-enforced — the same runner
   * machine the loader uses; depth 1: an embedded child cannot embed further).
   * opts: { into: Element (required), preset: "live"|"inert", collection, html,
   *         snapshot, heights: {min,max}|false, fit: {width} }.
   * `fit` renders the child at its natural `width` px and scales the frame to fill `into`
   * (thumbnails, previews) — sizing via heights is off while it is on.
   * Returns { el, unmount, refresh }.
   *
   * `name` may also be the ONE reserved brick, `"@live"`: a region showing whatever app the AI
   * opened last, swapping by itself as it opens others. Extra opts there: `onApp(name|null)`
   * (fires on every switch, and with null while the region is waiting). See embedLive — and note
   * the depth budget is unchanged, because the app the brick resolves IS the one level.
   */
  async embed(name, opts = {}) {
    const n = String(name);
    if (!opts.into || typeof opts.into.appendChild !== "function") throw new Error("embed: opts.into element required");
    // The reserved brick, taken before anything else: it resolves its own target, so none of the
    // source/binding/preset machinery below applies to it. `@` cannot begin an app name
    // (store.mjs APP_NAME_RE), so this branch can never shadow a real app.
    if (n === LIVE_NAME) return embedLive(opts);
    const preset = opts.preset || "live";
    let html = opts.html, caps = opts.caps, tier = opts.tier, csp = opts.csp;
    // Inert children never call anything, so provided html is all they need; every other
    // preset resolves the engine truth (source + tier + caps) unless the caller provided it.
    if ((html == null || caps == null) && !(preset === "inert" && html != null)) {
      const r = await rawCall("get_app_html", { name: n });
      const sc = (r && r.structuredContent) || {};
      if (!sc.html) throw new Error('embed: app "' + n + '" not found');
      if (html == null) html = sc.html;
      if (caps == null) caps = sc.caps || {};
      if (tier == null) tier = sc.tier == null ? "local" : sc.tier;
      // THE MOUNTED APP's network declaration (manifest.csp ∪ the user's policy:csp rows), never
      // this document's. None from the engine ⇒ the child gets the floor.
      if (csp == null) csp = sc.csp || null;
    }
    if (caps == null) caps = {};
    if (tier == null) tier = "local";
    // A caller-supplied snapshot is SHARED (the embedder fetched every collection once):
    // childPreviewSnapshot cuts this child's share and picks the binding by the engine's rule —
    // the same rule composePreviewDoc uses. An explicit opts.collection still wins.
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
    // A SHARED child is another account's code: none of THIS user's settings are its to read
    // (S4 audit T13a). It gets an empty map — oma.pref answers its fallbacks — and the parent does
    // not even fetch settings on its behalf. A handle-named app is shared whatever tier was passed.
    const noPrefs = tier === "shared" || n.charAt(0) === "@";
    function rebuildPrefs(rows, ver) {
      if (dead) return;
      if (typeof ver === "number") {
        if (ver < prefVersion) return;   // a boot read that finished LATE is not newer information
        prefVersion = ver;
      }
      if (noPrefs) rows = [];
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
        snapshot: () => childSnap,
        settingsIds: () => settingsIds,
        readCollection,
        readFile: (app, path) => fileBytes(app, path).then((f) => {
          let s = ""; const b = f.bytes;
          for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
          return { base64: btoa(s), mime: f.mime };
        }),
        notify: omaNotify,
        // engine confirmation demands render in OUR chrome
        requestConfirm: shellConfirm,
        uuid,
      },
    });

    const frame = document.createElement("iframe");
    // allow-forms is for the submit EVENT, not the submission: without it Chrome refuses the form
    // before dispatching `submit`, so an app's onsubmit (and its preventDefault) never runs. The
    // submission stays closed by three walls: the child's `form-action 'none'`, the embedder's
    // `frame-src 'none'`, and the bridge's unconditional cancel (runner.mjs BRIDGE).
    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    // heights:false hands ALL sizing to the embedder's own CSS (scaled thumbnails, preview
    // fit) — no inline size properties to out-specificity a stylesheet. `fit` implies it.
    const H = opts.fit || opts.heights === false ? null : opts.heights || { min: 60, max: 20000 };
    frame.style.cssText = "display:block;border:0;" + (H ? "width:100%;height:" + Math.max(H.min, 140) + "px" : "");
    // fit: {width} — scale-to-thumbnail. The child renders at its natural fit.width; the frame is
    // scaled to fill `into`, whose CSS keeps owning the visible box. Pointer behaviour stays the
    // caller's (an inert thumbnail sets pointer-events:none in its own stylesheet).
    let fitObserver = null;
    if (opts.fit && Number(opts.fit.width) > 0) {
      const nat = Number(opts.fit.width);
      const applyFit = () => {
        const w = opts.into.clientWidth, h = opts.into.clientHeight;
        if (!w) return;                       // hidden — the observer re-fires when it shows
        const s = w / nat;
        frame.style.width = nat + "px";
        frame.style.height = Math.max(1, Math.ceil(h / s)) + "px";
        frame.style.transform = "scale(" + s + ")";
        frame.style.transformOrigin = "0 0";
      };
      applyFit();
      if (typeof ResizeObserver === "function") {
        fitObserver = new ResizeObserver(applyFit);
        fitObserver.observe(opts.into);
      }
    }

    // `changed` covers the apply-refresh case: an optimistic apply does not move childSnap.version,
    // so the bridge's own change test cannot see an UPDATE — the parent says so explicitly.
    function push(changed) {
      if (!frame.contentWindow) return;
      frame.contentWindow.postMessage({
        omaRunSnapshot: true,
        ...(changed ? { changed: true } : {}),
        snapshot: { collection: childSnap.collection || coll, items: childSnap.items || [], version: childSnap.version || 0, app: n, host: state.host },
        prefs: prefMap || {},
        compKeys,
        // The theme layer for THIS child, resolved here: prefMap already merged global with the
        // child's own group, and themeVars already dropped anything failing the token charsets.
        // The child applies the pairs verbatim — no second copy of the rule inside the bridge.
        themeVars: themeVars(prefMap || {}),
      }, "*");
    }

    // Prefs + first data, per preset: live walks both in full; inert touches nothing — its
    // snapshot came with the fixtures.
    let boot = Promise.resolve();
    if (preset === "live") {
      // Boot results are the OLDEST information this embed will ever have, but they can arrive
      // LAST (a slow first read racing a fast child write). Both legs therefore adopt the same way
      // every other path does — version-monotonically, and never after unmount.
      boot = Promise.allSettled([
        (noPrefs ? Promise.resolve() : readCollection("settings").then((s) => rebuildPrefs(s.items || [], s.settings_version)))
          .catch(() => {}).then(() => { if (prefMap === null) prefMap = {}; }),
        opts.snapshot ? Promise.resolve()
          : readCollection(coll)
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
          // NOTHING a child asked for rebuilds prefs or settingsIds: a filtered settings read that
          // matches nothing would empty the set the guard uses to recognise foreign settings rows
          // (bypassing settings_write:false). The parent keeps them fresh from its OWN full walks:
          // boot, the post-ack re-walk below, and onParentPref.
          // Likewise ONLY a refresh restates the child's projection: readCollection may return a
          // FILTERED subset, and adopting it would drop every row outside the filter for good.
          if (d.method === "refresh" && sc.collection === coll && (sc.version || 0) >= (childSnap.version || 0))
            childSnap = { ...childSnap, items: sc.items, version: sc.version || 0 };
          push();
        } else if (sc && "ok" in sc) {
          // Child writes go through the SAME continuity rule as the top-level widget's, so a
          // concurrent write since the child's read is never skipped.
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
        if (fitObserver) { try { fitObserver.disconnect(); } catch {} }
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
    // pref map fresh as the user flips switches, without a second fetch.
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
      if (preset === "inert" || noPrefs) return;
      clearTimeout(prefT);
      prefT = setTimeout(() => {
        readCollection("settings").then((s2) => { rebuildPrefs(s2.items || [], s2.settings_version); if (!dead) push(); }).catch(() => {});
      }, 250);
    };
    prefCbs.push(onParentPref);
    if (preset === "live") liveEmbeds.add(handle);

    frame.onload = () => { Promise.race([boot, new Promise((r) => setTimeout(r, 1200))]).then(push, push); };
    // Context is inherited: on a standalone page the child is told so too, or it draws a chat card
    // inside a region meant to be its ground. `inert` is the exception — it is a PICTURE of the
    // widget as a chat shows it, card included.
    frame.srcdoc = composeChildDoc(html, { tokenCss: tokenCSS(document, childTokenSubstitutes()), baseCss: ownBaseCss(), fallbackCss: ownFallbackCss(), bridge: BRIDGE, standalone: !!SA && preset !== "inert", csp });
    opts.into.appendChild(frame);
    return handle;
  },
  /** True when running in a plain browser page (no chat attached — sendMessage unavailable). */
  get standalone() { return !!SA; },
  /**
   * Base path for app→app links (e.g. `oma.viewBase + name`). Defaults to the
   * engine viewer's "/view/"; an embedding shell sets standalone.viewBase to its own mount
   * base so links resolve there. Single source of truth — apps never hardcode "/view/".
   * Resolution chain: linkBase().
   */
  get viewBase() { return linkBase(); },
  /**
   * PROPOSE a message into the chat (ui/message). Call ONLY from an explicit user click
   * (e.g. a "Send to AI" button) — never automatically.
   *
   * ⚠️ The resolved value means THE HOST ACCEPTED THE REQUEST, not that the user sent anything —
   * never render "done" on it. Hosts mediate: Claude places the text in the composer UNSENT;
   * ChatGPT shows an editable Cancel/Send modal. Nothing on the wire reports the outcome.
   */
  sendMessage(text) {
    const t = String(text);
    // GLOBAL degradation: no chat channel (standalone page) or a host that rejects/fails the call
    // (e.g. Codex widget-proxy -32000) falls back to the CLIPBOARD — the user pastes the text to
    // their AI. Apps never need their own fallback. The degraded result is NOT an exception
    // (isError + degraded tag), so apps do not crash.
    const degrade = (why) => {
      let p;
      try { p = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(t) : Promise.reject(new Error("no clipboard")); }
      catch (e) { p = Promise.reject(e); }
      return p.then(
        () => { omaNotify("Copied to clipboard — paste it to your AI (" + why + ")."); return { isError: true, degraded: "clipboard" }; },
        () => { console.warn("[oma] sendMessage degraded (" + why + "); text:", t); omaNotify("Couldn't reach the chat (" + why + ") — the text is in the console."); return { isError: true, degraded: "console" }; });
    };
    if (SA) return degrade("no chat attached");
    // NOTHING IS SAID ON THE SUCCESS PATH, deliberately: the protocol gives no completion signal,
    // and a runtime-level notice was wrong on real hosts in both directions. The caller decides
    // what to show (KNOWN-ISSUES: on a host that only stages the text, a click can look like
    // nothing happened).
    return hostApp.sendMessage({ role: "user", content: [{ type: "text", text: t }] })
      .then((r) => (r && r.isError ? degrade("host declined") : r))
      .catch((e) => degrade((e && e.message) || "send failed"));
  },
  /**
   * Open a URL through the host (ui/open-link). Where sendMessage PROPOSES, this DOES the thing —
   * no model, no host trust decision about app-authored text. A widget cannot navigate on its own
   * (its sandbox has no allow-top-navigation / allow-popups).
   *
   * Resolves { ok } rather than throwing: "the host will not open links" is a normal answer on
   * some surfaces, and the caller decides what to show.
   */
  openLink(url) {
    const u = String(url || "");
    if (!u) return Promise.resolve({ ok: false });
    // Standalone (browser viewer): no host to ask. A blocked popup returns null rather than
    // throwing, so `ok` is what window.open RETURNED.
    // Not window.open(u, "_blank", "noopener"): with noopener it returns null even when the tab
    // opened, so ok was always false. Open, then cut the opener by hand.
    if (SA) { try { const w = window.open(u, "_blank"); if (w) w.opener = null; return Promise.resolve({ ok: !!w }); } catch (e) { return Promise.resolve({ ok: false }); } }
    return hostApp.openLink({ url: u })
      .then((r) => ({ ok: !(r && r.isError) }))
      .catch(() => ({ ok: false }));
  },
  /** "inline" | "fullscreen" — where the app is shown right now (also <html data-oma-display>). */
  get display() { return display; },
  /** The modes this host will actually switch to, e.g. ["inline", "fullscreen"]. A mode missing
   *  here is one requestDisplay cannot reach — don't offer a button for it. */
  get displayModes() { return [...displayModes]; },
  /**
   * Ask the host to show this app inline or fullscreen (ui/request-display-mode). Call from a user
   * click. Resolves { ok, mode } — `mode` is where the host actually put us, which may not be what
   * was asked (the host decides); never throws.
   */
  requestDisplay(mode) {
    const want = String(mode || "");
    if (SA || !displayModes.includes(want)) return Promise.resolve({ ok: want === display, mode: display });
    return hostApp.requestDisplayMode({ mode: want })
      .then((r) => { const got = (r && r.mode) || want; applyDisplay({ displayMode: got }); return { ok: got === want, mode: got }; })
      .catch(() => ({ ok: false, mode: display }));
  },
  /** cb(mode) whenever the display mode changes — by requestDisplay, or by the host (its own
   *  expand/close controls). */
  onDisplayChange(cb) { if (typeof cb === "function") displayCbs.push(cb); },
  /**
   * What this app can do, named for the AI (ext-apps "App-provided tools"):
   *   const off = oma.tools.register({ name, description, inputSchema, annotations, run(input) })
   * `inputSchema` is plain JSON Schema (an object's properties / required); `run` may be async and
   * returns a string, any JSON value, or an MCP CallToolResult. The AI calls it by name — natively
   * where the host supports app tools, else through the screen relay. This page only: never
   * persisted; registering a name again replaces it; `off()` removes it.
   */
  tools: { register: (def) => appTools.register(def) },
};

// INTERNAL bind hook — not author API; the universal loader is the one caller. DIRECT MODE ONLY;
// first wins, like every other writer of state.collection. The loader hands over the binding
// `get_app_html` computed — it never recomputes it (contracts.mjs defaultCollectionFor owns that).
window.__OMA_BIND__ = (collection) => {
  if (typeof collection === "string" && collection && !state.collection) state.collection = collection;
  return state.collection;
};

// …and the same seam for the HOST LABEL, which the loader already holds from get_app_html.
// First-wins like the binding: a widget's host never changes, and the browser viewer stamps its
// own label before this can be called.
window.__OMA_HOST__ = (host) => {
  if (typeof host === "string" && host && !state.host) state.host = host;
  return state.host;
};

// Staleness: the AI (or another host — CLI, another chat) can write via data_* while this
// widget sits on screen. ADAPTIVE poll while visible: each tick asks the cheap get_data_version
// probe; a moved GLOBAL seq is then confirmed against OUR collection with one data_changes
// call — a foreign collection's write costs a probe + one tiny check, never a full walk
// (and safely advances our mark, so it doesn't re-fire). settings changes are caught from
// the probe's settings_version — write acks carry no settings snapshots. After user
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
  if (pendingWrites > 0 || !subscribed()) return;
  const r = await rawCall("data_changes", { collection: state.collection, since: state.version });
  const d = r && !r.isError ? r.structuredContent : null;
  const verdict = decideChanges(d);
  if (verdict.kind === "walk") { await walk(); pollDelay = FAST_MS; }  // hot: keep streaming
  else if (verdict.kind === "advance") state = { ...state, version: verdict.to };  // all elsewhere — silent
}
async function pollTick() {
  if (ready && document.visibilityState === "visible" && state.collection && subscribed()) {
    try {
      const r = await rawCall("get_data_version", sharedBinding());
      if (r && r.isError && isNotShared(r)) { noLongerShared(); setTimeout(pollTick, pollMs()); return; }
      const sc = r && !r.isError ? r.structuredContent : null;
      if (!sc || typeof sc.seq !== "number") await walk();  // engine predates get_data_version → old behavior
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

// ---- broken-mount notice: an uncaught error during the initial window tells the USER what
// happened and names the explicit recovery path (list_app_checkpoints → restore_app, driven
// through the AI) — never an automatic rollback. Earlier parse-time errors arrive via the
// __OMA_EARLY_ERRORS__ buffer (a classic script installed before any app code runs).
{
  const REPORT_WINDOW_MS = 8000;
  const t0 = Date.now();
  let reported = false;
  const report = (msg) => {
    if (reported || !compName()) return;
    reported = true;
    omaNotify(`This app hit an error while loading: ${String(msg).slice(0, 160)} — if its latest change broke it, ask the AI to roll back (list_app_checkpoints → restore_app).`);
  };
  for (const m of (typeof window !== "undefined" && window.__OMA_EARLY_ERRORS__) || []) report(m);
  window.addEventListener("error", (e) => { if (Date.now() - t0 < REPORT_WINDOW_MS) report((e && e.message) || "script error"); });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e && e.reason;
    if (r && r.omaToolCallError) return;   // environment/tool failure, NOT broken app code
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
  ensureSystemBadge();         // same corner affordance as in a chat host
  goLive();
  // A viewer's height is the window's or the panel's, never the app's, so what does not fit must
  // stay reachable — even for apps declaring `html,body{overflow:hidden}` (right for a host that
  // sizes to the app, wrong here). `auto` on the ROOT only: free when the app fits, and a body
  // scroll container that can never scroll would kill `position:sticky` bars (as runner.mjs
  // unpinDocumentHeight notes). Inline + !important on <html>, which no app rewrites.
  try { document.documentElement.style.setProperty("overflow-y", "auto", "important"); } catch (e) { /* no root, no app */ }
  // Viewer SHELL (standalone pages only — host chats render the bare widget): a slim fixed top
  // bar so a browser-opened app has navigation and identity instead of floating raw in the tab.
  // Attached to <html> like omaNotify (apps rewrite body.innerHTML), body pushed down via
  // an injected style so no app content hides underneath.
  // SA.chrome === false → skip bar AND card: an embedding shell (hosted /app) owns the chrome,
  // and the widget renders bare exactly as it does inside a chat host iframe.
  if (SA.chrome !== false) try {
    const bar = document.createElement("div");
    bar.id = "__oma_viewer_bar";
    const st = document.createElement("style");
    // The CARD: a quiet page background with the app centered on one elevated card, so every
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
  // ---- app→app links as an INTENT, for a shell that owns where apps open ------------------
  // SA.navIntent (the /view door: `?nav=intent`) — opt-in, default off. Inside a panel host,
  // following `<a href="{oma.viewBase}{name}">` would swap this document out from under everything
  // the host built around the app. Instead: preventDefault and post `openmcp:open-app` (the
  // message the hosted shell already listens for), so the embedder opens it.
  // Left alone: a top-level tab (parent === window — nobody to tell, the link must work); links
  // not to an app under our own viewBase; modified clicks (new tab, download, middle button).
  if (SA.navIntent) try {
    const linkRoot = new URL(linkBase(), location.href).href;
    if (parent !== window) document.addEventListener("click", (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target && e.target.closest && e.target.closest("a[href]");
      if (!a) return;
      const target = a.getAttribute("target");
      if (target && target !== "_self") return;
      let href;
      try { href = new URL(a.getAttribute("href"), location.href).href; } catch { return; }
      if (href.indexOf(linkRoot) !== 0) return;
      const name = href.slice(linkRoot.length).replace(/[?#].*$/, "");
      // The store's own name shape (store.mjs APP_NAME_RE): a deeper path under the view base is
      // not an app link, and an embedder must never be handed a name it would have to validate.
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) return;
      e.preventDefault();
      parent.postMessage({ type: "openmcp:open-app", name: name }, "*");
    }, true);
  } catch { /* an embedder that cannot be told keeps the plain link */ }
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
          // The OTHER axis on the same frame: which app was opened last (null = none yet).
          // `in`, not truthiness — null is an answer, and an engine that predates the key says
          // nothing at all rather than "no app". Every `@live` brick on the page is downstream.
          if ("live" in d) pushLivePointer(d.live);
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
    // Unconditional on purpose: the per-app opener `open_<name>` carries ONLY a collection (its app
    // is in the TOOL name) and must bind, so do not guard on the envelope naming an app. Should a
    // foreign envelope carrying a collection ever appear, discriminate on the opening tool
    // (hostContext.toolInfo.tool.name) instead.
    if (typeof a.collection === "string" && a.collection) state.collection = a.collection;
    rememberIdentity();          // this is THE channel a re-render replays — write it down
    startWalk();
  };
  hostApp.ontoolresult = (result) => {
    const sc = result && result.structuredContent;
    // IDENTITY IS NOT DATA — take the labels BEFORE the freshness gate gets a vote. open_app
    // answers with zero rows and the REAL total, which canAdopt rightly refuses as rows; but a
    // widget's app/host/collection never change for its life and must not depend on data freshness.
    // First-wins: a later result never rebinds a widget that already knows what it is.
    if (sc && typeof sc.collection === "string" && !state.collection) state.collection = sc.collection;
    if (sc && typeof sc.app === "string" && !state.app) state.app = sc.app;
    if (sc && typeof sc.host === "string" && !state.host) state.host = sc.host;
    rememberIdentity();          // may have just learned the name from this very result
    if (sc && Array.isArray(sc.items)) { if (!adopt(sc)) startWalk(); }
    else startWalk();
  };
  // The engine relays the AI's screen_read / screen_act (tools/screen.mjs): this widget long-polls
  // screen_poll, runs the job with screenRead/screenAct, and hands the result back on its next
  // poll. Stops quietly when the server has no such tool (an older engine) or the host refuses.
  // "The app on screen" is decided server-side from each widget's report (visible, rendered at,
  // last touched) — sent on every poll and PINGED on change, since a waiting poll's state can be ~20 s old.
  const screenRelay = async () => {
    const session = "s" + Math.random().toString(36).slice(2, 10);
    const born = Date.now();
    let touched = 0, relayOn = true;
    const seen = () => ({ session, app: compName() || "", born, touched, display,
      visible: document.visibilityState === "visible" && innerWidth > 0 && innerHeight > 0 });
    const ping = () => { if (relayOn) hostApp.callServerTool({ name: "screen_poll", arguments: { ...seen(), ping: true } }, { timeout: 10_000 }).catch(() => {}); };
    document.addEventListener("visibilitychange", ping);
    addEventListener("resize", () => { if (!innerWidth || !innerHeight) ping(); });
    displayCbs.push(ping);
    let lastTouchPing = 0;
    addEventListener("pointerdown", (e) => {
      if (!e.isTrusted) return;
      touched = Date.now();
      if (touched - lastTouchPing > 5000) { lastTouchPing = touched; ping(); }
    }, true);
    let done, fails = 0;
    while (fails < 3) {
      let r;
      try { r = await hostApp.callServerTool({ name: "screen_poll", arguments: { ...seen(), ...(done ? { done } : {}) } }, { timeout: 40_000 }); }
      catch (e) { fails++; await new Promise((ok) => setTimeout(ok, 2000)); continue; }
      done = undefined;
      if (!r || r.isError) { fails++; continue; }
      fails = 0;
      const job = r.structuredContent && r.structuredContent.job;
      if (!job) continue;
      try {
        const out = job.tool ? await appTools.call(job.tool, job.input)
          : job.action === "read" ? { content: [{ type: "text", text: screenRead() }] } : await screenAct({ ...job, action: job.action });
        done = { id: job.id, text: appToolText(out), ...(out.isError ? { isError: true } : {}) };
      } catch (e) { done = { id: job.id, text: "The app failed: " + ((e && e.message) || e), isError: true }; }
    }
    relayOn = false;
  };
  hostApp.onhostcontextchanged = (ctx) => { applyTheme(ctx); applyDisplay(ctx); applySafeArea(ctx); };
  hostApp.onerror = (e) => console.error("[oma] bridge error", e);

  hostApp.connect().then(() => {
    applyTheme(hostApp.getHostContext());
    applyDisplay(hostApp.getHostContext());
    applySafeArea(hostApp.getHostContext());
    prefsPromise = syncPrefs();  // bridge must be connected before callServerTool works
    connected = true;
    ensureSystemBadge();         // the system corner (shown when forced or asked for), on every widget
    goLive();                    // binding may have arrived before connect — walk now (or ready, for a page)
    scheduleMountRecovery();     // and if no binding ever comes (refresh-replay), ask again
    screenRelay();               // EXPERIMENT: the AI's `screen` actions reach this widget
  }).catch((e) => console.error("[oma] connect failed", e));
}
