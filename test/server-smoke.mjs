// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/server-smoke.mjs — end-to-end proof of the ENGINE over real stdio.
// Covers the creation loop itself: seed components present → generic data flow →
// save_component at runtime → the open_<name> tool appears dynamically → shell-wrapped ui://.
// Run: node test/server-smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { openStore } from "../src/store.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "smoke.db");
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);
rmSync(join(ROOT, "test", "files"), { recursive: true, force: true }); // file-plane blobs land beside the test db

// seed directly into the test db
{
  const store = openStore(DB);
  for (const file of readdirSync(join(ROOT, "components")).filter((f) => f.endsWith(".html"))) {
    store.execute({ type: "save_component", command_id: "seed-" + file, name: basename(file, ".html"),
      html: readFileSync(join(ROOT, "components", file), "utf-8"), actor: "seed" });
  }
  store.close();
}

let pass = 0, fail = 0;
const ok = (name, cond) => (cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name)));

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: "node",
  args: [join(ROOT, "src", "server.mjs")],
  // OMA_DYNAMIC_TOOLS=1: this suite covers the opt-in per-component tool path;
  // http-smoke covers the default (open_component-only) behavior.
  env: { ...process.env, OMA_DB: DB, OMA_HOST: "smoke", OMA_DYNAMIC_TOOLS: "1" },
}));
console.log("connected over stdio");

console.log("0. server instructions teach when-to-use");
const instr = client.getInstructions?.();
ok("instructions delivered at initialize", typeof instr === "string" && instr.includes("SHOW UI vs READ data"));
ok("instructions teach persisting files (file_write)", typeof instr === "string" && /PERSISTING FILES/.test(instr) && /file_write/.test(instr));

console.log("1. seed components are live as dynamic tools");
let { tools } = await client.listTools();
let names = tools.map((t) => t.name);
ok("open_habit_streaks + open_meal_planner exist", names.includes("open_habit_streaks") && names.includes("open_meal_planner"));
ok("engine tools exist", ["get_component_guide", "list_components", "save_component", "get_component", "data_add_item", "data_move_item"].every((n) => names.includes(n)));
const openHabits = tools.find((t) => t.name === "open_habit_streaks");
ok("open_habit_streaks carries ui://", openHabits?._meta?.ui?.resourceUri === "ui://open-mcp-apps/habit-streaks.html");
ok("data tools carry NO ui://", !tools.find((t) => t.name === "data_add_item")?._meta?.ui?.resourceUri);

console.log("2. ui:// resource is shell-wrapped");
const res = await client.readResource({ uri: "ui://open-mcp-apps/habit-streaks.html" });
const doc = res.contents[0];
ok("MIME correct", doc.mimeType === "text/html;profile=mcp-app");
ok("shell runtime injected", doc.text.includes('data-oma="runtime"') && doc.text.includes("window.oma"));
ok("design tokens injected", doc.text.includes('data-oma="tokens"'));
ok("component version injected (render-health identity)", doc.text.includes("__OMA_COMPONENT_VERSION__"));
ok("early-error buffer injected before component code", doc.text.includes("__OMA_EARLY_ERRORS__"));

console.log("3. generic data flow (kanban semantics on a free-form collection)");
const A = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "kanban", group: "To Do", fields: { title: "ship v0" } } });
ok("added to To Do", A.structuredContent.items.some((i) => i.group === "To Do" && i.fields.title === "ship v0"));
const id = A.structuredContent.items[0].id;
const M = await client.callTool({ name: "data_move_item", arguments: { command_id: randomUUID(), id, group: "Doing", expected_version: 1 } });
ok("moved to Doing", M.structuredContent.items[0].group === "Doing");
ok("version bumped", M.structuredContent.items[0].version === 2);
const stale = await client.callTool({ name: "data_move_item", arguments: { command_id: randomUUID(), id, group: "Done", expected_version: 1 } });
ok("stale move rejected (still Doing)", stale.structuredContent.items[0].group === "Doing");
const U = await client.callTool({ name: "data_update_item", arguments: { command_id: randomUUID(), id, fields: { note: "smoke", title: "ship v0!" }, expected_version: 2 } });
ok("fields merged", U.structuredContent.items[0].fields.note === "smoke" && U.structuredContent.items[0].fields.title === "ship v0!");
const open = await client.callTool({ name: "open_habit_streaks", arguments: { collection: "kanban" } });
ok("open_<name> binds the requested collection", open.structuredContent.collection === "kanban" && open.structuredContent.items.length === 1);
ok("model-readable summary present", open.content.some((c) => c.type === "text" && /Doing \(1\)/.test(c.text)));

console.log("4. THE LOOP: save a brand-new component at runtime");
const guide = await client.callTool({ name: "get_component_guide", arguments: {} });
ok("guide teaches window.oma", guide.content[0].text.includes("oma.addItem") && guide.content[0].text.includes("oma.sendMessage"));
const noteHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><ul id="l"></ul>
<script type="module">
  const r = (s) => { document.getElementById("l").innerHTML = s.items.map((i) => "<li>" + i.fields.text + "</li>").join(""); };
  oma.ready(r); oma.onChange(r);
