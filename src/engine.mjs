// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// engine.mjs — builds the complete MCP server (tools + resources) around a store.
// Shared by every entry point: stdio (server.mjs), Streamable HTTP (http.mjs), and the
// in-memory client behind the browser viewer. One engine, many transports — the data is
// the same SQLite regardless of which host connects.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE, EXTENSION_ID } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { COMPONENT_NAME_RE, SETTINGS_COLLECTION, RESERVED_KEY_RE, MAX_FILE_INLINE_BYTES, MAX_FILE_BYTES, MAX_APP_FILE_BYTES, MAX_APP_FILE_COUNT } from "./store.mjs";
import { wrapComponent, wrapLoader } from "./shell.mjs";
import { openFileChannel } from "./files.mjs";
import { listGallery, readGalleryComponent } from "./gallery.mjs";
import { GUIDE } from "./guide.mjs";

// Tool annotations (hints for hosts; OpenAI treats impact annotations as required).
// This engine is a closed local system — nothing here reaches the open world.
const RO = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const itemShape = z.object({
  id: z.string(), group: z.string(), position: z.number(),
  fields: z.record(z.string(), z.any()), version: z.number(),
});
const snapshotSchema = {
  collection: z.string(), items: z.array(itemShape), version: z.number(),
  settings_version: z.number().optional(), // rides on every toResult — the shell's pref-refetch gate
  files_version: z.number().optional(),    // same idea for the file plane — the shell's file-refetch gate
  host: z.string().optional(),
};
// Per-app file metadata (the ref index shape; bytes never ride here — see file_read's data_base64).
const fileMetaShape = z.object({
  component: z.string(), path: z.string(), sha256: z.string(), size: z.number(),
  mime: z.string(), version: z.number(), backend: z.string(),
  created_at: z.string(), updated_at: z.string(),
});
// The pinned caps shape (see CAP_NAMES/TIER_CAPS below) — served by component_html to the
// loader/runner and by component_permissions to the settings Permissions pane.
const capsShape = z.object({
  call_tools: z.array(z.string()), send_message: z.boolean(), update_context: z.boolean(),
  delete_items: z.enum(["allow", "confirm", "deny"]),
  cross_collection_read: z.boolean(), cross_collection_write: z.boolean(),
  settings_write: z.boolean(), read_source: z.boolean(),
  file_read: z.boolean(), file_write: z.boolean(),
});

// Reserved settings groups (docs/settings-design.md §8): a group is a component name, so
// these may never BE component names. Blocks naming only — not writes into those groups.
const RESERVED_COMPONENT_NAMES = new Set(["security", "engine", "host", "system", "shell", "oma"]);

// The SHARED preference catalog (P4 code/UI split): the ENGINE owns what shared prefs exist,
// their types/defaults/labels; the settings component only RENDERS what ui_prefs_schema
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

// Locked SYSTEM components: their UI + logic ship WITH the engine (import-fixed) and must never be
// overwritten by the AI or a (possibly regenerated/hostile) widget through the TOOL surface. The
// seed path and privileged installers write the store DIRECTLY (store.execute), so they are exempt
// by construction — this lock lives at the tool boundary, not in the store. "dashboard" is
// deliberately NOT here (it's the user's editable personal launcher); user apps stay editable too.
const LOCKED_COMPONENTS = new Set(["settings", "gallery"]);

// The 9 scenario-taxonomy category slugs (authoritative source: the shared
// scenario-taxonomy doc, verified 2026-07-22; shared contract per
// docs/manifest-shared-keys.md — do not amend privately). Invalid → warn + drop, never reject.
const SCENE_CATEGORIES = new Set([
  "data-explore", "teach-sim", "input-cocreate", "browse-compare", "local-tools",
  "dev-artifacts", "notation", "ambient-viral", "deliverables",
]);

// ------------------------------------------------------------------ trust tiers & caps
// docs/security-model.md §2.3 step 1 + §3: component_html returns {html, author, tier, caps}.
// The ENGINE is the single reader of security:*/policy:* when building caps; the RUNNER
// (wrapLoader's runner branch) enforces them. No install-tier column exists yet, so every
// non-local author resolves to the STRICTEST tier ("unreviewed"). Exported: /view (http.mjs)
// applies the same tier gate.
export const tierOf = (author) =>
  // "gallery" = install_from_gallery provenance. OSS gallery content is FIRST-PARTY (we author
  // every entry — the same files the seed path installs as local), so it runs DIRECT like any
  // locally-authored component (Leo 2026-07-24: no review exists in OSS because there is nothing
  // to review; the runner + review flow arrive together with the SaaS user-publishing pipeline).
  // The author stamp still tracks provenance + drives gallery update detection.
  author === "agent" || author === "human" || author === "seed" || author === "gallery" ? "local"
  : "unreviewed";
// Fail-closed placeholder for DIRECT render paths (docs/security-model.md §2.3): any surface
// that would hand a component the real window.oma with full trust must refuse non-local tiers
// until a runner exists on that path. Served by the per-component ui:// resource below and by
// /view in http.mjs. Deliberately shell-free — no window.oma, no scripts.
export const RUNNER_REQUIRED_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Sandboxed runner required</title></head><body style="font-family:system-ui;max-width:560px;margin:40px auto;color-scheme:light dark"><h3>Component not rendered</h3><p>This component requires sandboxed runner mode, which isn't available on this path yet. Open it with <code>open_component</code> instead — the universal loader runs non-local components behind a sandboxed runner.</p></body></html>`;
// Pinned caps shape — the runner builds against these exact field names:
//   { call_tools: string[] (["*"] = wildcard sentinel), send_message: bool, update_context: bool,
//     delete_items: "allow"|"confirm"|"deny", cross_collection_read: bool,
//     cross_collection_write: bool, settings_write: bool, read_source: bool }
// CONTRACT: these snake_case names are also the ONLY cap suffixes computeCaps reads from
// policy keys — security:<component>:<cap> / policy:defaults:<tier>:<cap>. A key with any
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
  // gallery installs are first-party and run local/direct instead (see tierOf). When SaaS
  // review arrives: reviewed content renders sandboxed and NEVER promotes to local —
  // curation filters intent, the runner caps blast radius. Own-collection data ops flow
  // through the runner's bridge methods
  // (always on); call_tools gates only the generic passthrough. data_collections is deliberately
  // NOT in call_tools: collection discovery IS a cross-collection read and the runner refuses it
  // while cross_collection_read is false — listing it here would advertise a cap that can never
  // execute. A reviewed meta-component that truly needs discovery gets an explicit
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

