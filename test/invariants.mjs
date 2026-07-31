// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/invariants.mjs — two architectural rules that only hold if a machine enforces them.
//
// Both exist because the author of this codebase is usually an AI, and an AI will cheerfully
// re-add a tool inline or introduce an undocumented env flag while doing something else. A rule
// living in a doc gets obeyed for a week; a rule living here gets obeyed.
//
//  1. TOOL REGISTRATION IS CONFINED. src/engine.mjs is the one file three tracks all need to
//     edit — it is the project's only real serialization bottleneck. Once registrations are split
//     into src/tools/*.mjs, this check is what stops the bottleneck from quietly growing back.
//  2. EVERY ENV FLAG IS DECLARED. Work-in-progress lands on main behind an OMA_* flag, which
//     means flag debt is the price of trunk-based development. Construction flags therefore carry
//     an expiry, and this test fails when one is overdue. Undeclared and unused flags both fail
//     too: an undeclared flag is a hidden switch, a stale entry is a lie about what exists.
//
// Static scan only — no server, no db, runs in milliseconds.
// Run: node test/invariants.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Where server.registerTool( is allowed to appear. src/tools/ is listed ahead of the split so the
// refactor needs no edit here — and so the intended destination is documented in the rule itself.
const TOOL_REGISTRATION_ALLOWED = [
  "src/engine.mjs",     // today: everything. Roadmap: split into src/tools/*.mjs
  /^src\/tools\/[a-z-]+\.mjs$/,
];

// The complete set of environment switches the SHIPPED engine reads. Test-only variables belong
// nowhere near this table: the registry's claim is "these are the switches a deployment has",
// and listing test/eval-live.mjs's OMA_EVAL_* here would make that claim false. shippedSources()
// scans src/** plus the root entry points for exactly that reason.
//   product      — a real, permanent capability toggle. Needs a `why`.
//   construction — temporary, gates unfinished work on main. Needs `removeBy` (ISO date).
//   build        — provenance stamped in by the image build. Not a toggle; never branched on.
//   platform     — not ours; set by the OS or a host.
const FLAGS = {
  OMA_BUILD:          { kind: "build",    why: "commit SHA baked in by the image build; reported to the host in the MCP server info so a deployment can be told apart from a checkout" },
  OMA_BUILD_FILE:     { kind: "build",    why: "path to the same SHA, for images that resolve it at build time — discoverable via `docker inspect`, unlike a value injected inline in CMD" },
  OMA_DB:             { kind: "product",  why: "database location override (tests, multi-tenant hosts)" },
  OMA_HOST:           { kind: "product",  why: "host label when clientInfo.name is unavailable" },
  OMA_FILE_BACKEND:   { kind: "product",  why: "swappable file-plane backend" },
  OMA_DYNAMIC_TOOLS:  { kind: "product",  why: "opt-in per-app open_<name> tools; DEFAULT OFF because every save_app would invalidate the whole conversation's prompt cache" },
  OMA_QUERY:          { kind: "construction", removeBy: "2026-09-15",
                        why: "gates EXECUTION of data_query, never its registration — a tool that appears mid-life invalidates every cached tool list, so the seat ships from day one and the flag decides whether calling it works. Off until a live-model eval shows models reach for it instead of pulling rows; the fallback (read and count) is always available, which is what makes the flag safe to leave off" },
  // OMA_PROBE / OMA_PROBE_OUT retired 2026-07-27 with src/tools/probe.mjs, exactly as their entry
  // demanded: both readings landed in the host matrix (E1b — audience ignored by every measured
  // host; E6 — the ui-extension predicate held at n=4; §15c — the delivery cut measured on the
  // four-host matrix). The delivery-cut campaign docs hold the numbers.
  PORT:               { kind: "product",  why: "http transport port" },
  OMA_VIEWER:         { kind: "product",  why: "turns OFF the local browser viewer that the stdio server starts by default (OMA_VIEWER=0). It is a real capability toggle, not a debug flag: default-on means every install binds a loopback port it was not asked for, and port clashes and corporate policy are both real reasons to want it gone. Read ONLY by the embedded path — running `node src/http.mjs` directly IS asking for a viewer, so the flag does not gate it" },
  OMA_VIEW_BASE:      { kind: "product",  why: "public base URL of the browser viewer, for the app links handed to the model. Defaults to loopback, which is right locally and DEAD behind a tunnel or reverse proxy — the setup every hosted chat reaches this server through. The process cannot discover its own external address; the operator can" },
  APPDATA:            { kind: "platform", why: "Windows data dir" },
  XDG_DATA_HOME:      { kind: "platform", why: "XDG data dir" },
  XDG_CONFIG_HOME:    { kind: "platform", why: "XDG config dir" },
};

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

