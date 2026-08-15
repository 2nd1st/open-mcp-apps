// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// tool-policy.mjs — the SINGLE source of truth for "control-plane" tools: the ones a
// rendered or previewed app (ANY tier, incl. local) may NEVER reach via callTool.
// They mutate the app registry (save / delete / restore / install_from_app_store) or the
// security policy (security_set). A child that could call them would rewrite policy or
// overwrite/delete apps.
//
// Enforced at BOTH chokepoints from this one list: the runner guard for sandboxed children
// (src/runner.mjs makeGuard) and the direct runtime's generic door (src/shell-runtime.js
// callTool) — nobody hand-maintains a second copy, so the set can never drift.
// The `app_store_*` prefix reserves the future SaaS app-publishing namespace up front.
export const CONTROL_PLANE_TOOLS = [
  "security_set",
  "save_app",
  "edit_app",      // same wall as save: a child that can edit source can rewrite any app
  "archive_app",   // seat retired 2026-08-04, name still reserved: the store command exists and the seat returns with a settings entry
  "delete_app",
  "restore_app",
  "install_from_app_store",
];
// render_health left the list 2026-08-04 with its seat AND its store action (elegance B3):
// unlike archive_app there is nothing behind the name any more.
// call_function is deliberately NOT here: it is a data-plane verb (a widget calling its own
// app's function is a designed path). Its caller-binding lands with the function pillar's
// runner wiring; until that flag exists the engine-side seat refuses every call anyway.

// The same-policy-two-runtimes sets (W4 consolidation). Both runtimes stamp a widget's
// destructive/write calls as the human acts they are, and both refuse data_batch — but each
// had grown its own copy of the SET and the sentence, and the sets had already diverged once
// (file_delete missed the direct runtime's list when the file plane learned to demand). The
// policy now lives here; the runtimes import membership and message, never restate them.
export const DATA_WRITE_TOOLS = ["data_add_item", "data_update_item", "data_move_item", "data_delete_item"];
/** Tools whose widget-originated calls are stamped actor:"human" (+ command_id + via) at the
 *  generic door, so the engine's confirmation gate and the ledger's provenance see who acted. */
export const STAMPED_TOOLS = [...DATA_WRITE_TOOLS, "file_delete"];
/** Why a widget cannot have data_batch, in the words both runtimes refuse with: a batch is
 *  all-or-nothing, so one confirmation demand inside it fails the whole call — per-row demands
 *  need per-row calls. */
export const DATA_BATCH_REFUSAL = "data_batch is not available to apps — delete or write one row at a time (oma.deleteItem / oma.addItem), so each destructive row can be confirmed on its own.";

/** True if `name` is a control-plane tool no app may call. Normalizes (trim+lowercase)
 *  so a padded or re-cased variant can't slip past, and matches the reserved `app_store_*`.
 *  `_`-prefixed names are internal RPC methods (undo, the Data pane's ledger view — served by
 *  the /rpc transport only, never registered as MCP tools): a sandboxed child must not reach
 *  them through a passthrough either, so they are control-plane by prefix. */
export function isControlPlaneTool(name) {
  const t = String(name == null ? "" : name).trim().toLowerCase();
  return CONTROL_PLANE_TOOLS.indexOf(t) !== -1 || t.indexOf("app_store_") === 0 || t.indexOf("_") === 0;
}
