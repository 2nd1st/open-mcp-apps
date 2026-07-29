// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// contracts.mjs — the annotations, shapes and capability policy that the tool modules share.
// Extracted from engine.mjs so src/tools/*.mjs can import them without a cycle: engine.mjs
// imports the tool modules, therefore the tool modules must never import engine.mjs.
// tierOf and RUNNER_REQUIRED_HTML stay part of engine.mjs's public surface via a re-export —
// server.mjs / http.mjs / index.mjs keep importing them from there.

import { z } from "zod";

// This engine is a closed local system — nothing here reaches the open world.
const RO = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// destructiveHint is documented as false = "performs only additive updates", which read literally
// would make every edit destructive and have hosts confirm each one. The criterion that is actually
// decidable, and the one this codebase uses:
//
//     Can this call destroy something THE ENGINE ITSELF cannot give back?
//
// Applied to what the engine actually retains:
//   · item edits/moves   → the ledger records them (item_updated{fields}, item_moved{from,to}), so
//                          replaying from item_added reconstructs any point in time  → NOT destructive
//   · app writes   → the html lives in app_history (see store.mjs schema)  → NOT destructive
//   · settings writes    → ordinary items, same ledger                                 → NOT destructive
//   · FILE overwrites    → the previous blob becomes an orphan and the GC sweep unlinks it. The bytes
//                          are gone and nothing here can return them                   → DESTRUCTIVE
// So file_write and file_write_commit carry this, and ordinary editing does not — which keeps host
// confirmation prompts for the case that actually loses data. (Audit finding, 2026-07-26.)
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
// WRITE claims idempotentHint: true, and that claim is only TRUE for tools carrying an idempotency
// key (cmdArgs' command_id, enforced by change_event's UNIQUE(command_id)). Repeating a call that
// has no such key DOES have an additional effect, so those tools need this instead.
//
// Not cosmetic. The MCP docs define idempotentHint as "repeated calls with the same arguments have
// no additional effect", and a host may retry a timed-out call on the strength of it. file_write_chunk
// appends its bytes again when replayed — a host trusting the old annotation would silently corrupt
// the uploaded file. Found by a spec-conformance audit, 2026-07-26.
const WRITE_NOT_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const itemShape = z.object({
  id: z.string(), group: z.string(), position: z.number(),
  fields: z.record(z.string(), z.any()), version: z.number(),
});
// A write's receipt. Deliberately unlike snapshotSchema: no items array, because a write returns
// the row it wrote and nothing else. `prev_collection_seq` is what lets a widget decide between
// applying the row locally (it held exactly that mark) and re-reading (it did not).
//
// Terse on purpose: every byte of an outputSchema is resident in tools/list for every conversation,
// and the field names here need no gloss. What they MEAN is taught once, in the guide.
const ackSchema = {
  ok: z.boolean(),
  id: z.string().optional(),
  collection: z.string().optional(),
  seq: z.number().optional(),
  prev_collection_seq: z.number().optional(),
  // ONE key for the row, not two. On success it is the row as written; on a conflict it is the row
  // as it actually stands — which is precisely what the retry needs. `ok` already says which
  // situation you are in, so a second name for the same thing would be a concept with no work.
  item: itemShape.optional(),
  deleted: z.boolean().optional(),
  expected_version: z.number().optional(),
  reason: z.string().optional(),
  violations: z.array(z.string()).optional(),
  note: z.string().optional(),
  eot: z.string().optional(),
};

