// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/doc-facts.mjs — six rules that stop documentation from drifting away from the code.
//
// Sibling of invariants.mjs, and it exists for the same stated reason: "A rule living in a doc
// gets obeyed for a week; a rule living here gets obeyed." Every convergence pass this project
// has run has been undone within days, because the pass fixed VALUES and nothing enforced them.
//
//  1. DERIVED      — a number written in a doc must be recomputable from the source it describes.
//  2. NO-DANGLING  — a path written in a doc must resolve, or be DECLARED foreign.
//  3. EVIDENCE     — a ledger row that claims to be evidenced must carry the evidence.
//  4. MULTI-HOME   — one fact living in several docs must read the same in all of them.
//  5. DEAD-NAME    — an ACTIVE doc must not name an identifier that no longer exists.
//  6. ACTIVE-INDEX — every doc is either in the active index, or under the archive.
//
// 5 and 6 answer a sharper threat than 1-4. The first four assume the reader is us. The last two
// assume the reader is an agent with no context that greps, finds one line, and acts on it —
// it sees a PATH, not the banner at the top of the file. So the split between "current" and
// "history" has to live in the path, and a name that would make its call fail must not be in a
// current file at all.
//
// REPO-AGNOSTIC. The rules are here; everything repo-specific is in <root>/docs/doc-facts.config.json.
// Another repo adopts the same principle by writing its own config — one principle, not two.
//   node test/doc-facts.mjs                     this repo, static checks (what CI runs)
//   node test/doc-facts.mjs --root=../other     another checkout, same rules
//   node test/doc-facts.mjs --deep              also RUN the test files whose counts the docs quote

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, basename, relative } from "node:path";

const SELF_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootArg = process.argv.find((a) => a.startsWith("--root="));
const ROOT = rootArg ? rootArg.slice(7) : (process.env.DOC_FACTS_ROOT || SELF_ROOT);
const DEEP = process.argv.includes("--deep");

const read = (p) => readFileSync(join(ROOT, p), "utf-8");
const has = (p) => existsSync(join(ROOT, p));
const rx = (s) => new RegExp(s);

const CONFIG_PATH = "docs/doc-facts.config.json";
// A tree with no `docs/` at all has no documentation to keep honest, and this runner ships into
// exactly such a tree: the public snapshot carries `test/` but never `docs/` (see the ALLOWLIST in
// scripts/publish.mjs), so on the public repo this file used to exit 1 on every push — `npm test`
// is a `&&` chain and doc-facts sits second, which reds the whole run and stops the other 21 suites
// from ever executing there. That is the same class of defect the ALLOWLIST already names for
// index.mjs ("a snapshot without it ships a test suite that cannot start, and reds CI on the first
// push"); this is its documentation-side twin, and the fix belongs here rather than in the snapshot
// because shipping a `docs/` we deliberately withhold would be the wrong repair.
//
// The distinction that keeps the guard intact: NO `docs/` means nothing to check, so skip and pass.
// A `docs/` that EXISTS but has lost its config is the real defect this branch was written for —
// a repo with documentation and no rules describing it — and that still fails loudly. So the
// public snapshot goes green without the internal tree gaining a way to silently disable the suite.
if (!has(CONFIG_PATH)) {
  if (!has("docs")) {
    console.log(`doc-facts: no docs/ under ${ROOT} — nothing to check, skipped.`);
    console.log(`  (This tree carries the runner but not the documentation it checks; the public`);
    console.log(`   snapshot is built that way on purpose. A tree WITH docs/ and no config fails.)`);
    process.exit(0);
  }
  console.error(`doc-facts: no ${CONFIG_PATH} under ${ROOT}\n` +
    `  This runner is repo-agnostic — it needs a config describing THIS repo's docs.\n` +
    `  Copy the engine's as a starting point and edit it.`);
  process.exit(1);
}
const CFG = JSON.parse(read(CONFIG_PATH));

// How much is "enough to be checking something". These are facts about the SIZE of a repo, not
// rules — the engine has 140+ paths and 7 multi-home facts, a smaller repo legitimately has fewer.
// They are thresholds and not booleans because the failure they guard against is a pattern that
// silently stops matching: without a floor, a broken scan reports zero problems and passes.
// Set a floor you would NOTICE dropping below, and raise it as the repo grows.
const MIN = { paths: 50, multiHome: 5, indexBytes: 200, ...(CFG.minimums || {}) };

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));
const empty = (v) => v == null || String(v).trim() === "" || String(v).trim() === "—";

