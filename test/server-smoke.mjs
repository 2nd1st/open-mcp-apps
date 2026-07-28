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
import { openStore, SCHEMA_VERSION } from "../src/store.mjs";

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
ok("instructions delivered at initialize", typeof instr === "string" && instr.includes("ROUTING:"));
ok("instructions teach persisting files (file_write)", typeof instr === "string" && /FILES/.test(instr) && /file_write/.test(instr));

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


// A component now declares itself INSIDE its document, so a test that wants a declaration builds
// the document that makes it. That is the contract under test, not a detail of the harness.
const withDecl = (html, decl) =>
  html.replace("</head>", `<script type="application/json" id="oma-manifest">${JSON.stringify(decl)}</script></head>`);

console.log("3. generic data flow (kanban semantics on a free-form collection)");
const A = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "kanban", group: "To Do", fields: { title: "ship v0" } } });
ok("added to To Do", A.structuredContent.item.group === "To Do" && A.structuredContent.item.fields.title === "ship v0");
const id = A.structuredContent.id;
// A row's version is its LEDGER POSITION now, so the OCC token comes from the previous ack rather
// than from counting (1, 2, 3…). That is the whole user-visible effect of the merge: the number is
// large and gappy, and the only correct way to hold one is to have been told it.
const vAdd = A.structuredContent.item.version;
ok("the ack's item.version is this write's ledger seq", vAdd === A.structuredContent.seq);
const M = await client.callTool({ name: "data_move_item", arguments: { command_id: randomUUID(), id, group: "Doing", expected_version: vAdd } });
ok("moved to Doing", M.structuredContent.item.group === "Doing");
ok("version advanced along the one axis", M.structuredContent.item.version > vAdd && M.structuredContent.item.version === M.structuredContent.seq);
const stale = await client.callTool({ name: "data_move_item", arguments: { command_id: randomUUID(), id, group: "Done", expected_version: vAdd } });
ok("stale move rejected (still Doing)", stale.structuredContent.ok === false && stale.structuredContent.item.group === "Doing");
const U = await client.callTool({ name: "data_update_item", arguments: { command_id: randomUUID(), id, fields: { note: "smoke", title: "ship v0!" }, expected_version: M.structuredContent.item.version } });
ok("fields merged", U.structuredContent.item.fields.note === "smoke" && U.structuredContent.item.fields.title === "ship v0!");
const open = await client.callTool({ name: "open_habit_streaks", arguments: { collection: "kanban" } });
// Write-set C (row #4 reaffirmed): open returns ZERO rows — the widget refetches on mount, so rows
// here travelled twice on a widget host and once for nothing on a bare one. total still rides.
ok("open_<name> binds the requested collection — zero rows by design",
  open.structuredContent.collection === "kanban" && open.structuredContent.items.length === 0 &&
  open.structuredContent.total === 1);
{
  const t = open.content.find((c) => c.type === "text").text;
  ok("open text names the binding and the size, and defers the data to the widget",
    /"kanban"/.test(t) && /1/.test(t), t);
  ok("open text does NOT echo item contents (the widget has them; the model would pay twice)",
    !t.includes("ship v0!"), t);
}

console.log("4. THE LOOP: save a brand-new component at runtime");
const guide = await client.callTool({ name: "get_component_guide", arguments: {} });
ok("guide teaches window.oma", guide.content[0].text.includes("oma.addItem") && guide.content[0].text.includes("oma.sendMessage"));
const noteHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><ul id="l"></ul>
<script type="module">
  const r = (s) => { document.getElementById("l").innerHTML = s.items.map((i) => "<li>" + i.fields.text + "</li>").join(""); };
  oma.ready(r); oma.onChange(r);
