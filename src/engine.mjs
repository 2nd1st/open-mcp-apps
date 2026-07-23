// engine.mjs — builds the complete MCP server (tools + resources) around a store.
// Shared by every entry point: stdio (server.mjs), Streamable HTTP (http.mjs), and the
// in-memory client behind the browser viewer. One engine, many transports — the data is
// the same SQLite regardless of which host connects.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE, EXTENSION_ID } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { COMPONENT_NAME_RE, SETTINGS_COLLECTION, RESERVED_KEY_RE } from "./store.mjs";
import { wrapComponent, wrapLoader } from "./shell.mjs";
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
  host: z.string().optional(),
};

// Reserved settings groups (docs/settings-design.md §8): a group is a component name, so
// these may never BE component names. Blocks naming only — not writes into those groups.
const RESERVED_COMPONENT_NAMES = new Set(["security", "engine", "host", "system", "shell", "oma"]);

// The 9 scenario-taxonomy category slugs (a shared cross-tool contract; verified
// 2026-07-22 — do not amend privately). Invalid → warn + drop, never reject.
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
export const tierOf = (author) => (author === "agent" || author === "human" || author === "seed" ? "local" : "unreviewed");
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
  "cross_collection_read", "cross_collection_write", "settings_write", "read_source"];
const TIER_CAPS = {
  // local-authored runs DIRECT (co-equal with the AI) — anything stricter would be theater.
  local: { call_tools: ["*"], send_message: true, update_context: true, delete_items: "allow",
    cross_collection_read: true, cross_collection_write: true, settings_write: true, read_source: true },
  // library-reviewed: unreachable until library_install lands — preset pinned NOW so the runner
  // can build against it. Own-collection data ops flow through the runner's bridge methods
  // (always on); call_tools gates only the generic passthrough. data_collections is deliberately
  // NOT in call_tools: collection discovery IS a cross-collection read and the runner refuses it
  // while cross_collection_read is false — listing it here would advertise a cap that can never
  // execute. A reviewed meta-component that truly needs discovery gets an explicit
  // security:<name>:* overlay (cross_collection_read + call_tools), not a preset grant.
  "library-reviewed": { call_tools: ["data_list"], send_message: false,
    update_context: false, delete_items: "confirm", cross_collection_read: false,
    cross_collection_write: false, settings_write: false, read_source: false },
  // unreviewed / pasted: assume hostile.
  unreviewed: { call_tools: [], send_message: false, update_context: false, delete_items: "deny",
    cross_collection_read: false, cross_collection_write: false, settings_write: false, read_source: false },
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

SYSTEM APPS (open via open_component): "dashboard" = overview cards of all your collections; "settings" = preferences + usage guide + About + a browsable library of your components. These are engine-provided and privileged — allowed to span collections. Everything else is an app built for one scenario and its own data; that independence is exactly what lets it reopen cleanly in a later chat.

__PROACTIVITY_STANCE__

SHOW UI vs READ data:
- A topic maps to an EXISTING app (list_components / data_collections hits one) and it isn't already on screen → OPEN it (open_component {component, collection?}) as part of answering — don't just recite its data as text. Opening an app that already exists is nearly free, so reach for it by default (asked "how's project X going?" and a board for it exists → show the board, don't narrate numbers).
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
 */
export function createEngine(store, { hostLabel } = {}) {
  const server = new McpServer(
    { name: "open-mcp-apps", version: "0.1.0" },
    {
      instructions: buildInstructions(store),
      // Advertise the MCP Apps extension (2026-07-28 RC makes extensions first-class;
      // strict hosts may otherwise assume no ui:// support despite _meta.ui on tools).
      capabilities: { extensions: { [EXTENSION_ID]: {} } },
    },
  );

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
    if (r.conflict) return `Version conflict (expected v${r.expected}) — refresh and retry.`;
    if (r.error) return `Command failed: ${r.error}.`;
    return "Command failed.";
  }
  const fail = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

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
      return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: wrapComponent(comp.html, { component: name }) }] };
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
        caps: z.object({
          call_tools: z.array(z.string()), send_message: z.boolean(), update_context: z.boolean(),
          delete_items: z.enum(["allow", "confirm", "deny"]),
          cross_collection_read: z.boolean(), cross_collection_write: z.boolean(),
          settings_write: z.boolean(), read_source: z.boolean(),
        }),
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
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
      },
    },
    async (a) => {
      if (!COMPONENT_NAME_RE.test(a.name || "")) return fail("Invalid name: must match ^[a-z][a-z0-9-]{0,31}$ (lowercase, digits, hyphens).");
      if (RESERVED_COMPONENT_NAMES.has(a.name)) return fail(`"${a.name}" is a reserved namespace (settings groups security/engine/host/system/shell/oma) — pick another name.`);
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
        name: a.name, html: a.html, description: a.description || "", scene, actor: "agent", host: hostName(),
      });
      if (!r.ok) return fail(failNote(r));
      registerComponent(a.name);
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
      description: "Read all items in a data collection WITHOUT rendering any UI — use this to answer questions or decide; use open_component / open_<name> when the user should see the widget.",
      inputSchema: { collection: z.string() },
      outputSchema: snapshotSchema,
    },
    async (a) => toResult(store.snapshot(a.collection)),
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
    "delete_component",
    {
      title: "Delete component",
      annotations: DESTRUCTIVE,
      description: "Remove a component from the registry permanently (confirm with the user first). Version history is RETAINED as a tombstone and its data collection / settings items are untouched. The component's ui:// registration may linger until server restart; open_component itself fails cleanly right away.",
      inputSchema: { ...cmdArgs, name: z.string() },
    },
    async (a) => {
      const r = run(a, "delete_component");
      if (!r.ok) return fail(r.error === "not_found" ? `No component "${a.name}" in the registry. list_components shows what exists.` : failNote(r));
      return { content: [{ type: "text", text: `Deleted "${a.name}"${r.idempotent ? " (already deleted)" : ""}. Version history retained; its data collection and settings items are untouched.` }] };
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
