// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/bridge-resilience.mjs — a silently DROPPED bridge request must never wedge the runtime.
//
// Claude Desktop 1.24012.9 (and Claude Code — same MCP Apps bridge stack) drops widget→host
// calls sent in an early post-mount window: the request never settles — no reply, no SDK
// timeout ("oncalltool handler replaced" in the renderer log; requests on the replaced handler
// are lost). Live-test 2026-07-28 found v0.3's loader first paint 100% hung on that one call,
// and the runtime shares the failure mode wholesale: an unsettled await kills the poll chain,
// jams syncPrefs' busy latch, and holds walk()'s single-flight slot forever.
//
// These tests execute the ACTUAL shipped source — extracted from the runtime / the served
// loader document, with only the time constants scaled down — against a scripted bridge
// (resolve, reject, sink) and pin the envelope semantics.
//
// Run: node test/bridge-resilience.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wrapLoader, wrapApp } from "../src/shell.mjs";
import { BRIDGE, composePreviewDoc, SELF_HEIGHT_UNPIN_SOURCE } from "../src/runner.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rt = readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf-8");

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));
const sink = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("1. the bridge deadline — SDK request timeout, policy pinned at the call site");
{
  // The hand-rolled withDeadline wrapper retired 2026-08-04 (elegance A17): the ext-apps SDK's
  // own request options carry a timeout, and the POLICY — 10s, reject-not-hang, on every bridge
  // call — is what these pins hold. The mechanism is the SDK's; a dropped request still rejects
  // through the same tagged-error path (section 3 below exercises that end to end).
  ok("the 10s policy constant survives", /const BRIDGE_DEADLINE_MS = 10_000;/.test(rt));
  ok("…and rides the SDK's request options at the ONE bridge call site",
    /hostApp\.callServerTool\(\{ name, arguments: args \}, \{ timeout: BRIDGE_DEADLINE_MS \}\)/.test(rt));
}

console.log("\n2. loader first paint — fresh-call retry against the early-mount drop window");
{
  const doc = wrapLoader();
  const lm = doc.match(/(function fetchAppHtml[\s\S]*?\n\})\s*\n\s*oma\.ready/);
  ok("fetchAppHtml exists in the served loader document", !!lm);
  const scaled = lm[1].replace("[3000, 5000, 7000, 9000]", "[30, 50, 70, 90]");
  ok("…and the windows literal was found to scale (test rig integrity)", scaled !== lm[1]);
  const build = (callTool) => {
    const calls = { n: 0, shows: [] };
    const oma = { callTool: (...a) => { calls.n++; return callTool(calls.n, ...a); } };
    const show = (msg) => calls.shows.push(msg);
    const fn = new Function("oma", "show", scaled + "; return fetchAppHtml;")(oma, show);
    return { fn, calls };
  };

  { // the observed failure: the first sends vanish, a later one lands
    const { fn, calls } = build((n) => (n <= 2 ? sink() : Promise.resolve({ structuredContent: { html: "<b>x</b>" } })));
    const r = await fn("bill-calendar");
    ok("two dropped attempts are abandoned, the third answer paints", r.structuredContent.html === "<b>x</b>");
    ok("…in exactly three sends", calls.n === 3, "sent " + calls.n);
    ok("…with visible retry progress, not a frozen placeholder", calls.shows.some((s) => /retry/.test(s)));
  }
  { // a real answer is terminal: retrying a denial can't help
    const { fn, calls } = build(() => Promise.reject(new Error("denied")));
    let err = null; try { await fn("x"); } catch (e) { err = e; }
    ok("a rejection inside the window is terminal", err && err.message === "denied");
    ok("…after a single send", calls.n === 1, "sent " + calls.n);
  }
  { // total drop: honest failure text instead of eternal "Loading app…"
    const { fn, calls } = build(() => sink());
    let err = null; try { await fn("x"); } catch (e) { err = e; }
    ok("all-dropped ends in an honest error", err && /did not answer/.test(err.message), err && err.message);
    ok("…after every window was tried", calls.n === 4, "sent " + calls.n);
  }
  await sleep(120); // let abandoned timers from the scaled windows drain before the summary
}

console.log("\n2a2. the loader BINDS from the answer it already fetched (fix (c))");
{
  // The generic loader has no binding of its own — one document serves every app — so
  // state.collection could only ever arrive as a host push. `open_app`'s `collection` input
  // is optional and models routinely omit it, so the common refresh shape is "ontoolinput arrived,
  // ontoolresult did not": the loader knows WHICH app to load and still cannot write, because every
  // data call goes out with collection:null and the runtime refuses it ("No collection bound yet").
  //
  // The answer was already in hand: the loader fetches get_app_html before it mounts anything,
  // and the server knows what that app opens on. It sends the binding; the loader applies it. The
  // loader must NOT re-derive it from the name (contracts.mjs: a second copy of "what does this app
  // open on" is a second answer waiting to disagree).
  const doc = wrapLoader();
  const rm = doc.match(/oma\.ready\(async \(state\) => \{([\s\S]*)\n\}\);/);
  ok("the loader's ready callback exists in the served document", !!rm);
  // The name lookup is the REAL one from the served document, not a stub: it is the piece that
  // decides whether a late-arriving identity is caught or dropped.
  const cnm = doc.match(/(function appName\(state\) \{[\s\S]*?\n\})/);
  ok("appName exists in the served document", !!cnm);
  const buildAppName = (oma, win, show) =>
    new Function("oma", "window", "show", cnm[1] + "\nreturn appName;")(oma, win, show);

  const run = async ({ toolInput, result, state }) => {
    const bound = [];
    const mounted = [];
    const shows = [];
    const embeds = [];
    const oma = {
      toolInput,
      callTool: async () => result,
      embed: async (n, o) => { embeds.push(o); },
    };
    // The binding handoff moved off the author API onto the internal hook (elegance A10).
    const win = { __OMA_BIND__: (c) => bound.push(c) };
    const body = rm[1]
      .replace(/const r = await fetchAppHtml\(name\);/, "const r = await oma.callTool();");
    const document = { body: { innerHTML: "x" } };   // the sandboxed branch clears the body first
    const show = (m) => shows.push(m);
    const fn = new Function("oma", "state", "show", "mount", "window", "document", "appName",
      `return (async () => {${body}})();`);
    await fn(oma, state, show, (h) => mounted.push(h), win, document, buildAppName(oma, win, show));
    return { bound, mounted, shows, embeds, win, document };
  };

  const HTML = "<b>the app</b>";
  {
    // The shape a refresh actually produces: a name, no collection.
    const r = await run({
      toolInput: { app: "shopping-list" },
      state: { collection: null, app: null },
      result: { structuredContent: { html: HTML, tier: "local", version: 3, collection: "shopping-list" } },
    });
    ok("🔴 the loader binds the runtime from the server's answer",
      r.bound.length === 1 && r.bound[0] === "shopping-list", JSON.stringify(r.bound));
    ok("…and still mounts the app", r.mounted.length === 1 && r.mounted[0] === HTML);
    ok("…and says nothing alarming on the way", r.shows.length === 0, JSON.stringify(r.shows));
  }
  {
    // An app whose rows do NOT live under its own name: the loader must use what it was SENT.
    // Re-deriving from the name here is the failure this test exists to make impossible.
    const r = await run({
      toolInput: { app: "builder-progress" },
      state: { collection: null, app: null },
      result: { structuredContent: { html: HTML, tier: "local", version: 1, collection: "build-progress" } },
    });
    ok("…using the collection it was SENT, never the app's name",
      r.bound[0] === "build-progress", JSON.stringify(r.bound));
  }
  {
    // An older engine that does not send one must not make the loader invent a binding.
    const r = await run({
      toolInput: { app: "legacy" },
      state: { collection: null, app: null },
      result: { structuredContent: { html: HTML, tier: "local", version: 1 } },
    });
    ok("an answer without a collection binds nothing rather than guessing", r.bound.length === 0);
    ok("…and the app still mounts (an old engine keeps working)", r.mounted.length === 1);
  }
  {
    // The sandboxed branch takes the same answer instead of falling back to the name.
    const r = await run({
      toolInput: { app: "third-party" },
      state: { collection: null, app: null },
      result: { structuredContent: { html: HTML, tier: "unreviewed", caps: {}, collection: "tp-rows" } },
    });
    ok("the sandboxed branch is bound from the same answer too",
      r.embeds.length === 1 && r.embeds[0].collection === "tp-rows", JSON.stringify(r.embeds));
  }
}

console.log("\n2b. the SHIPPED bundle carries the envelope (dist is what browsers run)");
{
  // Found the hard way: every widget loads dist/shell.js, not src/ — a fix that passes the
  // source-level tests above can still be absent from what the host serves. Strings survive
  // minification; the function names may not.
  const dist = readFileSync(join(ROOT, "dist", "shell.js"), "utf-8");
  ok("dist/shell.js carries the 10s deadline policy on the bridge call", /callServerTool\(\{name:\w+,arguments:\w+\},\{timeout:/.test(dist.replace(/\s+/g, "")) || dist.includes("timeout:O$") || /timeout:[A-Za-z_$]+\}\)/.test(dist));
  ok("dist/shell.js contains the inert fixture answering", dist.includes('"fx-"') || dist.includes("'fx-'") || dist.includes("fx-"));
}