/** Shipped source only: src/**.mjs plus the root entry points. Tests and scripts are not shipped. */
function shippedSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs")) out.push(p);
    }
  };
  if (existsSync(join(ROOT, "src"))) walk(join(ROOT, "src"));
  for (const f of ["index.mjs", "build.mjs", "seed.mjs", "install.mjs", "uninstall.mjs"])
    if (existsSync(join(ROOT, f))) out.push(join(ROOT, f));
  return out.map((p) => [relative(ROOT, p).split("\\").join("/"), readFileSync(p, "utf-8")]);
}

const sources = shippedSources();
const allowed = (rel) => TOOL_REGISTRATION_ALLOWED.some((a) => (typeof a === "string" ? a === rel : a.test(rel)));

// All three registration calls, not just server.registerTool: open_app and the per-app
// open_<name> tools go through the MCP-Apps helpers, so matching only .registerTool( would let
// 1 of the 33 tools — and every ui:// resource — escape the rule.
const REGISTRATION_CALL = /(?:\.registerTool|registerAppTool|registerAppResource)\s*\(/;

console.log("1. tool registration is confined");
const registrars = sources.filter(([, src]) => REGISTRATION_CALL.test(src)).map(([rel]) => rel);
const strays = registrars.filter((rel) => !allowed(rel));
ok(`registrations live in ${registrars.length} allowed file(s): ${registrars.join(", ") || "(none)"}`,
  strays.length === 0,
  `tools registered outside the allowed set: ${strays.join(", ")}\n` +
  `      Put them in src/tools/<domain>.mjs — engine.mjs is the bottleneck three tracks share.`);

console.log("2. every env flag is declared");
const used = new Map(); // NAME -> [files]
for (const [rel, src] of sources)
  for (const m of src.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g))
    used.set(m[1], [...new Set([...(used.get(m[1]) ?? []), rel])]);

const undeclared = [...used.keys()].filter((n) => !FLAGS[n]);
ok(`${used.size} env var(s) read, all declared`, undeclared.length === 0,
  `undeclared: ${undeclared.map((n) => `${n} (${used.get(n).join(", ")})`).join("; ")}\n` +
  `      Add it to FLAGS with a kind and a why — a hidden switch is a switch nobody can review.`);

const stale = Object.keys(FLAGS).filter((n) => !used.has(n));
ok("no stale declarations", stale.length === 0,
  `declared but never read: ${stale.join(", ")} — delete the entry, or the registry stops being true.`);

const today = new Date().toISOString().slice(0, 10);
const construction = Object.entries(FLAGS).filter(([, f]) => f.kind === "construction");
const undated = construction.filter(([, f]) => !/^\d{4}-\d{2}-\d{2}$/.test(f.removeBy ?? ""));
ok(`${construction.length} construction flag(s), all dated`, undated.length === 0,
  `missing a valid removeBy (YYYY-MM-DD): ${undated.map(([n]) => n).join(", ")}`);

const overdue = construction.filter(([, f]) => f.removeBy && f.removeBy < today);
ok("no overdue construction flags", overdue.length === 0,
  `past removeBy: ${overdue.map(([n, f]) => `${n} (due ${f.removeBy})`).join(", ")}\n` +
  `      Either finish the work and delete the flag, or move the date deliberately — flag debt ` +
  `is the one cost trunk-based development actually charges.`);

const missingWhy = Object.entries(FLAGS).filter(([, f]) => !f.why);
ok("every flag says why it exists", missingWhy.length === 0,
  `no why: ${missingWhy.map(([n]) => n).join(", ")}`);

