// SPDX-License-Identifier: MIT
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

import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer, CLIENT_INFO_META_KEY, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import { EXTENSION_ID } from "./mcp-apps.mjs";
import { SETTINGS_COLLECTION, ITEM_WRITE_KEYS, ITEM_WRITE_ENVELOPE } from "./store.mjs";
import { CAP_NAMES, TIER_CAPS, coerceCap, SEEDED_APPS, answer, toMcp, EOT } from "./contracts.mjs";
import { openFileChannel } from "./files.mjs";
import { isControlPlaneTool, TOOL_ALIASES } from "./tool-policy.mjs";
import { latestPref } from "./runtime-core.mjs";
import { bridgeInvalidations } from "./notify.mjs";
import { ENGINE_VERSION } from "./version.mjs";
import { installSchemaTrim, listCacheHints, ENGINE_CONSTANT } from "./cache-hints.mjs";
import { register as registerAppTools } from "./tools/apps.mjs";
import { register as registerDataTools } from "./tools/data.mjs";
import { register as registerFileTools } from "./tools/files.mjs";
import { register as registerRegistryTools } from "./tools/registry.mjs";
import { register as registerAppStoreTools } from "./tools/app-store.mjs";
import { register as registerSettingsTools } from "./tools/settings.mjs";
import { register as registerPrompts } from "./prompts.mjs";

// Part of this module's public surface (server.mjs / http.mjs / index.mjs import them from here),
// so the move into contracts.mjs is invisible to callers.
export { tierOf, RUNNER_REQUIRED_HTML, defaultCollectionFor, stageWidthFor, stageDisplayFor } from "./contracts.mjs";

// WHO is calling, carried across await points. Two writers, one reader:
//   · the HTTP entry wraps each /mcp dispatch in run({ fallback }) — its User-Agent/body-derived
//     label, request-scoped so stateless requests can never inherit another client's identity;
//   · the per-call wrapper below overlays { call } from the request's own `_meta` envelope
//     (`io.modelcontextprotocol/clientInfo`, SEP-2575) — the most specific claim there is.
// AsyncLocalStorage rather than a variable because tool handlers await store/file work and a
// concurrent call on the same connection (stdio allows it) would otherwise swap labels mid-flight.
export const hostContext = new AsyncLocalStorage();


// Downloaded into the model's context at initialize — this is where the engine teaches the
// AI WHEN to reach for it, not just what the tools do. Keep it tight; it is always in context.
const INSTRUCTIONS = `open-mcp-apps gives the user persistent, interactive UI apps (widgets) backed by data collections shared between you and the user. Data outlives the conversation.

Collections in this server hold the user's structured app data — todos, kanbans, habits, notes, queues, budgets, logs — and list_data_collections lists them by name, item count and last activity.

__ONBOARDING_OR_INVENTORY__

ROUTING:
- open_app renders an app from the registry as a widget, and the widget shows its own data, so the reply does not have to repeat it as text. list_apps returns the registry's real names.
- data_list and list_data_collections read facts without a UI. data_add_item / data_update_item / data_move_item / data_delete_item / apply_data_writes write; visible widgets refresh themselves.
- data_changes attributes the edits a user made inside a widget, which never pass through this conversation.
- get_app_guide holds the authoring contract for building or changing an app. An existing app can be bound to a different collection instead of being rewritten.
- "app-store" is the built-in store of ready-made apps: app_store_list browses it, install_from_app_store installs one. dashboard and settings are the other system apps.
- An app can keep FILES too (file_write / file_list / file_read): images, PDFs, exports — per app, across chats.

__PROACTIVITY_STANCE__

WHEN NOT: one-shot visuals and pure discussion are answered in text or charts, with no app involved. Personal or sensitive data (health, money, private notes) is stored only after the user has said yes; missing data is never a reason to wait, missing consent is.`;
// The other empty-state shape ("what's actually in our freezer?" — a question about something no
// app holds yet) is deliberately NOT here: its trigger point is a data read coming back empty, so
// the guidance rides in list_data_collections'/data_list's empty replies — the data the model is looking
// at when it decides (the apps.mjs birthday lesson: prose in the resident channel LOST to a
// fact in the decision channel; and on at least one measured host the tail of this string never
// reaches the model at all).

// Read a global settings pref (group "") from the shared store — one cheap settings snapshot.
function readPref(store, key) {
  try {
    return latestPref(store.snapshot(SETTINGS_COLLECTION).items, key)?.fields.value;
  } catch {}
  return undefined;
}

