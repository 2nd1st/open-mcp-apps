// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/promote-app.mjs — the visual→app upgrade transaction + suggested_kind diagnostic
// (W-P §8-R3, re-shaped by W-N: the manifest is a first-class slot, so the promote flips a key
// in the STORED manifest and never touches the document).
//
// What must stay true, in order of what it costs when it breaks:
//   1. the promote is the ARBITRATED transaction and nothing more: kind flipped in the stored
//      manifest with every OTHER declared key preserved, one new version, ui untouched;
//   2. only visual→app exists. Already-app is a no-op (no event), primitive is refused, and
//      nothing ever downgrades;
//   3. suggested_kind is PROSE ONLY. The moment it appears as a structuredContent KEY, some
//      program can consume it — and the arbitration's ban (no influence on enumeration/closure/
//      export/retention, no auto-upgrade) stops being enforceable by construction.
// Run: node test/promote-app.mjs
import { stripDeclarationBlock, mentionsDeclarationTag, readDeclaration } from "../src/manifest-block.mjs";
import { suggestedKind } from "../src/tools/apps.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

const OPEN = '<script type="application/json" id="oma-manifest">';
const ui = (body = "<p>hi</p>") => `<!DOCTYPE html><html><head></head><body>${body}</body></html>`;

console.log("1. the legacy grammar's two survivors — the migration stripper and the save guard");
{
  const legacy = `<!DOCTYPE html>\r\n<html><head>${OPEN}{"kind":"visual"}</` + `script></head><body><p>x</p></body></html>`;
  const s = stripDeclarationBlock(legacy);
  ok("strip removes exactly the block, raw bytes — CRLF outside it survives",
    s.found && !s.html.includes("oma-manifest") && s.html.includes("\r\n") && s.html.includes("<p>x</p>"), JSON.stringify(s.html));
  ok("a block-free document passes through unchanged", stripDeclarationBlock(ui()).html === ui());
  ok("the guard sees the canonical tag", mentionsDeclarationTag(legacy));
  ok("…and a near-miss spelling", mentionsDeclarationTag(`<script id='oma-manifest' type='application/json'>{}</` + `script>`));
  ok("…but prose mentioning oma-manifest is free speech", !mentionsDeclarationTag("<p>declare via the old #oma-manifest block</p>"));
  ok("readDeclaration still reads legacy documents (the migration's reader)",
    readDeclaration(legacy).value.kind === "visual");
}

console.log("\n2. suggestedKind — binds persistent state, or it is a visual");
{
  const quiet = ui("<canvas></canvas><script>oma.ready(draw); oma.pref('accent','teal');</" + "script>");
  ok("ready + pref alone stay visual — theming a one-shot is not a binding", suggestedKind(quiet, { kind: "visual" }) === "visual");
  const binds = ui("<script>oma.onChange(render); document.oncontextmenu = () => oma.addItem({fields:{}});</" + "script>");
  ok("oma data verbs suggest app", suggestedKind(binds, { kind: "visual" }) === "app");
  ok("declared collections suggest app even with no code yet", suggestedKind(ui(), { kind: "visual", collections: { trips: {} } }) === "app");
  const tools = ui("<script>oma.callTool('data_list',{collection:'x'});</" + "script>");
  ok("direct data_* tool calls suggest app", suggestedKind(tools, null) === "app");
}

