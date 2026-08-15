// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/host-matrix-smoke.mjs — the guard on docs/host-matrix.json.
//
// Why a ledger of PROSE gets a machine guard
// ------------------------------------------
// host-matrix.json is the three-axis book of record: what the spec asks (`rows`), what we
// papered over (`stopgaps`), and what only a human can check (`experiences`). It carries its
// own policies in `_meta` — and every one of them is currently enforced by nothing but the
// discipline of whoever edits next. Two of those policies say, in the file's own words:
//
//   · counts: "🔴 手写的，改行必重算 … 不重算就会像 experiences.totals 那样立刻过期"
//   · stopgaps.anti_drift_rule: every stopgap MUST carry `matrix_row` or an explicit null
//
// A rule that names its own past failure and is still enforced by memory is a rule that will
// fail again. 2026-07-29 cost a day to exactly this shape — one fact living in several places
// with nobody counting. So: let the machine count.
//
// What this does NOT do: judge whether a verdict is CORRECT. It checks the book is internally
// consistent and that its self-declared invariants hold. Truth still comes from measurement.
//
// Run: node test/host-matrix-smoke.mjs
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOOK = join(ROOT, "docs", "host-matrix.json");

// The book this guard reads lives under `docs/`, and `docs/` never enters the public snapshot
// (see the ALLOWLIST in scripts/publish.mjs) while `test/` always does. So on the public repo this
// file threw ENOENT on every push — the same defect the ALLOWLIST already names for index.mjs, and
// the twin of the one in test/doc-facts.mjs. It hid behind that one: `npm test` is a `&&` chain and
// doc-facts fails second, so until doc-facts was fixed this line had never been reached there.
//
// ABSENT is not EMPTY. Section 0 below refuses to pass on an empty corpus on purpose ("a green run
// over zero rows proves nothing"), and that rule is untouched: a book that EXISTS must still have
// rows. What is being distinguished here is the tree that never carried the book at all — there is
// no ledger to keep honest, so there is no claim to make about it either way, and the honest
// outcome is to say so and skip rather than to invent a verdict about a file nobody shipped.
if (!existsSync(BOOK)) {
  console.log(`host-matrix: no docs/host-matrix.json under ${ROOT} — nothing to guard, skipped.`);
  console.log(`  (This tree carries the guard but not the ledger; the public snapshot is built`);
  console.log(`   that way on purpose. A tree WITH the book still has to satisfy every rule below.)`);
  process.exit(0);
}
const m = JSON.parse(readFileSync(BOOK, "utf8"));

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

// A guard whose corpus is empty is not passing, it is blind. Every section below re-asserts
// that it actually had rows to look at — the "空结果 = 判据无效" rule, in code.
console.log("0. the book is non-empty (a green run over zero rows proves nothing)");
ok("rows present", m.rows?.length > 0, `rows=${m.rows?.length}`);
ok("stopgaps present", m.stopgaps?.length > 0, `stopgaps=${m.stopgaps?.length}`);
ok("experiences present", m.experiences?.length > 0, `experiences=${m.experiences?.length}`);

console.log("\n1. row shape — the fields every row is declared to carry");
{
  const VERDICTS = new Set([...(m._meta.verdict_values || []), "UNKNOWN"]);
  const STATUSES = new Set(m._meta.status_values || []);
  const badVerdict = m.rows.filter((r) => !VERDICTS.has(r.verdict)).map((r) => `${r.id}=${r.verdict}`);
  const badStatus = m.rows.filter((r) => !STATUSES.has(r.status)).map((r) => `${r.id}=${r.status}`);
  const noId = m.rows.filter((r) => !r.id);
  const dupes = (() => {
    const seen = new Set(), d = [];
    for (const r of m.rows) { if (seen.has(r.id)) d.push(r.id); seen.add(r.id); }
    return d;
  })();
  ok("every row has an id", noId.length === 0, `${noId.length} 行无 id`);
  ok("row ids are unique", dupes.length === 0, dupes.join(", "));
  ok("verdict ∈ declared values", badVerdict.length === 0, badVerdict.join(", "));
  ok("status ∈ declared values", badStatus.length === 0, badStatus.join(", "));
  // Provenance is the most valuable column in the book: it is what stops someone else's
  // conclusion being promoted into ours. A blank one is worse than a pessimistic one.
  const noProv = m.rows.filter((r) => !r.verified_by).map((r) => r.id);
  ok("every row declares verified_by (provenance is never blank)", noProv.length === 0, noProv.join(", "));
}

