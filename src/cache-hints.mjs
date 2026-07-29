// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// cache-hints.mjs — post-processing for cacheable results: drop redundant $schema, add caching hints.
//
// Both are things the SDK does not do and we cannot express through registerTool/registerResource,
// because the SDK builds the definitions inside its own list handlers. So we WRAP those handlers
// rather than reimplement them: the original still produces the payload, we only edit the envelope.
//
// Wrapping reaches into Protocol's private handler map. That is a real coupling, taken knowingly:
// the alternative is owning the whole listing (far more surface to drift), and test/tool-surface.mjs
// compares the served list against a golden byte-for-byte, so an SDK change that breaks this shows
// up as a failing build rather than a silent regression. If the handler is not where we expect, we
// leave the server exactly as it was — a missing optimisation, never a broken listing.

import { LOADER_URI } from "./tools/apps.mjs";

// Keywords whose MEANING differs between draft-07 and 2020-12. If a schema uses none of them, the
// two dialects agree on every keyword it actually contains, so the declaration carries no
// information and the spec's default (2020-12) describes it exactly.
const DIVERGENT_KEYWORDS = new Set(["definitions", "dependencies", "additionalItems", "$ref", "$defs", "prefixItems"]);

/** True if this schema means something different depending on which dialect it is read as. */
export function dialectMatters(value) {
  if (Array.isArray(value)) return value.some(dialectMatters);
  if (!value || typeof value !== "object") return false;
  for (const [k, v] of Object.entries(value)) {
    if (DIVERGENT_KEYWORDS.has(k)) return true;
    if (k === "items" && Array.isArray(v)) return true;        // tuple form moved to prefixItems
    if (k === "exclusiveMinimum" && typeof v === "boolean") return true; // draft-04 style
    if (k === "exclusiveMaximum" && typeof v === "boolean") return true;
    if (dialectMatters(v)) return true;
  }
  return false;
}

/** Drop `$schema` from schemas that read identically under either dialect.
 *
 *  ⚠️ The premise this started from was wrong. The assumption was that these declared the 2020-12
 *  DEFAULT and were pure waste; the SDK actually emits "http://json-schema.org/draft-07/schema#",
 *  an explicit and different dialect. Removing that would silently reinterpret the schema — the
 *  spec lists an explicit draft-07 tool as a legitimate case.
 *
 *  So the removal is conditional and self-guarding: our current schemas use only keywords the two
 *  drafts agree on (verified: zero occurrences of definitions/$ref/dependencies/tuple-items across
 *  all 34 tools), which makes dropping the declaration information-preserving. The moment a schema
 *  gains a divergent construct, its declaration stays, without anyone having to remember why.
 *  Worth 3,172 B — ~793 tokens resident in every conversation. */
function dropRedundantDialect(value) {
  if (Array.isArray(value)) return value.map(dropRedundantDialect);
  if (!value || typeof value !== "object") return value;
  const drop = "$schema" in value && !dialectMatters(value);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "$schema" && drop) continue;
    out[k] = dropRedundantDialect(v);
  }
  return out;
}

/**
 * Caching hints for tools/list. The draft spec makes these MUST for complete list results.
 *
 * cacheScope is the part that needs care, and it is NOT a constant. Per the spec, "public" lets a
 * client, gateway or proxy serve one caller's cached response to another — explicitly including
 * across authorization contexts, "different access tokens can leverage the same cache".
 *
 *   · dynamic tools OFF (the default): every tenant sees the identical 34 tools. Nothing in the
 *     list is user-specific, so "public" is true and lets shared infrastructure cache it once.
 *   · dynamic tools ON: the list contains one open_<name> per app, i.e. THIS tenant's
 *     app names. Declaring that "public" would leak them through a shared cache. "private"
 *     confines reuse to the same authorization context.
 *
 * Getting this wrong is not a performance bug, it is a cross-tenant disclosure — which is why the
 * scope is derived from the flag rather than written down as a literal.
 */
export function listCacheHints({ dynamicTools }) {
  return dynamicTools
    ? { ttlMs: 10_000, cacheScope: "private" }   // changes whenever an app is saved
    : { ttlMs: 300_000, cacheScope: "public" }; // fixed for the life of the process
}

/**
 * The same two fields on the resource side (SEP-2549 requires them on `resources/list`,
 * `resources/read` and `resources/templates/list` too, not just `tools/list`).
 *
 * There are exactly two kinds of document behind our `ui://` space, and they want opposite hints:
 *
 *   · STORE-DERIVED — the per-app resources and the list that enumerates them. The bytes are
 *     the user's own app, and the list is the user's own app names. `private`, because a
 *     shared cache serving one tenant's app to another is a disclosure, not a slow render. And
 *     `ttlMs: 0` — "immediately stale, re-fetch when needed" — because the AI can rewrite a
 *     app mid-sentence: any freshness window we promise here is a window in which the user
 *     sees the app they just changed, unchanged. We have no basis to promise one, so we promise
 *     none. (Spec: 0 is a defined value, not the absence of a hint.)
 *   · ENGINE-CONSTANT — answers built from the engine binary alone. Byte-identical for every tenant
 *     of a deployment, so `public` lets a gateway fetch them once for everyone.
 *
 * The template list is engine-constant — it carries URI patterns, never store contents — and
 * test/server-smoke pins it empty so that the day someone registers a store-derived template, the
 * scope decision comes back up for review instead of silently going public.
 */