// ---------------------------------------------------------------------------- 0. CONFIG INTACT
//
// A key that goes missing must not quietly take its whole class with it. `mustMention` was dropped
// from the config by a merge; the loop reads `CFG.mustMention || []`, so it iterated zero times,
// this file went from 38 assertions to 30 with ZERO failures, and v0.4.2 shipped with four checks
// switched off. Nothing was broken — only unwatched, which is why nobody could have noticed.
//
// The rule is "the KEY must exist", not "the key must have content": `[]` is a legitimate way to
// say "this repo does not configure that class", and the class then says so out loud. An ABSENT
// key says nothing at all, and that is the difference between a decision and an accident.
//
// `ledger` is the one legal omission, because its absence is ANNOUNCED — section 3 prints
// "(no ledger configured for this repo — skipped)". That is the whole test for whether a key may
// be optional: does anyone find out?
const REQUIRED_KEYS = ["docsDir", "archiveDir", "activeIndex", "extraDocs",
  "derived", "mustMention", "deepCounts", "multiHome", "deadNames", "foreign"];
console.log("0. CONFIG INTACT — a dropped key must not silently disable its class");
{
  const missing = REQUIRED_KEYS.filter((k) => !(k in CFG));
  ok(`config declares every class the runner knows about (${REQUIRED_KEYS.length})`,
    missing.length === 0,
    `missing: ${missing.join(", ")}\n` +
    `      An absent key disables that class SILENTLY — a merge probably dropped it.\n` +
    `      If the class genuinely does not apply here, declare it empty ([] / {}) rather than removing it.`);
}

/** Every markdown file under docsDir, plus the named extras. Split into active and archived. */
function docFiles() {
  const all = [];
  const walk = (dir) => {
    if (!has(dir)) return;
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const p = dir + "/" + e.name;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) all.push(p);
    }
  };
  walk(CFG.docsDir);
  const archived = all.filter((p) => p.startsWith(CFG.archiveDir + "/"));
  const active = all.filter((p) => !p.startsWith(CFG.archiveDir + "/"));
  for (const f of CFG.extraDocs || []) if (has(f)) active.push(f);
  return { active, archived, all };
}
const { active: ACTIVE, archived: ARCHIVED } = docFiles();

// --------------------------------------------------------------------------------- helpers
/** Docs write big numbers the way people read them — `29,022`, not `29022`. The comparison in
 *  DERIVED is on strings, so the computed side has to be spelled the doc's way or a pin fails on
 *  punctuation alone. Regex rather than toLocaleString: no ICU build to depend on. */
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Compute a derived value from source. Kinds are deliberately few and declarative — a config
 *  that can express arbitrary code is a config nobody can audit. */
async function compute(c) {
  if (c.kind === "jsonField") return JSON.parse(read(c.file))[c.field];
  if (c.kind === "countMatches") {
    const outer = read(c.file).match(rx(c.outer));
    return outer ? [...outer[1].matchAll(new RegExp(c.each, "g"))].length : null;
  }
  if (c.kind === "countFiles") {
    let names = readdirSync(join(ROOT, c.dir)).filter((f) => rx(c.match).test(f));
    if (c.excludeNamesFrom) {
      const e = c.excludeNamesFrom;
      const outer = read(e.file).match(rx(e.pattern));
      const excl = outer ? [...outer[1].matchAll(new RegExp(e.each, "g"))].map((m) => m[1] + (e.suffix || "")) : [];
      if (!excl.length) return null;                    // refuse to "succeed" on a parse that found nothing
      names = names.filter((f) => !excl.includes(f));
    }
    return names.length;
  }
  // The one kind that cannot be answered by reading bytes off disk: the SIZE of a string the
  // source BUILDS. `GUIDE` is a template literal, so its file bytes and its runtime bytes differ
  // by every escape written into it — measuring the file would pin a number nobody quotes. So
  // import the module and measure the VALUE. That is reading a fact out of source, not running a
  // suite, which is why it belongs in the always-on pass and not under --deep. A throw comes back
  // as null so the guard below reports it as one loud failed assertion rather than taking the
  // whole runner down with a stack trace.
  if (c.kind === "exportBytes") {
    try {
      const mod = await import(pathToFileURL(join(ROOT, c.file)).href);
      const v = mod[c.export];
      return typeof v === "string" ? Buffer.byteLength(v, "utf8") : null;
    } catch { return null; }
  }
  throw new Error("unknown compute kind: " + c.kind);
}

