// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// notify.mjs — the invalidation bridge (W2, redesign §2.5-C).
//
// `subscriptions/listen` is an INVALIDATION primitive, not a message channel: the 2026-07-28
// filters are tools-list, prompts-list, resources-list and named resource URIs, and the stream
// carries no replay contract (a reconnect must refetch). So this module answers exactly one
// question — "what did a store write make STALE on the host?" — and it answers nothing else.
// The messages-to-the-AI problem (C2 inbox) is not solved by this primitive and is not attempted
// here; it stays a resource plus a pull tool.
//
// The gap it closes is not theoretical. `registerApp` mints a `ui://` resource the moment the AI
// saves a new app, and until now NOBODY told the host: a client that had listed resources held
// that stale list for the rest of the session, so an app created mid-conversation was invisible
// to every direct-embedding path until a reconnect.
//
// WHAT IS DELIBERATELY SILENT: item, settings and file writes. No MCP resource models a
// collection, so there is nothing on the host to invalidate — the widget poll and `data_changes`
// (a caller-held ledger mark) own that plane, and inventing a resource per collection just to
// have something to invalidate would add a surface to serve a mechanism rather than a user.
// The one exception is the tool list: a settings write may pin or unpin an app's own opener, so
// a burst that moved the settings sub-version (or touched the app plane) runs `syncTools`.

/** Ledger commands that change what the host is holding. Everything else is data-plane. */
const APP_PLANE = new Set(["save_app", "delete_app", "archive_app"]);

/**
 * Bridge one store's change stream onto one server's notifications.
 *
 * OWNERSHIP (§2.5-C). Engines are built PER CONNECTION — `createEngine` is handed to the
 * transport as a factory — while the store is process-wide and its EventEmitter is shared. So a
 * subscription that is never released is not a tidiness matter: every reconnect would add a
 * listener that outlives its dead server, past the emitter's 100-listener ceiling, each one still
 * trying to write to a closed transport. The disposer returned here is wired to the server's own
 * close, so the bridge lives exactly as long as the connection it speaks for.
 *
 * COALESCING. A burst (a seeded install, a apply_data_writes, the AI saving three apps in a row) must
 * cost one notification per KIND, not one per command: the host's only reaction is to refetch,
 * and refetching three times for three saves is three times the work for one answer. Events are
 * folded into a pending set and flushed on the next tick — the same tick discipline the store
 * uses for its own post-commit emit, so a notification can never precede the commit it describes.
 *
 * BACKPRESSURE. There is none to manage, and that is a property of the mapping rather than an
 * omission: only app-plane commands notify, a burst folds to one flush, and the payloads carry no
 * data (a URI at most). The plane that DOES have volume — item writes — is silent by design.
 *
 * NO REPLAY. `listen` has no replay contract, so a client that missed a flush while disconnected
 * must refetch on reconnect. Nothing here queues for absent clients; a dropped notification is
 * indistinguishable from never having subscribed, which is exactly what the primitive promises.
 */
export function bridgeInvalidations(store, server, { hasApp = () => false, syncTools } = {}) {
  if (!store?.events || !server?.server) return () => {};
  const uriOf = (name) => `ui://open-mcp-apps/${name}.html`;
  const settingsVersion = () => { try { return store.dataVersion().settings_version; } catch { return undefined; } };

  let pendingList = false;
  const pendingUris = new Set();
  let pendingTools = false;    // an app-plane write: the opener set may have moved
  let pendingData = false;     // any other write: it may have been a pin, if settings moved
  let lastSettings = syncTools ? settingsVersion() : undefined;
  let scheduled = false;

  // Every send is best-effort, and it has to swallow BOTH shapes of failure: the SDK's senders
  // are async, so "Not connected" arrives as a rejected promise, not a throw. An engine that was
  // built but never attached to a transport is ordinary — the browser viewer holds one, and a
  // connection closing between a store write and this tick is how connections end. A lost
  // notification costs the client a refetch it must do after any reconnect anyway; an unhandled
  // rejection would take the process down for it (this is how the suite first found the gap).
  const quiet = (send) => {
    try { const r = send(); if (r && typeof r.catch === "function") r.catch(() => {}); } catch { /* closed */ }
  };

  const flush = () => {
    scheduled = false;
    const list = pendingList, uris = [...pendingUris], tools = pendingTools, data = pendingData;
    pendingList = false; pendingUris.clear(); pendingTools = false; pendingData = false;
    if (list) quiet(() => server.server.sendResourceListChanged());
    for (const uri of uris) quiet(() => server.server.sendResourceUpdated({ uri }));
    // tools/list_changed is never sent from here: syncTools registers/removes openers and the SDK
    // announces those (debounced to one per tick). No opener moved ⇒ nothing is sent, so an
    // ordinary save_app leaves every prompt cache intact.
    if (syncTools && (tools || data)) {
      const sv = settingsVersion();
      const moved = sv !== lastSettings;
      lastSettings = sv;
      if (tools || moved) quiet(syncTools);
    }
  };

  const schedule = () => { if (!scheduled) { scheduled = true; queueMicrotask(flush); } };

  const onChange = (e) => {
    if (!e) return;
    if (!APP_PLANE.has(e.type)) {
      if (syncTools) { pendingData = true; schedule(); }
      return;
    }
    pendingTools = true;
    const name = typeof e.name === "string" ? e.name : "";
    // WHICH invalidation, decided HERE rather than at flush time. A save arrives while the app's
    // resource registration is still pending — the store emits inside execute(), and the tool
    // handler calls registerApp on the line after — so "was this app already registered?" is only
    // true-to-the-event at emit. Asking at flush would call every first save an update of a
    // resource the host has never heard of.
    if (e.type === "save_app" && name && hasApp(name)) pendingUris.add(uriOf(name));
    else pendingList = true;
    schedule();
  };

  store.events.on("change", onChange);
  return () => { store.events.off("change", onChange); };
}
