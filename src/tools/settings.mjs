// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// tools/settings.mjs — the settings pane surface: prefs schema, permissions overview, and the privileged
// policy writer.
// Registered by engine.mjs. Moved here verbatim: the tool surface is byte-identical to before
// the split, which test/tool-surface.mjs proves against its golden file.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { SETTINGS_COLLECTION, RESERVED_KEY_RE } from "../store.mjs";
import { RO, WRITE, snapshotSchema, ackSchema, capsShape, SHARED_PREFS, LOCKED_COMPONENTS, tierOf, CAP_NAMES } from "../contracts.mjs";

export function register(ctx) {
  const { server, store, hostName, failNote, fail, computeCaps, toAck } = ctx;

  // ------------------------------------------------------ prefs schema (settings pane, P4)
  server.registerTool(
    "ui_prefs_schema",
    {
      title: "Shared preference catalog",
      annotations: RO,
      description: "The engine-owned catalog of SHARED preferences (key, type, label, default, options) that the settings app renders. Components read effective values via oma.pref(); this tool only describes what exists. Read-only.",
      inputSchema: {},
      outputSchema: {
        shared: z.array(z.object({
          key: z.string(), type: z.enum(["string", "number", "boolean", "enum"]),
          label: z.string(), desc: z.string(),
          default: z.union([z.string(), z.number(), z.boolean()]),
          options: z.array(z.union([z.string(), z.object({ value: z.string(), label: z.string() })])).optional(),
          maxlength: z.number().optional(), min: z.number().optional(), max: z.number().optional(), step: z.number().optional(),
        })),
      },
    },
    async () => ({
      content: [{ type: "text", text: `Shared preference catalog: ${SHARED_PREFS.map((p) => p.key).join(", ")}.` }],
      structuredContent: { shared: SHARED_PREFS },
    }),
  );

  // ------------------------------------------------------ permissions overview (settings pane)
  server.registerTool(
    "component_permissions",
    {
      title: "Component permissions overview",
      annotations: RO,
      description: "For every component: its author, trust tier, whether it's a locked system component, and the effective capability grants (including file_read/file_write). This is what the settings Permissions pane renders. Read-only; capability OVERRIDES are written with security_set.",
      inputSchema: {},
      outputSchema: {
        components: z.array(z.object({
          name: z.string(), author: z.string(),
          tier: z.enum(["local", "library-reviewed", "unreviewed"]),
          locked: z.boolean(), caps: capsShape,
        })),
      },
    },
    async () => {
      const components = store.listComponents().map((c) => {
        const tier = tierOf(c.author);
        return { name: c.name, author: c.author, tier, locked: LOCKED_COMPONENTS.has(c.name), caps: computeCaps(c.name, tier) };
      });
      const text = components.length
        ? "Component permissions:\n" + components.map((c) =>
            `  - ${c.name} · tier ${c.tier} (by ${c.author})${c.locked ? " · LOCKED" : ""} · files ${c.caps.file_read ? "r" : "-"}${c.caps.file_write ? "w" : "-"} · sendMessage ${c.caps.send_message ? "on" : "off"}`).join("\n")
        : "No components installed.";
      return { content: [{ type: "text", text }], structuredContent: { components } };
    },
  );

  // -------------------------------------------------------------- privileged policy writer
  // The ONLY path that can write reserved security:*/policy:* keys. Privilege travels
  // out-of-band (store.executePrivileged), NEVER as a command field — so a prompt-injected
  // data_* call carrying {privileged:true} still hits the guard. Intended for the settings-app
  // Permissions UI; per-component capability policy is enforced at the RUNNER (this only keeps
  // the policy store itself tamper-evident — see docs/security-model.md §4).
  server.registerTool(
    "security_set",
    {
      title: "Set a security policy key",
      annotations: WRITE,
      description: "Privileged writer for reserved settings keys (security:* / policy:*) — the ONLY tool that can write them; the generic data_* tools refuse reserved keys. Upserts one key/value in the settings collection.",
      inputSchema: {
        key: z.string().describe("a reserved key, e.g. security:kanban:send_message (cap suffixes are snake_case — the caps field names)"),
        value: z.string().describe("the policy value, e.g. allow | ask | deny | confirm"),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
      },
      outputSchema: ackSchema,
    },
    async (a) => {
      const key = String(a.key || "");
      if (!RESERVED_KEY_RE.test(key)) return fail(`security_set only writes reserved keys (security:* / policy:*). Use data_* for "${key}".`);
      // Cap-segment validation (naming contract): computeCaps only ever reads the snake_case
      // CAP_NAMES suffixes. An unknown suffix — e.g. dotted "sendMessage" — is still stored
      // (reserved namespace, forward-compat) but flagged, so a typo'd policy is VISIBLY
      // ineffective instead of silently believed.
      const capSeg = (key.match(/^security:[^:]+:(.+)$/) || key.match(/^policy:defaults:[^:]+:(.+)$/))?.[1];
      const warn = capSeg && !CAP_NAMES.includes(capSeg)
        ? `\n⚠ "${capSeg}" is not a capability the engine reads — the key is stored but has NO effect. Valid caps (snake_case): ${CAP_NAMES.join(", ")}.`
        : "";
      const cid = a.command_id || randomUUID();
      const existing = store.snapshot(SETTINGS_COLLECTION).items.find((i) => i.fields.key === key);
      const r = existing
        ? store.executePrivileged({ type: "update_item", command_id: cid, id: existing.id, fields: { value: a.value }, actor: "human", host: hostName() })
        : store.executePrivileged({ type: "add_item", command_id: cid, collection: SETTINGS_COLLECTION, fields: { key, value: a.value }, actor: "human", host: hostName() });
      return r.ok ? toAck(r, `Set ${key}.` + warn) : fail(failNote(r));
    },
  );
}
