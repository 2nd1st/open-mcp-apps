// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// tools/settings.mjs — the settings pane surface: prefs schema, permissions overview, and the privileged
// policy writer.
// Registered by engine.mjs. Moved here verbatim: the tool surface is byte-identical to before
// the split, which test/tool-surface.mjs proves against its golden file.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { SETTINGS_COLLECTION, RESERVED_KEY_RE } from "../store.mjs";
import { RO, WRITE, ackSchema, SHARED_PREFS, CAP_NAMES, coerceCap, capValueHelp } from "../contracts.mjs";
import { latestPref } from "../runtime-core.mjs";

export function register(ctx) {
  const { server, store, hostName, failNote, fail, toAck } = ctx;

  // ------------------------------------------------------ prefs schema (settings pane, P4)
  server.registerTool(
    "ui_prefs_schema",
    {
      title: "Shared preference catalog",
      annotations: RO,
      description: "The engine-owned catalog of SHARED preferences (key, type, label, default, options) that the settings app renders. Apps read effective values via oma.pref(); this tool only describes what exists. Read-only.",
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

  // app_permissions retired 2026-08-04 (elegance review A13): its per-app rows were a projection
  // of what app_html already returns (author, tier, caps — and now locked), to a single caller
  // that fetches app_html for every app anyway. The settings pane assembles the same view from
  // list_apps (locked rides each row) + its app_html cache.

  // -------------------------------------------------------------- privileged policy writer
  // The ONLY path that can write reserved security:*/policy:* keys. Privilege travels
  // out-of-band (store.executePrivileged), NEVER as a command field — so a prompt-injected
  // data_* call carrying {privileged:true} still hits the guard. Intended for the settings-app
  // Permissions UI; per-app capability policy is enforced at the RUNNER (this only keeps
  // the policy store itself tamper-evident — see docs/security-model.md §4).
  server.registerTool(
    "security_set",
    {
      title: "Set a security policy key",
      annotations: WRITE,
      description: "Privileged writer for reserved settings keys (security:* / policy:*) — the ONLY tool that can write them; the generic data_* tools refuse reserved keys. Upserts one key/value in the settings collection.",
      inputSchema: {
        key: z.string().describe("a reserved key, e.g. security:kanban:send_message (cap suffixes are snake_case — the caps field names)"),
        value: z.string().describe("the policy value: allow | deny (true/false too); delete_items also takes confirm; call_tools takes \"*\", a JSON array or a comma-separated tool list. An unknown value is REFUSED, never stored"),
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
      // Value validation — a WARNING would not have been enough here. An unrecognized value made
      // computeCaps fall back to the TIER DEFAULT, and local's preset is everything ALLOWED: a
      // policy typed `ask` did not fail to apply, it left the app at the WIDEST setting while the
      // receipt read "Set …". Refuse, and say what the vocabulary is (coerceCap owns the ruling).
      if (capSeg && CAP_NAMES.includes(capSeg) && coerceCap(capSeg, a.value) === undefined)
        return fail(`"${a.value}" is not a value the engine reads for "${capSeg}" — NOTHING was written (an unreadable value would have left the app at its tier default, which for a local app is fully allowed). Valid: ${capValueHelp(capSeg)}.`);
      const cid = a.command_id || randomUUID();
      // The row the READERS will read (computeCaps takes the last one) — updating any other
      // makes a policy that reports itself set and never takes effect.
      const existing = latestPref(store.snapshot(SETTINGS_COLLECTION).items, key);
      const r = existing
        ? store.executePrivileged({ type: "update_item", command_id: cid, id: existing.id, fields: { value: a.value }, actor: "human", host: hostName() })
        : store.executePrivileged({ type: "add_item", command_id: cid, collection: SETTINGS_COLLECTION, fields: { key, value: a.value }, actor: "human", host: hostName() });
      return r.ok ? toAck(r, `Set ${key}.` + warn) : fail(failNote(r));
    },
  );
}
