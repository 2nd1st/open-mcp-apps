// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// engine.mjs — builds the complete MCP server (tools + resources) around a store.
// Shared by every entry point: stdio (server.mjs), Streamable HTTP (http.mjs), and the
// in-memory client behind the browser viewer. One engine, many transports — the data is
// the same SQLite regardless of which host connects.
//
// Tool REGISTRATION lives in src/tools/*.mjs, one module per domain, and this file only builds
// the shared context and walks them. That is enforced by test/invariants.mjs, for two reasons:
// this file used to be the one file every track had to edit (the project's only real
// serialization bottleneck), and a registration table is what lets a construction flag gate the
// tool surface itself — an unfinished tool reaching tools/list is a live cost regression for
// every user, because prompt caching is an exact-prefix match.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EXTENSION_ID } from "@modelcontextprotocol/ext-apps/server";
import { SETTINGS_COLLECTION, ITEM_WRITE_KEYS, ITEM_WRITE_ENVELOPE } from "./store.mjs";
import { CAP_NAMES, TIER_CAPS, coerceCap, SEEDED_APPS, answer, toMcp, EOT } from "./contracts.mjs";
import { openFileChannel } from "./files.mjs";
import { isControlPlaneTool } from "./tool-policy.mjs";
import { ENGINE_VERSION } from "./version.mjs";
import { installCacheHints } from "./cache-hints.mjs";
import { register as registerAppTools } from "./tools/apps.mjs";
import { register as registerDataTools } from "./tools/data.mjs";
import { register as registerFileTools } from "./tools/files.mjs";
import { register as registerRegistryTools } from "./tools/registry.mjs";
import { register as registerLibraryTools } from "./tools/library.mjs";
import { register as registerSettingsTools } from "./tools/settings.mjs";

// Part of this module's public surface (server.mjs / http.mjs / index.mjs import them from here),
// so the move into contracts.mjs is invisible to callers.
export { tierOf, RUNNER_REQUIRED_HTML, defaultCollectionFor } from "./contracts.mjs";


// Downloaded into the model's context at initialize — this is where the engine teaches the
// AI WHEN to reach for it, not just what the tools do. Keep it tight; it is always in context.
const INSTRUCTIONS = `open-mcp-apps gives the user persistent, interactive UI apps (widgets) backed by data collections shared between you and the user. Data outlives the conversation.

FIRST STOP: when the user asks about THEIR data, boards, lists, trackers, or "what do I have" — in any language — call data_collections BEFORE files, cloud connectors, or other sources. Their todos, kanbans, habits, notes, queues, budgets, logs live HERE.

__ONBOARDING_OR_INVENTORY__

ROUTING:
- A topic maps to an existing app → open_app it as part of answering (nearly free); don't recite its data as text. Real names come from list_apps, never from your memory of the chat.
- Need a fact, no UI → data_list / data_collections. Acting for the user ("mark X done") → data_* writes; visible widgets refresh themselves.
- What did the user do while you were away? Their widget edits never pass through this conversation — data_changes is the only tool that attributes them.
- Building or CHANGING an app → get_app_guide FIRST; the craft lives there, not here. Prefer reusing an app on a new collection over creating near-duplicates.
- "library" is the built-in store of ready-made apps — browse it, or install_from_library directly. dashboard and settings are the other system apps.
- An app can keep FILES too (file_write / file_list / file_read): images, PDFs, exports — per app, across chats.

__PROACTIVITY_STANCE__

WHEN NOT: one-shot visuals or pure discussion — answer in text/charts. Personal or sensitive data (health, money, private notes) needs the user's one-line yes before you store it; missing data is never a reason to wait, missing consent is.`;
// The other empty-state shape ("what's actually in our freezer?" — a question about something no
// app holds yet) is deliberately NOT here: its trigger point is a data read coming back empty, so
// the guidance rides in data_collections'/data_list's empty replies — the data the model is looking
// at when it decides (the apps.mjs birthday lesson: prose in the resident channel LOST to a
// fact in the decision channel; and on at least one measured host the tail of this string never
// reaches the model at all).

// Read a global settings pref (group "") from the shared store — one cheap settings snapshot.
function readPref(store, key) {
  try {
    for (const it of store.snapshot(SETTINGS_COLLECTION).items)
      if (String(it.fields?.key ?? "") === key) return it.fields.value;
  } catch {}
  return undefined;
}

