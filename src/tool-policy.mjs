// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// tool-policy.mjs — the SINGLE source of truth for "control-plane" tools: the ones a
// rendered or previewed app (ANY tier, incl. local) may NEVER reach via callTool.
// They mutate the app registry (save / delete / restore / install_from_library /
// render_health, which reverts an app) or the security policy (security_set). A child
// that could call them would rewrite policy or overwrite/delete/revert apps.
//
// Enforced parent-side at the runner chokepoint (src/shell.mjs runnerMount) and mirrored by
// every preview bridge (components/settings.html) through oma.isControlPlaneTool
// (src/shell-runtime.js) — nobody hand-maintains a second list, so the set can never drift.
// The `library_*` prefix reserves the future SaaS app-publishing namespace up front.
export const CONTROL_PLANE_TOOLS = [
  "security_set",
  "save_app",
  "edit_app",      // same wall as save: a child that can edit source can rewrite any app
  "archive_app",   // registry lifecycle — a child must not shelve or resurface its siblings
  "delete_app",
  "restore_app",
  "install_from_library",
  "render_health",
];
// call_function is deliberately NOT here: it is a data-plane verb (a widget calling its own
// app's function is a designed path). Its caller-binding lands with the function pillar's
// runner wiring; until that flag exists the engine-side seat refuses every call anyway.

/** True if `name` is a control-plane tool no app may call. Normalizes (trim+lowercase)
 *  so a padded or re-cased variant can't slip past, and matches the reserved `library_*`.
 *  `_`-prefixed names are internal RPC methods (undo, the Data pane's ledger view — served by
 *  the /rpc transport only, never registered as MCP tools): a sandboxed child must not reach
 *  them through a passthrough either, so they are control-plane by prefix. */
export function isControlPlaneTool(name) {
  const t = String(name == null ? "" : name).trim().toLowerCase();
  return CONTROL_PLANE_TOOLS.indexOf(t) !== -1 || t.indexOf("library_") === 0 || t.indexOf("_") === 0;
}