</script></body></html>`;
const save = await client.callTool({ name: "save_component", arguments: { name: "smoke-notes", html: noteHtml, description: "simple note list" } });
ok("saved v1", save.content[0].text.includes('Saved "smoke-notes" v1'));
({ tools } = await client.listTools());
names = tools.map((t) => t.name);
ok("open_smoke_notes appeared DYNAMICALLY", names.includes("open_smoke_notes"));
ok("open_smoke_notes carries its ui://", tools.find((t) => t.name === "open_smoke_notes")?._meta?.ui?.resourceUri === "ui://open-mcp-apps/smoke-notes.html");
const notesRes = await client.readResource({ uri: "ui://open-mcp-apps/smoke-notes.html" });
ok("new component served shell-wrapped", notesRes.contents[0].text.includes("window.oma") && notesRes.contents[0].text.includes('id="l"'));

console.log("5. component update = new version, served immediately");
const save2 = await client.callTool({ name: "save_component", arguments: { name: "smoke-notes", html: noteHtml.replace('id="l"', 'id="l" class="v2"'), description: "" } });
ok("v2 saved", save2.content[0].text.includes("v2"));
const notesV2 = await client.readResource({ uri: "ui://open-mcp-apps/smoke-notes.html" });
ok("resource serves v2 live (no re-register)", notesV2.contents[0].text.includes('class="v2"'));
const seedCount = readdirSync(join(ROOT, "components")).filter((f) => f.endsWith(".html")).length;
const listC = await client.callTool({ name: "list_components", arguments: {} });
ok(`registry lists ${seedCount} seeds + smoke-notes`, listC.structuredContent.components.length === seedCount + 1);

console.log("6. universal opener: zero-wait open of a just-saved component");
const openTool = tools.find((t) => t.name === "open_component");
ok("open_component is a static tool with the loader ui://", openTool?._meta?.ui?.resourceUri === "ui://open-mcp-apps/app.html");
const loaderRes = await client.readResource({ uri: "ui://open-mcp-apps/app.html" });
ok("loader resource shell-wrapped + has loader", loaderRes.contents[0].text.includes('data-oma="loader"') && loaderRes.contents[0].text.includes("component_html"));
const openNow = await client.callTool({ name: "open_component", arguments: { component: "smoke-notes" } });
ok("open_component works immediately for the fresh component", openNow.structuredContent?.component === "smoke-notes" && openNow.structuredContent?.collection === "smoke-notes");
const chtml = await client.callTool({ name: "component_html", arguments: { name: "smoke-notes" } });
ok("component_html feeds the loader (html in structuredContent)", chtml.structuredContent?.html?.includes('class="v2"') && chtml.structuredContent?.version === 2);
ok("component_html keeps model context tiny", chtml.content[0].text.length < 200);
const openMissing = await client.callTool({ name: "open_component", arguments: { component: "does-not-exist" } });
ok("open_component rejects unknown component", openMissing.isError === true);

console.log("6b. data_collections — discoverability");
const colls = await client.callTool({ name: "data_collections", arguments: {} });
ok("lists the kanban collection with count", colls.structuredContent.collections.some((c) => c.collection === "kanban" && c.items === 1));
ok("model-readable summary", colls.content[0].text.includes("kanban: 1 item"));

console.log("7. guardrails");
const badName = await client.callTool({ name: "save_component", arguments: { name: "Bad Name!", html: noteHtml } });
ok("bad name rejected", badName.isError === true);
const extUrl = await client.callTool({ name: "save_component", arguments: { name: "ext-test", html: noteHtml.replace("<ul", '<script src="https://evil.example/x.js"></script><ul') } });
ok("external URL warned", extUrl.content[0].text.includes("External URLs detected"));
const noOma = await client.callTool({ name: "save_component", arguments: { name: "static-test", html: "<!DOCTYPE html><html><body><h1>static</h1>no oma here, just markup filling the minimum size…</body></html>" } });
ok("no-oma warned", noOma.content[0].text.includes("never references the oma API"));

console.log("8. security v0.1 — reserved namespace, size cap, privileged writer");
// (1) the generic data_* tools refuse reserved security:* / policy:* keys
const resAdd = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", fields: { key: "security:kanban:sendMessage", value: "deny" } } });
ok("data_add_item refuses a reserved security:* key", resAdd.isError === true && /reserved_key/.test(resAdd.content[0].text));
const polAdd = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", fields: { key: "policy:x", value: "1" } } });
ok("data_add_item refuses a reserved policy:* key", polAdd.isError === true && /reserved_key/.test(polAdd.content[0].text));
// regression: a NON-reserved settings key (a normal preference) is unaffected
const prefAdd = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", fields: { key: "widget_poll_seconds", value: "30" } } });
ok("non-reserved settings key still writable", !prefAdd.isError && prefAdd.structuredContent.items.some((i) => i.fields.key === "widget_poll_seconds"));
// (2) privilege cannot travel as a command field — an injected {privileged:true} still hits the guard
const inject = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", privileged: true, fields: { key: "security:evil:x", value: "allow" } } });
ok("injected {privileged:true} on data_* is still rejected", inject.isError === true && /reserved_key/.test(inject.content[0].text));
// (3) security_set (the out-of-band privileged writer) succeeds on a reserved key
const secSet = await client.callTool({ name: "security_set", arguments: { key: "security:kanban:sendMessage", value: "deny" } });
ok("security_set writes a reserved key", !secSet.isError && secSet.structuredContent.items.some((i) => i.fields.key === "security:kanban:sendMessage" && i.fields.value === "deny"));
const secSetBad = await client.callTool({ name: "security_set", arguments: { key: "widget_poll_seconds", value: "5" } });
ok("security_set refuses non-reserved keys", secSetBad.isError === true);
// (4) the per-item fields byte cap binds every caller (DoS floor)
const tooBig = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "kanban", group: "To Do", fields: { title: "big", blob: "x".repeat(33_000) } } });
ok("oversized item fields rejected (fields_too_large)", tooBig.isError === true && /fields_too_large/.test(tooBig.content[0].text));

console.log("9. onboarding — always-in-context GETTING STARTED hook");
ok("instructions carry the GETTING STARTED onboarding hook", typeof instr === "string" && instr.includes("GETTING STARTED"));
ok("the hook runs a personalized, history-aware onboarding", /past conversations/i.test(instr) && /let them pick/i.test(instr) && /one scenario/i.test(instr));
ok("onboarding step 4 sets the cost expectation + proactivity preference", /proactivity/i.test(instr) && /tokens ONCE/i.test(instr) && /on-request/i.test(instr));
ok("the proactivity stance is resolved into instructions (no placeholder leak)", !instr.includes("__PROACTIVITY_STANCE__") && /PROACTIVITY —/.test(instr));
ok("SHOW UI leans proactive — open an existing app rather than narrating its data", /nearly free/i.test(instr) && /show the board/i.test(instr));

console.log("10. settings_version — the pref-refetch gate on every snapshot");
// present on any snapshot (data_* toResult carries the whole snapshot)
const snapK = (await client.callTool({ name: "data_list", arguments: { collection: "kanban" } })).structuredContent;
ok("settings_version present in snapshots", typeof snapK.settings_version === "number");
const sv = async () => (await client.callTool({ name: "data_list", arguments: { collection: "settings" } })).structuredContent.settings_version;
let sVer = await sv();
// (a) settings ADD bumps it
const sAdd = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", fields: { key: "density", value: "compact" } } });
ok("settings add bumps settings_version", sAdd.structuredContent.settings_version > sVer);
sVer = sAdd.structuredContent.settings_version;
const sId = sAdd.structuredContent.items.find((i) => i.fields.key === "density").id;
// (b) settings UPDATE bumps it
const sUpd = await client.callTool({ name: "data_update_item", arguments: { command_id: randomUUID(), id: sId, fields: { value: "comfortable" } } });
ok("settings update bumps settings_version", sUpd.structuredContent.settings_version > sVer);
sVer = sUpd.structuredContent.settings_version;
// (c) a FOREIGN-collection write does NOT bump it (though the global version does)
const kAdd = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "kanban", group: "To Do", fields: { title: "not a setting" } } });
ok("foreign-collection write leaves settings_version unchanged", kAdd.structuredContent.settings_version === sVer && kAdd.structuredContent.version > sVer);
// (d) save_component does NOT bump it (component_saved events carry no `collection`)
await client.callTool({ name: "save_component", arguments: { name: "smoke-notes", html: noteHtml.replace('id="l"', 'id="l" data-r="10"'), description: "" } });
ok("save_component leaves settings_version unchanged", (await sv()) === sVer);
// (e) settings DELETE bumps it
const sDel = await client.callTool({ name: "data_delete_item", arguments: { command_id: randomUUID(), id: sId } });
ok("settings delete bumps settings_version", sDel.structuredContent.settings_version > sVer);

console.log("10b. pref merge order — duplicate (group,key) rows resolve last-wins in snapshot order");
// the shell, settings app, and preview childPrefs all resolve by scanning items[] in order:
// last row per (group,key) wins, component group over global — pinned here against ORDER BY drift
await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", fields: { key: "merge_probe", value: "global-old" } } });
await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", fields: { key: "merge_probe", value: "global-new" } } });
const mSnap = (await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", group: "smoke-notes", fields: { key: "merge_probe", value: "component" } } })).structuredContent;
const mRows = mSnap.items.filter((i) => i.fields.key === "merge_probe");
const mGlobals = mRows.filter((i) => i.group === "");
ok("duplicate global rows: the later-created row is LAST in items[]", mGlobals.length === 2 && mGlobals[mGlobals.length - 1].fields.value === "global-new");
let mG, mC;
for (const i of mRows) { if (i.group === "") mG = i.fields.value; else if (i.group === "smoke-notes") mC = i.fields.value; }
ok("last-wins scan of the global layer yields the newer duplicate", mG === "global-new");
ok("component-scoped row present in the snapshot (merge = component over global)", mC === "component");
// the settings UI pins confirm_delete + proactivity as its unfolded TOP rows (components/settings.html
// TOP_KEYS) — renaming/removing either in the engine catalog must fail loudly here, not drop out silently
const prefCatalog = (await client.callTool({ name: "ui_prefs_schema", arguments: {} })).structuredContent;
ok("ui_prefs_schema carries the pinned TOP keys (confirm_delete + proactivity)", ["confirm_delete", "proactivity"].every((k) => prefCatalog.shared.some((p) => p.key === k)));

console.log("11. data_update_item WITHOUT expected_version — last-write-wins (setPref semantics)");
const pAdd = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", group: "smoke-notes", fields: { key: "widget_poll_seconds", value: "15" } } });
const pItem = pAdd.structuredContent.items.find((i) => i.group === "smoke-notes" && i.fields.key === "widget_poll_seconds");
const pId = pItem.id, pV = pItem.version;
// a concurrent writer bumps the item version behind our back
const pBump = await client.callTool({ name: "data_update_item", arguments: { command_id: randomUUID(), id: pId, fields: { value: "16" }, expected_version: pV } });
ok("concurrent bump lands", pBump.structuredContent.items.find((i) => i.id === pId).version === pV + 1);
// setPref-style write omits expected_version → succeeds despite the moved version (store skips OCC)
const pLww = await client.callTool({ name: "data_update_item", arguments: { command_id: randomUUID(), id: pId, fields: { value: "17" } } });
const pAfter = pLww.structuredContent.items.find((i) => i.id === pId);
ok("update without expected_version succeeds after a concurrent bump", !pLww.isError && pAfter.fields.value === "17" && pAfter.version === pV + 2);

console.log("12. save_component rejects reserved namespace names (settings groups)");
for (const rn of ["security", "engine", "host", "system", "shell", "oma"]) {
  const rr = await client.callTool({ name: "save_component", arguments: { name: rn, html: noteHtml } });
  ok(`reserved name "${rn}" rejected`, rr.isError === true && /reserved namespace/.test(rr.content[0].text));
}

console.log("12b. locked system components — settings/gallery refuse tool-side save, restore & delete (seed/privileged exempt)");
for (const ln of ["settings", "gallery"]) {
  const lr = await client.callTool({ name: "save_component", arguments: { name: ln, html: noteHtml } });
  ok(`locked "${ln}" refuses save_component`, lr.isError === true && /locked system component/.test(lr.content[0].text));
  const lrr = await client.callTool({ name: "restore_component", arguments: { name: ln, version: 1 } });
  ok(`locked "${ln}" refuses restore_component`, lrr.isError === true && /locked system component/.test(lrr.content[0].text));
  const lrd = await client.callTool({ name: "delete_component", arguments: { name: ln, command_id: randomUUID() } });
  ok(`locked "${ln}" refuses delete_component`, lrd.isError === true && /locked system component/.test(lrd.content[0].text));
}
// dashboard is intentionally editable (the personal launcher) — a tool-side save must SUCCEED.
const dashSave = await client.callTool({ name: "save_component", arguments: { name: "dashboard", html: noteHtml, description: "editable launcher" } });
ok("dashboard is NOT locked — save_component succeeds", !dashSave.isError && /Saved "dashboard"/.test(dashSave.content[0].text));

console.log("13. THE TOOL-SURFACE INVARIANT (docs/security-model.md §1.5 — lane A item A8)");
// The exact set of tool names the server registers TODAY (hardcoded on purpose: this list is a
// security contract, not something to auto-derive). Per-component openers are the ONLY dynamic
// surface — allowed via the open_<name> regex because this suite runs OMA_DYNAMIC_TOOLS=1.
const KNOWN_SAFE = new Set([
  "open_component", "component_html", "get_component_guide", "list_components", "get_component", "save_component",
  "data_list", "data_collections", "data_add_item", "data_update_item", "data_move_item", "data_delete_item",
  "security_set",
  // PR-4 (design-system §7.5): both operate ONLY on the component registry table via prepared
  // statements — no process/fs/shell/socket primitive, no generic escape (security-model §1.5).
  "component_history", "delete_component",
  // P1 version-rollback: get_component_version reads one historical html from component_history
  // via a prepared statement; restore_component re-saves it through the SAME save_component
  // command path (store.execute). No process/fs/shell/socket primitive, no generic escape.
  "get_component_version", "restore_component",
  // F2 per-app file plane: all five go through the engine's file channel (src/files.mjs), which
  // confines fs to a per-app, content-addressed, traversal-immune blob store — no generic fs/shell/
  // socket primitive reachable from a tool (security-model §1.5). Bytes ride base64 but only ever
  // land under files/<component>/<sha256>.blob.
  "file_list", "file_read", "file_write", "file_delete", "file_usage",
  // Chunked large-file write: same channel/backend as file_write — staging lives under the
  // backend's own .tmp (uuid names, never caller input), commit lands through the identical
  // write_file store transaction. No new fs surface beyond src/files.mjs (§1.5).
  "file_write_begin", "file_write_chunk", "file_write_commit", "file_write_abort",
  // data_version: read-only aggregate over change_event via prepared statements — no primitives.
  "data_version",
  // Gallery: gallery_list/gallery_preview/install_from_gallery read ONLY repo components/*.html
  // through src/gallery.mjs, whose name argument is COMPONENT_NAME_RE-validated (no dots/slashes
  // → no traversal) and whose dir is fixed at module load; gallery_preview additionally returns
  // the entry's EMBEDDED fixtures JSON (parsed, fail-null) — still the same fixed dir, no
  // primitives; install writes go through the same save_component store path with actor
  // "gallery" (provenance stamp; first-party content → local tier, direct render).
  "gallery_list", "gallery_preview", "install_from_gallery",
  // component_permissions: read-only projection of registry rows + tier presets + policy
  // overlays (computeCaps) — same data security_set/settings already expose, no primitives.
  "component_permissions",
  // ui_prefs_schema: returns a static in-engine catalog constant — no store read, no primitives.
  "ui_prefs_schema",
  // render_health: accepts a health report and can only trigger the SAME restore path as
  // restore_component (save_component via store.execute, local-tier + unlocked components only,
  // 3-per-run budget). No fs/shell/socket primitive; worst abuse = rolling a component back to
  // its own earlier version, which restore_component already allows.
  "render_health",
]);
const DYNAMIC_OPEN_RE = /^open_[a-z0-9_]+$/; // per-component open_<name> (dynamic tools)
({ tools } = await client.listTools());
names = tools.map((t) => t.name);
const unknown = names.filter((n) => !KNOWN_SAFE.has(n) && !DYNAMIC_OPEN_RE.test(n));
ok(
  unknown.length
    ? "UNKNOWN TOOL(S) " + unknown.join(", ") + " — new tool detected — extend the known-safe list ONLY after confirming it exposes no OS primitives (docs/security-model.md §1.5)"
    : "tool surface is exactly the known-safe set (+ dynamic open_<name>)",
  unknown.length === 0,
);
ok("every known-safe tool is still registered (no silent removal of the contract)", [...KNOWN_SAFE].every((n) => names.includes(n)));
// the open_ prefix alone must not grant a pass: every dynamic open_* has to map to a REGISTERED
// component (engine.mjs: open_<name.replaceAll("-","_")>) — a static tool named open_url would fail here
const compTools = new Set((await client.callTool({ name: "list_components", arguments: {} })).structuredContent.components.map((c) => "open_" + c.name.replaceAll("-", "_")));
const rogueOpen = names.filter((n) => !KNOWN_SAFE.has(n) && DYNAMIC_OPEN_RE.test(n) && !compTools.has(n));
ok(
  rogueOpen.length
    ? "ROGUE open_* tool(s) not backed by a component: " + rogueOpen.join(", ")
    : "every dynamic open_* maps to a registered component",
  rogueOpen.length === 0,
);

// ORDERING NOTE: sections 14+ save fixture components and delete one. Under OMA_DYNAMIC_TOOLS=1
// a deleted component's open_<name> tool lingers until restart (documented behavior), so the
// rogue-open check in section 13 must keep running BEFORE these sections.

console.log("14. component_history — version metadata only, NEVER the html");
const histHtml1 = noteHtml;
const histHtml2 = noteHtml.replace("<ul", '<ul data-hist-v2=""');
await client.callTool({ name: "save_component", arguments: { name: "hist-probe", html: histHtml1, description: "history probe" } });
await client.callTool({ name: "save_component", arguments: { name: "hist-probe", html: histHtml2, description: "" } });
const hist = await client.callTool({ name: "component_history", arguments: { name: "hist-probe" } });
const hEntries = hist.structuredContent?.history || [];
ok("two saves → two history entries", !hist.isError && hEntries.length === 2);
ok("newest-first ordering", hEntries[0]?.version === 2 && hEntries[1]?.version === 1);
ok("entries carry numeric html_size matching the saved bytes", hEntries[0]?.html_size === histHtml2.length && hEntries[1]?.html_size === histHtml1.length);
ok("entries carry a ts string", hEntries.every((h) => typeof h.ts === "string" && h.ts.length > 0));
ok("history NEVER carries the html itself", hEntries.every((h) => !("html" in h)) && !JSON.stringify(hist.structuredContent).includes("data-hist-v2"));
const histMissing = await client.callTool({ name: "component_history", arguments: { name: "no-such-comp" } });
ok("unknown component → clean error", histMissing.isError === true && /No history/.test(histMissing.content[0].text));

console.log("14b. version rollback — get_component_version reads old html; restore_component rolls forward a copy");
// hist-probe carries v1 (histHtml1, no marker) and v2 (histHtml2, data-hist-v2).
const gv1 = await client.callTool({ name: "get_component_version", arguments: { name: "hist-probe", version: 1 } });
ok("get_component_version v1 returns that version's html", !gv1.isError && gv1.content[0].text.includes("v1 (historical") && !gv1.content[0].text.includes("data-hist-v2"));
const gv2 = await client.callTool({ name: "get_component_version", arguments: { name: "hist-probe", version: 2 } });
ok("get_component_version v2 returns the OTHER version's html", !gv2.isError && gv2.content[0].text.includes("data-hist-v2"));
const gvMissing = await client.callTool({ name: "get_component_version", arguments: { name: "hist-probe", version: 99 } });
ok("unknown version → clean error", gvMissing.isError === true && /No version 99/.test(gvMissing.content[0].text));
const gvNoComp = await client.callTool({ name: "get_component_version", arguments: { name: "no-such-comp", version: 1 } });
ok("unknown component → clean error", gvNoComp.isError === true && /No version 1/.test(gvNoComp.content[0].text));
// restore v1 → re-saved as a NEW current version (v3), history preserved, current html reverts.
const restore = await client.callTool({ name: "restore_component", arguments: { name: "hist-probe", version: 1 } });
ok("restore v1 rolls forward to a new v3 (history preserved)", !restore.isError && /from v1/.test(restore.content[0].text) && /new v3/.test(restore.content[0].text));
const curAfter = await client.callTool({ name: "get_component", arguments: { name: "hist-probe" } });
ok("current source now matches v1 (marker gone)", curAfter.content[0].text.includes("hist-probe v3") && !curAfter.content[0].text.includes("data-hist-v2"));
const histAfter = await client.callTool({ name: "component_history", arguments: { name: "hist-probe" } });
ok("history grew to 3 versions (nothing lost)", !histAfter.isError && histAfter.structuredContent.history.length === 3 && histAfter.structuredContent.history[0].version === 3);
const restoreMissing = await client.callTool({ name: "restore_component", arguments: { name: "hist-probe", version: 99 } });
ok("restore of an unknown version → clean error", restoreMissing.isError === true && /No version 99/.test(restoreMissing.content[0].text));

console.log("15. delete_component — tombstone delete, idempotent replay");
await client.callTool({ name: "save_component", arguments: { name: "doomed", html: noteHtml, description: "delete fixture" } });
// a settings row under the component's group must SURVIVE the delete (no cascade — the
// settings app's Orphaned section is the janitor, docs/settings-design.md §7)
const dPref = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", group: "doomed", fields: { key: "kept_after_delete", value: "yes" } } });
ok("settings row under the doomed group written", !dPref.isError);
const delCmdId = randomUUID();
const del1 = await client.callTool({ name: "delete_component", arguments: { name: "doomed", command_id: delCmdId } });
ok("delete succeeds", !del1.isError && del1.content[0].text.includes('Deleted "doomed"'));
const listAfterDel = await client.callTool({ name: "list_components", arguments: {} });
ok("deleted component gone from list_components", !listAfterDel.structuredContent.components.some((c) => c.name === "doomed"));
const openGone = await client.callTool({ name: "open_component", arguments: { component: "doomed" } });
ok("open_component fails gracefully after delete", openGone.isError === true && /No component "doomed" in the registry/.test(openGone.content[0].text));
const histGone = await client.callTool({ name: "component_history", arguments: { name: "doomed" } });
ok("version history retained as tombstone", !histGone.isError && histGone.structuredContent.history.length === 1);
const sAfterDel = await client.callTool({ name: "data_list", arguments: { collection: "settings" } });
ok("settings items under the component's group survive the delete", sAfterDel.structuredContent.items.some((i) => i.group === "doomed" && i.fields.key === "kept_after_delete"));
const del2 = await client.callTool({ name: "delete_component", arguments: { name: "doomed", command_id: delCmdId } });
ok("same command_id replay is a no-op success (idempotent)", !del2.isError && del2.content[0].text.includes("already deleted"));
const delMissing = await client.callTool({ name: "delete_component", arguments: { name: "never-existed", command_id: randomUUID() } });
ok("deleting an unknown component fails cleanly", delMissing.isError === true && /No component "never-existed" in the registry/.test(delMissing.content[0].text));

console.log("16. save_component scene — valid slug stored, invalid warned + dropped");
const sceneOk = await client.callTool({ name: "save_component", arguments: { name: "scene-probe", html: noteHtml, description: "scene fixture", scene: { category_id: "local-tools", tags: ["probe"] } } });
ok("valid scene saves without a scene warning", !sceneOk.isError && sceneOk.content[0].text.includes('Saved "scene-probe"') && !sceneOk.content[0].text.includes("Unknown scene.category_id"));
const sceneBad = await client.callTool({ name: "save_component", arguments: { name: "scene-bad", html: noteHtml, scene: { category_id: "not-a-real-slug" } } });
ok("invalid category_id → save still succeeds", !sceneBad.isError && sceneBad.content[0].text.includes('Saved "scene-bad"'));
ok("invalid category_id → warning in the result text", /Unknown scene\.category_id "not-a-real-slug"/.test(sceneBad.content[0].text));
const sceneComps = (await client.callTool({ name: "list_components", arguments: {} })).structuredContent.components;
ok("valid scene lands in list_components.category_id", sceneComps.find((c) => c.name === "scene-probe")?.category_id === "local-tools");
ok("dropped scene → category_id null", sceneComps.find((c) => c.name === "scene-bad")?.category_id === null);
ok("scene-less components carry category_id null (uniform schema)", sceneComps.find((c) => c.name === "habit-streaks")?.category_id === null);

console.log("17. trust tiers & caps — component_html carries {author, tier, caps}");
// (a) local tier: seed/agent/human authors run direct with the all-allow preset
const localTier = (await client.callTool({ name: "component_html", arguments: { name: "habit-streaks" } })).structuredContent;
ok("seed-authored → tier local", localTier.author === "seed" && localTier.tier === "local");
ok("local caps: call_tools is the wildcard", Array.isArray(localTier.caps?.call_tools) && localTier.caps.call_tools.length === 1 && localTier.caps.call_tools[0] === "*");
ok("local caps: messaging + settings allowed, delete_items allow", localTier.caps.send_message === true && localTier.caps.update_context === true && localTier.caps.settings_write === true && localTier.caps.delete_items === "allow");
// (b) NON-local fixture: written through a second store handle on the same file. WAL tolerates
// our short-lived writer next to the server's connection; the write is fully committed (handle
// closed) before the next MCP call, so the server's fresh read transaction sees it.
{
  const direct = openStore(DB);
  const r = direct.execute({ type: "save_component", command_id: randomUUID(), name: "library-fixture",
    html: "<!DOCTYPE html><html><body><div id='lib'>library fixture — not locally authored</div></body></html>",
    actor: "library-test" });
  direct.close();
  ok("fixture written directly with author library-test", r.ok === true);
}
const unrev = (await client.callTool({ name: "component_html", arguments: { name: "library-fixture" } })).structuredContent;
ok("unknown author → tier unreviewed", unrev.author === "library-test" && unrev.tier === "unreviewed");
ok("unreviewed caps: empty call_tools, no messaging", unrev.caps.call_tools.length === 0 && unrev.caps.send_message === false && unrev.caps.update_context === false);
ok("unreviewed caps: delete_items deny; cross/settings/source all denied", unrev.caps.delete_items === "deny" && unrev.caps.cross_collection_read === false && unrev.caps.cross_collection_write === false && unrev.caps.settings_write === false && unrev.caps.read_source === false);
// (c) security:<component>:<cap> overlay via the privileged writer flips exactly ONE cap
const ovr = await client.callTool({ name: "security_set", arguments: { key: "security:library-fixture:send_message", value: "allow" } });
ok("security_set writes the per-component overlay row", !ovr.isError);
const unrev2 = (await client.callTool({ name: "component_html", arguments: { name: "library-fixture" } })).structuredContent;
ok("overlay applied: send_message flipped to true", unrev2.caps.send_message === true);
ok("overlay is surgical: everything else keeps the unreviewed preset", unrev2.tier === "unreviewed" && unrev2.caps.call_tools.length === 0 && unrev2.caps.update_context === false && unrev2.caps.delete_items === "deny" && unrev2.caps.settings_write === false);

console.log("18. loader runner branch — chokepoint markers in the served ui:// loader");
const loaderDoc = (await client.readResource({ uri: "ui://open-mcp-apps/app.html" })).contents[0].text;
ok("runner CSP policy present (default/connect/frame all 'none')", loaderDoc.includes("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'"));
ok("child iframe sandboxed with allow-scripts", loaderDoc.includes('frame.setAttribute("sandbox", "allow-scripts")'));
// a prose comment in the loader mentions allow-same-origin — what matters is that no sandbox
// VALUE (setAttribute arg or sandbox= attribute) ever grants it
const sandboxValues = [
  ...loaderDoc.matchAll(/setAttribute\(\s*"sandbox"\s*,\s*"([^"]*)"/g),
  ...loaderDoc.matchAll(/sandbox="([^"]*)"/g),
].map((m) => m[1]);
ok("no sandbox value grants allow-same-origin", sandboxValues.length > 0 && sandboxValues.every((v) => !v.includes("allow-same-origin")));
ok("tier branch: local (or missing tier) mounts direct", loaderDoc.includes('sc.tier == null || sc.tier === "local"') && loaderDoc.includes("return mount(html)"));
ok("non-local tiers route through runnerMount with engine caps", loaderDoc.includes("runnerMount(name, html, sc.caps || {})") && loaderDoc.includes("function runnerMount("));
ok("control-plane denylist present with every registry/policy-mutating tool", loaderDoc.includes("CONTROL_PLANE_DENY") && ["security_set", "save_component", "delete_component", "restore_component", "install_from_gallery", "render_health"].every((n) => loaderDoc.includes('"' + n + '"')));
ok("control-plane deny also covers any future library_* tool", loaderDoc.includes('indexOf("library_") === 0'));
ok("control-plane tools rejected with a clear message", loaderDoc.includes("is not available to components"));
// CSP-first: the runner builds our own <head> with the CSP as the FIRST child; it never anchors
// on the component's own <head> (a pre-<head> script would otherwise run before the policy).
ok("runner builds CSP-first document, not a <head>-anchored splice", loaderDoc.includes('"<!doctype html><html><head>" + RUNNER_CSP') && !/\.replace\(\s*\/<head/.test(loaderDoc.slice(loaderDoc.indexOf("function runnerMount"))));

console.log("19. policy-key naming — snake_case canonical; dotted/unknown stored but inert + warned");
const dottedSet = await client.callTool({ name: "security_set", arguments: { key: "security:habit-streaks:sendMessage", value: "deny" } });
ok("security_set stores an unknown/dotted cap but WARNS", !dottedSet.isError && /send_message|valid cap|unknown cap|snake_case/i.test(dottedSet.content[0].text));
const habitCaps2 = (await client.callTool({ name: "component_html", arguments: { name: "habit-streaks" } })).structuredContent.caps;
ok("dotted cap is inert — computeCaps reads only snake_case (habit-streaks local stays all-allow)", habitCaps2.send_message === true);

console.log("20. save_component scene — change, explicit clear, invalid preserves existing");
await client.callTool({ name: "save_component", arguments: { name: "scene-probe", html: noteHtml, scene: { category_id: "input-cocreate" } } });
const afterChange = (await client.callTool({ name: "list_components", arguments: {} })).structuredContent.components;
ok("scene change updates category_id", afterChange.find((c) => c.name === "scene-probe")?.category_id === "input-cocreate");
await client.callTool({ name: "save_component", arguments: { name: "scene-probe", html: noteHtml, scene: null } });
const afterClear = (await client.callTool({ name: "list_components", arguments: {} })).structuredContent.components;
ok("explicit scene:null CLEARS category_id", afterClear.find((c) => c.name === "scene-probe")?.category_id === null);
await client.callTool({ name: "save_component", arguments: { name: "scene-probe", html: noteHtml, scene: { category_id: "notation" } } });
const badOnExisting = await client.callTool({ name: "save_component", arguments: { name: "scene-probe", html: noteHtml, scene: { category_id: "bogus-slug" } } });
const afterBad = (await client.callTool({ name: "list_components", arguments: {} })).structuredContent.components;
ok("invalid category_id on an existing scene PRESERVES it (honest warning)", /Unknown scene\.category_id/.test(badOnExisting.content[0].text) && afterBad.find((c) => c.name === "scene-probe")?.category_id === "notation");
await client.callTool({ name: "save_component", arguments: { name: "scene-probe", html: noteHtml, scene: null } });

console.log("21. version continuity — delete then recreate keeps history monotonic");
await client.callTool({ name: "save_component", arguments: { name: "ver-probe", html: noteHtml, description: "v1" } });
await client.callTool({ name: "save_component", arguments: { name: "ver-probe", html: histHtml2, description: "v2" } });
await client.callTool({ name: "delete_component", arguments: { name: "ver-probe", command_id: randomUUID() } });
await client.callTool({ name: "save_component", arguments: { name: "ver-probe", html: noteHtml, description: "v3" } });
const verHist = (await client.callTool({ name: "component_history", arguments: { name: "ver-probe" } })).structuredContent.history;
ok("recreate resumes numbering — history monotonic [3,2,1], no v1 REPLACE collision", verHist.map((h) => h.version).join(",") === "3,2,1");

console.log("22. idempotency is bound to the command (type + target)");
const reuseId = randomUUID();
await client.callTool({ name: "save_component", arguments: { name: "reuse-a", html: noteHtml, description: "reuse fixture" } });
const delReuse = await client.callTool({ name: "delete_component", arguments: { name: "reuse-a", command_id: reuseId } });
ok("first delete with the id succeeds", !delReuse.isError);
await client.callTool({ name: "save_component", arguments: { name: "reuse-b", html: noteHtml, description: "second fixture" } });
const reuse = await client.callTool({ name: "delete_component", arguments: { name: "reuse-b", command_id: reuseId } });
ok("reusing a command_id for a DIFFERENT target is rejected (command_id_reused)", reuse.isError === true && /command_id|different command/i.test(reuse.content[0].text));
const stillThere = (await client.callTool({ name: "list_components", arguments: {} })).structuredContent.components;
ok("the different target was left untouched", stillThere.some((c) => c.name === "reuse-b"));

console.log("23. FILE PLANE (store-level) — per-app ref index, quota, OCC, idempotency, isolation");
{
  const fstore = openStore(DB);
  const cid = () => randomUUID();
  const shaA = "a".repeat(64), shaB = "b".repeat(64), shaC = "c".repeat(64);
  const w1 = fstore.execute({ type: "write_file", command_id: cid(), component: "file-test-a", path: "logo.png", sha256: shaA, size: 1024, mime: "image/png" });
  ok("write_file creates a v1 ref", w1.ok && w1.created && w1.meta.version === 1 && w1.meta.sha256 === shaA);
  const m1 = fstore.statFile("file-test-a", "logo.png");
  ok("statFile returns the meta", m1 && m1.size === 1024 && m1.mime === "image/png");
  const w2 = fstore.execute({ type: "write_file", command_id: cid(), component: "file-test-a", path: "logo.png", sha256: shaB, size: 2048, mime: "image/png" });
  ok("overwrite bumps version + reports freed_sha", w2.ok && !w2.created && w2.meta.version === 2 && w2.freed_sha === shaA);
  const wOcc = fstore.execute({ type: "write_file", command_id: cid(), component: "file-test-a", path: "logo.png", sha256: shaC, size: 512, mime: "image/png", expected_version: 1 });
  ok("stale expected_version → conflict", !wOcc.ok && wOcc.conflict === true && wOcc.expected === 2);
  const idc = cid();
  const wi1 = fstore.execute({ type: "write_file", command_id: idc, component: "file-test-a", path: "doc.txt", sha256: shaC, size: 100, mime: "text/plain" });
  const wi2 = fstore.execute({ type: "write_file", command_id: idc, component: "file-test-a", path: "doc.txt", sha256: shaC, size: 100, mime: "text/plain" });
  ok("replayed command_id is idempotent (no new version)", wi1.ok && wi2.idempotent === true && fstore.statFile("file-test-a", "doc.txt").version === 1);
  ok("traversal path rejected", fstore.execute({ type: "write_file", command_id: cid(), component: "file-test-a", path: "../escape", sha256: shaA, size: 1 }).error === "bad_path");
  ok("bad sha256 rejected", fstore.execute({ type: "write_file", command_id: cid(), component: "file-test-a", path: "x.bin", sha256: "nothex", size: 1 }).error === "bad_sha256");
  ok("oversize rejected", fstore.execute({ type: "write_file", command_id: cid(), component: "file-test-a", path: "huge.bin", sha256: shaA, size: 250 * 1024 * 1024 + 1 }).error === "file_too_large");
  fstore.execute({ type: "write_file", command_id: cid(), component: "file-test-b", path: "b-only.dat", sha256: shaA, size: 10 });
  const listA = fstore.listFiles("file-test-a").map((r) => r.path);
  ok("listFiles is per-app scoped (no cross-app leak)", !listA.includes("b-only.dat") && fstore.listFiles("file-test-b").length === 1);
  fstore.execute({ type: "write_file", command_id: cid(), component: "file-test-b", path: "b-copy.dat", sha256: shaA, size: 10 });
  ok("within-app refcount counts a shared sha", fstore.blobRefcount("file-test-b", shaA) === 2);
  const del = fstore.execute({ type: "delete_file", command_id: cid(), component: "file-test-b", path: "b-copy.dat" });
  ok("delete_file frees the sha + drops the ref", del.ok && del.freed_sha === shaA && fstore.statFile("file-test-b", "b-copy.dat") === null && fstore.blobRefcount("file-test-b", shaA) === 1);
  ok("delete of a missing file → not_found", fstore.execute({ type: "delete_file", command_id: cid(), component: "file-test-b", path: "ghost" }).error === "not_found");
  const snapBefore = fstore.snapshot("file-test-a");
  fstore.execute({ type: "write_file", command_id: cid(), component: "file-test-a", path: "another.bin", sha256: shaB, size: 5 });
  const snapAfter = fstore.snapshot("file-test-a");
  ok("files_version bumps on file activity", snapAfter.files_version > snapBefore.files_version);
  ok("settings_version untouched by file activity", snapAfter.settings_version === snapBefore.settings_version);
  // app byte-quota fail-closed — LOGICAL bytes only, so no real bytes are written (the store records the number)
  const big = 250 * 1024 * 1024; // = MAX_FILE_BYTES; 20 × 250MiB = 5000MiB < 5GiB cap, the 21st crosses it
  for (let i = 0; i < 20; i++) fstore.execute({ type: "write_file", command_id: cid(), component: "quota-app", path: "big" + i, sha256: String(i).padStart(64, "0"), size: big });
  const over = fstore.execute({ type: "write_file", command_id: cid(), component: "quota-app", path: "over", sha256: "f".repeat(64), size: big });
  ok("per-app byte quota fails closed at the cap", !over.ok && over.error === "quota_exceeded");
  // OCC create-after-delete must NOT resurrect (review finding 4): a guarded write against a deleted row → conflict
  fstore.execute({ type: "write_file", command_id: cid(), component: "occ-app", path: "c.json", sha256: shaA, size: 10 });
  fstore.execute({ type: "delete_file", command_id: cid(), component: "occ-app", path: "c.json" });
  const resurrect = fstore.execute({ type: "write_file", command_id: cid(), component: "occ-app", path: "c.json", sha256: shaB, size: 10, expected_version: 1 });
  ok("guarded write against a deleted file → conflict (expected 0), NOT silent resurrection", !resurrect.ok && resurrect.conflict === true && resurrect.expected === 0);
  ok("create-if-absent (no expected_version) still works after delete", fstore.execute({ type: "write_file", command_id: cid(), component: "occ-app", path: "c.json", sha256: shaB, size: 10 }).ok);
  // component normalization (finding 5): a whitespace-padded component is rejected consistently, never a false idempotency reuse
  ok("whitespace-padded component rejected as bad_component (no trim asymmetry)", fstore.execute({ type: "write_file", command_id: cid(), component: "padded ", path: "x", sha256: shaA, size: 1 }).error === "bad_component");
  fstore.close();
}

console.log("24. FILE TOOLS (engine) — write/read roundtrip, list, usage, delete, caps seam");
const fcid = () => randomUUID();
const payload = Buffer.from("engine file tools roundtrip ✓ 中文 bytes").toString("base64");
const fw = await client.callTool({ name: "file_write", arguments: { command_id: fcid(), component: "smoke-notes", path: "note.txt", data_base64: payload, mime: "text/plain" } });
ok("file_write stores + returns v1 meta + files_version", !fw.isError && fw.structuredContent.version === 1 && fw.structuredContent.size > 0 && typeof fw.structuredContent.files_version === "number");
const frd = await client.callTool({ name: "file_read", arguments: { component: "smoke-notes", path: "note.txt" } });
ok("file_read returns bytes in structuredContent, NOT the text block", !frd.isError && frd.structuredContent.data_base64 === payload && !frd.content[0].text.includes(payload));
const fls = await client.callTool({ name: "file_list", arguments: { component: "smoke-notes" } });
ok("file_list shows the stored file", !fls.isError && fls.structuredContent.files.some((f) => f.path === "note.txt") && fls.structuredContent.usage.count >= 1);
const fus = await client.callTool({ name: "file_usage", arguments: { component: "smoke-notes" } });
ok("file_usage reports bytes + quota", !fus.isError && fus.structuredContent.bytes > 0 && fus.structuredContent.quota_bytes > 0);
const frdMissing = await client.callTool({ name: "file_read", arguments: { component: "smoke-notes", path: "ghost.txt" } });
ok("file_read of a missing file → clean error", frdMissing.isError === true && /No file/.test(frdMissing.content[0].text));
const fdel = await client.callTool({ name: "file_delete", arguments: { command_id: fcid(), component: "smoke-notes", path: "note.txt" } });
ok("file_delete removes it", !fdel.isError && fdel.structuredContent.deleted === true);
ok("file_read after delete → gone", (await client.callTool({ name: "file_read", arguments: { component: "smoke-notes", path: "note.txt" } })).isError === true);
const fileCaps = await client.callTool({ name: "component_html", arguments: { name: "smoke-notes" } });
ok("component_html caps carry the new file_read/file_write (local tier = both true)", fileCaps.structuredContent.caps.file_read === true && fileCaps.structuredContent.caps.file_write === true);

console.log("25. data_version — the cheapest change probe");
const dv1 = (await client.callTool({ name: "data_version", arguments: {} })).structuredContent;
ok("shape {seq, settings_version, files_version, schema_version: 1}",
  typeof dv1.seq === "number" && typeof dv1.settings_version === "number" &&
  typeof dv1.files_version === "number" && dv1.schema_version === 1);
await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "kanban", group: "To Do", fields: { title: "bump seq for data_version" } } });
const dv2 = (await client.callTool({ name: "data_version", arguments: {} })).structuredContent;
ok("seq strictly increases after one write", dv2.seq > dv1.seq);

console.log("26. data_list paging — limit/cursor/group/match; PLAIN call keeps the full-snapshot contract");
for (let i = 0; i < 12; i++)
  await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "page-probe",
    group: i < 7 ? "g1" : "g2", fields: { title: "pp-" + i, parity: i % 2 === 0 ? "even" : "odd" } } });
const p1 = (await client.callTool({ name: "data_list", arguments: { collection: "page-probe", limit: 5 } })).structuredContent;
ok("{limit:5} → 5 items + next_cursor + total 12", p1.items.length === 5 && typeof p1.next_cursor === "string" && p1.total === 12);
const pageSeen = new Set(p1.items.map((i) => i.id));
let pageCur = p1.next_cursor, lastPage = p1;
while (pageCur) {
  lastPage = (await client.callTool({ name: "data_list", arguments: { collection: "page-probe", limit: 5, cursor: pageCur } })).structuredContent;
  for (const it of lastPage.items) pageSeen.add(it.id);
  pageCur = lastPage.next_cursor;
}
ok("cursor walk visits all 12 unique items and ends next_cursor null", pageSeen.size === 12 && lastPage.next_cursor === null);
const pGrp = (await client.callTool({ name: "data_list", arguments: { collection: "page-probe", group: "g1" } })).structuredContent;
ok("{group} filters to that lane (total is the group's)", pGrp.items.length === 7 && pGrp.items.every((i) => i.group === "g1") && pGrp.total === 7);
const pMatch = (await client.callTool({ name: "data_list", arguments: { collection: "page-probe", match: { parity: "even" } } })).structuredContent;
ok("{match} filters by exact field equality (total stays pre-filter)", pMatch.items.length === 6 && pMatch.items.every((i) => i.fields.parity === "even") && pMatch.total === 12);
const pBad = await client.callTool({ name: "data_list", arguments: { collection: "page-probe", cursor: "@@not-a-cursor@@" } });
ok("bad cursor → clean error", pBad.isError === true && /Invalid cursor/.test(pBad.content[0].text));
const pPlain = (await client.callTool({ name: "data_list", arguments: { collection: "page-probe" } })).structuredContent;
ok("PLAIN data_list keeps the full snapshot (12 items, NO total/next_cursor keys)",
  pPlain.items.length === 12 && !("total" in pPlain) && !("next_cursor" in pPlain));

console.log("27. schema manifests — declared field contracts bind every write; tri-state on re-save");
const manManifest = { collections: { "man-data": { strict: true, fields: {
  title: { type: "string", required: true },
  count: { type: "number" },
  state: { type: "string", enum: ["open", "done"] },
} } } };
const manSave = await client.callTool({ name: "save_component", arguments: { name: "man-probe", html: noteHtml, description: "manifest probe", manifest: manManifest } });
ok("man-probe saved with a manifest", !manSave.isError && /Saved "man-probe"/.test(manSave.content[0].text));
const manAdd = (fields) => client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "man-data", fields } });
const vReq = await manAdd({ count: 1 });
ok("missing required title → schema_violation", vReq.isError === true && /schema_violation/.test(vReq.content[0].text));
const vType = await manAdd({ title: "t", count: "nope" });
ok("wrong type (count as string) → rejected", vType.isError === true && /schema_violation/.test(vType.content[0].text));
const vEnum = await manAdd({ title: "t", state: "bogus" });
ok("enum violation (state bogus) → rejected", vEnum.isError === true && /schema_violation/.test(vEnum.content[0].text));
const vStrict = await manAdd({ title: "t", rogue: "undeclared" });
ok("undeclared field under strict → rejected", vStrict.isError === true && /schema_violation/.test(vStrict.content[0].text));
const vOk = await manAdd({ title: "first", count: 2, state: "open" });
ok("fully valid add succeeds", !vOk.isError && vOk.structuredContent.items.some((i) => i.fields.title === "first"));
const manId = vOk.structuredContent.items.find((i) => i.fields.title === "first").id;
const vMerge = await client.callTool({ name: "data_update_item", arguments: { command_id: randomUUID(), id: manId, fields: { state: "bogus" } } });
ok("update merging to an invalid state → rejected (post-merge validated)", vMerge.isError === true && /schema_violation/.test(vMerge.content[0].text));
const vFree = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "man-free", fields: { anything: "goes" } } });
ok("ungoverned collections stay free-form", !vFree.isError);
const manBad = await client.callTool({ name: "save_component", arguments: { name: "man-probe", html: noteHtml, manifest: { collections: { settings: { fields: { key: { type: "string" } } } } } } });
ok("manifest may not govern settings → bad_manifest", manBad.isError === true && /Invalid manifest/.test(manBad.content[0].text));
await client.callTool({ name: "save_component", arguments: { name: "man-probe", html: noteHtml, description: "resave without manifest key" } });
const vStill = await manAdd({ count: 3 });
ok("manifest OMITTED on re-save → preserved (bad add still rejects)", vStill.isError === true && /schema_violation/.test(vStill.content[0].text));
await client.callTool({ name: "save_component", arguments: { name: "man-probe", html: noteHtml, manifest: null } });
const vFreed = await manAdd({ count: 3 });
ok("manifest:null on re-save → cleared (same add now succeeds)", !vFreed.isError);

console.log("28. gallery — refusal over a local app; real install → first-party content runs LOCAL/direct");
const gl0 = (await client.callTool({ name: "gallery_list", arguments: {} })).structuredContent.entries;
ok(`gallery lists the ${seedCount - 3} shipped apps (system settings/dashboard/gallery excluded)`,
  gl0.length === seedCount - 3 && !gl0.some((e) => ["settings", "dashboard", "gallery"].includes(e.name)));
const gBefore = gl0.find((e) => e.name === "habit-streaks");
ok("seeded habit-streaks shows installed but NOT from_gallery", gBefore?.installed === true && gBefore?.from_gallery === false);
const gRefuse = await client.callTool({ name: "install_from_gallery", arguments: { name: "habit-streaks" } });
ok("install over the seed-authored copy is refused", gRefuse.isError === true && /already exists/.test(gRefuse.content[0].text) && /seed-authored/.test(gRefuse.content[0].text));
await client.callTool({ name: "delete_component", arguments: { name: "habit-streaks", command_id: randomUUID() } });
const gInst = await client.callTool({ name: "install_from_gallery", arguments: { name: "habit-streaks" } });
// OSS decision (Leo 2026-07-24): gallery content is FIRST-PARTY → author "gallery" is a
// provenance stamp mapping to tier LOCAL (direct render), same standing as the user's own
// apps. The runner + review flow stay dormant until the SaaS publishing pipeline.
ok("after delete, install succeeds at tier local (v2 — history continued)",
  !gInst.isError && gInst.structuredContent.tier === "local" && gInst.structuredContent.version === 2);
const gHtml = (await client.callTool({ name: "component_html", arguments: { name: "habit-streaks" } })).structuredContent;
ok("component_html: author gallery → tier local (first-party)", gHtml.author === "gallery" && gHtml.tier === "local");
ok("local caps: full-trust preset (file_read+file_write+send_message all true)", gHtml.caps.file_read === true && gHtml.caps.file_write === true && gHtml.caps.send_message === true);
const gRes = await client.readResource({ uri: "ui://open-mcp-apps/habit-streaks.html" });
ok("direct-mode ui:// resource serves the wrapped component (NOT a runner placeholder)", gRes.contents[0].text.includes("window.oma") && !gRes.contents[0].text.includes("Sandboxed runner required"));
const gAfter = (await client.callTool({ name: "gallery_list", arguments: {} })).structuredContent.entries.find((e) => e.name === "habit-streaks");
ok("gallery_list now shows installed + from_gallery + no update pending", gAfter?.installed === true && gAfter?.from_gallery === true && gAfter?.update_available === false);
const gAgain = await client.callTool({ name: "install_from_gallery", arguments: { name: "habit-streaks" } });
ok("re-install is a friendly no-op (already up to date, not an error)", !gAgain.isError && /already installed and up to date/.test(gAgain.content[0].text) && gAgain.structuredContent.updated === false);

console.log("29. chunked file write — begin/chunk/commit lifecycle over MCP");
const b64 = (s) => Buffer.from(s).toString("base64");
const cBeg = await client.callTool({ name: "file_write_begin", arguments: { component: "smoke-notes" } });
ok("begin → upload_id + limits", !cBeg.isError && typeof cBeg.structuredContent.upload_id === "string" &&
  cBeg.structuredContent.chunk_limit_bytes > 0 && cBeg.structuredContent.file_limit_bytes >= cBeg.structuredContent.chunk_limit_bytes);
const upId = cBeg.structuredContent.upload_id;
const ck1 = await client.callTool({ name: "file_write_chunk", arguments: { upload_id: upId, data_base64: b64("hello ") } });
ok("chunk 1 staged (6 bytes)", !ck1.isError && ck1.structuredContent.bytes === 6);
const ck2 = await client.callTool({ name: "file_write_chunk", arguments: { upload_id: upId, data_base64: b64("world") } });
ok("chunk 2 staged (11 bytes total)", !ck2.isError && ck2.structuredContent.bytes === 11);
const cCommit = await client.callTool({ name: "file_write_commit", arguments: { upload_id: upId, path: "big.bin" } });
ok("commit lands big.bin (size 11, v1, file_write result shape)", !cCommit.isError && cCommit.structuredContent.size === 11 &&
  cCommit.structuredContent.version === 1 && cCommit.structuredContent.component === "smoke-notes" && typeof cCommit.structuredContent.files_version === "number");
const cRead = await client.callTool({ name: "file_read", arguments: { component: "smoke-notes", path: "big.bin" } });
ok("file_read returns the assembled bytes + matching sha", !cRead.isError && cRead.structuredContent.data_base64 === b64("hello world") && cRead.structuredContent.sha256 === cCommit.structuredContent.sha256);
const ckLate = await client.callTool({ name: "file_write_chunk", arguments: { upload_id: upId, data_base64: b64("more") } });
ok("chunk after commit → upload gone", ckLate.isError === true && /No such upload/.test(ckLate.content[0].text));
const cBeg2 = await client.callTool({ name: "file_write_begin", arguments: { component: "smoke-notes" } });
const upId2 = cBeg2.structuredContent.upload_id;
await client.callTool({ name: "file_write_chunk", arguments: { upload_id: upId2, data_base64: b64("doomed") } });
const cAb = await client.callTool({ name: "file_write_abort", arguments: { upload_id: upId2 } });
ok("abort discards the upload", !cAb.isError && cAb.structuredContent.aborted === true);
const cAbCommit = await client.callTool({ name: "file_write_commit", arguments: { upload_id: upId2, path: "never.bin" } });
ok("commit after abort → clean error", cAbCommit.isError === true && /No such upload/.test(cAbCommit.content[0].text));
const cBeg3 = await client.callTool({ name: "file_write_begin", arguments: { component: "smoke-notes" } });
const cEmpty = await client.callTool({ name: "file_write_chunk", arguments: { upload_id: cBeg3.structuredContent.upload_id, data_base64: "" } });
ok("empty chunk rejected", cEmpty.isError === true && /Empty chunk/.test(cEmpty.content[0].text));
await client.callTool({ name: "file_write_abort", arguments: { upload_id: cBeg3.structuredContent.upload_id } });

console.log("30. render_health — auto-revert on a failed mount; stale/healthy/locked/non-local/budget guards");
const rhA = noteHtml.replace('id="l"', 'id="l" data-rh="A-marker"');
const rhB = noteHtml.replace('id="l"', 'id="l" data-rh="B-marker"');
await client.callTool({ name: "save_component", arguments: { name: "rh-probe", html: rhA, description: "render-health probe" } });
await client.callTool({ name: "save_component", arguments: { name: "rh-probe", html: rhB, description: "" } });
const rh1 = await client.callTool({ name: "render_health", arguments: { component: "rh-probe", version: 2, ok: false, error: "boom" } });
ok("failure on current v2 → reverted, restored_version 1, new_version 3",
  !rh1.isError && rh1.structuredContent.reverted === true && rh1.structuredContent.restored_version === 1 && rh1.structuredContent.new_version === 3);
const rhCur = await client.callTool({ name: "get_component", arguments: { name: "rh-probe" } });
ok("current source is v1's html again (marker A, served as v3)", rhCur.content[0].text.includes("rh-probe v3") && rhCur.content[0].text.includes("A-marker") && !rhCur.content[0].text.includes("B-marker"));
const rhStale = await client.callTool({ name: "render_health", arguments: { component: "rh-probe", version: 2, ok: false, error: "boom again" } });
ok("stale report (v2 while current is v3) → ignored", rhStale.structuredContent.reverted === false && /Stale report/.test(rhStale.structuredContent.note));
const rhOk = await client.callTool({ name: "render_health", arguments: { component: "rh-probe", version: 3, ok: true } });
ok("healthy report never reverts", rhOk.structuredContent.reverted === false);
const settingsVer = (await client.callTool({ name: "component_html", arguments: { name: "settings" } })).structuredContent.version;
const rhLock = await client.callTool({ name: "render_health", arguments: { component: "settings", version: settingsVer, ok: false, error: "boom" } });
ok("locked system component is never auto-reverted", rhLock.structuredContent.reverted === false && /Locked/.test(rhLock.structuredContent.note));
// library-fixture (§17b, author "library-test") is the surviving non-local component now that
// gallery installs are first-party/local.
const rhNlVer = (await client.callTool({ name: "component_html", arguments: { name: "library-fixture" } })).structuredContent.version;
const rhNl = await client.callTool({ name: "render_health", arguments: { component: "library-fixture", version: rhNlVer, ok: false, error: "boom" } });
ok("non-local component is never auto-reverted", rhNl.structuredContent.reverted === false && /Non-local/.test(rhNl.structuredContent.note));
// Budget is a HARD 3-per-server-run ceiling: healthy (ok:true) reports do NOT reset it — the
// review round proved a resettable budget is hollow (interleaved ok:true reports allowed 8
// forced reverts). rh1 above consumed 1 of 3, so of the next three break+report cycles only
// TWO revert; the third is refused at the cap.
let budgetReverts = 0;
for (let i = 0; i < 3; i++) {
  await client.callTool({ name: "save_component", arguments: { name: "rh-probe", html: noteHtml.replace('id="l"', `id="l" data-rh="broken-${i}"`), description: "" } });
  const v = (await client.callTool({ name: "component_html", arguments: { name: "rh-probe" } })).structuredContent.version;
  const rep = await client.callTool({ name: "render_health", arguments: { component: "rh-probe", version: v, ok: false, error: "boom " + i } });
  if (rep.structuredContent.reverted === true) budgetReverts++;
}
ok("hard budget: only two more reverts fit (3 total per run; ok:true does NOT reset)", budgetReverts === 2);
await client.callTool({ name: "save_component", arguments: { name: "rh-probe", html: noteHtml.replace('id="l"', 'id="l" data-rh="broken-final"'), description: "" } });
const vFinal = (await client.callTool({ name: "component_html", arguments: { name: "rh-probe" } })).structuredContent.version;
const rhLimit = await client.callTool({ name: "render_health", arguments: { component: "rh-probe", version: vFinal, ok: false, error: "boom final" } });
ok("the next failure hits the 3-per-run budget → refused with a limit note", rhLimit.structuredContent.reverted === false && /Auto-revert limit reached/.test(rhLimit.structuredContent.note));

console.log("31. ui_prefs_schema + component_permissions — the settings pane's data sources");
const prefsShared = (await client.callTool({ name: "ui_prefs_schema", arguments: {} })).structuredContent.shared;
ok("shared catalog has ≥8 entries", Array.isArray(prefsShared) && prefsShared.length >= 8);
const wpsPref = prefsShared.find((p) => p.key === "widget_poll_seconds");
ok("widget_poll_seconds is a number pref", wpsPref?.type === "number");
const proPref = prefsShared.find((p) => p.key === "proactivity");
ok("proactivity is an enum with 2 options", proPref?.type === "enum" && Array.isArray(proPref.options) && proPref.options.length === 2);
const perms = (await client.callTool({ name: "component_permissions", arguments: {} })).structuredContent.components;
const permSettings = perms.find((c) => c.name === "settings");
ok("settings: locked:true, tier local", permSettings?.locked === true && permSettings?.tier === "local");
const permHabit = perms.find((c) => c.name === "habit-streaks");
ok("habit-streaks (gallery-installed): tier local, full file caps (first-party)", permHabit?.tier === "local" && permHabit?.caps.file_read === true && permHabit?.caps.file_write === true);

await client.close();

console.log("32. package barrel + embed hooks (the library-consumer surface)");
const barrel = await import("../index.mjs");
ok("barrel exposes the embed surface", typeof barrel.openStore === "function" && typeof barrel.createEngine === "function" &&
  typeof barrel.wrapComponent === "function" && typeof barrel.wrapLoader === "function" &&
  typeof barrel.tierOf === "function" && typeof barrel.openFileChannel === "function" &&
  typeof barrel.seedSystemComponents === "function" && typeof barrel.GUIDE === "string");
// brandCss was removed (dead API + a </style>-breakout XSS vector): a component-supplied brand
// layer must NEVER be injectable into a served widget. Passing it is now inert.
const plain32 = barrel.wrapComponent("<div>x</div>", {});
const branded32 = barrel.wrapComponent("<div>x</div>", { brandCss: "</style><script>1</script>" });
ok("brandCss removed: no brand style block, and a passed value can't inject markup",
  !plain32.includes('data-oma="brand"') && !branded32.includes('data-oma="brand"') &&
  !branded32.includes("<script>1</script>"));
ok("wrapLoader emits no brand layer", !barrel.wrapLoader().includes('data-oma="brand"'));
// tokens: the SUPPORTED way for an embedder to supply the host token layer brandCss was reaching
// for. A map, validated on both halves — the breakout brandCss allowed must be impossible here,
// and an invalid name or value is a hard error rather than a silently dropped declaration.
const toked32 = barrel.wrapComponent("<div>x</div>", {
  tokens: { "--color-text-info": "#326E64", "--color-ring-primary": "light-dark(#326E64, #58b0a0)" },
});
ok("tokens: emitted as one :root block AFTER the neutral fallbacks (so the embedder wins)",
  toked32.includes('<style data-oma="host-tokens">:root{--color-text-info:#326E64;--color-ring-primary:light-dark(#326E64, #58b0a0)}</style>') &&
  toked32.indexOf('data-oma="tokens"') < toked32.indexOf('data-oma="host-tokens"'));
ok("tokens: absent/empty emits nothing", !plain32.includes("host-tokens") &&
  !barrel.wrapComponent("<div>x</div>", { tokens: {} }).includes("host-tokens"));
const tokenThrows = (tokens) => {
  try { barrel.wrapComponent("<div>x</div>", { tokens }); return false; } catch { return true; }
};
ok("tokens: </style> breakout in a VALUE throws (the exact brandCss vector)",
  tokenThrows({ "--x": "red</style><script>1</script>" }));
ok("tokens: declaration-splitting via ; or } in a value throws",
  tokenThrows({ "--x": "red;color:blue" }) && tokenThrows({ "--x": "red}body{display:none" }));
ok("tokens: a non custom-property name throws (can't smuggle a selector)",
  tokenThrows({ color: "red" }) && tokenThrows({ "--A": "red" }) && tokenThrows({ "}body{color": "red" }));
ok("tokens: a non-object throws", tokenThrows("--x:red") && tokenThrows(["--x"]));
// createEngine opts over an in-memory transport pair — the hosted-embed path (no stdio, no http).
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const store32 = barrel.openStore(DB);
const eng32 = barrel.createEngine(store32, { hostLabel: "embed-test", instructions: "HOSTED INSTRUCTIONS ONLY" });
const [ct32, st32] = InMemoryTransport.createLinkedPair();
const c32 = new Client({ name: "embed", version: "1.0.0" });
await eng32.connect(st32);
await c32.connect(ct32);
ok("instructions override replaces the default wholesale", c32.getInstructions?.() === "HOSTED INSTRUCTIONS ONLY");
const loader32 = await c32.readResource({ uri: "ui://open-mcp-apps/app.html" });
ok("served loader carries no brand layer", !loader32.contents[0].text.includes('data-oma="brand"'));
await c32.close();
store32.close();

for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