const snapshotSchema = {
  collection: z.string(),
  // Emitted ahead of `items` deliberately: a client that finds a result too large keeps both ENDS
  // and eats the middle (codex 0.144: 24,000 chars + "…truncated…" + 24,000 — measured), so a count
  // written before the array outlives the rows it counts. `total` vs the rows actually present is
  // how the model learns it is holding less than we sent. On a page it means the collection's size,
  // not the page's — same field, and the difference is the point.
  total: z.number().optional(),
  items: z.array(itemShape), version: z.number(),
  settings_version: z.number().optional(), // rides on every toResult — the shell's pref-refetch gate
  files_version: z.number().optional(),    // same idea for the file plane — the shell's file-refetch gate
  host: z.string().optional(),
  // 🔴 ok/note exist because the two hosts we ship to feed the MODEL different, disjoint channels:
  // claude.ai feeds it `content` and routes structuredContent to the widget; codex feeds it
  // structuredContent and does not pass `content` to the model at all when structuredContent is
  // present (both measured, OMA_PROBE). Note the precise claim: `content` is not discarded there,
  // it is rendered to the USER — codex's UI shows every block, annotations included. Both hosts
  // show the human both channels; they differ only in which one the model receives.
  // So a fact that lives in only one channel does not reach the model on one of the two hosts — and the fact
  // that lived only in `content` was "this write FAILED": data_update/move/delete answer a version
  // conflict with the fresh snapshot plus an explanatory note, which on codex arrived as a perfectly
  // ordinary success. These two mirror that note onto the structured channel verbatim. They are not
  // a second source of truth; they are the same sentence, addressed to the other reader.
  ok: z.boolean().optional(),
  note: z.string().optional(),
};
// Per-app file metadata (the ref index shape; bytes never ride here — see file_read's data_base64).
const fileMetaShape = z.object({
  app: z.string(), path: z.string(), sha256: z.string(), size: z.number(),
  mime: z.string(), version: z.number(), backend: z.string(),
  created_at: z.string(), updated_at: z.string(),
});
// The pinned caps shape (see CAP_NAMES/TIER_CAPS below) — served by app_html to the
// loader/runner and by app_permissions to the settings Permissions pane.
const capsShape = z.object({
  call_tools: z.array(z.string()), send_message: z.boolean(), update_context: z.boolean(),
  delete_items: z.enum(["allow", "confirm", "deny"]),
  cross_collection_read: z.boolean(), cross_collection_write: z.boolean(),
  settings_write: z.boolean(), read_source: z.boolean(),
  file_read: z.boolean(), file_write: z.boolean(),
});

// Reserved settings groups (docs/settings-design.md §8): a group is an app name, so
// these may never BE app names. Blocks naming only — not writes into those groups.
// The last three are not vocabulary hygiene, they are a brick-the-server guard, and the mine is
// live: install.mjs turns OMA_DYNAMIC_TOOLS on for every Anthropic host, and a per-app tool is
// named `open_${name.replaceAll("-","_")}`. So an app called `app` registers `open_app`
// — the static opener's own name — the SDK throws on the duplicate, createEngine throws, and the
// server no longer starts. At that point `delete_app` cannot be reached either: the only way
// out is editing SQLite by hand. `app` collides with the loader URI the same way.
// `app` and `component` are this product's own house vocabulary, so "make me an app tracker"
// is a plausible thing for a user to say — which is exactly why a name cannot be allowed to reach
// into the tool namespace. `component` is the RETIRED house word (v0.4.0) and stays refused: the
// ledger, the archived docs and every store older than v0.4 still carry it, so letting it back in
// through the front door would put a user's app and our own history under one word.
const RESERVED_APP_NAMES = new Set([
  "security", "engine", "host", "system", "shell", "oma",
  "app", "component", "loader",
]);

// The apps the engine SHIPS and seeds into every fresh store. One definition, because two
// places need it for unrelated reasons and a drifting copy would be silent: seed.mjs decides what
// to install, and engine.mjs uses "owns an app that is not one of these" as the signal that a
// user is past onboarding (see buildInstructions).
const SEEDED_APPS = new Set(["settings", "dashboard", "library"]);

