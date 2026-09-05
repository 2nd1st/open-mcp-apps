// SPDX-License-Identifier: MIT
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
//  2. NO FLAG LEAKS. Work-in-progress lands on main behind an OMA_* flag that is off unless the
//     environment names it — the practice is written up outside this repo, so the rule is restated
//     here rather than cited. A half-finished feature that registers its tool unconditionally is a
//     live cost regression for every user. Booting with a DEFAULT env and diffing the surface
//     is the only check that catches that.
//
// This is also the acceptance test for any refactor that MOVES tool registrations without
// changing them: byte-identical surface == provably behaviour-preserving.
//
// Intentional failure: `npm test` reds on every deliberate surface change. That is the point —
// review the diff, then re-bless with UPDATE_GOLDEN=1 in the SAME commit as the change.
// Run: node test/tool-surface.mjs   ·   bless: UPDATE_GOLDEN=1 node test/tool-surface.mjs

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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
// LEGACY era on purpose too: it is the wire every shipped host (claude.ai / ChatGPT / Claude
// Desktop) speaks today, so the golden pins the bytes THOSE models actually see. The 2026-07-28
// face gets its own pinned connection in §2 for the vocabulary the legacy wire cannot carry.
const stdioParams = () => ({
  command: "node",
  args: [join(ROOT, "src", "server.mjs")],
  env: { ...process.env, OMA_DB: DB, OMA_HOST: "surface", OMA_DYNAMIC_TOOLS: "" },
});
const client = new Client({ name: "surface", version: "1.0.0" });
await client.connect(new StdioClientTransport(stdioParams()));

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