// Downloaded into the model's context at initialize — this is where the engine teaches the
// AI WHEN to reach for it, not just what the tools do. Keep it tight; it is always in context.
const INSTRUCTIONS = `open-mcp-apps gives the user persistent, interactive UI components (widgets) backed by data collections shared between you and the user. Data outlives the conversation.

FIRST STOP: when the user asks about THEIR data, boards, lists, trackers, or "what do I have" — in ANY language, not just English — call data_collections BEFORE looking at files, cloud connectors, or other sources. The user's todos, kanbans, habits, notes, queues live HERE. Mention what you find even if you also check other sources.

GETTING STARTED — your job is to BUILD, not to brief: when the user asks how to use open-mcp-apps, for an intro, or to get set up (however they phrase it, e.g. "I just installed this, how do I use it?"), your FIRST move is to build and open ONE app made for them. Do NOT open with an explanation or a feature tour, do NOT list or describe the components that exist, and do NOT ask which app they'd like before building — pick the best fit yourself. Steps: (1) Read THEM silently — from your memory and your past conversations, what do they actually do, track, or keep re-explaining? (ask ONE quick question only if you truly have nothing to go on). (2) Build it now — write a custom component tailored to their world (get_component_guide → save_component), and seed it with their REAL, current content pulled from your memory and past conversations — the actual projects, tasks, links, or items they're already working with — so it opens already reflecting their real work (you're adding a UI on top of their existing habits, not handing them a blank new workflow to populate); never placeholder or invented rows. Then open_component it so it renders immediately; the wow is that it's about THEM — their form AND their data. This first app is their first impression, so make it your BEST work: genuinely polished and visually rich — reach for the visual form that fits the scenario (status cards, a progress ring, a timeline, color-coded state, small inline SVG, clear hierarchy), not a bare list. (3) ONLY AFTER it's on screen: say in one sentence what it is, then offer a couple more you could build — one line each — and let them pick. (4) After that first app is on screen and you've offered a couple more, in your OWN words (conversational, not a form) briefly cover two things: (a) cost — building a NEW component spends some tokens ONCE, but reopening and reusing it later is cheaper than re-describing things in text every time, so apps pay off for anything recurring; (b) their proactivity preference — ask, or infer from what you know of them, whether they want you PROACTIVE (spin up or open an app whenever it fits what they're doing) or ON-REQUEST (only when they ask) — then record it with data_add into the settings collection (group "", key "proactivity", value "proactive" | "on-request") and honor it thereafter. A sentence or two — a light touch after the wow, not a wizard. Never end your first reply without a rendered app; never present the existing components as a menu to choose from. settings and dashboard are engine system apps — never pitch them as example apps. Each app owns one scenario and its own data; skip anything sensitive unless they agree.

WHEN to use it: the user wants to track / manage / organize something over time (todos, kanban, habits, queues, inventories), refers to data across chats ("my todo list"), or wants a clickable UI. WHEN NOT: one-shot visuals or explanations (answer in text/charts), pure discussion, or personal/sensitive data the user hasn't agreed to store — ask before creating a new collection for such data.

PERSISTING FILES: an app can keep FILES too (images, PDFs, documents, exports) — anything too big or binary for a data item. When the user hands you a file worth keeping with an app, or you generate one, store it under that app with file_write (file_list / file_read / file_delete manage them; file_read returns the bytes only in structuredContent, so it never floods your context). Files over the single-call limit use the chunked path: file_write_begin → file_write_chunk (repeat) → file_write_commit. Files persist per-app across chats, like collections. Ask first before storing anything sensitive.

SYSTEM APPS (open via open_component): "dashboard" = overview cards of all your collections; "settings" = preferences + usage guide + About + a browsable library of your components; "gallery" = a library of ready-made high-quality apps the user can browse and install (or install one directly with install_from_gallery when they ask for something it covers). These are engine-provided and privileged — allowed to span collections. Everything else is an app built for one scenario and its own data; that independence is exactly what lets it reopen cleanly in a later chat.

__PROACTIVITY_STANCE__

SHOW UI vs READ data:
- A topic maps to an EXISTING app (list_components / data_collections hits one) and it isn't already on screen → OPEN it (open_component {component, collection?}) as part of answering — don't just recite its data as text. Opening an app that already exists is nearly free, so reach for it by default (asked "how's project X going?" and a board for it exists → show the board, don't narrate numbers).
- A component's real name comes from list_components, NOT your memory of the chat — verify before you open or name an existing app. The registry is the source of truth and your recollection drifts: a gallery install, an earlier chat, or a rename may differ from what you think was built. If the name you expect isn't there, say what IS there instead of guessing or claiming something went missing.
- The user explicitly asks to SEE or OPERATE something → open_component, the ONE tool that renders any component. Don't re-open a widget already visible in this chat.
- You only need a fact to answer and no app fits → data_list / data_collections (renders nothing).
- Acting on the user's behalf ("mark X done") → data_* tools; any visible widget auto-refreshes within ~20s. Confirm in text; open the relevant board if one isn't already shown.
- Unsure where data lives → data_collections.

Creating UI: check list_components first; prefer REUSING a component on a new collection (open_component {component, collection}) over creating near-duplicates. If nothing fits: get_component_guide → save_component → open_component immediately.`;

// Read a global settings pref (group "") from the shared store — one cheap settings snapshot.
function readPref(store, key) {
  try {
    for (const it of store.snapshot(SETTINGS_COLLECTION).items)
      if (String(it.fields?.key ?? "") === key) return it.fields.value;
  } catch {}
  return undefined;
}

// INSTRUCTIONS carry a __PROACTIVITY_STANCE__ placeholder resolved per server start from the user's
// stored `proactivity` pref (set during onboarding, step 4). Low-frequency setting → reading it once
// at createEngine time is enough; a change takes effect on the next host restart.
function buildInstructions(store) {
  const pref = readPref(store, "proactivity");
  const stance = pref === "proactive"
    ? "PROACTIVITY — the user chose PROACTIVE: when a topic maps to an existing app, open it unprompted; when a recurring need has no app yet, offer or just build one (a NEW build costs tokens once — a quick heads-up before a big one is courteous, not a blocker)."
    : pref === "on-request"
    ? "PROACTIVITY — the user chose ON-REQUEST: build or create apps only when asked. Exception: when they clearly want to SEE something that ALREADY has an app, open it anyway — showing an existing app is nearly free."
    : "PROACTIVITY — no preference set yet: open an EXISTING matching app proactively (nearly free), but PROPOSE building a NEW one (which costs tokens once) rather than building unprompted. Settle this with the user during onboarding.";
  return INSTRUCTIONS.replace("__PROACTIVITY_STANCE__", stance);
}

/**
 * Build a fully-wired McpServer.
 * @param store  the shared store (one per process — every transport sees the same data)
 * @param opts.hostLabel  fixed host label (e.g. "browser-viewer"); when absent, the host is
 *                        identified from the MCP initialize clientInfo (Claude/ChatGPT/...).
 * @param opts.instructions  replace the default initialize instructions wholesale (hosted
 *                        deployments carry their own copy; default = buildInstructions).
 */