// The SHARED preference catalog (P4 code/UI split): the ENGINE owns what shared prefs exist,
// their types/defaults/labels; the settings app only RENDERS what ui_prefs_schema
// returns. One source of truth — a regenerated/broken settings UI can't redefine the catalog.
const SHARED_PREFS = [
  { key: "locale", type: "string", label: "Locale", default: "auto", maxlength: 35,
    desc: "Language and region, e.g. en-US — or \"auto\" to match your device." },
  { key: "week_start", type: "enum", label: "Week starts on", default: "monday",
    options: ["monday", "sunday", "saturday"], desc: "Calendars and habit grids start the week here." },
  { key: "date_format", type: "enum", label: "Date format", default: "auto",
    options: ["auto", "yyyy-mm-dd", "dd/mm/yyyy", "mm/dd/yyyy"], desc: "\"auto\" follows the Locale setting." },
  { key: "currency", type: "string", label: "Currency", default: "USD", maxlength: 8,
    desc: "Currency code for money apps, e.g. USD." },
  { key: "density", type: "enum", label: "Density", default: "comfortable",
    options: ["comfortable", "compact"], desc: "Compact means tighter spacing and rows." },
  { key: "confirm_delete", type: "boolean", label: "Confirm before delete", default: true,
    desc: "Apps ask before deleting anything." },
  { key: "proactivity", type: "enum", label: "AI proactivity", default: "on-request",
    options: [{ value: "proactive", label: "Proactive — act when it fits" }, { value: "on-request", label: "On request — only when asked" }],
    desc: "Whether the AI opens or builds apps on its own when they fit, or only when you ask. Usually set during onboarding; takes effect after restarting the chat app." },
  { key: "widget_poll_seconds", type: "number", label: "Widget auto-refresh (seconds)", default: 20, min: 5, max: 300, step: 5,
    desc: "How often visible widgets refresh (faster right after activity). Override per app below." },
  { key: "user_name", type: "string", label: "Your name", default: "", maxlength: 60,
    desc: "Your name, for a personal greeting." },
];

// Locked SYSTEM apps: their UI + logic ship WITH the engine (import-fixed) and must never be
// overwritten by the AI or a (possibly regenerated/hostile) widget through the TOOL surface. The
// seed path and privileged installers write the store DIRECTLY (store.execute), so they are exempt
// by construction — this lock lives at the tool boundary, not in the store. "dashboard" is
// deliberately NOT here (it's the user's editable personal launcher); user apps stay editable too.
const LOCKED_APPS = new Set(["settings", "library"]);

// The 9 scenario-taxonomy category slugs (authoritative source: the shared
// scenario-taxonomy doc, verified 2026-07-22; shared contract per
// docs/manifest-shared-keys.md — do not amend privately). Invalid → warn + drop, never reject.
const SCENE_CATEGORIES = new Set([
  "data-explore", "teach-sim", "input-cocreate", "browse-compare", "local-tools",
  "dev-artifacts", "notation", "ambient-viral", "deliverables",
]);

// ------------------------------------------------------------- default collection binding
/** Which collection an app opens on when the caller names none.
 *
 *  It used to be the app's own NAME, full stop — the `collections` an app declares in
 *  its #oma-manifest block took no part at all, so an app whose rows live under a different name
 *  opened BLANK (measured on 8 of 9 authoring runs; two models wrote their own workaround around
 *  it rather than report it). Now: an UNAMBIGUOUS declaration wins. Two or more declared and there
 *  is no "the" collection to pick, so the name stays the default and the caller can still say.
 *
 *  Lives here, not in the tool, because /view (http.mjs) mounts apps by the same rule and a
 *  second copy of "what does this app open on" is a second answer waiting to disagree.
 *  Exported through engine.mjs alongside tierOf, for embedding shells that mount apps too. */
const defaultCollectionFor = (comp) => {
  if (!comp) return null;
  // TIER GATE, and it is the whole reason this is a function and not two lines at the call site.
  // The manifest is written BY THE APP. For a local (first-party / AI-authored) app
  // that is just it telling us where its own rows live. For an UNREVIEWED one it would be the
  // app choosing what it is bound to — and the bound collection is precisely what the runner
  // grants full typed read/write on regardless of cross_collection_read/write. A published
  // app declaring `{"collections":{"private-ledger":{}}}` would then be handed another app's
  // rows by the act of opening it. Untrusted apps bind to their own NAME, full stop.
  if (comp.manifest && tierOf(comp.author) === "local") {
    try {
      const names = Object.keys(JSON.parse(comp.manifest).collections || {});
      // .trim() belt-and-braces: the store now refuses a padded key at save time, but a manifest
      // STORED before that check exists is still out there, and binding to " trips " while every
      // write canonicalizes to "trips" opens the app on a collection that can never have rows.
      if (names.length === 1 && names[0].trim()) return names[0].trim();
    } catch { /* a manifest that no longer parses must not break OPENING the app */ }
  }
  return comp.name ?? null;
};