console.log("2. dialect + caching hints (src/cache-hints.mjs) — on the 2026-07-28 wire");
{
  // Cache fields are 2026-07-28 vocabulary and the SDK emits them on modern-era responses only,
  // so this section speaks that era — a pinned connection, no probe-and-fallback: if the server
  // stops offering 2026-07-28 via server/discover, connect() throws and this test reds.
  const modern = new Client({ name: "surface", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await modern.connect(new StdioClientTransport(stdioParams()));
  const list = await modern.listTools();
  const raw = JSON.stringify(list);
  ok("no $schema survives — every tool schema reads identically under either dialect",
    !raw.includes("$schema"),
    "if a schema gained definitions/$ref/tuple-items, its declaration is KEPT on purpose — see cache-hints.mjs");
  ok("modern list carries no `execution` — Tasks vocabulary left the core schema (SEP-2663)",
    !raw.includes('"execution"'));
  ok(`ttlMs present (${list.ttlMs})`, typeof list.ttlMs === "number" && list.ttlMs >= 0);
  // The default configuration registers no per-app tools, so this list is identical for every
  // tenant and may be shared. It becomes "private" the moment OMA_DYNAMIC_TOOLS puts a tenant's own
  // app names in it — declaring THAT public would leak them through a shared cache.
  ok('cacheScope is "public" with dynamic tools off', list.cacheScope === "public", list.cacheScope);
  // The eras must agree on the tools themselves: the golden below is pinned on the legacy wire,
  // and this line is what entitles it to stand for both.
  ok("modern-era tools[] byte-identical to the legacy-era list",
    JSON.stringify(canon(list.tools)) === JSON.stringify(canon(tools)));
  await modern.close();
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
  // Its only write is the live pointer, and only when the caller passes `mount: true`: ONE row,
  // overwritten in place with the app's own name (store.touchLiveApp). Replay it and the pointer
  // holds the same value it held after the first call — which is the property the hint promises a
  // host that retries a timed-out call. What a replay does move is that row's render tally and its
  // timestamp, and that is the honest answer rather than a hole in this reason: a retried mount IS
  // a second attempt to put the app on screen, the loader itself makes up to four of them
  // (shell.mjs races a growing window against hosts that drop early bridge calls), and nothing
  // downstream reads the tally as a count of anything but renders. No key is possible either —
  // this seat carries no command_id and giving it one would put an idempotency key on the widget
  // mount path for a row the ledger does not record.
  get_app_html: "the pointer is one overwritten row; a replay leaves the same app live",
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

console.log("2c. the two gates overlap by name, and only where we said they would");
// TWO GATES, TWO QUESTIONS. `openai/widgetAccessible: true` is the HOST gate: it tells a
// default-DENY host "the top-level widget you rendered may call this back". The control-plane list
// (tool-policy.mjs) is the NESTING gate: "an app embedded inside another app may never reach
// this". A name on both is a real, deliberate shape — the system app we ship may do it at the top
// level, a nested child may not — so the check here is NOT disjointness. It is that the overlap is
// exactly the three names below and never grows by accident.
//
// THE THREE, and why each is safe to hand a top-level widget:
//   • `app_store_list` / `preview_app_store_entry` — App Store READS. They are control-plane only
//     because the `app_store_*` PREFIX reserves that namespace for a publishing surface that does
//     not exist yet: a forward reservation written for writes, catching two reads on its way past.
//     (`preview_app_store_entry` is in the explicit list solely to keep the wall it had under its
//     old name, `app_store_preview`, which the prefix used to cover.)
//   • `install_from_app_store` — a WRITE, and the exemption that needs the most reason. It is the
//     designed path for a user pressing Add in the App Store app (components/app-store/ui.html),
//     which is a first-party system app rendered at the top level; on a default-DENY host that
//     button does not work without this flag. What it cannot do bounds the risk: it refuses to
//     overwrite an app the user or their AI wrote — an existing entry whose author is not
//     "library" is rejected outright (src/tools/app-store.mjs:123) — the app it installs is
//     removable with `delete_app`, and every byte it writes goes through the ledgered store
//     command, so nothing lands anywhere a normal undo/delete cannot reach.
// `security_set` is NOT exempt and stays off the host gate, and the difference is in kind: it
// rewrites the POLICY the other walls are made of, and it has no widget caller at all (the
// settings pane drives it through the direct runtime's passthrough, never through this flag).
{
  const { isControlPlaneTool } = await import("../src/tool-policy.mjs");
  const SYSTEM_APP_SEATS = new Set(["app_store_list", "preview_app_store_entry", "install_from_app_store"]);
  const advertised = tools.filter((t) => t._meta?.["openai/widgetAccessible"] === true).map((t) => t.name);
  const both = advertised.filter((n) => isControlPlaneTool(n) && !SYSTEM_APP_SEATS.has(n));
  ok(`${advertised.length} widget-accessible tool(s), and the only control-plane ones are the named three`,
    both.length === 0,
    `on the host gate AND the nesting gate without being named above: ${both.join(", ")}`);
  const staleExemption = [...SYSTEM_APP_SEATS].filter((n) => !advertised.includes(n) || !isControlPlaneTool(n));
  ok("…and all three named seats are still on both gates", staleExemption.length === 0,
    `no longer both widget-accessible and control-plane: ${staleExemption.join(", ")} — drop the exemption`);
  ok("security_set is on the nesting gate and off the host gate",
    isControlPlaneTool("security_set") && !advertised.includes("security_set"),
    "security_set rewrites policy and has no widget caller — it must not be advertised to a host");
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

console.log("4. the engine options a deployment sets — unlisted, dynamicTools, telemetry");
// Two claims, and the second is the one that can rot silently. LISTING is easy to see; being
// still CALLABLE is what a hosted deployment and every app saved before the rename are relying
// on, and nothing else in the suite exercises a name that is deliberately absent from the list.
{
  const { Client: MemClient, InMemoryTransport } = await import("@modelcontextprotocol/client");
  const { createEngine } = await import("../index.mjs");
  const { openStore } = await import("../src/store.mjs");
  const { TOOL_ALIASES } = await import("../src/tool-policy.mjs");
  const memDb = join(ROOT, "test", "unlisted.db");
  for (const f of [memDb, memDb + "-wal", memDb + "-shm"]) if (existsSync(f)) unlinkSync(f);
  const memStore = openStore(memDb);
  const open = async (opts) => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createEngine(memStore, opts).connect(st);
    const c = new MemClient({ name: "unlisted", version: "1.0.0" });
    await c.connect(ct);
    return c;
  };

  const plain = await open({});
  const plainNames = (await plain.listTools()).tools.map((t) => t.name);
  const retired = Object.values(TOOL_ALIASES);
  ok(`${retired.length} retired name(s) registered and none of them listed`,
    retired.every((n) => !plainNames.includes(n)),
    `listed anyway: ${retired.filter((n) => plainNames.includes(n)).join(", ")}`);
  // The bridge itself: an app saved before the rename polls this every few seconds.
  const viaRetired = await plain.callTool({ name: "data_version", arguments: {} });
  ok("…and a retired name still answers on tools/call (the bridge apps in the field ride on)",
    !viaRetired.isError && typeof viaRetired.structuredContent?.seq === "number",
    JSON.stringify(viaRetired).slice(0, 200));
  // Something for the hidden seat to answer ABOUT — a fresh store holds no apps at all.
  await plain.callTool({ name: "save_app", arguments: { name: "unlisted-probe", ui: "<p>probe</p>" } });
  await plain.close();

  // THE OPTION OVERRIDES THE ENVIRONMENT, in both directions. This process runs with
  // OMA_DYNAMIC_TOOLS unset, so `true` has to be able to turn the openers ON here — an option
  // that only ever agreed with the env would look identical to one that did nothing.
  const dynOn = await open({ dynamicTools: true });
  const dynOnNames = (await dynOn.listTools()).tools.map((t) => t.name);
  ok("dynamicTools:true registers the per-app openers, whatever the environment says",
    dynOnNames.includes("open_unlisted_probe"), dynOnNames.filter((n) => n.startsWith("open_")).join(", "));
  await dynOn.close();
  const dynOff = await open({ dynamicTools: false });
  const dynOffNames = (await dynOff.listTools()).tools.map((t) => t.name);
  ok("…and dynamicTools:false keeps them off", !dynOffNames.some((n) => /^open_.+/.test(n) && n !== "open_app"));
  await dynOff.close();

  const hidden = await open({ unlisted: ["get_app_html"] });
  const hiddenNames = (await hidden.listTools()).tools.map((t) => t.name);
  ok('unlisted:["get_app_html"] ⇒ it is gone from tools/list', !hiddenNames.includes("get_app_html"));
  ok("…and nothing else moved with it", hiddenNames.length === plainNames.length - 1
    && hiddenNames.every((n) => plainNames.includes(n)));
  const stillWorks = await hidden.callTool({ name: "get_app_html", arguments: { name: "unlisted-probe" } });
  ok("…and tools/call still reaches it — hidden is not disabled",
    !stillWorks.isError && typeof stillWorks.structuredContent?.html === "string",
    JSON.stringify(stillWorks).slice(0, 200));
  await hidden.close();
  memStore.close();
  for (const f of [memDb, memDb + "-wal", memDb + "-shm"]) if (existsSync(f)) unlinkSync(f);

  // TELEMETRY IS A SEAT TOO, and "off" has to mean the file is never written — not that it is
  // written and ignored. A deployment declines this because the alternative is disclosing a
  // collection it has no product reason to keep, and a disclosure is about the bytes on disk.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const edit = async (dir, opts) => {
    const s = openStore(join(dir, "t.db"));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createEngine(s, opts).connect(st);
    const c = new MemClient({ name: "telemetry", version: "1.0.0" });
    await c.connect(ct);
    const saved = await c.callTool({ name: "save_app", arguments: { name: "tel-probe", ui: "<p>alpha</p>" } });
    const r = await c.callTool({ name: "edit_app", arguments: { app: "tel-probe",
      command_id: "tel-edit-1", expected_version: saved.structuredContent.version,
      edits: [{ old_string: "alpha", new_string: "beta" }] } });
    await c.close();
    s.close();
    return { r, file: join(dir, "edit-telemetry.jsonl") };
  };
  const onDir = mkdtempSync(join(tmpdir(), "oma-tel-on-"));
  const offDir = mkdtempSync(join(tmpdir(), "oma-tel-off-"));
  const on = await edit(onDir, {});
  const off = await edit(offDir, { telemetry: false });
  ok("the default records the edit tripwire beside the database", existsSync(on.file));
  ok("telemetry:false writes no sidecar at all", !existsSync(off.file));
  ok("…and the edit itself is unaffected either way",
    !on.r.isError && !off.r.isError && off.r.structuredContent.applied === 1,
    JSON.stringify(off.r).slice(0, 200));
  rmSync(onDir, { recursive: true, force: true });
  rmSync(offDir, { recursive: true, force: true });
}

for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

console.log(`\ntool-surface: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
