// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/runtime-contract.mjs — RUNTIME.md describes the two window.oma surfaces. This makes it true.
//
// RUNTIME.md exists for authors who are NOT the AI: someone who built an app in their own editor
// months ago, installed it with install-app.mjs, and has no get_app_guide in the loop. For
// them the document IS the API — and a document that has drifted from the code is worse than none,
// because it fails in their editor rather than ours.
//
// So the rule is two-way and mechanical:
//   1. every name RUNTIME.md documents must exist in the runtime it claims it for
//   2. every name those runtimes expose must be documented — no undocumented public API
// (2) is the half that actually decays: adding a method is easy and updating a markdown file two
// directories up is easy to skip.
//
// The extraction is deliberately CRUDE — a substring/boundary check per name against the source of
// each surface, not a parser. A parser here would need to handle method shorthand, getters, and a
// bridge that only exists as a string, and would be a second implementation of JavaScript to
// maintain. The names are the contract; that is all this needs to see.
//
// GROUND TRUTH. The two lists below were read out of a live browser (Object.keys on each surface,
// both mounted through /view), not inferred from source — and re-verified as the thing that made
// the crude extraction trustworthy in the first place. Direct mode's extra three are real and
// intended: embed (a sandboxed child may not embed further), viewBase (a sandboxed child has no
// navigation), openLink (a URL is an outbound channel a sandboxed child must not hold).
//
// Run: node test/runtime-contract.mjs
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BRIDGE, RUNNER_CSP_POLICY } from "../src/runner.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

// Measured in Chrome 2026-07-27; re-cut 2026-08-04 (elegance A10): callFunction (no server
// seat then), updateContext (returns with R2's bridge), host and isControlPlaneTool
// (zero consumers) left the surface; bind moved to the internal __OMA_BIND__ loader hook.
// callFunction RETURNED 2026-08-05 exactly on A10's condition — W3 shipped the server seat —
// in both runtimes (the bridge's rides the generic callTool door, so the guard shaping fires).
const PORTABLE = ["addItem", "callFunction", "callTool", "deleteItem", "files",
  "moveItem", "onChange", "onPrefChange", "pref", "readCollection", "ready", "refresh",
  "sendMessage", "setPref", "standalone", "state", "updateItem"];
// openLink is DIRECT-ONLY on purpose, and it is a security decision rather than an oversight: a
// URL is an outbound channel (the data rides in the query string), so handing a host-mediated
// link opener to a SANDBOXED child would punch a hole through the very property measured in
// docs/spec-conformance.md §8 — every outbound channel closed, top-navigation and popups
// included. A first-party document running direct is a different trust position entirely.
// `bind` is direct-only for the same class of reason, one notch sharper: it names the collection a
// runtime reads and writes. Its one caller is the universal loader, applying a binding the SERVER
// computed; a sandboxed child that could call it could point itself at another app's rows, which is
// precisely the boundary the guard's allowlist exists to hold.
// `tools` (2026-10-02) is direct-only for the openLink reason turned inward: a tool's name and
// description are text the MODEL reads and its run() is code the model triggers — from a
// sandboxed, unreviewed author that is a prompt-injection channel, not a feature.
const DIRECT_ONLY = ["display", "displayModes", "embed", "onDisplayChange", "openLink", "requestDisplay", "tools", "viewBase"];

const doc = readFileSync(join(ROOT, "RUNTIME.md"), "utf-8");
const runtimeSrc = readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf-8");
// The direct surface is one object literal; slicing to it keeps an unrelated internal named `embed`
// from making this test pass for the wrong reason.
const directLiteral = runtimeSrc.slice(runtimeSrc.indexOf("window.oma = {"));