const STORE_DERIVED = { ttlMs: 0, cacheScope: "private" };
const ENGINE_CONSTANT = { ttlMs: 300_000, cacheScope: "public" };

/** The universal loader: PUBLIC, but promising no freshness. Measured, 2026-07-29.
 *
 *  This carried ENGINE_CONSTANT's 300_000 ms on the strength of "stable for the life of the build".
 *  That sentence is true and it is not the whole statement, because the thing the hint is attached
 *  to — `ui://open-mcp-apps/app.html` — is NOT scoped to a build. It is one constant string for the
 *  life of the project. So a five-minute promise made by build N is still being honoured while
 *  build N+1 is serving, and there is no way to withdraw it: the identifier a cache keys on did not
 *  change when the bytes did.
 *
 *  What that cost us, measured on stg: the image swapped at 03:48:18 UTC, a widget rendered at
 *  03:51:56 against a document the host had cached from BEFORE the swap (zero `resources/read` in
 *  between), and the host did not fetch the new document until 03:56:02. Eight minutes in which
 *  every test measured the previous build — and nobody could tell which side of the line they were
 *  on. Two days of "fixed it, then it broke again" were partly this.
 *
 *  Two ways out. Scope the IDENTIFIER to the build (a content hash in the URI) — which makes the
 *  long TTL honest, at the price of a name that churns on every edit and a byte-compared tool
 *  surface that churns with it. Or stop claiming a stability we cannot enforce. We already made
 *  exactly this call for store-derived documents, for exactly this reason — "any freshness window
 *  we promise is a window in which the user sees the app they just changed, unchanged" — and the
 *  loader changes on every deploy. So it gets the same answer, and pays the same price: one
 *  `resources/read` per widget open (~30 ms, measured), against a cache that cannot go stale.
 *
 *  `public` stays: the document really is identical for every tenant of a deployment, and with no
 *  freshness window there is nothing for a shared cache to hold on to. */
const LOADER = { ttlMs: 0, cacheScope: "public" };

/** The loader is only shareable while it really is the same answer for everybody.
 *
 *  It was declared public on the strength of "wrapLoader() is built from the engine binary alone",
 *  which was true — and then stopped being the whole truth: the widget security declaration
 *  attaches `_meta.ui.domain` and `redirect_domains`, and both are properties of a DEPLOYMENT.
 *  Two deployments then serve the same URI with different metadata while both say "public", which
 *  is a licence for a shared gateway to hand one deployment's declaration to another.
 *
 *  So the scope is read off the ANSWER rather than remembered from the body: deployment-derived
 *  fields present ⇒ private. A future field of the same kind only has to be named here.
 *
 *  ⚠️ This said "the test pins the two cases" from the day it was written, and that was FALSE until
 *  2026-07-29: only the no-domain side was covered, so the branch a SaaS deployment actually takes
 *  had zero tests. Both sides are pinned now (test/server-smoke §2c builds an engine with
 *  widgetDomain, and one with viewBase, and asserts the loader drops to private) — but the lesson
 *  is the sentence, not the gap: a comment claiming coverage is not coverage, and this one went
 *  three weeks without anyone checking it against the file it named. */
function deploymentSpecific(result) {
  const meta = result?.contents?.[0]?._meta || {};
  const ui = meta.ui || {};
  return !!(ui.domain || meta["openai/widgetDomain"] || (meta["openai/widgetCSP"]?.redirect_domains || []).length);
}

export function resourceCacheHints(uri, result) {
  return uri === LOADER_URI && !deploymentSpecific(result) ? LOADER : STORE_DERIVED;
}

/** Wrap the SDK's cacheable-result handlers in place. Returns true if the wrap took effect. */
export function installCacheHints(server, { dynamicTools }) {
  const handlers = server?.server?._requestHandlers;
  const inner = handlers?.get?.("tools/list");
  if (typeof inner !== "function") return false; // SDK moved it — leave the server untouched
  handlers.set("tools/list", async (request, extra) => ({
    ...dropRedundantDialect(await inner(request, extra)),
    ...listCacheHints({ dynamicTools }),
  }));

  // Resources are wrapped one by one and each is optional: a server with no resources registered
  // has no such handler, and that is not an error.
  for (const [method, hints] of [
    ["resources/list", STORE_DERIVED],           // enumerates ui:// per app = tenant names
    ["resources/templates/list", ENGINE_CONSTANT], // URI patterns only (pinned empty by the smoke)
  ]) {
    const list = handlers.get(method);
    if (typeof list === "function")
      handlers.set(method, async (request, extra) => ({ ...(await list(request, extra)), ...hints }));
  }

  const read = handlers.get("resources/read");
  if (typeof read === "function")
    handlers.set("resources/read", async (request, extra) => {
      const out = await read(request, extra);
      return { ...out, ...resourceCacheHints(request?.params?.uri, out) };
    });

  return true;
}
