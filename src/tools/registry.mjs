// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// tools/registry.mjs — registry lifecycle: version history, restore, render health, delete.
// Registered by engine.mjs. Moved here verbatim: the tool surface is byte-identical to before
// the split, which test/tool-surface.mjs proves against its golden file.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { RO, WRITE, WRITE_NOT_IDEMPOTENT, DESTRUCTIVE, RESERVED_COMPONENT_NAMES, LOCKED_COMPONENTS, tierOf, cmdArgs } from "../contracts.mjs";

export function register(ctx) {
  const { server, store, hostName, run, failNote, fail, registerComponent } = ctx;

  // ---------------------------------------------------- registry lifecycle (design-system §7.5)
  server.registerTool(
    "component_history",
    {
      title: "Component version history",
      annotations: RO,
      description: "List a component's saved versions as {version, ts, html_size} — metadata only, NEVER the html (keeps context small; use get_component for the current source). History survives delete_component (tombstone).",
      inputSchema: { name: z.string() },
      outputSchema: {
        name: z.string(),
        history: z.array(z.object({ version: z.number(), ts: z.string(), html_size: z.number() })),
      },
    },
    async (a) => {
      const history = store.componentHistory(a.name);
      if (!history.length) return fail(`No history for component "${a.name}".`);
      const text = `"${a.name}" — ${history.length} version(s):\n` +
        history.map((h) => `  v${h.version} · ${h.ts} · ${h.html_size} chars`).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { name: a.name, history } };
    },
  );

  // get_component_version RETIRED here (signed v0.3 break): reading a historical version's full
  // source was the one read that could never be windowed coherently (history is immutable, so a
  // model diffing it wants ranges of TWO documents — a job for a diff, not a raw dump), and its
  // whole-source reply was a mutilation hazard on the hosts that cut middles. restore_component
  // still reads history through the store; component_history still lists it.

  server.registerTool(
    "restore_component",
    {
      title: "Restore a component version",
      annotations: WRITE,
      description: "Roll a component back to one of its earlier versions: re-saves that version's HTML as a NEW current version (nothing is lost — history is preserved and you can roll forward again). Use when a newer edit broke the UI. Find the version number with component_history; after restoring, open_component to view it.",
      inputSchema: {
        name: z.string(),
        version: z.number().describe("the historical version to restore (see component_history)"),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
      },
    },
    async (a) => {
      if (LOCKED_COMPONENTS.has(a.name)) return fail(`"${a.name}" is a locked system component — it can't be restored or overwritten here.`);
      if (RESERVED_COMPONENT_NAMES.has(a.name)) return fail(`"${a.name}" is a reserved namespace — nothing restorable lives there.`);
      const old = store.getComponentVersion(a.name, a.version);
      if (!old) return fail(`No version ${a.version} for component "${a.name}". Use component_history to see which versions exist.`);
      const r = store.execute({
        type: "save_component", declaration_policy: "salvage", command_id: a.command_id || randomUUID(),
        name: a.name, html: old.html, description: "", actor: "agent", host: hostName(),
      });
      if (!r.ok) return fail(failNote(r));
      registerComponent(a.name);
      return { content: [{ type: "text", text: `Restored "${a.name}" from v${a.version} → saved as new v${r.version} (history preserved). Show it now with open_component {component: "${a.name}"}.` }] };
    },
  );

  // Render-health + AUTO-REVERT — the safety net that makes "the AI edits your UI" safe. The
  // widget loader reports an uncaught error during a component's initial mount; when the report
  // is about the CURRENT version and an earlier version exists, the engine restores that earlier
  // version automatically (as a NEW forward version — nothing is lost). Local tier only: runner
  // tiers serve fixed curated content, and the runner's cap allowlist doesn't route this tool.
  const autoRevertBudget = new Map(); // component → auto-reverts spent this server run (cap 3 — a broken chain must not loop forever)
  server.registerTool(
    "render_health",
    {
      title: "Report component render health (internal)",
      annotations: WRITE_NOT_IDEMPOTENT,  // no idempotency key, and a repeated failure report can revert again
      description: "Internal: the widget loader reports whether a component's html mounted cleanly. A failure report about the current version triggers an automatic rollback to the previous version (history preserved, max 3 per component per server run). Not normally called by the AI — use restore_component to roll back deliberately.",
      inputSchema: {
        component: z.string(),
        version: z.number().describe("the component version that was rendering"),
        ok: z.boolean(),
        error: z.string().optional().describe("the uncaught error message, when ok=false"),
      },
      outputSchema: {
        component: z.string(), ok: z.boolean(), reverted: z.boolean(),
        restored_version: z.number().optional().describe("the historical version whose html is now current again"),
        new_version: z.number().optional().describe("the new current version number after the revert"),
        note: z.string().optional(),
      },
    },
    async (a) => {
      const done = (reverted, note, extra = {}) => ({
        content: [{ type: "text", text: note }],
        structuredContent: { component: a.component, ok: !!a.ok, reverted, note, ...extra },
      });
      const comp = store.getComponent(a.component);
      if (!comp) return done(false, `No component "${a.component}" — nothing to do.`);
      // A healthy report does NOT reset the budget: the 3-per-server-run cap is a hard ceiling,
      // otherwise interleaved ok:true reports make it hollow (verified abusable — 8 reverts, 0 refused).
      if (a.ok) return done(false, "Healthy render noted.");
      if (a.version !== comp.version) return done(false, `Stale report (about v${a.version}, current is v${comp.version}) — ignored.`);
      if (LOCKED_COMPONENTS.has(a.component)) return done(false, "Locked system component — not auto-reverted.");
      if (tierOf(comp.author) !== "local") return done(false, "Non-local component — not auto-reverted (fixed curated content).");
      // The previous DIFFERENT document — not merely the previous version number. Version flips
      // that write no html (archive) and re-saves of identical html would otherwise make the
      // "revert" re-save the exact bytes that are failing (found by the C review).
      let old = null;
      for (const h of store.componentHistory(a.component)) {
        if (h.version >= comp.version) continue;
        const full = store.getComponentVersion(a.component, h.version);
        if (full && full.html !== comp.html) { old = full; break; }
      }
      if (!old) return done(false, "No earlier different version to revert to.");
      const prev = old;
      const spent = autoRevertBudget.get(a.component) || 0;
      if (spent >= 3) return done(false, "Auto-revert limit reached for this component (3 per server run) — fix it manually (component_history + restore_component).");
      const r = store.execute({
        type: "save_component", declaration_policy: "salvage", command_id: randomUUID(),
        name: a.component, html: old.html, description: "", actor: "agent", host: hostName(),
      });
      if (!r.ok) return done(false, `Auto-revert failed: ${failNote(r)}`);
      autoRevertBudget.set(a.component, spent + 1);
      registerComponent(a.component);
      return done(true,
        `"${a.component}" v${a.version} failed to render (${(a.error || "uncaught error").slice(0, 200)}) — automatically restored v${prev.version} as new v${r.version}. Reload shows the working version.`,
        { restored_version: prev.version, new_version: r.version });
    },
  );

  server.registerTool(
    "delete_component",
    {
      title: "Delete component",
      annotations: DESTRUCTIVE,
      description: "Remove a component from the registry permanently (confirm with the user first). Version history is RETAINED as a tombstone and its data collection / settings items are untouched. The component's ui:// registration may linger until server restart; open_component itself fails cleanly right away.",
      inputSchema: { ...cmdArgs, name: z.string() },
    },
    async (a) => {
      if (LOCKED_COMPONENTS.has(a.name)) return fail(`"${a.name}" is a locked system component — its UI ships with the engine and can't be deleted here.`);
      const r = run(a, "delete_component");
      if (!r.ok) return fail(r.error === "not_found" ? `No component "${a.name}" in the registry. list_components shows what exists.` : failNote(r));
      return { content: [{ type: "text", text: `Deleted "${a.name}"${r.idempotent ? " (already deleted)" : ""}. Version history retained; its data collection and settings items are untouched.` }] };
    },
  );

}