// The onboarding procedure, held apart from INSTRUCTIONS because it is only TRUE for a user who
// has nothing yet: it says build one app immediately, do not brief, and explicitly do not list
// what already exists. For someone with ten apps that is not merely expensive, it is WRONG ADVICE.
// So it is SWAPPED, not trimmed — each half is paid only by the reader it is correct for.
const ONBOARDING = `GETTING STARTED — your job is to BUILD, not to brief: when the user asks how to use open-mcp-apps, for an intro, or to get set up (however they phrase it), your FIRST move is to build and open ONE app made for THEM. Do NOT open with an explanation or feature tour, do NOT list the apps that exist, do NOT ask which app they'd like. Steps: (1) Read them silently — from your memory and past conversations, what do they actually do, track, or keep re-explaining? Ask ONE quick question only if you truly have nothing. (2) Build it now — get_app_guide, seed their REAL current content into the collection with data_batch (from memory and past chats; never placeholder or invented rows — the wow is that it opens already about THEM), save_app, open_app immediately. The guide's craft rules are the bar: this first app is their first impression, make it your best work. (3) Only after it is on screen: one sentence on what it is, then offer a couple more you could build, one line each. (4) Then, conversationally, two things: a NEW app costs tokens once and pays off for anything recurring; and ask — or infer — whether they want you PROACTIVE about future apps or ON-REQUEST, record it with data_add into settings (group "", key "proactivity", value "proactive" | "on-request"), and honor it. Never end your first reply without a rendered app; never pitch settings or dashboard as example apps; skip anything sensitive unless they agree.`;

// What replaces it once the user has apps of their own.
//
// ⚠️ NOT a list of those apps. That was the first attempt and Leo killed it on grounds we had
// already accepted once: OMA_DYNAMIC_TOOLS is OFF by default "because every save_app would
// invalidate the whole conversation's prompt cache" — and this string lives in that prefix (codex
// carries it inside tool_search's description, which sits in req.tools at the very front). Naming
// the user's apps here re-introduces the exact property we refused, through a different door.
// Guiding the model to LIST is the cheap direction: a tool result lands in the conversation body,
// which only grows, so it caches instead of invalidating.
//
// What survives is the part list_apps cannot do. This string is the RETRIEVAL INDEX on both
// hosts (codex: tool_search's description; claude.ai: the connector's), so the model finds us only
// if the words a person would actually say appear here. Instances change; VOCABULARY does not.
const INVENTORY = `THE USER ALREADY HAS APPS HERE — they built them in earlier chats and they are still live: trackers, lists, boards, logs, journals, queues, inventories, habits, budgets, reading lists, collections, plans. When anything they say could plausibly BE one of those ("my expenses", "the reading list", "that board", "what am I tracking"), call list_apps or data_collections and look — do not assume it does not exist, and do not recreate something under a new name. Use the exact names the registry returns; never invent one. Then open_app it rather than reciting its data as text.`;

// INSTRUCTIONS carry a __PROACTIVITY_STANCE__ placeholder resolved per server start from the user's
// stored `proactivity` pref (set during onboarding, step 4). Low-frequency setting → reading it once
// at createEngine time is enough; a change takes effect on the next host restart.
/** INSTRUCTIONS are two-layered. The MANUAL (what this surface is, how to behave) is replaceable —
 *  a hosted deployment carries its own. The DYNAMIC segments are the engine's to keep true: which
 *  half of onboarding-vs-inventory this user actually is, their stored proactivity stance — and,
 *  when the function pillar lands, the roster. An override can POSITION them (carry the
 *  placeholders) but can never remove them: a manual that omits a placeholder gets that segment
 *  appended. Structural on purpose — a hosted copy that pinned the onboarding text for a user with
 *  ten apps was handing out advice that is simply wrong for its reader. */
