// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/runtime-contract.mjs — RUNTIME.md describes the two window.oma surfaces. This makes it true.
//
// RUNTIME.md exists for authors who are NOT the AI: someone who built an app in their own editor
// months ago, installed it with install-app.mjs, and has no get_component_guide in the loop. For
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
// navigation), isControlPlaneTool (for embedders building their own bridge, so they gate on the
// single source of truth instead of hand-maintaining a denylist).
//
// Run: node test/runtime-contract.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BRIDGE } from "../src/runner.mjs";
import { RUNTIME_CONTRACT } from "../src/runtime-core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

// Measured in Chrome, 2026-07-27, engine at the commit that added this file.
const PORTABLE = ["addItem", "callFunction", "callTool", "contract", "deleteItem", "files", "host",
  "moveItem", "onChange", "onPrefChange", "pref", "readCollection", "ready", "refresh",
  "sendMessage", "setPref", "standalone", "state", "toolInput", "updateContext", "updateItem"];
const DIRECT_ONLY = ["embed", "isControlPlaneTool", "viewBase"];

const doc = readFileSync(join(ROOT, "RUNTIME.md"), "utf-8");
const runtimeSrc = readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf-8");
// The direct surface is one object literal; slicing to it keeps an unrelated internal named `embed`
// from making this test pass for the wrong reason.
const directLiteral = runtimeSrc.slice(runtimeSrc.indexOf("window.oma = {"));
const bridgeLiteral = BRIDGE.slice(BRIDGE.indexOf("window.oma={"));

/** TOP-LEVEL keys of an object literal. The first version of this file matched member-shaped text
 *  anywhere in the literal; it reported ~60 nested keys as undocumented API, and it also said
 *  `embed` was present when the strict scan says it is a method the loose one only saw in a call.
 *  "Over-collecting is the safe direction" was wrong — a check that cries wolf gets a growing
 *  ignore-list bolted to it and then gets ignored, which is the exact failure OMA_REFERENCE_RE is
 *  commented about in src/tools/components.mjs.
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
  // The measurement this static scan stands in for. Chrome's Object.keys reported 23 direct / 20
  // bridge on the engine as it was BEFORE oma.contract was added — the very reading that produced
  // this file. Both surfaces gained exactly that one name, so the live numbers +1 are what the
  // extractor must produce today. A static extractor that agrees with a running one is the only
  // reason to trust the extractor at all, so the agreement is asserted rather than assumed.
  ok("direct surface = Chrome's 23 + oma.contract", direct.length === 23 + 1, `got ${direct.length}`);
  ok("bridge surface = Chrome's 20 + oma.contract", bridge.length === 20 + 1, `got ${bridge.length}`);
}

console.log("\n3. the document and the code agree on the version");
ok("RUNTIME.md states the contract version the code exports",
  new RegExp(`\\*\\*Contract version: ${RUNTIME_CONTRACT}\\*\\*`).test(doc), `code says ${RUNTIME_CONTRACT}`);
ok("both runtimes report the SAME number — a component cannot tell them apart by it",
  new RegExp(`get contract\\(\\)\\{return ${RUNTIME_CONTRACT}\\}`).test(BRIDGE)
  && /get contract\(\) \{ return RUNTIME_CONTRACT; \}/.test(runtimeSrc));

console.log("\n4. the claims RUNTIME.md makes about the engine, checked against the engine");
{
  const store = readFileSync(join(ROOT, "src", "store.mjs"), "utf-8");
  const runner = readFileSync(join(ROOT, "src", "runner.mjs"), "utf-8");
  const contracts = readFileSync(join(ROOT, "src", "contracts.mjs"), "utf-8");
  ok("the 200,000-byte document limit is the store's real limit",
    /MAX_COMPONENT_HTML = 200_000/.test(store) && doc.includes("200,000 bytes"));
  ok("the sandboxed child really is sandbox=allow-scripts with no allow-same-origin",
    /sandbox[^\n]*allow-scripts/.test(runtimeSrc) && !/allow-same-origin/.test(runtimeSrc)
    && doc.includes('sandbox="allow-scripts"'));
  ok("the child CSP really is default-src 'none'",
    /RUNNER_CSP_POLICY = "default-src 'none'/.test(runner) && doc.includes("default-src 'none'"));
  ok("the unreviewed tier really grants no call_tools",
    /unreviewed: \{ call_tools: \[\]/.test(contracts) && doc.includes("not allowed"));
  ok("a non-local component really binds to its own name whatever it declared",
    /tierOf\(comp\.author\) === "local"/.test(contracts) && doc.includes("**always its own name**"));
  ok("provenance really is unoverwritable in both directions (test/provenance.mjs owns the proof)",
    /tierOf\(existing\.author\) !== tierOf\(actor\)/.test(store) && doc.includes("not overwritable in either direction"));
}

console.log(`\n${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