// The onboarding procedure, held apart from INSTRUCTIONS because it is only TRUE for a user who
// has nothing yet: it describes building one app straight away rather than touring the surface.
// For someone with ten apps that is not merely expensive, it is WRONG ADVICE. So it is SWAPPED,
// not trimmed — each half is paid only by the reader it is correct for.
//
// It states what the engine can do and what the first move looks like; it does not order the model
// around, and it asks for nothing out of the conversation's history or the model's memory. Those
// two shapes are what a directory review reads as a server steering its host, so they stay out.
const ONBOARDING = `GETTING STARTED — this user has no apps of their own yet, so the useful opening move is one app built for them and opened, rather than a feature tour. The shape of it: (1) the subject comes from what the user has already said they do, track, or keep re-explaining — one short question if there is nothing to go on; (2) get_app_guide carries the craft rules that make an app come out right, then save_app and open_app; apply_data_writes fills the collection with the user's own real content, since an app that opens already about them is the point and invented rows are not; (3) once it is on screen, one sentence on what it is, then a couple more you could build, one line each; (4) two things are worth saying at that point — a NEW app costs tokens ONCE and pays off for anything recurring, and the user's proactivity preference (PROACTIVE or ON-REQUEST for future apps) is recorded with data_add into settings (group "", key "proactivity", value "proactive" | "on-request") and honored from then on. Sensitive subjects stay out unless the user agrees to them.`;

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
const INVENTORY = `THE USER ALREADY HAS APPS HERE — built in earlier chats and still live: trackers, lists, boards, logs, journals, queues, inventories, habits, budgets, reading lists, collections, plans. When something the user says could be one of those ("my expenses", "the reading list", "that board", "what am I tracking"), list_apps and list_data_collections show what exists, under the exact names the registry returns. open_app puts one on screen, and the widget shows its own data.`;

// INSTRUCTIONS carry a __PROACTIVITY_STANCE__ placeholder resolved per server start from the user's
// stored `proactivity` pref (set during onboarding, step 4). Low-frequency setting → reading it once
// at createEngine time is enough; a change takes effect on the next host restart.
/** INSTRUCTIONS are two-layered. The MANUAL (what this surface is, what its tools do) is
 *  replaceable — a hosted deployment carries its own. The DYNAMIC segments are the engine's to keep
 *  true: which half of onboarding-vs-inventory this user actually is, and their stored proactivity
 *  stance. There are exactly two, and the function roster is NOT a third: the pillar shipped, and
 *  the roster deliberately stayed out of here. INSTRUCTIONS are a cache PREFIX — a segment that
 *  moves whenever any app declares or drops a function would invalidate it for every conversation.
 *  The discovery it was meant to provide lives on the list_apps row instead (a `functions` count,
 *  and only when there is one); the names are one get_app {slot:"manifest"} away, paid for by
 *  whoever needs them.
 *
 *  An override POSITIONS the two by carrying their placeholders — and OMITS them by leaving the
 *  placeholders out. That is the reversal of the older rule ("a manual that omits a placeholder
 *  gets that segment appended"), and it is deliberate: the appending version meant a hosted
 *  deployment had no configuration by which to ship instructions of its own, which the directory
 *  listing work needs. What that rule was protecting still holds for the DEFAULT manual, which
 *  carries both placeholders and always will; a deployment that writes its own manual is stating
 *  that it knows what its readers need, and owns the consequence. */
function composeInstructions(manual, store) {
  const pref = readPref(store, "proactivity");
  const stance = pref === "proactive"
    ? "PROACTIVITY — the user's stored preference is PROACTIVE: they have asked for an existing app to be opened when a topic maps to one, and for a new app to be offered or built when a recurring need has none yet. Opening an existing app is nearly free; a new build costs tokens once, so a heads-up before a large one is courteous."
    : pref === "on-request"
    ? "PROACTIVITY — the user's stored preference is ON-REQUEST: they have asked that new apps be built only when they ask for one. Opening an app that already exists is nearly free, so showing one they want to see sits inside that preference."
    : "PROACTIVITY — no preference is stored yet. Opening an EXISTING matching app is nearly free; building a NEW one costs tokens once. The preference is settled with the user during onboarding and recorded in settings.";
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
    // Only the engine's OWN manual gets a missing segment appended — that is a guard against
    // editing a placeholder out of INSTRUCTIONS by accident. A caller-supplied manual that
    // leaves one out has said so on purpose, and gets what it asked for.
    else if (manual === undefined) missing.push(text);
  }
  return missing.length ? `${out}\n\n${missing.join("\n\n")}` : out;
}
function buildInstructions(store) { return composeInstructions(undefined, store); }

/** The `functions` option, read once. `false | true | {egress?, executor?}` in, `false` or a
 *  normalised seat object out — and a TypeError for anything else, because the shapes it refuses
 *  are the ones whose failure mode is silent: an `egress` missing its token is a body that reaches
 *  the open internet through a host that believed it had a gateway in front of it, and a
 *  misspelled key on the option object is the same thing wearing a typo. `true` and `{}` are the
 *  same seat (run here, no egress filtering) — that is the OSS entrypoints' shape and it stays. */
