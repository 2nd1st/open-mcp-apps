// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// list-hints.mjs — post-processing for tools/list: drop redundant $schema, add caching hints.
//
// Both are things the SDK does not do and we cannot express through registerTool, because the SDK
// builds the tool definitions inside its own tools/list handler. So we WRAP that handler rather
// than reimplement the listing: the original still produces the tools, we only edit the envelope.
//
// Wrapping reaches into Protocol's private handler map. That is a real coupling, taken knowingly:
// the alternative is owning the whole listing (far more surface to drift), and test/tool-surface.mjs
// compares the served list against a golden byte-for-byte, so an SDK change that breaks this shows
// up as a failing build rather than a silent regression. If the handler is not where we expect, we
// leave the server exactly as it was — a missing optimisation, never a broken listing.

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
 *   · dynamic tools ON: the list contains one open_<name> per component, i.e. THIS tenant's
 *     component names. Declaring that "public" would leak them through a shared cache. "private"
 *     confines reuse to the same authorization context.
 *
 * Getting this wrong is not a performance bug, it is a cross-tenant disclosure — which is why the
 * scope is derived from the flag rather than written down as a literal.
 */
export function listCacheHints({ dynamicTools }) {
  return dynamicTools
    ? { ttlMs: 10_000, cacheScope: "private" }   // changes whenever a component is saved
    : { ttlMs: 300_000, cacheScope: "public" }; // fixed for the life of the process
}

/** Wrap the SDK's tools/list handler in place. Returns true if the wrap took effect. */
export function installListHints(server, { dynamicTools }) {
  const handlers = server?.server?._requestHandlers;
  const inner = handlers?.get?.("tools/list");
  if (typeof inner !== "function") return false; // SDK moved it — leave the server untouched
  handlers.set("tools/list", async (request, extra) => ({
    ...dropRedundantDialect(await inner(request, extra)),
    ...listCacheHints({ dynamicTools }),
  }));
  return true;
}
