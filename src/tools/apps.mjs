// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// tools/apps.mjs — the app registry surface: the per-app wiring, the universal opener,
// and the creation loop (guide / list / read / save).
// Registered by engine.mjs. Moved here verbatim: the tool surface is byte-identical to before
// the split, which test/tool-surface.mjs proves against its golden file.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "../mcp-apps.mjs";
import { LOADER } from "../cache-hints.mjs";
import { APP_NAME_RE } from "../store.mjs";
import { wrapApp, wrapLoader, stampStage } from "../shell.mjs";
import { GUIDE, guideChapter } from "../guide.mjs";
import { RO, WRITE, WRITE_NOT_IDEMPOTENT, snapshotSchema, capsShape, cmdArgs, SEEDED_APPS, RESERVED_APP_NAMES, LOCKED_APPS, SCENE_CATEGORIES, tierOf, RUNNER_REQUIRED_HTML, defaultCollectionFor, stageWidthFor, stageDisplayFor, answer, toMcp, textWindow } from "../contracts.mjs";
import { sliceHash, locateNode, applyRangeEdits } from "../edit-range.mjs";
import { makeFunctionHost } from "../functions.mjs";
import { editTelemetry } from "../edit-telemetry.mjs";

// "Does this document actually talk to the API?" — the shapes a real app reaches it by.
// The original test was the literal `oma.` alone, which fired on working code: `const OMA =
// window.oma` and `const { oma } = window` are both idiomatic, and one measured author re-sent an
// entire 33KB document to silence the false warning. A linter that cries wolf costs more than the
// miss it prevents, so the bar is "any plausible reference", not "the one spelling we expected".
// Exported so the false-positive cases stay pinned in test/server-smoke.
export const OMA_REFERENCE_RE = /\boma\s*[.[]|window\s*\.\s*oma\b|window\s*\[\s*["']oma["']\s*\]|\{[^{}]*\boma\b[^{}]*\}\s*=/;

// suggested_kind (§8-R3) — a DIAGNOSTIC, never a decision. "app" when the document binds
// persistent state (the oma data/file verbs, the data_*/file_* tools, or declared collections);
// "visual" otherwise. `oma.pref` is deliberately NOT a binding — theming a one-shot visual does
// not make it a keeper. The arbitration forbids this value from influencing enumeration, closure,
// export or retention, and from ever upgrading anything by itself — which is why it ships as a
// prose sentence and never as a structured field: a ban is easiest to hold on a value no program
// can reach.
const BINDS_RE = /\boma\s*\.\s*(addItem|updateItem|moveItem|deleteItem|onChange|readCollection|refresh|files)\b|\bdata_(add_item|update_item|move_item|delete_item|list|query|batch|collections|changes|version)\b|\bfile_(write|read|list|delete)\b/;
export const suggestedKind = (ui, manifest) =>
  ((manifest && manifest.collections && typeof manifest.collections === "object"
    && Object.keys(manifest.collections).length > 0) || BINDS_RE.test(String(ui ?? "")))
    ? "app" : "visual";

// The universal opener's document. Module-level because cache-hints.mjs has to tell it apart from
// the per-app resources: this one is built from the engine binary alone (same bytes for every
// tenant, every store), and that is exactly the difference between a shareable cache and a leak.
export const LOADER_URI = "ui://open-mcp-apps/app.html";

// The app-write receipt, shared by save_app / edit_app / (conflict answers).
// Terse for the same reason ackSchema is: outputSchema bytes are resident for every conversation.
const saveAckSchema = {
  ok: z.boolean(),
  name: z.string().optional(),
  version: z.number().optional(),
  created: z.boolean().optional(),
  size: z.number().optional(),
  prev_size: z.number().nullable().optional(),
  manifest_action: z.string().optional(),
  applied: z.number().optional(),
  expected_version: z.number().optional(),
  reason: z.string().optional(),
  note: z.string().optional(),
  eot: z.string().optional(),
};

export function register(ctx) {
  const { server, store, hostName, run, failNote, fail, computeCaps, viewBase, widgetDomain } = ctx;

  // A real, clickable URL for the HUMAN, produced only when this engine actually has a viewer to
  // link to. Bare stdio has none and prints none — the same rule list_apps already follows, and for
  // the same reason: a URL that 404s teaches the user the thing is broken, which is worse than no
  // URL. Where it matters most is a terminal host, where an app can be built and never drawn: the
  // widget channel is the only way to SEE it, and a CLI does not have one.
  const viewRoot = viewBase && /^https?:\/\//.test(viewBase)
    ? `${String(viewBase).replace(/\/+$/, "")}/view/`
    : null;
  const viewUrl = (name) => (viewRoot ? viewRoot + encodeURIComponent(name) : null);

  // R1 tripwire data source (W-E): one JSONL line per editing event, sidecar next to the DB.
  // recordEdit returns a count when a REPORT_EVERY boundary is crossed — that becomes a
  // one-line milestone note in the ack, and a human (Leo) runs the report; nothing automatic.
  const recordEdit = editTelemetry(store.dataDir);


  // ---------------------------------------------------------------- widget security declaration
  // What a host should let this widget reach. Ours reaches NOTHING: every shipped app is a
  // self-contained document (verified 2026-07-28 — zero absolute URLs across all 19 apps and
  // the runtime), so the honest declaration is also the strictest one there is, and it turns "we
  // are self-contained" from a claim in a README into a machine-readable one on the wire.
  //
  //   · frameDomains is DELIBERATELY not declared. Omitted means frame-src 'none', and declaring it
  //     invites a stricter review for a capability we do not want. Our nested previews are `srcdoc`
  //     iframes, which are unaffected — measured, not assumed: a srcdoc child with
  //     sandbox="allow-scripts" loads normally under frame-src 'none' in Chrome.
  //   · redirect_domains carries the viewer origin when there IS one, because oma.openLink sends
  //     the user there (the Browse button). It is per-deployment, so it is derived, never a literal.
  //   · The snake_case `openai/widgetCSP` twin is ChatGPT's documented compatibility key; its own
  //     reference says the standard fields are superseded by _meta.ui.csp but redirect_domains is
  //     still read from the legacy key, so both are sent and they agree.
  const viewerOrigin = (() => {
    try { return viewBase && /^https?:\/\//.test(viewBase) ? new URL(viewBase).origin : null; } catch { return null; }
  })();
  const redirects = viewerOrigin ? [viewerOrigin] : [];
  const UI_SECURITY = {
    ui: { csp: { connectDomains: [], resourceDomains: [] }, ...(widgetDomain ? { domain: widgetDomain } : {}) },
    "openai/widgetCSP": { connect_domains: [], resource_domains: [], ...(redirects.length ? { redirect_domains: redirects } : {}) },
    ...(widgetDomain ? { "openai/widgetDomain": widgetDomain } : {}),
  };
  // ---------------------------------------------------------- dynamic app wiring
  // ⚠️ E12 — do not turn this on without re-reading this paragraph. Beyond the per-tool budget,
  // registering a tool per app means the tool list CHANGES whenever save_app runs, and
  // prompt caching is an exact-prefix match over tools+system+messages: measured, cache_read drops
  // to 0. So every app the AI creates re-bills the entire conversation from scratch. The cost
  // is not the extra tools, it is that building an app invalidates everything said before it.
  // Per-app open_<name> tools are OPT-IN (OMA_DYNAMIC_TOOLS=1). Every tool costs a
  // separate host permission prompt and the tool list balloons with the registry — the
  // universal open_app covers all apps behind ONE permission grant, and never
  // suffers the host's slow tools/list_changed propagation.
  const DYNAMIC_TOOLS = process.env.OMA_DYNAMIC_TOOLS === "1";
  const registered = new Set();
  function registerApp(name) {
    if (registered.has(name)) return; // callbacks read the registry live; updates need no re-register
    registered.add(name);
    const uri = `ui://open-mcp-apps/${name}.html`;
    // THE ENGINE MUST BOOT ON DATA IT WOULD NOT ACCEPT TODAY.
    //
    // `app` joined RESERVED_APP_NAMES on 2026-07-29. Reserving a name stops the next one; it
    // says nothing about the stores that already exist, and this engine is public. An app
    // called `app` claims exactly the universal loader's URI, so the loader's own registration
    // below hit "already registered", createEngine threw, and the server never came up — and a
    // server that will not start cannot be asked to delete the row that stops it. The only way out
    // was hand-editing SQLite.
    //
    // The app yields, not the engine: it loses its per-app DIRECT resource and keeps everything
    // else — open_app still opens it, its data and history are untouched. Note this cannot be
    // fixed by wrapping the loop below in try/catch: the throw lands on the LOADER's registration,
    // which is not in the loop.
    if (uri === LOADER_URI) {
      console.warn(`[oma] app "${name}" shares the loader's resource URI, so it gets no per-app ` +
        `resource; it still opens through open_app. Renaming it restores direct embedding.`);
      return;
    }

    // No cacheHint: the SDK default ({ttlMs: 0, cacheScope: "private"}) IS the store-derived
    // answer — stated once in cache-hints.mjs, inherited here rather than restated (elegance A18).
    registerAppResource(server, `app-${name}`, uri, { mimeType: RESOURCE_MIME_TYPE, _meta: UI_SECURITY }, async () => {
      const comp = store.getApp(name);
      if (!comp) throw new Error(`app ${name} not found`);
      // Tier gate (docs/security-model.md §2.3): this per-app resource serves DIRECT mode
      // (wrapApp = the real window.oma, full trust) and has no runner branch — the loader's
      // tier branch (shell.mjs, via oma.embed) covers only the open_app path. Non-local tiers
      // fail closed to the placeholder; every app today is local, so nothing changes until one isn't.
      if (tierOf(comp.author) !== "local")
        return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: RUNNER_REQUIRED_HTML, _meta: UI_SECURITY }] };
      // The binding rides IN the document: Claude Desktop's dynamic-tools mode delivers neither
      // toolinput nor a collection through its pushes (live-test 2026-07-28, writes bounced as
      // collection:null), and this resource knows its app at serve time — the one place
      // the open_app loader path can't know it.
      // viewRoot rides along for the same reason the binding does — this document runs in an
      // opaque origin and cannot derive it. It is what makes the system badge's "Open in browser"
      // exist (and oma.viewBase absolute) inside a host; an engine without a viewer stamps
      // nothing, and the item is not drawn (D-13 ②).
      return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: wrapApp(comp.ui, { app: name, collection: defaultCollectionFor(comp), stage: stageWidthFor(comp), viewBase: viewRoot }), _meta: UI_SECURITY }] };
    });

    if (!DYNAMIC_TOOLS) return;
    registerAppTool(
      server,
      `open_${name.replaceAll("-", "_")}`,
      {
        title: `Open ${name}`,
        annotations: RO,
        description: `Open the "${name}" app as an interactive widget — use when the user wants to SEE or OPERATE this data (to merely read facts, use data_list instead). Optionally pass a collection name to bind it to a specific data collection (default: the one the app declares, else "${name}").`,
        inputSchema: { collection: z.string().optional().describe(`data collection to bind (default: the app's declared one, else "${name}")`) },
        outputSchema: { ...snapshotSchema, app: z.string().optional(), returned: z.number().optional(), eot: z.string().optional() },
        _meta: { ui: { resourceUri: uri } },
      },
      async (a) => {
        // Zero rows, same ruling as open_app: the widget refetches on mount.
        // …and the SAME binding rule. These opt-in per-app tools are a second door onto the
        // same act, so a different default here would mean open_trip_board and open_app
        // disagreeing about where one app lives — read live, because a save may have changed it.
        // No `|| name` tail. defaultCollectionFor already falls back to the app's own name
        // when the app declares nothing, so the only way it answers nothing is an app that is
        // GONE — deleted between this tool being registered and being called. Falling back to the
        // name there invents a binding for an app that no longer exists, and a widget bound to an
        // invented collection writes into it silently. Fail the way the sibling path already does.
        const comp = store.getApp(name);
        if (!comp) return fail(`App "${name}" no longer exists.`);
        // …and the SAME live-pointer rule as open_app, display exemption included: these per-app
        // tools are a second door onto one act, so a wall display must not depend on which door
        // the host happened to offer.
        if (!stageDisplayFor(comp)) store.touchLiveApp(name);
        const collection = (a && a.collection) || defaultCollectionFor(comp);
        const v = store.dataVersion();
        return toMcp(answer.page(
          { app: name, collection, items: [], version: v.seq,
            settings_version: v.settings_version, files_version: v.files_version, host: hostName() },
          { returned: 0, total: store.countItems(collection),
            text: `Opened "${name}" on collection "${collection}". The widget loads its own data.` },
        ));
      },
    );
  }
  // …and a belt for the unknown collisions: one bad row must never be the reason a whole deployment
  // cannot start. Anything unexpected costs that app its per-app resource and nothing else.
  for (const c of store.listApps()) {
    try { registerApp(c.name); }
    catch (e) { console.warn(`[oma] app "${c.name}" could not be registered (${e && e.message}); it still opens through open_app`); }
  }

  // ------------------------------------------------- the universal opener (static tool)
  // Loader cache scope, decided here because both inputs are knobs of THIS engine: public only
  // while the document really is the same answer for everybody, and widgetDomain / the viewer
  // redirect origin make it deployment-specific. Doctrine + the measured stg incident behind
  // ttlMs: 0 live in cache-hints.mjs (LOADER).
  // Deployment-derived security fields present ⇒ the answer is tenant-specific ⇒ OMIT the hint
  // and inherit the SDK's private/zero default; only the truly-universal loader declares public.
  // The two conditions still cover it now that the document itself may carry the viewer URL:
  // `redirects` is non-empty on exactly the engines that stamp one, so a loader carrying a
  // deployment's viewer base can never be the one declaring itself publicly cacheable.
  const loaderHint = (widgetDomain || redirects.length) ? {} : { cacheHint: LOADER };
  registerAppResource(server, "app-loader", LOADER_URI, { mimeType: RESOURCE_MIME_TYPE, ...loaderHint, _meta: UI_SECURITY },
    async () => ({ contents: [{ uri: LOADER_URI, mimeType: RESOURCE_MIME_TYPE, text: wrapLoader({ viewBase: viewRoot }), _meta: UI_SECURITY }] }));

  registerAppTool(
    server,
    "open_app",
    {
      title: "Open any app",
      annotations: RO,
      description: "Open ANY app from the registry by name as an interactive widget — use when the user wants to SEE or OPERATE the data (to merely read facts, use data_list — no UI). Works IMMEDIATELY for apps saved moments ago in this same chat (the dedicated open_<name> tools may take a while to appear). Prefer reusing an app on a different collection over creating near-duplicate apps.",
      inputSchema: {
        app: z.string().describe("app name in the registry (see list_apps)"),
        collection: z.string().optional().describe("data collection to bind (default: the one the app declares, else its own name)"),
      },
      outputSchema: { ...snapshotSchema, app: z.string(), returned: z.number().optional(), eot: z.string().optional() },
      _meta: { ui: { resourceUri: LOADER_URI } },
    },
    async (a) => {
      const comp = store.getApp(a.app);
      if (!comp) return fail(`No app "${a.app}" in the registry. list_apps shows what exists.`);
      // THE ONE PLACE "the app the AI opened last" is recorded — a single overwritten field, no
      // ledger event (store.touchLiveApp says why). It sits AFTER the existence check on purpose:
      // a failed open puts nothing on screen, so it must not move a pointer that says what IS on
      // screen. Only the open_* doors record; app_html does not, because every `@live` brick and
      // every loader fetch their source through it and would otherwise keep re-electing themselves.
      //
      // …and a DISPLAY app records nothing (contracts.mjs stageDisplayFor). An app carrying an
      // `@live` brick is a frame around whatever the pointer names, so pointing at it would aim
      // the wall at itself. This is the OUTER of the two walls: it keeps the bad value from ever
      // being written. The inner one lives in the brick, which refuses to mount a display app no
      // matter how the pointer came to name one — an old row, a hand-written store, a door written
      // after this line.
      if (!stageDisplayFor(comp)) store.touchLiveApp(a.app);
      // ZERO rows, by ruling (redesign row #4, reaffirmed 2026-07-26): the widget always refetches
      // on mount, so rows here would travel twice on a host with a widget and once for nothing on a
      // host without one. total and version still ride — the model knows the size of what it opened
      // without a single row moving. Measured cost: ~0.9s to the widget's first frame, accepted.
      // Binding order: what the caller ASKED for, then what the app DECLARED, then its name.
      // The declaration used to play no part at all, so an app whose rows live in a differently
      // named collection opened BLANK unless the caller happened to pass `collection` — measured
      // at 8 of 9 authoring runs, two of which wrote their own workaround rather than report it.
      // Only an UNAMBIGUOUS declaration (exactly one collection) is used: with two or more there
      // is no "the" collection to pick, and guessing would be worse than the documented default.
      const collection = a.collection || defaultCollectionFor(comp);
      const v = store.dataVersion();
      const total = store.countItems(collection);
      return toMcp(answer.page(
        { app: a.app, collection, items: [], version: v.seq,
          settings_version: v.settings_version, files_version: v.files_version, host: hostName() },
        { returned: 0, total,
          text: `Opened "${a.app}" on collection "${collection}" (${total} item(s), seq ${v.seq}). The widget loads its own data; if YOU need rows, read data_list.`
            + (viewUrl(a.app) ? ` In a browser: ${viewUrl(a.app)}` : "") },
      ));
    },
  );

  server.registerTool(
    "app_html",
    {
      title: "App HTML (internal)",
      annotations: RO,
      description: "Internal: returns raw app HTML plus its trust tier and capability grants for the universal loader widget. Not useful to call directly — use get_app to read source.",
      inputSchema: { name: z.string() },
      outputSchema: {
        name: z.string(), version: z.number(), html: z.string(),
        author: z.string(),
        tier: z.enum(["local", "unreviewed"]),
        locked: z.boolean().describe("a fixed system app (settings renders these read-only)"),
        // WHAT THIS APP OPENS ON, computed by the one function that owns that question
        // (contracts.mjs defaultCollectionFor — /view mounts by the same rule, and a second copy is
        // a second answer waiting to disagree). It is here because the generic loader document
        // cannot carry a binding of its own: one document serves every app, so state.collection had
        // only ever one source, a host push. `open_app`'s collection input is optional and
        // models routinely omit it, so the ordinary refresh leaves a widget that knows which app it
        // is and still cannot write.
        //
        // DECLARED, not smuggled through structuredContent. A schema that lists three of its four
        // keys is a schema that lies, and this key is read on every first paint — the opposite of
        // delete_app, which declares nothing at all and is legible for it.
        collection: z.string().describe("the collection this app opens on"),
        caps: capsShape,
        // The declaration as the engine MATERIALISED it. The settings app used to re-parse the html
        // in the browser to find it, which meant two parsers over the same untrusted document and
        // two chances to disagree about what an app declared. One source, read once, at save.
        declaration: z.record(z.string(), z.any()).nullable().optional(),
      },
    },
    async (a) => {
      const comp = store.getApp(a.name);
      if (!comp) return fail(`No app "${a.name}".`);
      const tier = tierOf(comp.author);
      // Always the whole document. This call is the loader widget's mount source — the widget
      // cannot assemble windows, and the host↔widget bridge is the one channel measured intact
      // well past the model-facing cut (≥120K). The budget discipline therefore deliberately does
      // not apply here; a model reading source has get_app, which windows by default.
      // `html` stays the FIELD name here — it names the payload's format for the loader widget
      // (shell-runtime reads r.html), not the registry slot. The value is the ui slot.
      //
      // …carrying the stage class, because this is the loader's mount source and the loader is
      // the third door onto the same document (the other two — /view and the per-app ui://
      // resource — get it from wrapApp). Stamped in the BYTES rather than announced in a new
      // structuredContent key: the tool surface is resident context for every host on every
      // connection, and this is a rendering detail the model has no use for. `declaration` right
      // above already carries the manifest verbatim for anyone who wants to read the field
      // itself; what the loader needs is the class, and one authority computes it (stageWidthFor).
      return {
        content: [{ type: "text", text: `(app "${comp.name}" v${comp.version}, ${comp.ui.length} chars, tier ${tier} — consumed by the loader widget)` }],
        structuredContent: { name: comp.name, version: comp.version, author: comp.author, tier,
          locked: LOCKED_APPS.has(comp.name), collection: defaultCollectionFor(comp),
          caps: computeCaps(comp.name, tier), declaration: comp.manifest ? JSON.parse(comp.manifest) : null,
          html: stampStage(comp.ui, stageWidthFor(comp)) },
      };
    },
  );

  // -------------------------------------------------------------------- creation loop
  server.registerTool(
    "get_app_guide",
    {
      title: "App authoring guide",
      annotations: RO,
      description: "READ THIS FIRST before creating or editing an app. Returns the window.oma API contract, available CSS design tokens, the data model, and a minimal working app template.",
      // The chapter list is frozen at first publish: inputSchema bytes are resident, so a value
      // added later is a tools/list change for everyone. All four exist from day one; `functions`
      // says so plainly while the pillar is still behind a flag.
      inputSchema: {
        topic: z.enum(["basics", "functions", "embed", "style"]).optional()
          .describe("which chapter (default basics: the contract + template). Each chapter stands alone"),
      },
    },
    async (a) => ({ content: [{ type: "text", text: guideChapter(a?.topic) }] }),
  );

  server.registerTool(
    "list_apps",
    {
      title: "List apps",
      annotations: RO,
      description: "List UI apps in the registry (reusable across all chats). If the UI the user wants already exists, prefer opening it over creating a new one. Lists the user's openable apps by default — pass name to look one up, or widen with kind/visibility.",
      // Three params, frozen with this publish: name (the "open my X" lookup — exact match, so a
      // registry of any size answers in one call), kind and visibility (the two columns that decide
      // what is an app and what is retired/long-tail).
      inputSchema: {
        name: z.string().optional().describe("exact app name — the fastest way to answer \"open my X\""),
        kind: z.enum(["app", "visual", "primitive", "any"]).optional().describe("default app: what a person opens and reuses"),
        visibility: z.enum(["featured", "listed", "unlisted", "archived", "any"]).optional().describe("default featured+listed; archived/unlisted are retired or long-tail"),
      },
    },
    async (a = {}) => {
      // An exact-name lookup is explicit intent: the defaults exist to scope BROWSING, and letting
      // them veto a lookup makes the tool report that an existing app does not exist.
      // Filters the caller actually passed still apply.
      const all = store.listApps({
        name: a.name,
        kinds: a.kind === "any" ? undefined : a.kind ? [a.kind] : a.name ? undefined : ["app"],
        visibilities: a.visibility === "any" ? undefined : a.visibility ? [a.visibility] : a.name ? undefined : ["featured", "listed"],
      });
      const comps = all;
      const own = comps.filter((c) => !SEEDED_APPS.has(c.name));
      // E10: the "→ open_<name>" pointer is only true when per-app tools are registered,
      // and they are OPT-IN. With the default configuration those tools do not exist, so printing
      // the arrow was telling the model to call something that would fail — and the universal
      // open_app, which always works, is what it should reach for instead.
      const line = (c) => `- ${c.name} v${c.version} (${c.html_size} chars, by ${c.author})` +
        (SEEDED_APPS.has(c.name) ? " [ships with the engine — not one of the user's apps]" : "") +
        ` — ${c.description || "no description"}` +
        // A REAL link, only when this engine actually has a viewer to link to (local http server /
        // hosted viewBase). Bare stdio has none, so it prints none — a URL that 404s teaches the
        // user this thing is broken, which is worse than no URL.
        (viewBase ? `  → ${String(viewBase).replace(/\/+$/, "")}/view/${encodeURIComponent(c.name)}` : "") +
        (DYNAMIC_TOOLS ? `  → open_${c.name.replaceAll("-", "_")}` : "");
      // Found by the live-model eval: a brand-new user's registry is NOT empty — we seed three
      // system apps — so the one line that pushed toward BUILDING ("Registry is empty…") could
      // never fire, and the model saw three perfectly plausible apps and opened one instead. The
      // instructions already forbid exactly that, in prose. Prose lost. The fact now lives in the
      // data the model is looking at when it decides.
      // A filtered list must never read as the whole registry. `total` says how many matched,
      // before the rows — the same reason a page reports the collection's size and not its own length.
      const scoped = a.name || a.kind || a.visibility;
      const head = scoped ? `${all.length} match:` : null;
      const empty = a.name
        ? `No app named "${a.name}". Call list_apps with no arguments to see what exists.`
        : scoped
        ? "Nothing matches that filter. Call list_apps with no arguments (or kind:\"any\", visibility:\"any\") to widen."
        : "Registry is empty. Call get_app_guide, then save_app to create the first one.";
      const text = comps.length
        ? [head, comps.map(line).join("\n"), own.length ? null :
            "The user has NO apps of their own yet — everything above ships with the engine and is not " +
            "an answer to what they want. Build one: get_app_guide, then save_app, then open_app."]
            .filter(Boolean).join("\n")
        : empty;
      // `locked` rides each row so the settings pane can tell fixed system UI apart without a
      // second tool (app_permissions retired 2026-08-04 — app_html carries the per-app caps).
      return { content: [{ type: "text", text }], structuredContent: { total: all.length, shown: comps.length,
        apps: comps.map((c) => ({ ...c, locked: LOCKED_APPS.has(c.name) })) } };
    },
  );

  server.registerTool(
    "get_app",
    {
      title: "Get app source",
      annotations: RO,
      description: "Read an app's ui source as a WINDOW — offset/length select it, next_offset continues, total is the full length. Windows exist because some hosts silently drop the MIDDLE of an oversized result: a big app read whole can arrive mutilated with no sign, and an edit saved from it destroys the source. Carries version — the expected_version for edit_app / save_app — and hash, the expect_hash for a range edit of exactly this window. node jumps the window to the element marked data-oma-node=\"<node>\". slot:\"manifest\" returns the declaration object instead (no window mechanics).",
      inputSchema: {
        name: z.string(),
        slot: z.enum(["ui", "manifest"]).optional().describe("default ui; manifest returns {manifest: object|null} whole"),
        offset: z.number().optional().describe("character offset to read from (default 0; ui slot only)"),
        length: z.number().optional().describe("max characters for this window (default fits the result budget; ui slot only)"),
        node: z.string().optional().describe("read the element marked data-oma-node=\"<node>\" — the window (and its hash) covers exactly that element (ui slot only)"),
      },
      outputSchema: {
        name: z.string(), version: z.number(),
        returned: z.number().optional(), total: z.number().optional(),
        offset: z.number().optional(), text: z.string().optional(), hash: z.string().optional(),
        next_offset: z.number().nullable().optional(),
        manifest: z.record(z.string(), z.any()).nullable().optional(),
        eot: z.string().optional(),
      },
    },
    async (a) => {
      const comp = store.getApp(a.name);
      if (!comp) return fail(`No app "${a.name}". list_apps shows what exists.`);
      // The manifest slot is small and structured — it returns WHOLE, with the same version
      // (the OCC token covers both slots, because a version snapshots both).
      if (a.slot === "manifest") {
        const manifest = comp.manifest ? JSON.parse(comp.manifest) : null;
        return toMcp(answer.chunk(
          { name: comp.name, version: comp.version, manifest },
          { text: `// ${comp.name} v${comp.version} — manifest slot\n${JSON.stringify(manifest, null, 2)}` },
        ));
      }
      // node resolves to a span at READ time — edit_app never runs a locator, so ambiguity
      // (missing/duplicated marker, broken markup) surfaces here, where re-asking is cheap.
      let want = { offset: a.offset, length: a.length }, nodeNote = "";
      if (a.node != null) {
        const span = locateNode(comp.ui, a.node);
        if (!span.ok) return fail(`data-oma-node lookup failed: ${span.detail}`);
        want = { offset: span.offset, length: span.length };
        nodeNote = ` — <${span.tag} data-oma-node="${a.node}">`;
      }
      const w = textWindow(comp.ui, want,
        (t) => ({ name: comp.name, version: comp.version, offset: 0, next_offset: 0, total: comp.ui.length, returned: t.length, text: t, eot: "·eot" }));
      // The hash covers EXACTLY the returned text: a range edit of {offset, returned, hash}
      // round-trips without the model ever computing anything.
      const hash = sliceHash(w.text);
      const head = `// ${comp.name} v${comp.version} — chars ${w.offset}–${w.offset + w.text.length} of ${w.total}${nodeNote} — hash ${hash}` +
        (w.next_offset != null ? ` (continue at offset ${w.next_offset})` : " (end)");
      return toMcp(answer.chunk(
        { name: comp.name, version: comp.version, offset: w.offset, hash, next_offset: w.next_offset, text: w.text },
        { returned: w.text.length, total: w.total, text: `${head}\n${w.text}` },
      ));
    },
  );

  server.registerTool(
    "save_app",
    {
      title: "Save app",
      annotations: WRITE,
      description: "Create or update a UI app in the persistent registry. Two slots, each optional on update (an omitted slot keeps its current value): ui — the complete self-contained HTML document (contract in get_app_guide; window.oma, no external resources, NO embedded manifest block) — and manifest, the app's declaration as a JSON object (kind, collections, settings, scene; keys in get_app_guide). manifest: null clears the declaration. Creating needs ui. Every save snapshots both slots as one new version (history kept). After saving, open it IMMEDIATELY with open_app.",
      inputSchema: {
        name: z.string().describe("app name, ^[a-z][a-z0-9-]{0,31}$ (e.g. 'kanban', 'habit-tracker')"),
        ui: z.string().optional().describe("complete self-contained HTML document using window.oma; omit on update to keep the current one"),
        // A WIDE object on purpose: declaring the manifest's known keys here would put every new
        // vocabulary word into the resident tools/list bytes AND let the SDK strip unknown keys —
        // breaking the "a newer document must still save on an older engine" contract. Depth is
        // validated by the store (manifestShapeError), which preserves what it does not know.
        manifest: z.record(z.string(), z.any()).nullable().optional().describe("declaration object (whole-value replace), null to clear, omit to keep"),
        description: z.string().optional().describe("one line: what this app shows and what data fields it uses"),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
        expected_version: z.number().optional().describe("REQUIRED when overwriting an existing app: the version you read (get_app). Creating a new name needs none"),
      },
      outputSchema: saveAckSchema,
    },
    async (a) => {
      if (!APP_NAME_RE.test(a.name || "")) return fail("Invalid name: must match ^[a-z][a-z0-9-]{0,31}$ (lowercase, digits, hyphens).");
      // The list is READ from the set, not retyped beside it. The hand-kept copy listed the
      // original six and silently went stale when `app`, `app` and `loader` were added — so a
      // user naming an app `app` was told it clashed with a settings group, which is not why it was
      // refused. A refusal that explains the wrong rule is worse than a terse one.
      if (RESERVED_APP_NAMES.has(a.name)) return fail(`"${a.name}" is a reserved name (${[...RESERVED_APP_NAMES].join(", ")}) — pick another one.`);
      if (LOCKED_APPS.has(a.name)) return fail(`"${a.name}" is a locked system app — its UI ships with the engine and can't be overwritten here. (dashboard and your own apps are editable.)`);
      // A RETRY must reach a receipt, not die on the freshness guards below — those protect NEW
      // writes, and a replayed command is by definition not one (found by the C review: a created
      // app's lost-reply retry was answered "expected_version_required"). The store still
      // arbitrates: a mismatched command under this id is command_id_reused.
      if (a.command_id) {
        const prior = store.priorReceipt(a.command_id);
        if (prior) {
          if (prior.event_type !== "component_saved" || prior.aggregate_id !== a.name)
            return fail(failNote({ error: "command_id_reused" }));
          return toMcp(answer.ack(
            { ok: true, name: a.name, version: prior.seq, ...(prior.payload?.size != null ? { size: prior.payload.size } : {}),
              note: "already saved (idempotent replay)" },
            `Already saved — "${a.name}" is at v${prior.seq} from this same command_id.`));
        }
      }
      // Overwrite requires the version the author READ (vision row #2 / redesign row #5): a save
      // that never saw the current source is exactly how a stub eats a live app — and on a
      // host that mutilates large reads, "what you saw" and "what exists" can silently differ.
      // Creation is exempt: there is nothing to have read.
      const existing = store.getApp(a.name);
      if (existing && a.expected_version == null)
        return toMcp(answer.fail("expected_version_required", { name: a.name, version: existing.version },
          `"${a.name}" already exists at v${existing.version} (${existing.ui.length.toLocaleString()} chars). Overwriting requires expected_version — read it first (get_app) and pass expected_version: ${existing.version}. A NEW app needs a different name.`), { isError: true });
      const warnings = [];
      const notes = [];
      // Slot-scoped lint: each warning fires only when its slot actually travels on THIS call —
      // a manifest-only save must not re-lint a document it is not touching.
      if (a.manifest && a.manifest.scene && a.manifest.scene.category_id != null
          && !SCENE_CATEGORIES.has(a.manifest.scene.category_id))
        warnings.push(`Unknown scene.category_id "${a.manifest.scene.category_id}" — it is stored as declared but the Library will not file it. Valid: ${[...SCENE_CATEGORIES].join(", ")}.`);
      // Accept every shape a real app reaches the API by, not just the literal `oma.`:
      // `window.oma`, an alias (`const OMA = window.oma`), bracket access, and destructuring all
      // count. The narrow test fired on working code — one measured author re-sent an entire 33KB
      // document to silence it — and a warning that cries wolf costs more than the miss it prevents.
      if (a.ui !== undefined) {
        if (!OMA_REFERENCE_RE.test(a.ui))
          warnings.push("The ui never references the oma API — it will render but won't load or save any data.");
        if (/src\s*=\s*["']https?:|href\s*=\s*["']https?:|@import|fetch\s*\(/i.test(a.ui)) warnings.push("External URLs detected — the sandbox CSP blocks all external resources; the app may break. Inline everything.");
        if (/React\.createElement|ReactDOM|from\s+["']react["']|import\s+React|@babel\/standalone|text\/babel/.test(a.ui)) warnings.push("React/JSX/Babel detected — widgets have no React runtime or JSX compiler (this is not claude.ai Artifacts). Rewrite with vanilla DOM per get_app_guide.");
      }
      const r = store.execute({
        type: "save_app", command_id: a.command_id || randomUUID(),
        name: a.name, ...(a.ui !== undefined ? { ui: a.ui } : {}), ...("manifest" in a ? { manifest: a.manifest } : {}),
        description: a.description || "", actor: "agent", host: hostName(),
        expected_version: a.expected_version,
      });
      if (!r.ok) {
        if (r.conflict) {
          const why = r.deleted
            ? `Version conflict: "${a.name}" was DELETED after you read v${a.expected_version}. Recreating would resurrect a deletion behind your token — if that IS the intent, save again without expected_version; undo/history can also restore it.`
            : `Version conflict: "${a.name}" is at v${r.expected}, not v${a.expected_version}. Someone saved it since you read it — get_app again and re-apply your change.`;
          return toMcp(answer.fail("version_conflict",
            { name: a.name, ...(r.expected != null ? { expected_version: r.expected } : {}) }, why), { isError: true });
        }
        if (r.error === "embedded_manifest_block")
          return fail("The document carries a legacy #oma-manifest block. Declarations moved out of the html: remove the block and pass its JSON as the `manifest` parameter instead (entity-escape the tag if the app genuinely displays it as text).");
        if (r.error === "empty_manifest_use_null")
          return fail("manifest: {} is ambiguous (empty declaration vs clear) — pass manifest: null to clear the declaration, or omit the key to keep it.");
        return fail(r.error === "bad_manifest" ? `Invalid manifest: ${r.detail}.` : failNote(r));
      }
      // A replay's receipt has no size/declaration facts (they belong to the original response) —
      // say what a retry needs and stop, rather than dereferencing fields that are not there.
      if (r.idempotent)
        return toMcp(answer.ack({ ok: true, name: a.name, version: r.version, note: "already saved (idempotent replay)" },
          `Already saved — "${a.name}" is at v${r.version} from this same command_id.`));
      registerApp(a.name);
      // A field contract set over collections that ALREADY have rows: warn about the rows that do
      // not conform. Writes stay possible (the store delta-validates, so legacy rows can be edited
      // but never made worse) — the author just deserves to know the contract is not met yet.
      if (a.manifest && a.manifest.collections) {
        for (const [collName, spec] of Object.entries(a.manifest.collections)) {
          if (!spec || !spec.fields) continue;   // stewardship-only declaration validates nothing
          try {
            const bad = store.snapshot(collName).items.filter((i) => {
              for (const [fn, f] of Object.entries(spec.fields)) {
                const v = i.fields[fn];
                if (v == null) { if (f.required) return true; continue; }
                const t = Array.isArray(v) ? "array" : typeof v;
                if (t !== f.type) return true;
                if (f.enum && !f.enum.includes(v)) return true;
              }
              return false;
            }).length;
            if (bad) warnings.push(`Manifest set on "${collName}", but ${bad} existing item(s) don't conform — they stay editable (violations can't get worse) but won't validate until fixed.`);
          } catch { /* collection may not exist yet — nothing to warn about */ }
        }
      }
      // What this save did to the declaration, said out loud — a manifest-only save must never
      // read as "nothing changed", and an inherited declaration is a fact the next edit depends on.
      if (r.note) notes.push(r.note);
      if (r.manifest_action === "replaced") notes.push("Declaration replaced.");
      else if (r.manifest_action === "cleared") notes.push("Declaration cleared (kind and Library filing reset too).");
      // The one place suggested_kind speaks on a save: a "visual" that binds persistent data has
      // outgrown its declaration. One sentence, fired only on the divergence with an action
      // attached — the reverse case (an app with no bindings yet) is every half-built app and
      // would be noise on each save. Reads the RESOLVED slots from the receipt, so an inherited
      // slot is judged by what it actually is, not by what this call happened to carry.
      const savedUi = a.ui !== undefined ? a.ui : null;
      if (r.kind === "visual" && savedUi !== null && suggestedKind(savedUi, r.manifest ? JSON.parse(r.manifest) : null) === "app")
        notes.push(`suggested_kind: app — this "visual" binds persistent data. Nothing changes by itself; promote_app {name: "${a.name}"} upgrades it in place if it has become a keeper.`);
      // Size pair on every save, unconditionally: a 82,623 → 74 char overwrite has to be visible
      // in the reply that caused it, not discoverable afterwards.
      const sizeNote = r.prev_size == null
        ? `${r.size.toLocaleString()} chars.`
        : `${r.prev_size.toLocaleString()} → ${r.size.toLocaleString()} chars.`;
      // A ui rewrite over an EXISTING app is the "full rewrite" the R1 tripwire divides by: every
      // one of these is an edit that did not go through edit_app. Creations are not edits, and a
      // manifest-only save touches no document — both skip.
      if (!r.created && a.ui !== undefined) recordEdit({ host: hostName(), app: a.name, mode: "rewrite", edits: 1,
        req_bytes: a.ui.length, changed_bytes: a.ui.length, doc_bytes: r.size, outcome: "ok" });
      const lines = [
        `Saved "${a.name}" v${r.version}${r.created ? " (new app)" : " (updated)"} — ${sizeNote}`,
        ...notes,
        `Show it NOW with: open_app {app: "${a.name}"} — works immediately.`,
        ...(viewUrl(a.name) ? [`Or in a browser: ${viewUrl(a.name)}`] : []),
        `It persists and is reusable in every future chat.`,
        ...warnings.map((w) => `⚠ ${w}`),
      ];
      return toMcp(answer.ack(
        { ok: true, name: a.name, version: r.version, created: r.created, size: r.size,
          prev_size: r.prev_size ?? null, manifest_action: r.manifest_action,
          ...(notes.length ? { note: notes.join(" ") } : {}) },
        lines.join("\n"),
      ));
    },
  );

  server.registerTool(
    "edit_app",
    {
      title: "Edit app source",
      annotations: WRITE,
      description: "Surgical edits to an app WITHOUT round-tripping the whole source. Two edit forms, mixable: RANGE {offset, length, expect_hash, new_string} replaces a span you read with get_app (cheapest — echo the window's offset/returned/hash, no anchor text travels); STRING {old_string, new_string} replaces an exact-once match (or set replace_all). Range offsets always address the expected_version document and must not overlap; string edits apply after ranges, in order. All edits apply together, or nothing applies. The #oma-manifest block is re-read on save.",
      inputSchema: {
        ...cmdArgs,
        // `app`, not `name` — save_app/get_app take `name`, and the split is
        // frozen into the published surface, so the only honest fix is to SAY it. Two independent
        // authors each burned a call on the guess. The word costs 34 bytes of tools/list once.
        app: z.string().describe("app name (this tool says `app`; save_app and get_app say `name`)"),
        expected_version: z.number().describe("REQUIRED — the version the edits were authored against (from get_app)"),
        edits: z.array(z.object({
          old_string: z.string().optional().describe("STRING form: exact match including whitespace"),
          new_string: z.string(),
          replace_all: z.boolean().optional(),
          offset: z.number().optional().describe("RANGE form: from get_app's offset"),
          length: z.number().optional().describe("RANGE form: get_app's returned"),
          expect_hash: z.string().optional().describe("RANGE form: get_app's hash for that window"),
        })).describe("each item is RANGE (offset+length+expect_hash) or STRING (old_string)"),
      },
      outputSchema: saveAckSchema,
    },
    async (a) => {
      if (RESERVED_APP_NAMES.has(a.app)) return fail(`"${a.app}" is a reserved namespace.`);
      if (LOCKED_APPS.has(a.app)) return fail(`"${a.app}" is a locked system app — its UI ships with the engine.`);
      // Replay FIRST, before the version guard and before re-applying edits: the original edit may
      // have consumed its own old_string, so a retry re-applied against the new source would die on
      // "0 matches" and never reach the store's replay branch (found by the C review).
      if (a.command_id) {
        const prior = store.priorReceipt(a.command_id);
        if (prior) {
          if (prior.event_type !== "component_saved" || prior.aggregate_id !== a.app)
            return fail(failNote({ error: "command_id_reused" }));
          return toMcp(answer.ack(
            { ok: true, name: a.app, version: prior.seq, applied: Array.isArray(a.edits) ? a.edits.length : 0,
              note: "already applied (idempotent replay)" },
            `Already applied — "${a.app}" is at v${prior.seq} from this same command_id.`));
        }
      }
      const comp = store.getApp(a.app);
      if (!comp) return fail(`No app "${a.app}". list_apps shows what exists.`);
      // Telemetry wrapper: every exit path of the apply below records ONE line (the R1 tripwire
      // counts failures as first-class data — a structural-ambiguity error unrecorded is a
      // tripwire that can never fire). `tel` closes over the request's fixed facts.
      const edits = Array.isArray(a.edits) ? a.edits : [];
      const rangeEdits = edits.filter((e) => e && (e.offset != null || e.length != null || e.expect_hash != null));
      const stringEdits = edits.filter((e) => e && !(e.offset != null || e.length != null || e.expect_hash != null));
      const mode = rangeEdits.length && stringEdits.length ? "mixed" : rangeEdits.length ? "range" : "string";
      const changed = edits.reduce((s, e) => s + Math.max(e?.old_string?.length ?? e?.length ?? 0, e?.new_string?.length ?? 0), 0);
      const tel = (outcome) => recordEdit({ host: hostName(), app: a.app, mode, edits: edits.length,
        req_bytes: JSON.stringify(a.edits ?? "").length, changed_bytes: changed, doc_bytes: comp.ui.length, outcome });
      if (comp.version !== a.expected_version) {
        tel("version_conflict");
        return toMcp(answer.fail("version_conflict", { name: a.app, expected_version: comp.version },
          `"${a.app}" is at v${comp.version}, not v${a.expected_version} — re-read the region you are editing and re-apply.`), { isError: true });
      }
      if (!edits.length) return fail("No edits given — pass edits: [{offset, length, expect_hash, new_string}] (range) or [{old_string, new_string}] (string).");
      for (let i = 0; i < rangeEdits.length; i++) {
        const e = rangeEdits[i];
        if (e.offset == null || e.length == null || !e.expect_hash) {
          tel("bad_range");
          return fail(`Edit ${edits.indexOf(e)}: a range edit needs ALL of offset, length and expect_hash (get_app returns all three). NOTHING was applied.`);
        }
      }
      // Ranges first, against the ORIGINAL expected_version document (offsets never shift);
      // string edits after, in order, on the intermediate result.
      let html = comp.ui;
      if (rangeEdits.length) {
        const r = applyRangeEdits(html, rangeEdits);
        if (!r.ok) { tel(r.error); return fail(`${r.detail}. NOTHING was applied.`); }
        html = r.html;
      }
      for (let i = 0; i < stringEdits.length; i++) {
        const e = stringEdits[i] || {};
        const oldS = String(e.old_string ?? "");
        if (!oldS) { tel("empty_old_string"); return fail(`Edit ${edits.indexOf(e)}: old_string is empty. NOTHING was applied.`); }
        const n = html.split(oldS).length - 1;
        if (n === 0) { tel("no_match"); return fail(`Edit ${edits.indexOf(e)}: old_string not found (0 matches) — read that region again (get_app with offset) and match it exactly, including whitespace. NOTHING was applied.`); }
        if (n > 1 && !e.replace_all) { tel("multi_match"); return fail(`Edit ${edits.indexOf(e)}: old_string matches ${n} times — add surrounding context to pin ONE occurrence, or set replace_all: true. NOTHING was applied.`); }
        html = e.replace_all ? html.split(oldS).join(String(e.new_string ?? "")) : html.replace(oldS, String(e.new_string ?? ""));
      }
      // The apply is pure and the save is OCC-guarded, so read→apply→save is transaction-equivalent:
      // a concurrent save between the read above and this write turns into a version conflict, never
      // a lost update. Empty description preserves the existing one (the store's '' rule); the
      // manifest slot is NOT passed — edit_app edits the ui, the declaration is inherited.
      const r = store.execute({
        type: "save_app", command_id: a.command_id, name: a.app, ui: html,
        description: "", actor: a.actor || "agent", host: hostName(), expected_version: a.expected_version,
      });
      if (!r.ok) {
        if (r.conflict) {
          tel("version_conflict");
          return toMcp(answer.fail("version_conflict", { name: a.app, expected_version: r.expected },
            `Version conflict: "${a.app}" moved to v${r.expected} while editing — re-read and re-apply. NOTHING was applied.`), { isError: true });
        }
        tel(r.error || "store_error");
        return fail(r.error === "bad_manifest" ? `The edited document's declaration is invalid: ${r.detail}. NOTHING was applied — fix the edit and retry.`
          : `${failNote(r)} NOTHING was applied.`);
      }
      if (r.idempotent)
        return toMcp(answer.ack({ ok: true, name: a.app, version: r.version, applied: edits.length, note: "already applied (idempotent replay)" },
          `Already applied — "${a.app}" is at v${r.version} from this same command_id.`));
      const milestone = tel("ok");
      // Same divergence sentence save_app fires, because an edit is just as capable of adding the
      // first binding to a "visual" — and the author deserves the hint at the moment it happened.
      // The manifest is the RESOLVED (inherited) one from the receipt, not something re-parsed.
      const sk = r.kind === "visual" && suggestedKind(html, r.manifest ? JSON.parse(r.manifest) : null) === "app"
        ? `suggested_kind: app — this "visual" now binds persistent data. Nothing changes by itself; promote_app {name: "${a.app}"} upgrades it in place if it has become a keeper.` : null;
      return toMcp(answer.ack(
        { ok: true, name: a.app, version: r.version, size: r.size, prev_size: r.prev_size ?? null,
          applied: edits.length, manifest_action: r.manifest_action, ...(r.note ? { note: r.note } : {}) },
        `Edited "${a.app}" — ${edits.length} edit(s) applied, v${a.expected_version} → v${r.version}, ${(r.prev_size ?? 0).toLocaleString()} → ${r.size.toLocaleString()} chars.` +
          (r.note ? `\n${r.note}` : "") +
          (sk ? `\n${sk}` : "") +
          (milestone ? `\n[telemetry] ${milestone} qualified edits — time for the R1 tripwire report: node scripts/edit-telemetry-report.mjs (reviewer: Leo)` : ""),
      ));
    },
  );

  server.registerTool(
    "promote_app",
    {
      title: "Promote visual to app",
      annotations: WRITE,
      description: "Upgrade a kind:\"visual\" app to a full app in ONE atomic step: the engine flips `kind` in the stored manifest, keeping every other declared key, and saves a new version (OCC-guarded, history kept). Already an app is a no-op; downgrades are refused — demoting is an author edit (save_app with the manifest), not a lifecycle verb.",
      inputSchema: {
        name: z.string().describe("an existing app with kind \"visual\" (list_apps {kind:\"visual\"} shows them)"),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
      },
      // The promote receipt: state facts only. `suggested_kind` never appears here or anywhere
      // structured — see the diagnostic's comment at the top of this file.
      outputSchema: {
        ok: z.boolean(), name: z.string().optional(), version: z.number().optional(),
        kind: z.string().optional(), was: z.string().optional(),
        reason: z.string().optional(), note: z.string().optional(), eot: z.string().optional(),
      },
    },
    async (a) => {
      if (LOCKED_APPS.has(a.name)) return fail(`"${a.name}" is a locked system app — its UI ships with the engine.`);
      // Replay first, same rule as save/edit: the original promote consumed the "visual" state it
      // needs, so a retry re-run from scratch would answer "already an app" instead of reaching
      // the store's replay branch — a receipt, not a shrug.
      if (a.command_id) {
        const prior = store.priorReceipt(a.command_id);
        if (prior) {
          if (prior.event_type !== "component_saved" || prior.aggregate_id !== a.name)
            return fail(failNote({ error: "command_id_reused" }));
          return toMcp(answer.ack(
            { ok: true, name: a.name, version: prior.seq, kind: "app", note: "already promoted (idempotent replay)" },
            `Already promoted — "${a.name}" is at v${prior.seq} from this same command_id.`));
        }
      }
      const comp = store.getApp(a.name);
      if (!comp) return fail(`No app "${a.name}". list_apps {kind:"visual"} shows what can be promoted.`);
      if (comp.kind === "app")
        return toMcp(answer.ack(
          { ok: true, name: a.name, version: comp.version, kind: "app", note: "already an app — nothing to do" },
          `"${a.name}" is already kind "app" (v${comp.version}) — nothing to do.`));
      if (comp.kind !== "visual")
        return fail(`"${a.name}" is kind "${comp.kind}" — promote_app only upgrades "visual" to "app" ("primitive" is a reserved kind with no lifecycle verbs).`);
      // The transaction (§8-R3): read the authoritative manifest, flip its kind, save it back as a
      // whole-slot replacement — every OTHER key rides along untouched, which is exactly why this
      // verb exists (a caller replacing the manifest by hand must first read and re-transmit it,
      // and a forgotten key is a deleted key). The ui slot is inherited; OCC turns a concurrent
      // save into a clean conflict, never a half-promoted app. Riding the save_app command — not
      // a new one — is what makes provenance, undo, history and the invalidation bridge all hold
      // without a second copy of any rule.
      const manifest = comp.manifest ? JSON.parse(comp.manifest) : {};
      const r = store.execute({
        type: "save_app", command_id: a.command_id || randomUUID(), name: a.name,
        manifest: { ...manifest, kind: "app" },
        description: "", actor: "agent", host: hostName(), expected_version: comp.version,
      });
      if (!r.ok) {
        if (r.conflict)
          return toMcp(answer.fail("version_conflict",
            { name: a.name, ...(r.expected != null ? { expected_version: r.expected } : {}) },
            `"${a.name}" changed while promoting (now v${r.expected}) — call promote_app again; it re-reads.`), { isError: true });
        return fail(failNote(r));
      }
      return toMcp(answer.ack(
        { ok: true, name: a.name, version: r.version, kind: "app", was: "visual" },
        `Promoted "${a.name}" — kind visual → app, v${comp.version} → v${r.version}. Same ui, same declaration but for kind; history keeps every version.`,
      ));
    },
  );

  // archive_app's SEAT retired 2026-08-04 (elegance B2, Leo: remove now, re-add when an entry
  // exists). The CONCEPT stays signed (visibility 'archived', the store's archive_app command,
  // its ledger vocabulary and replay semantics — all intact and tested in ledger-smoke): today no
  // surface offers an archive action, so the seat was 1,171 resident bytes with only tests as
  // callers. The day settings grows an Archive button, the seat hooks straight back onto the
  // store command — one release-time cache break, same as any seat arrival.

  // call_function — the function pillar's single dispatcher (W3). The seat returned WITH its
  // executor (the 2026-07-27 retirement's own condition: a registered tool whose only behaviour
  // is to refuse is a schema every conversation pays for). It is OPT-IN per engine (ctx.functions):
  // the local entrypoints turn it on, a hosted multi-tenant plane must never inherit same-process
  // execution by accident — functions.mjs's header carries the whole §2.5-D mapping.
  if (ctx.functions) {
    const fnHost = makeFunctionHost(store);
    server.registerTool(
      "call_function",
      {
        title: "Call an app function",
        // WRITE, not NOT_IDEMPOTENT: inner command_ids are derived from this call's command_id in
        // issue order, so a retried call replays into the ledger's dedup instead of writing twice.
        annotations: WRITE,
        description: "Run a function an app declares (manifest.functions) — data in, data out, no UI needed. Args are checked against the declared params; failures return the declared schema so the retry needs no extra read. The reply carries the return value plus a receipt per write.",
        // Passthrough for the same reason the item writes are: the runner stamps `via` (and forces
        // `app`) on a widget's call, and a strip-mode schema would eat the stamp in transit.
        // W5 (redesign B2, VOCAB): app and function mirror into Mcp-Param-App / Mcp-Param-Function
        // so an EDGE can route and meter the inner operation without parsing the body — behind the
        // dispatcher, Mcp-Name only ever says "call_function". The MUST-verify obligation
        // (header↔body mismatch → -32020) is the SDK's on the modern wire (createMcpHandler),
        // not ours; enforcement itself (rate limits, quotas) is the BFF's, never the header's.
        inputSchema: z.object({
          ...cmdArgs,
          app: z.string().meta({ "x-mcp-header": "App" }),
          function: z.string().meta({ "x-mcp-header": "Function" }),
          args: z.record(z.string(), z.any()).optional(),
        }).passthrough(),
        outputSchema: {
          ok: z.boolean(),
          result: z.any().optional(),
          writes: z.array(z.object({ op: z.string(), id: z.string(), collection: z.string(), seq: z.number(), idempotent: z.boolean().optional() })).optional(),
          reason: z.string().optional(),
          available: z.array(z.string()).optional(),
          violations: z.array(z.string()).optional(),
          note: z.string().optional(),
          eot: z.string().optional(),
        },
      },
      async (a) => {
        const r = fnHost.call({
          app: a.app, function: a.function, args: a.args,
          actor: a.actor || "agent", host: hostName(),
          command_id: a.command_id || randomUUID(),
        });
        if (r.ok) {
          const wrote = r.writes.length
            ? ` — ${r.writes.length} write${r.writes.length === 1 ? "" : "s"} (${r.writes.map((w) => `${w.op} ${w.id}`).join(", ")})`
            : " — no writes";
          return toMcp(answer.ack(
            { ok: true, ...(r.result === null ? {} : { result: r.result }), writes: r.writes },
            `Ran ${a.app}.${a.function}${wrote}.`));
        }
        const teach =
          r.error === "no_such_function"
            ? (r.available.length
              ? `"${a.function}" is not declared by "${a.app}" — its functions are: ${r.available.join(", ")}.`
              : `"${a.app}" declares no functions. An app declares them in manifest.functions with a matching body block — get_app_guide {topic: "functions"}.`)
          : r.error === "bad_args"
            ? `Arguments rejected: ${r.violations.join("; ")}. Declared params: ${JSON.stringify(r.params)}.`
          : r.error === "no_such_app" ? `No app named "${a.app}" — list_apps shows what exists.`
          : r.detail || r.error;
        const body = {};
        if (r.available) body.available = r.available;
        if (r.violations) body.violations = r.violations;
        if (r.writes && r.writes.length) body.writes = r.writes;
        return toMcp(answer.fail(r.error, body, teach), { isError: true });
      },
    );
  }

  // Handed back so engine.mjs can put it in ctx: library install and restore need to wire
  // an app that did not exist when this module ran.
  // `hasApp` is the same Set, read-only: the invalidation bridge has to tell a FIRST save (the
  // resource list grew) from a re-save (one resource's content moved), and this closure is the
  // only place that knows which registrations exist.
  return { registerApp, hasApp: (name) => registered.has(name) };
}