// ------------------------------------------------------------------ trust tiers & caps
// docs/security-model.md §2.3 step 1 + §3: app_html returns {html, author, tier, caps}.
// The ENGINE is the single reader of security:*/policy:* when building caps; the RUNNER
// (wrapLoader's runner branch) enforces them. No install-tier column exists yet, so every
// non-local author resolves to the STRICTEST tier ("unreviewed"). Exported: /view (http.mjs)
// applies the same tier gate.
const tierOf = (author) =>
  // "library" = install_from_library provenance. OSS library content is FIRST-PARTY (we author
  // every entry — the same files the seed path installs as local), so it runs DIRECT like any
  // locally-authored app (Leo 2026-07-24: no review exists in OSS because there is nothing
  // to review; the runner + review flow arrive together with the SaaS user-publishing pipeline).
  // The author stamp still tracks provenance + drives library update detection.
  author === "agent" || author === "human" || author === "seed" || author === "library" ? "local"
  : "unreviewed";
// Fail-closed placeholder for DIRECT render paths (docs/security-model.md §2.3): any surface
// that would hand an app the real window.oma with full trust must refuse non-local tiers
// until a runner exists on that path. Deliberately shell-free — no window.oma, no scripts.
// ONE surface still serves it: the per-app ui:// resource, which IS direct mode and has no
// loader to delegate to. /view used to as well and no longer does — it serves wrapLoader() for a
// non-local tier, which reaches the runner the same way the open_app path does.
const RUNNER_REQUIRED_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Sandboxed runner required</title></head><body style="font-family:system-ui;max-width:560px;margin:40px auto;color-scheme:light dark"><h3>App not rendered</h3><p>This app requires sandboxed runner mode, which isn't available on this path yet. Open it with <code>open_app</code> instead — the universal loader runs non-local apps behind a sandboxed runner.</p></body></html>`;
// Pinned caps shape — the runner builds against these exact field names:
//   { call_tools: string[] (["*"] = wildcard sentinel), send_message: bool, update_context: bool,
//     delete_items: "allow"|"confirm"|"deny", cross_collection_read: bool,
//     cross_collection_write: bool, settings_write: bool, read_source: bool }
// CONTRACT: these snake_case names are also the ONLY cap suffixes computeCaps reads from
// policy keys — security:<app>:<cap> / policy:defaults:<tier>:<cap>. A key with any
// other suffix (e.g. dotted "sendMessage") is stored but never consulted; security_set flags
// such keys with a warning at write time.
const CAP_NAMES = ["call_tools", "send_message", "update_context", "delete_items",
  "cross_collection_read", "cross_collection_write", "settings_write", "read_source",
  "file_read", "file_write"];
const TIER_CAPS = {
  // local-authored runs DIRECT (co-equal with the AI) — anything stricter would be theater.
  local: { call_tools: ["*"], send_message: true, update_context: true, delete_items: "allow",
    cross_collection_read: true, cross_collection_write: true, settings_write: true, read_source: true,
    file_read: true, file_write: true },
  // library-reviewed: DORMANT until the SaaS user-publishing pipeline lands (third-party
  // content + actual review). Preset pinned NOW so the runner can build against it; OSS
  // library installs are first-party and run local/direct instead (see tierOf). When SaaS
  // review arrives: reviewed content renders sandboxed and NEVER promotes to local —
  // curation filters intent, the runner caps blast radius. Own-collection data ops flow
  // through the runner's bridge methods
  // (always on); call_tools gates only the generic passthrough. data_collections is deliberately
  // NOT in call_tools: collection discovery IS a cross-collection read and the runner refuses it
  // while cross_collection_read is false — listing it here would advertise a cap that can never
  // execute. A reviewed meta-app that truly needs discovery gets an explicit
  // security:<name>:* overlay (cross_collection_read + call_tools), not a preset grant.
  "library-reviewed": { call_tools: ["data_list"], send_message: false,
    update_context: false, delete_items: "confirm", cross_collection_read: false,
    cross_collection_write: false, settings_write: false, read_source: false,
    file_read: true, file_write: false },
  // unreviewed / pasted: assume hostile.
  unreviewed: { call_tools: [], send_message: false, update_context: false, delete_items: "deny",
    cross_collection_read: false, cross_collection_write: false, settings_write: false, read_source: false,
    file_read: false, file_write: false },
};
// Overlay-value coercion. security_set stores strings, so accept allow/deny/confirm/true/false
// (plus "*", JSON or CSV arrays for call_tools). Unrecognized values keep the tier default —
// a mistyped policy row must fail closed to the preset, not open.
function coerceCap(cap, v) {
  if (cap === "call_tools") {
    if (Array.isArray(v)) return v.map(String);
    const s = String(v ?? "").trim();
    if (s === "*") return ["*"];
    if (s.startsWith("[")) { try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : undefined; } catch { return undefined; } }
    return s ? s.split(",").map((t) => t.trim()).filter(Boolean) : [];
  }
  if (cap === "delete_items") {
    if (v === true || v === "true" || v === "allow") return "allow";
    if (v === false || v === "false" || v === "deny") return "deny";
    return v === "confirm" ? "confirm" : undefined;
  }
  const s = typeof v === "boolean" ? String(v) : String(v ?? "").trim().toLowerCase();
  if (s === "true" || s === "allow") return true;
  if (s === "false" || s === "deny") return false;
  return undefined;
}