console.log("\n2c. a failure surface that survives the runtime being broken");
// The bug this pins: on a page refresh the widget sat on "Loading app…" forever — no retry
// counter, no error, and not one get_app_html call reaching the server. Everything the loader can
// SAY lives inside oma.ready(...), so when the bridge never delivered (or window.oma never existed
// because the module graph died), nothing spoke. Two causes, one symptom; both are asserted here
// because the readings could not tell them apart and the fix has to cover both.
{
  const doc = wrapLoader();
  ok("the watchdog is a CLASSIC script — a module would be deferred and die with the module graph",
    /<script data-oma="watchdog">/.test(doc) && !/type="module"[^>]*data-oma="watchdog"/.test(doc));
  ok("…and it is armed BEFORE the runtime, so it survives the runtime throwing on evaluation",
    doc.indexOf('data-oma="watchdog"') < doc.indexOf('data-oma="runtime"'));
  ok("it never touches window.oma (the thing that may be broken)",
    !/window\.oma\s*\./.test(doc.slice(doc.indexOf('data-oma="watchdog"'), doc.indexOf('data-oma="runtime"'))));
  ok("the loader stands the watchdog down the moment it actually starts",
    /__OMA_LOADER_STARTED__\s*=\s*true/.test(doc));
  ok("the message is human, and tells the user what to do", /Ask your assistant to open this app again/.test(doc));
  // The deadline pair has to stay ordered: release first (8s), speak only if even that did not
  // happen (12s). Equal or inverted values would make the watchdog fire over a healthy slow host.
  const runtimeSrc = readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf-8");
  const readyMs = Number((runtimeSrc.match(/\}, (\d+)\);\s*\n\s*\},\s*\n\s*\/\*\* cb\(state\) after every data change/) || [])[1]);
  const watchdogMs = Number((doc.match(/\}, (\d+)\);/) || [])[1]);
  ok(`ready releases (${readyMs}ms) strictly before the watchdog speaks (${watchdogMs}ms)`,
    Number.isFinite(readyMs) && Number.isFinite(watchdogMs) && readyMs < watchdogMs, `${readyMs} vs ${watchdogMs}`);
  ok("oma.ready no longer waits forever — it releases its callbacks on a deadline",
    /readyDeadline/.test(runtimeSrc) && /ready deadline: the host never delivered/.test(runtimeSrc));
}

console.log("\n2f. the height unpin reaches the documents a HOST measures, from ONE source");
// 🔴 Measured on Leo's claude.ai (2026-08-13): a pinned app in a chat is measured at the frame
// height it already has, so it can never be seen to grow — and the fix first shipped only where
// the height BROADCAST lives (the runner's two child documents), while a chat host's top-level
// widget document is composed here, in shell.mjs. wrapLoader is what claude.ai renders for the
// universal opener; wrapApp is the same story for a per-app ui:// resource. Neither broadcasts
// anything. The pin is byte identity, not "an unpin is present": four documents carrying four
// hand-kept copies is exactly the drift that produced the broadcast bug this machine ended.
//
// This source also carried a CEILING for one day (max-height at the screen bound, a scroll
// container, a drawn scrollbar). Leo's call 2026-08-14: infinite height, the host's official limit
// decides — it cost the app's own scrolling on phones. The assertions below hold the removal.
{
  const docs = [["the loader document", wrapLoader()], ["a wrapped app document", wrapApp("<p>x</p>", { app: "a" })],
    ["the live bridge", BRIDGE], ["the preview document", composePreviewDoc("<p>x</p>", { name: "a" })]];
  for (const [what, doc] of docs) {
    ok(`${what} carries the unpin source VERBATIM — same bytes as runner.mjs exports`,
      doc.includes(SELF_HEIGHT_UNPIN_SOURCE));
    ok(`…and exactly one copy of it (a second would be a copy-paste, not an injection)`,
      doc.split("function unpinDocumentHeight").length - 1 === 1,
      String(doc.split("function unpinDocumentHeight").length - 1));
  }
  // The unpin only exists for an embedder that sizes our frame from our document. A top-level page
  // (/view, which wrapApp/wrapLoader also serve) has none, and its viewer stage styles body itself.
  ok("it applies only when something is EMBEDDING us", SELF_HEIGHT_UNPIN_SOURCE.includes("if(window.parent===window)return;"));
  // …and an embedder is not automatically a MEASURER. A shell (browser viewer, hosted SaaS surface)
  // hands us a viewport-fixed frame and expects the app to lay itself out inside it; it never reads
  // our scrollHeight, so rewriting html/body's height there answers a question nobody asked.
  ok("…and NOT when the embedder is a shell that owns the frame height (standalone marker)",
    SELF_HEIGHT_UNPIN_SOURCE.includes("if(window.__OMA_STANDALONE__)return;"));
  // The guard reads a marker that must be ASSIGNED, and "mentions __OMA_STANDALONE__" is not that
  // test: the runtime source READS the global, so every document carrying the runtime mentions it.
  // Only shell.mjs's `data-oma="standalone"` script assigns it — that is the byte the guard turns on.
  {
    const assigns = (doc) => /window\.__OMA_STANDALONE__\s*=/.test(doc);
    for (const [what, doc] of [["a chat-host widget", wrapApp("<p>x</p>", { app: "a" })],
      ["the chat-host loader", wrapLoader()], ["the live bridge", BRIDGE],
      ["the inert preview", composePreviewDoc("<p>x</p>", { name: "a" })]]) {
      ok(`${what} never assigns the marker, so it stays unpinned`,
        !assigns(doc) && doc.includes(SELF_HEIGHT_UNPIN_SOURCE));
    }
    ok("…and shell mode is the ONLY thing that assigns it",
      assigns(wrapApp("<p>x</p>", { app: "a", standalone: { endpoint: "/rpc", app: "a" } })) &&
        assigns(wrapLoader({ standalone: { endpoint: "/rpc", app: "a" } })));
  }
  for (const [what, doc] of [["a wrapped app", wrapApp("<p>x</p>", { app: "a", standalone: { endpoint: "/rpc", app: "a" } })],
    ["the loader", wrapLoader({ standalone: { endpoint: "/rpc", app: "a" } })]]) {
    ok(`${what} in shell mode defines the marker BEFORE the unpin reads it`,
      doc.indexOf('data-oma="standalone"') > -1 &&
        doc.indexOf('data-oma="standalone"') < doc.indexOf('data-oma="height-unpin"'));
  }
  ok("…and it fires as soon as a body exists, not at load",
    /if\(document\.body\)omaUnpinNow\(\);else document\.addEventListener\("DOMContentLoaded",omaUnpinNow\)/.test(SELF_HEIGHT_UNPIN_SOURCE));
  // THE CEILING IS GONE, and these are the bytes of it. It capped the body at a screen-derived
  // height (70% of it on a touch pointer), which made `body` a scroll container — so it also had to
  // hide the platform's scrollbar and draw an overlay thumb, self-heal that thumb through the
  // loader's innerHTML rewrites, and collapse it so it did not answer for the app's own extent.
  // Every one of those existed only to serve the cap. Leo, 2026-08-14: the app's own scrolling
  // stopped working on a phone, so infinite height and the host's official limit decides.
  // Scoped to the injected script in each document, never the whole page: the kit stylesheet every
  // shell document carries has its own legitimate `max-height` and `scrollbar-width` rules, and an
  // assertion that cannot tell those apart is an assertion about the kit.
  const injected = (doc) => {
    const at = doc.indexOf('data-oma="height-unpin">');
    return at < 0 ? "" : doc.slice(at, doc.indexOf("</script>", at));
  };
  for (const [what, src] of [["the unpin source", SELF_HEIGHT_UNPIN_SOURCE], ["the live bridge", BRIDGE],
    ["the loader's injected script", injected(wrapLoader())],
    ["a wrapped app's injected script", injected(wrapApp("<p>x</p>", { app: "a" }))]]) {
    ok(`${what} is there at all`, src.length > 200, String(src.length));
    ok(`${what} sets no ceiling on the document (no max-height)`, !/max-height/.test(src));
    ok(`${what} leaves the platform's scrollbar alone (no scrollbar-width, no ::-webkit-scrollbar)`,
      !/scrollbar-width/.test(src) && !/::-webkit-scrollbar/.test(src));
    ok(`${what} draws no scrollbar of its own (no self-cap-thumb)`, !/self-cap-thumb/.test(src));
    ok(`${what} does not read the pointer type — the bound it fed is gone`, !/pointer:coarse/.test(src));
  }
  // What the unpin DOES set: an auto height on both boxes, and overflow left VISIBLE. `auto` was
  // the cap's scroll container; a body with overflow-y:auto and no max-height is a scroller that
  // can never scroll, and position:sticky binds to the nearest non-visible-overflow ancestor —
  // the store's and settings' capsule bars would stick to a box that does not move.
  ok("it unpins both boxes (height:auto + min-height:0) and leaves the overflow VISIBLE",
    /"height", "auto", "important"/.test(SELF_HEIGHT_UNPIN_SOURCE)
    && /"min-height", "0", "important"/.test(SELF_HEIGHT_UNPIN_SOURCE)
    && /"overflow-y", "visible", "important"/.test(SELF_HEIGHT_UNPIN_SOURCE)
    && /unpin\(root\);\s*unpin\(body\);/.test(SELF_HEIGHT_UNPIN_SOURCE));
  {
    // This source travels by toString into a CSP'd child, so anything it closes over in THIS module
    // is a ReferenceError there — and nothing else in this suite ever executes it, which is exactly
    // how a module-scoped constant would ship green. Evaluate it once against nothing but stubs.
    const win = { addEventListener() {}, screen: { height: 844 } };
    win.parent = { notWin: true };
    const doc = { body: null, addEventListener() {}, querySelector: () => null };
    let threw = null;
    try { new Function("window", "document", "(function(){" + SELF_HEIGHT_UNPIN_SOURCE + "})()")(win, doc); }
    catch (e) { threw = e; }
    ok("the whole injected source evaluates with browser stubs alone — nothing closes over this module",
      threw === null, String(threw));
  }
  {
    // …and the BROADCAST source, run for real, because a missing name there is invisible: the whole
    // postMessage sits inside a catch, so `screenHeightCap` left behind in the unpin source would
    // turn every report into a swallowed ReferenceError and no regex in this file would notice.
    const preview = composePreviewDoc("<div>hi</div>", { name: "a" });
    const src = preview.slice(preview.lastIndexOf("<script>") + 8, preview.lastIndexOf("</script>"));
    const posted = [];
    const parent = { postMessage: (m) => posted.push(m) };
    const style = { setProperty() {} };
    const body = { style, scrollHeight: 5000, children: [], getBoundingClientRect: () => ({ top: 0 }) };
    const win = { parent, screen: { height: 900 }, innerHeight: 400, addEventListener() {} };
    const doc = { body, documentElement: { style }, readyState: "complete", addEventListener() {} };
    let threw = null;
    try { new Function("window", "document", "parent", src)(win, doc, parent); }
    catch (e) { threw = e; }
    ok("the broadcast source runs end to end on stubs and actually posts a height",
      threw === null && posted.length === 1 && posted[0].omaRunHeight === true,
      String(threw) + JSON.stringify(posted));
    ok("…a NUMBER, bounded by the screen reading (5000px of app, 900px screen ⇒ 900)",
      posted[0] && posted[0].h === 900, JSON.stringify(posted));
  }
  {
    // …AND THE SAME THING AFTER MINIFICATION, which is the file that actually ships.
    //
    // The check above reads the SOURCE module, where every injected function still has the name
    // this file wrote. dist/shell.js is built with minify:true, and the bodies are injected by
    // toString(): a body that calls a SIBLING calls it by whatever name the bundler left there.
    // 0.5.0 shipped exactly that hole — the helper was declared as the literal `screenHeightCap`
    // while the minified caller asked for `Eh` — so every sandboxed child threw a ReferenceError
    // inside omaSendHeight's own catch and NO embed ever reported a height (measured in Chrome:
    // every frame sat at its initial 140px forever). Nothing that reads src/ can see that, so this
    // one builds the artifact and runs the injected source the way the browser does.
    const { build } = await import("esbuild");
    const out = await build({
      entryPoints: [join(ROOT, "src", "runner.mjs")],
      bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, write: false,
    });
    const min = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
    const preview = min.composePreviewDoc("<div>hi</div>", { name: "a" });
    const src = preview.slice(preview.lastIndexOf("<script>") + 8, preview.lastIndexOf("</script>"));
    const posted = [];
    const parent = { postMessage: (m) => posted.push(m) };
    const style = { setProperty() {} };
    const body = { style, scrollHeight: 5000, children: [], getBoundingClientRect: () => ({ top: 0 }) };
    const win = { parent, screen: { height: 900 }, innerHeight: 400, addEventListener() {} };
    const doc = { body, documentElement: { style }, readyState: "complete", addEventListener() {} };
    let threw = null;
    try { new Function("window", "document", "parent", src)(win, doc, parent); }
    catch (e) { threw = e; }
    // The ReferenceError this pins never escapes — it is caught and dropped — so the assertion has
    // to be about the POST, never about a throw.
    ok("the MINIFIED broadcast still posts: every name its bodies call is one the child has",
      threw === null && posted.length === 1 && posted[0].h === 900,
      String(threw) + JSON.stringify(posted));
  }
  for (const [what, doc] of docs.slice(0, 2)) {
    ok(`${what} injects it as a CLASSIC script — a module is deferred, and "before anyone measures" is the point`,
      /<script data-oma="height-unpin">/.test(doc) && !/type="module"[^>]*data-oma="height-unpin"/.test(doc));
    ok(`…armed before the runtime module, which is the thing that may be slow or broken`,
      doc.indexOf('data-oma="height-unpin"') < doc.indexOf('data-oma="runtime"'));
  }
}

