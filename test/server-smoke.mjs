// test/server-smoke.mjs — end-to-end proof of the ENGINE over real stdio.
// Covers the creation loop itself: seed components present → generic data flow →
// save_component at runtime → the open_<name> tool appears dynamically → shell-wrapped ui://.
// Run: node test/server-smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { openStore } from "../src/store.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "smoke.db");
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

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

console.log("1. seed components are live as dynamic tools");
let { tools } = await client.listTools();
let names = tools.map((t) => t.name);
ok("open_kanban + open_todo exist", names.includes("open_kanban") && names.includes("open_todo"));
ok("engine tools exist", ["get_component_guide", "list_components", "save_component", "get_component", "data_add_item", "data_move_item"].every((n) => names.includes(n)));
const openKanban = tools.find((t) => t.name === "open_kanban");
ok("open_kanban carries ui://", openKanban?._meta?.ui?.resourceUri === "ui://open-mcp-apps/kanban.html");
ok("data tools carry NO ui://", !tools.find((t) => t.name === "data_add_item")?._meta?.ui?.resourceUri);

console.log("2. ui:// resource is shell-wrapped");
const res = await client.readResource({ uri: "ui://open-mcp-apps/kanban.html" });
const doc = res.contents[0];
ok("MIME correct", doc.mimeType === "text/html;profile=mcp-app");
ok("shell runtime injected", doc.text.includes('data-oma="runtime"') && doc.text.includes("window.oma"));
ok("design tokens injected", doc.text.includes('data-oma="tokens"'));
ok("component markup present", doc.text.includes('id="board"'));

console.log("3. generic data flow (kanban semantics)");
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
const open = await client.callTool({ name: "open_kanban", arguments: {} });
ok("open_kanban returns the same collection", open.structuredContent.collection === "kanban" && open.structuredContent.items.length === 1);
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
const noKiosk = await client.callTool({ name: "save_component", arguments: { name: "static-test", html: "<!DOCTYPE html><html><body><h1>static</h1>no oma here, just markup filling the minimum size…</body></html>" } });
ok("no-oma warned", noKiosk.content[0].text.includes("never references the oma API"));

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
ok("scene-less components carry category_id null (uniform schema)", sceneComps.find((c) => c.name === "kanban")?.category_id === null);

console.log("17. trust tiers & caps — component_html carries {author, tier, caps}");
// (a) local tier: seed/agent/human authors run direct with the all-allow preset
const localTier = (await client.callTool({ name: "component_html", arguments: { name: "kanban" } })).structuredContent;
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
ok("control-plane denylist present with all four members", loaderDoc.includes("CONTROL_PLANE_DENY") && ["security_set", "save_component", "delete_component", "library_install"].every((n) => loaderDoc.includes('"' + n + '"')));
ok("control-plane deny also covers any future library_* tool", loaderDoc.includes('indexOf("library_") === 0'));
ok("control-plane tools rejected with a clear message", loaderDoc.includes("is not available to components"));
// CSP-first: the runner builds our own <head> with the CSP as the FIRST child; it never anchors
// on the component's own <head> (a pre-<head> script would otherwise run before the policy).
ok("runner builds CSP-first document, not a <head>-anchored splice", loaderDoc.includes('"<!doctype html><html><head>" + RUNNER_CSP') && !/\.replace\(\s*\/<head/.test(loaderDoc.slice(loaderDoc.indexOf("function runnerMount"))));

console.log("19. policy-key naming — snake_case canonical; dotted/unknown stored but inert + warned");
const dottedSet = await client.callTool({ name: "security_set", arguments: { key: "security:kanban:sendMessage", value: "deny" } });
ok("security_set stores an unknown/dotted cap but WARNS", !dottedSet.isError && /send_message|valid cap|unknown cap|snake_case/i.test(dottedSet.content[0].text));
const kanbanCaps2 = (await client.callTool({ name: "component_html", arguments: { name: "kanban" } })).structuredContent.caps;
ok("dotted cap is inert — computeCaps reads only snake_case (kanban local stays all-allow)", kanbanCaps2.send_message === true);

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

await client.close();
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