function normalizeFunctionsSeat(functions) {
  if (functions === false || functions === undefined || functions === null) return false;
  if (functions === true) return {};
  if (typeof functions !== "object" || Array.isArray(functions))
    throw new TypeError(`createEngine: functions must be false, true, or {egress?, executor?} — got ${Array.isArray(functions) ? "an array" : typeof functions}`);
  const { egress, executor } = functions;
  if (executor !== undefined && typeof executor !== "function")
    throw new TypeError("createEngine: functions.executor must be a function — it replaces where a body RUNS (runFunctionBody's call/outcome shape); see src/functions.mjs");
  if (egress !== undefined) {
    if (!egress || typeof egress !== "object" || Array.isArray(egress))
      throw new TypeError("createEngine: functions.egress must be {gateway, token}");
    if (typeof egress.gateway !== "string" || !/^https?:\/\//.test(egress.gateway))
      throw new TypeError("createEngine: functions.egress.gateway must be an http(s) origin the worker can POST to — a body's fetch is rewritten to <gateway>/egress");
    if (typeof egress.token !== "string" || !egress.token)
      throw new TypeError("createEngine: functions.egress.token must be a non-empty string — the gateway needs it to know which tenant is calling");
  }
  return { ...(egress === undefined ? {} : { egress }), ...(executor === undefined ? {} : { executor }) };
}

/** The `widgetDomain` option, read once. `string | {ui?, openai?}` in, `undefined` or a normalised
 *  `{ui?, openai?}` out — and a TypeError for anything else. Two hosts read two different keys off
 *  this one option and want mutually exclusive values (Claude: a bare hash of the connector URL
 *  under claudemcpcontent.com, which it refuses to render if wrong; ChatGPT: a scheme-bearing
 *  origin the deployment owns), so a deployment facing both must be able to address them
 *  separately. A string still means "both keys, this value" — the 0.5.x behaviour, byte for byte.
 *  A malformed shape THROWS rather than degrading, for the same reason the functions seat does:
 *  declaring nothing is this option's exact failure mode, and it is silent at construction —
 *  ChatGPT rejects the submission and Claude renders a blank, neither naming the key. */
function normalizeWidgetDomain(widgetDomain) {
  if (widgetDomain === undefined || widgetDomain === null) return undefined;
  if (typeof widgetDomain === "string") {
    if (!widgetDomain) throw new TypeError("createEngine: widgetDomain must be a non-empty string or {ui?, openai?} — omit it entirely to declare neither key");
    return { ui: widgetDomain, openai: widgetDomain };
  }
  if (typeof widgetDomain !== "object" || Array.isArray(widgetDomain))
    throw new TypeError(`createEngine: widgetDomain must be a string or {ui?, openai?} — got ${Array.isArray(widgetDomain) ? "an array" : typeof widgetDomain}`);
  const extra = Object.keys(widgetDomain).filter((k) => k !== "ui" && k !== "openai");
  if (extra.length)
    throw new TypeError(`createEngine: widgetDomain accepts only { ui, openai } — got ${extra.join(", ")}. A misspelled half declares nothing, which is the failure this option exists to prevent`);
  const { ui, openai } = widgetDomain;
  for (const [k, v] of [["ui", ui], ["openai", openai]])
    if (v !== undefined && (typeof v !== "string" || !v))
      throw new TypeError(`createEngine: widgetDomain.${k} must be a non-empty string — omit the key to leave that host's declaration out`);
  return { ...(ui === undefined ? {} : { ui }), ...(openai === undefined ? {} : { openai }) };
}

/** Hide `hidden` from `tools/list` without touching `tools/call`. Returns whether it installed. */
function installUnlistedFilter(server, hidden) {
  if (!hidden || hidden.size === 0) return false;
  const handlers = server?.server?._requestHandlers;
  const inner = handlers?.get?.("tools/list");
  if (typeof inner !== "function") return false; // SDK moved it — leave the server untouched
  handlers.set("tools/list", async (request, extra) => {
    const out = await inner(request, extra);
    // Mutate the field, never the object: see the caller's note about the cache-hint Symbol.
    if (out && Array.isArray(out.tools)) out.tools = out.tools.filter((t) => !hidden.has(t?.name));
    return out;
  });
  return true;
}

/**
 * Build a fully-wired McpServer.
 * @param store  the shared store (one per process — every transport sees the same data)
 * @param opts.hostLabel  fixed host label (e.g. "browser-viewer"); when absent, the host is
 *                        identified from the caller's clientInfo (Claude/ChatGPT/...) — carried by
 *                        the `initialize` handshake up to MCP 2026-06-18, and by every request's
 *                        `_meta` from 2026-07-28 on, where `initialize` no longer exists.
 * @param opts.instructions  replace the MANUAL layer of the instructions (hosted deployments
 *                        carry their own behaviour text). The engine-composed DYNAMIC segments
 *                        (onboarding vs inventory, proactivity stance — and nothing else; see
 *                        composeInstructions for why the function roster is not one of them)
 *                        are positioned by an override that carries the placeholders
 *                        (__ONBOARDING_OR_INVENTORY__, __PROACTIVITY_STANCE__) and DROPPED by one
 *                        that omits them — a hosted manual decides for itself whether to carry
 *                        them. Only the engine's own default manual gets them appended. See
 *                        composeInstructions.
 * @param opts.widgetDomain  dedicated origin a host should give this deployment's widget sandbox.
 *                        ONE option, TWO wire keys, and the two hosts want values that CANNOT be
 *                        the same string — which is the whole reason the object form exists:
 *                        `{ ui, openai }`, either half omittable.
 *                          · `ui` → `_meta.ui.domain`, the MCP Apps standard key. Claude wants the
 *                            BARE host `{sha256(full connector URL).hex[0:32]}.claudemcpcontent.com`
 *                            and VALIDATES it against the connector URL: a wrong value is
 *                            `Invalid ui.domain format` / `ui.domain mismatch` and the app does not
 *                            render at all. A stdio connector has no URL to hash, so a LOCAL
 *                            install must not set this half.
 *                          · `openai` → `_meta["openai/widgetDomain"]`, ChatGPT's key. An origin
 *                            WITH a scheme that the deployment owns (e.g. "https://example.com"),
 *                            REQUIRED to submit a plugin with UI and "unique per plugin"; OpenAI
 *                            derives `<slug>.web-sandbox.oaiusercontent.com` from it and points the
 *                            "Open in <App>" button at it.
 *                        A plain STRING writes both keys with that one value — right for a
 *                        deployment facing a single host, wrong for one facing both. An omitted
 *                        half ⇒ that key is not declared and the host uses its own; omitted
 *                        entirely ⇒ neither key. All of it is a property of a DEPLOYMENT's
 *                        registration, not of the engine, so it is a knob and never a default —
 *                        the spec itself says the format is host-dependent and servers MUST consult
 *                        each host's docs (ext-apps `UIResourceMeta.domain`), so there is nothing
 *                        for the engine to invent. Evidence: docs/host-policies-2026-09-03.md 第三问.
 * @param opts.viewBase  base URL of a browser viewer for this store (e.g. "http://127.0.0.1:8787").
 *                        When present, list_apps prints a real /view/<name> link per app;
 *                        when absent (bare stdio — no viewer exists) it prints none.
 * @param opts.functions  register the call_function seat and its engine-side executor. DEFAULT
 *                        OFF at this layer, deliberately: execution is same-process (node:vm is an
 *                        isolation seam, not a hardened boundary — functions.mjs header), which is
 *                        the right trust model for the LOCAL product (the author's code already
 *                        runs with these caps in the user's browser) and the wrong one for a
 *                        multi-tenant hosted plane. The engine's own entrypoints (server.mjs,
 *                        http.mjs) pass true — OSS users get functions out of the box, with
 *                        OMA_FUNCTIONS=0 as the kill-switch — while an embedding consumer that
 *                        does not ask gets no seat, so a hosted deployment can only turn this on
 *                        on purpose.
 *                        `false` (default) = no seat. `true` (or `{}`) = the seat, run HERE, on a
 *                        worker thread, with the machine's own network. An OBJECT is the hosted
 *                        shape, and it carries at most two things, both of them seams rather than
 *                        policy (2026-09-05):
 *                          · `egress: {gateway, token}` — the body's `fetch` is rewritten in the
 *                            worker to speak to THAT gateway, which is where a host puts its
 *                            allowlist, its private-address check and its secret injection. The
 *                            engine ships no allowlist and never will: it cannot keep a promise
 *                            about a network it does not own.
 *                          · `executor` — where the body runs. Anything honouring
 *                            `runFunctionBody`'s call/outcome shape (functions.mjs, exported for
 *                            exactly this): a container, a socket, another machine. Everything
 *                            belonging to the STORE stays on this side of it.
 *                        Neither moves `oma.contract` and neither adds an env flag: they are
 *                        options an embedder passes, invisible to every app and every host.
 * @param opts.unlisted   tool names to REGISTER BUT NOT LIST. They are still callable through
 *                        `tools/call` exactly as before; they simply stop appearing in
 *                        `tools/list`. Two callers need this and they need it for opposite
 *                        reasons: a hosted deployment hides the four seats whose only real
 *                        callers are widgets (their own descriptions say "internal", and a
 *                        directory reviewer reading a public tool list should not have to
 *                        discount them), and the engine itself hides every retired tool name it
 *                        still answers to (see TOOL_ALIASES in tool-policy.mjs — a name that must
 *                        keep working for already-saved apps, and must not be advertised to
 *                        anyone writing a new one). Default `[]`, and with an empty set the
 *                        filter is not installed at all: the wire is byte-identical to a build
 *                        that never had this option, which is the property the tool-surface
 *                        golden checks.
 * @param opts.telemetry  record the edit tripwire's JSONL sidecar beside the database. DEFAULT
 *                        true — the local product measures its own editing path, on the user's own
 *                        machine, in a file they can read and delete. `false` makes the recorder a
 *                        no-op and the file is never created, which is what a deployment needs
 *                        when the alternative is disclosing a collection it has no product reason
 *                        to keep.
 * @param opts.dynamicTools  register a per-app `open_<name>` tool for every app. When PASSED it
 *                        decides; when omitted, `OMA_DYNAMIC_TOOLS=1` still does. An env flag is
 *                        the right control for a person running this locally and the wrong one
 *                        for a deployment that must be able to state what its tool list is — a
 *                        per-app opener makes `tools/list` move whenever a user saves an app.
 */
export function createEngine(store, { hostLabel, instructions, viewBase, widgetDomain, functions = false, unlisted = [], telemetry = true, dynamicTools: dynamicToolsOpt } = {}) {
  // The seat, normalised once here into `false | {egress?, executor?}` so that every reader
  // downstream (the tool registration, the guide) asks the same object the same way. A malformed
  // seat THROWS rather than degrading: a hosted plane that meant to pass a gateway and passed a
  // typo would otherwise get same-process execution with the machine's own network — the one
  // failure mode this option exists to prevent, arriving silently.
  const fnSeat = normalizeFunctionsSeat(functions);
  // Same discipline for the two-host widget origin: normalised once here into
  // `undefined | {ui?, openai?}` so the one reader downstream (uiSecurityFor) never has to ask
  // which of the two shapes it got.
  const widgetDomains = normalizeWidgetDomain(widgetDomain);
  // Registered but not listed. Fixed at construction: `tools/list` is a cached prefix, so a set
  // that could move mid-connection would be a cache break with no event to hang it on. The
  // retired names are in it unconditionally — an embedder does not get to advertise them, and a
  // caller that omits `unlisted` entirely still gets a list with no dead spellings in it.
  const unlistedTools = new Set([...Object.values(TOOL_ALIASES), ...unlisted]);
  // THE OPTION WINS WHERE IT IS GIVEN, and the environment answers where it is not. An env flag is
  // the right control for a person running the local product and the wrong one for a deployment
  // that has to be able to state what its tool list is: a per-app opener makes `tools/list` move
  // whenever a user saves an app, which is exactly what a directory's versioned-metadata contract
  // forbids. `undefined` — not `false` — is what "not given" means here, so an embedder can pass
  // `false` and MEAN it on a machine whose environment says otherwise.
  const dynamicTools = dynamicToolsOpt === undefined
    ? process.env.OMA_DYNAMIC_TOOLS === "1"
    : !!dynamicToolsOpt;
  const server = new McpServer(
    // Reported to the host at initialize (legacy era) / server-discover (2026-07-28). Real version,
    // not a literal — see version.mjs for why being unable to tell which build a deployment runs
    // is a correctness problem, not a nicety.
    { name: "open-mcp-apps", version: ENGINE_VERSION },
    {
      instructions: composeInstructions(instructions, store),
      // Advertise the MCP Apps extension (2026-07-28 makes extensions first-class;
      // strict hosts may otherwise assume no ui:// support despite _meta.ui on tools).
      // `resources.subscribe` / `resources.listChanged` are what make a `subscriptions/listen`
      // filter mentioning our URIs honorable — the SDK narrows a requested filter against the
      // declared capabilities, so an undeclared bit means the client's subscription is silently
      // dropped from the ack. On the legacy wire the same bit promises `resources/subscribe`, and
      // the handlers that keep that promise are registered further down, beside the prompts.
      // EVERY listChanged bit is written out, true or false, and never left to the SDK — because
      // silence here does NOT mean "not declared": registering a tool or a prompt makes the SDK
      // declare that capability itself, filling the bit in with `?? true`. `tools.listChanged`
      // learned this the hard way. It used to be a conditional spread that added the key only with
      // the per-app openers on, meaning to say "off ⇒ the surface never moves, don't re-list" —
      // and it said `true` in every mode for as long as it existed, because an absent key is not
      // `false`; measured 2026-08-16, and test/capabilities.mjs pins both modes now. The intent
      // was right: with the openers off the tool surface is fixed for the life of the process, and
      // claiming it might move is an invitation to re-list — the prompt-cache cost OMA_DYNAMIC_TOOLS
      // is defaulted off to avoid. `prompts` is the same ruling: one prompt, compiled in, registered
      // before the transport is attached, so the list provably cannot move.
      capabilities: {
        extensions: { [EXTENSION_ID]: {} },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: false },
        tools: { listChanged: dynamicTools },
      },
      // Both eras, one engine: the SDK's default list is legacy-only, and a list with a modern
      // entry is ALSO the switch that registers `server/discover` (a MUST on 2026-07-28) — so
      // this line is the whole modern-era opt-in, not a version cosmetics.
      supportedProtocolVersions: ["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS],
      // SEP-2549 cache scopes ride SDK-native now; the POLICY (what is tenant-derived and what is
      // engine-constant, and why getting it wrong is a cross-tenant disclosure) lives in
      // cache-hints.mjs. Omitted operations keep the SDK default {ttlMs: 0, cacheScope: "private"},
      // which IS the store-derived answer — stated there, inherited here. `server/discover` is
      // deliberately omitted too: its instructions are personalised per store (onboarding vs
      // inventory), so the conservative default is the correct scope, not an oversight.
      cacheHints: {
        "tools/list": listCacheHints({ dynamicTools }),
        "resources/templates/list": ENGINE_CONSTANT,
      },
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
  // 🔴 TWO LISTS, TWO DIFFERENT DOORS — a name on both of them is not a contradiction.
  // This list answers ONE question: may the TOP-LEVEL widget a host rendered call this tool back
  // through that host? `CONTROL_PLANE_TOOLS` (tool-policy.mjs) answers a different one: may an app
  // EMBEDDED INSIDE another app reach this through the runner guard's passthrough? The second
  // answer is always no, at every tier, because a child that could rewrite the registry or the
  // security policy would own its parent. The first is a question about the system apps we ship,
  // and for the App Store app's Add button the answer is yes. So three names sit on both lists ON
  // PURPOSE — `app_store_list`, `preview_app_store_entry`, `install_from_app_store` — and the
  // shape they describe is exactly the product's: a first-party system app drives an App Store
  // seat at the top level; no nested child ever reaches one. (The disjointness test in
  // test/tool-surface.mjs names those three and no others, so the overlap cannot grow quietly.)
  // `security_set` is on the control-plane list and deliberately NOT here, and the difference is
  // in kind rather than in degree: it rewrites the POLICY the other walls are made of, and it has
  // no widget caller at all — the settings pane reaches it through the direct runtime's
  // passthrough, never through this flag. Advertising a door nobody walks through would only
  // widen the surface a default-DENY host is asked to open.
  const WIDGET_CALLABLE = new Set([
    "data_list", "get_data_version", "data_changes", "get_app_html",
    "data_add_item", "data_update_item", "data_move_item", "data_delete_item",
    "app_store_list", "preview_app_store_entry", "install_from_app_store",
    "list_apps", "list_data_collections",
    "get_ui_preference_schema", "call_function",
  ]);
  // MCP Apps `_meta.ui.visibility` (elegance C2, Leo 2026-08-04): tools whose only real callers
  // are widgets/system apps — their own descriptions say "internal" — declared app-only, which the
  // standard specifies as "do not expose to the model". On a host that honors it this moves their
  // schemas out of the model's resident context entirely; on one that does not, nothing changes.
  // The wire (tools/list) still carries them either way — the golden tracks raw-wire bytes.
  // get_data_version stays model-visible on purpose: its description invites the model to poll.
  const APP_ONLY = new Set(["get_app_html", "preview_app_store_entry", "get_ui_preference_schema", "security_set"]);
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
  // Per-call identity (SEP-2575): on the 2026-07-28 wire every request carries its own clientInfo
  // in the `_meta` envelope, and the SDK lifts it onto ctx.mcpReq.envelope. Overlaying it here —
  // at the ONE seam every tool passes through — is what lets hostName() name THE CALL instead of
  // whichever connection happened to open first. The ctx is found by shape, not position, because
  // the SDK hands no-input tools a shorter argument list.
  const perCallHost = (handler) => (...args) => {
    const ctx = args.find((x) => x && typeof x === "object" && x.mcpReq);
    const ci = ctx?.mcpReq?.envelope?.[CLIENT_INFO_META_KEY];
    return (ci && typeof ci.name === "string" && ci.name)
      ? hostContext.run({ ...hostContext.getStore(), call: ci.name }, () => handler(...args))
      : handler(...args);
  };
  server.registerTool = (name, config, handler) => {
    let cfg = config;
    if (WIDGET_CALLABLE.has(name) || APP_ONLY.has(name)) {
      const meta = { ...(config._meta || {}) };
      if (WIDGET_CALLABLE.has(name)) meta["openai/widgetAccessible"] = true;
      if (APP_ONLY.has(name)) meta.ui = { ...(meta.ui || {}), visibility: ["app"] };
      cfg = { ...config, _meta: meta };
    }
    const registered = sdkRegisterTool(name, cfg, perCallHost(logged(name, handler)));
    // THE RETIRED SPELLING, registered beside the seat it retired from (tool-policy.mjs
    // TOOL_ALIASES). Same `cfg` object, so the alias carries the seat's own annotations, schemas
    // and `_meta` by construction rather than by a second declaration that could drift; same
    // handler, wrapped the same way, so a call through the old name is the same call. It is
    // added to `unlistedTools` below the registrations, which is what keeps it a bridge for apps
    // already in the field instead of a second name anyone can discover.
    const alias = TOOL_ALIASES[name];
    if (alias) sdkRegisterTool(alias, cfg, perCallHost(logged(alias, handler)));
    return registered;
  };

  // The per-app file channel: opaque user-file storage (bytes in a local content-addressed
  // folder; the store holds the ref index). MEMOIZED per store (files.mjs) so every engine over one store — incl.
  // the stateless /mcp path's engine-per-request — shares ONE upload table; the startup orphan
  // sweep runs inside openFileChannel exactly once per store.
  const fileChannel = openFileChannel(store);

  // Who is talking to us? Both protocol eras answer, most specific claim first:
  //   1. a fixed hostLabel (the caller KNOWS — e.g. "browser-viewer");
  //   2. this call's own clientInfo — the 2026-07-28 per-request `_meta` envelope, overlaid onto
  //      hostContext by the perCallHost wrapper above (SEP-2575 names THE CALL, which is also the
  //      shape that answered "one claude.ai user presents three clientInfo names");
  //   3. the legacy `initialize` clientInfo the SDK keeps per connection (stdio's 2025-era wire);
  //   4. the HTTP entry's request-scoped fallback (User-Agent/body-derived, set via hostContext);
  //   5. OMA_HOST, then NOTHING — "" is the answer, not a name.
  // Provenance annotation for the ledger, not a security property.
  //
  // 🔴 It used to end in the literal "unknown", and that string is a claim: it travels in the
  // ledger's host column and — through get_app_html/open_app's structuredContent — into
  // `oma.state.host`, where the settings app prints it as this machine's identity. Measured on
  // Leo's claude.ai (2026-08-13): the capsule badge and the rail both read "unknown", because
  // every step above genuinely came up empty. That is the NORMAL case since MCP 2026-07-28
  // dropped the `initialize` handshake — the protocol's silence, not a fact about the user's
  // client — so the honest value is the empty one, which is already what every reader treats as
  // "say nothing" (settings' hostLabel, the ledger's nullable column). Keeping the sentinel and
  // teaching each display to special-case it would have put the same lie on the wire forever and
  // made every future consumer inherit it.
  const hostName = () => {
    if (hostLabel) return hostLabel;
    const scoped = hostContext.getStore();
    if (scoped?.call) return scoped.call;
    const ci = server.server.getClientVersion?.();
    return (ci && ci.name) || scoped?.fallback || process.env.OMA_HOST || "";
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
    if (r.error === "empty_ui") return "empty_ui — an app needs something to render: every app here is something a person opens. Send the HTML you want saved as `ui`.";
    if (r.error === "ui_required_on_create") return "ui_required_on_create — a NEW app needs its document: pass `ui` (a complete self-contained HTML). manifest alone can only update an existing app.";
    if (r.error === "no_slots_provided") return "no_slots_provided — pass `ui`, `manifest`, or both; a save that touches neither slot changes nothing.";
    if (r.error === "bad_name") return "bad_name — app names are lowercase letters, digits and dashes, starting with a letter (max 32 chars).";
    if (r.error === "provenance_locked") return `provenance_locked — "${r.name}" was authored outside this conversation (by ${r.author}, trust tier ${r.tier}) and runs under that provenance. Saving over it here would re-stamp it as yours and change what it is allowed to do, so nothing was written. Build your own under a different name, or delete this one first if it should go.`;
    if (r.error === "built_outside") return `built_outside — "${r.name}" was built outside this store: its ui is a template that loads bundled assets (oma-asset:…), and the code those assets came from is not here. Source lives outside this store; rebuild and re-install with install-app.mjs. Nothing was written.`;
    if (r.error === "bad_asset_ref") return `bad_asset_ref — ${r.detail}. An oma-asset: reference names a file in THIS app's file plane (file_list shows them).`;
    if (r.error === "group_too_long") return `group_too_long — a group is a lane name (max ${r.limit} chars), not a data field.`;
    if (r.error === "confirmation_expired") return "confirmation_expired — the confirmation window closed. Re-send WITHOUT request_state to get a fresh one.";
    if (r.error === "confirmation_invalid") return "confirmation_invalid — the request_state does not match this exact delete (row, version, caller). Re-send WITHOUT request_state to get a fresh one.";
    if (r.confirmation_required) return `Confirmation required — deleting "${r.preview}". Confirm with the user, then re-send with request_state.`;
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
    upload_not_found: "No such upload (it may have expired or been committed) — start again with file_write_begin.",
    upload_expired: "That upload expired or its staging data was lost — start again with file_write_begin.",
    upload_busy: "That upload is mid-operation — send chunks one at a time, in order.",
    too_many_uploads: "Too many uploads in flight — commit or abort one first.",
    bad_chunk_seq: "Invalid chunk seq — a 0-based index of this chunk within the upload.",
    chunk_out_of_order: "That chunk arrived out of order — send the index the upload expects next (see `expected`).",
    chunk_already_staged: "That chunk index was already staged and cannot be re-verified — continue with the next index, or abandon this upload and start a fresh one if unsure what was sent.",
    chunk_mismatch: "That chunk index was already staged with DIFFERENT bytes — the resend does not match what landed. Abandon this upload and start a fresh one.",
  };
  const fileFailNote = (r) =>
    r.conflict ? `Version conflict (expected v${r.expected}) — refresh and retry.`
    : r.error === "command_id_reused" ? "That command_id was already used by a DIFFERENT command — use a fresh uuid."
    : FILE_ERRORS[r.error] || `File operation failed: ${r.error || "unknown"}.`;

  // caps = tier preset ⊕ policy:defaults:<tier>:<cap> ⊕ security:<app>:<cap> (last wins).
  // Rows come from the settings snapshot scanned in items[] order (the same last-wins scan the
  // pref merge uses). Overlays apply verbatim — security_set is the only writer and is privileged.
  // (The dormant caller axis — computeCaps(app, tier, caller) with caller always "owner" —
  // retired 2026-08-04, elegance A4: a parameter with one value is a promise, not a feature.
  // WHO-is-asking arrives with its first real second caller, as a signature change then.)
  function computeCaps(app, tier) {
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
  // The SAME wall apply_data_writes has always had, applied here too (ITEM_WRITE_KEYS — one table, both
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
  const ctx = { server, store, fileChannel, hostName, run, toAck, toConflict, toFail, renderItems, failNote, fail, fileFailNote, computeCaps, viewBase, widgetDomain: widgetDomains, functions: fnSeat, telemetry, dynamicTools };

  // Order is the tool-surface order, and the surface is a golden file — do not reshuffle.
  // apps goes first because it hands back registerApp, which app-store and registry
  // need to wire an app that did not exist when their module ran.
  Object.assign(ctx, registerAppTools(ctx));
  registerDataTools(ctx);
  registerFileTools(ctx);
  registerRegistryTools(ctx);
  registerAppStoreTools(ctx);
  registerSettingsTools(ctx);

  // Prompts are a different MCP primitive on a different verb (`prompts/list`), so they sit
  // outside src/tools/ and outside the tool-surface golden — nothing registered here reaches
  // `tools/list`, and the resident per-conversation cost the ratchet guards is untouched.
  // Unconditional, and that is the ruling rather than an omission: a prompt is inert until a
  // person picks it out of a menu, so there is no risk for a seat flag to gate. Hosted
  // deployments share this createEngine and inherit it for the same reason.
  registerPrompts(ctx);

  // The legacy-era subscription verbs, accepted and answered `{}`. Declaring `resources.subscribe`
  // (above) is what a legacy host reads as "resources/subscribe will be honoured", and until this
  // pair existed the honest answer to that verb was -32601 Method not found — measured 2026-08-16
  // on every legacy wire era the SDK negotiates (2024-11-05 → 2025-11-25). Nothing else needed to
  // change, because the engine never tracked subscribers in the first place: bridgeInvalidations
  // (below) sends `notifications/resources/updated` for every app-plane write to whoever is on the
  // connection, which is the strictly larger promise. So "subscribe" here is a receipt for a
  // delivery that was already happening; the handlers exist so the declaration stops lying, not
  // to gate anything. Modern (2026-07-28) hosts never send these — that era replaced them with
  // `subscriptions/listen`, which the SDK serves itself off the same declared bit.
  server.server.setRequestHandler("resources/subscribe", async () => ({}));
  server.server.setRequestHandler("resources/unsubscribe", async () => ({}));

  // Must run AFTER every registration: it wraps the handler the SDK built around the finished set.
  // Only the `$schema` trim remains here — the SEP-2549 cache fields moved into ServerOptions
  // (cacheHints above, per-resource cacheHint in tools/apps.mjs) where the SDK emits them itself.
  installSchemaTrim(server);

  // …and the same seam again, for the names that must answer without being advertised. Wrapping
  // the SDK's own finished handler rather than rebuilding the list is not a shortcut: the
  // descriptor generation lives inside the SDK (schema conversion included), so any second copy
  // would be a second answer waiting to disagree with the first about a byte. Filtering what that
  // handler produced can only ever REMOVE entries, which is exactly the promise — and with an
  // empty set the wrapper is not installed at all, so the wire is provably untouched.
  //
  // The result object's IDENTITY is preserved for the reason installSchemaTrim states: the SDK
  // hangs its per-operation cache-hint fallback on a Symbol attached to that object, and a
  // rebuilt result silently downgrades every tools/list to {ttlMs: 0, cacheScope: "private"}.
  installUnlistedFilter(server, unlistedTools);

  // The invalidation bridge (W2). Wired LAST because it needs the finished app registry, and
  // released with the connection: engines are per-connection, the store's emitter is not, so a
  // subscription that outlives its server is a listener writing to a closed transport forever.
  // The transport owns `onclose`; chaining rather than assigning keeps whatever it already had.
  const releaseBridge = bridgeInvalidations(store, server, { dynamicTools, hasApp: ctx.hasApp });
  const priorClose = server.server.onclose;
  server.server.onclose = () => { releaseBridge(); if (typeof priorClose === "function") priorClose(); };

  return server;
}