console.log("\n2. needs_retest rows say how to settle themselves");
{
  // A row that says "retest me" without saying HOW is a row that never gets settled — it just
  // sits there looking like work in progress. This assertion found 8 such rows on its first
  // run (2026-07-29). They are GRANDFATHERED rather than invented-for, because U did not take
  // those measurements and filling in someone else's runbook would be exactly the promotion of
  // another lane's conclusion into ours that the `verified_by` column exists to prevent.
  //
  // 🔴 This is a RATCHET, not an exemption: the list may only shrink. A new needs_retest row
  // without how_to_check goes red immediately, and every id removed from this list is one row
  // that got its runbook. Do not add to it — fill in the row instead.
  const GRANDFATHERED = new Set([
    "openai-ref.widget-domain",                        // lane-d-firsthand
    "retest.size-changed",                             // lane-d-firsthand
    "retest.widget-domain-accepted",                   // lane-d-firsthand
    "retest.claude-desktop-widget-write-path",         // lane-d-firsthand
    // selfcheck.spec-conformance.self-contradiction — 债已还，2026-08-05（task #41 §7 对账把
    // §4½ 的 ⏳ 与 §7.5 的「不再需要靠猜」改成互指的两半）⇒ 该行 status 已是 assertable，
    // 按棘轮规矩从这张表里删掉，而不是留着让旧债看起来是永久的。
    "PLAT-4", "PLAT-5", "PLAT-7",                      // survey-2026-07-29(未复核)
  ]);
  const retest = m.rows.filter((r) => r.status === "needs_retest");
  ok("there are needs_retest rows to check", retest.length > 0, `${retest.length}`);
  const noHow = retest.filter((r) => !r.how_to_check && !GRANDFATHERED.has(r.id)).map((r) => r.id);
  ok("each new needs_retest row carries how_to_check", noHow.length === 0,
    `无跑法: ${noHow.join(", ")} — 补 how_to_check，不要加进 GRANDFATHERED`);
  // The ratchet must not rust: an id that no longer needs the exemption has to leave the list,
  // otherwise the debt looks permanent and nobody notices it was paid.
  const stale = [...GRANDFATHERED].filter((id) => {
    const r = m.rows.find((x) => x.id === id);
    return !r || r.status !== "needs_retest" || r.how_to_check;
  });
  ok("grandfather list has no stale entries (ratchet only shrinks)", stale.length === 0,
    `这些已不需要豁免，从 GRANDFATHERED 删掉: ${stale.join(", ")}`);
}

console.log("\n3. counts match a recount (the policy the file writes about itself)");
{
  const c = m._meta.counts;
  const recount = (key) => m.rows.reduce((acc, r) => (acc[r[key]] = (acc[r[key]] || 0) + 1, acc), {});
  const eq = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());
  ok("counts.rows matches rows.length", c.rows === m.rows.length, `${c.rows} vs ${m.rows.length}`);
  ok("counts.stopgaps matches", c.stopgaps === m.stopgaps.length, `${c.stopgaps} vs ${m.stopgaps.length}`);
  ok("counts.experiences matches", c.experiences === m.experiences.length, `${c.experiences} vs ${m.experiences.length}`);
  ok("counts.by_verdict matches a recount", eq(c.by_verdict, recount("verdict")), JSON.stringify(recount("verdict")));
  ok("counts.by_status matches a recount", eq(c.by_status, recount("status")), JSON.stringify(recount("status")));
  ok("counts.by_verified_by matches a recount", eq(c.by_verified_by, recount("verified_by")), JSON.stringify(recount("verified_by")));
}

console.log("\n4. stopgaps — anti_drift_rule and removable_when_rule, enforced");
{
  const ids = new Set(m.rows.map((r) => r.id));
  const missingLink = m.stopgaps.filter((s) => !("matrix_row" in s)).map((s) => s.id);
  ok("every stopgap declares matrix_row (or an explicit null)", missingLink.length === 0, missingLink.join(", "));
  const danglingRefs = m.stopgaps
    .filter((s) => s.matrix_row && !ids.has(String(s.matrix_row).split(/[,\s]/)[0]))
    .map((s) => `${s.id}→${s.matrix_row}`);
  ok("matrix_row points at a row that exists", danglingRefs.length === 0, danglingRefs.join(", "));
  // "禁止『等以后』『上游修好再说』这类不可判定写法" — the file's own words. We cannot judge
  // decidability, but we can refuse the empty case and the literal weasel phrasings it names.
  const noCondition = m.stopgaps.filter((s) => !s.removable_when || !String(s.removable_when).trim()).map((s) => s.id);
  ok("every stopgap has a removable_when", noCondition.length === 0, noCondition.join(", "));
  // A stopgap marked `resolved` must show its work. "已修" is a claim; the reading from actually
  // running `how_to_check` is the thing that lets a later reader trust the row without re-doing it.
  const resolvedNoProof = m.stopgaps
    .filter((s) => s.resolved && !String(s.resolved.evidence || "").trim())
    .map((s) => s.id);
  ok("every resolved stopgap carries the reading that closed it", resolvedNoProof.length === 0,
    `${resolvedNoProof.join(", ")} — resolved 必须带 evidence（跑出来的读数，不是「已修」两个字）`);
  const WEASEL = ["等以后", "以后再说", "上游修好再说", "TBD", "待定"];
  const weasel = m.stopgaps
    .filter((s) => WEASEL.some((w) => String(s.removable_when).includes(w)))
    .map((s) => s.id);
  ok("no undecidable removable_when phrasing", weasel.length === 0, weasel.join(", "));
}

