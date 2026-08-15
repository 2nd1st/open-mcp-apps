// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// seed.mjs — load the built-in SYSTEM apps (components/<name>/ entries) into a registry.
// CLI: node seed.mjs   (idempotent per content: re-seeding same content just bumps version)
// As a library: import { seedSystemApps } from "@2nd1st/open-mcp-apps" — embedders (e.g. a hosted
// data-plane provisioning a fresh per-tenant store) call it after openStore(); idempotent,
// so calling on every open is safe and cheap (content-hash command_id + unchanged check).
import { openStore } from "./src/store.mjs";
import { SEEDED_APPS } from "./src/contracts.mjs";
import { readSystemApp } from "./src/app-store.mjs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const DESCRIPTIONS = {
  settings: "Settings — preferences (poll intervals etc, stored in the settings collection), usage guide, About stats, App Store placeholder",
  dashboard: "Everything dashboard — meta app: overview cards for ALL collections (counts, groups, previews), Open buttons ask the AI to bring up the full board",
  "app-store": "App Store — browse the built-in store of ready-made first-party apps (live previews with sample data) and install them into your registry with one click",
};

// Only SYSTEM apps are installed on seed. The other components/<name>/ entries are the APP STORE —
// browsable in the `app-store` app and installed on demand (install_from_app_store), NOT auto-
// installed; a fresh registry stays clean so onboarding builds apps tailored to the user
// instead of presenting a pre-filled catalog.
// Defined in contracts.mjs — engine.mjs needs the same set to tell a first-time user apart.
const SYSTEM = SEEDED_APPS;

// System apps this engine used to seed under a NAME it no longer uses. Renaming a system app
// (v0.5.0: `library` → `app-store`) does not touch the row already sitting in every existing
// store, and that row is then an orphan in the worst way: still installed, no longer in
// SEEDED_APPS (so onboarding counts it as an app the USER built), no longer in LOCKED_APPS
// (so the AI may rewrite it), showing a page the engine stopped shipping, and wired to four tool
// names that now answer "unknown tool". Nothing about it works, and nothing about it says so.
// So the seeder retires it on the way past — the same run that installs the replacement.
// `author: "seed"` is what a v0.4.2 store actually holds for that row (measured, not assumed:
// seeded at 953af1e^ and read back off the app table), and it is the same signal the non-seed
// guard below already trusts. An app a USER named `library` has some other author and is left
// exactly where it is; the delete goes through store.execute, so it is one ordinary
// `component_deleted` in the ledger with its bytes still recoverable from app_history — a
// tombstone, not an erasure.
const RETIRED_SYSTEM_APPS = [{ name: "library", replacedBy: "app-store" }];

function retireRenamedSystemApps(store, log) {
  const out = [];
  for (const { name, replacedBy } of RETIRED_SYSTEM_APPS) {
    const existing = store.getApp(name);
    if (!existing) continue;
    if (existing.author !== "seed") {
      log(`= ${name} — not ours (author=${existing.author}); left untouched`);
      out.push({ name, action: "kept", author: existing.author });
      continue;
    }
    // Version in the command_id so a later row under the same name is a DIFFERENT command —
    // eventByCmd idempotency would otherwise swallow the second retirement as a replay.
    const r = store.execute({ type: "delete_app", command_id: `seed-retire-${name}-v${existing.version}`,
                              name, actor: "seed" });
    log(r.ok ? `− ${name} retired (replaced by ${replacedBy})` : `✗ ${name}: ${r.error}`);
    out.push(r.ok ? { name, action: "retired", version: existing.version, replaced_by: replacedBy }
                  : { name, action: "error", error: r.error });
  }
  return out;
}

/**
 * Seed the system apps into `store`. Returns [{name, action: "seeded"|"unchanged"|"skipped"|"retired"|"kept"|"conflict"|"error", version?, error?}].
 * Stored bytes are the file's bytes. The kit used to be spliced in HERE, at seed time, through a
 * per-file marker; it is now injected by the engine into every rendered document (src/shell.mjs
 * KIT_CSS), so splicing it in as well would give exactly these three apps two copies.
 * That also means a kit edit no longer needs a re-seed to take effect anywhere.
 */
export function seedSystemApps(store, { log = () => {} } = {}) {
  const out = retireRenamedSystemApps(store, log);
  for (const name of SYSTEM) {
    const entry = readSystemApp(name);
    if (!entry) { log(`✗ ${name} — system entry missing from components/`); out.push({ name, action: "error", error: "entry_missing" }); continue; }
    const manifestJson = entry.manifest ? JSON.stringify(entry.manifest) : null;
    const existing = store.getApp(name);
    // A system NAME occupied by an app this seeder did not write is the USER'S property —
    // a v0.2.0 store may legally hold an app called "app-store" (the name was not reserved then).
    // Seed without expected_version would silently clobber it, so this is the one hard refusal:
    // leave the user's row untouched, say so loudly, and ship degraded (that browse surface simply
    // isn't installed) — the user frees the slot by renaming their app.
    if (existing && existing.author !== "seed") {
      log(`✗ ${name} — name taken by a non-seed app (author=${existing.author}); left untouched`);
      out.push({ name, action: "conflict", author: existing.author });
      continue;
    }
    // Unchanged-check covers BOTH slots: a manifest-only change to a shipped app must re-seed, and
    // both are folded into the command_id hash (else eventByCmd idempotency swallows the bump).
    if (existing && existing.ui === entry.ui && (existing.manifest ?? null) === manifestJson) {
      log(`= ${name} unchanged (v${existing.version})`); out.push({ name, action: "unchanged", version: existing.version }); continue;
    }
    // command_id derived from content hash → re-running the same seed is a no-op even across dbs
    const command_id = "seed-" + name + "-" + createHash("sha256").update(entry.ui + "\n@manifest:" + (manifestJson ?? "")).digest("hex").slice(0, 16);
    const r = store.execute({ type: "save_app", command_id, name, ui: entry.ui, manifest: entry.manifest ?? null,
      description: DESCRIPTIONS[name] || "", actor: "seed",
      ...(existing ? { expected_version: existing.version } : {}) });
    log(r.ok ? `✓ ${name} → v${r.version ?? "?"}${r.idempotent ? " (idempotent)" : ""}` : `✗ ${name}: ${r.error}`);
    out.push(r.ok ? { name, action: "seeded", version: r.version } : { name, action: "error", error: r.error });
  }
  return out;
}

// CLI entry (node seed.mjs): seed the fixed per-user db — OMA_DB overrides (see store.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = openStore();
  seedSystemApps(store, { log: console.log });
  store.close();
}