console.log("\n3. the recovery paths the deadline unlocks (source pins)");
{
  ok("pollTick guards its awaits — one rejected probe cannot kill the chain",
    /async function pollTick\(\)[\s\S]*?catch \{/.test(rt));
  ok("syncPrefs clears its busy latch in finally — a rejected read cannot jam prefs",
    /prefSyncBusy = false;\s*\n\s*if \(prefSyncQueued\)/.test(rt) && /finally \{/.test(rt.slice(rt.indexOf("async function syncPrefs"), rt.indexOf("function schedulePrefSync"))));
  ok("walk releases its single-flight slot in finally",
    /finally \{\s*\n\s*walking = null;/.test(rt));
  ok("addItem refuses an unbound collection loudly instead of sending collection:null",
    /addItem\(\{[\s\S]{0,600}?No collection bound yet/.test(rt));
  // embed() used to rebuild childSnap from an explicit key list, which silently dropped the
  // `apps` roster the embedder had just supplied — a fix that shipped without its effect.
  // The DECISION is covered properly in test/runtime-core.mjs §11; this pins the WIRING, which is
  // the part that was missing. It is a source pin and says so: embed needs a DOM to run.
  ok("embed hands its caller's snapshot to childPreviewSnapshot rather than re-deriving it",
    /const share = opts\.snapshot[\s\S]{0,200}childPreviewSnapshot\(/.test(rt));
  ok("…and childSnap carries the sliced items AND the roster (the key that used to be dropped)",
    /let childSnap = share[\s\S]{0,200}items: share\.items, apps: share\.apps/.test(rt));
}

console.log("\n4. the Installed grid's preview snapshot — data that arrives LATE must still arrive");
{
  // Same idea one layer up, and the same failure shape: a thumbnail mounts from an
  // IntersectionObserver as its card nears the viewport, but the pane's collection list is one
  // more host round trip AWAY at that moment (loadApps() renders the grid, and only then
  // does boot ask list_data_collections). So the observer normally fires FIRST. Answering that with an
  // empty snapshot is not a rare race — it is the ordinary first paint, and it is permanent: the
  // thumb is recorded in `thumbs`, its skeleton is removed, and nothing mounts it again.
  //
  // Real source, extracted from the shipped app.
  const settingsSrc = readFileSync(join(ROOT, "components", "settings", "ui.html"), "utf-8");
  const m = settingsSrc.match(/(const PREVIEW_ROWS_PER_COLLECTION[\s\S]*?)\n\s*\/\/ Mount = oma\.embed/);
  ok("previewSnapshot + its constants extracted from components/settings/ui.html", !!m);

  // `previewInputsReady` only exists once the gate does; probe for it rather than assume it, so
  // this section runs (and fails honestly) against a build that has not been fixed yet.
  const build = new Function("oma", "console", `
    let collsCache = [];
    ${m[1]}
    return {
      previewSnapshot,
      setColls: (c) => { collsCache = c; },
      release: () => { if (typeof previewInputsReady === "function") previewInputsReady(); },
    };`);

  const mkOma = (log) => ({
    callTool: async (name, args) => {
      log.push(`${name}:${args.collection}`);
      return { structuredContent: { items: [{ group: "", fields: { t: args.collection + "-row" } }] } };
    },
  });

  {
    const log = [];
    const api = build(mkOma(log), { warn() {} });
    // A thumb mounts BEFORE the collection list has landed — the ordinary first paint.
    const early = api.previewSnapshot();
    let settledEarly = false;
    early.then(() => { settledEarly = true; });
    await sleep(5);
    ok("a snapshot asked for before the inputs exist does not answer yet", settledEarly === false);

    api.setColls([{ collection: "build-progress" }, { collection: "notes" }]);
    api.release();
    const rows = await early;
    ok("…and once the inputs land it answers with the real rows, not an empty snapshot",
      rows.length === 2 && rows.some((r) => r.collection === "build-progress"), JSON.stringify(rows));
    ok("…having fetched each collection exactly once", log.length === 2, log.join(","));
  }

  {
    // Single-flight survives the gate: five thumbs entering the viewport together must still
    // produce ONE pass over the store (the bug that made 5 mounts fetch 11 collections each).
    const log = [];
    const api = build(mkOma(log), { warn() {} });
    const many = [api.previewSnapshot(), api.previewSnapshot(), api.previewSnapshot(),
      api.previewSnapshot(), api.previewSnapshot()];
    api.setColls([{ collection: "a" }, { collection: "b" }]);
    api.release();
    const all = await Promise.all(many);
    ok("five simultaneous mounts share ONE fetch pass (single-flight survives the gate)",
      log.length === 2, log.join(","));
    // IDENTITY, not equal length. The old `r === all[0] || r.length === all[0].length` could not
    // fail: if single-flight broke, five mounts each get their OWN array of the same rows, and the
    // second clause waves it through. Same-reference IS the property — one in-flight fetch means
    // one array — so that is what gets asserted.
    ok("…and every one of them gets the SAME array, not an equal-looking copy",
      all.every((r) => r === all[0]), `${new Set(all).size} distinct result(s)`);
  }

  {
    // The gate must not become a new way to hang: settings' boot releases it unconditionally,
    // so a store with nothing in it answers empty rather than never.
    const log = [];
    const api = build(mkOma(log), { warn() {} });
    const p = api.previewSnapshot();
    api.release();                       // released with collsCache still empty — a fresh install
    ok("a released-but-empty store answers [] instead of hanging", (await p).length === 0);
  }

  {
    // ⚠️ DO NOT grep components/settings/ui.html — READ it. That file carries three deliberate NUL
    // bytes (lines 1038 / 1051 / 1228: `group + "\0" + key`, the composite key for draft/focus
    // restore). grep in its default mode treats the whole file as binary and answers NOTHING with
    // EXIT=1 — a hit and a miss look identical. That silence has twice manufactured the same false
    // conclusion, "settings never passes declaration": once into the commit message of 09281d4
    // ("grep `declaration:` 零命中"), once nearly into a redundant fix for a line that has been
    // there since c5d4393. Hence this pin, which is also the antidote: this test file has no NUL
    // bytes, so a repo-wide grep for the string lands HERE, on the warning, instead of nowhere.
    //
    // What it holds: mountThumb hands each thumbnail its app's own declaration. Without it the
    // child snapshot may only keep rows whose collection equals the app NAME, so every installed
    // multi-collection app (companion → companion-profile/-memories/-knows, elder-days →
    // elder-meds/-checks/-vitals) previews permanently empty on the Installed wall.
    const region = settingsSrc.slice(settingsSrc.indexOf("async function mountThumb"),
      settingsSrc.indexOf("// ---- grid rendering"));
    ok("mountThumb was extracted from components/settings/ui.html",
      region.length > 200 && /oma\.embed\(name, \{/.test(region));
    ok("🔴 mountThumb passes the app's declaration to oma.embed (multi-collection thumbs need it)",
      /declaration: declsRaw\.get\(name\),/.test(region),
      "READ the file, do not grep it — 3 NUL bytes make grep answer empty with EXIT=1");
    ok("…and declsRaw is actually filled, so the key is not handed over forever undefined",
      /declsRaw\.set\(name, d \|\| null\)/.test(settingsSrc));
  }
}

console.log("\n2d. the deadline re-arms — it is a guarantee, not a one-shot");
{
  // The deadline exists so a caller can never wait forever. Its first version armed ONE timer
  // (`if (readyDeadline == null)`) and never cleared the handle, so once it had fired with the host
  // still silent, every LATER ready(cb) queued behind a spent timer and waited forever — the exact
  // hang it was written to end, reintroduced for anyone registering after the first 8 seconds.
  // Real source, with only the constant scaled down.
  const m = rt.match(/\n  ready\(cb\) \{\n([\s\S]*?)\n  \},\n/);
  ok("ready(cb) extracted from the runtime", !!m);
  const build = new Function("MS", `
    let ready = false, readyDeadline = null; const readyCbs = []; const state = { probe: true };
    const console = { warn() {}, error() {} };
    function readyFn(cb) {\n${m[1].replace(/8000/, "MS")}\n}
    return { readyFn, deliver: () => { ready = true; for (const fn of readyCbs.splice(0)) fn(state); } };`);

  {
    const api = build(40);
    const fired = [];
    api.readyFn((s) => fired.push(["first", s]));
    await sleep(70);
    ok("the first callback is released when the host stays silent", fired.length === 1 && fired[0][0] === "first");

    // An app that calls oma.ready() late — from a click, a lazy import, a second pane.
    api.readyFn((s) => fired.push(["late", s]));
    await sleep(70);
    ok("🔴 a callback registered AFTER the deadline fired still gets released, not stranded",
      fired.length === 2 && fired[1][0] === "late", JSON.stringify(fired.map((f) => f[0])));
  }

  {
    // …and the re-arming must not double-fire anyone, nor pre-empt a host that does answer.
    const api = build(40);
    const fired = [];
    api.readyFn(() => fired.push("a"));
    api.deliver();
    await sleep(70);
    ok("a host that answers wins, and the pending timer stays silent", fired.length === 1);
    api.readyFn(() => fired.push("b"));
    ok("…and once ready, a later registration fires immediately", fired.length === 2);
  }
}

console.log("\n2e. sendMessage says NOTHING on the success path (deliberate — see KNOWN-ISSUES)");
{
  // 0.3.2 briefly notified after every accepted call. Live testing falsified it in both directions
  // at once: on desktop the message had already been delivered and the banner fired anyway, and on
  // mobile the banner fired while an EMPTY message arrived. The protocol reports no completion, so
  // a runtime-level guess cannot be right on every host; the caller decides. Pinned because a
  // removal is invisible — nothing here would have failed if the notice quietly came back.
  const body = rt.slice(rt.indexOf("  sendMessage(text) {"), rt.indexOf("  openLink(url) {"));
  ok("sendMessage's body was located", body.length > 200 && /hostApp\.sendMessage\(/.test(body));
  const afterSend = body.slice(body.indexOf("return hostApp.sendMessage("));
  ok("no notice fires once the host accepts the request",
    !/omaNotify\(/.test(afterSend), afterSend.slice(0, 300));
  ok("…while the DEGRADED paths still speak (silence is only for the success path)",
    (body.match(/omaNotify\(/g) || []).length >= 2);
  ok("the reason is recorded where a user will look for it",
    /look like it did nothing/.test(readFileSync(join(ROOT, "KNOWN-ISSUES.md"), "utf-8")));
}

console.log("\n5. identity is not data — the freshness gate must not decide what the widget KNOWS");
{
  // open_app answers with ZERO rows and the collection's REAL total (by design: the widget
  // fetches its own data). canAdopt refuses exactly that shape — `items.length !== total` — which is
  // correct for ROWS and catastrophic for LABELS, because state.app / state.host / the
  // collection are only ever assigned INSIDE adopt(), after the gate returns.
  //
  // So on the loader path, as soon as the collection has a single row, the widget can never learn
  // which app it is or which host it is on. That is one half of the "No app specified." a
  // refresh produces — and it is OUR half: even a host that redelivers perfectly is thrown away.
  //
  // Real source: the ontoolresult handler and adopt(), extracted and run against a scripted result.
  const handler = rt.match(/hostApp\.ontoolresult = \(result\) => \{([\s\S]*?)\n  \};/);
  ok("ontoolresult handler extracted from the runtime", !!handler);

  const { canAdopt } = await import("../src/runtime-core.mjs");
  const run = (result, seed = {}) => {
    const state = { collection: null, items: [], version: 0, total: 0, truncated: false, app: null, host: null, ...seed };
    let adoptCalls = 0, adoptReturned = null;
    // adopt(), reduced to the two things this test is about: the gate, and the assignment that
    // only happens past it. Anything the gate lets through still lands the labels as before.
    const adopt = (snap) => {
      adoptCalls++;
      if (!canAdopt(state, snap)) return (adoptReturned = false);
      Object.assign(state, {
        collection: snap.collection ?? state.collection, items: snap.items,
        version: snap.version ?? state.version, app: snap.app ?? state.app,
        host: snap.host ?? state.host,
      });
      return (adoptReturned = true);
    };
    // Writing the identity down is what survives a re-render bound to another call; count it here
    // so learning the name and recording it cannot drift apart.
    let announced = 0;
    new Function("result", "state", "adopt", "startWalk", "rememberIdentity", handler[1])(
      result, state, adopt, () => {}, () => { announced++; });
    return { state, adoptCalls, adoptReturned, announced };
  };

  // Exactly what open_app sends when the app already has data.
  const openResult = { structuredContent: {
    app: "shopping-list", collection: "shopping-list", items: [], version: 412,
    total: 7, settings_version: 3, files_version: 1, host: "chatgpt",
  } };

  const r = run(openResult);
  ok("the freshness gate still REFUSES the zero-row/real-total snapshot — it is not relaxed",
    r.adoptReturned === false);
  ok("…and yet the widget learns which app it is", r.state.app === "shopping-list", String(r.state.app));
  ok("…and which host it is on", r.state.host === "chatgpt", String(r.state.host));
  ok("…and what it is bound to", r.state.collection === "shopping-list", String(r.state.collection));
  ok("no rows were adopted (labels moved, data did not)", r.state.items.length === 0);

  // Idempotence / first-wins, the same rule the collection already had: a later result must not
  // rebind a widget that already knows what it is.
  const r2 = run({ structuredContent: { app: "other-app", collection: "other", items: [], total: 3, host: "claude-ai" } },
    { app: "shopping-list", host: "chatgpt", collection: "shopping-list" });
  ok("a later result cannot rename a widget that already knows its identity",
    r2.state.app === "shopping-list" && r2.state.host === "chatgpt" && r2.state.collection === "shopping-list",
    JSON.stringify({ c: r2.state.app, h: r2.state.host, coll: r2.state.collection }));

  // An empty collection was always fine (0 === 0 passes the gate) — that is why this went unnoticed.
  const r3 = run({ structuredContent: { app: "fresh-app", collection: "fresh-app", items: [], version: 5, total: 0, host: "claude-ai" } });
  ok("the empty-collection case still adopts normally (this is why the hole stayed invisible)",
    r3.adoptReturned === true && r3.state.app === "fresh-app" && r3.state.host === "claude-ai");

  ok("a result carrying no identity leaves the fields alone rather than nulling them",
    run({ structuredContent: { collection: "x", items: [], total: 2 } }, { app: "keep", host: "keep-host" }).state.app === "keep");
}

console.log("\n6. the loader's identity-lost surface REPORTS instead of shrugging");
{
  // The universal loader is one document serving every app, so on a host re-render that replays no
  // tool input it cannot know which app it is. That much is structural. What is NOT structural is
  // saying "No app specified." and stopping: the channels it checked are exactly the evidence
  // needed to tell "the host sent nothing" apart from "the host sent something we never read".
  // These run the REAL served source against a paper DOM.
  const doc = wrapLoader();
  // boundToolName is included because lost() calls it: the panel names WHICH call the host bound
  // this render to, and that sentence is the diagnosis.
  const m = doc.match(/(function boundToolName\(\) \{[\s\S]*?)\nfunction mount\(/);
  ok("identityChannels + lost exist in the served loader document", !!m);

  const paperDom = (win) => {
    const node = () => {
      const n = { style: { cssText: "" }, children: [], _text: "", className: "", onclick: null,
        appendChild(c) { this.children.push(c); return c; },
        get textContent() { return this._text + this.children.map((c) => c.textContent).join(" "); },
        set textContent(v) { this._text = v; } };
      return n;
    };
    const body = node();
    return {
      document: { body, referrer: "https://chatgpt.example/c/abc", createElement: () => node() },
      location: { href: "https://web-sandbox.example/widget" },
      console: { warn() {} },
      localStorage: { setItem() {}, removeItem() {} },
      window: win,
      body,
    };
  };
  const runLost = (omaStub, hostContext, extraGlobals = {}) => {
    const win = { __OMA_HOST_CONTEXT__: hostContext, name: "", ...extraGlobals };
    const env = paperDom(win);
    // body.innerHTML = "" is the first thing lost() does; the paper node just absorbs it.
    Object.defineProperty(env.body, "innerHTML", { set() {}, get() { return ""; }, configurable: true });
    new Function("oma", "window", "document", "location", "console", "localStorage",
      m[1] + "\nlost();")(omaStub, win, env.document, env.location, env.console, env.localStorage);
    return env.body.textContent;
  };

  // The forensic roster/raw dump retired 2026-08-04 (elegance A15): once identity recovery has
  // failed, no evidence changes the user's next move. What must survive: the plain sentence, the
  // recovery instruction, and the one diagnosis that names the call the host DID bind.
  const bare = runLost({ toolInput: null, state: { app: null, collection: null, items: [] } }, undefined);
  ok("it says, in words, that the widget lost track of which app it is",
    /lost track of which app it is/.test(bare), bare.slice(0, 120));
  ok("…and tells the user their data is fine and what to do next",
    /open the app again/.test(bare) && /data is untouched/.test(bare));

  // 🔴 The one diagnosis kept: a host that bound this render to a DIFFERENT call is named.
  const withInfo = runLost(
    { toolInput: null, state: { app: null, collection: null, items: [] } },
    { theme: "dark", toolInfo: { id: 42, tool: { name: "get_app" } } });
  ok("a render bound to a different call names that call in the sentence",
    /get_app/.test(withInfo) && /different call/.test(withInfo), withInfo);

  // Nothing here may throw: this is the surface that runs when everything else already failed.
  let threw = null;
  try {
    runLost({ get toolInput() { throw new Error("bridge gone"); }, get state() { throw new Error("bridge gone"); } }, null);
  } catch (e) { threw = e; }
  ok("a runtime whose every accessor throws still produces a panel rather than a blank widget",
    threw === null, threw && threw.message);

  // The phrase survives in the comment that explains why it was replaced — what must not survive
  // is the loader RENDERING it and stopping there.
  ok("the dead-end is no longer a rendered outcome",
    !/show\(\s*["']No app specified/.test(doc) && /if \(!name\) return lost\(\);/.test(doc));
}

console.log("\n7. WHICH APP AM I — answered now, from what we know and what the host kept for us");
{
  // There used to be a fourth step here: wait 12s in case the answer was still in flight, plus a
  // subscription channel in the runtime to deliver it. Both are GONE, and the tests for them with
  // it. The premise was a "race" between the host's delivery and oma.ready's 8s deadline — but the
  // deadline only fires when NOTHING arrived, because identity arriving is itself what triggers the
  // walk that makes ready true. And measured: every re-render that failed was handed another
  // call's envelope verbatim — one that will never name us, however long it is held. The
  // subscription's own first line returned early without a name, so it could not even fire.
  const doc = wrapLoader();
  const cm = doc.match(/(function appName\(state\) \{[\s\S]*?\n\})/);
  ok("appName is in the served document", !!cm);
  const build = (oma, win) => new Function("oma", "window", cm[1] + "\nreturn appName;")(oma, win);

  ok("a live name in the tool input answers straight away",
    build({ toolInput: { app: "shopping-list" } }, {})({ app: null }) === "shopping-list");
  ok("N11's channel counts as knowing too — a result-only replay lands the name there",
    build({ toolInput: {} }, {})({ app: "rescued-app" }) === "rescued-app");
  ok("🔴 nothing live, but the host kept our note — this is what survives a mis-bound re-render",
    build({ toolInput: {} }, { __OMA_IDENTITY__: () => "remembered-app" })({ app: null }) === "remembered-app");
  ok("nothing anywhere answers null — immediately, not after a spinner",
    build({ toolInput: {} }, { __OMA_IDENTITY__: () => null })({ app: null }) === null);
  ok("a runtime without the identity hook degrades to null instead of throwing",
    build({ toolInput: {} }, {})({ app: null }) === null);
  ok("it is synchronous — no promise, so no window in which a wrong answer can arrive late",
    typeof build({ toolInput: { app: "x" } }, {})({}) === "string");

  ok("the runtime records identity from the tool-INPUT door", /toolInput = a;[\s\S]{0,2500}rememberIdentity\(\);/.test(rt));
  ok("…and from the tool-RESULT door, where N11's rescue lands",
    /state\.host = sc\.host;[\s\S]{0,300}rememberIdentity\(\);/.test(rt));
  ok("the subscription machinery is gone, not merely unused",
    !/identityCbs/.test(rt) && !/__OMA_ON_IDENTITY__/.test(rt));
  ok("…and so is the disproven race narrative it was justified by",
    !/coin flip/.test(rt) && !/coin flip/.test(doc));
}

console.log("\n8. 🔴 a re-render bound to the WRONG tool call — remember, because being told twice fails");
{
  // MEASURED, ChatGPT web, 2026-07-29, from the loader's own dump. When a turn has more than one
  // tool call, the first mount is bound correctly and a later re-render replays the FIRST call of
  // that turn — verbatim, arguments and tool definition:
  //   get_app{name:"dev-probe"} → open_app{...}   ⇒ widget got toolInput {name:"dev-probe"}
  //   list_data_collections{}              → open_app{...}   ⇒ widget got toolInput {}
  // So the envelope is not missing, it is someone else's, and no guard can tell those apart. What
  // CAN be done is refuse to need telling twice: write the identity down at first mount, into the
  // host's own per-instance state channel.
  const m = rt.match(/(const STATE_KEY = "__oma";[\s\S]*?window\.__OMA_IDENTITY__ = [\s\S]*?\n\} catch \(_\) \{[^\n]*\})/);
  ok("the remember/recall pair and the identity hook were located in the runtime", !!m);

  const build = ({ openai, toolInput = {}, state = {} }) => {
    const win = openai === undefined ? {} : { openai };
    const st = { collection: null, app: null, host: null, ...state };
    const cbs = [];
    const api = new Function("window", "toolInput", "state", "identityCbs", "console",
      m[1] + "\nreturn { rememberIdentity, recallIdentity, identity: window.__OMA_IDENTITY__ };")(
      win, toolInput, st, cbs, { error() {}, warn() {} });
    return { ...api, state: st, cbs, win };
  };
  const fakeOai = () => {
    let s = undefined;
    return { get widgetState() { return s; }, setWidgetState(v) { s = v; }, _writes: () => s };
  };

  {
    const oai = fakeOai();
    const a = build({ openai: oai, toolInput: { app: "shopping-list" }, state: { collection: "shopping-list", host: "chatgpt" } });
    a.rememberIdentity();
    ok("🔴 the moment we know, it is written into the host's own state channel",
      oai.widgetState && oai.widgetState.__oma && oai.widgetState.__oma.app === "shopping-list",
      JSON.stringify(oai.widgetState));
    ok("…with the binding and the host name, the two other things a mis-bound replay never delivers",
      oai.widgetState.__oma.collection === "shopping-list" && oai.widgetState.__oma.host === "chatgpt");
  }
  {
    // The app owns this object; we are a guest in one namespaced key.
    const oai = fakeOai();
    oai.setWidgetState({ scrollTop: 120, filter: "open" });
    const a = build({ openai: oai, toolInput: { app: "trip-board" } });
    a.rememberIdentity();
    ok("the app's own widget state is preserved, not overwritten",
      oai.widgetState.scrollTop === 120 && oai.widgetState.filter === "open" && oai.widgetState.__oma.app === "trip-board",
      JSON.stringify(oai.widgetState));
  }
  {
    let writes = 0;
    const oai = fakeOai();
    const wrapped = { get widgetState() { return oai.widgetState; }, setWidgetState(v) { writes++; oai.setWidgetState(v); } };
    const a = build({ openai: wrapped, toolInput: { app: "x" } });
    a.rememberIdentity(); a.rememberIdentity(); a.rememberIdentity();
    ok("writing is idempotent — a poll that re-announces does not re-write every tick", writes === 1, String(writes));
  }
  {
    // 🔴 THE ONE THAT MATTERS: a mis-bound re-render. Nothing live names us, and nothing ever will,
    // because the envelope in flight belongs to another call. Subscribing here waits forever.
    const oai = fakeOai();
    oai.setWidgetState({ __oma: { app: "dev-probe", collection: "_probe-dev", host: "chatgpt" } });
    const a = build({ openai: oai, toolInput: { name: "dev-probe" } });   // ← get_app's args, verbatim
    const got = a.identity();
    ok("🔴 a widget handed ANOTHER call's envelope still recovers its own name", got === "dev-probe", String(got));
    ok("…and the binding comes back with it, so writes work rather than bouncing off as collection:null",
      a.state.collection === "_probe-dev" && a.state.host === "chatgpt");
  }
  {
    // Live knowledge always beats memory — memory is the fallback, never the authority.
    const oai = fakeOai();
    oai.setWidgetState({ __oma: { app: "stale-app", collection: "stale" } });
    const a = build({ openai: oai, toolInput: { app: "live-app" } });
    ok("a live name outranks a remembered one", a.identity() === "live-app", String(a.identity()));
  }
  {
    const a = build({ openai: undefined, toolInput: {} });   // Claude, Codex, any non-OpenAI host
    ok("a host with no state channel simply has nothing remembered — null, not a throw",
      a.identity() === null);
    a.rememberIdentity();
    ok("…and remembering is a silent no-op there rather than a throw", true);
  }
  {
    // A host that offers widgetState but refuses the write must not take the widget down with it.
    const hostile = { widgetState: {}, setWidgetState() { throw new Error("denied"); } };
    const a = build({ openai: hostile, toolInput: { app: "x" } });
    let threw = null;
    try { a.rememberIdentity(); } catch (e) { threw = e; }
    ok("a rejected write leaves us exactly where we were, never mid-paint", threw === null, threw && threw.message);
  }
  // (The forensic dump that reported the vendor channel retired with the panel, elegance A15 —
  // the RECOVERY through openai.widgetState is what matters and is pinned above.)
}


console.log("\n9. a document that was STAMPED with its identity must not have to be told what it is");
{
  // wrapApp injects __OMA_APP__ and __OMA_COLLECTION_HINT__ before the runtime
  // evaluates, so a per-app document knows its own name at t=0 — but `app` started at null
  // anyway, which left ontoolresult's first-wins rule to be won by whoever spoke first. On a host
  // that hands a widget another call's envelope (measured verbatim, ChatGPT web) or in a turn that
  // opens two apps at once, that first speaker can be a DIFFERENT app.
  const seedM = rt.match(/(const BOUND_HINT = [\s\S]*?\nlet state = \{[^\n]*\};)/);
  ok("the state initializer was located", !!seedM);
  const seeded = (win) => new Function("window", seedM[1] + "\nreturn state;")(win);
  {
    const st = seeded({ __OMA_APP__: "trip-board", __OMA_COLLECTION_HINT__: "trip-tasks" });
    ok("🔴 a stamped document starts KNOWING its own name, not just its binding",
      st.app === "trip-board" && st.collection === "trip-tasks",
      JSON.stringify({ c: st.app, coll: st.collection }));
  }
  ok("…so first-wins now protects it: there is nothing left for a foreign envelope to win",
    /!state\.app/.test(rt));
  {
    const st = seeded({});
    ok("the universal loader still starts blank — it is stamped only after it resolves and mounts",
      st.app === null && st.collection === null);
  }

  // ⚠️ The two collection guards that used to live here were REVERTED, and the tests with them:
  // the reading they were built on was the model binding on purpose, and the guards broke the
  // per-app opener's documented `collection` argument. Pinning the reverted behaviour instead, so
  // nobody re-adds them without a measurement:
  const inM = rt.match(/hostApp\.ontoolinput = \(params\) => \{[\s\S]*?\n  \};/);
  ok("open_<name>'s collection argument still binds — its app is in the TOOL name, not the args",
    /if \(typeof a\.collection === "string" && a\.collection\) state\.collection = a\.collection;/.test(inM[0]),
    "a guard requiring a.app would silently drop the AI's explicit binding here");
}

console.log("\n10. the system badge — hover corner, pref-forced, or recovery-forced (D-13 + W1)");
{
  // ONE corner affordance, three states. The recovery story (ChatGPT web, both panes,
  // 2026-08-05): after a page refresh the re-render is handed another call's envelope with no
  // `collection`, so no startWalk() trigger ever fires — UI paints, data never loads, one
  // widget WRITE restores everything (the bridge was fine; nothing ever asked again). The
  // ladder rebinds from the identity note and re-walks; when it ends dry the badge goes FORCED
  // visible, and its tap (also the user gesture a gating host may want) runs the same
  // recover-and-walk. Real source, delays scaled down, run against stubs.
  const region = rt.match(/(const MOUNT_RETRY_MS = [\s\S]*?function hideRecoveryBadge\(\) \{[\s\S]*?\n\})/);
  ok("the badge region was extracted from the runtime", !!region);
  const scaled = region[1].replace("[800, 2500, 7000]", "[8, 16, 24]").replace("}, 1500)", "}, 10)");
  ok("…and both time literals were found to scale (test rig integrity)",
    scaled.includes("[8, 16, 24]") && !scaled.includes("1500"));

  const build = ({ note, walkSucceeds, pref, viewBase = null, openLinkOk = true }) => {
    const rig = { walks: 0, notes: [], attached: [], embeds: [], links: [], unmounts: 0, keyListeners: 0 };
    const stubs = `
      let walkedOnce = false, walking = null;
      const state = { collection: null, app: null, host: null };
      const compName = () => state.app;
      const linkBase = () => env.viewBase || "/view/";     // the runtime's own chain, stubbed
      const recoverIdentity = () => {
        const kept = env.note();
        if (!kept) return null;
        if (!state.collection) state.collection = kept;
        return kept;
      };
      const walk = () => {
        env.walks++;
        if (env.walkSucceeds()) { walkedOnce = true; hideRecoveryBadge(); }
        return Promise.resolve();
      };
      const omaNotify = (m) => env.notes.push(m);
      const rawPref = () => env.pref;
      const coercePref = (v, f) => (v == null ? f : v);
      const mkNode = () => {
        const n = { style: {}, disabled: false, textContent: "", title: "", type: "", className: "",
          kids: [], removed: false, cls: new Set(), setAttribute() {}, onclick: null,
          append(...els) { n.kids.push(...els); }, remove() { n.removed = true; } };
        n.classList = { toggle: (c, on) => { if (on) n.cls.add(c); else n.cls.delete(c); },
          contains: (c) => n.cls.has(c) };
        return n;
      };
      const document = { createElement: mkNode,
        documentElement: { append: (...els) => env.attached.push(...els) },
        addEventListener: () => { env.keyListeners++; },
        removeEventListener: () => { env.keyListeners--; } };
      // The two doors the menu actions use, both already shipped: the runner machine and the
      // host's ui/open-link. The badge is not allowed to invent a third.
      const window = { oma: {
        embed: (name, opts) => { env.embeds.push({ name, opts });
          return Promise.resolve({ unmount: () => { env.unmounts++; } }); },
        openLink: (url) => { env.links.push(url); return Promise.resolve({ ok: env.openLinkOk }); },
      } };
    `;
    const handles = new Function("env", stubs + scaled + `
      return { schedule: scheduleMountRecovery, mount: ensureSystemBadge, state,
               badge: () => sysBadge, bar: () => sysBar, items: () => (sysBar ? sysBar.kids : []),
               panel: () => sysPanel, forced: () => badgeForced,
               setApp: (n) => { state.app = n; },
               markWalked: () => { walkedOnce = true; } };`)(
      Object.assign(rig, { note, walkSucceeds, pref, viewBase, openLinkOk }));
    return { rig, ...handles };
  };
  const visible = (t) => t.badge() && t.badge().classList.contains("oma-on");
  const item = (t, title) => t.items().find((b) => b.title === title);
  const healthy = (extra) => build({ note: () => null, walkSucceeds: () => true, pref: undefined, ...extra });

  { // healthy host: mounted (as connect does), hover-only, ladder does nothing visible
    const t = build({ note: () => null, walkSucceeds: () => true, pref: undefined });
    t.mount();
    t.markWalked();
    t.schedule();
    await sleep(80);
    ok("on a healthy host the ladder never walks and the badge stays hover-only",
      t.rig.walks === 0 && !t.forced() && !visible(t) && t.badge().textContent === "↻");
  }
  { // the shared pref forces it visible without any failure
    const t = build({ note: () => null, walkSucceeds: () => true, pref: "always" });
    t.mount();
    t.markWalked();
    ok("system_badge=always keeps the badge visible on a healthy widget",
      visible(t) && t.badge().textContent === "↻");
  }
  { // the measured pit, with the note intact: rung one rebinds and walks — never forced
    const t = build({ note: () => "habit-streaks", walkSucceeds: () => true, pref: undefined });
    t.mount();
    t.schedule();
    await sleep(80);
    ok("a lost binding is recovered from the identity note and walked, once",
      t.rig.walks === 1 && t.state.collection === "habit-streaks", "walks=" + t.rig.walks);
    ok("…and the badge is never forced when the ladder succeeds", !t.forced() && !visible(t));
  }
  { // no note, walks fail: the ladder ends FORCED; the TAP (a user gesture) recovers
    let gestureSeen = false;
    const t = build({ note: () => (gestureSeen ? "habit-streaks" : null),
                      walkSucceeds: () => gestureSeen, pref: undefined });
    t.mount();
    t.schedule();
    await sleep(80);
    ok("when nothing can rebind, the ladder ends with the badge forced visible",
      t.forced() && visible(t) && /Load data/.test(t.badge().textContent));
    gestureSeen = true;               // the host that gates on a gesture just got one
    t.badge().onclick();
    await sleep(10);
    ok("one tap recovers the binding, walks, and stands the badge back down to hover",
      t.rig.walks === 1 && !t.forced() && !visible(t) && t.badge().textContent === "↻",
      JSON.stringify({ walks: t.rig.walks, forced: t.forced() }));
  }
  { // no note anywhere: the tap says the honest thing instead of doing nothing
    const t = build({ note: () => null, walkSucceeds: () => false, pref: undefined });
    t.mount();
    t.schedule();
    await sleep(80);
    t.badge().onclick();
    await sleep(10);
    ok("with no note to recover from, the tap explains the host-side way out",
      t.rig.notes.length === 1 && /open the app again/.test(t.rig.notes[0]), String(t.rig.notes[0]));
    ok("…and the badge stays forced for another try", t.forced() && visible(t));
  }

  // ---- D-13 ①②, Leo 2026-08-06: two more actions in the same hover corner --------------------
  { // the row, with a viewer to point at
    const t = healthy({ viewBase: "https://viewer.example/view/" });
    t.mount();
    ok("the corner is a ROW of actions: refresh, settings, open-in-browser",
      t.items().map((b) => b.textContent).join(" ") === "↻ ⚙ ⧉",
      JSON.stringify(t.items().map((b) => b.textContent)));
    ok("…each one named in words, not only in a glyph",
      t.items().map((b) => b.title).join(" | ") ===
      "Refresh this app's data | Open settings | Open in browser");
  }
  { // 🔴 D-13 ②: no viewer ⇒ the item does not EXIST (not: exists and does nothing)
    const t = healthy({ viewBase: null });
    t.mount();
    ok("🔴 with no viewer base, open-in-browser is never rendered at all",
      !item(t, "Open in browser") && t.items().length === 2);
    ok("…and the two actions that need no viewer are still there",
      !!item(t, "Refresh this app's data") && !!item(t, "Open settings"));
  }
  { // the browser item goes through the host's open-link door, at this app's own URL
    const t = healthy({ viewBase: "https://viewer.example/view/" });
    t.mount();
    t.setApp("habit-streaks");
    item(t, "Open in browser").onclick();
    await sleep(10);
    ok("open-in-browser asks the HOST to open this app's viewer URL (ui/open-link, no navigation)",
      t.rig.links.length === 1 && t.rig.links[0] === "https://viewer.example/view/habit-streaks",
      JSON.stringify(t.rig.links));
    ok("…and a host that opens it says nothing further", t.rig.notes.length === 0);
  }
  { // a host that refuses links, and a widget that does not know its own name
    const t = healthy({ viewBase: "https://viewer.example/view/", openLinkOk: false });
    t.mount();
    t.setApp("habit-streaks");
    item(t, "Open in browser").onclick();
    await sleep(10);
    ok("a host that will not open links is REPORTED, with the URL, instead of a dead click",
      t.rig.notes.length === 1 && /viewer\.example\/view\/habit-streaks/.test(t.rig.notes[0]),
      String(t.rig.notes[0]));
    const u = healthy({ viewBase: "https://viewer.example/view/" });
    u.mount();
    item(u, "Open in browser").onclick();
    await sleep(10);
    ok("…and with no identity at all it says so rather than opening a link for the wrong app",
      u.rig.links.length === 0 && /which app this is/.test(u.rig.notes[0] || ""), String(u.rig.notes[0]));
  }
  { // settings: the ONE mount machine, in place, and the same item closes it
    const t = healthy({ viewBase: null });
    t.mount();
    item(t, "Open settings").onclick();
    await sleep(10);
    ok("the settings item embeds the settings app IN PLACE via oma.embed — no new engine door",
      t.rig.embeds.length === 1 && t.rig.embeds[0].name === "settings" &&
      t.rig.embeds[0].opts.preset === "live", JSON.stringify(t.rig.embeds.map((e) => e.name)));
    ok("…in a panel of ours, with an Escape listener while it is open",
      !!t.panel() && t.rig.keyListeners === 1);
    item(t, "Open settings").onclick();
    ok("…and the same item closes it: child unmounted, panel removed, listener dropped",
      !t.panel() && t.rig.unmounts === 1 && t.rig.keyListeners === 0);
  }
  { // the pref is about the CORNER, not about one button in it
    const t = healthy({ pref: "always", viewBase: "https://viewer.example/view/" });
    t.mount();
    t.markWalked();
    ok("system_badge=always reveals the whole row, not just the refresh button",
      t.bar().classList.contains("oma-on") && visible(t));
  }
}

console.log("\n11. one intent, one card — a burst of delete demands coalesces (W1, S4)");
{
  // Measured (Leo, claude web cowork, 2026-08-05): settings' "Reset all" produced a CHAIN of
  // confirmation cards, one per row. The engine's per-row demands are correct — the UI asking
  // the same question N times was not. shellConfirm now absorbs demands that arrive while its
  // card is open; each member still spends its own request_state on re-send.
  const region = rt.match(/(let confirmCard = null;[\s\S]*?\n\})/);
  ok("shellConfirm was extracted from the runtime", !!region);

  const build = () => {
    const dom = { attached: [], keyHandlers: [] };
    const node = () => ({
      style: {}, textContent: "", _kids: [],
      append(...k) { this._kids.push(...k); },
      appendChild(k) { this._kids.push(k); },
      focus() {}, remove() { dom.attached = dom.attached.filter((x) => x !== this); },
    });
    const document = {
      createElement: () => node(),
      documentElement: { appendChild: (el) => dom.attached.push(el) },
      addEventListener: (t, h) => { if (t === "keydown") dom.keyHandlers.push(h); },
      removeEventListener: (t, h) => { dom.keyHandlers = dom.keyHandlers.filter((x) => x !== h); },
    };
    const confirm = new Function("document", region[1] + "\nreturn shellConfirm;")(document);
    // The card's pieces by construction order: [label, no, yes] appended to el.
    const card = () => dom.attached[0];
    const label = () => card()._kids[0].textContent;
    const click = (which) => card()._kids[which === "yes" ? 2 : 1].onclick();
    return { confirm, dom, card, label, click };
  };

  { // the S4 shape: three concurrent demands, ONE card, one click answers all three
    const t = build();
    const answers = [
      t.confirm({ preview: "locale" }), t.confirm({ preview: "date_format" }), t.confirm({ preview: "proactivity" })];
    ok("three demands in one burst share one card", t.dom.attached.length === 1);
    ok("…whose label is plural and names the first member",
      /Delete 3 items, including "locale"\?/.test(t.label()), t.label());
    t.click("yes");
    ok("one click answers every joined demand true", (await Promise.all(answers)).every((a) => a === true));
    ok("…and the card is gone", t.dom.attached.length === 0);
    const single = t.confirm({ preview: "later" });
    ok("a demand AFTER the answer opens a fresh card — an old answer buys nothing new",
      t.dom.attached.length === 1 && /Delete "later"\?/.test(t.label()), t.label());
    t.click("no");
    ok("…and cancel still answers false", (await single) === false);
  }
  { // fail-closed for the whole group: Escape declines every member
    const t = build();
    const answers = [t.confirm({ preview: "a" }), t.confirm({ preview: "b" })];
    t.dom.keyHandlers.forEach((h) => h({ key: "Escape" }));
    ok("Escape resolves every joined demand false", (await Promise.all(answers)).every((a) => a === false));
    ok("…and removes the card", t.dom.attached.length === 0);
  }
}

console.log("\n12. scale-to-thumbnail lives in the ONE machine (W4) — no per-app copies");
{
  // The settings grid (720px, CSS-var scale) and the App Store grid (760px, JS transform) had
  // each grown their own fit machinery, and the two had measurably drifted. oma.embed's `fit`
  // option is the single implementation now; the natural width is each caller's declared
  // argument. These pins keep a third copy from growing back.
  ok("oma.embed implements fit (natural width + transform scale + container observer)",
    /opts\.fit && Number\(opts\.fit\.width\) > 0/.test(rt) && /transformOrigin = "0 0"/.test(rt));
  const settingsUi = readFileSync(join(ROOT, "components", "settings", "ui.html"), "utf-8");
  const storeUi = readFileSync(join(ROOT, "components", "app-store", "ui.html"), "utf-8");
  ok("both grids mount through fit instead of hand-scaling",
    /fit: \{ width: VIRTUAL_W \}/.test(settingsUi) && /fit: \{ width: NATURAL_W \}/.test(storeUi));
  ok("…and neither keeps its own scale machinery",
    !/--pv-scale/.test(settingsUi) && !/updateScale/.test(settingsUi)
      && !/function fitPreview/.test(storeUi) && !/roScale/.test(storeUi));
}

console.log("\n13. 'Delete its data too' — settings runs the ENGINE's two-step, never its own (D-13 ③)");
{
  // The cascade confirmation is not a second arm-to-confirm: delete_app data:"cascade" answers
  // the FIRST call with a disposition plan plus a request_state bound to the world that plan
  // describes (server-smoke §15b pins the engine half). This section runs settings' real delete
  // card against a scripted engine and holds the two properties that matter: the first call never
  // deletes, and the second is the SAME call with the state attached.
  const settingsUi = readFileSync(join(ROOT, "components", "settings", "ui.html"), "utf-8");
  const region = settingsUi.match(/(let delArmed = false, delArmT = 0;[\s\S]*?)\n\s*\/\/ ---- Data pane/);
  ok("the delete card was extracted from components/settings/ui.html", !!region);

  const demand = (rows, keys) => ({ structuredContent: { ok: false, reason: "confirmation_required",
    name: "trip-board", request_state: "STATE-1", expires_at: "2026-08-06T00:10:00Z",
    preview: "trip-board and its data",
    plan: rows, settings_keys: keys } });
  const done = (cascaded) => ({ structuredContent: { ok: true, name: "trip-board", deleted: true,
    ...(cascaded ? { cascaded: [{ collection: "trip-board", rows: 3 }], settings_keys: 1 } : {}) } });
  const errored = (text) => ({ isError: true, content: [{ type: "text", text }] });

  const build = (replies) => {
    const rig = { calls: [], closed: 0, apps: 0, data: 0, replies: replies.slice() };
    const stubs = `
      const nodes = new Map();
      const mkNode = (id) => {
        const n = { id, hidden: true, textContent: "", checked: false, disabled: false, kids: [],
          onclick: null, focus() {}, append(...e) { n.kids.push(...e); } };
        Object.defineProperty(n, "innerHTML", { get: () => "", set: (v) => { if (!v) n.kids.length = 0; } });
        return n;
      };
      const document = { getElementById: (id) => {
        if (!nodes.has(id)) nodes.set(id, mkNode(id));
        return nodes.get(id);
      } };
      const el = (tag, cls, text) => ({ tag, cls, textContent: text });
      const setTimeout = () => 0, clearTimeout = () => {};     // the 4s disarm is not under test
      const crypto = { randomUUID: () => "cid-" + env.calls.length };
      const coercePref = (v, f) => (v == null ? f : v);
      const curStored = () => null;                            // confirm_delete unset ⇒ default ON
      const manifests = new Map(), declsRaw = new Map();
      const drawerComp = { name: "trip-board" };
      const closeDrawer = () => { env.closed++; };
      const loadApps = async () => { env.apps++; };
      const loadData = async () => { env.data++; };
      const oma = { callTool: async (name, args) => {
        env.calls.push({ name, args });
        return env.replies.shift() || { structuredContent: { ok: true, deleted: true } };
      } };
    `;
    const api = new Function("env", stubs + region[1] + `
      return { node: (id) => document.getElementById(id),
               del: () => document.getElementById("d-delete").onclick(),
               yes: () => document.getElementById("d-plan-yes").onclick(),
               no: () => document.getElementById("d-plan-no").onclick() };`)(rig);
    return { rig, ...api };
  };

  { // unticked: the tombstone delete, exactly as before — no `data`, no plan, no second leg
    const t = build([done(false)]);
    await t.del();                                  // arms
    ok("the first click only ARMS — nothing is sent", t.rig.calls.length === 0);
    await t.del();
    ok("unticked, delete_app is sent WITHOUT a disposition (the tombstone default)",
      t.rig.calls.length === 1 && t.rig.calls[0].args.data === undefined &&
      t.rig.calls[0].args.actor === "human", JSON.stringify(t.rig.calls[0]));
    ok("…and a keep-mode delete does not disturb the Data pane's cache",
      t.rig.closed === 1 && t.rig.apps === 1 && t.rig.data === 0);
  }

  { // 🔴 ticked: the first call is the DEMAND — it must not delete, and the plan must be shown
    const t = build([demand([{ collection: "trip-board", verdict: "exclusive", rows: 3 },
      { collection: "shared-notes", verdict: "shared", why: "also declared by journal" }], 1), done(true)]);
    t.node("d-cascade").checked = true;
    await t.del();
    ok("the arm label says what the tick changed", t.node("d-del-lbl").textContent === "Really delete + data?");
    await t.del();
    ok("🔴 ticked, the first call carries data:\"cascade\" and NO request_state",
      t.rig.calls.length === 1 && t.rig.calls[0].args.data === "cascade" &&
      t.rig.calls[0].args.request_state === undefined);
    ok("…and nothing was deleted: the drawer stays open, the plan is on screen",
      t.rig.closed === 0 && t.rig.apps === 0 && t.node("d-plan").hidden === false);
    const lines = t.node("d-plan-list").kids.map((k) => k.textContent);
    ok("…the plan says what GOES, with counts", lines.some((l) => /trip-board · 3 items/.test(l)) &&
      lines.some((l) => /its settings · 1 key/.test(l)), JSON.stringify(lines));
    ok("…and what STAYS, with the engine's own reason",
      lines.some((l) => /^Kept: shared-notes \(also declared by journal\)/.test(l)), JSON.stringify(lines));
    await t.yes();
    ok("the second leg is the IDENTICAL call with the state attached",
      t.rig.calls.length === 2 && t.rig.calls[1].args.data === "cascade" &&
      t.rig.calls[1].args.name === t.rig.calls[0].args.name &&
      t.rig.calls[1].args.request_state === "STATE-1", JSON.stringify(t.rig.calls[1].args));
    ok("…and only THEN is it gone — grid and Data pane both refreshed",
      t.rig.closed === 1 && t.rig.apps === 1 && t.rig.data === 1);
  }

  { // the world moved while the plan was on screen: the state is spent, and the plan dies with it
    const t = build([demand([{ collection: "trip-board", verdict: "exclusive", rows: 3 }], 0),
      errored("The confirmation no longer matches the world it was issued for.")]);
    t.node("d-cascade").checked = true;
    await t.del(); await t.del();
    await t.yes();
    ok("a stale state is reported and nothing is deleted",
      t.rig.calls.length === 2 && t.rig.closed === 0 && t.rig.apps === 0 &&
      /no longer matches/.test(t.node("d-err").textContent), t.node("d-err").textContent);
    ok("…and the stale plan is taken off screen rather than left to be re-confirmed",
      t.node("d-plan").hidden === true && /Press Delete again/.test(t.node("d-err").textContent));
  }
  { // a re-issued demand on the second leg is shown again — never auto-answered
    const t = build([demand([{ collection: "trip-board", verdict: "exclusive", rows: 3 }], 0),
      demand([{ collection: "trip-board", verdict: "exclusive", rows: 4 }], 0)]);
    t.node("d-cascade").checked = true;
    await t.del(); await t.del();
    await t.yes();
    ok("a re-issued plan replaces the one on screen, and still waits for the user",
      t.rig.calls.length === 2 && t.rig.closed === 0 && t.node("d-plan").hidden === false &&
      t.node("d-plan-list").kids.some((k) => /4 items/.test(k.textContent)));
  }

  { // Cancel spends nothing
    const t = build([demand([{ collection: "trip-board", verdict: "exclusive", rows: 3 }], 0)]);
    t.node("d-cascade").checked = true;
    await t.del(); await t.del();
    t.no();
    ok("Cancel closes the plan and sends nothing further",
      t.node("d-plan").hidden === true && t.rig.calls.length === 1 && t.rig.closed === 0);
  }
}

console.log(fail ? `\nFAILURES: ${pass} passed, ${fail} failed` : `\nALL PASS: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