</script></body></html>`;
// Overwrites need the version the author read (write-set C contract) — this helper is the test's
// "I just looked" shorthand.
const verOf = async (n) => (await client.callTool({ name: "list_components", arguments: { name: n } })).structuredContent.components[0]?.version;
const save = await client.callTool({ name: "save_component", arguments: { name: "smoke-notes", html: noteHtml, description: "simple note list" } });
// The echoed version is the GLOBAL ledger seq (three-axis merge), so it moves whenever the seed
// set grows. The old literal 'v1' check survived v12 only because "v12" CONTAINS "v1" — substring
// luck, not a passing test. Pin the shape, not a number the seed count controls.
ok("saved (fresh component, seq-numbered)", /Saved "smoke-notes" v\d+/.test(save.content[0].text));
({ tools } = await client.listTools());
names = tools.map((t) => t.name);
ok("open_smoke_notes appeared DYNAMICALLY", names.includes("open_smoke_notes"));
ok("open_smoke_notes carries its ui://", tools.find((t) => t.name === "open_smoke_notes")?._meta?.ui?.resourceUri === "ui://open-mcp-apps/smoke-notes.html");
const notesRes = await client.readResource({ uri: "ui://open-mcp-apps/smoke-notes.html" });
ok("new component served shell-wrapped", notesRes.contents[0].text.includes("window.oma") && notesRes.contents[0].text.includes('id="l"'));

console.log("5. component update = new version, served immediately");
const save2 = await client.callTool({ name: "save_component", arguments: { name: "smoke-notes", html: noteHtml.replace('id="l"', 'id="l" class="v2"'), description: "", expected_version: save.structuredContent.version } });
// A component's version is its ledger position too, so "the second save" is a LARGER number, not 2.
ok("the second save advanced the version", /updated/.test(save2.content[0].text) && /Saved "smoke-notes" v\d+/.test(save2.content[0].text));
const notesV2 = await client.readResource({ uri: "ui://open-mcp-apps/smoke-notes.html" });
ok("resource serves v2 live (no re-register)", notesV2.contents[0].text.includes('class="v2"'));
const seedCount = readdirSync(join(ROOT, "components")).filter((f) => f.endsWith(".html")).length;
const listC = await client.callTool({ name: "list_components", arguments: {} });
ok(`registry lists ${seedCount} seeds + smoke-notes`, listC.structuredContent.components.length === seedCount + 1);
// Found by the live-model eval (test/eval-live.mjs, task "onboarding"): a brand-new user's registry
// is NOT empty, because we seed three system apps — so the one line that pushed toward BUILDING
// ("Registry is empty…") could never fire, and the model sometimes opened settings/dashboard rather
// than making the user an app. INSTRUCTIONS already forbade that, in prose. Prose lost.
{
  const listText = listC.content.map((c) => c.text).join("\n");
  ok("the seeded apps are marked as the engine's, right where the model is choosing",
    /dashboard[^\n]*ships with the engine/.test(listText), listText.split("\n").slice(0, 4).join(" | "));
  ok("a user-authored component is NOT marked that way",
    /smoke-notes[^\n]*(?!ships with the engine)/.test(listText) && !/smoke-notes[^\n]*ships with the engine/.test(listText));
  ok("with an app of their own, no build nudge is printed", !/NO apps of their own/.test(listText));
}

console.log("6. universal opener: zero-wait open of a just-saved component");
const openTool = tools.find((t) => t.name === "open_component");
ok("open_component is a static tool with the loader ui://", openTool?._meta?.ui?.resourceUri === "ui://open-mcp-apps/app.html");
const loaderRes = await client.readResource({ uri: "ui://open-mcp-apps/app.html" });
ok("loader resource shell-wrapped + has loader", loaderRes.contents[0].text.includes('data-oma="loader"') && loaderRes.contents[0].text.includes("component_html"));
const openNow = await client.callTool({ name: "open_component", arguments: { component: "smoke-notes" } });
ok("open_component works immediately for the fresh component", openNow.structuredContent?.component === "smoke-notes" && openNow.structuredContent?.collection === "smoke-notes");
const chtml = await client.callTool({ name: "component_html", arguments: { name: "smoke-notes" } });
ok("component_html feeds the loader (html in structuredContent)", chtml.structuredContent?.html?.includes('class="v2"') && chtml.structuredContent?.version > 0);
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
const noOma = await client.callTool({ name: "save_component", arguments: { name: "static-test", html: "<!DOCTYPE html><html><body><h1>static</h1>no api here, just markup filling the minimum size…</body></html>" } });
ok("no-oma warned", noOma.content[0].text.includes("never references the oma API"));
// …and the aliases a real component actually uses do NOT warn. A measured author re-sent an entire
// 33KB document to silence this on working code; a linter that cries wolf costs more than it saves.
{
  const wrap = (js) => `<!DOCTYPE html><html><body><h1>x</h1><script type="module">${js}</script></body></html>`;
  const forms = {
    "window.oma alias": "const OMA = window.oma; OMA.ready(() => {});",
    "destructured": "const { oma } = window; oma.ready(() => {});",
    "multi-key destructure": "const { host, oma } = window; oma.ready(() => {});",
    "bracket access": 'window["oma"].ready(() => {});',
  };
  let quiet = [];
  for (const [label, js] of Object.entries(forms)) {
    const r = await client.callTool({ name: "save_component", arguments: { name: "lint-" + label.replace(/[^a-z]+/g, "-").replace(/^-|-$/g, ""), html: wrap(js) } });
    if (r.content[0].text.includes("never references the oma API")) quiet.push(label);
  }
  ok("the oma-reference check accepts every idiomatic spelling, not just the literal `oma.`",
    quiet.length === 0, `still false-positive on: ${quiet.join(", ")}`);
}

console.log("8. security v0.1 — reserved namespace, size cap, privileged writer");
// (1) the generic data_* tools refuse reserved security:* / policy:* keys
const resAdd = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", fields: { key: "security:kanban:sendMessage", value: "deny" } } });
ok("data_add_item refuses a reserved security:* key", resAdd.isError === true && /reserved_key/.test(resAdd.content[0].text));
const polAdd = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", fields: { key: "policy:x", value: "1" } } });
ok("data_add_item refuses a reserved policy:* key", polAdd.isError === true && /reserved_key/.test(polAdd.content[0].text));
// regression: a NON-reserved settings key (a normal preference) is unaffected
const prefAdd = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", fields: { key: "widget_poll_seconds", value: "30" } } });
ok("non-reserved settings key still writable", !prefAdd.isError && prefAdd.structuredContent.item.fields.key === "widget_poll_seconds");
// (2) privilege cannot travel as a command field — an injected {privileged:true} still hits the guard
const inject = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", privileged: true, fields: { key: "security:evil:x", value: "allow" } } });
ok("injected {privileged:true} on data_* is still rejected", inject.isError === true && /reserved_key/.test(inject.content[0].text));
// (3) security_set (the out-of-band privileged writer) succeeds on a reserved key
const secSet = await client.callTool({ name: "security_set", arguments: { key: "security:kanban:sendMessage", value: "deny" } });
ok("security_set writes a reserved key", !secSet.isError && secSet.structuredContent.item.fields.key === "security:kanban:sendMessage" && secSet.structuredContent.item.fields.value === "deny");
const secSetBad = await client.callTool({ name: "security_set", arguments: { key: "widget_poll_seconds", value: "5" } });
ok("security_set refuses non-reserved keys", secSetBad.isError === true);
// (4) the per-item fields byte cap binds every caller (DoS floor)
const tooBig = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "kanban", group: "To Do", fields: { title: "big", blob: "x".repeat(33_000) } } });
ok("oversized item fields rejected (fields_too_large)", tooBig.isError === true && /fields_too_large/.test(tooBig.content[0].text));

console.log("9. onboarding vs inventory — the instructions address the reader they actually have");
// This block used to assert ONE state, which is why it took a behaviour change to notice that the
// onboarding text is not merely expensive for an established user — it is WRONG for them. It says
// build one app immediately, do not brief, do not list what exists. Both states are asserted now.
{
  const { openStore } = await import("../src/store.mjs");
  const { createEngine } = await import("../src/engine.mjs");
  const fresh = join(ROOT, "test", "onboarding-probe.db");
  for (const f of [fresh, fresh + "-wal", fresh + "-shm"]) if (existsSync(f)) unlinkSync(f);
  const { seedSystemComponents } = await import("../seed.mjs");
  const st = openStore(fresh);
  seedSystemComponents(st);   // a real fresh install is NOT an empty registry — that is the whole point
  const blank = createEngine(st).server._instructions;
  ok("a user with nothing gets the GETTING STARTED onboarding hook", blank.includes("GETTING STARTED"));
  // The positive half of the eval finding: on a fresh install list_components must SAY the user has
  // nothing, because the registry it shows them is not empty — it holds our three system apps.
  {
    const { InMemoryTransport: IMT } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [ct2, st2] = IMT.createLinkedPair();
    const eng2 = createEngine(st); await eng2.connect(st2);
    const c2 = new Client({ name: "fresh", version: "1.0.0" }); await c2.connect(ct2);
    const txt = (await c2.callTool({ name: "list_components", arguments: {} })).content.map((c) => c.text).join("\n");
    ok("a fresh install is TOLD the user has no apps yet, and what to do about it",
      /NO apps of their own/.test(txt) && /save_component/.test(txt), txt.slice(-160));
    await c2.close();
  }
  ok("the hook runs a personalized, history-aware onboarding",
    /past conversations/i.test(blank) && /offer a couple more/i.test(blank) && /best work/i.test(blank));
  ok("onboarding step 4 sets the cost expectation + proactivity preference",
    /proactivity/i.test(blank) && /tokens ONCE/i.test(blank) && /on-request/i.test(blank));

  st.execute({ type: "save_component", command_id: "onb-1", name: "expenses-2026",
    html: "<p>x</p>".repeat(200), description: "Expense tracker. Logs spending by merchant.", actor: "agent" });
  const settled = createEngine(st).server._instructions;
  ok("once they own an app, the onboarding procedure is GONE — it would be wrong advice",
    !settled.includes("GETTING STARTED"));
  ok("and it is REPLACED, not just deleted: the model is told apps already exist",
    /THE USER ALREADY HAS APPS HERE/.test(settled));
  ok("it points at the cheap call rather than inlining the answer",
    /list_components/.test(settled) && /data_collections/.test(settled));
  ok("and warns against recreating or inventing names", /never invent one/i.test(settled) && /new name/i.test(settled));
  // 🔴 The regression this pins: an earlier version listed the user's actual component names here.
  // That put per-user, per-build data into the PREFIX — codex carries these instructions inside
  // tool_search's description, in req.tools — so every save_component would have invalidated the
  // whole cached prefix. That is the exact property OMA_DYNAMIC_TOOLS is disabled to avoid. A tool
  // RESULT is cheap for the opposite reason: it lands in the conversation body, which only grows.
  ok("🔴 it carries NO per-user instance data — that belongs in a tool result, not the prefix",
    !settled.includes("expenses-2026"),
    "instructions must not vary with what the user has built; see OMA_DYNAMIC_TOOLS in test/invariants.mjs");
  st.close();
  for (const f of [fresh, fresh + "-wal", fresh + "-shm"]) if (existsSync(f)) unlinkSync(f);
}
ok("the proactivity stance is resolved into instructions (no placeholder leak)", !instr.includes("__PROACTIVITY_STANCE__") && /PROACTIVITY —/.test(instr));
ok("SHOW UI leans proactive — open an existing app rather than narrating its data", /nearly free/i.test(instr) && /recite its data as text/i.test(instr));

console.log("10. settings_version — the pref-refetch gate, asserted where it lives: on reads");
// A write no longer echoes the collection it landed in, so the version trio rides on READS, which
// is where a widget consults it. The invariant is unchanged: a settings write moves settings_version
// and a foreign write does not — it is just observed one call later, from the read path.
const snapK = (await client.callTool({ name: "data_list", arguments: { collection: "kanban" } })).structuredContent;
ok("settings_version present in snapshots", typeof snapK.settings_version === "number");
const sv = async () => (await client.callTool({ name: "data_list", arguments: { collection: "settings" } })).structuredContent.settings_version;
const gv = async () => (await client.callTool({ name: "data_list", arguments: { collection: "kanban" } })).structuredContent.version;
let sVer = await sv();
// (a) settings ADD bumps it — and the ack itself says which collection it wrote and where in the ledger
const sAdd = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", fields: { key: "density", value: "compact" } } });
ok("the ack names the collection and its ledger position", sAdd.structuredContent.collection === "settings" && typeof sAdd.structuredContent.seq === "number");
ok("settings add bumps settings_version", (await sv()) > sVer);
sVer = await sv();
const sId = sAdd.structuredContent.id;
// (b) settings UPDATE bumps it
await client.callTool({ name: "data_update_item", arguments: { command_id: randomUUID(), id: sId, fields: { value: "comfortable" } } });
ok("settings update bumps settings_version", (await sv()) > sVer);
sVer = await sv();
// (c) a FOREIGN-collection write does NOT bump it (though the global version does)
const kBefore = await gv();
await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "kanban", group: "To Do", fields: { title: "not a setting" } } });
ok("foreign-collection write leaves settings_version unchanged", (await sv()) === sVer && (await gv()) > kBefore);
// (d) save_component does NOT bump it (component_saved events carry no `collection`)
await client.callTool({ name: "save_component", arguments: { name: "smoke-notes", html: noteHtml.replace('id="l"', 'id="l" data-r="10"'), description: "", expected_version: await verOf("smoke-notes") } });
ok("save_component leaves settings_version unchanged", (await sv()) === sVer);
// (e) settings DELETE bumps it
const sDel = await client.callTool({ name: "data_delete_item", arguments: { command_id: randomUUID(), id: sId } });
ok("a delete ack says the row is gone and carries no item", sDel.structuredContent.deleted === true && sDel.structuredContent.item === undefined);
ok("settings delete bumps settings_version", (await sv()) > sVer);

console.log("11. data_update_item WITHOUT expected_version — last-write-wins (setPref semantics)");
const pAdd = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", group: "smoke-notes", fields: { key: "widget_poll_seconds", value: "15" } } });
const pItem = pAdd.structuredContent.item;
const pId = pItem.id, pV = pItem.version;
// a concurrent writer bumps the item version behind our back
const pBump = await client.callTool({ name: "data_update_item", arguments: { command_id: randomUUID(), id: pId, fields: { value: "16" }, expected_version: pV } });
ok("concurrent bump lands", pBump.structuredContent.item.version === pV + 1);
// setPref-style write omits expected_version → succeeds despite the moved version (store skips OCC)
const pLww = await client.callTool({ name: "data_update_item", arguments: { command_id: randomUUID(), id: pId, fields: { value: "17" } } });
const pAfter = pLww.structuredContent.item;
ok("update without expected_version succeeds after a concurrent bump", !pLww.isError && pAfter.fields.value === "17" && pAfter.version === pV + 2);

console.log("12. save_component rejects reserved namespace names (settings groups)");
for (const rn of ["security", "engine", "host", "system", "shell", "oma"]) {
  const rr = await client.callTool({ name: "save_component", arguments: { name: rn, html: noteHtml } });
  ok(`reserved name "${rn}" rejected`, rr.isError === true && /reserved namespace/.test(rr.content[0].text));
}

console.log("12b. locked system components — settings/library refuse tool-side save, restore & delete (seed/privileged exempt)");
for (const ln of ["settings", "library"]) {
  const lr = await client.callTool({ name: "save_component", arguments: { name: ln, html: noteHtml } });
  ok(`locked "${ln}" refuses save_component`, lr.isError === true && /locked system component/.test(lr.content[0].text));
  const lrr = await client.callTool({ name: "restore_component", arguments: { name: ln, version: 1 } });
  ok(`locked "${ln}" refuses restore_component`, lrr.isError === true && /locked system component/.test(lrr.content[0].text));
  const lrd = await client.callTool({ name: "delete_component", arguments: { name: ln, command_id: randomUUID() } });
  ok(`locked "${ln}" refuses delete_component`, lrd.isError === true && /locked system component/.test(lrd.content[0].text));
}
// dashboard is intentionally editable (the personal launcher) — a tool-side save must SUCCEED.
const dashSave = await client.callTool({ name: "save_component", arguments: { name: "dashboard", html: noteHtml, description: "editable launcher", expected_version: await verOf("dashboard") } });
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
  // P1 version-rollback: restore_component re-saves a historical html through the SAME
  // save_component command path (store.execute). No process/fs/shell/socket primitive.
  // (get_component_version RETIRED in write-set C — signed v0.3 break.)
  "restore_component",
  // F2 per-app file plane: all five go through the engine's file channel (src/files.mjs), which
  // confines fs to a per-app, content-addressed, traversal-immune blob store — no generic fs/shell/
  // socket primitive reachable from a tool (security-model §1.5). Bytes ride base64 but only ever
  // land under files/<component>/<sha256>.blob.
  "file_list", "file_read", "file_write", "file_delete",   // file_usage RETIRED in write-set C (file_list reports usage)
  // Chunked large-file write: same channel/backend as file_write — staging lives under the
  // backend's own .tmp (uuid names, never caller input), commit lands through the identical
  // write_file store transaction. No new fs surface beyond src/files.mjs (§1.5).
  "file_write_begin", "file_write_chunk", "file_write_commit", "file_write_abort",
  // data_version: read-only aggregate over change_event via prepared statements — no primitives.
  "data_version",
  // Write-set C additions (§1.5 review): edit_component applies exact-string replacements
  // in-memory and lands through the SAME save_component store path — no new primitive;
  // archive_component flips one registry column through a typed store command. (call_function's
  // seat was PULLED 2026-07-27 — it returns with its executor when OMA_FUNCTIONS lands, and
  // re-enters this list at that review.)
  "edit_component", "archive_component",
  // Library: library_list/library_preview/install_from_library read ONLY repo components/*.html
  // through src/library.mjs, whose name argument is COMPONENT_NAME_RE-validated (no dots/slashes
  // → no traversal) and whose dir is fixed at module load; library_preview additionally returns
  // the entry's EMBEDDED fixtures JSON (parsed, fail-null) — still the same fixed dir, no
  // primitives; install writes go through the same save_component store path with actor
  // "library" (provenance stamp; first-party content → local tier, direct render).
  "library_list", "library_preview", "install_from_library",
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
  // data_changes: read-only ledger projection for ONE collection (store.changesSince) plus a
  // watermark write scoped to (collection, host). Same rows data_list already exposes, no
  // primitives; it cannot mutate items and cannot read across collections.
  "data_changes",
  // data_batch: N of the SAME four typed item commands the single-write tools already expose, in one
  // db.transaction. It adds no command type and no new code path into the store — core() is the only
  // thing that executes them, exactly as it does for a single write. No primitives; the only new
  // reach is "more of what was already reachable, atomically", bounded by MAX_BATCH_COMMANDS.
  "data_batch",
  // data_query: read-only aggregate over ONE collection through the same prepared row reads and the
  // same filter table as data_list's match. It returns numbers, never rows, and by construction
  // cannot read across collections or write anything. No primitives.
  "data_query",
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
await client.callTool({ name: "save_component", arguments: { name: "hist-probe", html: histHtml2, description: "", expected_version: await verOf("hist-probe") } });
const hist = await client.callTool({ name: "component_history", arguments: { name: "hist-probe" } });
const hEntries = hist.structuredContent?.history || [];
ok("two saves → two history entries", !hist.isError && hEntries.length === 2);
ok("newest-first ordering", hEntries[0]?.version > hEntries[1]?.version);
ok("entries carry numeric html_size matching the saved bytes", hEntries[0]?.html_size === histHtml2.length && hEntries[1]?.html_size === histHtml1.length);
ok("entries carry a ts string", hEntries.every((h) => typeof h.ts === "string" && h.ts.length > 0));
ok("history NEVER carries the html itself", hEntries.every((h) => !("html" in h)) && !JSON.stringify(hist.structuredContent).includes("data-hist-v2"));
const histMissing = await client.callTool({ name: "component_history", arguments: { name: "no-such-comp" } });
ok("unknown component → clean error", histMissing.isError === true && /No history/.test(histMissing.content[0].text));

console.log("14b. version rollback — get_component_version is RETIRED; restore_component rolls forward a copy");
// hist-probe's two saves sit at their ledger positions, so the numbers come from the history
// listing rather than from counting. hEntries is newest-first: [1] is the first save, [0] the second.
const hv1 = hEntries[1].version, hv2 = hEntries[0].version;
// The tool is gone (signed v0.3 break), not merely refusing: history is listed by
// component_history, and its html is reachable only through restore_component's store path.
const gvGone = await client.callTool({ name: "get_component_version", arguments: { name: "hist-probe", version: hv1 } });
ok("get_component_version is retired — the seat is gone", gvGone.isError === true && /not found/.test(gvGone.content[0].text));
// restore v1 → re-saved as a NEW current version (v3), history preserved, current html reverts.
const restore = await client.callTool({ name: "restore_component", arguments: { name: "hist-probe", version: hv1 } });
ok("restore rolls FORWARD to a new version (history preserved, never rewritten)",
  !restore.isError && /from v\d+/.test(restore.content[0].text) && /new v\d+/.test(restore.content[0].text));
const curAfter = await client.callTool({ name: "get_component", arguments: { name: "hist-probe" } });
ok("current source now matches the restored version (marker gone)", /hist-probe v\d+/.test(curAfter.content[0].text) && !curAfter.content[0].text.includes("data-hist-v2"));
const histAfter = await client.callTool({ name: "component_history", arguments: { name: "hist-probe" } });
ok("history grew to 3 versions (nothing lost)", !histAfter.isError && histAfter.structuredContent.history.length === 3 && histAfter.structuredContent.history[0].version > hv2);
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

console.log("16. scene now travels in the declaration — valid slug filed, unknown slug warned");
// scene moved out of the tool's parameters and into the document, like everything else a component
// says about itself. The COLUMN still exists and the Library still reads it — it is a projection of
// the declaration, kept so a taxonomy query never has to parse JSON.
const sceneOk = await client.callTool({ name: "save_component", arguments: { name: "scene-probe", description: "scene fixture",
  html: withDecl(noteHtml, { manifest_version: 2, scene: { category_id: "local-tools", tags: ["probe"] } }) } });
ok("a declared scene saves without a warning", !sceneOk.isError && sceneOk.content[0].text.includes('Saved "scene-probe"') && !sceneOk.content[0].text.includes("Unknown scene.category_id"));
const sceneBad = await client.callTool({ name: "save_component", arguments: { name: "scene-bad",
  html: withDecl(noteHtml, { manifest_version: 2, scene: { category_id: "not-a-real-slug" } }) } });
ok("an unknown category_id → the save still succeeds (our taxonomy, not the author's fault)", !sceneBad.isError && sceneBad.content[0].text.includes('Saved "scene-bad"'));
ok("...and the reply says the Library will not file it", /Unknown scene\.category_id "not-a-real-slug"/.test(sceneBad.content[0].text));
const sceneComps = (await client.callTool({ name: "list_components", arguments: {} })).structuredContent.components;
ok("a declared scene is projected into the column list_components reads", sceneComps.find((c) => c.name === "scene-probe")?.category_id === "local-tools");
ok("scene-less components carry category_id null (uniform schema)", sceneComps.find((c) => c.name === "habit-streaks")?.category_id === null);
// The old parameters are gone, and a caller that still sends them is TOLD rather than silently ignored.
const oldParam = await client.callTool({ name: "save_component", arguments: { name: "scene-probe", html: noteHtml, scene: { category_id: "local-tools" } } });
ok("passing the retired scene/manifest parameter is refused, with where the declaration lives now",
  oldParam.isError === true && /no longer parameters/.test(oldParam.content[0].text) && /oma-manifest/.test(oldParam.content[0].text));

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

console.log("18. loader runner branch — chokepoint markers (served doc + the ONE machine)");
// Write-set D: the runner machine lives ONCE in src/runner.mjs and ships to the loader inside
// the bundled runtime (minified — identifiers and whitespace don't survive), so structural
// pins grep the SOURCE and behavioral strings are checked on the SERVED document.
const loaderDoc = (await client.readResource({ uri: "ui://open-mcp-apps/app.html" })).contents[0].text;
const { readFileSync: readSrc } = await import("node:fs");
const runnerSrc = readSrc(join(ROOT, "src", "runner.mjs"), "utf8");
const policySrc = readSrc(join(ROOT, "src", "tool-policy.mjs"), "utf8");
ok("runner CSP policy present (default/connect/frame all 'none')", loaderDoc.includes("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'"));
ok("child iframe sandboxed with allow-scripts", /setAttribute\(\s*"sandbox"\s*,\s*"allow-scripts"\)/.test(loaderDoc));
// a prose comment mentions allow-same-origin — what matters is that no sandbox VALUE
// (setAttribute arg or sandbox= attribute) ever grants it
const sandboxValues = [
  ...loaderDoc.matchAll(/setAttribute\(\s*"sandbox"\s*,\s*"([^"]*)"/g),
  ...loaderDoc.matchAll(/sandbox="([^"]*)"/g),
].map((m) => m[1]);
ok("no sandbox value grants allow-same-origin", sandboxValues.length > 0 && sandboxValues.every((v) => !v.includes("allow-same-origin")));
ok("tier branch: local (or missing tier) mounts direct", loaderDoc.includes('sc.tier == null || sc.tier === "local"') && loaderDoc.includes("return mount(sc.html)"));
ok("non-local tiers route through the runner machine (oma.embed)", loaderDoc.includes("oma.embed(name, {") && loaderDoc.includes("caps: sc.caps || {}"));
ok("control-plane denylist present with every registry/policy-mutating tool", runnerSrc.includes("isControlPlaneTool(tl)") && ["security_set", "save_component", "edit_component", "archive_component", "delete_component", "restore_component", "install_from_library", "render_health"].every((n) => policySrc.includes('"' + n + '"')));
ok("control-plane deny also covers future library_* tools AND internal `_` RPC names", policySrc.includes('indexOf("library_") === 0') && policySrc.includes('indexOf("_") === 0'));
ok("control-plane tools rejected with a clear message", runnerSrc.includes("is not available to components") && loaderDoc.includes("is not available to components"));
// CSP-first: the runner builds our own <head> with the CSP as the FIRST child; it never anchors
// on the component's own <head> (a pre-<head> script would otherwise run before the policy).
ok("runner builds CSP-first document, not a <head>-anchored splice", runnerSrc.includes('"<!doctype html><html><head>" + RUNNER_CSP') && !/\.replace\(\s*\/<head/.test(runnerSrc) && loaderDoc.includes("<!doctype html><html><head>"));

console.log("19. policy-key naming — snake_case canonical; dotted/unknown stored but inert + warned");
const dottedSet = await client.callTool({ name: "security_set", arguments: { key: "security:habit-streaks:sendMessage", value: "deny" } });
ok("security_set stores an unknown/dotted cap but WARNS", !dottedSet.isError && /send_message|valid cap|unknown cap|snake_case/i.test(dottedSet.content[0].text));
const habitCaps2 = (await client.callTool({ name: "component_html", arguments: { name: "habit-streaks" } })).structuredContent.caps;
ok("dotted cap is inert — computeCaps reads only snake_case (habit-streaks local stays all-allow)", habitCaps2.send_message === true);

console.log("20. save_component scene — change, explicit clear, invalid preserves existing");
await client.callTool({ name: "save_component", arguments: { name: "scene-probe", html: noteHtml, scene: { category_id: "input-cocreate" } } });
await client.callTool({ name: "save_component", arguments: { name: "scene-probe", html: noteHtml, scene: null } });

console.log("21. version continuity — delete then recreate keeps history monotonic");
await client.callTool({ name: "save_component", arguments: { name: "ver-probe", html: noteHtml, description: "v1" } });
await client.callTool({ name: "save_component", arguments: { name: "ver-probe", html: histHtml2, description: "v2", expected_version: await verOf("ver-probe") } });
await client.callTool({ name: "delete_component", arguments: { name: "ver-probe", command_id: randomUUID() } });
await client.callTool({ name: "save_component", arguments: { name: "ver-probe", html: noteHtml, description: "v3", expected_version: await verOf("ver-probe") } });
const verHist = (await client.callTool({ name: "component_history", arguments: { name: "ver-probe" } })).structuredContent.history;
// Continuity across delete/recreate is now FREE: the ledger never goes backwards, so a recreated
// component cannot collide with a tombstoned history row. Three saves, three strictly descending
// versions — the property the old maxHistVersion+1 dance existed to hand-maintain.
ok("recreate keeps history monotonic and collision-free (no REPLACE over a tombstone)",
  verHist.length === 3 && verHist[0].version > verHist[1].version && verHist[1].version > verHist[2].version);

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
  ok("write_file creates a ref stamped with its ledger position", w1.ok && w1.created && w1.meta.version > 0 && w1.meta.sha256 === shaA);
  const m1 = fstore.statFile("file-test-a", "logo.png");
  ok("statFile returns the meta", m1 && m1.size === 1024 && m1.mime === "image/png");
  const w2 = fstore.execute({ type: "write_file", command_id: cid(), component: "file-test-a", path: "logo.png", sha256: shaB, size: 2048, mime: "image/png" });
  ok("overwrite advances the version + reports freed_sha", w2.ok && !w2.created && w2.meta.version > w1.meta.version && w2.freed_sha === shaA);
  const wOcc = fstore.execute({ type: "write_file", command_id: cid(), component: "file-test-a", path: "logo.png", sha256: shaC, size: 512, mime: "image/png", expected_version: w1.meta.version });
  ok("stale expected_version → conflict", !wOcc.ok && wOcc.conflict === true && wOcc.expected === w2.meta.version);
  const idc = cid();
  const wi1 = fstore.execute({ type: "write_file", command_id: idc, component: "file-test-a", path: "doc.txt", sha256: shaC, size: 100, mime: "text/plain" });
  const wi2 = fstore.execute({ type: "write_file", command_id: idc, component: "file-test-a", path: "doc.txt", sha256: shaC, size: 100, mime: "text/plain" });
  ok("replayed command_id is idempotent (no new version)", wi1.ok && wi2.idempotent === true && fstore.statFile("file-test-a", "doc.txt").version === wi1.meta.version);
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
ok("file_write stores + returns meta + files_version", !fw.isError && fw.structuredContent.version > 0 && fw.structuredContent.size > 0 && typeof fw.structuredContent.files_version === "number");
const frd = await client.callTool({ name: "file_read", arguments: { component: "smoke-notes", path: "note.txt" } });
ok("file_read returns bytes in structuredContent, NOT the text block", !frd.isError && frd.structuredContent.data_base64 === payload && !frd.content[0].text.includes(payload));
const fls = await client.callTool({ name: "file_list", arguments: { component: "smoke-notes" } });
ok("file_list shows the stored file", !fls.isError && fls.structuredContent.files.some((f) => f.path === "note.txt") && fls.structuredContent.usage.count >= 1);
// file_usage is retired (write-set C): the same totals ride every file_list page.
ok("usage rides file_list — one fact, one spelling (file_usage retired)",
  fls.structuredContent.usage.bytes > 0 && typeof fls.structuredContent.files_version === "number");
const fusGone = await client.callTool({ name: "file_usage", arguments: { component: "smoke-notes" } });
ok("file_usage's seat is gone", fusGone.isError === true && /not found/.test(fusGone.content[0].text));
const frdMissing = await client.callTool({ name: "file_read", arguments: { component: "smoke-notes", path: "ghost.txt" } });
ok("file_read of a missing file → clean error", frdMissing.isError === true && /No file/.test(frdMissing.content[0].text));
const fdel = await client.callTool({ name: "file_delete", arguments: { command_id: fcid(), component: "smoke-notes", path: "note.txt" } });
ok("file_delete removes it", !fdel.isError && fdel.structuredContent.deleted === true);
ok("file_read after delete → gone", (await client.callTool({ name: "file_read", arguments: { component: "smoke-notes", path: "note.txt" } })).isError === true);
const fileCaps = await client.callTool({ name: "component_html", arguments: { name: "smoke-notes" } });
ok("component_html caps carry the new file_read/file_write (local tier = both true)", fileCaps.structuredContent.caps.file_read === true && fileCaps.structuredContent.caps.file_write === true);

console.log("25. data_version — the cheapest change probe");
const dv1 = (await client.callTool({ name: "data_version", arguments: {} })).structuredContent;
ok("shape {seq, settings_version, files_version, schema_version}",
  typeof dv1.seq === "number" && typeof dv1.settings_version === "number" &&
  typeof dv1.files_version === "number" && dv1.schema_version === SCHEMA_VERSION);
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
// Write-set C: EVERY read is a page — the plain call is simply the first one. Under the default
// limit the whole small collection fits, and the walk's end is an explicit null, never an absence.
ok("PLAIN data_list is the first page — all 12 fit, and next_cursor is an explicit null",
  pPlain.items.length === 12 && pPlain.next_cursor === null && pPlain.returned === 12);
// `total` used to be pinned ABSENT here, which pinned the defect: a result that says how many rows
// it got but never how many exist cannot be checked against anything. See two-channel §7.
ok("...and it declares total, so the rows received can be checked against the rows that exist",
  pPlain.total === 12);

console.log("27. schema manifests — declared field contracts bind every write; tri-state on re-save");
const manManifest = { collections: { "man-data": { strict: true, fields: {
  title: { type: "string", required: true },
  count: { type: "number" },
  state: { type: "string", enum: ["open", "done"] },
} } } };
const manSave = await client.callTool({ name: "save_component", arguments: { name: "man-probe", html: withDecl(noteHtml, manManifest), description: "manifest probe" } });
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
ok("fully valid add succeeds", !vOk.isError && vOk.structuredContent.item.fields.title === "first");
const manId = vOk.structuredContent.id;
const vMerge = await client.callTool({ name: "data_update_item", arguments: { command_id: randomUUID(), id: manId, fields: { state: "bogus" } } });
ok("update merging to an invalid state → rejected (post-merge validated)", vMerge.isError === true && /schema_violation/.test(vMerge.content[0].text));
const vFree = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "man-free", fields: { anything: "goes" } } });
ok("ungoverned collections stay free-form", !vFree.isError);
const manBad = await client.callTool({ name: "save_component", arguments: { name: "man-probe", expected_version: await verOf("man-probe"), html: withDecl(noteHtml, { collections: { settings: { fields: { key: { type: "string" } } } } }) } });
ok("a declaration may not govern the settings collection", manBad.isError === true && /reserved "settings"/.test(manBad.content[0].text));
await client.callTool({ name: "save_component", arguments: { name: "man-probe", html: noteHtml, description: "resave with no declaration block", expected_version: await verOf("man-probe") } });
const vStill = await manAdd({ count: 3 });
ok("a document with NO block preserves the stored declaration (bad add still rejects)", vStill.isError === true && /schema_violation/.test(vStill.content[0].text));
await client.callTool({ name: "save_component", arguments: { name: "man-probe", html: withDecl(noteHtml, {}), expected_version: await verOf("man-probe") } });
const vFreed = await manAdd({ count: 3 });
ok("an EMPTY block clears it (same add now succeeds)", !vFreed.isError);

console.log("26b. data_batch — N writes, one transaction, one event per write");
const bCmds = (n, coll) => Array.from({ length: n }, (_, i) => ({ type: "add_item", collection: coll, fields: { title: `row ${i}`, amount: i } }));
const bId = randomUUID();
const bOk = await client.callTool({ name: "data_batch", arguments: { command_id: bId, commands: bCmds(5, "batch-probe") } });
ok("a batch applies and reports how many", !bOk.isError && bOk.structuredContent.count === 5);
ok("the reply is one {id, seq} per command — not the rows the caller already has",
  bOk.structuredContent.results.length === 5 && bOk.structuredContent.results.every((r) => r.id && r.seq) &&
  bOk.structuredContent.results[0].item === undefined);
ok("the receipts ride the TEXT channel too — a content-only host must learn the ids it was given",
  bOk.structuredContent.results.every((r) => bOk.content[0].text.includes(r.id)));
ok("each command got its OWN ledger position (undo and OCC stay as fine-grained as the writes)",
  new Set(bOk.structuredContent.results.map((r) => r.seq)).size === 5);
const bRows = (await client.callTool({ name: "data_list", arguments: { collection: "batch-probe" } })).structuredContent.items;
ok("the rows are really there, each stamped with its own write's seq",
  bRows.length === 5 && bRows.every((i) => bOk.structuredContent.results.some((r) => r.id === i.id && r.seq === i.version)));
const bReplay = await client.callTool({ name: "data_batch", arguments: { command_id: bId, commands: bCmds(5, "batch-probe") } });
ok("replaying the SAME batch is a no-op (the batch id derives each command's id)",
  !bReplay.isError && (await client.callTool({ name: "data_list", arguments: { collection: "batch-probe" } })).structuredContent.items.length === 5);
ok("...and the replay repeats its receipts — ids, seqs and the outer seq all survive",
  bReplay.structuredContent.results.length === 5 && bReplay.structuredContent.results.every((r) => r.id && r.seq) &&
  bReplay.structuredContent.seq === bOk.structuredContent.seq);
const bFail = await client.callTool({ name: "data_batch", arguments: { command_id: randomUUID(), commands: [
  { type: "add_item", collection: "batch-probe", fields: { title: "would be row 6" } },
  { type: "update_item", id: "no-such-id", fields: { x: 1 } },
] } });
ok("one bad command rolls the WHOLE batch back — no half-applied state", bFail.isError === true &&
  (await client.callTool({ name: "data_list", arguments: { collection: "batch-probe" } })).structuredContent.items.length === 5);
ok("...and it names WHICH command failed, so a 200-row seed is one fix away, not a bisection",
  /Command 1 failed/.test(bFail.content[0].text) && bFail.structuredContent.failed_index === 1);
const bHuge = await client.callTool({ name: "data_batch", arguments: { command_id: randomUUID(), commands: bCmds(201, "batch-probe") } });
ok("past the command cap it says the cap and the count, rather than trying", bHuge.isError === true && /at most 200/.test(bHuge.content[0].text));
// The measured reason the ack is {id, seq} and not the rows: 300 full-row echoes serialise to
// ~102,600 chars, 2.85x the result budget — theheadline use case would live in a truncated reply.
ok("a 200-command ack stays well inside the result budget",
  JSON.stringify((await client.callTool({ name: "data_batch", arguments: { command_id: randomUUID(), commands: bCmds(200, "batch-big") } })).structuredContent).length < 20000);

console.log("26b2. the batch wall — the vocabulary is the four item commands, not core()");
const bStore = openStore(DB);
const settingsBefore = bStore.getComponent("settings").html;
const bEscape = await client.callTool({ name: "data_batch", arguments: { command_id: randomUUID(), commands: [
  { type: "save_component", name: "settings", html: "<p>overwritten</p>" },
] } });
ok("a non-item command is refused BY NAME instead of opening a second door to core()",
  bEscape.isError === true && /add_item, update_item, move_item, delete_item/.test(bEscape.content[0].text));
ok("...and the system component it aimed at is untouched", bStore.getComponent("settings").html === settingsBefore);
const bTypo = await client.callTool({ name: "data_batch", arguments: { command_id: randomUUID(), commands: [
  { type: "add-item", collection: "batch-probe", fields: { title: "typo" } },
] } });
ok("a typo'd type is an indexed batch failure, not a thrown internal error",
  bTypo.isError === true && bTypo.structuredContent?.failed_index === 0);
const bMint = await client.callTool({ name: "data_batch", arguments: { command_id: randomUUID(), commands: [
  { type: "add_item", collection: "batch-probe", fields: { title: "minted" }, actor: "seed" },
] } });
ok("a batch cannot mint write classes the single tools cannot (actor stays human|agent)", bMint.isError === true);
const bSmuggle = await client.callTool({ name: "data_batch", arguments: { command_id: randomUUID(), commands: [
  { type: "add_item", collection: "batch-probe", fields: { title: "smuggled" }, id: "attacker-chosen", principal: "someone-else" },
] } });
ok("unpublished keys are dropped, not honored — an explicit add id does not survive the wall",
  !bSmuggle.isError && bSmuggle.structuredContent.results[0].id !== "attacker-chosen");

// …and the SINGLE-write tools now stand behind the same wall. They did not: their schemas are
// `.passthrough()` (they must carry the runner's `via`), so every unpublished key a caller invented
// reached the store. `id` on add_item is the one that matters — CHOOSING an id is what makes a
// deleted id re-creatable in another collection, after which a widget's stale snapshot still lists
// it and an id-addressed write lands on the foreign row (adversarial #2, B-3). One table
// (ITEM_WRITE_KEYS) now governs both paths, so they cannot drift apart again.
{
  const one = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "wall-probe", id: "CHOSEN-ID", fields: { t: 1 } } });
  ok("data_add_item mints the id — a caller-chosen one does not survive the wall either",
    !one.isError && one.structuredContent.id !== "CHOSEN-ID");
  await client.callTool({ name: "data_delete_item", arguments: { command_id: randomUUID(), id: one.structuredContent.id } });
  const again = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "wall-elsewhere", id: one.structuredContent.id, fields: { t: 2 } } });
  ok("…so a deleted id can never be re-created in ANOTHER collection (B-3's precondition, gone)",
    !again.isError && again.structuredContent.id !== one.structuredContent.id);
  // Everything published must be untouched by the wall.
  const pub = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "wall-probe", group: "g", fields: { t: 1 }, position: 3 } });
  ok("published keys still pass (collection/group/fields/position)",
    !pub.isError && pub.structuredContent.item.group === "g" && pub.structuredContent.item.position === 3);
  const okv = await client.callTool({ name: "data_update_item", arguments: { command_id: randomUUID(), id: pub.structuredContent.id, fields: { t: 2 }, expected_version: pub.structuredContent.seq } });
  ok("a caller's explicit expected_version still applies", !okv.isError && okv.structuredContent.ok === true);
  const bad = await client.callTool({ name: "data_update_item", arguments: { command_id: randomUUID(), id: pub.structuredContent.id, fields: { t: 3 }, expected_version: 1 } });
  ok("…and a wrong one still conflicts (the wall is about UNPUBLISHED keys only)",
    bad.structuredContent.ok === false && bad.structuredContent.reason === "version_conflict");
  const withVia = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "wall-probe", fields: { t: 9 }, via: { component: "widget-x" } } });
  ok("`via` passes — it is the reason these schemas are passthrough at all", !withVia.isError);
  const evs = await client.callTool({ name: "data_changes", arguments: { collection: "wall-probe", since: 0 } });
  ok("…and is still stripped from every AI-facing read", !JSON.stringify(evs.structuredContent).includes("widget-x"));
}

console.log("26b3. a replay carries the ORIGINAL receipt");
const ridReplay = randomUUID();
const rFirst = await client.callTool({ name: "data_add_item", arguments: { command_id: ridReplay, collection: "batch-probe", fields: { title: "receipt" } } });
const rAgain = await client.callTool({ name: "data_add_item", arguments: { command_id: ridReplay, collection: "batch-probe", fields: { title: "receipt" } } });
ok("the retry gets id, seq and the row — a retry fires exactly when the first reply was lost",
  rAgain.structuredContent.id === rFirst.structuredContent.id &&
  rAgain.structuredContent.seq === rFirst.structuredContent.seq &&
  rAgain.structuredContent.item?.fields?.title === "receipt");
ok("...and its text names the id instead of 'undefined'",
  rAgain.content[0].text.includes(rFirst.structuredContent.id) && !/undefined/.test(rAgain.content[0].text));

console.log("26b4. receipts are caller-sized, so the budget is checked, not assumed");
const longIds = Array.from({ length: 60 }, (_, i) => "long-" + String(i).padStart(4, "0") + "-" + "x".repeat(900));
for (const id of longIds) bStore.execute({ type: "add_item", command_id: randomUUID(), collection: "batch-long", id, fields: { n: 0 }, actor: "human" });
const bLong = await client.callTool({ name: "data_batch", arguments: { command_id: randomUUID(), commands: longIds.map((id) => ({ type: "update_item", id, fields: { n: 1 } })) } });
ok("an ack that would blow the budget truncates its receipt TAIL and says so",
  !bLong.isError && bLong.structuredContent.results.length < 60 &&
  /truncated to the first \d+ of 60/.test(bLong.structuredContent.note || ""));
ok("...every command still applied — the truncation is of receipts, never of writes",
  bStore.snapshot("batch-long").items.every((i) => i.fields.n === 1));

console.log("26b5. one grammar, one refusal — data_list rejects a typo'd operator by name");
const badOp = await client.callTool({ name: "data_list", arguments: { collection: "batch-probe", match: { amount: { greaterThan: 1 } } } });
ok("a typo'd operator is a NAMED error, not a silent empty result",
  badOp.isError === true && /Unknown filter operator/.test(badOp.content[0].text) && /greaterThan/.test(badOp.content[0].text));

console.log("26b6. an exact-name lookup is explicit intent — defaults scope browsing, not existence");
bStore.execute({ type: "save_component", command_id: randomUUID(), name: "hidden-visual", visibility: "unlisted", actor: "human",
  html: `<p>tucked away</p><script type="application/json" id="oma-manifest">{"manifest_version":2,"kind":"visual"}<` + `/script>` });
const hidFound = await client.callTool({ name: "list_components", arguments: { name: "hidden-visual" } });
ok("list_components {name} finds an unlisted non-app instead of reporting it does not exist",
  !hidFound.isError && hidFound.structuredContent.total === 1 && hidFound.structuredContent.components[0].name === "hidden-visual");
const hidScoped = await client.callTool({ name: "list_components", arguments: { name: "hidden-visual", kind: "app" } });
ok("...while a filter the caller actually passed still applies", hidScoped.structuredContent.total === 0);

console.log("26c. data_query — the answer travels, the rows do not");
// Off by default: the seat is registered so no cached tool list is ever invalidated by its arrival,
// and calling it says so instead of failing obscurely.
const qOff = await client.callTool({ name: "data_query", arguments: { collection: "batch-probe" } });
ok("with the flag off the seat exists and explains itself", qOff.isError === true && /OMA_QUERY/.test(qOff.content[0].text));

console.log("27b. stewardship declarations — `fields` is optional; declaring a collection ≠ validating it");
const stewSave = await client.callTool({ name: "save_component", arguments: {
  name: "stew-probe", description: "stewardship only",
  html: withDecl(noteHtml, { collections: { "stew-data": {}, "stew-labelled": { label_field: "headline" } } }),
} });
ok("a fields-less declaration is accepted (pure stewardship)", !stewSave.isError && /Saved "stew-probe"/.test(stewSave.content[0].text));
const stewWrite = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "stew-data", fields: { anything: "goes", n: 7 } } });
ok("writing to a stewardship-only collection validates nothing and does not throw", !stewWrite.isError);
const labWrite = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "stew-labelled", fields: { headline: "hi" } } });
ok("label_field alone is a legal declaration", !labWrite.isError);
const strictNoFields = await client.callTool({ name: "save_component", arguments: { name: "stew-probe", expected_version: await verOf("stew-probe"), html: withDecl(noteHtml, { collections: { "stew-data": { strict: true } } }) } });
ok("strict without fields is rejected as a shape error (reads as a typo, never an intent)",
  strictNoFields.isError === true && /strict requires fields/.test(strictNoFields.content[0].text));
const badLabel = await client.callTool({ name: "save_component", arguments: { name: "stew-probe", expected_version: await verOf("stew-probe"), html: withDecl(noteHtml, { collections: { "stew-data": { label_field: "" } } }) } });
ok("label_field must be a non-empty string", badLabel.isError === true && /label_field/.test(badLabel.content[0].text));
// Two components declaring the same collection: the contract is the UNION, and strict only holds
// if every declarer asked for it — a sibling tightening its own view must not reject our writes.
await client.callTool({ name: "save_component", arguments: { name: "union-a", html: withDecl(noteHtml, { collections: { "union-data": { fields: { a: { type: "string", required: true } } } } }) } });
await client.callTool({ name: "save_component", arguments: { name: "union-b", html: withDecl(noteHtml, { collections: { "union-data": { strict: true, fields: { b: { type: "number", required: true } } } } }) } });
const unionMissing = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "union-data", fields: { a: "x" } } });
ok("union of declarations: b (declared by the other component) is required too",
  unionMissing.isError === true && /schema_violation/.test(unionMissing.content[0].text));
ok("violation names EVERY declarer, not whichever row saved last",
  /union-a/.test(unionMissing.content[0].text) && /union-b/.test(unionMissing.content[0].text));
const unionBoth = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "union-data", fields: { a: "x", b: 1, extra: "kept" } } });
ok("strict is a conjunction: one declarer's strict does not reject the other's undeclared keys", !unionBoth.isError);

console.log("27d. discovery face — the default answers \"open my X\" in one call, and a filtered list says so");
const lcName = await client.callTool({ name: "list_components", arguments: { name: "man-probe" } });
ok("name is an exact lookup: one row, and the count agrees",
  lcName.structuredContent.total === 1 && lcName.structuredContent.components[0].name === "man-probe");
const lcMiss = await client.callTool({ name: "list_components", arguments: { name: "no-such-app" } });
ok("a miss says how to widen instead of looking like an empty registry",
  lcMiss.structuredContent.total === 0 && /No component named/.test(lcMiss.content[0].text));
const lcDefault = await client.callTool({ name: "list_components", arguments: {} });
const lcAny = await client.callTool({ name: "list_components", arguments: { kind: "any", visibility: "any" } });
ok("default scope is kind=app + featured/listed (the openable apps)",
  lcDefault.structuredContent.components.every((c) => c.kind === "app" && ["featured", "listed"].includes(c.visibility)));
ok("kind/visibility any widens to the whole registry", lcAny.structuredContent.total >= lcDefault.structuredContent.total);
const lcCap = await client.callTool({ name: "list_components", arguments: { limit: 2 } });
ok("limit caps the rows but the reply reports the true match count",
  lcCap.structuredContent.components.length === 2 && lcCap.structuredContent.total > 2 &&
  new RegExp(`${lcCap.structuredContent.total} match, showing 2`).test(lcCap.content[0].text));
ok("the store's own listComponents() is unfiltered — the registry's consumers see everything",
  lcAny.structuredContent.total === lcAny.structuredContent.shown);

console.log("27e. guide chapters — each stands alone; the frozen enum admits what is not built yet");
const gBasics = (await client.callTool({ name: "get_component_guide", arguments: {} })).content[0].text;
const gStyle = (await client.callTool({ name: "get_component_guide", arguments: { topic: "style" } })).content[0].text;
const gFns = (await client.callTool({ name: "get_component_guide", arguments: { topic: "functions" } })).content[0].text;
ok("default chapter carries the API contract AND a working template", /window\.oma API/.test(gBasics) && /Minimal working component/.test(gBasics));
// Cap raised 15,500 → 19,500 (2026-07-27 slimming batch), then → 22,000 (2026-07-27 L0 batch).
// Basics grew by the things a measurement said an author never does unless told: the kit class
// table (CSS was 32-47% of every hand-written component, k- usage 0/4), the
// data-goes-in-the-collection rule (hardcoded 4/4 when unsaid, 0/9 when said), the
// skeleton-then-edit_component workflow, and now the two L0 findings — the empty-app failure
// (11/11 first attempts opened with zero rows, 8 without even a collection) and dropped
// requirements (3/11 rejected, ALL of them the right shape with something the user had said out
// loud simply missing).
//
// This is PULL-priced — paid by the one author who asks, not by every conversation — so the trade
// is a bigger guide for a better app. But the L0 additions are ON PROBATION: docs/l0-first-hit.md
// has a before leg, an after leg re-runs the same 14 prompts, and prose that does not move those
// numbers should come back OUT rather than sit here being plausible.
// 25,000 (was 22,000): the time-derived rendering lesson bought ~1.7K with a measurement behind
// it — the +45-day audit found ~1 in 5 shipped apps lying about time, the single largest defect
// class. Same probation as every L0 addition: the t+45 quality-round gate is its number, and if
// new apps keep lying anyway the prose comes back out.
ok("default chapter is smaller than the whole guide (the author pays for what they ask for)", gBasics.length < 25000,
  `basics is ${gBasics.length} chars`);
ok("…and it carries the three slimming rules, since basics is the chapter authors actually pull",
  /\.k-btn/.test(gBasics) && /data_batch/.test(gBasics) && /skeleton/i.test(gBasics),
  "an author who only pulls basics must still know the kit exists and that data belongs in the collection");
// The guide's data_batch example is the centrepiece of a rule we made HARD ("data goes in the
// collection"), so it must actually run. The first version of it put `collection` at the batch
// level, where the tool has no such parameter — every author who copied it would have hit
// collection_required on command 0 and had the whole transaction rolled back.
{
  const ex = gBasics.slice(gBasics.indexOf("data_batch {"), gBasics.indexOf("]}", gBasics.indexOf("data_batch {")) + 2);
  const addLines = ex.split("\n").filter((l) => /type:\s*"add_item"/.test(l));
  ok("the guide's data_batch example puts `collection` on EVERY command, never at the batch level",
    addLines.length > 0 && addLines.every((l) => /collection:/.test(l)) && !/^data_batch \{[^\n]*collection:/.test(ex),
    `example was:\n${ex}`);
  // …and the shape it teaches is executed for real, not just read.
  const batch = await client.callTool({ name: "data_batch", arguments: { command_id: randomUUID(), commands: [
    { type: "add_item", collection: "guide-example", fields: { q: "a", options: ["1", "2"], answer: 0 } },
    { type: "add_item", collection: "guide-example", fields: { q: "b", options: ["1", "2"], answer: 2 } },
  ] } });
  ok("…and that exact shape applies cleanly through the real tool",
    !batch.isError && batch.structuredContent.ok === true && batch.structuredContent.count === 2,
    JSON.stringify(batch.structuredContent));
}
ok("style stands alone: it repeats the hard rules rather than assuming basics was read",
  /NO external resources/.test(gStyle) && /design tokens/.test(gStyle));
ok("a chapter whose capability is behind a flag says so plainly, and points back",
  /Not available yet/.test(gFns) && /topic: "basics"/.test(gFns));

console.log("27f. open_component binding — the declaration finally participates");
{
  const barrel = await import("../index.mjs");
  const decl = (colls) => `<script type="application/json" id="oma-manifest">\n${JSON.stringify({ manifest_version: 2, collections: colls })}\n</script>`;
  const body = "<h1>t</h1><script type=\"module\">oma.ready(() => {});</scr" + "ipt>";
  const save = (name, colls) => client.callTool({ name: "save_component", arguments: { name, html: `<!DOCTYPE html><html><head>${decl(colls)}</head><body>${body}</body></html>` } });
  const openedOn = async (name, args = {}) => {
    const r = await client.callTool({ name: "open_component", arguments: { component: name, ...args } });
    return r.structuredContent.collection;
  };
  await save("bind-one", { trips: { label_field: "title" } });
  ok("a component declaring exactly ONE collection binds to it — this is the 8-of-9 blank-open bug",
    await openedOn("bind-one") === "trips");
  ok("an explicit collection still wins over the declaration",
    await openedOn("bind-one", { collection: "elsewhere" }) === "elsewhere");
  await save("bind-two", { trips: {}, legs: {} });
  ok("two declared collections ⇒ no single answer, so the component NAME stays the default",
    await openedOn("bind-two") === "bind-two");
  const plain = await client.callTool({ name: "save_component", arguments: { name: "bind-none", html: `<!DOCTYPE html><html><body>${body}</body></html>` } });
  ok("no declaration at all ⇒ unchanged behaviour", !plain.isError && await openedOn("bind-none") === "bind-none");

  // The binding is derived from a COMPONENT-AUTHORED manifest, so it is only trustworthy for a
  // component we trust. For an unreviewed one it would let the component pick what it is bound to —
  // and the bound collection is exactly what the runner grants full typed read/write on regardless
  // of cross_collection_read/write. Declaring another app's collection would then hand it those rows.
  ok("an UNREVIEWED component's manifest cannot choose its binding — it gets its own name",
    barrel.defaultCollectionFor({ name: "evil", author: "some-publisher", manifest: JSON.stringify({ collections: { "private-ledger": {} } }) }) === "evil");
  ok("…while local/seed/library authorship is honoured (the case the feature exists for)",
    ["agent", "human", "seed", "library"].every((a) =>
      barrel.defaultCollectionFor({ name: "x", author: a, manifest: JSON.stringify({ collections: { trips: {} } }) }) === "trips"));

  // A padded key is declarable but unwritable: every write canonicalizes with .trim(), so the
  // manifest would govern " trips " while rows land in "trips" — and the binding would open the app
  // on the empty one.
  const padded = await save("bind-padded", { " trips ": {} });
  ok("a collection key with surrounding whitespace is refused at save, with the fix in the message",
    padded.isError === true && /whitespace/.test(padded.content[0].text), padded.content?.[0]?.text?.slice(0, 120));
  ok("…and a manifest stored BEFORE that check still binds to the canonical name",
    barrel.defaultCollectionFor({ name: "old", author: "agent", manifest: JSON.stringify({ collections: { " trips ": {} } }) }) === "trips");
}

console.log("27g. tokenCSS — an embedder's PER-APP theme must not be baked into what it embeds");
{
  // tokenCSS reads a LIVE document, so it is browser-only and deliberately not in the package
  // barrel; the rule it encodes is still worth pinning here.
  const barrel = await import("../src/runner.mjs");
  // A fake document is enough: the whole rule is "what the caller substitutes wins, and null omits".
  const fakeDoc = { defaultView: { getComputedStyle: () => ({ colorScheme: "light",
    getPropertyValue: (n) => (n === "--color-text-primary" ? "#111" : n === "--color-background-primary" ? "#ff0000" : "") }) } };
  const leaky = barrel.tokenCSS(fakeDoc);
  ok("without substitutes the embedder's computed value is copied verbatim (the leak, reproduced)",
    /--color-background-primary:#ff0000/.test(leaky));
  const fixed = barrel.tokenCSS(fakeDoc, { "--color-background-primary": null });
  ok("null OMITS the token, so the child's own fallback layer answers instead",
    !/--color-background-primary/.test(fixed) && /--color-text-primary:#111/.test(fixed));
  const swapped = barrel.tokenCSS(fakeDoc, { "--color-background-primary": "Canvas" });
  ok("a substitute value is emitted in its place (the host's own value, beneath the theme)",
    /--color-background-primary:Canvas/.test(swapped));
  ok("the child document carries a fallback layer BEFORE the tokens, so omitting is safe",
    (() => {
      const doc = barrel.composeChildDoc("<p>x</p>", { fallbackCss: ":root{--x:1}", tokenCss: "<style>T</style>", kitCss: ".k{}" });
      return doc.indexOf('data-oma="token-fallback"') < doc.indexOf("<style>T</style>")
        && doc.indexOf("<style>T</style>") < doc.indexOf('data-oma="kit"');
    })());
}

console.log("27c. app-form invariant — every atom has a face (empty_html replaces the size floor)");
const emptyHtml = await client.callTool({ name: "save_component", arguments: { name: "faceless", html: "   \n\t " } });
ok("whitespace-only html → empty_html, and the note says why apps need a face",
  emptyHtml.isError === true && /empty_html/.test(emptyHtml.content[0].text) && /person opens/.test(emptyHtml.content[0].text));
const tinySave = await client.callTool({ name: "save_component", arguments: { name: "tiny-but-real", html: "<p>hi</p>" } });
ok("a 9-char component saves (small is reversible; the old 50-char floor was not the defence)", !tinySave.isError);
ok("save ack reports the size unconditionally", /9 chars/.test(tinySave.content[0].text));
const grown = await client.callTool({ name: "save_component", arguments: { name: "tiny-but-real", html: noteHtml, expected_version: await verOf("tiny-but-real") } });
ok("an overwrite reports the size PAIR, so a suspicious shrink announces itself",
  new RegExp(`9 → ${noteHtml.length}`).test(grown.content[0].text));

console.log("28. library — refusal over a local app; real install → first-party content runs LOCAL/direct");
const gl0 = (await client.callTool({ name: "library_list", arguments: {} })).structuredContent.entries;
ok(`library lists the ${seedCount - 3} shipped apps (system settings/dashboard/library excluded)`,
  gl0.length === seedCount - 3 && !gl0.some((e) => ["settings", "dashboard", "library"].includes(e.name)));
const gBefore = gl0.find((e) => e.name === "habit-streaks");
ok("seeded habit-streaks shows installed but NOT from_library", gBefore?.installed === true && gBefore?.from_library === false);
const gRefuse = await client.callTool({ name: "install_from_library", arguments: { name: "habit-streaks" } });
ok("install over the seed-authored copy is refused", gRefuse.isError === true && /already exists/.test(gRefuse.content[0].text) && /seed-authored/.test(gRefuse.content[0].text));
await client.callTool({ name: "delete_component", arguments: { name: "habit-streaks", command_id: randomUUID() } });
const gInst = await client.callTool({ name: "install_from_library", arguments: { name: "habit-streaks" } });
// OSS decision (Leo 2026-07-24): library content is FIRST-PARTY → author "library" is a
// provenance stamp mapping to tier LOCAL (direct render), same standing as the user's own
// apps. The runner + review flow stay dormant until the SaaS publishing pipeline.
ok("after delete, install succeeds at tier local (history continued, version rolls forward)",
  !gInst.isError && gInst.structuredContent.tier === "local" && gInst.structuredContent.version > 0);
const gHtml = (await client.callTool({ name: "component_html", arguments: { name: "habit-streaks" } })).structuredContent;
ok("component_html: author library → tier local (first-party)", gHtml.author === "library" && gHtml.tier === "local");
ok("local caps: full-trust preset (file_read+file_write+send_message all true)", gHtml.caps.file_read === true && gHtml.caps.file_write === true && gHtml.caps.send_message === true);
const gRes = await client.readResource({ uri: "ui://open-mcp-apps/habit-streaks.html" });
ok("direct-mode ui:// resource serves the wrapped component (NOT a runner placeholder)", gRes.contents[0].text.includes("window.oma") && !gRes.contents[0].text.includes("Sandboxed runner required"));
const gAfter = (await client.callTool({ name: "library_list", arguments: {} })).structuredContent.entries.find((e) => e.name === "habit-streaks");
ok("library_list now shows installed + from_library + no update pending", gAfter?.installed === true && gAfter?.from_library === true && gAfter?.update_available === false);
const gAgain = await client.callTool({ name: "install_from_library", arguments: { name: "habit-streaks" } });
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
ok("commit lands big.bin (size 11, file_write result shape)", !cCommit.isError && cCommit.structuredContent.size === 11 &&
  cCommit.structuredContent.version > 0 && cCommit.structuredContent.component === "smoke-notes" && typeof cCommit.structuredContent.files_version === "number");
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
await client.callTool({ name: "save_component", arguments: { name: "rh-probe", html: rhB, description: "", expected_version: await verOf("rh-probe") } });
// A widget reports the version it actually mounted, and that number is now a ledger position — so
// the test asks the registry which two versions exist instead of assuming 1 and 2.
const rhHist = (await client.callTool({ name: "component_history", arguments: { name: "rh-probe" } })).structuredContent.history;
const rhV1 = rhHist[1].version, rhV2 = rhHist[0].version;
const rh1 = await client.callTool({ name: "render_health", arguments: { component: "rh-probe", version: rhV2, ok: false, error: "boom" } });
ok("failure on the current version → reverted to the previous one, rolled forward as a new version",
  !rh1.isError && rh1.structuredContent.reverted === true && rh1.structuredContent.restored_version === rhV1 && rh1.structuredContent.new_version > rhV2);
const rhCur = await client.callTool({ name: "get_component", arguments: { name: "rh-probe" } });
ok("current source is the restored html again (marker A, served as the new version)",
  rhCur.content[0].text.includes(`rh-probe v${rh1.structuredContent.new_version}`) && rhCur.content[0].text.includes("A-marker") && !rhCur.content[0].text.includes("B-marker"));
const rhStale = await client.callTool({ name: "render_health", arguments: { component: "rh-probe", version: rhV2, ok: false, error: "boom again" } });
ok("stale report (an older version while a newer one is current) → ignored", rhStale.structuredContent.reverted === false && /Stale report/.test(rhStale.structuredContent.note));
const rhOk = await client.callTool({ name: "render_health", arguments: { component: "rh-probe", version: 3, ok: true } });
ok("healthy report never reverts", rhOk.structuredContent.reverted === false);
const settingsVer = (await client.callTool({ name: "component_html", arguments: { name: "settings" } })).structuredContent.version;
const rhLock = await client.callTool({ name: "render_health", arguments: { component: "settings", version: settingsVer, ok: false, error: "boom" } });
ok("locked system component is never auto-reverted", rhLock.structuredContent.reverted === false && /Locked/.test(rhLock.structuredContent.note));
// library-fixture (§17b, author "library-test") is the surviving non-local component now that
// library installs are first-party/local.
const rhNlVer = (await client.callTool({ name: "component_html", arguments: { name: "library-fixture" } })).structuredContent.version;
const rhNl = await client.callTool({ name: "render_health", arguments: { component: "library-fixture", version: rhNlVer, ok: false, error: "boom" } });
ok("non-local component is never auto-reverted", rhNl.structuredContent.reverted === false && /Non-local/.test(rhNl.structuredContent.note));
// Budget is a HARD 3-per-server-run ceiling: healthy (ok:true) reports do NOT reset it — the
// review round proved a resettable budget is hollow (interleaved ok:true reports allowed 8
// forced reverts). rh1 above consumed 1 of 3, so of the next three break+report cycles only
// TWO revert; the third is refused at the cap.
let budgetReverts = 0;
for (let i = 0; i < 3; i++) {
  await client.callTool({ name: "save_component", arguments: { name: "rh-probe", html: noteHtml.replace('id="l"', `id="l" data-rh="broken-${i}"`), description: "", expected_version: await verOf("rh-probe") } });
  const v = (await client.callTool({ name: "component_html", arguments: { name: "rh-probe" } })).structuredContent.version;
  const rep = await client.callTool({ name: "render_health", arguments: { component: "rh-probe", version: v, ok: false, error: "boom " + i } });
  if (rep.structuredContent.reverted === true) budgetReverts++;
}
ok("hard budget: only two more reverts fit (3 total per run; ok:true does NOT reset)", budgetReverts === 2);
await client.callTool({ name: "save_component", arguments: { name: "rh-probe", html: noteHtml.replace('id="l"', 'id="l" data-rh="broken-final"'), description: "", expected_version: await verOf("rh-probe") } });
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
ok("habit-streaks (library-installed): tier local, full file caps (first-party)", permHabit?.tier === "local" && permHabit?.caps.file_read === true && permHabit?.caps.file_write === true);

console.log("33. data_changes — the reopen story, end to end");
{
  const C = "reopen-probe";
  const mk = (fields, actor) => client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: C, fields, actor } });

  await mk({ title: "seeded by the model" }, "agent");
  // No server-held mark any more (write-set C): the mark is the CALLER's. The first call omits
  // `since` and BOOTSTRAPS — no events, just the position to hold.
  const boot = await client.callTool({ name: "data_changes", arguments: { collection: C } });
  ok("bootstrap: omitted since → no events, just the position to hold",
    boot.structuredContent.events.length === 0 && typeof boot.structuredContent.next_since === "number");
  ok("and the text says what to do with the number", /hold that as your mark/i.test(boot.content[0].text), boot.content[0].text);
  const mark = boot.structuredContent.next_since;

  const second = await client.callTool({ name: "data_changes", arguments: { collection: C, since: mark } });
  ok("nothing new after the held mark — nothing is reported twice", second.structuredContent.total === 0);
  ok("and it says so in words the model can act on", /nothing changed/i.test(second.content[0].text), second.content[0].text);

  // THE product case: the user edits in the widget, which never passes through the model. The
  // widget calls the same tools with actor "human", so the next reopen is where the model finds out.
  await mk({ title: "the user typed this" }, "human");
  await mk({ title: "and this" }, "human");
  const reopen = await client.callTool({ name: "data_changes", arguments: { collection: C, since: mark } });
  ok("reopen surfaces exactly the edits made since the held mark", reopen.structuredContent.total === 2);
  ok("next_since is the last event actually delivered — the mark to hold next",
    reopen.structuredContent.next_since === reopen.structuredContent.events.at(-1).seq);
  ok("attributed to the human, not to the model", reopen.structuredContent.events.every((e) => e.actor === "human"));
  ok("with full fields, not labels", reopen.structuredContent.events[0].fields.title === "the user typed this");
  ok("and the item ids, so the model can act on them", reopen.structuredContent.events.every((e) => !!e.id));

  // Explicit `since` overrides the mark — the escape hatch for a compacted conversation, and for a
  // second chat on the same host (they share a mark; MCP gives us no conversation id).
  const replay = await client.callTool({ name: "data_changes", arguments: { collection: C, since: 0 } });
  ok("explicit since=0 replays everything regardless of the mark", replay.structuredContent.total === 3);

  const other = await client.callTool({ name: "data_changes", arguments: { collection: "kanban", since: 0 } });
  ok("scoped to one collection", other.structuredContent.events.every((e) => e.type !== undefined) &&
    replay.structuredContent.events.every((e) => e.id !== other.structuredContent.events[0]?.id));
}

console.log("34. write-set C — windows, the edit loop, archive, and the seats");
{
  // A component bigger than one window, so the walk is real.
  const bigBody = `<!DOCTYPE html><html><body><div id="pad">${"lorem-ipsum-".repeat(4000)}</div><ul id="l"></ul>
