// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// cache-hints.mjs — the SEP-2549 cache POLICY, plus the tools/list `$schema` trim.
//
// The enforcement moved: the v2 SDK emits `ttlMs`/`cacheScope` itself, configured per operation
// (ServerOptions.cacheHints, engine.mjs) and per resource (registerResource's cacheHint,
// tools/apps.mjs). What lives here is the POLICY those two places read — which answers are
// tenant-derived and which are engine-constant, and why mixing them up is a cross-tenant
// disclosure, not a performance bug. One module so the doctrine has one home; the days of
// wrapping the SDK's private handler map for cache fields are over (the `$schema` trim below is
// the one wrap that remains, for a thing registerTool still cannot express).
//
// ⚠️ Era note (v2 semantics): cache fields are 2026-07-28 vocabulary. The SDK emits them on
// modern-era responses only — a 2025-era client never sees them, which is spec-correct where the
// old hand-injection sprayed them on the only (legacy) wire we had. Tests that assert these
// fields must speak the modern era to see them.

// The dialect the spec declares as default for tool schemas ("Defaults to JSON Schema 2020-12
// when no explicit $schema is provided" — Tool.inputSchema, 2026-07-28). A declaration that
// merely restates the default carries zero information, so serving it is pure resident bytes.
//
// This used to be a full draft-07↔2020-12 divergence classifier (recursive keyword walk,
// 17-entry divergent-keyword table). Retired 2026-08-04 (elegance A7): SDK v2 fixes Standard
// Schema conversion to 2020-12, no registration in this repo supplies raw JSON Schema, so the
// only $schema that can appear is the default restated. If a future wave imports an explicit
// non-default dialect, the golden byte gate forces the decision back into the open.
const DEFAULT_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** Drop a top-level `$schema` that merely restates the spec default. Identity-preserving:
 *  an untouched schema keeps its object (and any symbols riding it). */
function dropRedundantDialect(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  if (schema.$schema !== DEFAULT_DIALECT) return schema;
  const { $schema, ...rest } = schema;
  return rest;
}

/**
 * Caching hints for tools/list — the one scope that is NOT a constant. Per the spec, "public"
 * lets a client, gateway or proxy serve one caller's cached response to another — explicitly
 * including across authorization contexts ("different access tokens can leverage the same cache").
 *
 *   · dynamic tools OFF (the default): every tenant sees the identical tool list. Nothing in it
 *     is user-specific, so "public" is true and lets shared infrastructure cache it once.
 *   · dynamic tools ON: the list contains one open_<name> per app, i.e. THIS tenant's app names.
 *     Declaring that "public" would leak them through a shared cache. "private" confines reuse
 *     to the same authorization context.
 *
 * Derived from the flag rather than written down as a literal, because getting it wrong is a
 * cross-tenant disclosure.
 */
export function listCacheHints({ dynamicTools }) {
  return dynamicTools
    ? { ttlMs: 10_000, cacheScope: "private" }   // changes whenever an app is saved
    : { ttlMs: 300_000, cacheScope: "public" }; // fixed for the life of the process
}

/**
 * The two kinds of document behind our `ui://` space, and the template list, want opposite hints:
 *
 *   · STORE-DERIVED answers (the per-app resources, the lists that enumerate them) carry NO
 *     explicit hint: the SDK default — {ttlMs: 0, cacheScope: "private"} — is exactly the right
 *     one. `private`, because a shared cache serving one tenant's app to another is a disclosure;
 *     `0`, because the AI can rewrite an app mid-sentence. The constant that used to restate this
 *     default was retired 2026-08-04 (elegance A18): stating it here ONCE is the doctrine, and
 *     inheritance is what keeps every store-derived registration honest by omission.
 *   · ENGINE_CONSTANT — answers built from the engine binary alone, byte-identical for every
 *     tenant of a deployment, so `public` lets a gateway fetch them once for everyone. The
 *     template list qualifies — it carries URI patterns, never store contents — and
 *     test/server-smoke pins it empty so the day someone registers a store-derived template, the
 *     scope decision comes back up for review instead of silently going public.
 */
export const ENGINE_CONSTANT = { ttlMs: 300_000, cacheScope: "public" };

/** The universal loader: PUBLIC, but promising no freshness. Measured, 2026-07-29.
 *
 *  It carried ENGINE_CONSTANT's 300_000 ms on the strength of "stable for the life of the build" —
 *  true, and not the whole statement, because `ui://open-mcp-apps/app.html` is one constant string
 *  for the life of the PROJECT, not of a build. A five-minute promise made by build N is still
 *  being honoured while build N+1 serves, and there is no way to withdraw it. Measured cost on
 *  stg: an eight-minute window in which a host rendered widgets against the previous build's
 *  cached loader, and nobody could tell which side of the line they were on. So the loader pays
 *  one `resources/read` per widget open (~30 ms, measured) against a cache that cannot go stale.
 *
 *  `public` holds only while the answer really is the same for everybody — and the widget
 *  security declaration can make it deployment-specific (`_meta.ui.domain`, redirect_domains).
 *  Both inputs are knobs of createEngine, so the branch is decided AT REGISTRATION
 *  (tools/apps.mjs): deployment-derived fields present ⇒ the hint is omitted (private/zero default). */
export const LOADER = { ttlMs: 0, cacheScope: "public" };

/** Trim redundant `$schema` declarations from the served tools/list, in place.
 *  Returns true if the wrap took effect.
 *
 *  Wrapping reaches into Protocol's private handler map — a real coupling, taken knowingly: the
 *  SDK builds tool definitions inside its own list handler, so there is no registration-time seam
 *  for this. test/tool-surface.mjs compares the served list against a golden byte-for-byte, so an
 *  SDK change that breaks the wrap shows up as a failing build rather than a silent regression;
 *  if the handler is not where we expect, the server is left exactly as it was — a missing
 *  optimisation, never a broken listing. */
export function installSchemaTrim(server) {
  const handlers = server?.server?._requestHandlers;
  const inner = handlers?.get?.("tools/list");
  if (typeof inner !== "function") return false; // SDK moved it — leave the server untouched
  handlers.set("tools/list", async (request, extra) => {
    // Rebuild ONLY the two schema fields of tools that actually change. Identity is load-bearing
    // twice over: the SDK rides its per-operation cache-hint fallback on a Symbol attached to the
    // result object (`Symbol(modelcontextprotocol.resultCacheHintFallback)`, measured), and a
    // rebuilt result silently downgrades every tools/list to {ttlMs: 0, cacheScope: "private"}.
    // Running the trim over whole tool objects would also rewrite fields that are not schemas at
    // all — an opaque `_meta.$schema` is somebody's extension key, not a dialect declaration.
    const out = await inner(request, extra);
    if (out && Array.isArray(out.tools)) {
      out.tools = out.tools.map((t) => {
        if (!t || typeof t !== "object") return t;
        const input = dropRedundantDialect(t.inputSchema);
        const output = dropRedundantDialect(t.outputSchema);
        if (input === t.inputSchema && output === t.outputSchema) return t;
        const copy = { ...t };
        if (input !== t.inputSchema) copy.inputSchema = input;
        if (output !== t.outputSchema) copy.outputSchema = output;
        return copy;
      });
    }
    return out;
  });
  return true;
}
