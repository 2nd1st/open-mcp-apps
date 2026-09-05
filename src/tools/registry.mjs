// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// tools/registry.mjs — registry lifecycle: version history, restore, render health, delete.
// Registered by engine.mjs. Moved here verbatim: the tool surface is byte-identical to before
// the split, which test/tool-surface.mjs proves against its golden file.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { RO, WRITE, DESTRUCTIVE, RESERVED_APP_NAMES, LOCKED_APPS, cmdArgs, answer, toMcp } from "../contracts.mjs";

export function register(ctx) {
  const { server, store, hostName, run, failNote, fail, registerApp } = ctx;

  // ---------------------------------------------------- registry lifecycle (design-system §7.5)
  server.registerTool(
    "list_app_checkpoints",
    {
      title: "App history (checkpoints)",
      annotations: RO,
      description: "List an app's checkpoints as {checkpoint, ts, ui_size} — metadata only, NEVER the source (keeps context small; use get_app for the current source). Checkpoint 1 is the oldest; restore_app takes that number. History survives delete_app (tombstone). Each checkpoint snapshots BOTH slots (ui + manifest); restore brings back the pair.",
      inputSchema: { name: z.string() },
      outputSchema: {
        name: z.string(),
        history: z.array(z.object({ checkpoint: z.number(), ts: z.string(), ui_size: z.number() })),
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
        history.map((h) => `  checkpoint ${h.checkpoint} · ${h.ts} · ${h.ui_size} chars`).join("\n");
      // The seq does not travel on this read at all. It was only ever here so the UI could pick a
      // restore target, and the verb takes a checkpoint now — leaving it in would mean the number
      // we just took off the screen still arrives in the model's context, ready to be recited.
      return { content: [{ type: "text", text }],
        structuredContent: { name: a.name, history: history.map((h) => ({ checkpoint: h.checkpoint, ts: h.ts, ui_size: h.ui_size })) } };
    },
  );

  // get_app_version RETIRED here (signed v0.3 break): reading a historical version's full
  // source was the one read that could never be windowed coherently (history is immutable, so a
  // model diffing it wants ranges of TWO documents — a job for a diff, not a raw dump), and its
  // whole-source reply was a mutilation hazard on the hosts that cut middles. restore_app
  // still reads history through the store; list_app_checkpoints still lists it.

  server.registerTool(
    "restore_app",
    {
      title: "Restore an app version",
      annotations: WRITE,
      description: "Roll an app back to one of its earlier checkpoints: re-saves that checkpoint's HTML as a NEW current one (nothing is lost — history is preserved and you can roll forward again). Use when a newer edit broke the UI. Get the checkpoint number from list_app_checkpoints; after restoring, open_app to view it.",
      inputSchema: {
        name: z.string(),
        // Checkpoints, not versions, because `version` is the global ledger seq and this is the one
        // verb a PERSON drives ("go back to before you broke it"). Speaking versions here would put
        // the seq back on screen through the only door the narrative had left open.
        checkpoint: z.number().describe("which checkpoint to restore, 1 = the oldest (see list_app_checkpoints)"),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted"),
      },
    },
    async (a) => {
      if (LOCKED_APPS.has(a.name)) return fail(`"${a.name}" is a locked system app — it can't be restored or overwritten here.`);
      if (RESERVED_APP_NAMES.has(a.name)) return fail(`"${a.name}" is a reserved namespace — nothing restorable lives there.`);
      // Replay first, same rule as save_app / edit_app / promote_app: the store makes the retry a
      // no-op, but without this the receipt still read "Restored … saved as a new checkpoint" —
      // a rollback the user believes happened twice. A retry deserves a receipt, not a lie.
      if (a.command_id) {
        const prior = store.priorReceipt(a.command_id);
        if (prior) {
          if (prior.event_type !== "component_saved" || prior.aggregate_id !== a.name)
            return fail(failNote({ error: "command_id_reused" }));
          return { content: [{ type: "text", text: `Already restored — "${a.name}" was rolled back to checkpoint ${a.checkpoint} under this same command_id (v${prior.seq}). Nothing happened this time and NO new checkpoint was made. Show it with open_app {app: "${a.name}"}.` }] };
        }
      }
      const hist = store.appHistory(a.name);
      const target = hist.find((h) => h.checkpoint === a.checkpoint);
      if (!target) return fail(`No checkpoint ${a.checkpoint} for "${a.name}" — it has ${hist.length}. list_app_checkpoints lists them.`);
      const old = store.getAppVersion(a.name, target.version);
      if (!old) return fail(`Checkpoint ${a.checkpoint} of "${a.name}" has no stored source.`);
      // BOTH slots travel: a checkpoint is a coherent (ui, manifest) pair, and restoring one
      // without the other would manufacture a state that never existed. expected_version rides
      // along so a concurrent save between the read above and this write is a clean conflict
      // (the OCC bypass the W-N review flagged — closed here).
      const cur = store.getApp(a.name);
      const r = store.execute({
        type: "save_app", command_id: a.command_id || randomUUID(),
        name: a.name, ui: old.ui, manifest: old.manifest ? JSON.parse(old.manifest) : null,
        description: "", actor: "agent", host: hostName(),
        ...(cur ? { expected_version: cur.version } : {}),
      });
      if (!r.ok) return fail(failNote(r));
      // The store arbitrates too (a replay that raced past the pre-check above lands here): say
      // what a retry needs and stop, rather than reciting a rollback that did not happen.
      if (r.idempotent)
        return { content: [{ type: "text", text: `Already restored — "${a.name}" was rolled back to checkpoint ${a.checkpoint} under this same command_id (v${r.version}). Nothing happened this time and NO new checkpoint was made. Show it with open_app {app: "${a.name}"}.` }] };
      registerApp(a.name);
      return { content: [{ type: "text", text: `Restored "${a.name}" from checkpoint ${a.checkpoint} → saved as a new checkpoint (history preserved). Show it now with open_app {app: "${a.name}"}.` }] };
    },
  );

  // render_health + auto-revert retired 2026-08-04 (elegance B3, Leo: not needed). The seat's
  // only server action was the automatic rollback, which never fired outside tests; a broken
  // mount now surfaces as a user-facing notice in the runtime naming the explicit recovery path
  // (list_app_checkpoints → restore_app). Deliberate rollback was always restore_app and still is.

  server.registerTool(
    "delete_app",
    {
      title: "Delete app",
      annotations: DESTRUCTIVE,
      description: "Delete an app from the registry. Default data:\"keep\" is a tombstone: its data, files and history are KEPT and restore_app can bring the app back. data:\"cascade\" ALSO permanently deletes the data provably only this app used (plus its settings) — it always returns a disposition plan first: read the plan to the user (what will be deleted AND what will be kept and why), then re-send the same call with request_state. Cascade is NOT undoable. Shared or unprovable collections are always kept.",
      inputSchema: { ...cmdArgs, name: z.string(),
        data: z.enum(["keep", "cascade"]).optional().describe("\"keep\" (default): tombstone, data survives. \"cascade\": delete the app AND the data only it used — two-step confirmed, permanent"),
        request_state: z.string().optional().describe("the state from a prior confirmation_required answer — re-send the identical call with it attached") },
    },
    // Cascade returned in W1 (it retired 2026-08-04, elegance B1 — the bespoke plan_token
    // protocol went with it, permanently). The confirmation now rides the W-S request_state
    // two-step: the store recomputes the disposition in its own transaction, binds the demand to
    // the world the user was shown (any interleaved write invalidates the answer), and the
    // server never guesses which user data to erase — shared/unknown collections are kept.
    async (a) => {
      if (LOCKED_APPS.has(a.name)) return fail(`"${a.name}" is a locked system app — its UI ships with the engine and can't be deleted here.`);
      const r = run(a, "delete_app");
      // Not isError, same doctrine as delete_item: the demand IS the useful payload — a host
      // that discards errored results would strand the confirmation flow on its first leg.
      if (r.confirmation_required) {
        const kept = (r.plan || []).filter((c) => c.verdict !== "exclusive");
        const note = `Confirmation required — deleting ${r.preview}. This is permanent (no undo). ` +
          (kept.length ? `KEPT: ${kept.map((c) => `${c.collection} (${c.why})`).join("; ")}. ` : "") +
          `Read the plan to the user, then re-send the same call with request_state (expires ${r.expires_at}).`;
        return toMcp(answer.ack({ ok: false, reason: "confirmation_required", name: a.name,
          request_state: r.request_state, expires_at: r.expires_at, preview: r.preview,
          plan: r.plan, settings_keys: r.settings_keys, note }, note));
      }
      if (!r.ok) return fail(r.error === "not_found" ? `No app "${a.name}" in the registry. list_apps shows what exists.`
        : r.error === "confirmation_invalid" ? `The confirmation no longer matches the world it was issued for (something wrote in between, or the state is stale). Re-send WITHOUT request_state to get a fresh plan.`
        : r.error === "confirmation_expired" ? "The confirmation expired. Re-send WITHOUT request_state to get a fresh plan."
        : failNote(r));
      const took = r.cascaded
        ? ` Cascade removed ${r.cascaded.map((c) => `${c.collection} (${c.rows} rows)`).join(", ") || "no collections"} and ${r.settings_keys} setting(s); anything shared or unprovable was kept.`
        : " Its data and settings were KEPT — remove rows directly with the data_* tools if they should go too.";
      return toMcp(answer.ack({ ok: true, name: a.name, deleted: true,
        ...(r.cascaded ? { cascaded: r.cascaded, settings_keys: r.settings_keys } : {}) },
        `Deleted "${a.name}"${r.idempotent ? " (already deleted)" : ""}.` + took));
    },
  );

}
