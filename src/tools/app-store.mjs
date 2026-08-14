// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// tools/app-store.mjs — the bundled APP STORE: browse, preview, install.
// Registered by engine.mjs. Moved here verbatim: the tool surface is byte-identical to before
// the split, which test/tool-surface.mjs proves against its golden file.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { listAppStore, readAppStoreApp } from "../app-store.mjs";
import { RO, WRITE, itemShape, RESERVED_APP_NAMES, LOCKED_APPS, tierOf } from "../contracts.mjs";

export function register(ctx) {
  const { server, store, hostName, failNote, fail, registerApp } = ctx;

  // ------------------------------------------------------------------ app store
  // The repo's components/ dir is a curated first-party store. Installing FROM it saves the
  // app with actor "library" (provenance + update detection — a persisted store value that keeps
  // its v0.4 spelling; renaming it would need a migration) → tier local → runs DIRECT,
  // exactly like the user's own apps: it's our content, there is nothing to review in OSS.
  // The SaaS user-publishing pipeline later adds review + the runner tier on the same seam.
  // The `app-store` system app is the browsable UI over these tools.
  server.registerTool(
    "app_store_list",
    {
      title: "List App Store apps",
      annotations: RO,
      description: "Browse the built-in App Store: ready-made, high-quality apps shipped with the engine that the user can install into their registry. Shows install state. Renders no UI — open_app {app: \"app-store\"} shows the browsable App Store app.",
      inputSchema: {},
      outputSchema: {
        entries: z.array(z.object({
          name: z.string(), title: z.string(), description: z.string(), category: z.string(),
          ui_size: z.number(), has_manifest: z.boolean(), has_preview: z.boolean(),
          installed: z.boolean(), from_app_store: z.boolean().describe("installed copy came from the App Store"),
          update_available: z.boolean(),
        })),
      },
    },
    async () => {
      const entries = listAppStore().map((e) => {
        const cur = store.getApp(e.name);
        const from_app_store = !!cur && cur.author === "library";
        // BOTH slots decide freshness: a manifest-only store update is still an update, and
        // comparing only the document made it permanently uninstallable (W-N review, contract #7).
        const lib = from_app_store ? readAppStoreApp(e.name) : null;
        const update_available = !!lib && (cur.ui !== lib.ui
          || (cur.manifest ?? null) !== (lib.manifest ? JSON.stringify(lib.manifest) : null));
        return { name: e.name, title: e.title, description: e.description, category: e.category,
          ui_size: e.ui_size, has_manifest: e.has_manifest, has_preview: e.has_preview, installed: !!cur, from_app_store, update_available };
      });
      const text = entries.length
        ? "App Store apps:\n" + entries.map((e) => `  - ${e.name} — ${e.title}${e.installed ? (e.update_available ? " [installed, update available]" : " [installed]") : ""}${e.description ? ` — ${e.description}` : ""}`).join("\n")
        : "The App Store is empty (no store apps shipped in this install).";
      return { content: [{ type: "text", text }], structuredContent: { entries } };
    },
  );

  server.registerTool(
    "app_store_preview",
    {
      title: "App Store live-preview payload (internal)",
      annotations: RO,
      description: "Internal: returns an App Store entry's ui and manifest plus its mock-data fixtures, so the App Store app can render a LIVE sandboxed preview card (srcdoc + stub oma + mock snapshot). Read-only; nothing is installed. Not useful to call directly.",
      inputSchema: { name: z.string().describe("App Store entry name (see app_store_list)") },
      outputSchema: {
        name: z.string(), title: z.string(), description: z.string(), category: z.string(),
        html: z.string().describe("the entry's ui slot (field named for its format — the preview iframe srcdocs it)"),
        manifest: z.record(z.string(), z.any()).nullable(),
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
      const entry = readAppStoreApp(a.name);
      if (!entry) return fail(`No "${a.name}" in the App Store. app_store_list shows what's available.`);
      return {
        content: [{ type: "text", text: `(App Store preview payload for "${entry.name}" — ${entry.ui.length} chars, ${entry.fixtures ? entry.fixtures.items.length + " mock items" : "no fixtures"}; consumed by the App Store app)` }],
        structuredContent: { name: entry.name, title: entry.title, description: entry.description, category: entry.category, html: entry.ui, manifest: entry.manifest, fixtures: entry.fixtures },
      };
    },
  );

  server.registerTool(
    "install_from_app_store",
    {
      title: "Install an App Store app",
      annotations: WRITE,
      description: "Install (or update) a ready-made app from the built-in App Store into the user's registry. Once installed it behaves like any app of the user's own; its UI updates come from the App Store (newer store version), not from edits. Use app_store_list to see what's available. Installing is HALF the job: before handing it over, seed the collection with the user's real rows (data_batch, from what you already know of them) — an installed app opened empty and generic is half-delivered.",
      inputSchema: {
        name: z.string().describe("App Store entry name (see app_store_list)"),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
      },
      outputSchema: { name: z.string(), version: z.number(), tier: z.string(), updated: z.boolean().optional() },
    },
    async (a) => {
      // Same name guards as save_app — this is a registry WRITE path and must refuse what
      // the tool boundary refuses (reserved namespaces + locked system UIs), not rely on the
      // store dir happening to contain no such files.
      if (RESERVED_APP_NAMES.has(a.name) || LOCKED_APPS.has(a.name))
        return fail(`"${a.name}" is a reserved/system name — not installable.`);
      const entry = readAppStoreApp(a.name);
      if (!entry) return fail(`No "${a.name}" in the App Store. app_store_list shows what's available.`);
      const cur = store.getApp(a.name);
      if (cur && cur.author !== "library")
        return fail(`"${a.name}" already exists in your registry as a ${cur.author}-authored app — NOT overwriting it with the App Store version. Delete or rename the existing one first if you want the App Store app.`);
      // BOTH slots decide "up to date" (a manifest-only store update must install), and both
      // travel on the write — an install is a whole-entry act, never a document-only one.
      const libManifest = entry.manifest ? JSON.stringify(entry.manifest) : null;
      if (cur && cur.ui === entry.ui && (cur.manifest ?? null) === libManifest)
        return { content: [{ type: "text", text: `"${a.name}" is already installed and up to date (v${cur.version}). Open it with open_app.` }], structuredContent: { name: a.name, version: cur.version, tier: tierOf("library"), updated: false } };
      // expected_version on updates: a concurrent write between the read above and this install
      // becomes a clean conflict instead of a silent clobber (the OCC bypass the W-N review flagged).
      const r = store.execute({
        type: "save_app", command_id: a.command_id || randomUUID(),
        name: a.name, ui: entry.ui, manifest: entry.manifest ?? null,
        description: entry.description || entry.title, actor: "library", host: hostName(),
        ...(cur ? { expected_version: cur.version } : {}),
      });
      if (!r.ok) return fail(failNote(r));
      registerApp(a.name);
      return {
        content: [{ type: "text", text: `Installed "${a.name}" v${r.version} from the App Store. Open it now with open_app {app: "${a.name}"}.` }],
        structuredContent: { name: a.name, version: r.version, tier: tierOf("library"), updated: !!cur },
      };
    },
  );

}
