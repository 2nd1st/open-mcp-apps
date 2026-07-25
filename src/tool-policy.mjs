// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// tool-policy.mjs — the SINGLE source of truth for "control-plane" tools: the ones a
// rendered or previewed component (ANY tier, incl. local) may NEVER reach via callTool.
// They mutate the component registry (save / delete / restore / install_from_gallery /
// render_health, which reverts a component) or the security policy (security_set). A child
// that could call them would rewrite policy or overwrite/delete/revert components.
//
// Enforced parent-side at the runner chokepoint (src/shell.mjs runnerMount) and mirrored by
// every preview bridge (components/settings.html) through oma.isControlPlaneTool
// (src/shell-runtime.js) — nobody hand-maintains a second list, so the set can never drift.
// The `library_*` prefix reserves the future SaaS component-publishing namespace up front.
export const CONTROL_PLANE_TOOLS = [
  "security_set",
  "save_component",
  "delete_component",
  "restore_component",
  "install_from_gallery",
  "render_health",
];

/** True if `name` is a control-plane tool no component may call. Normalizes (trim+lowercase)
 *  so a padded or re-cased variant can't slip past, and matches the reserved `library_*`. */
export function isControlPlaneTool(name) {
  const t = String(name == null ? "" : name).trim().toLowerCase();
  return CONTROL_PLANE_TOOLS.indexOf(t) !== -1 || t.indexOf("library_") === 0;
}