// SPEC-26: the widget declares no capability it does not implement. `{ tools: {} }` announced a
// tool-serving view on every ui/initialize while oncalltool / onlisttools / a view-side
// registerTool are zero hits in src/ — two MUST violations in ext-apps draft apps.mdx (:1281,
// :1324). Pinned here rather than left to a reviewer's memory, because the declaration is one
// token wide and reads like boilerplate.
{
  const decl = runtimeSrc.match(/new App\(\{ name: "open-mcp-apps"[^}]*\}, ([^)]*)\)/);
  ok("the widget's ui/initialize capability declaration was found", !!decl, String(decl));
  // Since 2026-10-01 it declares display modes, and the rule holds: a declared mode must be
  // backed — the runtime asks the host for it and reads it back.
  ok("…the display modes it declares are backed: the runtime calls ui/request-display-mode and reads displayMode back",
    /availableDisplayModes: DISPLAY_MODES/.test(decl[1]) && /hostApp\.requestDisplayMode\(/.test(runtimeSrc)
      && /ctx\.displayMode/.test(runtimeSrc), decl[1]);
  // History of the other token: until 2026-10-02 the rule here was the inverse — NO tools, because
  // nothing answered tools/list (2026-10-01 the screen experiment declared view tools, measured
  // that neither claude.ai nor ChatGPT hands them to the model, and took the declaration back).
  // App-provided tools (oma.tools) made it backed: serveAppTools answers both requests, and the
  // SDK refuses those handlers unless the capability is declared — so the two must move together.
  const core = readFileSync(join(ROOT, "src", "runtime-core.mjs"), "utf-8");
  ok("🔴 it declares the tools capability WITH listChanged — and only because it is backed",
    /tools: \{ listChanged: true \}/.test(decl[1]), decl[1]);
  ok("…backed: serveAppTools answers tools/list + tools/call and sends list_changed, and the runtime wires it to hostApp",
    /app\.onlisttools = /.test(core) && /app\.oncalltool = /.test(core) && /app\.sendToolListChanged\(\)/.test(core)
      && /serveAppTools\(hostApp, appTools\)/.test(runtimeSrc));
}

const bridgeLiteral = BRIDGE.slice(BRIDGE.indexOf("window.oma={"));

/** TOP-LEVEL keys of an object literal. The first version of this file matched member-shaped text
 *  anywhere in the literal; it reported ~60 nested keys as undocumented API, and it also said
 *  `embed` was present when the strict scan says it is a method the loose one only saw in a call.
 *  "Over-collecting is the safe direction" was wrong — a check that cries wolf gets a growing
 *  ignore-list bolted to it and then gets ignored, which is the exact failure OMA_REFERENCE_RE is
 *  commented about in src/tools/apps.mjs.
 *
 *  Depth counting, and a name counts only at a MEMBER-START position: right after the opening
 *  brace, or after a comma that is itself at depth 1. Prefixes are the ones a literal can carry
 *  (`get` / `set` / `async` / generator `*`); missing `async` is what hid `embed`. */