function composeInstructions(manual, store) {
  const pref = readPref(store, "proactivity");
  const stance = pref === "proactive"
    ? "PROACTIVITY — the user chose PROACTIVE: when a topic maps to an existing app, open it unprompted; when a recurring need has no app yet, offer or just build one (a NEW build costs tokens once — a quick heads-up before a big one is courteous, not a blocker)."
    : pref === "on-request"
    ? "PROACTIVITY — the user chose ON-REQUEST: build or create apps only when asked. Exception: when they clearly want to SEE something that ALREADY has an app, open it anyway — showing an existing app is nearly free."
    : "PROACTIVITY — no preference set yet: open an EXISTING matching app proactively (nearly free), but PROPOSE building a NEW one (which costs tokens once) rather than building unprompted. Settle this with the user during onboarding.";
  // Which half this reader gets. One EXISTS query — on the hosted plane this runs per request.
  const settled = store.hasAppOutside(SEEDED_APPS);
  const dynamic = [
    ["__ONBOARDING_OR_INVENTORY__", settled ? INVENTORY : ONBOARDING],
    ["__PROACTIVITY_STANCE__", stance],
  ];
  let out = manual ?? INSTRUCTIONS;
  const missing = [];
  for (const [ph, text] of dynamic) {
    if (out.includes(ph)) out = out.replace(ph, text);
    else missing.push(text);
  }
  return missing.length ? `${out}\n\n${missing.join("\n\n")}` : out;
}
function buildInstructions(store) { return composeInstructions(undefined, store); }

/**
 * Build a fully-wired McpServer.
 * @param store  the shared store (one per process — every transport sees the same data)
 * @param opts.hostLabel  fixed host label (e.g. "browser-viewer"); when absent, the host is
 *                        identified from the MCP initialize clientInfo (Claude/ChatGPT/...).
 * @param opts.instructions  replace the MANUAL layer of the instructions (hosted deployments
 *                        carry their own behaviour text). The engine-composed DYNAMIC segments
 *                        (onboarding vs inventory, proactivity stance — and, later, the roster)
 *                        cannot be removed by an override: a manual that carries the placeholders
 *                        positions them; one that omits them gets them appended. See
 *                        composeInstructions for why that is structural, not advisory.
 * @param opts.widgetDomain  dedicated origin a host should give this deployment's widget sandbox
 *                        (`_meta.ui.domain`). REQUIRED by ChatGPT to submit an app with UI, where
 *                        it "must be unique per plugin" — which makes it a property of a
 *                        DEPLOYMENT's registration, not of the engine, so it is a knob and never a
 *                        default. Omitted ⇒ the field is not declared and the host uses its own.
 * @param opts.viewBase  base URL of a browser viewer for this store (e.g. "http://127.0.0.1:8787").
 *                        When present, list_apps prints a real /view/<name> link per app;
 *                        when absent (bare stdio — no viewer exists) it prints none.
 */
