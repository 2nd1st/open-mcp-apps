// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// mcp-apps.mjs — the MCP Apps server-side surface, implemented from the spec.
//
// This replaces the four symbols we used to import from @modelcontextprotocol/ext-apps/server.
// It is a spec implementation, not a fork: the two constants are the spec's own literal strings
// (apps.mdx: mimeType "MUST be text/html;profile=mcp-app"; the extension identifier is
// "io.modelcontextprotocol/ui"), and the two functions do exactly what the upstream module does —
// mirror the tool's `_meta.ui.resourceUri` into the deprecated flat `_meta["ui/resourceUri"]`
// spelling (and vice versa), and default the resource mimeType. Verified byte-identical against
// the upstream implementation before the swap (docs/spec-conformance.md §7.8: same registrations,
// 1262 B vs 1262 B, byte-for-byte). The flat alias is deprecated in the spec ("will be removed
// before GA") but still read by shipped hosts, so both spellings stay on the wire; dropping the
// alias is a host-compat decision to make against measured hosts, not a cleanup.
//
// Why own these four symbols at all: ext-apps pins the v1 SDK on its server side and has no v2
// line, while its WIDGET side (what src/shell-runtime.js imports, bundled into dist/shell.js)
// is browser code that never touches server npm resolution. Owning the server half lets the
// engine track the current protocol SDK; the widget half stays on ext-apps unchanged.

export const EXTENSION_ID = "io.modelcontextprotocol/ui";
export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/** Register a tool whose `_meta` carries the MCP Apps UI linkage, with the nested
 *  (`ui.resourceUri`) and deprecated flat (`"ui/resourceUri"`) spellings kept in agreement. */
export function registerAppTool(server, name, config, handler) {
  const m = config._meta, nested = m.ui, flat = m["ui/resourceUri"];
  let out = m;
  if (nested?.resourceUri && !flat) out = { ...m, "ui/resourceUri": nested.resourceUri };
  else if (flat && !nested?.resourceUri) out = { ...m, ui: { ...nested, resourceUri: flat } };
  return server.registerTool(name, { ...config, _meta: out }, handler);
}

/** Register a `ui://` resource, defaulting the mimeType the spec requires for app documents. */
export function registerAppResource(server, name, uri, config, handler) {
  return server.registerResource(name, uri, { mimeType: RESOURCE_MIME_TYPE, ...config }, handler);
}