// ────────────────────────────────────────────────────────── one budget, one builder, one envelope
// ONE number. Everything that has to fit inside a tool result — a page of rows, a window of source,
// a chunk of file text — derives its size from here; nothing declares its own threshold.
//
// It is a MEASURED CHOICE, not a derived truth: the one client cut we have recorded byte-for-byte
// keeps head 24,000 + a marker + tail 24,000 = 48,020 chars of a model-fed result and discards the
// middle (codex local core, on a recording proxy). 36,000 sits below that with room for the wrapper,
// and above the largest page anyone has asked for. Another client may cut lower; if one is ever
// measured, this is the single place that changes. Do not treat it as a sacred number, and do not
// re-derive per-tool thresholds from it — the whole point of one number is that there is one.
//
// Serialized characters, not raw content length: 32K of adversarial content can serialize past 64K
// (measured), so a raw-length check passes payloads that arrive mutilated.
const RESULT_BUDGET = 36_000;

// The envelope. Three marks in three POSITIONS, because the three ways a result gets damaged are
// distinguishable only by position:
//   `returned` rides BEFORE the bulk  → survives a middle-elision, so counting the rows you can
//                                       actually see and comparing exposes the gap.
//   a continuation mark rides AFTER   → says whether more exists, where a truncated tail cannot
//                                       fake its absence.
//   `eot` is ALWAYS last              → its absence means the tail was cut, full stop.
// ~25 bytes, on every result, unconditionally. It does not ride "when large" or "on hosts known to
// cut": a check that only appears when we predict damage is a check that cannot detect the damage
// we failed to predict. The one measured cut was invisible to us at the time — that is the lesson.
const EOT = "·eot";

/** Serialized size of what we are about to hand over. The only honest way to ask "does this fit". */
const sizeOf = (body) => JSON.stringify(body).length;

/** A WINDOW into one large text — the chunk primitive shared by get_app / app_html /
 *  file_read, so "read something big" has ONE grammar (offset/length in, next_offset out) instead
 *  of a dialect per tool. Derived from RESULT_BUDGET, never a second constant: the caller hands in
 *  `wrap` (slice → the body that will actually ship) and the slice shrinks until the WRAPPED body
 *  fits — which is what makes adversarial content (escaping can double a payload, measured) unable
 *  to push a chunk past the one number. `next_offset` is null exactly when the window ends at the
 *  end — an exact-fit read never pays an empty follow-up round trip. */
function textWindow(whole, { offset, length } = {}, wrap = (t) => t) {
  const total = whole.length;
  const at = Math.max(0, Math.min(Math.floor(Number(offset) || 0), total));
  // length ≤ 0 / NaN falls back to the default window (an explicit zero is a degenerate ask, not a
  // request for the default-by-accident). Units are UTF-16 code units: a window boundary CAN split
  // a surrogate pair — JSON survives it and concatenating windows reassembles exactly, but a
  // non-JS consumer of one lone window may replace the dangling half; documented, not defended.
  const rawLen = Math.floor(Number(length));
  const wantLen = Number.isFinite(rawLen) && rawLen > 0 ? rawLen : (RESULT_BUDGET - 6_000);
  let want = Math.max(1, Math.min(wantLen, Math.max(total - at, 1)));
  let text = whole.slice(at, at + want);
  while (text.length > 1 && sizeOf(wrap(text)) > RESULT_BUDGET) {
    want = Math.ceil(want / 2);
    text = whole.slice(at, at + want);
  }
  const next = at + text.length;
  return { text, offset: at, total, next_offset: next < total ? next : null };
}

