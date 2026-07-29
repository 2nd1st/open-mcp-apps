// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// tools/apps.mjs — the app registry surface: the per-app wiring, the universal opener,
// and the creation loop (guide / list / read / save).
// Registered by engine.mjs. Moved here verbatim: the tool surface is byte-identical to before
// the split, which test/tool-surface.mjs proves against its golden file.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { APP_NAME_RE } from "../store.mjs";
import { wrapApp, wrapLoader } from "../shell.mjs";
import { GUIDE, guideChapter } from "../guide.mjs";
import { readDeclaration } from "../manifest-block.mjs";
import { RO, WRITE, WRITE_NOT_IDEMPOTENT, snapshotSchema, capsShape, cmdArgs, SEEDED_APPS, RESERVED_APP_NAMES, LOCKED_APPS, SCENE_CATEGORIES, tierOf, RUNNER_REQUIRED_HTML, defaultCollectionFor, answer, toMcp, textWindow } from "../contracts.mjs";

// "Does this document actually talk to the API?" — the shapes a real app reaches it by.
// The original test was the literal `oma.` alone, which fired on working code: `const OMA =
// window.oma` and `const { oma } = window` are both idiomatic, and one measured author re-sent an
// entire 33KB document to silence the false warning. A linter that cries wolf costs more than the
// miss it prevents, so the bar is "any plausible reference", not "the one spelling we expected".
// Exported so the false-positive cases stay pinned in test/server-smoke.
export const OMA_REFERENCE_RE = /\boma\s*[.[]|window\s*\.\s*oma\b|window\s*\[\s*["']oma["']\s*\]|\{[^{}]*\boma\b[^{}]*\}\s*=/;

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
  declaration: z.string().optional(),
  applied: z.number().optional(),
  expected_version: z.number().optional(),
  reason: z.string().optional(),
  note: z.string().optional(),
  eot: z.string().optional(),
};

export function register(ctx) {
  const { server, store, hostName, run, failNote, fail, computeCaps, viewBase, widgetDomain } = ctx;


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

    registerAppResource(server, `app-${name}`, uri, { mimeType: RESOURCE_MIME_TYPE, _meta: UI_SECURITY }, async () => {
      const comp = store.getApp(name);
      if (!comp) throw new Error(`app ${name} not found`);
      // Tier gate (docs/security-model.md §2.3): this per-app resource serves DIRECT mode
      // (wrapApp = the real window.oma, full trust) and has no runner branch — the
      // loader's runnerMount covers only the open_app path. Non-local tiers fail closed
      // to the placeholder; every app today is local, so nothing changes until one isn't.
      if (tierOf(comp.author) !== "local")
        return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: RUNNER_REQUIRED_HTML, _meta: UI_SECURITY }] };
      // The binding rides IN the document: Claude Desktop's dynamic-tools mode delivers neither
      // toolinput nor a collection through its pushes (live-test 2026-07-28, writes bounced as
      // collection:null), and this resource knows its app at serve time — the one place
      // the open_app loader path can't know it.
      return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: wrapApp(comp.html, { app: name, version: comp.version, collection: defaultCollectionFor(comp) }), _meta: UI_SECURITY }] };
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
  registerAppResource(server, "app-loader", LOADER_URI, { mimeType: RESOURCE_MIME_TYPE, _meta: UI_SECURITY },
    async () => ({ contents: [{ uri: LOADER_URI, mimeType: RESOURCE_MIME_TYPE, text: wrapLoader(), _meta: UI_SECURITY }] }));

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
          text: `Opened "${a.app}" on collection "${collection}" (${total} item(s), seq ${v.seq}). The widget loads its own data; if YOU need rows, read data_list.` },
      ));
    },
  );

  server.registerTool(
    "app_html",
    {
      title: "App HTML (internal)",
      annotations: RO,
      description: "Internal: returns raw app HTML plus its trust tier and capability grants for the universal loader widget. Not useful to call directly — use get_app to read source.",
      inputSchema: {
        name: z.string(),
        offset: z.number().optional().describe("window the html (same grammar as get_app); omit for the whole document"),
        length: z.number().optional(),
      },
      outputSchema: {
        name: z.string(), version: z.number(), html: z.string(),
        author: z.string(),
        tier: z.enum(["local", "library-reviewed", "unreviewed"]),
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
        offset: z.number().optional(), next_offset: z.number().nullable().optional(),
        returned: z.number().optional(), total: z.number().optional(), eot: z.string().optional(),
      },
    },
    async (a) => {
      const comp = store.getApp(a.name);
      if (!comp) return fail(`No app "${a.name}".`);
      const tier = tierOf(comp.author);
      const meta = { name: comp.name, version: comp.version, author: comp.author, tier,
        collection: defaultCollectionFor(comp),
        caps: computeCaps(comp.name, tier), declaration: comp.manifest ? JSON.parse(comp.manifest) : null };
      // Windowed ONLY on request. The zero-parameter call is the loader widget's mount source and
      // MUST carry the whole document — the widget cannot assemble windows, and the host↔widget
      // bridge is the one channel measured intact well past the model-facing cut (≥120K). The
      // budget discipline therefore deliberately does not apply to it; a model reading source has
      // get_app, which windows by default.
      if (a.offset == null && a.length == null) {
        return {
          content: [{ type: "text", text: `(app "${comp.name}" v${comp.version}, ${comp.html.length} chars, tier ${tier} — consumed by the loader widget)` }],
          structuredContent: { ...meta, html: comp.html },
        };
      }
      const w = textWindow(comp.html, { offset: a.offset, length: a.length },
        (t) => ({ ...meta, html: t, offset: 0, next_offset: 0, returned: t.length, total: comp.html.length, eot: "·eot" }));
      return toMcp(answer.chunk(
        { ...meta, html: w.text, offset: w.offset, next_offset: w.next_offset },
        { returned: w.text.length, total: w.total,
          text: `(app "${comp.name}" v${comp.version} — html chars ${w.offset}–${w.offset + w.text.length} of ${w.total}${w.next_offset != null ? `, continue at offset ${w.next_offset}` : ", end"})` },
      ));
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
      // Four params, frozen with this publish: name (the "open my X" lookup — exact match, so a
      // registry of any size answers in one call), kind and visibility (the two columns that decide
      // what is an app and what is retired/long-tail), limit (a floor under the reply, not a page:
      // the count is always reported so a truncated list can never read as the whole registry).
      inputSchema: {
        name: z.string().optional().describe("exact app name — the fastest way to answer \"open my X\""),
        kind: z.enum(["app", "visual", "primitive", "any"]).optional().describe("default app: what a person opens and reuses"),
        visibility: z.enum(["featured", "listed", "unlisted", "archived", "any"]).optional().describe("default featured+listed; archived/unlisted are retired or long-tail"),
        limit: z.number().int().positive().optional().describe("cap the rows listed (the total is always reported)"),
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
      const comps = a.limit ? all.slice(0, a.limit) : all;
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
      // A filtered or capped list must never read as the whole registry. `total` says how many
      // matched and `shown` how many are printed, both before the rows — the same reason a page
      // reports the collection's size and not its own length.
      const scoped = a.name || a.kind || a.visibility;
      const capped = comps.length < all.length;
      const head = capped ? `${all.length} match, showing ${comps.length}:`
        : scoped ? `${all.length} match:` : null;
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
      return { content: [{ type: "text", text }], structuredContent: { total: all.length, shown: comps.length, apps: comps } };
    },
  );

  server.registerTool(
    "get_app",
    {
      title: "Get app source",
      annotations: RO,
      description: "Read an app's HTML source as a WINDOW — offset/length select it, next_offset continues, total is the full length. Windows exist because some hosts silently drop the MIDDLE of an oversized result: a big app read whole can arrive mutilated with no sign, and an edit saved from it destroys the source. Carries version — the expected_version for edit_app / save_app.",
      inputSchema: {
        name: z.string(),
        offset: z.number().optional().describe("character offset to read from (default 0)"),
        length: z.number().optional().describe("max characters for this window (default fits the result budget)"),
      },
      outputSchema: {
        name: z.string(), version: z.number(),
        returned: z.number().optional(), total: z.number().optional(),
        offset: z.number(), text: z.string(), next_offset: z.number().nullable().optional(),
        eot: z.string().optional(),
      },
    },
    async (a) => {
      const comp = store.getApp(a.name);
      if (!comp) return fail(`No app "${a.name}". list_apps shows what exists.`);
      const w = textWindow(comp.html, { offset: a.offset, length: a.length },
        (t) => ({ name: comp.name, version: comp.version, offset: 0, next_offset: 0, total: comp.html.length, returned: t.length, text: t, eot: "·eot" }));
      const head = `// ${comp.name} v${comp.version} — chars ${w.offset}–${w.offset + w.text.length} of ${w.total}` +
        (w.next_offset != null ? ` (continue at offset ${w.next_offset})` : " (end)");
      return toMcp(answer.chunk(
        { name: comp.name, version: comp.version, offset: w.offset, next_offset: w.next_offset, text: w.text },
        { returned: w.text.length, total: w.total, text: `${head}\n${w.text}` },
      ));
    },
  );

  server.registerTool(
    "save_app",
    {
      title: "Save app",
      annotations: WRITE,
      description: "Create or update a UI app in the persistent registry. The HTML must follow the contract from get_app_guide (single self-contained HTML using window.oma; no external resources). After saving, open it IMMEDIATELY with open_app. Saving an existing name creates a new version (history kept).",
      inputSchema: {
        name: z.string().describe("app name, ^[a-z][a-z0-9-]{0,31}$ (e.g. 'kanban', 'habit-tracker')"),
        html: z.string().describe("complete self-contained HTML document using window.oma"),
        description: z.string().optional().describe("one line: what this app shows and what data fields it uses"),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
        expected_version: z.number().optional().describe("REQUIRED when overwriting an existing app: the version you read (get_app). Creating a new name needs none"),
        // RETIRED, and deliberately still declared: a typed input schema STRIPS keys it does not
        // list, so removing these outright would make an old caller's declaration vanish in
        // silence. Declared as anything-and-refused, they cost a few bytes to tell one published
        // fork where the declaration lives now. Delete both at the next breaking version.
        manifest: z.any().optional().describe("RETIRED — declare inside the html (see get_app_guide)"),
        scene: z.any().optional().describe("RETIRED — declare inside the html (see get_app_guide)"),
      },
      outputSchema: saveAckSchema,
    },
    async (a) => {
      if (!APP_NAME_RE.test(a.name || "")) return fail("Invalid name: must match ^[a-z][a-z0-9-]{0,31}$ (lowercase, digits, hyphens).");
      // These moved INTO the document. Rejecting is the only honest answer: silently ignoring them
      // would drop a declaration the caller believes it made, and this engine has exactly one
      // published fork whose old calls must hear why rather than lose data.
      if (a.manifest !== undefined || a.scene !== undefined)
        return fail("manifest/scene are no longer parameters — an app declares itself INSIDE its html, in a <script type=\"application/json\" id=\"oma-manifest\"> block, which the engine reads on save. See get_app_guide.");
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
          `"${a.name}" already exists at v${existing.version} (${existing.html.length.toLocaleString()} chars). Overwriting requires expected_version — read it first (get_app) and pass expected_version: ${existing.version}. A NEW app needs a different name.`), { isError: true });
      const warnings = [];
      const notes = [];
      // The scene's CATEGORY check moved here from the old parameter path: the declaration now
      // arrives inside the html, so this reads it the same way the store will and warns before the
      // save rather than after. An unknown slug is a warning, not a rejection — the taxonomy is ours
      // and an app that guesses a category wrong is still an app worth saving.
      const declared = readDeclaration(a.html);
      if (declared.state === "present" && declared.value.scene && declared.value.scene.category_id != null
          && !SCENE_CATEGORIES.has(declared.value.scene.category_id))
        warnings.push(`Unknown scene.category_id "${declared.value.scene.category_id}" in the manifest block — it is stored as declared but the Library will not file it. Valid: ${[...SCENE_CATEGORIES].join(", ")}.`);
      // Accept every shape a real app reaches the API by, not just the literal `oma.`:
      // `window.oma`, an alias (`const OMA = window.oma`), bracket access, and destructuring all
      // count. The narrow test fired on working code — one measured author re-sent an entire 33KB
      // document to silence it — and a warning that cries wolf costs more than the miss it prevents.
      if (!OMA_REFERENCE_RE.test(a.html))
        warnings.push("HTML never references the oma API — it will render but won't load or save any data.");
      if (/src\s*=\s*["']https?:|href\s*=\s*["']https?:|@import|fetch\s*\(/i.test(a.html)) warnings.push("External URLs detected — the sandbox CSP blocks all external resources; the app may break. Inline everything.");
      if (/React\.createElement|ReactDOM|from\s+["']react["']|import\s+React|@babel\/standalone|text\/babel/.test(a.html)) warnings.push("React/JSX/Babel detected — widgets have no React runtime or JSX compiler (this is not claude.ai Artifacts). Rewrite with vanilla DOM per get_app_guide.");
      const r = store.execute({
        type: "save_app", command_id: a.command_id || randomUUID(),
        name: a.name, html: a.html, description: a.description || "", actor: "agent", host: hostName(),
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
        return fail(r.error === "bad_manifest" ? `Invalid manifest: ${r.detail}.` : failNote(r));
      }
      // A replay's receipt has no size/declaration facts (they belong to the original response) —
      // say what a retry needs and stop, rather than dereferencing fields that are not there.
      if (r.idempotent)
        return toMcp(answer.ack({ ok: true, name: a.name, version: r.version, note: "already saved (idempotent replay)" },
          `Already saved — "${a.name}" is at v${r.version} from this same command_id.`));
      registerApp(a.name);
      // A manifest set over collections with EXISTING rows: warn about rows that don't conform.
      // (Writes stay possible — the store delta-validates, so legacy rows can be edited but never
      // made worse — but the author should know the contract isn't fully met yet.)
      // A field contract set over collections that ALREADY have rows: warn about the rows that do
      // not conform. Writes stay possible (the store delta-validates, so legacy rows can be edited
      // but never made worse) — the author just deserves to know the contract is not met yet.
      if (declared.state === "present" && declared.value.collections) {
        for (const [collName, spec] of Object.entries(declared.value.collections)) {
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
      // What the engine actually read out of the document, said out loud. A declaration that was
      // kept, cleared, or absent is a fact about this save, and the author's next edit depends on it.
      if (r.note) notes.push(r.note);
      else if (r.declaration === "present") notes.push("Declaration read from the document's #oma-manifest block.");
      else if (r.declaration === "empty") notes.push("Empty #oma-manifest block — the stored declaration was cleared.");
      // Size pair on every save, unconditionally: a 82,623 → 74 char overwrite has to be visible
      // in the reply that caused it, not discoverable afterwards.
      const sizeNote = r.prev_size == null
        ? `${r.size.toLocaleString()} chars.`
        : `${r.prev_size.toLocaleString()} → ${r.size.toLocaleString()} chars.`;
      const lines = [
        `Saved "${a.name}" v${r.version}${r.created ? " (new app)" : " (updated)"} — ${sizeNote}`,
        ...notes,
        `Show it NOW with: open_app {app: "${a.name}"} — works immediately.`,
        `It persists and is reusable in every future chat.`,
        ...warnings.map((w) => `⚠ ${w}`),
      ];
      return toMcp(answer.ack(
        { ok: true, name: a.name, version: r.version, created: r.created, size: r.size,
          prev_size: r.prev_size ?? null, declaration: r.declaration,
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
      description: "Surgical edits to an app WITHOUT round-tripping the whole source: each edit replaces old_string (which must match exactly once, or set replace_all) with new_string. All edits apply together against expected_version, or nothing applies. No pre-read needed for source you just saved — your copy is byte-exact and your receipt carries the version; get_app is for source you did not write. The #oma-manifest block is re-read on save.",
      inputSchema: {
        ...cmdArgs,
        // `app`, not `name` — save_app/get_app take `name`, and the split is
        // frozen into the published surface, so the only honest fix is to SAY it. Two independent
        // authors each burned a call on the guess. The word costs 34 bytes of tools/list once.
        app: z.string().describe("app name (this tool says `app`; save_app and get_app say `name`)"),
        expected_version: z.number().describe("REQUIRED — the version the edits were authored against (from get_app)"),
        edits: z.array(z.object({
          old_string: z.string(),
          new_string: z.string(),
          replace_all: z.boolean().optional(),
        })).describe("applied in order; exact string match including whitespace"),
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
      if (comp.version !== a.expected_version)
        return toMcp(answer.fail("version_conflict", { name: a.app, expected_version: comp.version },
          `"${a.app}" is at v${comp.version}, not v${a.expected_version} — re-read the region you are editing and re-apply.`), { isError: true });
      const edits = Array.isArray(a.edits) ? a.edits : [];
      if (!edits.length) return fail("No edits given — pass edits: [{old_string, new_string}].");
      let html = comp.html;
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i] || {};
        const oldS = String(e.old_string ?? "");
        if (!oldS) return fail(`Edit ${i}: old_string is empty. NOTHING was applied.`);
        const n = html.split(oldS).length - 1;
        if (n === 0) return fail(`Edit ${i}: old_string not found (0 matches) — read that region again (get_app with offset) and match it exactly, including whitespace. NOTHING was applied.`);
        if (n > 1 && !e.replace_all) return fail(`Edit ${i}: old_string matches ${n} times — add surrounding context to pin ONE occurrence, or set replace_all: true. NOTHING was applied.`);
        html = e.replace_all ? html.split(oldS).join(String(e.new_string ?? "")) : html.replace(oldS, String(e.new_string ?? ""));
      }
      // The apply is pure and the save is OCC-guarded, so read→apply→save is transaction-equivalent:
      // a concurrent save between the read above and this write turns into a version conflict, never
      // a lost update. Empty description preserves the existing one (the store's '' rule).
      const r = store.execute({
        type: "save_app", command_id: a.command_id, name: a.app, html,
        description: "", actor: a.actor || "agent", host: hostName(), expected_version: a.expected_version,
      });
      if (!r.ok) {
        if (r.conflict) return toMcp(answer.fail("version_conflict", { name: a.app, expected_version: r.expected },
          `Version conflict: "${a.app}" moved to v${r.expected} while editing — re-read and re-apply. NOTHING was applied.`), { isError: true });
        return fail(r.error === "bad_manifest" ? `The edited document's declaration is invalid: ${r.detail}. NOTHING was applied — fix the edit and retry.`
          : `${failNote(r)} NOTHING was applied.`);
      }
      if (r.idempotent)
        return toMcp(answer.ack({ ok: true, name: a.app, version: r.version, applied: edits.length, note: "already applied (idempotent replay)" },
          `Already applied — "${a.app}" is at v${r.version} from this same command_id.`));
      return toMcp(answer.ack(
        { ok: true, name: a.app, version: r.version, size: r.size, prev_size: r.prev_size ?? null,
          applied: edits.length, declaration: r.declaration, ...(r.note ? { note: r.note } : {}) },
        `Edited "${a.app}" — ${edits.length} edit(s) applied, v${a.expected_version} → v${r.version}, ${(r.prev_size ?? 0).toLocaleString()} → ${r.size.toLocaleString()} chars.` +
          (r.note ? `\n${r.note}` : ""),
      ));
    },
  );

  server.registerTool(
    "archive_app",
    {
      title: "Archive / restore an app",
      annotations: WRITE,
      description: "Flip an app out of (or back into) the default listing. Archived apps stay fully intact — data, files, history, still openable by name — they just stop occupying the shelf. list_apps {visibility: \"archived\"} shows them. This is the KEEP-everything half of the pair: to remove an app and the data only it used, delete_app with data:\"cascade\" (permanent).",
      inputSchema: { ...cmdArgs, app: z.string(), archived: z.boolean().describe("true = archive; false = bring it back (listed)") },
      outputSchema: {
        ok: z.boolean(), name: z.string().optional(), visibility: z.string().optional(),
        version: z.number().optional(), reason: z.string().optional(), note: z.string().optional(), eot: z.string().optional(),
      },
    },
    async (a) => {
      if (LOCKED_APPS.has(a.app)) return fail(`"${a.app}" is a system app — it stays.`);
      const r = run({ ...a, name: a.app }, "archive_app");
      if (!r.ok) return fail(failNote(r));
      const vis = r.visibility ?? store.getApp(a.app)?.visibility;
      const note = r.unchanged ? `already ${vis}` : r.idempotent ? "already applied (idempotent replay)" : undefined;
      return toMcp(answer.ack(
        { ok: true, name: r.name ?? a.app, visibility: vis, version: r.version, ...(note ? { note } : {}) },
        note ? `"${a.app}" — ${note} (v${r.version}).` : `"${a.app}" is now ${vis} (v${r.version}).`,
      ));
    },
  );

  // call_function has NO seat until the function pillar ships (OMA_FUNCTIONS, write-set F).
  // The seat was briefly registered "up front so the surface never changes" — but a surface only
  // changes at a release boundary anyway, and until then the seat was a schema every conversation
  // paid for and a tool whose only behaviour was to refuse. Pulled 2026-07-27 (Leo: retire what
  // is not in use). When F lands the seat returns WITH its executor, priced as one release-time
  // cache break. The widget-side verb (oma.callFunction → rawCall) and the runner's shaping for
  // it stay in place — they are the contract F plugs into, and they cost the surface nothing.

  // Handed back so engine.mjs can put it in ctx: library install and restore need to wire
  // an app that did not exist when this module ran.
  return { registerApp };
}