export function createEngine(store, { hostLabel, instructions, viewBase, widgetDomain } = {}) {
  const server = new McpServer(
    // Reported to the host at initialize. Real version, not a literal — see version.mjs for why
    // being unable to tell which build a deployment runs is a correctness problem, not a nicety.
    { name: "open-mcp-apps", version: ENGINE_VERSION },
    {
      instructions: composeInstructions(instructions, store),
      // Advertise the MCP Apps extension (2026-07-28 RC makes extensions first-class;
      // strict hosts may otherwise assume no ui:// support despite _meta.ui on tools).
      capabilities: { extensions: { [EXTENSION_ID]: {} } },
    },
  );

  // Which tools a WIDGET may call is HOST policy now: OpenAI's hosts default-DENY widget→server
  // calls unless the tool descriptor carries _meta["openai/widgetAccessible"]: true (measured
  // 2026-07-28: the codex surface forwarded a widget's data_update_item but refused its
  // data_add_item with -32000 — identical annotations and schema shape, so the difference was
  // host policy mid-rollout, not a broken proxy). The MCP Apps standard's _meta.ui.visibility
  // already DEFAULTS to ["model","app"], so standard hosts allow these without any flag; this is
  // the OpenAI compatibility spelling of the same fact, stamped at ONE seam so a new tool that
  // widgets call gets it by joining the list, not by remembering a field.
  const WIDGET_CALLABLE = new Set([
    "data_list", "data_version", "data_changes", "app_html", "render_health",
    "data_add_item", "data_update_item", "data_move_item", "data_delete_item",
    "library_list", "library_preview", "install_from_library", "list_apps", "data_collections",
    "ui_prefs_schema", "security_set",
  ]);
  // ONE line per control-plane tool call that REACHES US. Deliberately not a call log: only the
  // handful of names tool-policy already treats as privileged, and only the name — never arguments,
  // never a row, never anything the user typed.
  //
  // It exists because a question we could not answer came up and will come up again: when a host
  // refuses an app-originated call, was it us or was it them? Today the answer is undecidable from
  // our side, and the reason is structural rather than an oversight — our denylist
  // (isControlPlaneTool) lives ONLY in the runner guard, which runs in the browser. An app's
  // refused call therefore never reaches a server at all, so no server log could ever record it.
  // What a server CAN state is the complement, and it is the half that settles the question:
  // "this privileged call arrived and we ran it" ⇒ any refusal the user saw came from upstream;
  // silence ⇒ it never got here. (48h of prod logs held 22 lines and zero tool calls — this is
  // the missing instrument, not a missing search.)
  const sdkRegisterTool = server.registerTool.bind(server);
  const logged = (name, handler) => (isControlPlaneTool(name)
    ? (...a) => { try { console.error(`[oma] control-plane tool called: ${name} host=${hostName()}`); } catch {} return handler(...a); }
    : handler);
  server.registerTool = (name, config, handler) => sdkRegisterTool(
    name,
    WIDGET_CALLABLE.has(name)
      ? { ...config, _meta: { ...(config._meta || {}), "openai/widgetAccessible": true } }
      : config,
    logged(name, handler),
  );

  // The per-app file channel: opaque user-file storage (bytes on a swappable backend; the store
  // holds the ref index). MEMOIZED per store (files.mjs) so every engine over one store — incl.
  // the stateless /mcp path's engine-per-request — shares ONE upload table; the startup orphan
  // sweep runs inside openFileChannel exactly once per store.
  const fileChannel = openFileChannel(store);

  // Who is talking to us? clientInfo.name arrives in the initialize handshake.
  const hostName = () => {
    if (hostLabel) return hostLabel;
    const ci = server.server.getClientVersion?.();
    return (ci && ci.name) || process.env.OMA_HOST || "unknown";
  };

  // ── the model-facing text ────────────────────────────────────────────────────────────────
  // One rule governs everything below: what the model reads is NEVER a lossy view of the data.
  // It is either complete, or it is shape (counts, field names, versions) that does not pretend
  // to be data. The old builder enumerated one label per item — which was both the entire token
  // bill AND a silent truncation: measured in claude.ai, the model could not name a single field
  // beyond the label, yet nothing in the text said so, so it answered as if it had seen the rows.
  //
  // structuredContent is CHEAPER, not free — the axiom "pay for content, never for
  // structuredContent" died in the delivery-cut measurements: claude.ai does route it to the
  // widget and out of the transcript, but codex's local kernel caps the WHOLE result (content +
  // structuredContent together) at ~48K chars and eats the middle. RESULT_BUDGET exists because
  // of that knife: both channels ride one bounded envelope, sized to arrive intact everywhere.

  /** Field names present across a sample of items — shape, not contents. */
  // The pre-envelope read builders (structured / toResult / toStale / toFull / toPage) and
  // their three thresholds (STRUCTURED_CEILING / DELIVERY_ADVISORY / FULL_READ_BUDGET) lived
  // here for two write-sets. The read surface now rides ONE envelope (contracts.mjs:
  // answer.page / answer.chunk) under ONE number (RESULT_BUDGET): each read tool shrinks its
  // own bulk to fit and says so, on both channels, with eot always last.

  /** Complete, id-bearing rendering. The id is not decoration: it is the ONLY way the model ever
   *  learns which row is which, and without it the model can create rows but can never update or
   *  delete an existing one — a gap the old label-only text hid completely. */
  const renderItems = (items) =>
    items.map((i) => `  ${i.id}${i.group ? ` [${i.group}]` : ""} ${JSON.stringify(i.fields)}`).join("\n");

  /** A write's receipt: what happened, to which row, and whether the caller's copy of the
   *  collection was the one it happened on top of. `prev_collection_seq` is the whole mechanism
   *  behind "click and it redraws with no extra round trip": a widget holding exactly that mark
   *  can apply the row itself and step to `seq`; anything else re-reads. The row rides along so
   *  the caller never has to fetch what it just wrote.
   *
   *  Never a collection. That is the rule this replaces: echoing every row back on every write is
   *  what made a write cost scale with the data instead of with the action. */
  function toAck(r, note) {
    const body = { ok: true, id: r.id, collection: r.collection, seq: r.seq, prev_collection_seq: r.prev_collection_seq };
    if (r.item) body.item = r.item;
    if (r.deleted) body.deleted = true;
    if (note) body.note = note;
    return toMcp(answer.ack(body, note));
  }

  /** A write that did NOT happen, handed back with the CURRENT row so the retry needs no extra
   *  read. Not isError: the payload is useful and a host that discards errored results would turn
   *  a recoverable conflict into a dead end. The failure is stated in both channels instead. */
  function toConflict(r, note) {
    const body = { ok: false, reason: r.conflict ? "version_conflict" : r.error, id: r.id, collection: r.collection };
    if (r.expected != null) body.expected_version = r.expected;
    if (r.item) body.item = r.item;
    if (r.violations) body.violations = r.violations;
    body.note = note;
    return toMcp(answer.ack(body, note));
  }

  function failNote(r) {
    if (r.error === "not_found") return "That item no longer exists — refresh.";
    if (r.error === "command_id_reused") return "That command_id was already used by a DIFFERENT command — nothing was done. Use a fresh uuid per action.";
    if (r.error === "schema_violation") return `schema_violation — rejected by the collection's manifest (declared by "${r.manifest_app}"): ${(r.violations || []).join("; ")}.`;
    if (r.error === "empty_html") return "empty_html — an app needs something to render: every app here is something a person opens. Send the HTML you want saved.";
    if (r.error === "bad_name") return "bad_name — app names are lowercase letters, digits and dashes, starting with a letter (max 32 chars).";
    if (r.error === "provenance_locked") return `provenance_locked — "${r.name}" was authored outside this conversation (by ${r.author}, trust tier ${r.tier}) and runs under that provenance. Saving over it here would re-stamp it as yours and change what it is allowed to do, so nothing was written. Build your own under a different name, or delete this one first if it should go.`;
    if (r.error === "group_too_long") return `group_too_long — a group is a lane name (max ${r.limit} chars), not a data field.`;
    if (r.conflict) return `Version conflict (expected v${r.expected}) — refresh and retry.`;
    if (r.error) return `Command failed: ${r.error}${r.detail ? ` — ${r.detail}` : ""}.`;
    return "Command failed.";
  }
  // Even a bare failure carries the tail mark: a cut-off error message is indistinguishable from a
  // complete one without it, and failures are exactly where a model acts on its own judgment.
  const fail = (msg) => ({ content: [{ type: "text", text: msg + "\n" + EOT }], isError: true });
  /** A WRITE that failed outright, on the full envelope: the why rides both channels, and a
   *  violations list rides structured so a retry can fix the exact field. Only for tools whose
   *  outputSchema is ackSchema — read tools keep bare fail() until their own rewrite. */
  function toFail(r) {
    const body = {};
    if (r.violations) body.violations = r.violations;
    if (r.id) body.id = r.id;
    if (r.collection) body.collection = r.collection;
    return toMcp(answer.fail(r.error || "failed", body, failNote(r)), { isError: true });
  }
  const FILE_ERRORS = {
    quota_exceeded: "This app's file storage quota is full — delete some files first.",
    too_many_files: "This app has too many files — delete some first.",
    total_quota_exceeded: "Global file storage is full.",
    total_too_many_files: "Global file storage has too many files.",
    file_too_large: "That file exceeds the per-file size limit.",
    bad_path: "Invalid file path — use a simple name (no '..', absolute paths, backslashes, or control characters).",
    bad_app: "Invalid app name for a file.",
    bad_sha256: "Internal error: bad content hash.",
    bad_size: "Invalid file size.",
    not_found: "No such file — refresh.",
    upload_not_found: "No such upload (it may have expired or been committed/aborted) — start again with file_write_begin.",
    upload_expired: "That upload expired or its staging data was lost — start again with file_write_begin.",
    upload_busy: "That upload is mid-operation — send chunks one at a time, in order.",
    too_many_uploads: "Too many uploads in flight — commit or abort one first.",
    backend_no_staging: "This file backend doesn't support chunked uploads.",
    bad_chunk_seq: "Invalid chunk seq — a 0-based index of this chunk within the upload.",
    chunk_out_of_order: "That chunk arrived out of order — send the index the upload expects next (see `expected`).",
    chunk_already_staged: "That chunk index was already staged and cannot be re-verified — continue with the next index, or abort and restart if unsure what was sent.",
    chunk_mismatch: "That chunk index was already staged with DIFFERENT bytes — the resend does not match what landed. Abort and restart the upload.",
    sha256_mismatch: "The staged bytes hash differently than expected_sha256 — nothing was committed and the upload is still intact: re-check what you sent, then commit again (or abort).",
  };
  const fileFailNote = (r) =>
    r.conflict ? `Version conflict (expected v${r.expected}) — refresh and retry.`
    : r.error === "command_id_reused" ? "That command_id was already used by a DIFFERENT command — use a fresh uuid."
    : FILE_ERRORS[r.error] || `File operation failed: ${r.error || "unknown"}.`;

  // caps = tier preset ⊕ policy:defaults:<tier>:<cap> ⊕ security:<app>:<cap> (last wins).
  // Rows come from the settings snapshot scanned in items[] order (the same last-wins scan the
  // pref merge uses). Overlays apply verbatim — security_set is the only writer and is privileged.
  // E13a: caps are decided on TWO axes from here on — what the app is trusted to be (tier),
  // and WHO is asking (caller). Today caller is always "owner" and changes nothing, which is the
  // whole point: the same app opened by its owner and by a stranger must be able to differ,
  // and every chokepoint that decides caps (shell.mjs runnerMount, the settings mirror,
  // tool-policy) reads this ONE signature. Widening it later means touching all of them at once.
  function computeCaps(app, tier, caller = "owner") {
    void caller;
    const preset = TIER_CAPS[tier] || TIER_CAPS.unreviewed;
    const caps = { ...preset, call_tools: [...preset.call_tools] };
    const byKey = new Map();
    for (const it of store.snapshot(SETTINGS_COLLECTION).items) {
      const k = String(it.fields?.key ?? "");
      if (k) byKey.set(k, it.fields.value);
    }
    for (const cap of CAP_NAMES) {
      for (const key of [`policy:defaults:${tier}:${cap}`, `security:${app}:${cap}`]) {
        if (!byKey.has(key)) continue;
        const v = coerceCap(cap, byKey.get(key));
        if (v !== undefined) caps[cap] = v;
      }
    }
    return caps;
  }

  // Every mutating command funnels through here — in data.mjs, and in registry.mjs's
  // delete_app — so it is shared context, not a data-tools local.
  // `type`/actor/host spread AFTER the args, never before: the four item-write schemas are
  // passthrough (to carry the runner's `via` stamp), so an arg bag can contain a `type` key —
  // and if the caller's `type` won, `data_add_item {type:"save_app", name, html}` would
  // dispatch a control-plane command through a data tool (reproduced: it overwrote a locked
  // app). The dispatch type is the ONE thing the caller never gets to choose.
  //
  // The SAME wall data_batch has always had, applied here too (ITEM_WRITE_KEYS — one table, both
  // write paths). Pinning `type` closed the worst instance; every other unpublished key a caller
  // invents was still forwarded, and `id` on add_item is the one that bites: the engine mints row
  // ids, but a caller that could CHOOSE one could re-create a deleted id in a different collection,
  // after which a widget's stale snapshot still lists that id and an id-addressed write lands on
  // the foreign row (adversarial #2 B-3). Non-item commands are untouched — this table is only
  // about the four item writes, whose schemas are passthrough.
  const run = (a, type) => {
    const allowed = ITEM_WRITE_KEYS[type];
    let clean = a;
    if (allowed) {
      clean = {};
      for (const k of allowed) if (a[k] !== undefined) clean[k] = a[k];
      for (const k of ITEM_WRITE_ENVELOPE) if (a[k] !== undefined) clean[k] = a[k];
    }
    return store.execute({ ...clean, type, actor: a.actor || "agent", host: hostName() });
  };

  // The shared context every tool module gets.
  const ctx = { server, store, fileChannel, hostName, run, toAck, toConflict, toFail, renderItems, failNote, fail, fileFailNote, computeCaps, viewBase, widgetDomain };

  // Order is the tool-surface order, and the surface is a golden file — do not reshuffle.
  // apps goes first because it hands back registerApp, which library and registry
  // need to wire an app that did not exist when their module ran.
  Object.assign(ctx, registerAppTools(ctx));
  registerDataTools(ctx);
  registerFileTools(ctx);
  registerRegistryTools(ctx);
  registerLibraryTools(ctx);
  registerSettingsTools(ctx);

  // Must run AFTER every registration: it wraps the handlers the SDK built around the finished set.
  installCacheHints(server, { dynamicTools: process.env.OMA_DYNAMIC_TOOLS === "1" });

  return server;
}