console.log("3. one answer to \"what does this app open on\"");
// contracts.mjs defaultCollectionFor carries that rule for the server (open_app, /view, the
// self-contained per-app resource). runtime-core childPreviewSnapshot carries it for the preview
// machines, because a browser app cannot import from src/. Two copies is what the codebase
// already ruled against — "a second copy of what does this app open on is a second answer waiting
// to disagree" (contracts.mjs) — so if there must be two, a machine has to hold them equal.
//
// This is not hypothetical: the preview side previously used `collection === appName`, which
// disagrees with the server for every app that declares a single collection under another name.
// SIX of the shipped manifests do (build-progress, project-tasks, and the multi-collection apps),
// and every one of them previewed empty.
{
  const { defaultCollectionFor } = await import("../src/contracts.mjs");
  const { childPreviewSnapshot } = await import("../src/runtime-core.mjs");
  const dir = join(ROOT, "components");
  const disagree = [];
  let checked = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".html")).sort()) {
    const name = f.slice(0, -5);
    const src = readFileSync(join(dir, f), "utf-8");
    const m = src.match(/<script[^>]*id=["']oma-manifest["'][^>]*>([\s\S]*?)<\/script>/);
    const manifest = m ? m[1].trim() : null;
    // Both sides get the SAME app, expressed the way each one receives it: the server reads
    // a stored row, the preview reads the parsed declaration handed back by app_html.
    let declaration = null;
    try { declaration = manifest ? JSON.parse(manifest) : null; } catch { declaration = null; }
    // "seed" is what the shipped set actually is; tierOf maps it to the local tier, which is the
    // gate BOTH sides put on honouring a manifest. Passing a bogus author here would silently test
    // the untrusted branch on both sides and agree for the wrong reason.
    const server = defaultCollectionFor({ name, manifest, author: "seed" });
    const preview = childPreviewSnapshot([], { app: name, declaration, tier: "local" }).collection;
    checked++;
    if (server !== preview) disagree.push(`${name}: server=${server} preview=${preview}`);
  }
  ok(`${checked} shipped app(s): the preview binding equals the server binding`,
    disagree.length === 0, disagree.join("\n      "));
}

// 3. THE LOCKFILE AGREES WITH package.json — ABOUT EVERYTHING IT MIRRORS, NOT JUST THE VERSION.
//
// This started as a version check, because v0.4.0 shipped with package.json at 0.4.0 and the
// lockfile still saying 0.3.2. `npm ci` does not care (it validates the dependency tree, not these
// fields, and installs cleanly), so nothing failed and nothing was reported — it was simply a lie
// in a file that ships.
//
// Then v0.4.1 added a `bin` and the lockfile did not follow, and the version check said nothing,
// because it was a check on ONE VALUE for a defect whose shape is "package.json moved and the
// lockfile did not". Same shape, second instance, and the guard written for the first was blind to
// the second. So it now governs the RELATIONSHIP: every key npm mirrors into the root entry has to
// agree, and the list of what npm mirrors has to stay honest.
//
// Three assertions, and the third is the one that keeps this from going stale again:
//   · shared keys agree           — catches a value drifting
//   · mirrored keys are PRESENT   — catches package.json growing a key the lockfile never got
//   · the mirror list is complete — catches npm mirroring something this check has never heard of,
//                                   which is how a check like this quietly stops covering things
//
// The fix for every one of them is the same command: `npm install --package-lock-only`.
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf-8"));
  const root = lock.packages?.[""] || {};
  // What npm copies from package.json into `packages[""]`. Measured against this repo's lockfile
  // rather than recited: name/version/license/engines/dependencies/devDependencies were already
  // there, `bin` is what v0.4.1 was missing, and the rest are the sibling fields npm treats the
  // same way. The completeness assertion below is what keeps this list from being a guess.
  const MIRRORED = ["name", "version", "license", "bin", "engines", "os", "cpu", "workspaces",
    "dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

  // `version` additionally lives at the TOP level of the lockfile. A bump that misses either is
  // the same defect, so it is checked separately from the root entry.
  ok(`package-lock.json's top-level version says ${pkg.version}, like package.json`,
    lock.version === pkg.version,
    `package.json=${pkg.version} lock.version=${lock.version} — run \`npm install --package-lock-only\``);

  const disagree = MIRRORED.filter((k) => k in pkg && k in root && JSON.stringify(pkg[k]) !== JSON.stringify(root[k]));
  ok("every key the lockfile mirrors carries the same value as package.json",
    disagree.length === 0,
    disagree.map((k) => `${k}: package.json=${JSON.stringify(pkg[k])} lock=${JSON.stringify(root[k])}`).join("\n      ")
      + ` — run \`npm install --package-lock-only\``);

  const missing = MIRRORED.filter((k) => k in pkg && !(k in root));
  ok(`the lockfile carries every mirrored key package.json declares (${MIRRORED.filter((k) => k in pkg).length} of them)`,
    missing.length === 0,
    `${missing.join(", ")} declared in package.json, absent from the lockfile's root entry`
      + ` — run \`npm install --package-lock-only\``);

  // If npm starts mirroring a field this list has never heard of, that field would be compared by
  // nobody. Failing here is the cheap version of finding out; the fix is one word in MIRRORED.
  const unlisted = Object.keys(root).filter((k) => k in pkg && !MIRRORED.includes(k));
  ok("…and nothing is mirrored that this check does not know to compare",
    unlisted.length === 0,
    `${unlisted.join(", ")} appears in both files but is not in MIRRORED — add it there`);
}

// ── a `bin` we ship under a name we do not own on npm ─────────────────────────────────────────
// Declaring `bin: {"open-mcp-apps": …}` makes `npx open-mcp-apps` LOOK like a way to run this
// project. It is not: that name on the npm registry belongs to an unrelated package, so the npx
// form fetches and executes somebody else's code. README carries that warning where users read it.
//
// This pins the COUPLING rather than blacklisting a string — a blacklist would flag the sentences
// that say the form does not work, which is the opposite of the harm. The rule is: as long as we
// ship a bin whose name is not ours, the disclosure has to exist. Whoever gets the name on npm
// deletes both together, deliberately, instead of one of them by accident.
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  const binNames = Object.keys(pkg.bin || {});
  const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
  const discloses = /npm registry is \*\*not this project\*\*|not this project/.test(readme)
    && /A note on npm/i.test(readme);
  ok("a bin named after the package still comes with README's note that the npm name is not ours",
    !binNames.includes(pkg.name) || discloses,
    `bin=${JSON.stringify(binNames)} pkg=${pkg.name} readme discloses=${discloses}`);
}

