// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/tool-surface.mjs — the tool surface is a GOLDEN FILE, not an implementation detail.
//
// Two invariants, both of which cost real money when they break:
//
//  1. BYTE STABILITY. Prompt caching is an exact-prefix match and tools render FIRST, so
//     changing one character of one description invalidates the tools+system+messages prefix
//     for every user, every conversation. Measured: cache_read drops to 0. The MCP spec now
//     also says tools/list SHOULD be deterministically ordered "to improve LLM prompt cache
//     hit rates" — order is therefore part of the surface, not cosmetics.
//  2. NO FLAG LEAKS. Work-in-progress lands on main behind an OMA_* flag (see docs/process.md
//     in the SaaS repo). A half-finished feature that registers its tool unconditionally is a
//     live cost regression for every user. Booting with a DEFAULT env and diffing the surface
//     is the only check that catches that.
//
// This is also the acceptance test for any refactor that MOVES tool registrations without
// changing them: byte-identical surface == provably behaviour-preserving.
//
// Intentional failure: `npm test` reds on every deliberate surface change. That is the point —
// review the diff, then re-bless with UPDATE_GOLDEN=1 in the SAME commit as the change.
// Run: node test/tool-surface.mjs   ·   bless: UPDATE_GOLDEN=1 node test/tool-surface.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "surface.db");
const GOLDEN = join(ROOT, "test", "golden", "tool-surface.json");
const BLESS = process.env.UPDATE_GOLDEN === "1";

// Ratchet, not a guess: today's measured COMPACT size (37,363 B) plus a hair. It may fall; it must
// never silently rise, because this is the per-conversation resident cost of merely being connected.
//
// History, because both directions are informative:
//   40,000  original measurement
//   41,000  E1Δ added data_changes — the delta capability, in the batch that cut the per-call cost
//           of a write 52x (1,711 tk -> 33 tk). Paying ~300 resident tokens to save thousands per
//           call is the trade the ratchet exists to make visible, not to forbid.
//   38,000  E11 landed: src/cache-hints.mjs drops the redundant $schema declaration, -3,172 B
//           (~793 tk). A ratchet that only ever loosens is a budget; this one tightens.
//   39,200  Write-set A, the discovery face: list_apps gained name/kind/visibility/limit
//           (answering "open my X" in ONE call instead of listing a whole registry), and
//           get_app_guide gained the frozen topic enum. +908 B measured.
//           Deliberately temporary: paid back below, in the very next write-set.
//   37,900  The declaration face moved INTO the app document, so save_app stopped
//           carrying a nested manifest schema in its input: 39,196 -> 37,773 B measured. The debt
//           the entry above promised to repay, repaid with 227 B of change — and the vocabulary can
//           grow from here without touching this number at all, which was the point.
//   43,000  data_batch + data_query landed (write-set B). Set with room rather than at the measurement:
//           a cap that reds on one byte of honest wording teaches people to golf descriptions, which
//           is the opposite of what this file is for. It comes back DOWN with the read-path pass.
//           Measured at the time: 41,601 B. +3,598 B, and NOT golfed: correctness and
//           a description a model can act on come first, and both tools buy back far more than they
//           cost per use — a 200-row seed goes from 200 calls to 1, and an aggregate that two
//           measured hosts each spent ~145,000 tokens computing by hand becomes one call.
//           Both EARN their concept: a batch makes "one action" and "one transaction" the same thing
//           again for multi-row work, which is what the store already guaranteed for a single write;
//           a query says that questions about data get answered where the data is, instead of the
//           rows making two trips through a model to have arithmetic done to them. Neither adds a
//           dialect — the batch carries the existing typed commands, the query shares match's table.
//           📌 (PAID in write-set C — see the 48,500 entry: the honest pass ran with the read-path
//           finalisation, exactly as recorded.) Original note: these descriptions and data_list's
//           get one honest pass together once the read path is final.
//           (2026-07-27: 37 → 36 — call_function's always-refusing seat pulled until OMA_FUNCTIONS;
//           it returns with its executor, priced as one release-time cache break.)
//   48,500  write-set C: the v0.3 face froze at **37 tools** — the real ratchet is now the SEAT
//           COUNT, which this file pins exactly (order + membership golden). Measured 47,342 B.
//           The +5.7K is schema, not prose: −2 seats (file_usage, get_app_version), +3 seats
//           (edit_app, call_function, archive_app), windowed-read grammar
//           (offset/length/next_offset) on three reads, write receipts (saveAckSchema) on the
//           app writes, and returned/total/next_cursor/eot self-verification keys on every
//           page. The description pass DID run (window rationale told once, at get_app;
//           data_query references data_list's grammar instead of restating it; data_list stopped
//           describing the refusal behaviour C deleted). One grammar for windows, one for pages,
//           one filter table — zero new dialects.
//   48,600  fix (c): +93 B — app_html declares `collection`, the binding the loader needs to
//           paint. It is ONE key on ONE internal tool, and the alternative was to smuggle it through
//           structuredContent undeclared (which the SDK does allow — validateToolOutput returns
//           early with no outputSchema). Rejected: app_html ALREADY declares html/caps/tier,
//           so a fourth silent key makes the schema lie, and this one is read on every first paint.
//           The rule, so the next person does not re-litigate it per tool: a tool declares its whole
//           answer or none of it — delete_app declares nothing and is legible for it; partial
//           is the only forbidden shape.
//           The price is one prompt-cache invalidation for every user, and it is NOT the reason to
//           hesitate: v0.3.2 already rewrites four tools' text and schemas (golden 80,911 → 81,624),
//           so that cost is spent whatever this key does. Byte COUNT looking unchanged is a
//           coincidence; the cache keys on content.
//   (cap unchanged) write-set D: +104 B — the four item-write inputSchemas became PASSTHROUGH
//           objects, and the JSON face now spells "additionalProperties": true on them (strip-mode
//           objects emitted nothing). That is the ENTIRE visible cost of the shadow `via` edge:
//           the stamp itself is never named in any schema or description (row #8 — via is not part
//           of any AI surface; data_changes strips it), it just needed schemas that don't eat
//           unknown keys in transit. Seats 37, order, membership: unchanged.
//
// ⚠️ What this ratchet does NOT measure, and what actually matters (Leo, 2026-07-26: "the system has
// to stay elegant and controlled, or optimising later is meaningless" — and, correcting a sloppier
// version of this note: "if a new concept itself makes the system more elegant, isn't that better?").
//
// So the test is not "did the count go up". A concept has to pay rent by making the system easier to
// reason about, and the count is a proxy that fails in BOTH directions. Refusing data_query would
// have removed a concept and left every "how much did I spend" answer travelling through the model
// twice, by hand — a simpler engine wrapped in a baroque path. Adding the envelope and the single
// operator table each cost a concept and made three things stop being special cases.
//
// The disease is not size, it is DIALECTS: a second way to filter, a per-tool threshold, a parallel
// command grammar, a rule that holds for one tool. Each of those can arrive while the byte count
// falls. test/invariants.mjs binds shape rather than size; the boundary comment above data_query
// marks the one place this surface is most likely to be asked to grow into something it must not.
//
// Why bytes and not tokens: a token count needs a metered API call, which makes CI cost money and
// depend on a key. Compact bytes are free, deterministic, and CALIBRATED — 39,292 B / 4 ≈ 9,823 tk
// lands inside the 9,800–11,000 tk per-round overhead measured independently against the real
// tokenizer. Re-calibrate with count_tokens if the ratio is ever in doubt; gate on bytes.
// (Compact, not the pretty golden: indentation inflates the golden ~1.7× and is not sent anywhere.)
//   47,935  v0.4.0 · component -> app. The cap goes DOWN for the first time: 48,589 -> 47,890
//           measured, 699 B back, and the new cap is measured + 45 so the recovered room cannot be
//           spent without an explicit decision. 684 B was the theoretical ceiling (114 golden
//           occurrences x 6 chars); the real number beat it because renaming a tool shortens its
//           name in the seat AND in every description that references it. What did NOT change is
//           the part worth pinning: still 36 seats, same order, same membership.
const SURFACE_BYTES_CAP = 47_935;

