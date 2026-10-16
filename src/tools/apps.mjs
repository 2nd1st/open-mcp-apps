// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// tools/apps.mjs — the app registry surface: the per-app wiring, the universal opener,
// and the creation loop (guide / list / read / save).
// Registered by engine.mjs. Moved here verbatim: the tool surface is byte-identical to before
// the split, which test/tool-surface.mjs proves against its golden file.

import { z } from "zod";
import { ResourceTemplate, ResourceNotFoundError } from "@modelcontextprotocol/server";
import { randomUUID, createHash } from "node:crypto";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "../mcp-apps.mjs";
import { APP_NAME_RE, cspFor, cspUnion, SETTINGS_COLLECTION, OPEN_TOOL_PREF } from "../store.mjs";
import { latestPref, coercePref } from "../runtime-core.mjs";
import { wrapApp, wrapLoader } from "../shell.mjs";
import { resolveAssets, appAssetReader, hasAssetReferences } from "../assets.mjs";
import { GUIDE, guideChapter } from "../guide.mjs";
import { RO, WRITE, WRITE_NOT_IDEMPOTENT, OPEN_WORLD_WRITE, snapshotSchema, capsShape, cmdArgs, SEEDED_APPS, RESERVED_APP_NAMES, LOCKED_APPS, SCENE_CATEGORIES, tierOf, RUNNER_REQUIRED_HTML, defaultCollectionFor, liveFrameFor, sharedCaps, answer, toMcp, textWindow, READ_WINDOW } from "../contracts.mjs";
import { isHandle, handleOf, notShared, sharedLocked, provenanceLine } from "../sharing.mjs";
import { sharedScopeOf } from "../store.mjs";
import { sliceHash, locateNode, applyRangeEdits } from "../edit-range.mjs";
import { makeFunctionHost } from "../functions.mjs";
import { skillLine, skillProvenance, skillAuthor } from "../skill.mjs";

// Advice, never a refusal (contracts READ_WINDOW): said when an app's document stops fitting one read.
// Measured 2026-10-06 (Claude + ChatGPT, 40K–170K apps): both edit big apps willingly and small edits
// read only the part they touch; the cost is a REWORK, which reads the whole app first — about once on
// Claude, about eight times over on ChatGPT. So the advice is about cost, not about being refused.
const sizeAdvice = (name, size) => `"${name}" is ${size.toLocaleString()} chars — past one get_app read ` +
  `(${READ_WINDOW.toLocaleString()}). Small edits stay cheap, but a rework reads the whole app first (on ` +
  `some hosts several times), so every big change costs more as it grows. Keep an app to one job; a ` +
  `bigger one splits into apps that share the collection.`;