console.log("\n5. experiences — why_not_automatable must be answerable");
{
  // The policy: 答不上来的说明它该写成测试，移出清单。A blank answer means the entry is in the
  // wrong list, so the guard treats blank as a failure rather than as a to-do.
  const blank = m.experiences.filter((e) => !e.why_not_automatable || !String(e.why_not_automatable).trim()).map((e) => e.id);
  ok("every experience answers why_not_automatable", blank.length === 0, blank.join(", "));
  const noSteps = m.experiences.filter((e) => !e.steps || !e.expected).map((e) => e.id);
  ok("every experience has steps + expected", noSteps.length === 0, noSteps.join(", "));
}

console.log("\n6. cross-references resolve");
{
  const sgIds = new Set(m.stopgaps.map((s) => s.id));
  const bad = [];
  for (const r of m.rows) {
    if (!r.blocked_by) continue;
    // blocked_by is prose-with-ids ("SG-17（我们迁移的闸门）+ …"), so extract the tokens.
    for (const tok of String(r.blocked_by).match(/SG-\d+/g) || []) if (!sgIds.has(tok)) bad.push(`${r.id}→${tok}`);
  }
  for (const e of m.experiences) {
    for (const tok of e.depends_on?.stopgaps || []) if (!sgIds.has(tok)) bad.push(`${e.id}→${tok}`);
  }
  ok("every SG- reference resolves to a real stopgap", bad.length === 0, bad.join(", "));
  const refsFound = m.rows.filter((r) => /SG-\d+/.test(String(r.blocked_by || ""))).length
    + m.experiences.filter((e) => (e.depends_on?.stopgaps || []).length).length;
  ok("there were references to resolve (guard is not vacuous)", refsFound > 0, `${refsFound} 处引用`);
}

console.log("\n7. impl paths still exist on disk");
{
  // 2026-07-29: the v0.4 component→app rename swept the code and left the ledger behind —
  // 8 rows pointed at `src/tools/components.mjs`, which no longer exists, while ZERO rows
  // pointed at the file that replaced it. The rename inventory was built from "where the
  // string appears in code", and the ledger is a different 属地 that was not on that list.
  //
  // A path that no longer resolves is worse than a missing one: it reads as evidence. So the
  // machine counts 属地 now. (Line numbers are NOT checked — they drift constantly and a
  // false-precise check would train people to ignore this one.)
  const impls = m.rows.map((r) => r.impl).filter((s) => typeof s === "string");
  // ⚠️ 后缀的顺序是 load-bearing：`js` 排在 `json` 前面会把 `tool-surface.json` 截成
  // `tool-surface.js`，然后报一个不存在的路径 —— 本守卫第一版就是这么假报了一条。长的在前，
  // 再加 `\b` 收边。一个会假报的守卫比没有守卫贵：它会训练人忽略它。
  const paths = [...new Set(impls.flatMap((s) => s.match(/(?:src|test|components|scripts)\/[\w./-]+\.(?:mjs|json|js|html)\b/g) || []))];
  ok("there were impl paths to resolve (guard is not vacuous)", paths.length > 0, `${paths.length} 条路径`);
  const missing = paths.filter((p) => !existsSync(join(ROOT, p)));
  ok("every impl path resolves on disk", missing.length === 0,
    `盘上不存在: ${missing.join(", ")} — 多半是改名扫了代码没扫账本`);
}

console.log("\n8. platform cells use declared vocabulary");
{
  const ALLOWED = new Set(m._meta.platform_cell_values || []);
  const KEYS = new Set(m._meta.platform_keys || []);
  let checked = 0;
  const badKey = [], badVal = [];
  for (const r of [...m.rows, ...m.experiences]) {
    if (!r.platforms || typeof r.platforms !== "object") continue;   // null / prose is legal
    for (const [k, v] of Object.entries(r.platforms)) {
      checked++;
      if (!KEYS.has(k)) badKey.push(`${r.id}.${k}`);
      // Cells may carry an annotation after the value ("无读数（本行的目标格）") — match the head.
      if (![...ALLOWED].some((a) => String(v).startsWith(a))) badVal.push(`${r.id}.${k}=${v}`);
    }
  }
  ok("platform cells were actually inspected", checked > 0, `${checked} 格`);
  ok("platform keys ∈ declared set", badKey.length === 0, badKey.slice(0, 5).join(", "));
  ok("platform cell values ∈ declared set", badVal.length === 0, badVal.slice(0, 5).join(", "));
}

console.log(`\nhost-matrix: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
