// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// tools/apps.mjs — the app registry surface: the per-app wiring, the universal opener,
// and the creation loop (guide / list / read / save).
// Registered by engine.mjs. Moved here verbatim: the tool surface is byte-identical to before
// the split, which test/tool-surface.mjs proves against its golden file.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "../mcp-apps.mjs";
import { APP_NAME_RE, cspFor, cspUnion } from "../store.mjs";
import { wrapApp, wrapLoader, stampStage } from "../shell.mjs";
import { resolveAssets, appAssetReader, hasAssetReferences } from "../assets.mjs";
import { GUIDE, guideChapter } from "../guide.mjs";
import { RO, WRITE, WRITE_NOT_IDEMPOTENT, OPEN_WORLD_WRITE, snapshotSchema, capsShape, cmdArgs, SEEDED_APPS, RESERVED_APP_NAMES, LOCKED_APPS, SCENE_CATEGORIES, tierOf, RUNNER_REQUIRED_HTML, defaultCollectionFor, stageWidthFor, stageDisplayFor, answer, toMcp, textWindow } from "../contracts.mjs";
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
  const { server, store, fileChannel, hostName, run, failNote, fail, computeCaps, viewBase, widgetDomain } = ctx;
  const DYNAMIC_TOOLS = !!ctx.dynamicTools;

  // ONE of the three serve-time seams' shared step: a stored `ui` becomes a DOCUMENT here, and a
  // document may carry no external subresource (the widget CSP forbids it, and a host iframe cannot
  // reach this machine anyway), so an app built outside the chat has its bundle inlined on the way
  // out. An app with no `oma-asset:` reference passes through byte-identical.
  //
  // THE STAGE CLASS IS WRITTEN FIRST, on the TEMPLATE, and that order is the whole point of doing
  // it here rather than at each seam: the class belongs on the app's OWN <body>, which is a tag
  // the template has and the bundle merely mentions. Stamping afterwards meant scanning bytes the
  // app never wrote (measured: React's dev build says "<body>" in an error string and got it
  // rewritten, killing the app). stampStage is idempotent, so wrapApp's own stamp downstream is a
  // no-op rather than a second class.
  const serveUi = (comp) =>
    resolveAssets(stampStage(comp.ui, stageWidthFor(comp)), appAssetReader(fileChannel, comp.name));

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
  // recordEdit still returns a count when a REPORT_EVERY boundary is crossed; NOBODY READS IT
  // any more. It used to be spliced into edit_app's success ack — an internal counter, a local
  // script path and a maintainer's name, in the model's context, on somebody else's machine.
  // The tripwire is our instrument and the file beside the DB is where it belongs; a tool result
  // is the user's. (The count stays in the return value rather than being deleted because the
  // boundary crossing is what the sidecar's own reader looks for.)
  //
  // …and it is now a SEAT, off by one option. The measurement exists to decide OUR question (is a
  // source-graph rewrite worth building?), which makes it a reasonable thing to collect on a
  // machine the user owns and an unreasonable thing to collect on somebody's behalf without
  // saying so. A deployment that would have to write it into a privacy policy can decline
  // instead, and declining has to mean the file is never created — not that it is written and
  // ignored — so the no-op replaces the recorder rather than guarding each call site.
  const recordEdit = ctx.telemetry === false ? () => null : editTelemetry(store.dataDir);


  // ---------------------------------------------------------------- widget security declaration
  // What a host should let this widget reach. The engine does not decide that — the APP declares
  // where it needs to reach (manifest.csp) and the user may add origins of their own
  // (settings `policy:csp:<app>` / `policy:csp:*`); store.cspFor merges the two and this shapes the
  // merge for the wire. Enforcement belongs to the host, per the MCP Apps spec; the OSS engine sets
  // no egress ceiling of its own (Leo, 2026-08-16).
  //
  // An app that declares nothing reaches NOTHING, and that is still every app we ship: all of them
  // are self-contained documents (verified 2026-07-28 — zero absolute URLs across the whole store
  // and the runtime), so the honest declaration is also the strictest one there is, and it turns
  // "we are self-contained" from a claim in a README into a machine-readable one on the wire.
  //
  //   · connectDomains / resourceDomains are ALWAYS present, empty array and all. They have been on
  //     the wire since this declaration existed, an empty allowlist is a positive statement ("this
  //     app reaches nothing") rather than an absent one, and a ChatGPT reviewer reads the listing at
  //     connection time. frameDomains / baseUriDomains appear only when declared: omitted means
  //     `frame-src 'none'` / `base-uri 'self'`, which is what we want by default, and declaring an
  //     empty frameDomains invites a stricter review for a capability the app did not ask for.
  //     Our own nested previews are `srcdoc` iframes, which are unaffected — measured, not assumed:
  //     a srcdoc child with sandbox="allow-scripts" loads normally under frame-src 'none' in Chrome.
  //   · redirect_domains carries the viewer origin when there IS one, because oma.openLink sends
  //     the user there (the Browse button). It is per-deployment, so it is derived, never a literal.
  //   · The snake_case `openai/widgetCSP` twin is ChatGPT's documented compatibility key; its own
  //     reference says the standard fields are superseded by _meta.ui.csp but redirect_domains is
  //     still read from the legacy key, so both are sent and they agree. It has only the two fields
  //     ChatGPT documents — frameDomains/baseUriDomains get no snake_case twin invented for them.
  const viewerOrigin = (() => {
    try { return viewBase && /^https?:\/\//.test(viewBase) ? new URL(viewBase).origin : null; } catch { return null; }
  })();
  const redirects = viewerOrigin ? [viewerOrigin] : [];
  /** The `_meta` a host reads, for one app's merged declaration ({} = declares nothing). */
  const uiSecurityFor = (csp = {}) => ({
    ui: {
      csp: {
        connectDomains: csp.connectDomains || [],
        resourceDomains: csp.resourceDomains || [],
        ...(csp.frameDomains?.length ? { frameDomains: csp.frameDomains } : {}),
        ...(csp.baseUriDomains?.length ? { baseUriDomains: csp.baseUriDomains } : {}),
      },
      // TWO KEYS, TWO HOSTS, TWO FORMATS — see createEngine's @param. Claude reads `ui.domain`
      // and wants a bare `{hash}.claudemcpcontent.com`; ChatGPT reads its own key below and wants
      // a scheme-bearing origin. The engine takes them as separate halves precisely because one
      // string cannot satisfy both, and a deployment may declare either, both, or neither.
      ...(widgetDomain?.ui ? { domain: widgetDomain.ui } : {}),
    },
    "openai/widgetCSP": {
      connect_domains: csp.connectDomains || [],
      resource_domains: csp.resourceDomains || [],
      ...(redirects.length ? { redirect_domains: redirects } : {}),
    },
    ...(widgetDomain?.openai ? { "openai/widgetDomain": widgetDomain.openai } : {}),
  });
  // The app-agnostic one: the universal loader serves every app from a single URI, so there is no
  // app whose declaration it could carry (see the loader's registration below).
  const UI_SECURITY = uiSecurityFor();
  // ---------------------------------------------------------- dynamic app wiring
  // ⚠️ E12 — do not turn this on without re-reading this paragraph. Beyond the per-tool budget,
  // registering a tool per app means the tool list CHANGES whenever save_app runs, and
  // prompt caching is an exact-prefix match over tools+system+messages: measured, cache_read drops
  // to 0. So every app the AI creates re-bills the entire conversation from scratch. The cost
  // is not the extra tools, it is that building an app invalidates everything said before it.
  // Per-app open_<name> tools are OPT-IN — `createEngine({dynamicTools})`, falling back to
  // OMA_DYNAMIC_TOOLS=1 when the embedder says nothing. Every tool costs a separate host
  // permission prompt and the tool list balloons with the registry — the universal open_app
  // covers all apps behind ONE permission grant, and never suffers the host's slow
  // tools/list_changed propagation. (The engine reads the resolved answer off ctx now, so there
  // is one decision and not one per module.)
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
    //
    // Two copies of this app's declaration, and they answer different questions. The one in the
    // REGISTRATION is what resources/list shows — a boot-time snapshot, because registration happens
    // once (`registered.has` returns early forever after) while save_app and security_set keep
    // writing. The one inside the callback is computed per READ, so the answer a host acts on is
    // never stale. Listing-then-reading can therefore show two values for an app whose declaration
    // changed mid-session; the read is the authority, and re-registering the resource to keep the
    // listing fresh would mean a resources/list_changed storm on every save.
    registerAppResource(server, `app-${name}`, uri, { mimeType: RESOURCE_MIME_TYPE, _meta: uiSecurityFor(cspFor(store.getApp(name), store)) }, async () => {
      const comp = store.getApp(name);
      if (!comp) throw new Error(`app ${name} not found`);
      const security = uiSecurityFor(cspFor(comp, store));
      // Tier gate (docs/security-model.md §2.3): this per-app resource serves DIRECT mode
      // (wrapApp = the real window.oma, full trust) and has no runner branch — the loader's
      // tier branch (shell.mjs, via oma.embed) covers only the open_app path. Non-local tiers
      // fail closed to the placeholder; every app today is local, so nothing changes until one isn't.
      // The placeholder carries the SAME declaration the real document would: what an app may reach
      // is a property of the app, not of which of its two bodies got served.
      if (tierOf(comp.author) !== "local")
        return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: RUNNER_REQUIRED_HTML, _meta: security }] };
      // The binding rides IN the document: Claude Desktop's dynamic-tools mode delivers neither
      // toolinput nor a collection through its pushes (live-test 2026-07-28, writes bounced as
      // collection:null), and this resource knows its app at serve time — the one place
      // the open_app loader path can't know it.
      // viewRoot rides along for the same reason the binding does — this document runs in an
      // opaque origin and cannot derive it. It is what makes the system badge's "Open in browser"
      // exist (and oma.viewBase absolute) inside a host; an engine without a viewer stamps
      // nothing, and the item is not drawn (D-13 ②).
      //
      // ── THE FIRST OF TWO PLACES "the app that is on screen" is recorded ──────────────────────
      // (The other is `get_app_html {mount:true}` — the loader saying it is mounting. See there
      // for why the two exist; the short version is at the end of this note.)
      // A single overwritten field, no ledger event (store.touchLiveApp says why). It used to sit
      // in the open_* TOOLS, and it does not belong there for two reasons that point the same way:
      //   · `readOnlyHint: true` means "does not modify its environment", and a tool that writes
      //     a row naming an app, a timestamp and a count is not that. The choice was to keep the
      //     hint and move the write, rather than keep the write and tell every host that opening
      //     an app is a mutation worth confirming.
      //   · a resource read is a BETTER witness of the thing the pointer claims. "The model called
      //     open" says an intention was formed; "the host fetched the document to render" says a
      //     widget actually went on screen, which is what an `@live` wall is pointing at.
      // The old worry — that the `@live` brick and the loader would keep re-electing themselves —
      // is answered on the other path by a parameter rather than by an exception: the brick and
      // every refetch call `get_app_html` without `mount`, and only the loader, at the moment it
      // mounts, passes it.
      //
      // …and a DISPLAY app records nothing (contracts.mjs stageDisplayFor). An app carrying an
      // `@live` brick is a frame around whatever the pointer names, so pointing at it would aim
      // the wall at itself. This is the OUTER of the two walls: it keeps the bad value from ever
      // being written. The inner one lives in the brick, which refuses to mount a display app no
      // matter how the pointer came to name one — an old row, a hand-written store, a door written
      // after this line.
      //
      // ⚠️ WHAT THIS COSTS, stated rather than discovered later: the pointer moves when a HOST
      // RENDERS, so a host that caches this resource updates it on the first render and not on
      // later ones. The second half of that cost has since been PAID rather than accepted: the
      // universal `open_app` path points at the LOADER resource (one document for every app),
      // which by construction cannot know which app it is about to mount — so with the per-app
      // openers off (the hosted shape) this path recorded nothing at all in a chat host, and the
      // `@live` wall stayed dark. The loader now says so itself, on the one call that holds the
      // name: `get_app_html {name, mount:true}`. Two doors, one row.
      if (!stageDisplayFor(comp)) store.touchLiveApp(name);
      return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: wrapApp(await serveUi(comp), { app: name, collection: defaultCollectionFor(comp), stage: stageWidthFor(comp), viewBase: viewRoot }), _meta: security }] };
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
        // No live-pointer write here any more — it moved to this app's `ui://` resource read,
        // which is the document THIS tool's `_meta.ui.resourceUri` sends the host to fetch. Same
        // act, one step later, and a step that only happens when something really renders.
        const collection = (a && a.collection) || defaultCollectionFor(comp);
        const v = store.dataVersion();
        return toMcp(answer.page(
          { app: name, collection, items: [], version: v.seq,
            settings_version: v.settings_version, files_version: v.files_version },
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
  // THE LOADER CARRIES THE UNION OF EVERY APP'S DECLARATION (Leo 2026-08-16, plan §7-8 option A).
  // One resource serves every app, and `open_app`'s `_meta.ui.resourceUri` points HERE — the path
  // every host takes by default — so no single app's manifest.csp could ride this `_meta`. It used
  // to carry nobody's, which meant a declaration reached a host only through the opt-in
  // `open_<name>` tools. Now the host is asked to allow the union (declared by any app ∪ the user's
  // additions), computed PER READ from the store, and the runner child mounted inside the loader is
  // narrowed to its own app by composeChildDoc — a srcdoc frame runs under parent ∩ own, so this
  // outer wall has to be at least as wide as the widest app or the inner one means nothing. Two
  // costs, both accepted: a local-tier app mounted same-document in the loader sees the union (it is
  // trusted first-party code either way), and a host that caches the loader resource picks up a new
  // declaration on its next read, not mid-session. A store with no declarations serves the 0.5.9
  // bytes exactly. Making the loader per-app instead would mean a resource per app — the very thing
  // E12 above measures as a prompt-cache wipe on every save.
  //
  // The registration-time `_meta` (what resources/list shows) is a snapshot; the read is live.
  // And the LOADER cache hint is gone: its `public` scope held only while the answer was the same
  // for everybody, and an answer derived from a store is by construction not.
  registerAppResource(server, "app-loader", LOADER_URI, { mimeType: RESOURCE_MIME_TYPE, _meta: uiSecurityFor(cspUnion(store)) },
    async () => ({ contents: [{ uri: LOADER_URI, mimeType: RESOURCE_MIME_TYPE, text: wrapLoader({ viewBase: viewRoot }), _meta: uiSecurityFor(cspUnion(store)) }] }));

  registerAppTool(
    server,
    "open_app",
    {
      title: "Open any app",
      annotations: RO,
      description: "Open ANY app from the registry by name. Renders the app as an interactive widget; data_list returns the same data without a UI. Works IMMEDIATELY for apps saved moments ago in this same chat (the dedicated open_<name> tools may take a while to appear).",
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
      // THIS HANDLER WRITES NOTHING, and that is what lets `readOnlyHint: true` above be true.
      // The live pointer ("which app is on screen") used to be stamped right here, which made the
      // most-called tool in the engine a writer while announcing itself as a read. It moved onto
      // the two paths that witness a RENDER rather than an intention — the per-app `ui://`
      // resource read (see the long note at that registration) and, for the shared loader document
      // this tool points at, the loader's own `get_app_html {mount:true}` on mount.
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
      // No `seq` in the SENTENCE. It is the store's global ledger position — the number that
      // makes a user who edited an app twice ask why it jumped from 5 to 43 (nothing happened to
      // it; those 38 were their groceries). registry.mjs settled that for app history and this
      // line was the one that got missed. `version` still rides the structured channel, where
      // machinery reads it and nobody recites it.
      return toMcp(answer.page(
        { app: a.app, collection, items: [], version: v.seq,
          settings_version: v.settings_version, files_version: v.files_version },
        { returned: 0, total,
          text: `Opened "${a.app}" on collection "${collection}" (${total} item(s)). The widget loads its own data; if YOU need rows, read data_list.`
            + (viewUrl(a.app) ? ` In a browser: ${viewUrl(a.app)}` : "") },
      ));
    },
  );

  server.registerTool(
    "get_app_html",
    {
      title: "App HTML (internal)",
      // NOT `RO`, because of `mount` below: this seat records the live pointer when a loader says
      // it is putting the app on screen, and a tool that writes a row naming an app, a timestamp
      // and a count is not "does not modify its environment". The honest hint costs nothing on the
      // model face — the description says internal, hosted deployments leave it unlisted, and its
      // only callers are widgets. `WRITE` is exactly the four values this seat deserves:
      // idempotent (the pointer is one overwritten row) and closed-world.
      annotations: WRITE,
      description: "Internal: returns raw app HTML plus its trust tier and capability grants for the universal loader widget. Not useful to call directly — use get_app to read source.",
      // `mount` is a CLAIM, not a request: "I am putting this document on screen now". Only the
      // universal loader makes it, and only when it is about to mount — see the handler.
      inputSchema: { name: z.string(), mount: z.boolean().optional().describe("the caller is mounting this app on screen now (records the live pointer); refetches and framing bricks leave it unset") },
      outputSchema: {
        name: z.string(), version: z.number(), html: z.string(),
        author: z.string(),
        tier: z.enum(["local", "unreviewed"]),
        locked: z.boolean().describe("a fixed system app (settings renders these read-only)"),
        // THE HOST LABEL, on the one channel that has a use for it. It rode every read tool's
        // snapshot until now, which meant a provenance annotation for the ledger travelled into
        // the model's context on every page of every collection. Its only real consumer is
        // `oma.state.host` inside a widget, and the loader fetches this payload on mount anyway —
        // so it moved to where its reader already was. Usually empty (MCP 2026-07-28 dropped the
        // handshake that carried a client name), which is the honest value and not a sentinel.
        host: z.string().optional().describe("label for the client this widget is running under; usually empty"),
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
        // Where this app may reach, MERGED (its own manifest.csp ∪ the user's policy:csp rows).
        // Declared here rather than smuggled through `declaration`, which carries what the app
        // said and not what the user added: the loader builds the runner child's CSP meta from
        // this, and a document composed from a key the schema does not list is a document nobody
        // can audit. The merge lives in the engine because only the engine can see the settings.
        csp: z.record(z.string(), z.array(z.string())).optional(),
      },
    },
    async (a) => {
      const comp = store.getApp(a.name);
      if (!comp) return fail(`No app "${a.name}".`);
      const tier = tierOf(comp.author);
      // ── THE SECOND PLACE "the app that is on screen" is recorded ─────────────────────────────
      // The first is the per-app `ui://` resource read (see the long note at that registration).
      // It is the better witness and it stays — but it can only witness a document that KNOWS its
      // app, and the universal `open_app` path points at the shared loader resource, one document
      // for every app. With the per-app openers off (the hosted shape) nothing in a chat host ever
      // reads a per-app resource, so the pointer never moved and an `@live` wall stayed dark.
      //
      // The loader closes that hole from the only position that has the answer: it is the thing
      // holding the name, at the moment it mounts. Hence `mount`, and hence it being opt-in rather
      // than "any fetch counts" — this seat is also how a refetch reloads its source and how the
      // `@live` brick reads the app it is FRAMING, and either of those counting as an open would
      // let a wall re-elect the app it is already showing, forever. The old comment here said the
      // brick and the loader "fetch through get_app_html, which is not a resource read at all";
      // that is still the shape of the answer, it is just now a parameter instead of a whole seat.
      //
      // …and a DISPLAY app records nothing, the same outer wall the resource path carries: a frame
      // must never aim the pointer at itself, however it came to be mounted.
      if (a.mount === true && !stageDisplayFor(comp)) store.touchLiveApp(comp.name);
      // Always the whole document. This call is the loader widget's mount source — the widget
      // cannot assemble windows, and the host↔widget bridge is the one channel measured intact
      // well past the model-facing cut (≥120K). The budget discipline therefore deliberately does
      // not apply here; a model reading source has get_app, which windows by default.
      // `html` stays the FIELD name here — it names the payload's format for the loader widget
      // (shell-runtime reads r.html), not the registry slot. The value is the ui slot.
      //
      // …carrying the stage class, because this is the loader's mount source and the loader is
      // the third door onto the same document (serveUi stamps it for all three, before the assets
      // go in — see its comment for why that order matters). Stamped in the BYTES rather than in a
      // structuredContent key: the tool surface is resident context for every host on every
      // connection, and this is a rendering detail the model has no use for. `declaration` right
      // above already carries the manifest verbatim for anyone who wants to read the field
      // itself; what the loader needs is the class, and one authority computes it (stageWidthFor).
      return {
        content: [{ type: "text", text: `(app "${comp.name}" v${comp.version}, ${comp.ui.length} chars, tier ${tier} — consumed by the loader widget)` }],
        structuredContent: { name: comp.name, version: comp.version, author: comp.author, tier,
          locked: LOCKED_APPS.has(comp.name), collection: defaultCollectionFor(comp), host: hostName(),
          caps: computeCaps(comp.name, tier), declaration: comp.manifest ? JSON.parse(comp.manifest) : null,
          csp: cspFor(comp, store),
          // …and its assets inlined, because this payload IS the document the loader mounts —
          // the third serve-time seam, and the one every non-local tier also travels (the runner's
          // child document is composed in the browser from exactly these bytes).
          html: await serveUi(comp) },
      };
    },
  );

  // -------------------------------------------------------------------- creation loop
  server.registerTool(
    "get_app_guide",
    {
      title: "App authoring guide",
      annotations: RO,
      description: "The authoring contract for creating or editing an app: the window.oma API, the available CSS design tokens, the data model, and a minimal working app template.",
      // The chapter list is frozen at first publish: inputSchema bytes are resident, so a value
      // added later is a tools/list change for everyone. All four exist from day one; `functions`
      // says so plainly while the pillar is still behind a flag.
      inputSchema: {
        topic: z.enum(["basics", "functions", "embed", "style"]).optional()
          .describe("which chapter (default basics: the contract + template). Each chapter stands alone"),
      },
    },
    // The seat is passed IN: a guide that teaches call_function on a host that does not register
    // it is the 0.6.0 defect this closes — the chapter existed, the tool did not, and an author
    // followed the chapter to a save that could never be called.
    async (a) => ({ content: [{ type: "text", text: guideChapter(a?.topic, ctx.functions) }] }),
  );

  server.registerTool(
    "list_apps",
    {
      title: "List apps",
      annotations: RO,
      description: "List UI apps in the registry (reusable across all chats). Lists the user's openable apps by default — pass name to look one up, or widen with kind/visibility.",
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
      // `ui_size`, not `html_size`: the column is `length(ui) AS ui_size` (store.mjs allComps) and
      // has been since the manifest split. The old name survived here alone, and JS answers a
      // missing property with `undefined` rather than an error — so every row printed
      // "(undefined chars, by …)" to the model, in every host, for every app.
      // The function roster, at the ONLY altitude a registry listing can afford (R5, 2026-08-16):
      // a COUNT, and only when there is one. Names and signatures are a per-app read
      // (get_app {slot:"manifest"}) — putting them here would make the cheapest discovery call
      // grow with every function anyone ever declares, and most apps declare none.
      const line = (c) => `- ${c.name} v${c.version} (${c.ui_size} chars, by ${c.author})` +
        (SEEDED_APPS.has(c.name) ? " [ships with the engine — not one of the user's apps]" : "") +
        ` — ${c.description || "no description"}` +
        (c.fn_count > 0 ? ` · ${c.fn_count} function${c.fn_count === 1 ? "" : "s"}` : "") +
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
      // second tool (app_permissions retired 2026-08-04 — get_app_html carries the per-app caps).
      // `functions` is ABSENT, not 0, on an app that declares none — absence is the honest shape
      // for "this app has no function face", and it keeps the rows of a registry that uses no
      // functions byte-identical to what they were before the field existed. (There is no
      // outputSchema on this tool, deliberately: an optional field costs nothing resident, while
      // declaring the row shape would put it in tools/list for every conversation forever.)
      return { content: [{ type: "text", text }], structuredContent: { total: all.length, shown: comps.length,
        apps: comps.map(({ fn_count, ...c }) => ({ ...c, locked: LOCKED_APPS.has(c.name),
          ...(fn_count > 0 ? { functions: fn_count } : {}) })) } };
    },
  );

  server.registerTool(
    "get_app",
    {
      title: "Get app source",
      annotations: RO,
      description: "Read an app's ui source as a WINDOW — offset/length select it, next_offset continues, total is the full length. Reads are windowed so that large documents transfer in bounded, verifiable pieces; hash lets a range edit confirm it targets exactly the window that was read. Carries version — the expected_version for edit_app / save_app — and hash, the expect_hash for a range edit of exactly this window. node jumps the window to the element marked data-oma-node=\"<node>\". slot:\"manifest\" returns the declaration object instead (no window mechanics).",
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
        // A one-way door, said out loud at the moment it is walked through. An `oma-asset:`
        // reference means "the source is elsewhere", and the engine takes that literally: from the
        // next save on, edit_app and save_app both refuse this app. Writing one from here is legal
        // (an app may genuinely want its data or a large script in a file) and is exactly the case
        // where the author has no elsewhere to rebuild from — so it is worth a sentence, not a
        // refusal. Free of resident bytes: a warning is result text, not tool surface.
        if (hasAssetReferences(a.ui))
          warnings.push("This ui references bundled assets (oma-asset:…), which marks the app as BUILT OUTSIDE this store — from now on edit_app and save_app both refuse it, and the only way to change it is install-app.mjs (--asset for the files). Inline the code instead if you meant to keep editing it here.");
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
      // Built outside ⇒ no edits, from anyone, through this door. The store refuses an AGENT save
      // over such an app (store.mjs save_app, `built_outside`) — but this tool's inputSchema carries
      // cmdArgs, whose `actor` is caller-chosen, and it passes that value straight through. A gate
      // that reads a forgeable field is not a gate, so the refusal here is UNCONDITIONAL, which is
      // also what Leo's shape asks for: editing a template is never the way to change a built app,
      // whoever is asking. Re-pushing is (install-app.mjs --update), and it is one command.
      if (hasAssetReferences(comp.ui))
        return fail(`"${a.app}" was built outside this store: its ui is a template that loads bundled assets ` +
          `(oma-asset:…), so editing it here would desynchronise the template from the build that made it. ` +
          `Source lives outside this store; rebuild and re-install with install-app.mjs. NOTHING was applied.`);
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
      tel("ok");
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
          (sk ? `\n${sk}` : ""),
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
    // createEngine normalised the seat to `{egress?, executor?}` — where the body runs and what
    // its fetch talks to are the host's to choose, and neither is visible on this tool's face.
    const fnHost = makeFunctionHost(store, ctx.functions);
    server.registerTool(
      "call_function",
      {
        title: "Call an app function",
        // OPEN_WORLD_WRITE, not WRITE: the body is the APP AUTHOR's code and it holds `fetch`, so
        // this seat is the one place a call can have an effect outside this store. idempotentHint
        // survives the switch for the reason it was true before — inner command_ids are derived
        // from this call's command_id in issue order, so a retried call replays into the ledger's
        // dedup instead of writing twice. That guarantee covers OUR writes and says nothing about
        // whatever the body sent elsewhere, which is exactly what destructiveHint now admits.
        annotations: OPEN_WORLD_WRITE,
        description: "Run a function an app declares (manifest.functions) — data in, data out, no UI needed. The body is code the app's author wrote and it may make outbound network requests (a host may route them through an allowlisted gateway). Args are checked against the declared params; failures return the declared schema so the retry needs no extra read. The reply carries the return value plus a receipt per write.",
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
        // await: the body runs on a worker thread (functions.mjs), so the executor answers on a
        // promise even for a body that never awaits anything of its own.
        const r = await fnHost.call({
          app: a.app, function: a.function, args: a.args,
          actor: a.actor || "agent", host: hostName(),
          command_id: a.command_id || randomUUID(),
        });
        if (r.ok) {
          const wrote = r.writes.length
            ? ` — ${r.writes.length} write${r.writes.length === 1 ? "" : "s"} (${r.writes.map((w) => `${w.op} ${w.id}`).join(", ")})`
            : " — no writes";
          // The return value rides the TEXT channel too (same-body doctrine, contracts.mjs): measured
          // 2026-09-02 on claude.ai — the model is handed content[].text only, and a receipt that
          // said "Ran fnprobe.egress — 2 writes" left it unable to see what the function returned.
          const returned = r.result === null ? "" : ` → ${JSON.stringify(r.result)}`;
          return toMcp(answer.ack(
            { ok: true, ...(r.result === null ? {} : { result: r.result }), writes: r.writes },
            `Ran ${a.app}.${a.function}${returned}${wrote}.`));
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
