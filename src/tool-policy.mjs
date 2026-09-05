// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// tool-policy.mjs — the SINGLE source of truth for "control-plane" tools: the ones an EMBEDDED
// app may NEVER reach via callTool. They mutate the app registry (save / delete / restore /
// install_from_app_store) or the security policy (security_set). A child that could call them
// would rewrite policy or overwrite/delete the apps around it — including its own parent.
//
// THIS IS ONE OF TWO GATES, AND THEY ASK DIFFERENT QUESTIONS. This list is the nesting gate:
// what a child running behind the runner may reach through its parent. The other is
// `WIDGET_CALLABLE` in src/engine.mjs, the host gate: what a TOP-LEVEL widget may call back
// through the host that rendered it (OpenAI's hosts default-DENY, so it is a declaration on the
// wire). A name on both lists is therefore not a contradiction and not a bug — it says "the
// system app we ship may do this at the top level, and no nested child may". Three App Store
// seats are exactly that (`app_store_list`, `preview_app_store_entry`, `install_from_app_store`);
// test/tool-surface.mjs pins the overlap to those three so it cannot grow unnoticed.
//
// Enforced at ONE chokepoint: the runner guard for sandboxed children (src/runner.mjs
// makeGuard). The direct runtime's generic door (src/shell-runtime.js callTool) does NOT consult
// this list, and the sentence that used to claim it did was simply false — measured 2026-09-05 in
// the built widget bundle (dist/shell.js): `isControlPlaneTool` survives minification with exactly
// one call site, inside the runner guard. The direct door's own comment gives the reason and it
// stands: direct mode mounts LOCAL-tier documents only, i.e. code the user or their own AI wrote,
// which already has every one of these tools through the model anyway. Adding the check there
// would not close a hole, it would break the App Store app's Add button and the settings pane's
// policy writer — the two first-party surfaces that legitimately drive control-plane verbs.
//
// So the claim is narrowed rather than the code widened. What the list still guarantees without
// qualification: nothing running behind the runner (any non-local tier, and every embedded child
// regardless of tier) can reach these names.
// The `app_store_*` prefix reserves the future SaaS app-publishing namespace up front.
// ── retired tool names, and the one table that knows them ────────────────────────────────────
// Seven seats were renamed to lead with a verb before the first directory submission (the last
// window where a rename is not a breaking change to a published metadata contract). The old names
// are still REGISTERED — an app saved in a user's store months ago calls `data_version` in its
// poll loop, and that app must keep working — but they are never LISTED, so nothing written from
// today's tool list learns them.
//
// The table is here, and not next to the registrations, because THREE readers need it and each
// would otherwise keep its own copy: the engine (to register the alias beside the seat and to hide
// it from tools/list) and the two runtimes' guards (to canonicalise a name BEFORE deciding what it
// is allowed to do). That last one is the load-bearing reason. Every guard below matches on a
// name; a widget that reached for a retired spelling would slip past a check written against the
// current one, which turns a rename into a hole. Canonicalise first, then decide.
export const TOOL_ALIASES = {
  get_app_html: "app_html",
  list_app_checkpoints: "app_history",
  apply_data_writes: "data_batch",
  get_data_version: "data_version",
  list_data_collections: "data_collections",
  get_ui_preference_schema: "ui_prefs_schema",
  preview_app_store_entry: "app_store_preview",
};
const RETIRED_TO_CURRENT = new Map(Object.entries(TOOL_ALIASES).map(([now, then]) => [then, now]));
/** The current name for `name`: a retired spelling maps to its seat, anything else passes through
 *  (trimmed). Case-folded on lookup for the same reason isControlPlaneTool folds — a re-cased
 *  variant must not be a different tool to a guard than it is to the server. */
export function canonicalToolName(name) {
  const t = String(name == null ? "" : name).trim();
  return RETIRED_TO_CURRENT.get(t.toLowerCase()) || t;
}

export const CONTROL_PLANE_TOOLS = [
  "security_set",
  // Reached here by NAME because it used to be reached by PREFIX: while it was called
  // `app_store_preview` the `app_store_*` rule below covered it, and the rename would otherwise
  // have quietly opened a door — a wall that disappears because a name got better is a wall that
  // was never being maintained. (`app_store_list` is still covered by the prefix.)
  "preview_app_store_entry",
  "save_app",
  "edit_app",      // same wall as save: a child that can edit source can rewrite any app
  "archive_app",   // seat retired 2026-08-04, name still reserved: the store command exists and the seat returns with a settings entry
  "delete_app",
  "restore_app",
  // Also on the HOST gate (engine.mjs WIDGET_CALLABLE), and that is the intended reading of the
  // two lists together: the App Store app's Add button is a top-level widget the user clicks, so
  // the host may forward it; an app embedded inside another app may not install anything.
  "install_from_app_store",
];
// render_health left the list 2026-08-04 with its seat AND its store action (elegance B3):
// unlike archive_app there is nothing behind the name any more.
// call_function is deliberately NOT here: it is a data-plane verb (a widget calling its own
// app's function is a designed path). Its caller-binding lands with the function pillar's
// runner wiring; until that flag exists the engine-side seat refuses every call anyway.

// The same-policy-two-runtimes sets (W4 consolidation). Both runtimes stamp a widget's
// destructive/write calls as the human acts they are, and both refuse apply_data_writes — but each
// had grown its own copy of the SET and the sentence, and the sets had already diverged once
// (file_delete missed the direct runtime's list when the file plane learned to demand). The
// policy now lives here; the runtimes import membership and message, never restate them.
export const DATA_WRITE_TOOLS = ["data_add_item", "data_update_item", "data_move_item", "data_delete_item"];
/** Tools whose widget-originated calls are stamped actor:"human" (+ command_id + via) at the
 *  generic door, so the engine's confirmation gate and the ledger's provenance see who acted. */
export const STAMPED_TOOLS = [...DATA_WRITE_TOOLS, "file_delete"];
/** Why a widget cannot have apply_data_writes, in the words both runtimes refuse with: a batch is
 *  all-or-nothing, so one confirmation demand inside it fails the whole call — per-row demands
 *  need per-row calls. */
export const DATA_BATCH_REFUSAL = "apply_data_writes is not available to apps — delete or write one row at a time (oma.deleteItem / oma.addItem), so each destructive row can be confirmed on its own.";

/** True if `name` is a control-plane tool no app may call. Canonicalises first (so a retired
 *  spelling is judged as the seat it names), then normalizes (trim+lowercase) so a padded or
 *  re-cased variant can't slip past, and matches the reserved `app_store_*`.
 *  `_`-prefixed names are internal RPC methods (undo, the Data pane's ledger view — served by
 *  the /rpc transport only, never registered as MCP tools): a sandboxed child must not reach
 *  them through a passthrough either, so they are control-plane by prefix. */
export function isControlPlaneTool(name) {
  const t = canonicalToolName(name).toLowerCase();
  return CONTROL_PLANE_TOOLS.indexOf(t) !== -1 || t.indexOf("app_store_") === 0 || t.indexOf("_") === 0;
}