/** The four shapes a tool result can take. Same body on BOTH channels — a fact that lives only in
 *  the text never reaches a model on a host that reads structuredContent instead (measured: codex
 *  local core is handed structuredContent and never sees `content`), and a fact that lives only in
 *  structuredContent never reaches one that reads the text (claude.ai). Anything the model must
 *  know goes in both, or it is not delivered.
 *
 *  Fail-closed on brand: a result the wrapper cannot stamp is still a result, so the stamp is
 *  applied last and never throws away the payload.
 *
 *  Four forms, and the names are the point:
 *    ack   — a write happened. One row, never a collection (redesign row #1).
 *    page  — a bounded slice of many rows, always with its true total and how to continue.
 *    chunk — a window into ONE large thing (app source, file text).
 *    fail  — nothing happened, and why. Carries state when state helps the retry.
 */
function envelope(kind, body, { returned, total, next, text }) {
  const head = { ...(returned == null ? {} : { returned }), ...(total == null ? {} : { total }) };
  // `next` distinguishes three states on purpose: undefined = this shape has no cursor concept
  // (omit the key), a string = more exists, null = the walk ENDED here — an explicit null the
  // caller can test, which absence could never say.
  const tail = { ...(next === undefined ? {} : { next_cursor: next }), eot: EOT };
  // `kind` is scaffolding, not wire: which keys are present already says which shape this is, and
  // the envelope's whole justification is that it is small enough to ride unconditionally.
  return { ...head, ...body, ...tail, __kind: kind, __text: text };
}

const answer = {
  ack(body, text) {
    return envelope("ack", body, { text });
  },
  page(body, { returned, total, next, text }) {
    return envelope("page", body, { returned, total, next, text });
  },
  chunk(body, { returned, total, next, text }) {
    return envelope("chunk", body, { returned, total, next, text });
  },
  fail(reason, body = {}, text) {
    // The WHY rides in the body too: a structured-only host must not learn less about a failure
    // than a text-only host (same-body doctrine).
    return envelope("fail", { ok: false, reason, note: text || reason, ...body }, { text: text || reason });
  },
};

/** Turn an envelope into the MCP result shape. The text channel gets the caller's rendering plus
 *  the same three marks, in the same order, so a model reading either channel can run the same
 *  check. `__text` is internal scaffolding and never ships. */
function toMcp(env, { isError = false } = {}) {
  const { __text, __kind, ...body } = env;
  const lines = [];
  if (body.returned != null) lines.push(body.total != null && body.total !== body.returned
    ? `${body.returned} of ${body.total}` : `${body.returned} returned`);
  if (__text) lines.push(__text);
  // "no more" ONLY on the explicit null — a shape with its own continuation vocabulary
  // (next_offset, next_since) says "continue at …" in its text, and stamping "no more" beside it
  // made the text contradict itself (found by the C review).
  if (body.next_cursor) lines.push(`more: pass cursor ${body.next_cursor}`);
  else if (body.next_cursor === null) lines.push("no more");
  lines.push(EOT);
  const out = { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }], structuredContent: body };
  if (isError) out.isError = true;
  return out;
}

const cmdArgs = {
  command_id: z.string().describe("idempotency key — generate a fresh uuid per action"),
  actor: z.enum(["human", "agent"]).optional(),
};

// The module's surface in one place — everything engine.mjs and the tool modules import.
export {
  RO, WRITE, WRITE_NOT_IDEMPOTENT, DESTRUCTIVE,
  itemShape, snapshotSchema, ackSchema, fileMetaShape, capsShape,
  RESERVED_APP_NAMES, SEEDED_APPS, SHARED_PREFS, LOCKED_APPS, SCENE_CATEGORIES,
  tierOf, RUNNER_REQUIRED_HTML, defaultCollectionFor,
  CAP_NAMES, TIER_CAPS, coerceCap,
  cmdArgs,
  RESULT_BUDGET, EOT, sizeOf, textWindow, answer, toMcp,
};