// ------------------------------------------------------------------------------ 1. DERIVED
console.log("1. DERIVED — a number in a doc is recomputable from its source");
for (const d of CFG.derived) {
  const value = await compute(d.compute);
  // A derivation that comes back empty is a broken derivation, not a value of zero. Without this
  // the checks below would compare every doc against `null` and pass by never matching.
  if (value == null || value === 0) { ok(`${d.what}: derivation produced a value`, false, `computed ${value} — the pattern probably stopped matching its source`); continue; }
  // `format` spells the computed value the way the doc writes it. It is presentation only — the
  // pin is still on the number, and an entry without it compares exactly as it always did.
  const shown = d.format === "thousands" ? thousands(value) : String(value);
  for (const [file, pattern] of d.where) {
    if (!has(file)) continue;
    const m = read(file).match(rx(pattern));
    ok(`${file}: ${d.what} says ${m ? m[1] : "—"}, source says ${shown}`,
      m != null && String(m[1]) === shown,
      m == null ? `no match for /${pattern}/ — the doc was reworded, so this check silently stopped checking` : `doc says ${m[1]}, computed ${shown}`);
  }
}

// --------------------------------------------------------------- 1c. DERIVED, set membership
//
// A count is a weak pin. `runtime-contract.mjs` pins the API NAMES and README says the contract
// therefore "can't drift silently" — but that test cannot notice a whole missing chapter, and for
// a while RUNTIME.md was missing every kit class and every design token while the suite stayed
// green. The belt was real; it just wasn't around the part that fell.
//
// So: extract a set of identifiers from source, and require the doc to mention each one. This is
// what makes the README sentence true rather than narrower.
for (const m of CFG.mustMention || []) {
  let src = read(m.from.file);
  // `outer` narrows to one construct first — an array literal, an object, a table — so `each`
  // does not sweep the whole file and collect names that were never the subject.
  if (m.from.outer) { const o = src.match(rx(m.from.outer)); src = o ? o[1] : ""; }
  const names = [...new Set([...src.matchAll(new RegExp(m.from.each, "g"))].map((x) => x[1]))];
  const doc = read(m.inDoc);
  ok(`${m.what}: ${names.length} name(s) extracted from ${m.from.file}`, names.length >= (m.min || 1),
    `found ${names.length} — the extraction pattern probably broke, and then the check below proves nothing`);
  const missing = names.filter((n) => !doc.includes(n));
  ok(`${m.inDoc} mentions every ${m.what} (${names.length - missing.length}/${names.length})`,
    missing.length === 0, missing.length ? `missing: ${missing.join(" ")}` : "");
}

