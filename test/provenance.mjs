// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/provenance.mjs — an app's AUTHOR is not overwritable.
//
// `author` is the column tierOf() reads to decide whether an app runs DIRECT, holding the
// real window.oma with the AI's own trust, or behind the sandboxed runner with caps. The insert
// in save_app's core stamps that column from the command's actor, so before the guard this
// suite covers, ANY save on top of an existing row re-stamped provenance. Measured, not reasoned:
// an app stored by "guest" (tier unreviewed, call_tools []) came back as author "agent"
// (tier local, call_tools ["*"]) after one save_app carrying the right expected_version.
// Full escalation, one call, no warning.
//
// It is unreachable in the shipped engine today only because there is no ingress for a non-local
// author — every path that writes an app runs as agent/human/seed/library. It becomes live
// the day user-supplied apps can be installed, which is exactly when nobody will be looking at
// this line. Hence a test rather than a comment.
//
// WHY THE STORE IS THE ONLY WALL. Six paths write app html: save_app,
// edit_app, restore_app, the render-health auto-revert, install_from_app_store, and
// undoLast — the last one from inside store.mjs itself. A guard per path is six chances to
// forget; §3 proves mechanically that they all funnel through one insert, so one check covers
// them. install_from_app_store additionally keeps its own tool-level twin of this rule, which
// predates the wall and stays because its message is specific to App Store updates.
//
// Run: node test/provenance.mjs
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openStore } from "../src/store.mjs";
import { tierOf } from "../src/contracts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "provenance.db");
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

const store = openStore(DB);
const doc = (body) => `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><div id="r">${body}</div>
<script>const o = window.oma; o.ready && o.ready();</script></body></html>`;
const save = (name, actor, body, expected) => store.execute({
  type: "save_app", command_id: randomUUID(), name, ui: doc(body),
  description: "", actor, host: "prov", ...(expected == null ? {} : { expected_version: expected }),
});
const row = (name) => store.getApp(name);

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("1. the wall — a save may not change an app's trust tier");

// The ingress that does not exist yet, simulated the only way it can be: a non-local actor.
// "guest" is in the store's ACTORS set and outside tierOf's local list, which is precisely the
// shape a user-uploaded app will have.
const c0 = save("uploaded-app", "guest", "v1");
ok("a non-local actor can create an app", c0.ok);
ok("...stored under its own provenance", row("uploaded-app").author === "guest");
ok("...which resolves to the strictest tier", tierOf(row("uploaded-app").author) === "unreviewed");

const before = row("uploaded-app");
const esc = save("uploaded-app", "agent", "v2-by-ai", before.version);
ok("ESCALATION REFUSED: the AI cannot save over a non-local app", esc.ok === false);
ok("...and says why by name", esc.error === "provenance_locked", `got ${JSON.stringify(esc.error)}`);
ok("...the refusal reports whose it is", esc.author === "guest" && esc.tier === "unreviewed");
{
  const after = row("uploaded-app");
  // A refusal that still mutated something would be worse than no guard: the caller would believe
  // nothing happened. Check every column the tier decision or a retry depends on.
  ok("...NOTHING was written — author intact", after.author === "guest");
  ok("...NOTHING was written — version intact", after.version === before.version);
  ok("...NOTHING was written — html intact", after.ui === before.ui);
  ok("...so the tier is still the strict one", tierOf(after.author) === "unreviewed");
}

// Symmetric on purpose. A demotion cannot GRANT capability, so it is not an escalation — but it is
// still one actor rewriting another's provenance, and one sentence is cheaper to hold than a
// direction. Refusing both ways also means the rule reads the same from either side of the wall.
const mine = save("ai-built-app", "agent", "v1");
ok("the AI can create its own app", mine.ok && row("ai-built-app").author === "agent");
const dem = save("ai-built-app", "guest", "replaced", row("ai-built-app").version);
ok("DEMOTION REFUSED: an upload cannot replace an AI-authored app either", dem.ok === false && dem.error === "provenance_locked");
ok("...and the AI's app is untouched", row("ai-built-app").author === "agent");

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("2. the wall is narrow — everything that was legal stays legal");

// This is the half that matters for regression: today EVERY app in a shipped store is local,
// so if the guard cost anything it would cost it here, on the paths that run every day.
const own = save("uploaded-app", "guest", "v2-by-uploader", row("uploaded-app").version);
ok("a non-local app can be updated by its OWN tier", own.ok);
ok("...and keeps its provenance", row("uploaded-app").author === "guest");

ok("agent over agent", save("ai-built-app", "agent", "v2", row("ai-built-app").version).ok);
// seed/library/human are all local: the seeder re-installing over an AI edit, the human undoing,
// and an App Store install are the same tier and must not notice this rule exists.
ok("seed over agent (re-seed on boot)", save("ai-built-app", "seed", "v3", row("ai-built-app").version).ok);
ok("human over seed (a widget-side write)", save("ai-built-app", "human", "v4", row("ai-built-app").version).ok);
ok("library over human (install_from_app_store)", save("ai-built-app", "library", "v5", row("ai-built-app").version).ok);
ok("...local provenance moves freely within its tier", tierOf(row("ai-built-app").author) === "local");
ok("creating a NEW name is never blocked (no existing row, no tier to change)",
  save("fresh-name", "guest", "hello").ok && save("another-fresh", "agent", "hello").ok);

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("3. undo goes through the same wall (it is the path no tool-level guard would cover)");