// ── the node path the installer writes into every host config ─────────────────────────────────
// better-sqlite3 is a native addon, so the registered node must BE the binary it was built for —
// which used to mean pinning process.execPath verbatim. Under Homebrew that is a versioned cellar
// path (…/Cellar/node/26.5.0/bin/node) which disappears on the next `brew upgrade node`, and all
// three host entries stop starting at once with nothing on screen to explain why (live-test
// 2026-07-28). The rule now: prefer a stable launcher, but ONLY when it resolves to the same
// binary. The criterion is identity — not that the path looks nicer.
//
// The logic is RUN here, not described here: importing install.mjs would perform an install, so
// the resolver is lifted out of the real source and evaluated against a fake realpath. If it ever
// stops being extractable, the first assertion says so rather than the rest passing vacuously.
{
  const src = readFileSync(join(ROOT, "install.mjs"), "utf-8");
  const m = /const NODE = \(\(\) => \{[\s\S]*?\n\}\)\(\);/.exec(src);
  ok("the installer's node resolver is extractable from the real source", !!m,
    "the regex no longer matches install.mjs — the assertions below prove nothing until it does");
  if (m) {
    const pick = new Function("realpathSync", "return " + m[0].replace(/^const NODE = /, "").replace(/;$/, ""));
    const SAME = "/real/node/binary";
    ok("prefers a stable launcher when it resolves to the SAME binary",
      pick((q) => (q === "/opt/homebrew/bin/node" || q === process.execPath) ? SAME : "/elsewhere/node")
        === "/opt/homebrew/bin/node");
    ok("never pins a launcher that resolves to a DIFFERENT binary — identity, not aesthetics",
      pick((q) => q === process.execPath ? SAME : "/a/different/node") === process.execPath);
    ok("falls back to execPath when no stable launcher is on this machine",
      pick((q) => { if (q === process.execPath) return SAME; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); })
        === process.execPath);
  }
}