for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

/** Key order in a JS object is construction order — stable per build, but not a contract we own.
 *  Sorting keys makes the golden diff mean "the surface changed", never "the SDK reordered". */
const canon = (v) =>
  Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
  : v;

// DEFAULT env on purpose: no OMA_DYNAMIC_TOOLS, empty registry. This is the surface a new user
// actually pays for. (server-smoke covers the opt-in dynamic-tool path separately.)
const client = new Client({ name: "surface", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: "node",
  args: [join(ROOT, "src", "server.mjs")],
  env: { ...process.env, OMA_DB: DB, OMA_HOST: "surface", OMA_DYNAMIC_TOOLS: "" },
}));

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
const canonical = canon(tools);
const actual = JSON.stringify(canonical, null, 2) + "\n"; // golden: pretty, so its diff is readable
const wireBytes = JSON.stringify(canonical).length;       // budget: compact, so it means something

console.log("1. surface shape");
ok(`${tools.length} tools registered`, tools.length > 0);
ok("no duplicate tool names", new Set(names).size === names.length,
  `duplicates: ${names.filter((n, i) => names.indexOf(n) !== i).join(", ")}`);
ok(`surface is ${wireBytes} B ≈ ${Math.round(wireBytes / 4)} tk (cap ${SURFACE_BYTES_CAP} B)`,
  wireBytes <= SURFACE_BYTES_CAP,
  "the resident per-conversation cost grew — shrink it, or raise the cap WITH a reason in the commit message");