console.log("\n3. the tool face — the transaction, its refusals, and where the diagnostic may speak");
{
  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
  const { fileURLToPath } = await import("node:url");
  const { dirname: dn, join } = await import("node:path");
  const { existsSync, unlinkSync } = await import("node:fs");
  const ROOT = join(dn(fileURLToPath(import.meta.url)), "..");
  const DB = join(ROOT, "test", "promote-app.db");
  for (const f of [DB, DB + "-wal", DB + "-shm", join(dn(DB), "edit-telemetry.jsonl")]) if (existsSync(f)) unlinkSync(f);

  const client = new Client({ name: "promote-app", version: "0" });
  await client.connect(new StdioClientTransport({
    command: "node", args: [join(ROOT, "src", "server.mjs")],
    env: { ...process.env, OMA_DB: DB, OMA_HOST: "promote-app-test", OMA_VIEWER: "0" },
  }));
  const { randomUUID } = await import("node:crypto");
  const call = async (name, args) => {
    if (name === "edit_app") args = { command_id: randomUUID(), ...args };
    const r = await client.callTool({ name, arguments: args });
    return { err: !!r.isError, s: r.structuredContent, text: r.content?.[0]?.text || "" };
  };

  const saved = await call("save_app", { name: "wp-sketch", description: "one-shot chart",
    ui: ui("<canvas></canvas><script>oma.ready(()=>{});</" + "script>"),
    manifest: { kind: "visual", scene: { category_id: "local-tools" } } });
  ok("a quiet visual saves with NO suggested_kind chatter", !saved.err && !saved.text.includes("suggested_kind"), saved.text);
  const hiddenList = await call("list_apps", {});
  ok("kind visual is invisible to the default enumeration",
    !hiddenList.s.apps.some((c) => c.name === "wp-sketch"));

  const promoted = await call("promote_app", { name: "wp-sketch" });
  ok("promote flips visual → app with one new version",
    !promoted.err && promoted.s.kind === "app" && promoted.s.was === "visual" && promoted.s.version > saved.s.version,
    promoted.text);
  const man = await call("get_app", { name: "wp-sketch", slot: "manifest" });
  ok("the STORED manifest now says app — and every other declared key survived the flip",
    man.s.manifest?.kind === "app" && man.s.manifest?.scene?.category_id === "local-tools", JSON.stringify(man.s));
  const shownList = await call("list_apps", {});
  const row = shownList.s.apps.find((c) => c.name === "wp-sketch");
  ok("promoted app enters the default enumeration with its description intact",
    row && row.kind === "app" && row.description === "one-shot chart", JSON.stringify(row));
  const hist = await call("app_history", { name: "wp-sketch" });
  ok("history holds exactly the save and the promote — one event each",
    hist.s.history.length === 2, JSON.stringify(hist.s.history));

  const again = await call("promote_app", { name: "wp-sketch" });
  ok("promoting an app is a no-op receipt, not a new version",
    !again.err && again.s.version === promoted.s.version && again.text.includes("nothing to do"), again.text);
  const ghost = await call("promote_app", { name: "wp-ghost" });
  ok("unknown app is a plain refusal", ghost.err && ghost.text.includes("No app"), ghost.text);
  const locked = await call("promote_app", { name: "settings" });
  ok("locked system apps are out of reach", locked.err && locked.text.includes("locked"), locked.text);
  await call("save_app", { name: "wp-prim", ui: ui(), manifest: { kind: "primitive" } });
  const prim = await call("promote_app", { name: "wp-prim" });
  ok("primitive is refused by name — reserved, no lifecycle verbs", prim.err && prim.text.includes("primitive"), prim.text);

  // The W-N slot contract, exercised where W-P lives: legacy blocks refused, {} refused,
  // manifest-only saves inherit the ui.
  const blocked = await call("save_app", { name: "wp-legacy", ui: `<html><head>${OPEN}{"kind":"visual"}</` + `script></head><body>x</body></html>` });
  ok("a document still carrying the legacy block is refused with the fix named",
    blocked.err && blocked.text.includes("manifest") && blocked.text.includes("parameter"), blocked.text);
  const empty = await call("save_app", { name: "wp-sketch", expected_version: promoted.s.version, manifest: {} });
  ok("manifest: {} is refused as ambiguous — null is the one spelling of clear",
    empty.err && empty.text.includes("null"), empty.text);

  // The diagnostic's two speaking spots: a save whose visual binds data, and an edit that adds
  // the first binding. Both prose; structuredContent must never grow the KEY.
  const bindy = await call("save_app", { name: "wp-keeper", description: "grew data",
    ui: ui("<ul></ul><script>oma.onChange(render);</" + "script>"), manifest: { kind: "visual" } });
  ok("save of a binding visual fires the suggested_kind sentence with the upgrade verb",
    bindy.text.includes("suggested_kind: app") && bindy.text.includes("promote_app"), bindy.text);
  ok("…and no suggested_kind KEY anywhere structured — the ban is enforced by unreachability",
    !("suggested_kind" in (bindy.s || {})), JSON.stringify(bindy.s));
  await call("save_app", { name: "wp-sketch2", ui: ui("<i></i>"), manifest: { kind: "visual" } });
  const v2 = await call("list_apps", { name: "wp-sketch2" });
  const edited = await call("edit_app", { app: "wp-sketch2", expected_version: v2.s.apps[0].version,
    edits: [{ old_string: "<i></i>", new_string: "<i></i><script>oma.onChange(x=>x);</" + "script>" }] });
  ok("edit_app adding the first binding to a (still-visual) app fires the same sentence",
    !edited.err && edited.text.includes("suggested_kind: app"), edited.text);

  await client.close();
  for (const f of [DB, DB + "-wal", DB + "-shm", join(dn(DB), "edit-telemetry.jsonl")]) if (existsSync(f)) unlinkSync(f);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
