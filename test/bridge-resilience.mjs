// SPDX-License-Identifier: AGPL-3.0-only
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
import { wrapLoader } from "../src/shell.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rt = readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf-8");

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));
const sink = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("1. withDeadline — the runtime's bridge envelope (real source, deadline scaled to 40ms)");
{
  const m = rt.match(/const BRIDGE_DEADLINE_MS = [\d_]+;\s*\n(function withDeadline[\s\S]*?\n\})/);
  ok("withDeadline + BRIDGE_DEADLINE_MS exist in the runtime", !!m);
  const withDeadline = new Function("BRIDGE_DEADLINE_MS", m[1] + "; return withDeadline;")(40);

  let out = null;
  try { await withDeadline(sink(), "data_version"); } catch (e) { out = String(e.message); }
  ok("a SUNK promise rejects instead of hanging", out != null);
  ok("…and the rejection names the call and the drop", /data_version/.test(out) && /no reply/.test(out), out);

  ok("a resolution inside the deadline passes through", (await withDeadline(Promise.resolve(7), "x")) === 7);

  let err = null;
  try { await withDeadline(Promise.reject(new Error("denied")), "x"); } catch (e) { err = e; }
  ok("a real rejection passes through untouched", err && err.message === "denied");

  ok("the bridge call site is wrapped (SA /rpc keeps fetch's own failure modes)",
    /withDeadline\(hostApp\.callServerTool\(/.test(rt));
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
  // The answer was already in hand: the loader fetches app_html before it mounts anything,
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
      bind: (c) => bound.push(c),
      callTool: async () => result,
      embed: async (n, o) => { embeds.push(o); },
    };
    const win = {};
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
  ok("dist/shell.js contains the bridge deadline", dist.includes("no reply in"));
  ok("dist/shell.js contains the inert fixture answering", dist.includes('"fx-"') || dist.includes("'fx-'") || dist.includes("fx-"));
}

console.log("\n2c. a failure surface that survives the runtime being broken");
// The bug this pins: on a page refresh the widget sat on "Loading app…" forever — no retry
// counter, no error, and not one app_html call reaching the server. Everything the loader can
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
  // does boot ask data_collections). So the observer normally fires FIRST. Answering that with an
  // empty snapshot is not a rare race — it is the ordinary first paint, and it is permanent: the
  // thumb is recorded in `thumbs`, its skeleton is removed, and nothing mounts it again.
  //
  // Real source, extracted from the shipped app.
  const settingsSrc = readFileSync(join(ROOT, "components", "settings.html"), "utf-8");
  const m = settingsSrc.match(/(const PREVIEW_ROWS_PER_COLLECTION[\s\S]*?)\n\s*\/\/ Mount = oma\.embed/);
  ok("previewSnapshot + its constants extracted from components/settings.html", !!m);

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

  // undefined, not null: the bridge never connected, so applyTheme never ran and the global was
  // never written. "we were told nothing" and "we never got to ask" are different readings.
  const bare = runLost({ toolInput: null, state: { app: null, collection: null, items: [] } }, undefined);
  ok("it says, in words, that the widget lost track of which app it is",
    /lost track of which app it is/.test(bare), bare.slice(0, 120));
  ok("…and names every channel it checked, marking the empty ones",
    /toolInput\.app ✗/.test(bare) && /state\.app ✗/.test(bare) &&
    /toolInfo\.id ✗/.test(bare) && /toolInfo\.tool\.name ✗/.test(bare), bare);
  ok("…and tells the user their data is fine and what to do next",
    /open the app again/.test(bare) && /data is untouched/.test(bare));
  ok("…and reports the missing bridge context as such, not as a silent null",
    /bridge never connected/.test(bare), bare);

  // 🔴 The reading this whole surface exists to produce: a host that replays hostContext but not
  // the tool input. If toolInfo comes back, the widget is recoverable and the dump says so.
  const withInfo = runLost(
    { toolInput: null, state: { app: null, collection: null, items: [] } },
    { theme: "dark", toolInfo: { id: 42, tool: { name: "open_app" } } });
  ok("a host that replays toolInfo is reported as SUCH — the id is named, not buried",
    /toolInfo\.id ✓ 42/.test(withInfo), withInfo);
  ok("…and the tool name it came from is named too (open_<app> vs open_app decides the fix)",
    /toolInfo\.tool\.name ✓ open_app/.test(withInfo), withInfo);
  ok("…and the raw host context is in the copyable dump, whole",
    /"theme": "dark"/.test(withInfo) && /"id": 42/.test(withInfo));

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
  //   data_collections{}              → open_app{...}   ⇒ widget got toolInput {}
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
  ok("the loader's dump reports the vendor channel — what it offers AND what we kept in it",
    /canPersist/.test(wrapLoader()) && /openai\.widgetState\.__oma/.test(wrapLoader()));
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

console.log(fail ? `\nFAILURES: ${pass} passed, ${fail} failed` : `\nALL PASS: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