// ------------------------------------------------------------------- 1b. DERIVED, under --deep
if (DEEP) {
  console.log("\n1b. DERIVED (--deep) — quoted assertion counts, by actually running the files");
  for (const [file, where] of CFG.deepCounts) {
    let actual = null;
    try {
      const out = execFileSync(process.execPath, [join(ROOT, file)], { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      const m = out.match(/(\d+) passed, \d+ failed\s*$/m);
      actual = m ? Number(m[1]) : null;
    } catch { actual = null; }
    if (actual == null) { ok(`${file} produced a countable result`, false, "the run failed or printed no tally"); continue; }
    for (const [doc, pattern] of where) {
      if (!has(doc)) continue;
      const m = read(doc).match(rx(pattern));
      ok(`${doc}: ${basename(file)} quoted as ${m ? m[1] : "—"}, actually ${actual}`,
        m != null && Number(m[1]) === actual, m == null ? `no match for /${pattern}/` : `doc says ${m[1]}, ran ${actual}`);
    }
  }
} else {
  console.log("\n1b. DERIVED (--deep) — SKIPPED (run with --deep to check quoted assertion counts)");
}

// -------------------------------------------------------------------------- 2. NO-DANGLING
console.log("\n2. NO-DANGLING — a path in a doc resolves, or is declared foreign");
const FOREIGN_SEEN = new Set();
{
  // Extensions guarded by a non-word lookahead: without it `.ts` matches inside `.tsx` and `.js`
  // inside `.json`, and the checker reports a missing file whose name it invented. (It did.)
  const EXT = "(?:mjs|cjs|jsx|tsx|json|yaml|yml|toml|html|css|md|ts|js)";
  const SPAN_RE = /`([^`\n]+)`/g;
  const PATH_RE = new RegExp("^([a-zA-Z0-9_][a-zA-Z0-9_./-]*\\." + EXT + ")(?![a-zA-Z0-9])");
  const pathsIn = (text) => {
    const out = [];
    for (const s of text.matchAll(SPAN_RE)) {
      const span = s[1];
      // `existing.html === html` is a property read on a variable, not a filename. A path never
      // contains a space or an operator; an expression always does.
      if (/[\s=(){}<>|&;]/.test(span.replace(/:\d+(-\d+)?(,\d+)*$/, ""))) continue;
      const m = span.match(PATH_RE);
      if (m) out.push(m[1]);
    }
    return out;
  };

  const byBasename = new Map();
  const index = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      // `.claude` joins them because the harness checks parallel agents out into
      // `.claude/worktrees/<id>/` — a FULL copy of the repo, so every basename in it becomes a
      // second (and third) candidate and the shorthand `known-defects.md` stops resolving. Nothing
      // under `.claude` is tracked, and nothing under it is a doc this project publishes; indexing
      // it made the check measure the harness instead of the repo.
      if (["node_modules", ".git", "dist", ".claude"].includes(e.name)) continue;
      const p = dir === "." ? e.name : dir + "/" + e.name;
      if (e.isDirectory()) index(p);
      else { if (!byBasename.has(e.name)) byBasename.set(e.name, []); byBasename.get(e.name).push(p); }
    }
  };
  index(".");

  const foreignOf = (p) => CFG.foreign.find((f) => (f.prefix && p.startsWith(f.prefix)) || f.exact === p);
  const seen = new Map();
  for (const doc of ACTIVE)
    for (const p of pathsIn(read(doc))) {
      if (!seen.has(p)) seen.set(p, new Set());
      seen.get(p).add(doc);
    }

  ok(`scan is non-vacuous: ${seen.size} distinct path(s) across ${ACTIVE.length} active doc(s)`,
    seen.size >= MIN.paths, "suspiciously few paths — the pattern probably stopped matching, which would make every check below vacuously pass");

  const dangling = [];
  for (const [p, where] of seen) {
    const f = foreignOf(p);
    if (f) { FOREIGN_SEEN.add(f); continue; }
    if (has(p)) continue;
    // The house idiom writes `contracts.mjs`, not `src/contracts.mjs`. That is fine BECAUSE it is
    // unambiguous — two files with that basename and the shorthand stops being a reference.
    const hits = p.includes("/") ? [] : (byBasename.get(basename(p)) || []);
    if (hits.length === 1) continue;
    dangling.push(`${p}  ← ${[...where].map((x) => basename(x)).join(", ")}` + (hits.length > 1 ? `  (ambiguous: ${hits.join(", ")})` : ""));
  }
  ok(`every path resolves or is declared foreign`, dangling.length === 0,
    dangling.length ? dangling.join("\n      ") + "\n      → fix the path, or add it to config `foreign` with a reason" : "");

  // Same carve-out as the dead-name sweep, for the same reason and it bit in the same way: an
  // exemption whose ONLY citation lives in a working-tree-held file reads "unused" in a checkout
  // that does not have that file's real contents. `heldBy` names the file, so the claim stays
  // auditable rather than becoming a blanket "skip this one".
  const held = CFG.deadNames?.workingTreeHeld || {};
  const unused = CFG.foreign
    .filter((f) => !FOREIGN_SEEN.has(f))
    .filter((f) => !(f.heldBy && f.heldBy in held))
    .map((f) => f.prefix || f.exact);
  ok(`no stale foreign exemptions`, unused.length === 0,
    unused.length ? `never matched, so nothing needs them: ${unused.join(", ")}` : "");
}

// ------------------------------------------------------------------------------ 3. EVIDENCE
console.log("\n3. EVIDENCE — a ledger row that claims evidence carries it");
if (CFG.ledger && has(CFG.ledger.file)) {
  const L = JSON.parse(read(CFG.ledger.file));
  const rowIds = new Set(L.rows.map((r) => r.id));
  const sgIds = new Set(L.stopgaps.map((s) => s.id));
  const PROV = CFG.ledger.provenance;
  const GRAND = new Set(CFG.ledger.retestWithoutMethodGrandfathered || []);

  ok(`ledger is non-vacuous: ${L.rows.length} rows, ${L.stopgaps.length} stopgaps, ${L.experiences.length} experiences`,
    L.rows.length > 0 && L.stopgaps.length > 0 && L.experiences.length > 0);

  const noEvidence = L.rows.filter((r) => r.status === "assertable" && empty(r.evidence)).map((r) => r.id);
  ok(`every assertable row carries evidence`, noEvidence.length === 0, noEvidence.join(", "));

  // Provenance vocabulary, declared the way invariants.mjs declares env flags: an undeclared value
  // is a hidden claim. The distinction these labels carry — "we ran it" vs "someone else did and
  // we transcribed it" — is the one that cost the most this week.
  const badProv = L.rows.filter((r) => !PROV[r.verified_by]).map((r) => `${r.id}=${r.verified_by ?? "(none)"}`);
  ok(`every row declares a known provenance (${Object.keys(PROV).length} in the vocabulary)`,
    badProv.length === 0, badProv.length ? badProv.join(", ") + " — add it to config with what it means" : "");

  const newHoles = L.rows.filter((r) => r.status === "needs_retest" && empty(r.how_to_check) && !GRAND.has(r.id)).map((r) => r.id);
  ok(`every NEW needs_retest row says how to retest (${GRAND.size} grandfathered)`, newHoles.length === 0,
    newHoles.length ? newHoles.join(", ") + " — a retest with no method is a TODO that never closes" : "");
  const goneStale = [...GRAND].filter((id) => !L.rows.some((r) => r.id === id && r.status === "needs_retest" && empty(r.how_to_check)));
  ok(`no stale grandfather entries`, goneStale.length === 0,
    goneStale.length ? `no longer needed, delete from config: ${goneStale.join(", ")}` : "");

  const sgHoles = L.stopgaps.filter((s) => empty(s.removable_when) || empty(s.how_to_check)).map((s) => s.id);
  ok(`every stopgap says what removes it and how to check`, sgHoles.length === 0, sgHoles.join(", "));
  const sgNoHome = L.stopgaps.filter((s) => !("matrix_row" in s)).map((s) => s.id);
  ok(`every stopgap declares a matrix_row (or an explicit null)`, sgNoHome.length === 0,
    sgNoHome.length ? sgNoHome.join(", ") + " — omitting the field is how a fact gets a second home" : "");
  const expHoles = L.experiences.filter((e) => empty(e.why_not_automatable)).map((e) => e.id);
  ok(`every experience says why it is not automatable`, expHoles.length === 0,
    expHoles.length ? expHoles.join(", ") + " — if it cannot say, it belongs in a test file" : "");

  // These ids looked perfectly well-formed on the day four of them pointed at rows that had been
  // merged away: right shape, right naming style, pointing at yesterday.
  const dangling = [];
  for (const e of L.experiences) {
    for (const s of e.depends_on?.spec || []) if (!rowIds.has(s)) dangling.push(`${e.id}.depends_on.spec → ${s}`);
    for (const s of e.depends_on?.stopgaps || []) if (!sgIds.has(s)) dangling.push(`${e.id}.depends_on.stopgaps → ${s}`);
  }
  for (const s of L.stopgaps) if (s.matrix_row != null && !rowIds.has(s.matrix_row)) dangling.push(`${s.id}.matrix_row → ${s.matrix_row}`);
  // `blocked_by` takes one id or a list of them, and NOTHING else. It carried prose once —
  // "SG-17（我们迁移的闸门）+ 宿主换挡…" — an id, an explanation, and a second non-id gate in one
  // string. That is not a stricter-parsing problem: a field a machine can dereference and a
  // sentence a human needs are two different things, and merging them loses both. The sentence
  // lives in `blocked_by_note`.
  for (const r of L.rows)
    for (const b of r.blocked_by == null ? [] : [].concat(r.blocked_by))
      if (!sgIds.has(b)) dangling.push(`${r.id}.blocked_by → ${b}` +
        (/[\s（(]/.test(b) ? "  (prose in a reference field — put the sentence in blocked_by_note)" : ""));
  ok(`every cross-reference points at an id that exists`, dangling.length === 0, dangling.join("\n      "));
} else {
  console.log("  (no ledger configured for this repo — skipped)");
}

// ---------------------------------------------------------------------------- 4. MULTI-HOME
console.log("\n4. MULTI-HOME — one fact, several docs, one reading");
{
  let checked = 0;
  for (const f of CFG.multiHome) {
    const readings = f.homes.filter(([file]) => has(file)).map(([file, pattern]) => [file, (read(file).match(rx(pattern)) || [])[1] ?? null]);
    const found = readings.filter(([, v]) => v != null);
    // A pattern that stops matching is the silent failure this whole file exists to prevent: the
    // check keeps passing while checking nothing. Fewer than two readings is a FAILURE.
    if (found.length < 2) {
      ok(`${f.what}: found in ≥2 homes`, false,
        `only ${found.length} matched (${readings.map(([fl, v]) => `${basename(fl)}=${v ?? "no match"}`).join(", ")})` +
        ` — either a doc was reworded (fix the pattern) or the fact lost a home (fix the doc)`);
      continue;
    }
    checked++;
    const vals = [...new Set(found.map(([, v]) => v))];
    ok(`${f.what}: ${found.length} homes agree on ${vals[0]}`, vals.length === 1,
      found.map(([fl, v]) => `${basename(fl)} says ${v}`).join(" / "));
  }
  if (!CFG.multiHome.length) {
    // Not configured is a different state from "configured and passing". Saying so out loud keeps
    // a repo from believing it has cover it never set up — the exact self-deception this file exists
    // to prevent, so it must not be quietly skipped either.
    console.log("  — MULTI-HOME not configured for this repo (multiHome: []) — nothing compared");
  } else {
    ok(`multi-home scan is non-vacuous: ${checked} fact(s) actually compared`, checked >= MIN.multiHome, "too few facts had two live homes — the patterns have rotted");
  }
}

// ----------------------------------------------------------------------------- 5. DEAD-NAME
//
// The sharpest way a stale doc does damage. An agent greps `docs/`, finds `save_component`, calls
// it, and the call fails — it never saw the banner at the top of the file, because it was reading
// one line of grep output. Archived docs are exempt on purpose: history keeps the old words, and
// rewriting it would manufacture the impression that we always called it `app`.
//
// 🔴 THE GENERAL RULE, and it outranks tidiness: A VERBATIM RECORD IS NEVER RENAMED.
//
// Measurement logs, host transcripts, quoted issues, release histories, rename mapping tables —
// anything whose value IS that it says what was actually said. On the day it was written the tool
// really was called `component_html`. Rewriting it does not make the record current; it makes the
// record FALSE, and it destroys the one property the record was kept for. A stale name in a
// how-to costs somebody a failed call; a rewritten measurement log costs us the ability to
// trust our own evidence — which is worse, and unrecoverable.
//
// This is a CATEGORY, not a list of special cases. When a file trips this check, the first
// question is not "how do I rename it" but "is this file a record or an instruction?" Records get
// an exemption with the reason `verbatim record`. Instructions get renamed.
//
// The distinction can run INSIDE one file — KNOWN-ISSUES.md is the worked example: its issue
// titles use dead names to describe a live problem (a real bug, rename it) while :115-116 is a
// pasted host transcript (evidence, never touch it). A file like that needs a human to split it,
// which is why the exemption reasons say so instead of quietly covering the whole file.
console.log("\n5. DEAD-NAME — an active doc must not name an identifier that no longer exists");
if (CFG.deadNames) {
  const map = CFG.deadNames.names;
  const names = Object.keys(map);

  // Prove the detector works before trusting a zero: an empty result must mean "clean", never
  // "the pattern broke". The archive is full of these names by design, so it is the fixture.
  const archiveHits = ARCHIVED.reduce((n, d) => n + names.reduce((k, nm) => k + (read(d).split(nm).length - 1), 0), 0);
  // Proving the detector works needs a fixture that CONTAINS the names. The archive is that fixture
  // here. A repo whose archive predates the rename has none, and must name its own fixture rather
  // than trust a zero — `deadNames.selfTestFile`, a path known to contain at least one.
  const fixture = CFG.deadNames.selfTestFile;
  const fixtureHits = fixture && has(fixture)
    ? names.reduce((k, nm) => k + (read(fixture).split(nm).length - 1), 0) : 0;
  ok(`detector is non-vacuous: ${names.length} dead name(s), ${archiveHits} in archive` + (fixture ? `, ${fixtureHits} in ${fixture}` : ""),
    names.length > 0 && (archiveHits > 0 || fixtureHits > 0),
    "found none anywhere — the detector is broken, so a clean active scan would prove nothing. Point deadNames.selfTestFile at a file that really contains one.");

  // A file whose job IS to speak the old names (a release history, a recorded transcript) is
  // exempt BY NAME with a written reason. Blanket-skipping a directory would hide the real bugs
  // among the legitimate mentions, which is the distinction this class exists to make.
  const EXEMPT = CFG.deadNames.exemptDocs || {};
  const offenders = [], exemptHits = [];
  for (const doc of ACTIVE) {
    const text = read(doc);
    const hits = names.map((nm) => [nm, text.split(nm).length - 1]).filter(([, n]) => n > 0);
    if (!hits.length) continue;
    const line = `${doc}: ${hits.map(([nm, n]) => `${nm}×${n} → ${map[nm]}`).join(", ")}`;
    (doc in EXEMPT ? exemptHits : offenders).push(line);
  }
  ok(`no dead names in ${ACTIVE.length - Object.keys(EXEMPT).length} unexempted active doc(s)`, offenders.length === 0,
    offenders.length ? offenders.join("\n      ") +
      `\n      → rename to the current seat (authority: ${CFG.deadNames.authority}), or move the doc under ${CFG.archiveDir}/ if it is history` : "");

  // An exemption nobody needs is a lie about what exists — same treatment invariants.mjs gives a
  // stale env flag. This is what will tell the next person that README's entry can go.
  //
  // …with one carve-out, and it is a lesson rather than a convenience: this rule assumed every
  // checkout sees the same bytes. That is false for a file somebody HOLDS UNCOMMITTED. The
  // live-test log reads as 784 bytes in git and 13 KB on its author's disk, so the same exemption
  // is "in use" in his checkout and "stale" in mine — and deleting it here would turn his run red.
  // Files named in workingTreeHeld are exempt from the staleness sweep for exactly that reason.
  const HELD = CFG.deadNames.workingTreeHeld || {};
  const unusedExempt = Object.keys(EXEMPT)
    .filter((d) => !(d in HELD))
    .filter((d) => !exemptHits.some((l) => l.startsWith(d + ":")));
  ok(`no stale dead-name exemptions (${Object.keys(EXEMPT).length} declared, ${exemptHits.length} in use, ${Object.keys(HELD).length} working-tree-held)`,
    unusedExempt.length === 0, unusedExempt.length ? `nothing needs them any more — delete from config: ${unusedExempt.join(", ")}` : "");
}

// -------------------------------------------------------------------------- 6. ACTIVE-INDEX
//
// The rule that makes a clean state non-reversible, and the reason it is worth more than the
// cleanup that preceded it. A new doc dropped into docs/ is unlabelled by default — nobody can
// tell from a grep hit whether it is current. Forcing every file to be either indexed or archived
// means the labelling cannot be forgotten: it fails the build.
console.log("\n6. ACTIVE-INDEX — every doc is indexed as current, or filed as history");
if (CFG.activeIndex) {
  if (!has(CFG.activeIndex)) {
    ok(`the active index exists (${CFG.activeIndex})`, false, "no index — every active doc is unlabelled");
  } else {
    const index = read(CFG.activeIndex);
    const exempt = new Set([CFG.activeIndex, CFG.archiveDir + "/README.md"]);
    const listed = (p) => index.includes(p) || index.includes(basename(p));

    ok(`index is non-vacuous: ${ACTIVE.length} active doc(s), ${ARCHIVED.length} archived`,
      ACTIVE.length > 0 && index.length >= MIN.indexBytes, "the index is empty or tiny — it would 'cover' nothing");

    const unlisted = ACTIVE.filter((p) => p.startsWith(CFG.docsDir + "/") && !exempt.has(p) && !listed(p));
    ok(`every active doc is in the index`, unlisted.length === 0,
      unlisted.length ? unlisted.join("\n      ") +
        `\n      → add it to ${CFG.activeIndex} with one line saying what it is, or move it under ${CFG.archiveDir}/` : "");

    // The reverse: an index entry for a file that no longer exists sends a reader to nothing.
    const ghosts = [...index.matchAll(new RegExp("\\(?(" + CFG.docsDir + "/[A-Za-z0-9._/-]+\\.md)\\)?", "g"))]
      .map((m) => m[1]).filter((p, i, a) => a.indexOf(p) === i).filter((p) => !has(p));
    ok(`the index has no ghost entries`, ghosts.length === 0, ghosts.join(", "));
  }
}

console.log(`\ndoc-facts: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
