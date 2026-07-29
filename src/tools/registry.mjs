// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// tools/registry.mjs — registry lifecycle: version history, restore, render health, delete.
// Registered by engine.mjs. Moved here verbatim: the tool surface is byte-identical to before
// the split, which test/tool-surface.mjs proves against its golden file.

import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { RO, WRITE, WRITE_NOT_IDEMPOTENT, DESTRUCTIVE, RESERVED_APP_NAMES, LOCKED_APPS, tierOf, cmdArgs, answer, toMcp } from "../contracts.mjs";

export function register(ctx) {
  const { server, store, hostName, run, failNote, fail, registerApp } = ctx;

  // ---------------------------------------------------- registry lifecycle (design-system §7.5)
  server.registerTool(
    "app_history",
    {
      title: "App history (checkpoints)",
      annotations: RO,
      description: "List an app's checkpoints as {checkpoint, ts, html_size} — metadata only, NEVER the html (keeps context small; use get_app for the current source). Checkpoint 1 is the oldest; restore_app takes that number. History survives delete_app (tombstone).",
      inputSchema: { name: z.string() },
      outputSchema: {
        name: z.string(),
        history: z.array(z.object({ checkpoint: z.number(), ts: z.string(), html_size: z.number() })),
      },
    },
    async (a) => {
      const history = store.appHistory(a.name);
      if (!history.length) return fail(`No history for app "${a.name}".`);
      // Checkpoints, not raw versions: `version` is the global ledger seq, so reciting it makes a
      // user who edited twice wonder why their app jumped from 5 to 43 (nothing happened to it —
      // those 38 were their groceries). The seq is not merely demoted here, it is GONE from this
      // sentence, because restore_app now speaks checkpoints too and nothing downstream
      // needs the number read aloud. structuredContent still carries `version` for machinery.
      const text = `"${a.name}" — ${history.length} checkpoint(s), newest first:\n` +
        history.map((h) => `  checkpoint ${h.checkpoint} · ${h.ts} · ${h.html_size} chars`).join("\n");
      // The seq does not travel on this read at all. It was only ever here so the UI could pick a
      // restore target, and the verb takes a checkpoint now — leaving it in would mean the number
      // we just took off the screen still arrives in the model's context, ready to be recited.
      return { content: [{ type: "text", text }],
        structuredContent: { name: a.name, history: history.map((h) => ({ checkpoint: h.checkpoint, ts: h.ts, html_size: h.html_size })) } };
    },
  );

  // get_app_version RETIRED here (signed v0.3 break): reading a historical version's full
  // source was the one read that could never be windowed coherently (history is immutable, so a
  // model diffing it wants ranges of TWO documents — a job for a diff, not a raw dump), and its
  // whole-source reply was a mutilation hazard on the hosts that cut middles. restore_app
  // still reads history through the store; app_history still lists it.

  server.registerTool(
    "restore_app",
    {
      title: "Restore an app version",
      annotations: WRITE,
      description: "Roll an app back to one of its earlier checkpoints: re-saves that checkpoint's HTML as a NEW current one (nothing is lost — history is preserved and you can roll forward again). Use when a newer edit broke the UI. Get the checkpoint number from app_history; after restoring, open_app to view it.",
      inputSchema: {
        name: z.string(),
        // Checkpoints, not versions, because `version` is the global ledger seq and this is the one
        // verb a PERSON drives ("go back to before you broke it"). Speaking versions here would put
        // the seq back on screen through the only door the narrative had left open.
        checkpoint: z.number().describe("which checkpoint to restore, 1 = the oldest (see app_history)"),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
      },
    },
    async (a) => {
      if (LOCKED_APPS.has(a.name)) return fail(`"${a.name}" is a locked system app — it can't be restored or overwritten here.`);
      if (RESERVED_APP_NAMES.has(a.name)) return fail(`"${a.name}" is a reserved namespace — nothing restorable lives there.`);
      const hist = store.appHistory(a.name);
      const target = hist.find((h) => h.checkpoint === a.checkpoint);
      if (!target) return fail(`No checkpoint ${a.checkpoint} for "${a.name}" — it has ${hist.length}. app_history lists them.`);
      const old = store.getAppVersion(a.name, target.version);
      if (!old) return fail(`Checkpoint ${a.checkpoint} of "${a.name}" has no stored source.`);
      const r = store.execute({
        type: "save_app", declaration_policy: "salvage", command_id: a.command_id || randomUUID(),
        name: a.name, html: old.html, description: "", actor: "agent", host: hostName(),
      });
      if (!r.ok) return fail(failNote(r));
      registerApp(a.name);
      return { content: [{ type: "text", text: `Restored "${a.name}" from checkpoint ${a.checkpoint} → saved as a new checkpoint (history preserved). Show it now with open_app {app: "${a.name}"}.` }] };
    },
  );

  // Render-health + AUTO-REVERT — the safety net that makes "the AI edits your UI" safe. The
  // widget loader reports an uncaught error during an app's initial mount; when the report
  // is about the CURRENT version and an earlier version exists, the engine restores that earlier
  // version automatically (as a NEW forward version — nothing is lost). Local tier only: runner
  // tiers serve fixed curated content, and the runner's cap allowlist doesn't route this tool.
  const autoRevertBudget = new Map(); // app → auto-reverts spent this server run (cap 3 — a broken chain must not loop forever)
  server.registerTool(
    "render_health",
    {
      title: "Report app render health (internal)",
      annotations: WRITE_NOT_IDEMPOTENT,  // no idempotency key, and a repeated failure report can revert again
      description: "Internal: the widget loader reports whether an app's html mounted cleanly. A failure report about the current version triggers an automatic rollback to the previous version (history preserved, max 3 per app per server run). Not normally called by the AI — use restore_app to roll back deliberately.",
      inputSchema: {
        app: z.string(),
        version: z.number().describe("the app version that was rendering"),
        ok: z.boolean(),
        error: z.string().optional().describe("the uncaught error message, when ok=false"),
      },
      outputSchema: {
        app: z.string(), ok: z.boolean(), reverted: z.boolean(),
        restored_version: z.number().optional().describe("the historical version whose html is now current again"),
        new_version: z.number().optional().describe("the new current version number after the revert"),
        note: z.string().optional(),
      },
    },
    async (a) => {
      const done = (reverted, note, extra = {}) => ({
        content: [{ type: "text", text: note }],
        structuredContent: { app: a.app, ok: !!a.ok, reverted, note, ...extra },
      });
      const comp = store.getApp(a.app);
      if (!comp) return done(false, `No app "${a.app}" — nothing to do.`);
      // A healthy report does NOT reset the budget: the 3-per-server-run cap is a hard ceiling,
      // otherwise interleaved ok:true reports make it hollow (verified abusable — 8 reverts, 0 refused).
      if (a.ok) return done(false, "Healthy render noted.");
      if (a.version !== comp.version) return done(false, `Stale report (about v${a.version}, current is v${comp.version}) — ignored.`);
      if (LOCKED_APPS.has(a.app)) return done(false, "Locked system app — not auto-reverted.");
      if (tierOf(comp.author) !== "local") return done(false, "Non-local app — not auto-reverted (fixed curated content).");
      // The previous DIFFERENT document — not merely the previous version number. Version flips
      // that write no html (archive) and re-saves of identical html would otherwise make the
      // "revert" re-save the exact bytes that are failing (found by the C review).
      let old = null;
      for (const h of store.appHistory(a.app)) {
        if (h.version >= comp.version) continue;
        const full = store.getAppVersion(a.app, h.version);
        if (full && full.html !== comp.html) { old = full; break; }
      }
      if (!old) return done(false, "No earlier different version to revert to.");
      const prev = old;
      const spent = autoRevertBudget.get(a.app) || 0;
      if (spent >= 3) return done(false, "Auto-revert limit reached for this app (3 per server run) — fix it manually (app_history + restore_app).");
      const r = store.execute({
        type: "save_app", declaration_policy: "salvage", command_id: randomUUID(),
        name: a.app, html: old.html, description: "", actor: "agent", host: hostName(),
      });
      if (!r.ok) return done(false, `Auto-revert failed: ${failNote(r)}`);
      autoRevertBudget.set(a.app, spent + 1);
      registerApp(a.app);
      return done(true,
        `"${a.app}" v${a.version} failed to render (${(a.error || "uncaught error").slice(0, 200)}) — automatically restored v${prev.version} as new v${r.version}. Reload shows the working version.`,
        { restored_version: prev.version, new_version: r.version });
    },
  );

  server.registerTool(
    "delete_app",
    {
      title: "Delete app",
      annotations: DESTRUCTIVE,
      description: "Delete an app. data:\"keep\" (default) removes only the app; data:\"cascade\" ALSO deletes the data only this app was using — permanently, with no undo. Cascade is two steps: call it once to get a plan (what would be deleted, what would be kept and why), show the user, then call again with that plan_token. Collections another app also uses are NEVER deleted. To keep everything and just clear the shelf, use archive_app instead.",
      // No outputSchema on purpose. The answer is a PLAN — a list of collections with a verdict and
      // a sentence of evidence each — and declaring that shape costs ~1.9 KB resident in every
      // conversation for a tool most conversations never call. The facts the model must act on
      // still travel in structuredContent (D-4), and the plan_token is quoted in the text too, so
      // a host that forwards only one channel can still complete the two-step.
      inputSchema: { ...cmdArgs, name: z.string(),
        data: z.enum(["keep", "cascade"]).optional().describe("cascade also deletes the data only this app used (permanent)"),
        plan_token: z.string().optional().describe("from the plan you showed the user — required to cascade"),
      },
    },
    async (a) => {
      if (LOCKED_APPS.has(a.name)) return fail(`"${a.name}" is a locked system app — its UI ships with the engine and can't be deleted here.`);
      if (a.data !== "cascade") {
        const r = run(a, "delete_app");
        if (!r.ok) return fail(r.error === "not_found" ? `No app "${a.name}" in the registry. list_apps shows what exists.` : failNote(r));
        return toMcp(answer.ack({ ok: true, name: a.name, deleted: true },
          `Deleted "${a.name}"${r.idempotent ? " (already deleted)" : ""}. Its data and settings were KEPT — the app is gone, so removing that data now means deleting the collection's rows directly (data_list to see them). Deleting WITH the data is a choice made at delete time: data:"cascade".`));
      }
      if (!store.getApp(a.name)) {
        // Gone, but the caller is holding a plan token — that is what a RETRY looks like after a
        // response was lost, and this precheck used to answer "No app" to it, so a caller
        // could not tell a completed irreversible delete from a failed one. The store already
        // knows: command_id is its idempotency key. Ask it instead of pre-empting it.
        if (a.plan_token) {
          const replay = run({ ...a, cascade: true, cascade_collections: [] }, "delete_app");
          // …and it has to be THIS act it is confirming. `ok` alone only says the command_id ran;
          // delete has two dispositions and one of them keeps every row, so a command_id first used
          // for a KEEP delete answered yes here and the caller was told its cascade had completed
          // while the data sat untouched. A false "your irreversible thing is done" is worse than
          // the error it replaced, so the receipt now has to name the cascade.
          if (replay.ok && replay.cascaded) return toMcp(answer.ack(
            { ok: true, name: a.name, deleted: true, note: "already applied", removed: replay.cascaded.collections || [] },
            `"${a.name}" was already deleted by this same request — nothing further to do.`));
          if (replay.ok) return fail(
            `"${a.name}" was already deleted by this command_id, but as a KEEP delete — its data was not touched. ` +
            `The app is gone, so cascade is no longer possible: remove the rows directly with the data_* tools if that is what you want.`);
        }
        return fail(`No app "${a.name}" in the registry. list_apps shows what exists.`);
      }

      // The plan IS the token: hashing it makes confirmation mean "the world still looks like what
      // the user was shown". No server-side token table — hosted runs an engine per request, so any
      // remembered token would be forgotten between the two calls of a two-step confirm.
      const plan = store.deleteDisposition(a.name);
      // `plan.collections` now carries each collection's ledger seq, so hashing the plan whole pins
      // the ROWS and not merely how many there were — swapping every row while keeping the count
      // used to leave this token valid. settings_seq does the same for the settings half. Nothing
      // here is declared in a schema: the plan travels in structuredContent (this tool has no
      // outputSchema, deliberately), so pinning it costs zero bytes on the resident tool surface.
      const token = createHash("sha256")
        .update(JSON.stringify([a.name, plan.collections, plan.settings_keys, plan.settings_seq]))
        .digest("hex").slice(0, 16);
      const kept = plan.collections.filter((c) => c.verdict !== "exclusive").map((c) => c.collection);
      const doomed = plan.collections.filter((c) => c.verdict === "exclusive");
      const rows = doomed.reduce((n, c) => n + c.rows, 0);
      const summary = [
        doomed.length ? `Deletes ${rows} row(s) in ${doomed.map((c) => `"${c.collection}"`).join(", ")}` : "Deletes no data rows",
        plan.settings_keys ? `${plan.settings_keys} of its settings` : null,
        kept.length ? `KEEPS ${kept.map((c) => `"${c}"`).join(", ")} (used by other apps, or ownership unproven)` : null,
      ].filter(Boolean).join("; ");

      if (a.plan_token !== token) {
        return toMcp(answer.ack(
          { ok: false, name: a.name, deleted: false, plan_token: token, collections: plan.collections, settings_keys: plan.settings_keys, kept,
            reason: a.plan_token ? "plan_changed" : "plan_required" },
          `${a.plan_token ? "The data changed since that plan, so it is void. Here is the current one" : "Nothing deleted yet"} — show the user, then call again with plan_token "${token}". ${summary}. This CANNOT be undone; archive_app keeps everything instead.`));
      }
      const r = run({ ...a, cascade: true, cascade_collections: plan.exclusive }, "delete_app");
      if (!r.ok) return fail(failNote(r));
      return toMcp(answer.ack(
        { ok: true, name: a.name, deleted: true, removed: r.cascaded || [], settings_keys: r.settings_keys || 0, kept },
        `Deleted "${a.name}" and its data: ${rows} row(s)${r.settings_keys ? ` plus ${r.settings_keys} settings` : ""}. ${kept.length ? `Kept ${kept.map((c) => `"${c}"`).join(", ")} — other apps use those.` : "Nothing else was using its collections."} This is permanent.`));
    },
  );

}