// "Does this document actually talk to the API?" — the shapes a real app reaches it by.
// The original test was the literal `oma.` alone, which fired on working code: `const OMA =
// window.oma` and `const { oma } = window` are both idiomatic, and one measured author re-sent an
// entire 33KB document to silence the false warning. A linter that cries wolf costs more than the
// miss it prevents, so the bar is "any plausible reference", not "the one spelling we expected".
// Exported so the false-positive cases stay pinned in test/server-smoke.
export const OMA_REFERENCE_RE = /\boma\s*[.[]|window\s*\.\s*oma\b|window\s*\[\s*["']oma["']\s*\]|\{[^{}]*\boma\b[^{}]*\}\s*=/;

// Whether an app binds persistent data: the oma data/file verbs, the data_*/file_* tools, or
// declared collections. `oma.pref` is deliberately NOT a binding — reading a setting to theme a
// page does not give it data.
const BINDS_RE = /\boma\s*\.\s*(addItem|updateItem|moveItem|deleteItem|onChange|readCollection|refresh|files)\b|\bdata_(add_item|update_item|move_item|delete_item|list|query|batch|collections|changes|version)\b|\bfile_(write|read|list|delete)\b/;
const bindsData = (ui, manifest) =>
  (manifest && manifest.collections && typeof manifest.collections === "object"
    && Object.keys(manifest.collections).length > 0) || BINDS_RE.test(String(ui ?? ""));

// What opening an app tells the model. A page — no data verbs, nothing declared, nothing stored,
// no collection asked for — is just opened: naming a collection it never reads had the model
// announce "the collection is empty, you're starting fresh" over a dice roller.
const openedText = (comp, collection, total, asked) =>
  !asked && total === 0 && !bindsData(comp.ui, comp.manifest ? JSON.parse(comp.manifest) : null)
    ? `Opened "${comp.name}".`
    : `Opened "${comp.name}" on collection "${collection}" (${total} item(s)). The widget loads its own data; if YOU need rows, read data_list.`;
// …and, for an app whose author wrote down how it is used, ONE more line: the skill's description and
// the way to the rest (src/skill.mjs). The meta, never the body — this rides every open. It travels
// as the structured `note` too, because the model on some hosts reads only that channel.
const withSkill = (text, how) => (how ? { text: `${text}\n${how}`, note: how } : { text });

// The universal opener's document is NAMED BY ITS OWN BYTES. A host keys its template cache on the
// URI — ChatGPT's docs say it outright ("publish a new URI" for a breaking HTML/JS/CSS change), and
// stg measured the cost of a fixed name on 2026-07-29: eight minutes of widgets rendered by the
// previous build's loader, and on 2026-10-02 a "Refresh tools" that refreshed the tools and kept
// the old loader. Hashing what is served (runtime bundle, loader, viewer base, the platform's CSP
// base) makes every build that changes it a new URI and a build that changes nothing the same one.
// The dot keeps it out of every app's way: APP_NAME_RE has no dot, so no `<name>.html` can claim it.
export const loaderUriFor = (doc) => `ui://open-mcp-apps/app.${createHash("sha256").update(doc).digest("hex").slice(0, 12)}.html`;
export const LOADER_URI_RE = /^ui:\/\/open-mcp-apps\/app\.[0-9a-f]{12}\.html$/;

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

// The absolute origins a document loads from: any src, <link href>, ES `import … from`
// and `import()`, CSS `@import`/`url()`, and fetch/WebSocket targets. A lint, not a parser — it
// only has to name what a host's CSP would refuse, and an origin it misses costs a warning, never
// a wrong save.
const ORIGIN_SITES = [
  /\bsrc\s*=\s*["'](https?:\/\/[^"'/?#\s]+)/gi,
  /<link\b[^>]*?\bhref\s*=\s*["'](https?:\/\/[^"'/?#\s]+)/gi,   // not <a href>: navigation is not a load
  /\bfrom\s*["'](https?:\/\/[^"'/?#\s]+)/gi,
  /\bimport\s*\(\s*["'](https?:\/\/[^"'/?#\s]+)/gi,
  /\burl\(\s*["']?(https?:\/\/[^"'/?#\s)]+)/gi,
  /@import\s+["'](https?:\/\/[^"'/?#\s]+)/gi,
  /\b(?:fetch|WebSocket|EventSource)\s*\(\s*["'`]((?:https?|wss?):\/\/[^"'`/?#\s]+)/gi,
];
function externalOrigins(html) {
  const out = new Set();
  for (const re of ORIGIN_SITES) for (const m of html.matchAll(re)) out.add(m[1].toLowerCase());
  return [...out];
}
function originAllowed(origin, csp) {
  const all = [...(csp.resourceDomains || []), ...(csp.connectDomains || [])];
  return all.some((d) => {
    const w = d.match(/^([a-z]+:\/\/)\*\.(.+)$/i);
    if (!w) return d.toLowerCase() === origin;
    return origin.startsWith(w[1].toLowerCase()) && origin.endsWith("." + w[2].toLowerCase());
  });
}

export function register(ctx) {
  const { server, store, fileChannel, hostName, run, failNote, fail, computeCaps, viewBase, widgetDomain, cspPolicy } = ctx;
  const PINNING = !!ctx.dynamicTools;
  const { route } = ctx;

  // ── apps other accounts shared with the caller (`@owner/app`) ──────────────────────────────
  // null = the caller's own app; false = refused; else {m, app, role, row}. Without `route` (every
  // local install) a name is only ever the caller's own.
  const sharedApp = async (h) => (route && isHandle(h) ? (await route.session().app(h)) ?? false : null);
  // The verbs that change an app's code, history or functions answer a share with ONE sentence: the
  // owner's, and copy_app is the way to an editable one. An ungranted handle is just not shared.
  const lockedOrNot = async (h) => {
    const sa = await sharedApp(h);
    return sa === null ? null : sa ? sharedLocked(h, sa.m.ownerLabel) : notShared(h);
  };
  // A shared app's document, with its OWN file plane for any bundled assets (the owner's channel,
  // reached through the facade, pinned to this app).
  const serveShared = (sa, comp) => resolveAssets(comp.ui, appAssetReader({ get: (app, path) => sa.m.face.files.get(app, path) }, comp.name));
  // The handles a shared app's runner may reach — its scope, spelled the way the caller names it.
  const sharedHandles = (sa) => sa.row.collections.map((c) => handleOf(sa.m.alias, c));

  // SCOPE FOLLOWS THE APP (Leo 2026-10-02, design §10-5): binding a new collection to an app the
  // owner has shared shares that collection too, from the very next call. So a save that moves the
  // scope says so, with how many people it reaches — the moment the owner can still change course.
  // `scopeOf` is read before the save, `scopeNote` after; both are no-ops on a deployment without
  // grant records (`ctx.sharing`).
  const scopeOf = (name) => (ctx.sharing ? sharedScopeOf(store, name, store.appBirth(name))?.collections ?? [] : null);
  async function scopeNote(name, before) {
    if (!ctx.sharing || !before) return null;
    const after = sharedScopeOf(store, name, store.appBirth(name))?.collections ?? [];
    const added = after.filter((c) => !before.includes(c)), removed = before.filter((c) => !after.includes(c));
    if (!added.length && !removed.length) return null;
    let listed;
    try { listed = await ctx.sharing.list({ app: name }); } catch { return null; }
    if (!listed || listed.ok !== true) return null;
    const people = (listed.grants || []).filter((g) => g.role !== "owner").length;
    const links = (listed.links || []).filter((l) => !l.revoked).length;
    if (!people && !links) return null;
    const who = [people ? `${people} account(s)` : null, links ? `${links} open share link(s)` : null].filter(Boolean).join(" and ");
    return `"${name}" is shared (${who}): ` +
      [added.length ? `they can now ALSO reach ${added.map((c) => `"${c}"`).join(", ")}` : null,
        removed.length ? `they no longer reach ${removed.map((c) => `"${c}"`).join(", ")}` : null].filter(Boolean).join("; ") +
      ". Tell the user — a shared app's scope follows what it binds.";
  }

  // ONE of the three serve-time seams' shared step: a stored `ui` becomes a DOCUMENT here, and a
  // document may carry no external subresource (the widget CSP forbids it, and a host iframe cannot
  // reach this machine anyway), so an app built outside the chat has its bundle inlined on the way
  // out. An app with no `oma-asset:` reference passes through byte-identical.
  const serveUi = (comp) => resolveAssets(comp.ui, appAssetReader(fileChannel, comp.name));

  // A real, clickable URL for the HUMAN, produced only when this engine actually has a viewer to
  // link to. Bare stdio has none and prints none — the same rule list_apps already follows, and for
  // the same reason: a URL that 404s teaches the user the thing is broken, which is worse than no
  // URL. Where it matters most is a terminal host, where an app can be built and never drawn: the
  // widget channel is the only way to SEE it, and a CLI does not have one.
  const viewRoot = viewBase && /^https?:\/\//.test(viewBase)
    ? `${String(viewBase).replace(/\/+$/, "")}/view/`
    : null;
  const viewUrl = (name) => (viewRoot ? viewRoot + encodeURIComponent(name) : null);
  // Built once: every input is fixed for the life of this engine (see loaderUriFor).
  const LOADER_DOC = wrapLoader({ viewBase: viewRoot });
  const LOADER_URI = loaderUriFor(LOADER_DOC + JSON.stringify(cspPolicy.base));



  // ---------------------------------------------------------------- widget security declaration
  // What a host should let this widget reach. The engine does not decide that — the APP declares
  // where it needs to reach (manifest.csp) and the user may add origins of their own
  // (settings `policy:csp:<app>` / `policy:csp:*`); store.cspFor merges the two and this shapes the
  // merge for the wire. Enforcement belongs to the host, per the MCP Apps spec; the OSS engine sets
  // no egress ceiling of its own (Leo, 2026-08-16).
  //
  // An app that declares nothing still gets the platform's base (store.PLATFORM_CSP — the CDN
  // script hosts and Google Fonts), static loads only; it reaches no server it did not declare.
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
  // ---------------------------------------------------------- per-app wiring
  // Every app gets its ui:// resource. Only a PINNED app gets its own open_<name> tool (see
  // syncOpeners below) — E12: a tool per app would make tools/list change on every save_app, and
  // prompt caching is an exact-prefix match (measured: cache_read drops to 0), so building an app
  // would re-bill the whole conversation. The universal open_app covers every app behind one grant.
  const registered = new Set();
  function registerApp(name) {
    if (registered.has(name)) return; // callbacks read the registry live; updates need no re-register
    registered.add(name);
    const uri = `ui://open-mcp-apps/${name}.html`;

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
    registerAppResource(server, `app-${name}`, uri, { mimeType: RESOURCE_MIME_TYPE, _meta: uiSecurityFor(cspFor(store.getApp(name), store, cspPolicy)) }, async () => {
      const comp = store.getApp(name);
      if (!comp) throw new Error(`app ${name} not found`);
      const security = uiSecurityFor(cspFor(comp, store, cspPolicy));
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
      // …and a LIVE FRAME records nothing (contracts.mjs liveFrameFor). An app carrying an
      // `@live` brick is a frame around whatever the pointer names, so pointing at it would aim
      // the wall at itself. This is the OUTER of the two walls: it keeps the bad value from ever
      // being written. The inner one lives in the brick, which refuses to mount a live frame no
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
      if (!liveFrameFor(comp)) store.touchLiveApp(name);
      return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: wrapApp(await serveUi(comp), { app: name, collection: defaultCollectionFor(comp), viewBase: viewRoot }), _meta: security }] };
    });
  }

  // ---------------------------------------------------------- pinned openers
  // The user pins an app in the settings app (group = app name, key open_tool, value true); only
  // then does it get open_<name>. syncOpeners reconciles the registered set with the pins and the
  // registry; the invalidation bridge (notify.mjs) runs it after app-plane writes and settings
  // changes. Each register/remove makes the SDK announce tools/list_changed, and engine.mjs
  // debounces that method, so one sync is one notification — this is its only post-connect sender.
  const openers = new Map();   // app name → the SDK's RegisteredTool handle
  const openerName = (name) => `open_${name.replaceAll("-", "_")}`;
  function syncOpeners() {
    if (!PINNING) return;
    const prefs = store.snapshot(SETTINGS_COLLECTION).items;
    const want = new Set(store.listApps().map((c) => c.name)
      .filter((name) => coercePref(latestPref(prefs, OPEN_TOOL_PREF, name)?.fields.value, false) === true));
    for (const [name, tool] of openers) if (!want.has(name)) { tool.remove(); openers.delete(name); }
    for (const name of want) {
      if (openers.has(name)) continue;
      try { registerApp(name); openers.set(name, registerOpener(name)); }
      catch (e) { console.warn(`[oma] pinned app "${name}" gets no ${openerName(name)} (${e && e.message}); it still opens through open_app`); }
    }
  }
  function registerOpener(name) {
    const uri = `ui://open-mcp-apps/${name}.html`;
    return registerAppTool(
      server,
      openerName(name),
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
        const total = store.countItems(collection);
        const said = withSkill(openedText(comp, collection, total, a && a.collection), skillLine(name, comp.skill, skillAuthor(comp)));
        return toMcp(answer.page(
          { app: name, collection, items: [], version: v.seq,
            settings_version: v.settings_version, files_version: v.files_version, ...(said.note ? { note: said.note } : {}) },
          { returned: 0, total, text: said.text },
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
  registerAppResource(server, "app-loader", LOADER_URI, { mimeType: RESOURCE_MIME_TYPE, _meta: uiSecurityFor(cspUnion(store, cspPolicy)) },
    async () => ({ contents: [{ uri: LOADER_URI, mimeType: RESOURCE_MIME_TYPE, text: LOADER_DOC, _meta: uiSecurityFor(cspUnion(store, cspPolicy)) }] }));
  // THE OLD NAMES STILL ANSWER — with today's document. The two hosts cache opposite halves:
  // ChatGPT keys the template's CONTENT on its URI (hence the hash above), and Claude keeps the
  // connector's TOOL LIST, so it goes on reading whatever URI it last saw — measured 2026-10-02,
  // `resources/read ui://open-mcp-apps/app.html` well after that name was retired, and a widget
  // that said "Unable to reach". So every name the loader has ever had (the bare app.html, any
  // earlier hash) resolves to the current loader. Fixed resources are matched before templates, so
  // an app that really is called `app` keeps its own `app.html`; any other tail is not ours.
  server.registerResource("app-loader-earlier", new ResourceTemplate("ui://open-mcp-apps/app{tail}", { list: undefined }),
    { mimeType: RESOURCE_MIME_TYPE },
    async (uri, { tail }) => {
      if (tail !== ".html" && !/^\.[0-9a-f]{12}\.html$/.test(tail)) throw new ResourceNotFoundError(uri.href);
      return { contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: LOADER_DOC, _meta: uiSecurityFor(cspUnion(store, cspPolicy)) }] };
    });

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
      // Another account's app opens through the same loader, on ITS OWN shared data only: a
      // collection argument outside the app's scope is refused rather than bound — a shared app
      // pointed at the caller's own rows is exactly the reach a share must never grant (T13a).
      const sa = await sharedApp(a.app);
      if (sa === false) return notShared(a.app);
      if (sa) {
        const comp = sa.m.face.getApp(sa.app);
        if (!comp) return notShared(a.app);
        const handles = sharedHandles(sa);
        const bound = handleOf(sa.m.alias, defaultCollectionFor(comp));
        const collection = a.collection || (handles.includes(bound) ? bound : handles[0]);
        if (!handles.includes(collection)) return notShared(a.collection ?? a.app);
        const total = sa.m.face.countItems(collection.slice(sa.m.alias.length + 2)) ?? 0;
        const fv = sa.m.face.dataVersion({ collection: collection.slice(sa.m.alias.length + 2) });
        const said = withSkill(`${provenanceLine(sa.m.ownerLabel, sa.role)}\nOpened "${a.app}" on collection "${collection}" (${total} item(s)). It runs sandboxed and reaches only what was shared; the widget loads its own data — if YOU need rows, read data_list.`,
          skillLine(a.app, comp.skill, skillAuthor(comp, sa.m.ownerLabel)));
        return toMcp(answer.page(
          { app: a.app, collection, items: [], version: fv.seq ?? 0,
            settings_version: store.dataVersion().settings_version, files_version: fv.files_version ?? 0, ...(said.note ? { note: said.note } : {}) },
          { returned: 0, total, text: said.text },
        ));
      }
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
      // The caller's OWN app may be opened on a collection shared WITH them (their app, their
      // trust, their grant): the size comes from the share — and a handle they hold no grant for
      // is refused here, not bound and left to fail inside the widget.
      const onShare = route && isHandle(collection) ? await route.session().collection(collection) : null;
      if (route && isHandle(collection) && !onShare) return notShared(collection);
      const v = store.dataVersion();
      const total = onShare ? onShare.m.face.countItems(onShare.name) ?? 0 : store.countItems(collection);
      // No `seq` in the SENTENCE. It is the store's global ledger position — the number that
      // makes a user who edited an app twice ask why it jumped from 5 to 43 (nothing happened to
      // it; those 38 were their groceries). registry.mjs settled that for app history and this
      // line was the one that got missed. `version` still rides the structured channel, where
      // machinery reads it and nobody recites it.
      const said = withSkill(openedText(comp, collection, total, a.collection)
        + (viewUrl(a.app) ? ` In a browser: ${viewUrl(a.app)}` : ""), skillLine(a.app, comp.skill, skillAuthor(comp)));
      return toMcp(answer.page(
        { app: a.app, collection, items: [], version: v.seq,
          settings_version: v.settings_version, files_version: v.files_version, ...(said.note ? { note: said.note } : {}) },
        { returned: 0, total, text: said.text },
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
        tier: z.enum(["local", "unreviewed", "shared"]),
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
      // Another account's app: tier `shared`, always behind the runner (the loader mounts anything
      // not `local` there), under sharedCaps — the role's verbs, pinned to the shared collections.
      // Its binding and every collection it may reach are HANDLES; its network policy is its own
      // declaration under this deployment's rule, never widened by either account's settings rows.
      const sa = await sharedApp(a.name);
      if (sa === false) return notShared(a.name);
      if (sa) {
        const comp = sa.m.face.getApp(sa.app);
        if (!comp) return notShared(a.name);
        const handles = sharedHandles(sa);
        const bound = handleOf(sa.m.alias, defaultCollectionFor(comp));
        // The live pointer is the CALLER's own (one row in their store, naming the handle) — the
        // owner's is never touched by someone else opening their app.
        if (a.mount === true && !liveFrameFor(comp)) store.touchLiveApp(a.name);
        return {
          content: [{ type: "text", text: `(app "${a.name}" v${comp.version}, ${comp.ui.length} chars, tier shared — consumed by the loader widget)` }],
          structuredContent: { name: a.name, version: comp.version, author: comp.author, tier: "shared",
            locked: true, collection: handles.includes(bound) ? bound : (handles[0] ?? bound), host: hostName(),
            caps: sharedCaps(sa.role, handles), declaration: comp.manifest ? JSON.parse(comp.manifest) : null,
            csp: cspFor(comp, null, cspPolicy),
            html: await serveShared(sa, comp) },
        };
      }
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
      // …and a LIVE FRAME records nothing, the same outer wall the resource path carries: a frame
      // must never aim the pointer at itself, however it came to be mounted.
      if (a.mount === true && !liveFrameFor(comp)) store.touchLiveApp(comp.name);
      // Always the whole document. This call is the loader widget's mount source — the widget
      // cannot assemble windows, and the host↔widget bridge is the one channel measured intact
      // well past the model-facing cut (≥120K). The budget discipline therefore deliberately does
      // not apply here; a model reading source has get_app, which windows by default.
      // `html` stays the FIELD name here — it names the payload's format for the loader widget
      // (shell-runtime reads r.html), not the registry slot. The value is the ui slot.
      return {
        content: [{ type: "text", text: `(app "${comp.name}" v${comp.version}, ${comp.ui.length} chars, tier ${tier} — consumed by the loader widget)` }],
        structuredContent: { name: comp.name, version: comp.version, author: comp.author, tier,
          locked: LOCKED_APPS.has(comp.name), collection: defaultCollectionFor(comp), host: hostName(),
          caps: computeCaps(comp.name, tier), declaration: comp.manifest ? JSON.parse(comp.manifest) : null,
          csp: cspFor(comp, store, cspPolicy),
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
      description: "List UI apps in the registry (reusable across all chats) — pass name to look one up.",
      // One param: name (the "open my X" lookup — exact match, so a registry of any size answers
      // in one call). A `visibility` filter (featured/listed/unlisted/archived) lived here until
      // 0.8.1; nothing has written those values since archive_app's seat left (2026-08-04), so an
      // old store's archived row now lists like any other app — it was always openable by name,
      // and hiding it with no way left to unarchive would strand it.
      inputSchema: {
        name: z.string().optional().describe("exact app name — the fastest way to answer \"open my X\""),
      },
    },
    async (a = {}) => {
      const all = store.listApps({ name: a.name });
      const comps = all;
      const own = comps.filter((c) => !SEEDED_APPS.has(c.name));
      // Apps OTHER accounts shared with the caller, after the caller's own — only from the caller's
      // grants (the router), under the same name filter, as `@owner/app` rows that say
      // who shared them and what the caller may do. None on a local install.
      const shared = [];
      if (route) {
        for (const m of await route.session().all())
          for (const s of m.face.scope().apps) {
            const name = handleOf(m.alias, s.app);
            if (a.name && a.name !== name) continue;
            shared.push({ name, version: s.version, description: s.description, author: s.author, ui_size: s.ui_size,
              locked: true, ...(s.has_skill ? { has_skill: true } : {}),
              shared: { from: m.ownerLabel, role: s.role, collections: s.collections.map((c) => handleOf(m.alias, c)) } });
          }
      }
      const sharedLine = (c) => `- ${c.name} v${c.version} — shared by ${c.shared.from} · ` +
        `${c.shared.role === "editor" ? "you can EDIT DATA" : "READ-ONLY"} · collections: ${c.shared.collections.join(", ") || "(none)"}` +
        (c.description ? ` — ${c.description}` : "");
      const sharedText = shared.length
        ? "Shared with you (other accounts' apps — you can use them and, per role, their data; you cannot change their code: copy_app makes an editable copy of your own):\n" +
          shared.map(sharedLine).join("\n")
        : null;
      // E10: the "→ open_<name>" pointer is printed only for an app whose opener is registered
      // (a pinned one). For any other app it would name a tool that does not exist, and the
      // universal open_app, which always works, is what the model should reach for instead.
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
        (openers.has(c.name) ? `  → ${openerName(c.name)}` : "");
      // Found by the live-model eval: a brand-new user's registry is NOT empty — we seed three
      // system apps — so the one line that pushed toward BUILDING ("Registry is empty…") could
      // never fire, and the model saw three perfectly plausible apps and opened one instead. The
      // instructions already forbid exactly that, in prose. Prose lost. The fact now lives in the
      // data the model is looking at when it decides.
      // A filtered list must never read as the whole registry. `total` says how many matched,
      // before the rows — the same reason a page reports the collection's size and not its own length.
      const head = a.name ? `${all.length + shared.length} match:` : null;
      const empty = a.name
        ? `No app named "${a.name}". Call list_apps with no arguments to see what exists.`
        : "Registry is empty. Call get_app_guide, then save_app to create the first one.";
      const text = comps.length
        ? [head, comps.map(line).join("\n"), own.length ? null :
            "The user has NO apps of their own yet — everything above ships with the engine and is not " +
            "an answer to what they want. Build one: get_app_guide, then save_app, then open_app.", sharedText]
            .filter(Boolean).join("\n")
        : sharedText ? [head, sharedText].filter(Boolean).join("\n")
        : empty;
      // `locked` rides each row so the settings pane can tell fixed system UI apart without a
      // second tool (app_permissions retired 2026-08-04 — get_app_html carries the per-app caps).
      // `functions` is ABSENT, not 0, on an app that declares none — absence is the honest shape
      // for "this app has no function face", and it keeps the rows of a registry that uses no
      // functions byte-identical to what they were before the field existed. (There is no
      // outputSchema on this tool, deliberately: an optional field costs nothing resident, while
      // declaring the row shape would put it in tools/list for every conversation forever.)
      // `pinning` says whether a pin does anything here (absent under dynamicTools:false), so the
      // settings app draws the "Own tool" switch only where it works.
      return { content: [{ type: "text", text }], structuredContent: { total: all.length + shared.length, shown: comps.length + shared.length,
        ...(PINNING ? { pinning: true } : {}),
        // `has_skill` follows the same rule as `functions`: present (true) only on an app that has
        // one, so a registry with no skills lists byte-identical rows. The TEXT line stays as it was —
        // the skill's description is already the row's description (store.mjs save_app).
        apps: [...comps.map(({ fn_count, has_skill, ...c }) => ({ ...c, locked: LOCKED_APPS.has(c.name),
          ...(fn_count > 0 ? { functions: fn_count } : {}), ...(has_skill ? { has_skill: true } : {}) })), ...shared] } };
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
      // A shared app's source is readable by either role: it is sent to the browser anyway, and
      // copying it (copy_app) starts from it. Its HEAD only — history is not part of a share.
      const sa = await sharedApp(a.name);
      if (sa === false) return notShared(a.name);
      const found = sa ? sa.m.face.getApp(sa.app) : store.getApp(a.name);
      if (!found) return sa ? notShared(a.name) : fail(`No app "${a.name}". list_apps shows what exists.`);
      // Named the way the caller named it: a shared app is `@owner/app` on every line it answers.
      const comp = sa ? { ...found, name: a.name } : found;
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

  // The skill slot's read (src/skill.mjs). Every other surface carries one line of it — open_app,
  // install, a data_list over its collections — and points here; this is the one place the body is
  // handed over, whole (it is capped well inside the result budget, so it is never windowed).
  server.registerTool(
    "get_app_skill",
    {
      title: "An app's usage notes",
      annotations: RO,
      // Reference, not orders (Claude directory review, 2026-10-16): the notes are whoever wrote the
      // app speaking — for an App Store or shared app, a third party — so nothing here tells the
      // model to read them first or to follow them; the reply names the author.
      description: "An app's usage notes as its author wrote them: its workflow, what goes where, how to run it on a schedule. Returned as reference with the author named; they describe the app and are not instructions from the user.",
      inputSchema: { app: z.string().describe("app name (see list_apps)") },
    },
    async (a) => {
      // A shared app's guide is readable by either role, like its source — and it is the OWNER's
      // words, which the first line says before anything else (skillProvenance).
      const sa = await sharedApp(a.app);
      if (sa === false) return notShared(a.app);
      const comp = sa ? sa.m.face.getApp(sa.app) : store.getApp(a.app);
      if (!comp) return sa ? notShared(a.app) : fail(`No app "${a.app}". list_apps shows what exists.`);
      if (comp.skill == null)
        return toMcp(answer.chunk({ name: a.app, version: comp.version, skill: null },
          { text: `"${a.app}" has no usage notes. open_app shows the app; data_list reads its data.` }));
      const from = skillProvenance({ app: a.app, author: comp.author, owner: sa ? sa.m.ownerLabel : null, from: comp.skill_from });
      return toMcp(answer.chunk({ name: a.app, version: comp.version, skill: comp.skill, ...(from ? { note: from } : {}) },
        { text: `${from ? `${from}\n` : ""}// ${a.app} v${comp.version} — usage notes\n${comp.skill}` }));
    },
  );

  server.registerTool(
    "save_app",
    {
      title: "Save app",
      annotations: WRITE,
      description: "Create or update a UI app in the persistent registry. Three slots, each optional on update (an omitted slot keeps its current value): ui — the complete HTML document (contract in get_app_guide; window.oma, loads only from the guide's CDN allowlist or manifest.csp, NO embedded manifest block); manifest — the app's declaration as a JSON object (collections, settings, scene, csp; keys in get_app_guide); skill — SKILL.md text telling an AI how to USE the app. null clears manifest or skill. Creating needs ui. Every save snapshots all slots as one new version (history kept). After saving, open it IMMEDIATELY with open_app.",
      inputSchema: {
        name: z.string().describe("app name, ^[a-z][a-z0-9-]{0,31}$ (e.g. 'kanban', 'habit-tracker')"),
        ui: z.string().optional().describe("complete self-contained HTML document using window.oma; omit on update to keep the current one"),
        // A WIDE object on purpose: declaring the manifest's known keys here would put every new
        // vocabulary word into the resident tools/list bytes AND let the SDK strip unknown keys —
        // breaking the "a newer document must still save on an older engine" contract. Depth is
        // validated by the store (manifestShapeError), which preserves what it does not know.
        manifest: z.record(z.string(), z.any()).nullable().optional().describe("declaration object (whole-value replace), null to clear, omit to keep"),
        skill: z.string().nullable().optional().describe("SKILL.md text (whole-value replace), null to clear, omit to keep"),
        description: z.string().optional().describe("one line: what this app shows and what data fields it uses"),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
        expected_version: z.number().optional().describe("REQUIRED when overwriting an existing app: the version you read (get_app). Creating a new name needs none"),
      },
      outputSchema: saveAckSchema,
    },
    async (a) => {
      const shared = await lockedOrNot(a.name);
      if (shared) return shared;
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
        if (a.ui.length > READ_WINDOW && !hasAssetReferences(a.ui)) warnings.push(sizeAdvice(a.name, a.ui.length));
        // Where the document loads from, against where it MAY: the platform base plus (on an
        // extensible deployment) this save's own manifest.csp and the user's additions. Only the
        // outside origins are named — loading React from cdnjs is the supported path, not a smell.
        const allowed = cspFor({ name: a.name, manifest: a.manifest ? JSON.stringify(a.manifest) : existing?.manifest }, store, cspPolicy);
        const outside = externalOrigins(a.ui).filter((o) => !originAllowed(o, allowed));
        if (outside.length)
          warnings.push(`Loads from ${outside.join(", ")}, which this deployment's widget policy does not allow — the host will block it. Allowed: ${(allowed.resourceDomains || []).join(", ")}${cspPolicy.extensible ? " (or declare it in manifest.csp)" : ""}. Inline it, or load it from an allowed origin.`);
        // A one-way door, said out loud at the moment it is walked through. An `oma-asset:`
        // reference means "the source is elsewhere", and the engine takes that literally: from the
        // next save on, edit_app and save_app both refuse this app. Writing one from here is legal
        // (an app may genuinely want its data or a large script in a file) and is exactly the case
        // where the author has no elsewhere to rebuild from — so it is worth a sentence, not a
        // refusal. Free of resident bytes: a warning is result text, not tool surface.
        if (hasAssetReferences(a.ui))
          warnings.push("This ui references bundled assets (oma-asset:…), which marks the app as BUILT OUTSIDE this store — from now on edit_app and save_app both refuse it, and the only way to change it is install-app.mjs (--asset for the files). Inline the code instead if you meant to keep editing it here.");
      }
      const scopeBefore = existing ? scopeOf(a.name) : null;
      const r = store.execute({
        type: "save_app", command_id: a.command_id || randomUUID(),
        name: a.name, ...(a.ui !== undefined ? { ui: a.ui } : {}), ...("manifest" in a ? { manifest: a.manifest } : {}),
        ...("skill" in a ? { skill: a.skill } : {}),
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
        if (r.error === "empty_skill_use_null")
          return fail("skill: \"\" is ambiguous (empty guide vs clear) — pass skill: null to clear it, or omit the key to keep it.");
        if (r.error === "bad_skill")
          return fail(`Invalid skill: ${r.detail}. The format is SKILL.md — get_app_guide covers it. NOTHING was saved.`);
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
      const reach = await scopeNote(a.name, scopeBefore);
      if (reach) notes.push(reach);
      if (r.manifest_action === "replaced") notes.push("Declaration replaced.");
      else if (r.manifest_action === "cleared") notes.push("Declaration cleared (Library filing reset too).");
      if (r.skill_action === "replaced") notes.push("Skill replaced — its description is now this app's description.");
      else if (r.skill_action === "cleared") notes.push("Skill cleared.");
      // One description, and it is the skill's: say so when the caller passed a different one, rather
      // than letting it believe the line it sent is what every listing now shows.
      if (a.description && r.skill_action !== "cleared") {
        const now = store.getApp(a.name);
        if (now && now.skill != null && now.description !== a.description)
          notes.push("description not applied: this app has a skill, and the skill's description is its description everywhere.");
      }
      // Size pair on every save, unconditionally: a 82,623 → 74 char overwrite has to be visible
      // in the reply that caused it, not discoverable afterwards.
      const sizeNote = r.prev_size == null
        ? `${r.size.toLocaleString()} chars.`
        : `${r.prev_size.toLocaleString()} → ${r.size.toLocaleString()} chars.`;
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
      description: "Surgical edits to an app WITHOUT round-tripping the whole source. Two edit forms, mixable: RANGE {offset, length, expect_hash, new_string} replaces a span you read with get_app (cheapest — echo the window's offset/returned/hash, no anchor text travels); STRING {old_string, new_string} replaces an exact-once match (or set replace_all). Range offsets always address the expected_version document and must not overlap; string edits apply after ranges, in order. All edits apply together, or nothing applies. The manifest and skill slots are kept.",
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
      const shared = await lockedOrNot(a.app);
      if (shared) return shared;
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
      const edits = Array.isArray(a.edits) ? a.edits : [];
      const rangeEdits = edits.filter((e) => e && (e.offset != null || e.length != null || e.expect_hash != null));
      const stringEdits = edits.filter((e) => e && !(e.offset != null || e.length != null || e.expect_hash != null));
      if (comp.version !== a.expected_version) {
        return toMcp(answer.fail("version_conflict", { name: a.app, expected_version: comp.version },
          `"${a.app}" is at v${comp.version}, not v${a.expected_version} — re-read the region you are editing and re-apply.`), { isError: true });
      }
      if (!edits.length) return fail("No edits given — pass edits: [{offset, length, expect_hash, new_string}] (range) or [{old_string, new_string}] (string).");
      for (let i = 0; i < rangeEdits.length; i++) {
        const e = rangeEdits[i];
        if (e.offset == null || e.length == null || !e.expect_hash) {
          return fail(`Edit ${edits.indexOf(e)}: a range edit needs ALL of offset, length and expect_hash (get_app returns all three). NOTHING was applied.`);
        }
      }
      // Ranges first, against the ORIGINAL expected_version document (offsets never shift);
      // string edits after, in order, on the intermediate result.
      let html = comp.ui;
      if (rangeEdits.length) {
        const r = applyRangeEdits(html, rangeEdits);
        if (!r.ok) return fail(`${r.detail}. NOTHING was applied.`);
        html = r.html;
      }
      for (let i = 0; i < stringEdits.length; i++) {
        const e = stringEdits[i] || {};
        const oldS = String(e.old_string ?? "");
        if (!oldS) return fail(`Edit ${edits.indexOf(e)}: old_string is empty. NOTHING was applied.`);
        const n = html.split(oldS).length - 1;
        if (n === 0) return fail(`Edit ${edits.indexOf(e)}: old_string not found (0 matches) — read that region again (get_app with offset) and match it exactly, including whitespace. NOTHING was applied.`);
        if (n > 1 && !e.replace_all) return fail(`Edit ${edits.indexOf(e)}: old_string matches ${n} times — add surrounding context to pin ONE occurrence, or set replace_all: true. NOTHING was applied.`);
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
          return toMcp(answer.fail("version_conflict", { name: a.app, expected_version: r.expected },
            `Version conflict: "${a.app}" moved to v${r.expected} while editing — re-read and re-apply. NOTHING was applied.`), { isError: true });
        }
        return fail(r.error === "bad_manifest" ? `The edited document's declaration is invalid: ${r.detail}. NOTHING was applied — fix the edit and retry.`
          : `${failNote(r)} NOTHING was applied.`);
      }
      if (r.idempotent)
        return toMcp(answer.ack({ ok: true, name: a.app, version: r.version, applied: edits.length, note: "already applied (idempotent replay)" },
          `Already applied — "${a.app}" is at v${r.version} from this same command_id.`));
      return toMcp(answer.ack(
        { ok: true, name: a.app, version: r.version, size: r.size, prev_size: r.prev_size ?? null,
          applied: edits.length, manifest_action: r.manifest_action, ...(r.note ? { note: r.note } : {}) },
        `Edited "${a.app}" — ${edits.length} edit(s) applied, v${a.expected_version} → v${r.version}, ${(r.prev_size ?? 0).toLocaleString()} → ${r.size.toLocaleString()} chars.` +
          (r.note ? `\n${r.note}` : "") +
          // Said once, on the edit that crosses the line — not on every edit of an app already past it.
          (r.size > READ_WINDOW && (r.prev_size ?? 0) <= READ_WINDOW ? `\n⚠ ${sizeAdvice(a.app, r.size)}` : ""),
      ));
    },
  );

  // archive_app: seat retired 2026-08-04 (elegance B2); the store command, its undo branch and
  // the visibility values behind it followed on 2026-10-06 (0.8.1) — nothing could reach them.

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
        // A shared app's functions run with its OWNER's egress and secrets, so a share never
        // reaches them, at any role (design §7 T8).
        const shared = await lockedOrNot(a.app);
        if (shared) return shared;
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
  // `syncOpeners` is called by engine.mjs once every fixed tool is registered (so pinned openers
  // sort after the constant surface) and then by the invalidation bridge.
  // `scopeOf` / `scopeNote` and `lockedOrNot` travel too: restore_app moves a declaration the same
  // way save_app does, and the registry verbs answer a shared app the same way the code verbs do.
  return { registerApp, hasApp: (name) => registered.has(name), syncOpeners, scopeOf, scopeNote, lockedOrNot };
}
