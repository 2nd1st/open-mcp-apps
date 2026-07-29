// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// tools/library.mjs — the bundled app library: browse, preview, install.
// Registered by engine.mjs. Moved here verbatim: the tool surface is byte-identical to before
// the split, which test/tool-surface.mjs proves against its golden file.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { listLibrary, readLibraryApp } from "../library.mjs";
import { RO, WRITE, itemShape, RESERVED_APP_NAMES, LOCKED_APPS, tierOf } from "../contracts.mjs";

export function register(ctx) {
  const { server, store, hostName, failNote, fail, registerApp } = ctx;

  // ------------------------------------------------------------------ library (app library)
  // The repo's components/ dir is a curated first-party library. Installing FROM it saves the
  // app with actor "library" (provenance + update detection) → tier local → runs DIRECT,
  // exactly like the user's own apps: it's our content, there is nothing to review in OSS.
  // The SaaS user-publishing pipeline later adds review + the runner tier on the same seam.
  // The `library` system app is the browsable UI over these tools.
  server.registerTool(
    "library_list",
    {
      title: "List library apps",
      annotations: RO,
      description: "Browse the built-in library: ready-made, high-quality apps shipped with the engine that the user can install into their registry. Shows install state. Renders no UI — open_app {app: \"library\"} shows the browsable library app.",
      inputSchema: {},
      outputSchema: {
        entries: z.array(z.object({
          name: z.string(), title: z.string(), description: z.string(), category: z.string(),
          size: z.number(), has_preview: z.boolean(),
          installed: z.boolean(), from_library: z.boolean().describe("installed copy came from the library"),
          update_available: z.boolean(),
        })),
      },
    },
    async () => {
      const entries = listLibrary().map((e) => {
        const cur = store.getApp(e.name);
        const from_library = !!cur && cur.author === "library";
        const update_available = from_library && cur.html !== (readLibraryApp(e.name)?.html ?? cur.html);
        return { name: e.name, title: e.title, description: e.description, category: e.category, size: e.size, has_preview: e.has_preview, installed: !!cur, from_library, update_available };
      });
      const text = entries.length
        ? "Library apps:\n" + entries.map((e) => `  - ${e.name} — ${e.title}${e.installed ? (e.update_available ? " [installed, update available]" : " [installed]") : ""}${e.description ? ` — ${e.description}` : ""}`).join("\n")
        : "The library is empty (no library apps shipped in this install).";
      return { content: [{ type: "text", text }], structuredContent: { entries } };
    },
  );

  server.registerTool(
    "library_preview",
    {
      title: "Library live-preview payload (internal)",
      annotations: RO,
      description: "Internal: returns a library entry's html plus its embedded mock-data fixtures, so the library app can render a LIVE sandboxed preview card (srcdoc + stub oma + mock snapshot). Read-only; nothing is installed. Not useful to call directly.",
      inputSchema: { name: z.string().describe("library entry name (see library_list)") },
      outputSchema: {
        name: z.string(), title: z.string(), description: z.string(), category: z.string(),
        html: z.string(),
        // FIXTURE rows, not store rows. The documented convention for an embedded mock snapshot is
        // {collection, group, fields} — the preview machines normalise it into real item shape when
        // they answer a read (runner.mjs fxRows / stubOmaScript). Declaring the full item shape here
        // demanded id/position/version that fixtures are not supposed to carry, so an entry that
        // followed the convention exactly (builder-progress) failed output validation and its
        // preview died on EVERY host — while entries that happened to include the extra keys passed.
        // Reproduced 2026-07-28 from a ChatGPT web screenshot: "preview unavailable" on one card.
        fixtures: z.object({ items: z.array(z.object({
          collection: z.string().optional(), group: z.string().optional(),
          fields: z.record(z.string(), z.any()),
          id: z.string().optional(), position: z.number().optional(), version: z.number().optional(),
        })) }).nullable().describe("embedded mock snapshot items, or null if the entry ships none"),
      },
    },
    async (a) => {
      const entry = readLibraryApp(a.name);
      if (!entry) return fail(`No "${a.name}" in the library. library_list shows what's available.`);
      return {
        content: [{ type: "text", text: `(library preview payload for "${entry.name}" — ${entry.html.length} chars, ${entry.fixtures ? entry.fixtures.items.length + " mock items" : "no fixtures"}; consumed by the library app)` }],
        structuredContent: { name: entry.name, title: entry.title, description: entry.description, category: entry.category, html: entry.html, fixtures: entry.fixtures },
      };
    },
  );

  server.registerTool(
    "install_from_library",
    {
      title: "Install a library app",
      annotations: WRITE,
      description: "Install (or update) a ready-made app from the built-in library into the user's registry. Once installed it behaves like any app of the user's own; its UI updates come from the library (newer library version), not from edits. Use library_list to see what's available. Installing is HALF the job: before handing it over, seed the collection with the user's real rows (data_batch, from what you already know of them) — an installed app opened empty and generic is half-delivered.",
      inputSchema: {
        name: z.string().describe("library entry name (see library_list)"),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
      },
      outputSchema: { name: z.string(), version: z.number(), tier: z.string(), updated: z.boolean().optional() },
    },
    async (a) => {
      // Same name guards as save_app — this is a registry WRITE path and must refuse what
      // the tool boundary refuses (reserved namespaces + locked system UIs), not rely on the
      // library dir happening to contain no such files.
      if (RESERVED_APP_NAMES.has(a.name) || LOCKED_APPS.has(a.name))
        return fail(`"${a.name}" is a reserved/system name — not installable.`);
      const entry = readLibraryApp(a.name);
      if (!entry) return fail(`No "${a.name}" in the library. library_list shows what's available.`);
      const cur = store.getApp(a.name);
      if (cur && cur.author !== "library")
        return fail(`"${a.name}" already exists in your registry as a ${cur.author}-authored app — NOT overwriting it with the library version. Delete or rename the existing one first if you want the library app.`);
      if (cur && cur.html === entry.html)
        return { content: [{ type: "text", text: `"${a.name}" is already installed and up to date (v${cur.version}). Open it with open_app.` }], structuredContent: { name: a.name, version: cur.version, tier: tierOf("library"), updated: false } };
      const r = store.execute({
        type: "save_app", declaration_policy: "salvage", command_id: a.command_id || randomUUID(),
        name: a.name, html: entry.html, description: entry.description || entry.title, actor: "library", host: hostName(),
      });
      if (!r.ok) return fail(failNote(r));
      registerApp(a.name);
      return {
        content: [{ type: "text", text: `Installed "${a.name}" v${r.version} from the library. Open it now with open_app {app: "${a.name}"}.` }],
        structuredContent: { name: a.name, version: r.version, tier: tierOf("library"), updated: !!cur },
      };
    },
  );

}