// undoLast is not an MCP tool — it is reachable from the Data pane and from any embedder, and it
// re-saves the previous html as actor "human". That makes it an escalation vector that lives
// INSIDE store.mjs, which is the single clearest argument for the guard being here and not in
// src/tools/. The consequence is worth stating out loud: a non-local app is managed by the path
// that installed it — undo/restore/auto-revert (all local actors) will not touch it.
{
  const u = store.undoLast("uploaded-app");
  ok("undo on a non-local app is refused", u.ok === false, `got ${JSON.stringify(u)}`);
  ok("...through the same wall, by name", JSON.stringify(u).includes("provenance_locked"), JSON.stringify(u));
  ok("...and provenance survives", row("uploaded-app").author === "guest");
}
{
  const before2 = row("ai-built-app");
  const u = store.undoLast("ai-built-app");
  ok("undo on a LOCAL app still works", u.ok !== false, JSON.stringify(u));
  ok("...and lands a new version", row("ai-built-app").version > before2.version);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("4. mechanical: the wall is the ONLY door to the author column");

// The reason a single check can cover six callers. If a second insert into `app` ever
// appears, this fails and whoever added it has to put the guard in front of it too — the same
// argument invariants.mjs makes about tool registration, applied to provenance.
{
  const src = readFileSync(join(ROOT, "src", "store.mjs"), "utf-8");
  const inserts = (src.match(/q\.insComp\.run\(/g) || []).length;
  ok("exactly one insert writes the app row", inserts === 1, `found ${inserts}`);
  const authored = (src.match(/author:\s*actor/g) || []).length;
  ok("...and it is the only place `author` is stamped from an actor", authored === 1, `found ${authored}`);
  const guard = /tierOf\(existing\.author\)\s*!==\s*tierOf\(actor\)/.test(src);
  ok("...guarded before it, in the same handler", guard);
}

store.close();

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("5. end to end — the refusal reaches the MODEL, in words it can act on");

// §1-4 prove the invariant. This proves the plumbing: a wall the model cannot see the reason for
// is a wall it will retry against forever. Real stdio, real tool surface, same db.
const client = new Client({ name: "provenance", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: "node", args: [join(ROOT, "src", "server.mjs")],
  env: { ...process.env, OMA_DB: DB, OMA_HOST: "prov" },
}));

const S = openStore(DB);
const uploadedV = S.getApp("uploaded-app").version;
S.close();
const textOf = (r) => (r.content || []).map((c) => c.text || "").join("\n");

{
  const r = await client.callTool({ name: "save_app", arguments: {
    command_id: randomUUID(), name: "uploaded-app", ui: doc("ai rewrite"),
    description: "", expected_version: uploadedV,
  } });
  ok("save_app is refused at the tool surface", r.isError === true);
  const t = textOf(r);
  ok("...naming the error", t.includes("provenance_locked"), t.slice(0, 200));
  ok("...naming the author and tier", t.includes("guest") && t.includes("unreviewed"), t.slice(0, 200));
  ok("...telling the model what to do instead", /different name|delete/i.test(t), t.slice(0, 200));
}
{
  // edit_app is the path that would ACTUALLY be taken: the AI reads the source, patches a
  // string, saves. Its wall is the same one, and its "NOTHING was applied" wording must survive.
  const cur = await client.callTool({ name: "get_app", arguments: { name: "uploaded-app" } });
  ok("the AI can still READ a non-local app's source", cur.isError !== true);
  const r = await client.callTool({ name: "edit_app", arguments: {
    command_id: randomUUID(), app: "uploaded-app", expected_version: uploadedV,
    edits: [{ old_string: "v2-by-uploader", new_string: "v2-by-ai" }],
  } });
  ok("edit_app is refused too", r.isError === true);
  ok("...and says nothing was applied", /NOTHING was applied/.test(textOf(r)), textOf(r).slice(0, 200));
}
{
  const r = await client.callTool({ name: "restore_app", arguments: { name: "uploaded-app", checkpoint: 1 } });
  ok("restore_app is refused", r.isError === true, textOf(r).slice(0, 160));
}
{
  // (render_health + auto-revert retired 2026-08-04, elegance B3 — nothing can roll an app
  // back automatically any more, local or not. The seat's absence is the guarantee now.)
  const r = await client.callTool({ name: "render_health", arguments: {
    app: "uploaded-app", version: uploadedV, ok: false, error: "boom",
  } }).catch((e) => e);
  ok("no seat exists that could auto-roll-back a non-local app",
    r instanceof Error && /not found/.test(String(r.message)));
}
{
  const r = await client.callTool({ name: "save_app", arguments: {
    command_id: randomUUID(), name: "ai-built-app", ui: doc("still fine"),
    description: "", expected_version: (await client.callTool({ name: "list_apps", arguments: { name: "ai-built-app" } })).structuredContent.apps[0].version,
  } });
  ok("the everyday path (AI saving its own app) is untouched", r.isError !== true, textOf(r).slice(0, 160));
}

await client.close();
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

console.log(`\n${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