console.log("2. dialect + caching hints (src/cache-hints.mjs)");
{
  const raw = JSON.stringify(await client.request({ method: "tools/list", params: {} },
    (await import("@modelcontextprotocol/sdk/types.js")).ListToolsResultSchema));
  ok("no $schema survives — every tool schema reads identically under either dialect",
    !raw.includes("$schema"),
    "if a schema gained definitions/$ref/tuple-items, its declaration is KEPT on purpose — see cache-hints.mjs");
  const hints = JSON.parse(raw);
  ok(`ttlMs present (${hints.ttlMs})`, typeof hints.ttlMs === "number" && hints.ttlMs >= 0);
  // The default configuration registers no per-app tools, so this list is identical for every
  // tenant and may be shared. It becomes "private" the moment OMA_DYNAMIC_TOOLS puts a tenant's own
  // app names in it — declaring THAT public would leak them through a shared cache.
  ok('cacheScope is "public" with dynamic tools off', hints.cacheScope === "public", hints.cacheScope);
}

console.log("2b. idempotentHint is a claim about effects, and it has to be true");
// How file_write_begin/chunk got it wrong: they took the default WRITE preset, which declares
// idempotentHint: true. That claim is only guaranteed by an idempotency key — cmdArgs' command_id,
// backed by change_event's UNIQUE(command_id). Without one, replaying file_write_chunk appends the
// bytes AGAIN, and the MCP docs say a host may retry a timed-out call on the strength of this hint.
// A wrong hint there is a corrupt upload, not a cosmetic issue.
//
// Naturally idempotent without a key — each needs a reason, so the exemption cannot grow silently.
const NATURALLY_IDEMPOTENT = {
  file_write_abort: "aborting an already-aborted upload changes nothing; the second call just reports it is gone",
};
{
  const claimed = tools.filter((t) => t.annotations?.idempotentHint === true && t.annotations?.readOnlyHint !== true);
  const unbacked = claimed.filter((t) => !("command_id" in (t.inputSchema?.properties ?? {})) && !NATURALLY_IDEMPOTENT[t.name]);
  ok(`${claimed.length} tool(s) claim idempotentHint, all of them backed`, unbacked.length === 0,
    `claims idempotency with no command_id and no declared reason: ${unbacked.map((t) => t.name).join(", ")}\n` +
    `      Either give it cmdArgs, use WRITE_NOT_IDEMPOTENT, or add it to NATURALLY_IDEMPOTENT with why.`);
  const stale = Object.keys(NATURALLY_IDEMPOTENT).filter((n) => !claimed.some((t) => t.name === n));
  ok("no stale exemptions", stale.length === 0, `listed but not claiming idempotency: ${stale.join(", ")}`);
}

console.log("3. golden file");
// A MISSING golden is a failure, not a licence to mint one. `BLESS || !existsSync(GOLDEN)` meant a
// lost baseline — a bad rebase, a partial checkout, a stray rm — was silently re-created from
// whatever the surface happened to be at that moment, and the check that guards the byte budget
// stamped its own approval. Recording a baseline is a deliberate act; only UPDATE_GOLDEN does it.
if (!BLESS && !existsSync(GOLDEN)) {
  ok(`the golden exists (${GOLDEN.slice(ROOT.length + 1)})`, false,
    `no baseline to compare against, so this file is currently guarding nothing.\n` +
    `      If the surface is genuinely correct right now, record it ON PURPOSE:\n` +
    `        UPDATE_GOLDEN=1 node test/tool-surface.mjs\n` +
    `      then READ THE DIFF before committing — that file is the byte budget's only anchor.`);
} else if (BLESS) {
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, actual);
  console.log(`  ⟳ blessed ${GOLDEN.slice(ROOT.length + 1)} (${actual.length} bytes, ${tools.length} tools)`);
  pass++;
} else {
  const golden = readFileSync(GOLDEN, "utf-8");
  const goldenNames = JSON.parse(golden).map((t) => t.name);
  // Order first: a reorder alone breaks caching, and "byte mismatch" would bury the reason.
  ok("tool order unchanged", JSON.stringify(goldenNames) === JSON.stringify(names),
    `golden: ${goldenNames.join(", ")}\n      actual: ${names.join(", ")}`);
  ok("no tools added or removed",
    goldenNames.length === names.length && goldenNames.every((n) => names.includes(n)),
    `added: ${names.filter((n) => !goldenNames.includes(n)).join(", ") || "(none)"}\n` +
    `      removed: ${goldenNames.filter((n) => !names.includes(n)).join(", ") || "(none)"}`);
  ok("surface byte-identical to golden", golden === actual,
    "a description/schema/annotation changed ⇒ every user's prompt cache is invalidated.\n" +
    "      Review `git diff test/golden/tool-surface.json` after: UPDATE_GOLDEN=1 node test/tool-surface.mjs");
}

await client.close();
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

console.log(`\ntool-surface: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