// ── destructive actions in shipped apps must honour confirm_delete ────────────────────────────
// `confirm_delete` is a SHARED preference: the user sets it once and every app obeys. Most did.
// settings.html did not — its "Reset all" deleted an entire section of stored values on ONE click
// and flashed "Saved", while the delete-app button 600 lines down the SAME FILE asked twice. The
// button's own title said "Delete every stored value in this section", so it knew what it was.
//
// This walks every shipped app, finds the calls that destroy data, and requires each to sit behind
// the pref — or to be listed below WITH A REASON. Entries are keyed by a snippet of the line, not
// a line number: when the excused code changes the entry goes stale and this goes red, instead of
// silently excusing whatever moved into that position.
{
  const DESTRUCTIVE = /oma\.deleteItem\s*\(|["']data_delete_item["']|["']delete_app["']|["']archive_app["']|oma\.files\s*\.\s*delete\s*\(/;
  const GATE = /confirmDeleteOn\s*\(\)|oma\.pref\s*\(\s*["']confirm_delete["']/;
  const WINDOW = 20;                     // lines above the call the gate may live in
  const UNGATED_BY_DESIGN = [
    ["companion.html", 'oma.callTool("data_delete_item"',
      "the gate is at the SOLE caller — deleteKnowledge() is called once, from a handler that arms first. A line window cannot see across a function boundary; this is the limit of the detector, not a hole in the app"],
    ["dashboard.html", "one unpin collapses them all",
      "unpin is a TOGGLE: the inverse is the same button, one click later. A confirm dance here would cost more than the mistake it prevents"],
    ["settings.html", "await oma.deleteItem(id); flashSaved();",
      "one preference back to its documented default, with the value on screen and re-settable in a keystroke. Confirming every pref reset trains people to click through the confirmation that matters"],
    ["settings.html", "dashboard_poll_seconds",
      "a MIGRATION, not a user action: the value is copied to its new home two lines above. Nothing is lost and nobody asked for it"],
  ];

  const sites = [];
  for (const f of readdirSync(join(ROOT, "components")).filter((x) => x.endsWith(".html"))) {
    const lines = readFileSync(join(ROOT, "components", f), "utf-8").split("\n");
    lines.forEach((ln, i) => {
      if (!DESTRUCTIVE.test(ln)) return;
      // Comments STRIPPED first. Found the hard way: the fix for "Reset all" carries a comment
      // explaining that it calls confirmDeleteOn(), and that comment alone satisfied the pattern —
      // deleting the entire gate below it left this green. A rule that a sentence can satisfy is
      // not a rule.
      const win = lines.slice(Math.max(0, i - WINDOW), i).join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
      const gated = GATE.test(win);
      sites.push({ file: f, line: i + 1, text: ln, gated });
    });
  }
  const gated = sites.filter((x) => x.gated);
  ok(`detector is non-vacuous: ${sites.length} destructive call site(s) across the shipped apps, ${gated.length} of them gated`,
    sites.length > 10 && gated.length > 5,
    "the DESTRUCTIVE/GATE patterns stopped matching — everything below is vacuous until they do");

  const excused = (s) => UNGATED_BY_DESIGN.find(([f, snip]) => f === s.file && s.text.includes(snip));
  const unexplained = sites.filter((s) => !s.gated && !excused(s));
  ok("every destructive call is behind confirm_delete, or listed with a reason why not",
    unexplained.length === 0,
    unexplained.map((s) => `${s.file}:${s.line}  ${s.text.trim().slice(0, 80)}`).join("\n      "));

  const stale = UNGATED_BY_DESIGN.filter(([f, snip]) =>
    !sites.some((s) => !s.gated && s.file === f && s.text.includes(snip)));
  ok("no stale exemptions — every entry still excuses a real ungated call",
    stale.length === 0,
    stale.map(([f, snip]) => `${f}: "${snip}" no longer matches an ungated call — gated now, or gone`).join("\n      "));
}

console.log(`\ninvariants: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