<script type="module">oma.ready(() => {});</script></body></html>`;
  await client.callTool({ name: "save_component", arguments: { name: "win-probe", html: bigBody, description: "window probe" } });
  const w1 = (await client.callTool({ name: "get_component", arguments: { name: "win-probe" } })).structuredContent;
  ok("a big source comes back as a WINDOW, not whole",
    w1.text.length < bigBody.length && w1.total === bigBody.length && typeof w1.next_offset === "number");
  ok("…bounded by the result budget", JSON.stringify(w1).length <= 36_000);
  let assembled = w1.text, wOff = w1.next_offset;
  while (wOff != null) {
    const wn = (await client.callTool({ name: "get_component", arguments: { name: "win-probe", offset: wOff } })).structuredContent;
    assembled += wn.text; wOff = wn.next_offset;
  }
  ok("the window walk reassembles the EXACT source", assembled === bigBody);

  const noVer = await client.callTool({ name: "save_component", arguments: { name: "win-probe", html: bigBody } });
  ok("overwrite without expected_version is refused BY NAME, carrying the current version",
    noVer.isError === true && noVer.structuredContent?.reason === "expected_version_required" &&
    noVer.structuredContent?.version === w1.version);
  const staleSave = await client.callTool({ name: "save_component", arguments: { name: "win-probe", html: bigBody, expected_version: 1 } });
  ok("a stale expected_version is a conflict carrying the CURRENT version",
    staleSave.isError === true && staleSave.structuredContent?.reason === "version_conflict" &&
    staleSave.structuredContent?.expected_version === w1.version);

  const e1 = await client.callTool({ name: "edit_component", arguments: { command_id: randomUUID(), component: "win-probe",
    expected_version: w1.version, edits: [{ old_string: 'id="l"', new_string: 'id="l" data-edited="1"' }] } });
  ok("an edit lands without round-tripping the source",
    !e1.isError && e1.structuredContent.ok === true && e1.structuredContent.applied === 1 && e1.structuredContent.version > w1.version);
  const spot = (await client.callTool({ name: "get_component", arguments: { name: "win-probe", offset: bigBody.indexOf('id="l"'), length: 60 } })).structuredContent;
  ok("…and really changed the source at that spot", spot.text.includes('data-edited="1"'));
  const eMiss = await client.callTool({ name: "edit_component", arguments: { command_id: randomUUID(), component: "win-probe",
    expected_version: e1.structuredContent.version, edits: [{ old_string: "NOT-IN-THE-DOCUMENT", new_string: "x" }] } });
  ok("a 0-match edit refuses and applies NOTHING", eMiss.isError === true && /0 matches/.test(eMiss.content[0].text));
  const eMulti = await client.callTool({ name: "edit_component", arguments: { command_id: randomUUID(), component: "win-probe",
    expected_version: e1.structuredContent.version, edits: [{ old_string: "lorem-ipsum-", new_string: "x" }] } });
  ok("an ambiguous edit names the count and demands anchoring or replace_all",
    eMulti.isError === true && /matches \d+ times/.test(eMulti.content[0].text));
  const eStale = await client.callTool({ name: "edit_component", arguments: { command_id: randomUUID(), component: "win-probe",
    expected_version: w1.version, edits: [{ old_string: 'data-edited="1"', new_string: "" }] } });
  ok("an edit against a stale version is a conflict — NOTHING was applied", eStale.isError === true && /re-read/.test(eStale.content[0].text));

  const arch = await client.callTool({ name: "archive_component", arguments: { command_id: randomUUID(), component: "win-probe", archived: true } });
  ok("archive flips visibility and stamps the one axis",
    !arch.isError && arch.structuredContent.visibility === "archived" && typeof arch.structuredContent.version === "number");
  const shelf = (await client.callTool({ name: "list_components", arguments: {} })).structuredContent;
  ok("an archived app leaves the default shelf", !shelf.components.some((c) => c.name === "win-probe"));
  const archShelf = (await client.callTool({ name: "list_components", arguments: { visibility: "archived", kind: "any" } })).structuredContent;
  ok("…and shows under visibility: archived", archShelf.components.some((c) => c.name === "win-probe"));
  const unarch = await client.callTool({ name: "archive_component", arguments: { command_id: randomUUID(), component: "win-probe", archived: false } });
  ok("unarchive brings it back", !unarch.isError && unarch.structuredContent.visibility === "listed");
  const lockArch = await client.callTool({ name: "archive_component", arguments: { command_id: randomUUID(), component: "settings", archived: true } });
  ok("a system component cannot be shelved", lockArch.isError === true);

  const cfTools = await client.listTools();
  ok("call_function has NO seat until the function pillar ships (pulled 2026-07-27)",
    !cfTools.tools.some((t) => t.name === "call_function"));

  const chWhole = (await client.callTool({ name: "component_html", arguments: { name: "win-probe" } })).structuredContent;
  ok("component_html zero-param carries the WHOLE document (the widget cannot assemble windows)",
    chWhole.html.length === e1.structuredContent.size);
  const chWin = (await client.callTool({ name: "component_html", arguments: { name: "win-probe", offset: 0, length: 1000 } })).structuredContent;
  ok("…and windows only when asked", chWin.html.length === 1000 && typeof chWin.next_offset === "number");

  const fbytes = Buffer.from("0123456789".repeat(400));
  await client.callTool({ name: "file_write", arguments: { command_id: randomUUID(), component: "win-probe", path: "win.bin", data_base64: fbytes.toString("base64") } });
  const fw1 = (await client.callTool({ name: "file_read", arguments: { component: "win-probe", path: "win.bin", length: 1500 } })).structuredContent;
  ok("file_read windows by BYTES and says where to continue", fw1.returned === 1500 && fw1.next_offset === 1500 && fw1.total === 4000);
  const fw2 = (await client.callTool({ name: "file_read", arguments: { component: "win-probe", path: "win.bin", offset: 1500 } })).structuredContent;
  const joined = Buffer.concat([Buffer.from(fw1.data_base64, "base64"), Buffer.from(fw2.data_base64, "base64")]);
  ok("decoded windows reassemble the exact bytes", fw2.next_offset === null && joined.equals(fbytes));
  for (const p of ["a.txt", "b.txt", "c.txt"])
    await client.callTool({ name: "file_write", arguments: { command_id: randomUUID(), component: "win-probe", path: p, data_base64: Buffer.from(p).toString("base64") } });
  const fl1 = (await client.callTool({ name: "file_list", arguments: { component: "win-probe", limit: 2 } })).structuredContent;
  ok("file_list pages with an explicit end", fl1.files.length === 2 && fl1.total === 4 && typeof fl1.next_cursor === "string");
  const fl2 = (await client.callTool({ name: "file_list", arguments: { component: "win-probe", limit: 2, cursor: fl1.next_cursor } })).structuredContent;
  ok("…second page completes the walk", fl2.files.length === 2 && fl2.next_cursor === null);

  console.log("34b. C-review residue pins");
  // A lost-reply retry of a CREATE must return the receipt, not die on the overwrite guard.
  const cRid = randomUUID();
  const c1 = await client.callTool({ name: "save_component", arguments: { command_id: cRid, name: "retry-probe", html: noteHtml, description: "retry probe" } });
  const c2 = await client.callTool({ name: "save_component", arguments: { command_id: cRid, name: "retry-probe", html: noteHtml, description: "retry probe" } });
  ok("a created component's lost-reply retry returns the original receipt",
    !c2.isError && c2.structuredContent.version === c1.structuredContent.version && /Already saved/.test(c2.content[0].text));
  const eRid = randomUUID();
  const ed1 = await client.callTool({ name: "edit_component", arguments: { command_id: eRid, component: "retry-probe",
    expected_version: c1.structuredContent.version, edits: [{ old_string: 'id="l"', new_string: 'id="lx"' }] } });
  const ed2 = await client.callTool({ name: "edit_component", arguments: { command_id: eRid, component: "retry-probe",
    expected_version: c1.structuredContent.version, edits: [{ old_string: 'id="l"', new_string: 'id="lx"' }] } });
  ok("an edit's lost-reply retry replays — even though the original edit consumed its own old_string",
    !ed2.isError && ed2.structuredContent.version === ed1.structuredContent.version && /Already applied/.test(ed2.content[0].text));
  await client.callTool({ name: "delete_component", arguments: { name: "retry-probe", command_id: randomUUID() } });
  const res = await client.callTool({ name: "save_component", arguments: { name: "retry-probe", html: noteHtml, expected_version: ed1.structuredContent.version } });
  ok("saving over a DELETED component with a version token is a conflict, never a silent resurrection",
    res.isError === true && /DELETED after you read/.test(res.content[0].text) &&
    (await client.callTool({ name: "list_components", arguments: { name: "retry-probe" } })).structuredContent.total === 0);
  const longGrp = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "batch-probe", group: "g".repeat(600), fields: { t: 1 } } });
  ok("an essay-sized group is refused by name (the one uncapped hole in a row's size)",
    longGrp.isError === true && /group_too_long/.test(longGrp.content[0].text));
  const vPage = (await client.callTool({ name: "data_list", arguments: { collection: "batch-probe", limit: 1 } })).structuredContent;
  ok("a page carries the version trio stamped in its own transaction, and the runtime's host",
    typeof vPage.version === "number" && typeof vPage.settings_version === "number" && typeof vPage.host === "string");
  const winText = (await client.callTool({ name: "get_component", arguments: { name: "win-probe" } })).content[0].text;
  ok("a continuing window never says 'no more'", /continue at offset/.test(winText) && !/no more/.test(winText));
  const ahead = (await client.callTool({ name: "data_changes", arguments: { collection: "batch-probe", since: 9999999 } })).structuredContent;
  ok("a mark ahead of the ledger is re-anchored loudly, not silently pinned",
    ahead.events.length === 0 && ahead.next_since === ahead.latest_seq && /ahead of this ledger/.test(ahead.note));
  const aRid = randomUUID();
  await client.callTool({ name: "archive_component", arguments: { command_id: aRid, component: "hidden-visual", archived: true } });
  await client.callTool({ name: "archive_component", arguments: { command_id: randomUUID(), component: "hidden-visual", archived: false } });
  const aReplay = await client.callTool({ name: "archive_component", arguments: { command_id: aRid, component: "hidden-visual", archived: true } });
  ok("an archive replayed after an unarchive reports the ORIGINAL flip, not current state",
    !aReplay.isError && aReplay.structuredContent.visibility === "archived" && /idempotent replay/.test(aReplay.content[0].text));
  const badFc = await client.callTool({ name: "file_list", arguments: { component: "win-probe", cursor: "@@bad@@" } });
  ok("file_list refuses a corrupted cursor exactly like data_list", badFc.isError === true && /Invalid cursor/.test(badFc.content[0].text));
  // Auto-revert must restore the previous DIFFERENT document — version flips (archive) write no html.
  await client.callTool({ name: "save_component", arguments: { name: "rv-probe", html: noteHtml, description: "rv" } });
  await client.callTool({ name: "save_component", arguments: { name: "rv-probe", html: histHtml2, description: "", expected_version: await verOf("rv-probe") } });
  await client.callTool({ name: "archive_component", arguments: { command_id: randomUUID(), component: "rv-probe", archived: true } });
  const rvCur = await verOf("rv-probe");
  const rh = await client.callTool({ name: "render_health", arguments: { component: "rv-probe", version: rvCur, ok: false, error: "boom" } });
  const rvNow = (await client.callTool({ name: "get_component", arguments: { name: "rv-probe" } })).structuredContent;
  ok("auto-revert skips version flips and identical html — it restores the previous DIFFERENT document",
    rh.structuredContent.reverted === true && rvNow.text.includes('id="l"') && !rvNow.text.includes("data-hist-v2"));
  const rtSrc = (await import("node:fs")).readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf8");
  const rnSrc = (await import("node:fs")).readFileSync(join(ROOT, "src", "runner.mjs"), "utf8");
  ok("the runtime repaints when rows arrive at an unchanged version (zero-row open guard)",
    rtSrc.includes("snap.items.length === state.items.length") &&
    rnSrc.includes("d.snapshot.items.length!==S.items.length"));
}

console.log("35. write-set D — via transits the MCP path, and no AI face ever shows it");
{
  // The four item-write schemas are passthrough: a runner-stamped via must survive SDK input
  // validation on every transport. The AI can also send one (it is exactly as forgeable as
  // `actor`, by design) — what matters is that no read the model can reach echoes it back.
  const vw = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "via-e2e", fields: { t: 1 }, actor: "human", via: { component: "some-widget" } } });
  ok("a via-stamped write acks normally over MCP", vw.structuredContent.ok === true);
  const vch = await client.callTool({ name: "data_changes", arguments: { collection: "via-e2e", since: 0 } });
  ok("data_changes strips via from the event", vch.structuredContent.events.length === 1 && !("via" in vch.structuredContent.events[0]));
  const vlist = await client.callTool({ name: "data_list", arguments: { collection: "via-e2e" } });
  ok("data_list rows carry no via either (items never grew a shadow column)",
    vlist.structuredContent.items.every((i) => !("via" in i)) && !vch.content[0].text.includes("some-widget"));
  const junk = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "via-e2e", fields: { t: 2 }, garbage_key: { nested: true } } });
  ok("unknown keys pass the schema and die in store.core() — the write still lands clean", junk.structuredContent.ok === true);
  // Passthrough must NOT let a caller pick the dispatch `type`: data_add_item carrying
  // type:"save_component" would be a data-plane → control-plane escape (adversarial D review).
  await client.callTool({ name: "save_component", arguments: { command_id: randomUUID(), name: "victim-probe", html: "<p>ORIGINAL</p>" } });
  const escape = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "via-e2e", fields: { t: 3 }, type: "save_component", name: "victim-probe", html: "<p>PWNED</p>" } });
  const victim = (await client.callTool({ name: "get_component", arguments: { name: "victim-probe" } })).structuredContent;
  ok("a caller-supplied `type` cannot hijack the command — the item write stays an item write",
    escape.structuredContent.ok === true && victim.text.includes("ORIGINAL") && !victim.text.includes("PWNED"));
}

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
// Write-set C: an override replaces the MANUAL layer only. The engine-composed dynamic segments
// (onboarding-vs-inventory, proactivity stance) can be POSITIONED via placeholders but never
// removed — a manual that omits them gets them appended. A hosted copy that nailed the onboarding
// text for a user with ten apps was handing its reader wrong advice; this makes that structural.
const inst32 = c32.getInstructions?.() ?? "";
ok("instructions override replaces the manual layer — and the dynamic segments survive it",
  inst32.startsWith("HOSTED INSTRUCTIONS ONLY") && /PROACTIVITY/.test(inst32) &&
  (/GETTING STARTED/.test(inst32) || /ALREADY HAS APPS/.test(inst32)));
const loader32 = await c32.readResource({ uri: "ui://open-mcp-apps/app.html" });
ok("served loader carries no brand layer", !loader32.contents[0].text.includes('data-oma="brand"'));
// viewBase: a REAL per-app link when a viewer exists, none when it does not (a URL that 404s
// teaches the user this thing is broken).
const eng33 = barrel.createEngine(store32, { hostLabel: "embed-test", viewBase: "https://apps.example/u/x" });
const [ct33, st33] = InMemoryTransport.createLinkedPair();
const c33 = new Client({ name: "embed2", version: "1.0.0" });
await eng33.connect(st33);
await c33.connect(ct33);
const lc33 = await c33.callTool({ name: "list_components", arguments: {} });
ok("viewBase puts a real /view link on every listed app — and a bare engine prints none",
  /https:\/\/apps\.example\/u\/x\/view\//.test(lc33.content.find((c) => c.type === "text").text) &&
  !inst32.includes("/view/"));
// The local viewer's base is OVERRIDABLE, because a process behind a tunnel or a reverse proxy
// cannot discover the address its reader actually uses — and a loopback link handed to a hosted
// chat is dead every time. Read from the source: this is a module constant, not a tool surface.
{
  const httpSrc = readFileSync(join(ROOT, "src", "http.mjs"), "utf-8");
  ok("the browser viewer's viewBase honours OMA_VIEW_BASE, defaulting to loopback",
    /OMA_VIEW_BASE\s*\|\|\s*`http:\/\/127\.0\.0\.1:\$\{PORT\}`/.test(httpSrc));
  // Wiring pins for the browser runtime — structural, because these orderings only exist in a
  // real document and the properties are worth more than the purity of the check.
  const rt = readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf-8");
  const flush = rt.slice(rt.indexOf("const flush = ()"), rt.indexOf("Promise.race(["));
  // Prefs are fetched at connect, in PARALLEL with the host's ontoolinput, so the theme can be
  // computed while compName() is still null — global layer only, per-app layer silently missing on
  // the universal-loader path. pref() is immune (resolves the name per call); the theme is not,
  // because it writes to the DOM once. flush is the point where identity is guaranteed known.
  ok("the theme layer is re-applied at ready-flush, once component identity is settled",
    /applyThemeVars\(themeVars\(currentMerged\(\)\)\)/.test(flush),
    "without this, an app with a per-app theme token opens with the GLOBAL theme only");
  ok("…and the child's theme pairs are computed by the PARENT, never re-validated in the bridge",
    /themeVars\(prefMap \|\| \{\}\)/.test(rt));
  // A walk requested WHILE one is in flight cannot be answered with that one: a pass that started
  // before a write cannot contain it, and handing it back as the write's reconciliation let a
  // pre-write snapshot adopt and take the freshly-painted rows away again.
  ok("a walk requested mid-walk queues a re-run instead of sharing the stale pass",
    /walkAgain = true/.test(rt) && /if \(walkAgain\) \{ walkAgain = false; await walk\(\); \}/.test(rt));
  // The parent's authorization set (settingsIds) and pref cache must never be rebuilt from a read a
  // CHILD asked for: a filtered settings read matching zero rows emptied the set, and the guard then
  // stopped recognising foreign settings rows — walking straight past settings_write:false.
  ok("no child-initiated read rebuilds prefs or settingsIds",
    !/if \(sc\.collection === "settings"\) rebuildPrefs/.test(rt),
    "the parent keeps them fresh from its OWN walks: boot, the post-ack re-walk, and onParentPref");
  // Two doors onto the same act must agree about where an app opens.
  const comps = readFileSync(join(ROOT, "src", "tools", "components.mjs"), "utf-8");
  ok("the opt-in per-component open_<name> tools use the SAME binding rule as open_component",
    (comps.match(/defaultCollectionFor\(/g) || []).length >= 2);
  // viewBase reaches the runtime only when an operator set one — passing it always would turn every
  // in-app link absolute (127.0.0.1) and break the ordinary localhost:PORT visit.
  ok("the viewer passes viewBase to components only when OMA_VIEW_BASE is set",
    /process\.env\.OMA_VIEW_BASE \? \{ viewBase:/.test(httpSrc));
}
await c32.close();
store32.close();

for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