function topLevelKeys(src) {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
  const out = [];
  let depth = 0, atStart = false, quote = null;
  for (let i = s.indexOf("{"); i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{" || c === "[" || c === "(") { if (++depth === 1) atStart = true; continue; }
    if (c === "}" || c === "]" || c === ")") { if (--depth === 0) break; continue; }
    if (depth !== 1) continue;
    if (c === ",") { atStart = true; continue; }
    if (!atStart || /\s/.test(c)) continue;
    const m = /^(?:(?:get|set|async)\s+|\*\s*)*([a-zA-Z_$][\w$]*)\s*[:(]/.exec(s.slice(i));
    if (m) out.push(m[1]);
    atStart = false;   // whatever this member turned out to be, we are past its name
  }
  return out;
}
const direct = topLevelKeys(directLiteral);
const bridge = topLevelKeys(bridgeLiteral);
const D = new Set(direct), B = new Set(bridge);

console.log("1. every name RUNTIME.md documents exists in the runtime it claims");
for (const n of PORTABLE) {
  ok(`${n} — direct`, D.has(n));
  ok(`${n} — runner bridge`, B.has(n));
}
for (const n of DIRECT_ONLY) {
  ok(`${n} — direct only, and present`, D.has(n));
  ok(`...and absent from the bridge`, !B.has(n), `"${n}" leaked into the sandboxed surface`);
}

console.log("\n2. every name the runtimes expose is documented (no undocumented public API)");
{
  const known = new Set([...PORTABLE, ...DIRECT_ONLY]);
  for (const [label, found, expected] of [
    ["direct", direct, [...PORTABLE, ...DIRECT_ONLY]],
    ["bridge", bridge, PORTABLE],
  ]) {
    const undocumented = found.filter((n) => !known.has(n));
    ok(`${label}: nothing exposed that RUNTIME.md doesn't name`, undocumented.length === 0,
      `undocumented: ${undocumented.join(" ")}`);
    // The count is the other half: it catches a name that was RENAMED into something documented
    // elsewhere, which the containment checks in §1 would both wave through.
    ok(`${label}: exactly the documented surface, no more (${found.length})`,
      found.length === expected.length,
      `found ${found.length} (${found.slice().sort().join(" ")}), documented ${expected.length}`);
  }
  // The measurement this static scan stands in for: Chrome's Object.keys read 23 direct / 20
  // bridge (2026-07-27, pre-contract). Ledger since: +contract, +openLink, +bind (2026-07-2x);
  // then the 2026-08-04 elegance cut removed callFunction, updateContext, host, isControlPlaneTool
  // and moved bind internal — direct 26→21, bridge 21→18; W3 (2026-08-05) returned callFunction
  // with its server seat — 22/19; 2026-10-01 display modes (display, displayModes, requestDisplay,
  // onDisplayChange — direct only for now) — 26/19; same day contract and toolInput (zero app
  // consumers; the loader reads identity through __OMA_IDENTITY__) left both surfaces — 24/17;
  // 2026-10-02 tools (app-provided tools, direct only) — 25/17.
  // A static extractor that agrees with the ledger of a running one is the only reason to trust
  // the extractor, so it is asserted.
  ok("direct surface = the measured ledger (25 after tools joined)", direct.length === 25, `got ${direct.length}`);
  ok("bridge surface = the measured ledger (17 after contract + toolInput left)", bridge.length === 17, `got ${bridge.length}`);
}

// ── 2b. …and the TYPES an app author compiles against name the same surface ──────────────────
// types/window-oma.d.ts is the fourth copy of this list (runtime source, this table, RUNTIME.md
// via doc-facts, and now the .d.ts). It is the copy nobody runs, so nothing but a test can notice
// it going stale — and a stale one is worse than none: it type-ERRORS correct code, in an editor,
// with no way for the author to tell whether they or the file are wrong.
// Membership, not shape: a signature is prose the compiler checks for the author, while a NAME is
// the thing this repo pins in four places and must not be able to drop from one of them.
console.log("\n2b. the app-author types (types/window-oma.d.ts) name the whole surface");
{
  const dts = readFileSync(join(ROOT, "types", "window-oma.d.ts"), "utf-8");
  // Member positions only — a name that appears in a comment is not a declaration, and this file
  // is heavily commented (`embed`, `openLink` and `viewBase` are all discussed in its header).
  const declared = new Set(
    dts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/[^\n]*/g, "$1")
      .split("\n").map((l) => /^\s{2}(?:readonly\s+)?([a-zA-Z_$][\w$]*)\??\s*[:(<]/.exec(l))
      .filter(Boolean).map((m) => m[1]));
  for (const n of PORTABLE) ok(`${n} — declared in window-oma.d.ts`, declared.has(n));
  for (const n of DIRECT_ONLY)
    ok(`${n} — declared, and OPTIONAL (a sandboxed app reads undefined)`, declared.has(n)
      && new RegExp(`^\\s{2}(?:readonly\\s+)?${n}\\?`, "m").test(dts));
  // ── THREE GATES, BECAUSE THE FIRST ONE WAS GREEN WHILE THE FILE REACHED NOBODY.
  // `files` has listed "types" since the day this .d.ts was written, and the assertion below it
  // passed every run — and `npm pack @2nd1st/open-mcp-apps@0.5.9 --dry-run` still shipped no
  // types/ at all, because npm packs from the PUBLIC checkout and scripts/publish.mjs never put
  // the directory there. A packaging claim needs every gate on the road out, not the first one.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  ok("…package.json ships it (a type file outside `files` is a type file nobody receives)",
    pkg.files.includes("types"));
  ok("…the public snapshot carries it (outside the ALLOWLIST it never reaches the repo npm packs from)",
    /^\s*"types",\s*$/m.test(readFileSync(join(ROOT, "scripts", "publish.mjs"), "utf-8")));
  // …and the exports map, which is what bundler/node16 resolution reads INSTEAD of the file tree.
  // Measured 2026-08-16: with only "." and "./package.json" declared, the documented
  // `/// <reference types="@2nd1st/open-mcp-apps/types/window-oma" />` was TS2688 under both, so
  // window.oma typed as an error in exactly the projects this file exists for.
  for (const sub of ["./types/window-oma", "./types/oma-function"]) {
    const ent = pkg.exports[sub];
    ok(`exports declares ${sub} → its .d.ts`,
      !!ent && typeof ent.types === "string" && existsSync(join(ROOT, ent.types)),
      JSON.stringify(ent));
  }
  // ── the STATE SHAPE, which the member list above cannot see ────────────────────────────────
  // `get state()` hands back the runtime's own object — and so does every `ready(cb)` / `onChange(cb)`
  // argument, which is the same object by reference. So whatever keys the initialiser declares are
  // keys an app can read, and the .d.ts has to say so or it type-ERRORS correct code.
  // Measured 2026-08-16: it did. `app` and `host` were live on the object (the universal loader
  // reads `state.app` to decide what to MOUNT — src/shell.mjs "state.app is where the loader reads
  // the name" — and engine.mjs:303 names `oma.state.host` as where the host label lands), while
  // OmaState declared neither. `oma.state.app` was TS2339 against a field that always has a value.
  // Filtering them off the getter instead was the other candidate and it is not available: the
  // callbacks hand out the same object, and the loader is a real consumer of what would be removed.
  //
  // Pinned against the INITIALISER, not a hand-kept list — that literal is one line, it is where a
  // new key is born, and a list beside it would be the fifth copy of a thing this file exists to
  // stop copying.
  {
    const init = /^let state = \{([^}]*)\};/m.exec(runtimeSrc);
    ok("the runtime's state initialiser was found", !!init, String(init));
    const keys = init ? [...init[1].matchAll(/([a-zA-Z_$][\w$]*)\s*:/g)].map((m) => m[1]) : [];
    ok(`the key scan is non-vacuous (${keys.length} keys on the runtime's state)`, keys.length >= 5, keys.join(" "));
    // Members of the OmaState block only: OmaItem right above it has `version` too, and a
    // whole-file search would let a missing state key pass on its neighbour's declaration.
    const block = /export interface OmaState \{([\s\S]*?)\n\}/.exec(dts);
    ok("OmaState was found in the .d.ts", !!block);
    const declared = new Set(block
      ? [...block[1].replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/^\s{2}([a-zA-Z_$][\w$]*)\??\s*:/gm)].map((m) => m[1])
      : []);
    for (const k of keys)
      ok(`state.${k} — declared in OmaState (an app can read it, so the types must name it)`, declared.has(k),
        `OmaState declares: ${[...declared].join(" ")}`);
  }

  // The function body's half of the author surface: the api names, from function-worker.mjs.
  const fdts = readFileSync(join(ROOT, "types", "oma-function.d.ts"), "utf-8");
  const worker = readFileSync(join(ROOT, "src", "function-worker.mjs"), "utf-8");
  const apiNames = [...worker.matchAll(/^\s{2}([a-z][\w$]*):\s*\(/gm)].map((m) => m[1]);
  ok(`the api scan is non-vacuous (${apiNames.length} name(s) read off function-worker.mjs)`,
    apiNames.length >= 4, apiNames.join(", "));
  for (const n of apiNames)
    ok(`api.${n} — declared in oma-function.d.ts`, new RegExp(`^\\s{2}${n}[(<]`, "m").test(fdts));
  ok("…and NO api.delete is declared (its absence is the design, not an omission)",
    !/^\s{2}delete[(<]/m.test(fdts) && !apiNames.includes("delete"));
}

// ── 2c. …and so does the AUTHORING GUIDE, which is the copy an AI writes code FROM ────────────
// RUNTIME.md is for the human author, and doc-facts pins it. `src/guide.mjs` is for the OTHER
// author — the model — and until this check existed nothing pinned it at all. That is exactly how
// it drifted: the 2026-08-04 elegance cut removed `oma.host` from both runtimes and updated
// RUNTIME.md in the same commit (its message says so), while the guide went on printing
//
//     oma.host        // who is rendering: "claude-ai", …
//
// for twelve days. A wrong name in this file is worse than a wrong name in a document, because
// nobody reads it and disagrees — a model copies it, and the app ships reading `undefined`.
//
// ONE DIRECTION ONLY: every `oma.<name>` the guide prints must exist. The reverse is not required
// and would be wrong to require — the guide is a teaching text that deliberately shows a subset
// (it never mentions `viewBase` or `displayModes`), and a rule forcing it to name everything would
// turn it back into the reference RUNTIME.md already is.
//
// The scan reads the FILE, not the exported `GUIDE` string, because the file is the superset: the
// per-topic CHAPTERS (embed, functions, style) are a second teaching surface reached through
// get_app_guide {topic}, and they are not exported one by one.
console.log("\n2c. the authoring guide (src/guide.mjs) names only members that exist");
{
  const guideSrc = readFileSync(join(ROOT, "src", "guide.mjs"), "utf-8");
  const surface = new Set([...PORTABLE, ...DIRECT_ONLY]);
  const named = [...new Set([...guideSrc.matchAll(/\boma\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]))].sort();
  // Non-vacuous first: a regex that stopped matching would make every assertion below pass by
  // never running, which is the failure this repo keeps re-learning.
  ok(`the scan is non-vacuous (${named.length} distinct oma.<name> in the guide)`, named.length >= 12, named.join(" "));
  const ghosts = named.filter((n) => !surface.has(n));
  ok("every name the guide teaches is on one of the two runtimes",
    ghosts.length === 0,
    `the guide teaches ${ghosts.map((n) => "oma." + n).join(", ")} — removed from the runtime, so an app that copies this reads undefined`);
}

console.log("\n3. the claims RUNTIME.md makes about the engine, checked against the engine");
{
  const store = readFileSync(join(ROOT, "src", "store.mjs"), "utf-8");
  const runner = readFileSync(join(ROOT, "src", "runner.mjs"), "utf-8");
  const contracts = readFileSync(join(ROOT, "src", "contracts.mjs"), "utf-8");
  // The document cap was REMOVED in v0.6.0, so this assertion pins its ABSENCE on both sides —
  // the doc↔code pairing this block exists for is just as breakable by a doc that keeps promising
  // a ceiling the store no longer has (that is exactly the shape it caught before).
  // Named shapes, not bare words: the store still SPEAKS of MAX_APP_HTML in the comment that
  // explains why it is gone, and that comment is worth keeping — so what is pinned is the
  // declaration and the refusal, the two things that would make the cap real again.
  ok("there is no write-side document size cap, and the document does not claim one",
    !/export const MAX_APP_HTML/.test(store) && !/error: "ui_too_large"/.test(store)
    && !doc.includes("200,000 bytes") && /no cap/.test(doc));
  ok("the sandboxed child really is sandbox=allow-scripts allow-forms with no allow-same-origin",
    /sandbox[^\n]*allow-scripts/.test(runtimeSrc) && !/allow-same-origin/.test(runtimeSrc)
    && doc.includes('sandbox="allow-scripts allow-forms"'));
  // Read off the VALUE as well as the source. Apps may now declare where they reach, so the policy
  // is BUILT (runnerCspFor) and the literal below is the FLOOR — the thing RUNTIME.md is actually
  // promising. Grepping the literal alone would go on passing even if the builder stopped agreeing
  // with it; test/csp-passthrough.mjs owns that equality, and this owns the doc's claim.
  ok("the child CSP really is default-src 'none' for an app that declares nothing",
    /RUNNER_CSP_POLICY = "default-src 'none'/.test(runner)
    && RUNNER_CSP_POLICY.startsWith("default-src 'none'") && doc.includes("default-src 'none'"));
  ok("the unreviewed tier really grants no call_tools",
    /unreviewed: \{ call_tools: \[\]/.test(contracts) && doc.includes("not allowed"));
  ok("a non-local app really binds to its own name whatever it declared",
    /tierOf\(comp\.author\) === "local"/.test(contracts) && doc.includes("**always its own name**"));
  ok("provenance really is unoverwritable in both directions (test/provenance.mjs owns the proof)",
    /tierOf\(existing\.author\) !== tierOf\(actor\)/.test(store) && doc.includes("not overwritable in either direction"));
}

// ── 4. app tools reach the AI on hosts that never ask the view (the RELAY road) ──────────────────
// The native road is driven in test/runtime-core.mjs §13 against a real SDK App. This is the other
// one, the road claude.ai and ChatGPT actually offer: the REAL server half (src/tools/screen.mjs)
// and the REAL registry, with the widget's poll loop played here — its DOM half (screenRead)
// cannot run in node, so the two lines of it that matter are pinned by source below.
console.log("\n4. app tools over the screen relay — listed by screen_read, called by screen_act {tool, input}");
{
  const { register } = await import("../src/tools/screen.mjs");
  const { createAppTools, appToolText } = await import("../src/runtime-core.mjs");
  const handlers = {};
  register({ server: { registerTool: (name, def, fn) => { handlers[name] = { def, fn }; } }, store: {}, hostName: () => "sim" });
  ok("screen_act offers the call form: tool + input", !!(handlers.screen_act && handlers.screen_act.def.inputSchema.tool && handlers.screen_act.def.inputSchema.input));
  ok("…and no sibling tool was added for it (one verb for \"do it in the app\")",
    Object.keys(handlers).sort().join(",") === "screen_act,screen_poll,screen_read", Object.keys(handlers).join(","));

  const appTools = createAppTools();
  appTools.register({ name: "pack_item", inputSchema: { properties: { item: { type: "string" } }, required: ["item"] }, run: ({ item }) => item + " is packed. 3 of 5 packed." });
  // The widget: one long poll → the job → run it the way shell-runtime's loop does → hand it back.
  const poll = (args) => handlers.screen_poll.fn({ session: "w1", app: "trip-planner", visible: true, born: Date.now(), ...args });
  const widget = (async () => {
    const r = await poll({});
    const job = r.structuredContent && r.structuredContent.job;
    // Not a tool job → answer as a press would, so a broken relay reads as ✗ below, not a crash.
    const out = job.tool ? await appTools.call(job.tool, job.input) : { content: [{ type: "text", text: "(pressed)" }] };
    poll({ done: { id: job.id, text: appToolText(out), ...(out.isError ? { isError: true } : {}) } });   // the next poll carries it
    return job;
  })();
  await new Promise((r) => setTimeout(r, 5));   // the widget is waiting in its poll
  const res = await handlers.screen_act.fn({ tool: "pack_item", input: { item: "passport" } });
  const job = await widget;
  ok("the AI's call reaches the widget as a TOOL job (name + input), not a press", job.tool === "pack_item" && job.input.item === "passport" && !job.ref && !job.action, JSON.stringify(job));
  ok("…and run()'s answer travels back to the AI as the result of screen_act",
    res.content[0].text === "passport is packed. 3 of 5 packed." && !res.isError, JSON.stringify(res));

  const w2 = (async () => {
    const r = await poll({});
    const j = r.structuredContent.job, out = await appTools.call(j.tool, j.input);
    poll({ done: { id: j.id, text: appToolText(out), ...(out.isError ? { isError: true } : {}) } });
  })();
  await new Promise((r) => setTimeout(r, 5));
  const bad = await handlers.screen_act.fn({ tool: "pack_itm", input: {} });
  await w2;
  ok("a wrong tool name comes back to the AI as an error naming the real ones", bad.isError === true && /pack_item/.test(bad.content[0].text), JSON.stringify(bad));

  // The widget half that node cannot run, pinned where it lives.
  ok("the runtime's relay loop runs a tool job through the registry and hands back appToolText",
    /job\.tool \? await appTools\.call\(job\.tool, job\.input\)/.test(runtimeSrc) && /text: appToolText\(out\)/.test(runtimeSrc));
  ok("screen_read lists the app's tools, ahead of the screen and outside its budget",
    /const own = appTools\.describe\(\);\s*\n\s*if \(own\) out\.push\(/.test(runtimeSrc));
  // The person's answer stays the person's. Reproduced 2026-10-05 in a real browser through
  // host-sim, before the fix: screen_act pressed an app's "Remove", then the confirmation card's
  // "Delete", and the row was gone. After it: "No control" for the AI, and a real click still
  // deletes. node cannot run the DOM half, so the three lines that hold it are pinned here.
  ok("the confirmation card is chrome — off the screen the relay reads and presses",
    /el\.setAttribute\("data-oma-chrome", ""\);\s*\n\s*el\.append\(label, no, yes\)/.test(runtimeSrc));
  ok("…its Delete answers only a click the browser marks as the person's (isTrusted)",
    /yes\.onclick = \(e\) => \{ if \(e\.isTrusted\) done\(true\); \};/.test(runtimeSrc));
  ok("…and screen_act cannot reach chrome by label either: every candidate passes screenOff",
    /const all = \[\.\.\.document\.querySelectorAll\(ACTIONABLE\)\]\.filter\(\(e\) => screenVisible\(e\) && !screenOff\(e\)\);/.test(runtimeSrc)
    && /if \(el && el\.isConnected && !screenOff\(el\)\) return el;/.test(runtimeSrc));
}

console.log(`\n${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