export function createEngine(store, { hostLabel, instructions } = {}) {
  const server = new McpServer(
    { name: "open-mcp-apps", version: "0.1.0" },
    {
      instructions: instructions ?? buildInstructions(store),
      // Advertise the MCP Apps extension (2026-07-28 RC makes extensions first-class;
      // strict hosts may otherwise assume no ui:// support despite _meta.ui on tools).
      capabilities: { extensions: { [EXTENSION_ID]: {} } },
    },
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

  function summarize(snapshot) {
    const groups = new Map();
    for (const it of snapshot.items) {
      if (!groups.has(it.group)) groups.set(it.group, []);
      groups.get(it.group).push(it);
    }
    if (!snapshot.items.length) return "(empty collection)";
    return [...groups.entries()]
      .map(([g, items]) => `${g || "(ungrouped)"} (${items.length}):\n` +
        items.map((i) => `  - ${i.fields.title ?? i.fields.text ?? i.fields.name ?? JSON.stringify(i.fields).slice(0, 60)}${i.fields.done ? " ✓" : ""}`).join("\n"))
      .join("\n");
  }
  function toResult(snapshot, note) {
    const text = (note ? note + "\n\n" : "") +
      `Collection "${snapshot.collection}" (v${snapshot.version}):\n${summarize(snapshot)}`;
    return { content: [{ type: "text", text }], structuredContent: { ...snapshot, host: hostName() } };
  }
  function failNote(r) {
    if (r.error === "not_found") return "That item no longer exists — refresh.";
    if (r.error === "command_id_reused") return "That command_id was already used by a DIFFERENT command — nothing was done. Use a fresh uuid per action.";
    if (r.error === "schema_violation") return `schema_violation — rejected by the collection's manifest (declared by "${r.manifest_component}"): ${(r.violations || []).join("; ")}.`;
    if (r.conflict) return `Version conflict (expected v${r.expected}) — refresh and retry.`;
    if (r.error) return `Command failed: ${r.error}.`;
    return "Command failed.";
  }
  const fail = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });
  const FILE_ERRORS = {
    quota_exceeded: "This app's file storage quota is full — delete some files first.",
    too_many_files: "This app has too many files — delete some first.",
    total_quota_exceeded: "Global file storage is full.",
    total_too_many_files: "Global file storage has too many files.",
    file_too_large: "That file exceeds the per-file size limit.",
    bad_path: "Invalid file path — use a simple name (no '..', absolute paths, backslashes, or control characters).",
    bad_component: "Invalid app name for a file.",
    bad_sha256: "Internal error: bad content hash.",
    bad_size: "Invalid file size.",
    not_found: "No such file — refresh.",
    upload_not_found: "No such upload (it may have expired or been committed/aborted) — start again with file_write_begin.",
    upload_expired: "That upload expired or its staging data was lost — start again with file_write_begin.",
    upload_busy: "That upload is mid-operation — send chunks one at a time, in order.",
    too_many_uploads: "Too many uploads in flight — commit or abort one first.",
    backend_no_staging: "This file backend doesn't support chunked uploads.",
  };
  const fileFailNote = (r) =>
    r.conflict ? `Version conflict (expected v${r.expected}) — refresh and retry.`
    : r.error === "command_id_reused" ? "That command_id was already used by a DIFFERENT command — use a fresh uuid."
    : FILE_ERRORS[r.error] || `File operation failed: ${r.error || "unknown"}.`;

  // ---------------------------------------------------------- dynamic component wiring
  // Per-component open_<name> tools are OPT-IN (OMA_DYNAMIC_TOOLS=1). Every tool costs a
  // separate host permission prompt and the tool list balloons with the registry — the
  // universal open_component covers all components behind ONE permission grant, and never
  // suffers the host's slow tools/list_changed propagation.
  const DYNAMIC_TOOLS = process.env.OMA_DYNAMIC_TOOLS === "1";
  const registered = new Set();
  function registerComponent(name) {
    if (registered.has(name)) return; // callbacks read the registry live; updates need no re-register
    registered.add(name);
    const uri = `ui://open-mcp-apps/${name}.html`;

    registerAppResource(server, `component-${name}`, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
      const comp = store.getComponent(name);
      if (!comp) throw new Error(`component ${name} not found`);
      // Tier gate (docs/security-model.md §2.3): this per-component resource serves DIRECT mode
      // (wrapComponent = the real window.oma, full trust) and has no runner branch — the
      // loader's runnerMount covers only the open_component path. Non-local tiers fail closed
      // to the placeholder; every component today is local, so nothing changes until one isn't.
      if (tierOf(comp.author) !== "local")
        return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: RUNNER_REQUIRED_HTML }] };
      return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: wrapComponent(comp.html, { component: name, version: comp.version }) }] };
    });

    if (!DYNAMIC_TOOLS) return;
    registerAppTool(
      server,
      `open_${name.replaceAll("-", "_")}`,
      {
        title: `Open ${name}`,
        annotations: RO,
        description: `Open the "${name}" component as an interactive widget — use when the user wants to SEE or OPERATE this data (to merely read facts, use data_list instead). Optionally pass a collection name to bind it to a specific data collection (default: "${name}").`,
        inputSchema: { collection: z.string().optional().describe(`data collection to bind (default "${name}")`) },
        outputSchema: snapshotSchema,
        _meta: { ui: { resourceUri: uri } },
      },
      async (a) => toResult(store.snapshot((a && a.collection) || name)),
    );
  }
  for (const c of store.listComponents()) registerComponent(c.name);

  // ------------------------------------------------- the universal opener (static tool)
  const LOADER_URI = "ui://open-mcp-apps/app.html";
  registerAppResource(server, "component-loader", LOADER_URI, { mimeType: RESOURCE_MIME_TYPE },
    async () => ({ contents: [{ uri: LOADER_URI, mimeType: RESOURCE_MIME_TYPE, text: wrapLoader() }] }));

  registerAppTool(
    server,
    "open_component",
    {
      title: "Open any component",
      annotations: RO,
      description: "Open ANY component from the registry by name as an interactive widget — use when the user wants to SEE or OPERATE the data (to merely read facts, use data_list — no UI). Works IMMEDIATELY for components saved moments ago in this same chat (the dedicated open_<name> tools may take a while to appear). Prefer reusing a component on a different collection over creating near-duplicate components.",
      inputSchema: {
        component: z.string().describe("component name in the registry (see list_components)"),
        collection: z.string().optional().describe("data collection to bind (default: same as component)"),
      },
      outputSchema: { ...snapshotSchema, component: z.string() },
      _meta: { ui: { resourceUri: LOADER_URI } },
    },
    async (a) => {
      const comp = store.getComponent(a.component);
      if (!comp) return fail(`No component "${a.component}" in the registry. list_components shows what exists.`);
      const r = toResult(store.snapshot(a.collection || a.component));
      r.structuredContent = { ...r.structuredContent, component: a.component };
      return r;
    },
  );

  // caps = tier preset ⊕ policy:defaults:<tier>:<cap> ⊕ security:<component>:<cap> (last wins).
  // Rows come from the settings snapshot scanned in items[] order (the same last-wins scan the
  // pref merge uses). Overlays apply verbatim — security_set is the only writer and is privileged.
  function computeCaps(component, tier) {
    const preset = TIER_CAPS[tier] || TIER_CAPS.unreviewed;
    const caps = { ...preset, call_tools: [...preset.call_tools] };
    const byKey = new Map();
    for (const it of store.snapshot(SETTINGS_COLLECTION).items) {
      const k = String(it.fields?.key ?? "");
      if (k) byKey.set(k, it.fields.value);
    }
    for (const cap of CAP_NAMES) {
      for (const key of [`policy:defaults:${tier}:${cap}`, `security:${component}:${cap}`]) {
        if (!byKey.has(key)) continue;
        const v = coerceCap(cap, byKey.get(key));
        if (v !== undefined) caps[cap] = v;
      }
    }
    return caps;
  }

  server.registerTool(
    "component_html",
    {
      title: "Component HTML (internal)",
      annotations: RO,
      description: "Internal: returns raw component HTML plus its trust tier and capability grants for the universal loader widget. Not useful to call directly — use get_component to read source.",
      inputSchema: { name: z.string() },
      outputSchema: {
        name: z.string(), version: z.number(), html: z.string(),
        author: z.string(),
        tier: z.enum(["local", "library-reviewed", "unreviewed"]),
        caps: capsShape,
      },
    },
    async (a) => {
      const comp = store.getComponent(a.name);
      if (!comp) return fail(`No component "${a.name}".`);
      const tier = tierOf(comp.author);
      return {
        content: [{ type: "text", text: `(component "${comp.name}" v${comp.version}, ${comp.html.length} chars, tier ${tier} — consumed by the loader widget)` }],
        structuredContent: { name: comp.name, version: comp.version, html: comp.html, author: comp.author, tier, caps: computeCaps(comp.name, tier) },
      };
    },
  );

  // -------------------------------------------------------------------- creation loop
  server.registerTool(
    "get_component_guide",
    {
      title: "Component authoring guide",
      annotations: RO,
      description: "READ THIS FIRST before creating or editing a component. Returns the window.oma API contract, available CSS design tokens, the data model, and a minimal working component template.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: GUIDE }] }),
  );

  server.registerTool(
    "list_components",
    {
      title: "List components",
      annotations: RO,
      description: "List all UI components in the registry (reusable across all chats). If the UI the user wants already exists, prefer opening it over creating a new one.",
      inputSchema: {},
    },
    async () => {
      const comps = store.listComponents();
      const text = comps.length
        ? comps.map((c) => `- ${c.name} v${c.version} (${c.html_size} chars, by ${c.author}) — ${c.description || "no description"}  → open_${c.name.replaceAll("-", "_")}`).join("\n")
        : "Registry is empty. Call get_component_guide, then save_component to create the first one.";
      return { content: [{ type: "text", text }], structuredContent: { components: comps } };
    },
  );

  server.registerTool(
    "get_component",
    {
      title: "Get component source",
      annotations: RO,
      description: "Read a component's current HTML source (e.g. to improve or fix it, then save_component again).",
      inputSchema: { name: z.string() },
    },
    async (a) => {
      const comp = store.getComponent(a.name);
      if (!comp) return fail(`No component "${a.name}". list_components shows what exists.`);
      return { content: [{ type: "text", text: `// ${comp.name} v${comp.version}\n${comp.html}` }] };
    },
  );

  server.registerTool(
    "save_component",
    {
      title: "Save component",
      annotations: WRITE,
      description: "Create or update a UI component in the persistent registry. The HTML must follow the contract from get_component_guide (single self-contained HTML using window.oma; no external resources). After saving, open it IMMEDIATELY with open_component. Saving an existing name creates a new version (history kept).",
      inputSchema: {
        name: z.string().describe("component name, ^[a-z][a-z0-9-]{0,31}$ (e.g. 'kanban', 'habit-tracker')"),
        html: z.string().describe("complete self-contained HTML document using window.oma"),
        description: z.string().optional().describe("one line: what this component shows and what data fields it uses"),
        scene: z.object({
          category_id: z.string().nullable().describe("one of the 9 scenario-taxonomy category slugs (e.g. 'input-cocreate', 'local-tools'); null clears the scene"),
          tags: z.array(z.string()).optional(),
        }).nullable().optional().describe("optional Library metadata. Omit to keep the existing scene; pass null (or category_id null) to CLEAR it; an unknown category_id warns and keeps the existing scene (the save still succeeds)"),
        manifest: z.object({
          collections: z.record(z.string(), z.object({
            fields: z.record(z.string(), z.object({
              type: z.enum(["string", "number", "boolean", "object", "array"]),
              required: z.boolean().optional(),
              enum: z.array(z.any()).optional().describe("allowed values (strict equality)"),
            })),
            strict: z.boolean().optional().describe("true = reject undeclared fields"),
          })),
        }).nullable().optional().describe("optional field contract for the collections this component owns — once declared, the STORE validates every write (AI, widget, rpc) against it: required/type/enum, plus undeclared-field rejection when strict. Omit to keep the existing manifest; null clears it. Manifest-less collections stay free-form"),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
      },
    },
    async (a) => {
      if (!COMPONENT_NAME_RE.test(a.name || "")) return fail("Invalid name: must match ^[a-z][a-z0-9-]{0,31}$ (lowercase, digits, hyphens).");
      if (RESERVED_COMPONENT_NAMES.has(a.name)) return fail(`"${a.name}" is a reserved namespace (settings groups security/engine/host/system/shell/oma) — pick another name.`);
      if (LOCKED_COMPONENTS.has(a.name)) return fail(`"${a.name}" is a locked system component — its UI ships with the engine and can't be overwritten here. (dashboard and your own apps are editable.)`);
      const warnings = [];
      const notes = [];
      // scene is TRI-STATE: omitted → preserve the stored scene; explicit null (or
      // {category_id: null}) → CLEAR it; valid object → set. An invalid slug preserves the
      // existing scene and the warning SAYS so — never a silent keep under a bare success.
      let scene; // undefined = preserve (the store only touches the stored scene when defined)
      if (a.scene === null || (a.scene && a.scene.category_id == null)) {
        scene = null;
        notes.push("Scene metadata cleared.");
      } else if (a.scene && !SCENE_CATEGORIES.has(a.scene.category_id)) {
        warnings.push(`Unknown scene.category_id "${a.scene.category_id}" — scene NOT changed (the existing scene, if any, is kept). Valid: ${[...SCENE_CATEGORIES].join(", ")}.`);
      } else if (a.scene) {
        scene = a.scene;
      }
      if (!/\boma\s*\./.test(a.html)) warnings.push("HTML never references the oma API — it will render but won't load or save any data.");
      if (/src\s*=\s*["']https?:|href\s*=\s*["']https?:|@import|fetch\s*\(/i.test(a.html)) warnings.push("External URLs detected — the sandbox CSP blocks all external resources; the component may break. Inline everything.");
      if (/React\.createElement|ReactDOM|from\s+["']react["']|import\s+React|@babel\/standalone|text\/babel/.test(a.html)) warnings.push("React/JSX/Babel detected — widgets have no React runtime or JSX compiler (this is not claude.ai Artifacts). Rewrite with vanilla DOM per get_component_guide.");
      const r = store.execute({
        type: "save_component", command_id: a.command_id || randomUUID(),
        name: a.name, html: a.html, description: a.description || "", scene, manifest: a.manifest, actor: "agent", host: hostName(),
      });
      if (!r.ok) return fail(r.error === "bad_manifest" ? `Invalid manifest: ${r.detail}.` : failNote(r));
      registerComponent(a.name);
      // A manifest set over collections with EXISTING rows: warn about rows that don't conform.
      // (Writes stay possible — the store delta-validates, so legacy rows can be edited but never
      // made worse — but the author should know the contract isn't fully met yet.)
      if (a.manifest && a.manifest.collections) {
        for (const [collName, spec] of Object.entries(a.manifest.collections)) {
          try {
            const bad = store.snapshot(collName).items.filter((i) => {
              const viol = [];
              for (const [fn, f] of Object.entries(spec.fields || {})) {
                const v = i.fields[fn];
                if (v == null) { if (f.required) viol.push(fn); continue; }
                const t = Array.isArray(v) ? "array" : typeof v;
                if (t !== f.type) viol.push(fn);
                else if (f.enum && !f.enum.includes(v)) viol.push(fn);
              }
              return viol.length > 0;
            }).length;
            if (bad) warnings.push(`Manifest set on "${collName}", but ${bad} existing item(s) don't conform — they stay editable (violations can't get worse) but won't validate until fixed.`);
          } catch { /* collection may not exist yet — nothing to warn about */ }
        }
      }
      const lines = [
        `Saved "${a.name}" v${r.version}${r.created ? " (new component)" : " (updated)"}.`,
        ...notes,
        `Show it NOW with: open_component {component: "${a.name}"} — works immediately.`,
        `It persists and is reusable in every future chat.`,
        ...warnings.map((w) => `⚠ ${w}`),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ------------------------------------------------------------------ generic data tools
  const cmdArgs = {
    command_id: z.string().describe("idempotency key — generate a fresh uuid per action"),
    actor: z.enum(["human", "agent"]).optional(),
  };
  const run = (a, type) => store.execute({ type, ...a, actor: a.actor || "agent", host: hostName() });

  server.registerTool(
    "data_list",
    {
      title: "List collection data",
      annotations: RO,
      description: "Read items in a data collection WITHOUT rendering any UI — use this to answer questions or decide; use open_component / open_<name> when the user should see the widget. For anything but small collections, pass `limit` (paged: response carries next_cursor to continue) and narrow with `group` / `match` instead of reading everything. Pages are a live keyset walk: items reordered/moved WHILE you paginate can be skipped or repeated — re-list from the start if exact completeness matters during heavy concurrent editing.",
      inputSchema: {
        collection: z.string(),
        group: z.string().optional().describe("only items in this group/lane"),
        match: z.record(z.string(), z.any()).optional().describe("exact-match filter on top-level field values, e.g. {\"done\": false}"),
        limit: z.number().optional().describe("page size (1-500). Passing any of limit/cursor/group/match switches to the paged shape with next_cursor"),
        cursor: z.string().optional().describe("opaque cursor from the previous page's next_cursor"),
      },
      outputSchema: {
        ...snapshotSchema,
        total: z.number().optional().describe("total items in the collection/group (pre-filter)"),
        next_cursor: z.string().nullable().optional().describe("pass back as `cursor` for the next page; null = no more"),
      },
    },
    async (a) => {
      // Plain call (collection only) keeps the full-snapshot contract — the widget/back-compat path.
      if (a.group == null && a.match == null && a.limit == null && (a.cursor == null || a.cursor === ""))
        return toResult(store.snapshot(a.collection));
      const r = store.queryItems(a.collection, { group: a.group, match: a.match, limit: a.limit, cursor: a.cursor });
      if (r.error) return fail(r.error === "bad_cursor" ? "Invalid cursor — restart from the first page (omit cursor)." : `Query failed: ${r.error}.`);
      const v = store.dataVersion();
      const text = `Collection "${a.collection}"${a.group != null ? ` group "${a.group}"` : ""}: ${r.items.length} item(s) of ${r.total}${r.next_cursor ? " (more pages — pass next_cursor)" : ""}:\n` +
        (r.items.map((i) => `  - [${i.group || "(ungrouped)"}] ${i.fields.title ?? i.fields.text ?? i.fields.name ?? JSON.stringify(i.fields).slice(0, 60)}`).join("\n") || "  (none matched)");
      return {
        content: [{ type: "text", text }],
        structuredContent: { collection: a.collection, items: r.items, version: v.seq, settings_version: v.settings_version, files_version: v.files_version, host: hostName(), total: r.total, next_cursor: r.next_cursor },
      };
    },
  );

  server.registerTool(
    "data_version",
    {
      title: "Data change probe",
      annotations: RO,
      description: "The cheapest possible change check: returns the global change counter (seq) plus settings/files sub-counters. If seq hasn't moved since you last looked, NOTHING changed anywhere — skip re-reading. Widgets use this for adaptive polling; you can too before re-listing a collection.",
      inputSchema: {},
      outputSchema: { seq: z.number(), settings_version: z.number(), files_version: z.number(), schema_version: z.number() },
    },
    async () => {
      const v = store.dataVersion();
      return { content: [{ type: "text", text: `seq ${v.seq} (settings ${v.settings_version}, files ${v.files_version}, schema v${v.schema_version})` }], structuredContent: v };
    },
  );

  server.registerTool(
    "data_collections",
    {
      title: "List collections",
      annotations: RO,
      description: "List every data collection that exists (name, item count, last activity). Use when unsure where data lives, what boards the user has, or which collection to bind a component to. Renders no UI.",
      inputSchema: {},
      outputSchema: {
        collections: z.array(z.object({
          collection: z.string(), items: z.number(), last_activity: z.string().nullable(),
        })),
      },
    },
    async () => {
      const collections = store.listCollections();
      const text = collections.length
        ? collections.map((c) => `- ${c.collection}: ${c.items} item(s), last activity ${c.last_activity || "never"}`).join("\n")
        : "No collections yet.";
      return { content: [{ type: "text", text }], structuredContent: { collections } };
    },
  );

  server.registerTool(
    "data_add_item",
    {
      title: "Add item",
      annotations: WRITE,
      description: "Add an item to a collection. `group` is the component-defined lane/section (e.g. a kanban column); `fields` is a JSON object (e.g. {title, done, notes…}).",
      inputSchema: {
        ...cmdArgs, collection: z.string(), group: z.string().optional(),
        fields: z.record(z.string(), z.any()), position: z.number().optional(),
      },
      outputSchema: snapshotSchema,
    },
    async (a) => {
      const r = run(a, "add_item");
      return r.ok ? toResult(r.snapshot, r.idempotent ? "Already added." : "Added.") : fail(failNote(r));
    },
  );

  server.registerTool(
    "data_update_item",
    {
      title: "Update item fields",
      annotations: WRITE,
      description: "Shallow-merge fields into an item (set a key to null to remove it). Uses optimistic concurrency.",
      inputSchema: {
        ...cmdArgs, id: z.string(), fields: z.record(z.string(), z.any()),
        expected_version: z.number().optional().describe("the item version you last saw"),
      },
      outputSchema: snapshotSchema,
    },
    async (a) => {
      const r = run(a, "update_item");
      return r.ok ? toResult(r.snapshot, r.idempotent ? "Already updated." : "Updated.") : r.snapshot ? toResult(r.snapshot, failNote(r)) : fail(failNote(r));
    },
  );

  server.registerTool(
    "data_move_item",
    {
      title: "Move item",
      annotations: WRITE,
      description: "Move an item to another group and/or position (e.g. kanban column).",
      inputSchema: {
        ...cmdArgs, id: z.string(), group: z.string().optional(),
        position: z.number().optional(), expected_version: z.number().optional(),
      },
      outputSchema: snapshotSchema,
    },
    async (a) => {
      const r = run(a, "move_item");
      return r.ok ? toResult(r.snapshot, r.idempotent ? "Already moved." : "Moved.") : r.snapshot ? toResult(r.snapshot, failNote(r)) : fail(failNote(r));
    },
  );

  server.registerTool(
    "data_delete_item",
    {
      title: "Delete item",
      annotations: DESTRUCTIVE,
      description: "Delete an item permanently.",
      inputSchema: { ...cmdArgs, id: z.string(), expected_version: z.number().optional() },
      outputSchema: snapshotSchema,
    },
    async (a) => {
      const r = run(a, "delete_item");
      return r.ok ? toResult(r.snapshot, r.idempotent ? "Already deleted." : "Deleted.") : r.snapshot ? toResult(r.snapshot, failNote(r)) : fail(failNote(r));
    },
  );

  // ------------------------------------------------------------ per-app file plane (scope b)
  // Opaque user-file storage the AI uses to stash + retrieve files the user hands it (chat
  // attachments, generated exports). Bytes ride a swappable backend (src/files.mjs); these tools
  // mirror the data_* shape. The file_read/file_write caps exist as the tier SEAM but are NOT gated
  // here — direct/AI use is local-tier (full). The runner enforces them for untrusted components
  // once tiering lands. We store bytes OPAQUELY: any file, accepted wholesale, never interpreted.
  server.registerTool(
    "file_list",
    {
      title: "List app files",
      annotations: RO,
      description: "List the files an app (component) has stored: names, sizes, versions, total usage. These are opaque user files (attachments, exports) the app keeps — separate from its structured data collection. Renders no UI.",
      inputSchema: { component: z.string().describe("the app whose files to list"), prefix: z.string().optional().describe("only paths starting with this prefix") },
      outputSchema: { component: z.string(), files: z.array(fileMetaShape), usage: z.object({ bytes: z.number(), count: z.number() }), files_version: z.number() },
    },
    async (a) => {
      if (!COMPONENT_NAME_RE.test(a.component || "")) return fail("Invalid app name.");
      const { files } = fileChannel.list(a.component, a.prefix);
      const usage = store.fileUsage(a.component);
      const text = files.length
        ? `Files for "${a.component}" (${usage.count}, ${usage.bytes} bytes):\n` + files.map((f) => `  - ${f.path} (${f.mime}, ${f.size} bytes, v${f.version})`).join("\n")
        : `No files stored for "${a.component}".`;
      return { content: [{ type: "text", text }], structuredContent: { component: a.component, files, usage: { bytes: usage.bytes, count: usage.count }, files_version: store.filesVersion() } };
    },
  );

  server.registerTool(
    "file_read",
    {
      title: "Read an app file",
      annotations: RO,
      description: "Read one file an app has stored. Bytes come back base64 in structuredContent.data_base64 — the text summary carries only metadata, so calling this does NOT dump the file into your context. Files over the inline limit return metadata only.",
      inputSchema: { component: z.string(), path: z.string().describe("the file's logical name") },
      outputSchema: { component: z.string(), path: z.string(), mime: z.string(), size: z.number(), sha256: z.string(), version: z.number(), data_base64: z.string().optional(), too_large_to_inline: z.boolean().optional() },
    },
    async (a) => {
      if (!COMPONENT_NAME_RE.test(a.component || "")) return fail("Invalid app name.");
      const meta = fileChannel.stat(a.component, a.path);
      if (!meta) return fail(`No file "${a.path}" stored for "${a.component}". Use file_list to see what exists.`);
      const base = { component: a.component, path: a.path, mime: meta.mime, size: meta.size, sha256: meta.sha256, version: meta.version };
      if (meta.size > MAX_FILE_INLINE_BYTES)
        return { content: [{ type: "text", text: `(file "${a.path}", ${meta.mime}, ${meta.size} bytes — over the ${MAX_FILE_INLINE_BYTES}-byte inline limit; not returned inline)` }], structuredContent: { ...base, too_large_to_inline: true } };
      let got;
      try { got = await fileChannel.get(a.component, a.path); }
      catch { return fail(`File "${a.path}" failed its integrity check (content-hash mismatch) — it may be corrupted.`); }
      if (!got) return fail(`File "${a.path}" is missing its stored bytes.`);
      return { content: [{ type: "text", text: `(file "${a.path}", ${meta.mime}, ${meta.size} bytes — bytes delivered in structuredContent.data_base64)` }], structuredContent: { ...base, data_base64: got.bytes.toString("base64") } };
    },
  );

  server.registerTool(
    "file_write",
    {
      title: "Store an app file",
      annotations: WRITE,
      description: "Store a file for an app (create or overwrite by path). `data_base64` is the file bytes, base64-encoded — pass any file the user gave you or that you generated. Overwriting an existing path bumps its version. Single-call writes are limited to a few MiB. Files persist and are the app's own, reusable across chats.",
      inputSchema: {
        command_id: z.string().describe("idempotency key — a fresh uuid per write"),
        component: z.string().describe("the app this file belongs to"),
        path: z.string().describe("logical file name, e.g. 'receipt.pdf' or 'exports/2026-q1.csv'"),
        data_base64: z.string().describe("file bytes, base64-encoded"),
        mime: z.string().optional().describe("content type, e.g. 'image/png' (default application/octet-stream)"),
        expected_version: z.number().optional().describe("the version you last saw, for optimistic concurrency (optional)"),
      },
      outputSchema: { component: z.string(), path: z.string(), size: z.number(), mime: z.string(), sha256: z.string(), version: z.number(), files_version: z.number() },
    },
    async (a) => {
      let bytes;
      try { bytes = Buffer.from(a.data_base64 || "", "base64"); } catch { return fail("data_base64 is not valid base64."); }
      if (bytes.length > MAX_FILE_INLINE_BYTES) return fail(`Single-call write is limited to ${MAX_FILE_INLINE_BYTES} bytes; this file is ${bytes.length}. (A chunked/streaming write path for large files is coming.)`);
      const r = await fileChannel.put(a.component, a.path, bytes, { mime: a.mime, command_id: a.command_id, expected_version: a.expected_version });
      if (!r.ok) return fail(fileFailNote(r));
      const m = r.meta;
      return { content: [{ type: "text", text: `Stored "${a.path}" (${m.size} bytes, ${m.mime}, v${m.version}) for "${a.component}".${r.idempotent ? " (already stored)" : ""}` }], structuredContent: { component: a.component, path: a.path, size: m.size, mime: m.mime, sha256: m.sha256, version: m.version, files_version: store.filesVersion() } };
    },
  );

  // Chunked write — the large-file path (single-shot file_write caps at MAX_FILE_INLINE_BYTES,
  // the per-file ceiling is MAX_FILE_BYTES). begin → chunk (in order, one at a time) → commit;
  // bytes stream to backend staging, so nothing big ever sits in RAM, and commit lands through
  // the exact same ref/quota/idempotency transaction as a single-shot write.
  server.registerTool(
    "file_write_begin",
    {
      title: "Begin a chunked file write",
      annotations: WRITE,
      description: `Start a chunked upload for a file too big for file_write's single call. Returns an upload_id; send the bytes in order with file_write_chunk (each chunk up to ~${Math.floor(MAX_FILE_INLINE_BYTES / 1024 / 1024)} MiB of raw bytes), then file_write_commit names the file. Uploads expire after 30 idle minutes; per-file ceiling ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MiB.`,
      inputSchema: { component: z.string().describe("the app this file will belong to") },
      outputSchema: { upload_id: z.string(), chunk_limit_bytes: z.number(), file_limit_bytes: z.number() },
    },
    async (a) => {
      const r = await fileChannel.beginUpload(a.component);
      if (!r.ok) return fail(fileFailNote(r));
      return {
        content: [{ type: "text", text: `Upload started (id ${r.upload_id}). Send chunks in order with file_write_chunk, then file_write_commit.` }],
        structuredContent: { upload_id: r.upload_id, chunk_limit_bytes: MAX_FILE_INLINE_BYTES, file_limit_bytes: MAX_FILE_BYTES },
      };
    },
  );

  server.registerTool(
    "file_write_chunk",
    {
      title: "Append a chunk to an upload",
      annotations: WRITE,
      description: "Append the next chunk of bytes (base64) to an upload started with file_write_begin. Send chunks strictly in order, one at a time.",
      inputSchema: { upload_id: z.string(), data_base64: z.string().describe("this chunk's bytes, base64-encoded") },
      outputSchema: { upload_id: z.string(), bytes: z.number().describe("total bytes staged so far") },
    },
    async (a) => {
      const bytes = Buffer.from(a.data_base64 || "", "base64");
      if (!bytes.length) return fail("Empty chunk — send actual bytes.");
      if (bytes.length > MAX_FILE_INLINE_BYTES) return fail(`Chunk too large (${bytes.length} bytes) — keep each chunk at or under ${MAX_FILE_INLINE_BYTES} bytes.`);
      const r = await fileChannel.appendUpload(a.upload_id, bytes);
      if (!r.ok) return fail(fileFailNote(r));
      return { content: [{ type: "text", text: `${r.bytes} bytes staged.` }], structuredContent: { upload_id: a.upload_id, bytes: r.bytes } };
    },
  );

  server.registerTool(
    "file_write_commit",
    {
      title: "Commit a chunked file write",
      annotations: WRITE,
      description: "Finalize an upload as an app file (create or overwrite by path) — the chunked equivalent of file_write. The upload is consumed either way; on failure, restart from file_write_begin.",
      inputSchema: {
        upload_id: z.string(),
        path: z.string().describe("logical file name, e.g. 'video.mp4' or 'exports/backup.zip'"),
        mime: z.string().optional(),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
        expected_version: z.number().optional(),
      },
      outputSchema: { component: z.string(), path: z.string(), size: z.number(), mime: z.string(), sha256: z.string(), version: z.number(), files_version: z.number() },
    },
    async (a) => {
      const r = await fileChannel.commitUpload(a.upload_id, a.path, { mime: a.mime, command_id: a.command_id, expected_version: a.expected_version });
      if (!r.ok) return fail(fileFailNote(r));
      const m = r.meta;
      return {
        content: [{ type: "text", text: `Stored "${m.path}" (${m.size} bytes, ${m.mime}, v${m.version}) for "${m.component}".` }],
        structuredContent: { component: m.component, path: m.path, size: m.size, mime: m.mime, sha256: m.sha256, version: m.version, files_version: store.filesVersion() },
      };
    },
  );

  server.registerTool(
    "file_write_abort",
    {
      title: "Abort a chunked file write",
      annotations: WRITE,
      description: "Discard an in-flight upload and its staged bytes. Safe to call on an already-gone upload.",
      inputSchema: { upload_id: z.string() },
      outputSchema: { upload_id: z.string(), aborted: z.boolean() },
    },
    async (a) => {
      await fileChannel.abortUpload(a.upload_id);
      return { content: [{ type: "text", text: "Upload discarded." }], structuredContent: { upload_id: a.upload_id, aborted: true } };
    },
  );

  server.registerTool(
    "file_delete",
    {
      title: "Delete an app file",
      annotations: DESTRUCTIVE,
      description: "Permanently delete one file an app has stored.",
      inputSchema: { command_id: z.string().describe("idempotency key (uuid)"), component: z.string(), path: z.string(), expected_version: z.number().optional() },
      outputSchema: { component: z.string(), path: z.string(), deleted: z.boolean(), files_version: z.number() },
    },
    async (a) => {
      const r = await fileChannel.del(a.component, a.path, { command_id: a.command_id, expected_version: a.expected_version });
      if (!r.ok) return fail(fileFailNote(r));
      return { content: [{ type: "text", text: `Deleted "${a.path}" from "${a.component}".` }], structuredContent: { component: a.component, path: a.path, deleted: true, files_version: store.filesVersion() } };
    },
  );

  server.registerTool(
    "file_usage",
    {
      title: "App file storage usage",
      annotations: RO,
      description: "Report how much file storage an app is using (bytes + file count) against its quota.",
      inputSchema: { component: z.string() },
      outputSchema: { component: z.string(), bytes: z.number(), count: z.number(), quota_bytes: z.number(), quota_files: z.number() },
    },
    async (a) => {
      if (!COMPONENT_NAME_RE.test(a.component || "")) return fail("Invalid app name.");
      const u = store.fileUsage(a.component);
      return { content: [{ type: "text", text: `"${a.component}": ${u.bytes} bytes across ${u.count} file(s) — quota ${MAX_APP_FILE_BYTES} bytes / ${MAX_APP_FILE_COUNT} files.` }], structuredContent: { component: a.component, bytes: u.bytes, count: u.count, quota_bytes: MAX_APP_FILE_BYTES, quota_files: MAX_APP_FILE_COUNT } };
    },
  );

  // ---------------------------------------------------- registry lifecycle (design-system §7.5)
  server.registerTool(
    "component_history",
    {
      title: "Component version history",
      annotations: RO,
      description: "List a component's saved versions as {version, ts, html_size} — metadata only, NEVER the html (keeps context small; use get_component for the current source). History survives delete_component (tombstone).",
      inputSchema: { name: z.string() },
      outputSchema: {
        name: z.string(),
        history: z.array(z.object({ version: z.number(), ts: z.string(), html_size: z.number() })),
      },
    },
    async (a) => {
      const history = store.componentHistory(a.name);
      if (!history.length) return fail(`No history for component "${a.name}".`);
      const text = `"${a.name}" — ${history.length} version(s):\n` +
        history.map((h) => `  v${h.version} · ${h.ts} · ${h.html_size} chars`).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { name: a.name, history } };
    },
  );

  server.registerTool(
    "get_component_version",
    {
      title: "Get a historical component version",
      annotations: RO,
      description: "Read the HTML source of a SPECIFIC past version of a component (from its history). Use with component_history (which lists the version numbers) to inspect or diff an older version before rolling back to it with restore_component.",
      inputSchema: { name: z.string(), version: z.number().describe("the historical version to read (see component_history)") },
    },
    async (a) => {
      const v = store.getComponentVersion(a.name, a.version);
      if (!v) return fail(`No version ${a.version} for component "${a.name}". Use component_history to see which versions exist.`);
      return { content: [{ type: "text", text: `// ${v.name} v${v.version} (historical, saved ${v.ts})\n${v.html}` }] };
    },
  );

  server.registerTool(
    "restore_component",
    {
      title: "Restore a component version",
      annotations: WRITE,
      description: "Roll a component back to one of its earlier versions: re-saves that version's HTML as a NEW current version (nothing is lost — history is preserved and you can roll forward again). Use when a newer edit broke the UI. Find the version number with component_history; after restoring, open_component to view it.",
      inputSchema: {
        name: z.string(),
        version: z.number().describe("the historical version to restore (see component_history)"),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
      },
    },
    async (a) => {
      if (LOCKED_COMPONENTS.has(a.name)) return fail(`"${a.name}" is a locked system component — it can't be restored or overwritten here.`);
      if (RESERVED_COMPONENT_NAMES.has(a.name)) return fail(`"${a.name}" is a reserved namespace — nothing restorable lives there.`);
      const old = store.getComponentVersion(a.name, a.version);
      if (!old) return fail(`No version ${a.version} for component "${a.name}". Use component_history to see which versions exist.`);
      const r = store.execute({
        type: "save_component", command_id: a.command_id || randomUUID(),
        name: a.name, html: old.html, description: "", actor: "agent", host: hostName(),
      });
      if (!r.ok) return fail(failNote(r));
      registerComponent(a.name);
      return { content: [{ type: "text", text: `Restored "${a.name}" from v${a.version} → saved as new v${r.version} (history preserved). Show it now with open_component {component: "${a.name}"}.` }] };
    },
  );

  // Render-health + AUTO-REVERT — the safety net that makes "the AI edits your UI" safe. The
  // widget loader reports an uncaught error during a component's initial mount; when the report
  // is about the CURRENT version and an earlier version exists, the engine restores that earlier
  // version automatically (as a NEW forward version — nothing is lost). Local tier only: runner
  // tiers serve fixed curated content, and the runner's cap allowlist doesn't route this tool.
  const autoRevertBudget = new Map(); // component → auto-reverts spent this server run (cap 3 — a broken chain must not loop forever)
  server.registerTool(
    "render_health",
    {
      title: "Report component render health (internal)",
      annotations: WRITE,
      description: "Internal: the widget loader reports whether a component's html mounted cleanly. A failure report about the current version triggers an automatic rollback to the previous version (history preserved, max 3 per component per server run). Not normally called by the AI — use restore_component to roll back deliberately.",
      inputSchema: {
        component: z.string(),
        version: z.number().describe("the component version that was rendering"),
        ok: z.boolean(),
        error: z.string().optional().describe("the uncaught error message, when ok=false"),
      },
      outputSchema: {
        component: z.string(), ok: z.boolean(), reverted: z.boolean(),
        restored_version: z.number().optional().describe("the historical version whose html is now current again"),
        new_version: z.number().optional().describe("the new current version number after the revert"),
        note: z.string().optional(),
      },
    },
    async (a) => {
      const done = (reverted, note, extra = {}) => ({
        content: [{ type: "text", text: note }],
        structuredContent: { component: a.component, ok: !!a.ok, reverted, note, ...extra },
      });
      const comp = store.getComponent(a.component);
      if (!comp) return done(false, `No component "${a.component}" — nothing to do.`);
      // A healthy report does NOT reset the budget: the 3-per-server-run cap is a hard ceiling,
      // otherwise interleaved ok:true reports make it hollow (verified abusable — 8 reverts, 0 refused).
      if (a.ok) return done(false, "Healthy render noted.");
      if (a.version !== comp.version) return done(false, `Stale report (about v${a.version}, current is v${comp.version}) — ignored.`);
      if (LOCKED_COMPONENTS.has(a.component)) return done(false, "Locked system component — not auto-reverted.");
      if (tierOf(comp.author) !== "local") return done(false, "Non-local component — not auto-reverted (fixed curated content).");
      const prev = store.componentHistory(a.component).find((h) => h.version < comp.version);
      if (!prev) return done(false, "No earlier version to revert to.");
      const spent = autoRevertBudget.get(a.component) || 0;
      if (spent >= 3) return done(false, "Auto-revert limit reached for this component (3 per server run) — fix it manually (get_component_version + restore_component).");
      const old = store.getComponentVersion(a.component, prev.version);
      if (!old) return done(false, "History entry unreadable — not reverted.");
      const r = store.execute({
        type: "save_component", command_id: randomUUID(),
        name: a.component, html: old.html, description: "", actor: "agent", host: hostName(),
      });
      if (!r.ok) return done(false, `Auto-revert failed: ${failNote(r)}`);
      autoRevertBudget.set(a.component, spent + 1);
      registerComponent(a.component);
      return done(true,
        `"${a.component}" v${a.version} failed to render (${(a.error || "uncaught error").slice(0, 200)}) — automatically restored v${prev.version} as new v${r.version}. Reload shows the working version.`,
        { restored_version: prev.version, new_version: r.version });
    },
  );

  server.registerTool(
    "delete_component",
    {
      title: "Delete component",
      annotations: DESTRUCTIVE,
      description: "Remove a component from the registry permanently (confirm with the user first). Version history is RETAINED as a tombstone and its data collection / settings items are untouched. The component's ui:// registration may linger until server restart; open_component itself fails cleanly right away.",
      inputSchema: { ...cmdArgs, name: z.string() },
    },
    async (a) => {
      if (LOCKED_COMPONENTS.has(a.name)) return fail(`"${a.name}" is a locked system component — its UI ships with the engine and can't be deleted here.`);
      const r = run(a, "delete_component");
      if (!r.ok) return fail(r.error === "not_found" ? `No component "${a.name}" in the registry. list_components shows what exists.` : failNote(r));
      return { content: [{ type: "text", text: `Deleted "${a.name}"${r.idempotent ? " (already deleted)" : ""}. Version history retained; its data collection and settings items are untouched.` }] };
    },
  );

  // ------------------------------------------------------------------ gallery (component library)
  // The repo's components/ dir is a curated first-party library. Installing FROM it saves the
  // component with actor "gallery" (provenance + update detection) → tier local → runs DIRECT,
  // exactly like the user's own apps: it's our content, there is nothing to review in OSS.
  // The SaaS user-publishing pipeline later adds review + the runner tier on the same seam.
  // The `gallery` system app is the browsable UI over these tools.
  server.registerTool(
    "gallery_list",
    {
      title: "List gallery apps",
      annotations: RO,
      description: "Browse the built-in gallery: ready-made, high-quality apps shipped with the engine that the user can install into their registry. Shows install state. Renders no UI — open_component {component: \"gallery\"} shows the browsable gallery app.",
      inputSchema: {},
      outputSchema: {
        entries: z.array(z.object({
          name: z.string(), title: z.string(), description: z.string(), category: z.string(),
          size: z.number(), has_preview: z.boolean(),
          installed: z.boolean(), from_gallery: z.boolean().describe("installed copy came from the gallery"),
          update_available: z.boolean(),
        })),
      },
    },
    async () => {
      const entries = listGallery().map((e) => {
        const cur = store.getComponent(e.name);
        const from_gallery = !!cur && cur.author === "gallery";
        const update_available = from_gallery && cur.html !== (readGalleryComponent(e.name)?.html ?? cur.html);
        return { name: e.name, title: e.title, description: e.description, category: e.category, size: e.size, has_preview: e.has_preview, installed: !!cur, from_gallery, update_available };
      });
      const text = entries.length
        ? "Gallery apps:\n" + entries.map((e) => `  - ${e.name} — ${e.title}${e.installed ? (e.update_available ? " [installed, update available]" : " [installed]") : ""}${e.description ? ` — ${e.description}` : ""}`).join("\n")
        : "The gallery is empty (no library components shipped in this install).";
      return { content: [{ type: "text", text }], structuredContent: { entries } };
    },
  );

  server.registerTool(
    "gallery_preview",
    {
      title: "Gallery live-preview payload (internal)",
      annotations: RO,
      description: "Internal: returns a gallery entry's html plus its embedded mock-data fixtures, so the gallery app can render a LIVE sandboxed preview card (srcdoc + stub oma + mock snapshot). Read-only; nothing is installed. Not useful to call directly.",
      inputSchema: { name: z.string().describe("gallery entry name (see gallery_list)") },
      outputSchema: {
        name: z.string(), title: z.string(), description: z.string(), category: z.string(),
        html: z.string(),
        fixtures: z.object({ items: z.array(itemShape) }).nullable().describe("embedded mock snapshot items, or null if the entry ships none"),
      },
    },
    async (a) => {
      const entry = readGalleryComponent(a.name);
      if (!entry) return fail(`No "${a.name}" in the gallery. gallery_list shows what's available.`);
      return {
        content: [{ type: "text", text: `(gallery preview payload for "${entry.name}" — ${entry.html.length} chars, ${entry.fixtures ? entry.fixtures.items.length + " mock items" : "no fixtures"}; consumed by the gallery app)` }],
        structuredContent: { name: entry.name, title: entry.title, description: entry.description, category: entry.category, html: entry.html, fixtures: entry.fixtures },
      };
    },
  );

  server.registerTool(
    "install_from_gallery",
    {
      title: "Install a gallery app",
      annotations: WRITE,
      description: "Install (or update) a ready-made app from the built-in gallery into the user's registry. Once installed it behaves like any app of the user's own; its UI updates come from the gallery (newer gallery version), not from edits. Use gallery_list to see what's available.",
      inputSchema: {
        name: z.string().describe("gallery entry name (see gallery_list)"),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
      },
      outputSchema: { name: z.string(), version: z.number(), tier: z.string(), updated: z.boolean().optional() },
    },
    async (a) => {
      // Same name guards as save_component — this is a registry WRITE path and must refuse what
      // the tool boundary refuses (reserved namespaces + locked system UIs), not rely on the
      // gallery dir happening to contain no such files.
      if (RESERVED_COMPONENT_NAMES.has(a.name) || LOCKED_COMPONENTS.has(a.name))
        return fail(`"${a.name}" is a reserved/system name — not installable.`);
      const entry = readGalleryComponent(a.name);
      if (!entry) return fail(`No "${a.name}" in the gallery. gallery_list shows what's available.`);
      const cur = store.getComponent(a.name);
      if (cur && cur.author !== "gallery")
        return fail(`"${a.name}" already exists in your registry as a ${cur.author}-authored app — NOT overwriting it with the gallery version. Delete or rename the existing one first if you want the gallery app.`);
      if (cur && cur.html === entry.html)
        return { content: [{ type: "text", text: `"${a.name}" is already installed and up to date (v${cur.version}). Open it with open_component.` }], structuredContent: { name: a.name, version: cur.version, tier: tierOf("gallery"), updated: false } };
      const r = store.execute({
        type: "save_component", command_id: a.command_id || randomUUID(),
        name: a.name, html: entry.html, description: entry.description || entry.title, actor: "gallery", host: hostName(),
      });
      if (!r.ok) return fail(failNote(r));
      registerComponent(a.name);
      return {
        content: [{ type: "text", text: `Installed "${a.name}" v${r.version} from the gallery. Open it now with open_component {component: "${a.name}"}.` }],
        structuredContent: { name: a.name, version: r.version, tier: tierOf("gallery"), updated: !!cur },
      };
    },
  );

  // ------------------------------------------------------ prefs schema (settings pane, P4)
  server.registerTool(
    "ui_prefs_schema",
    {
      title: "Shared preference catalog",
      annotations: RO,
      description: "The engine-owned catalog of SHARED preferences (key, type, label, default, options) that the settings app renders. Components read effective values via oma.pref(); this tool only describes what exists. Read-only.",
      inputSchema: {},
      outputSchema: {
        shared: z.array(z.object({
          key: z.string(), type: z.enum(["string", "number", "boolean", "enum"]),
          label: z.string(), desc: z.string(),
          default: z.union([z.string(), z.number(), z.boolean()]),
          options: z.array(z.union([z.string(), z.object({ value: z.string(), label: z.string() })])).optional(),
          maxlength: z.number().optional(), min: z.number().optional(), max: z.number().optional(), step: z.number().optional(),
        })),
      },
    },
    async () => ({
      content: [{ type: "text", text: `Shared preference catalog: ${SHARED_PREFS.map((p) => p.key).join(", ")}.` }],
      structuredContent: { shared: SHARED_PREFS },
    }),
  );

  // ------------------------------------------------------ permissions overview (settings pane)
  server.registerTool(
    "component_permissions",
    {
      title: "Component permissions overview",
      annotations: RO,
      description: "For every component: its author, trust tier, whether it's a locked system component, and the effective capability grants (including file_read/file_write). This is what the settings Permissions pane renders. Read-only; capability OVERRIDES are written with security_set.",
      inputSchema: {},
      outputSchema: {
        components: z.array(z.object({
          name: z.string(), author: z.string(),
          tier: z.enum(["local", "library-reviewed", "unreviewed"]),
          locked: z.boolean(), caps: capsShape,
        })),
      },
    },
    async () => {
      const components = store.listComponents().map((c) => {
        const tier = tierOf(c.author);
        return { name: c.name, author: c.author, tier, locked: LOCKED_COMPONENTS.has(c.name), caps: computeCaps(c.name, tier) };
      });
      const text = components.length
        ? "Component permissions:\n" + components.map((c) =>
            `  - ${c.name} · tier ${c.tier} (by ${c.author})${c.locked ? " · LOCKED" : ""} · files ${c.caps.file_read ? "r" : "-"}${c.caps.file_write ? "w" : "-"} · sendMessage ${c.caps.send_message ? "on" : "off"}`).join("\n")
        : "No components installed.";
      return { content: [{ type: "text", text }], structuredContent: { components } };
    },
  );

  // -------------------------------------------------------------- privileged policy writer
  // The ONLY path that can write reserved security:*/policy:* keys. Privilege travels
  // out-of-band (store.executePrivileged), NEVER as a command field — so a prompt-injected
  // data_* call carrying {privileged:true} still hits the guard. Intended for the settings-app
  // Permissions UI; per-component capability policy is enforced at the RUNNER (this only keeps
  // the policy store itself tamper-evident — see docs/security-model.md §4).
  server.registerTool(
    "security_set",
    {
      title: "Set a security policy key",
      annotations: WRITE,
      description: "Privileged writer for reserved settings keys (security:* / policy:*) — the ONLY tool that can write them; the generic data_* tools refuse reserved keys. Upserts one key/value in the settings collection.",
      inputSchema: {
        key: z.string().describe("a reserved key, e.g. security:kanban:send_message (cap suffixes are snake_case — the caps field names)"),
        value: z.string().describe("the policy value, e.g. allow | ask | deny | confirm"),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
      },
      outputSchema: snapshotSchema,
    },
    async (a) => {
      const key = String(a.key || "");
      if (!RESERVED_KEY_RE.test(key)) return fail(`security_set only writes reserved keys (security:* / policy:*). Use data_* for "${key}".`);
      // Cap-segment validation (naming contract): computeCaps only ever reads the snake_case
      // CAP_NAMES suffixes. An unknown suffix — e.g. dotted "sendMessage" — is still stored
      // (reserved namespace, forward-compat) but flagged, so a typo'd policy is VISIBLY
      // ineffective instead of silently believed.
      const capSeg = (key.match(/^security:[^:]+:(.+)$/) || key.match(/^policy:defaults:[^:]+:(.+)$/))?.[1];
      const warn = capSeg && !CAP_NAMES.includes(capSeg)
        ? `\n⚠ "${capSeg}" is not a capability the engine reads — the key is stored but has NO effect. Valid caps (snake_case): ${CAP_NAMES.join(", ")}.`
        : "";
      const cid = a.command_id || randomUUID();
      const existing = store.snapshot(SETTINGS_COLLECTION).items.find((i) => i.fields.key === key);
      const r = existing
        ? store.executePrivileged({ type: "update_item", command_id: cid, id: existing.id, fields: { value: a.value }, actor: "human", host: hostName() })
        : store.executePrivileged({ type: "add_item", command_id: cid, collection: SETTINGS_COLLECTION, fields: { key, value: a.value }, actor: "human", host: hostName() });
      return r.ok ? toResult(r.snapshot, `Set ${key}.` + warn) : fail(failNote(r));
    },
  );

  return server;
}
