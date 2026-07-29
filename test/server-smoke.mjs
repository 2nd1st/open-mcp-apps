// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/server-smoke.mjs — end-to-end proof of the ENGINE over real stdio.
// Covers the creation loop itself: seed apps present → generic data flow →
// save_app at runtime → the open_<name> tool appears dynamically → shell-wrapped ui://.
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
    store.execute({ type: "save_app", command_id: "seed-" + file, name: basename(file, ".html"),
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
  // OMA_DYNAMIC_TOOLS=1: this suite covers the opt-in per-app tool path;
  // http-smoke covers the default (open_app-only) behavior.
  env: { ...process.env, OMA_DB: DB, OMA_HOST: "smoke", OMA_DYNAMIC_TOOLS: "1" },
}));
console.log("connected over stdio");

console.log("0. server instructions teach when-to-use");
const instr = client.getInstructions?.();
ok("instructions delivered at initialize", typeof instr === "string" && instr.includes("ROUTING:"));
ok("instructions teach persisting files (file_write)", typeof instr === "string" && /FILES/.test(instr) && /file_write/.test(instr));

console.log("1. seed apps are live as dynamic tools");
let { tools } = await client.listTools();
let names = tools.map((t) => t.name);
ok("open_habit_streaks + open_meal_planner exist", names.includes("open_habit_streaks") && names.includes("open_meal_planner"));
ok("engine tools exist", ["get_app_guide", "list_apps", "save_app", "get_app", "data_add_item", "data_move_item"].every((n) => names.includes(n)));
const openHabits = tools.find((t) => t.name === "open_habit_streaks");
ok("open_habit_streaks carries ui://", openHabits?._meta?.ui?.resourceUri === "ui://open-mcp-apps/habit-streaks.html");
ok("data tools carry NO ui://", !tools.find((t) => t.name === "data_add_item")?._meta?.ui?.resourceUri);

console.log("2. ui:// resource is shell-wrapped");
const res = await client.readResource({ uri: "ui://open-mcp-apps/habit-streaks.html" });
const doc = res.contents[0];
ok("MIME correct", doc.mimeType === "text/html;profile=mcp-app");
ok("shell runtime injected", doc.text.includes('data-oma="runtime"') && doc.text.includes("window.oma"));
ok("design tokens injected", doc.text.includes('data-oma="tokens"'));
ok("app version injected (render-health identity)", doc.text.includes("__OMA_APP_VERSION__"));
ok("early-error buffer injected before app code", doc.text.includes("__OMA_EARLY_ERRORS__"));

console.log("2b-lib. every shipped library entry can actually be previewed");
// One entry shipped with fixtures in the DOCUMENTED shape ({collection, group, fields}) and its
// preview failed output validation on every host, because the tool declared the full store-item
// shape instead. The card said "preview unavailable" and the app swallowed the reason.
// Sweeping all of them is the only assertion that catches the next one.
{
  const entries = (await client.callTool({ name: "library_list", arguments: {} })).structuredContent.entries;
  const broken = [];
  for (const e of entries) {
    const r = await client.callTool({ name: "library_preview", arguments: { name: e.name } }).catch((err) => ({ isError: true, content: [{ text: String(err.message) }] }));
    if (r.isError || !r.structuredContent?.html) broken.push(e.name);
  }
  ok(`all ${entries.length} library entries preview cleanly`, broken.length === 0, `broken: ${broken.join(", ")}`);
}

console.log("2b-ui. widget security declaration (ChatGPT submission gate)");
// ChatGPT's connector page flags a template with no widget CSP and no widget domain, and its
// reference calls the domain "required when submitting a plugin with UI". Ours is the easiest
// possible declaration to make honestly: every shipped app is self-contained (verified —
// zero absolute URLs), so the truthful answer is also the strictest one, and it stops being a
// claim in a README the moment it is on the wire.
{
  const meta = (await client.readResource({ uri: "ui://open-mcp-apps/app.html" })).contents[0]._meta;
  ok("the loader declares an EMPTY CSP allowlist — self-contained, and it says so",
    meta?.ui?.csp?.connectDomains?.length === 0 && meta?.ui?.csp?.resourceDomains?.length === 0, JSON.stringify(meta?.ui?.csp));
  // Declaring frameDomains buys a stricter review for a capability we do not want; omitting it
  // means frame-src 'none', which measurably does NOT affect our srcdoc previews.
  ok("…and does NOT declare frameDomains", meta?.ui?.csp?.frameDomains === undefined);
  ok("ChatGPT's legacy snake_case twin is sent and agrees",
    meta?.["openai/widgetCSP"]?.connect_domains?.length === 0 && meta?.["openai/widgetCSP"]?.resource_domains?.length === 0);
  // The domain is per-SUBMISSION ("must be unique per plugin"), so the engine must never invent one.
  ok("no widget domain is invented when the deployment did not set one",
    meta?.ui?.domain === undefined && meta?.["openai/widgetDomain"] === undefined);
  const listed = (await client.listResources()).resources.find((r) => r.uri.endsWith("app.html"));
  // Asserted by VALUE, not by presence. `!== undefined` passed on `csp: {}` — an empty object is
  // exactly what a half-built declaration looks like, and the listing is the copy a reviewer reads
  // at connection time, so "something is there" is the wrong question. The listing must carry the
  // SAME empty allowlists the read does.
  ok("the listing carries the same declaration the read does (what a reviewer sees at connection time)",
    listed?._meta?.ui?.csp?.connectDomains?.length === 0
    && listed?._meta?.ui?.csp?.resourceDomains?.length === 0
    && JSON.stringify(listed?._meta?.ui?.csp) === JSON.stringify(meta?.ui?.csp),
    JSON.stringify(listed?._meta?.ui?.csp));
}

console.log("2c. cache hints on every cacheable result (SEP-2549, src/cache-hints.mjs)");
{
  // The RC requires ttlMs + cacheScope on tools/list, resources/list, resources/read and
  // resources/templates/list. What matters here is not that the fields EXIST but that the scope
  // tells the truth: "public" invites a shared gateway to serve one tenant's bytes to another, so
  // every store-derived answer has to be private. This test is the guard on that distinction.
  const listed = await client.listResources();
  ok("resources/list carries hints", typeof listed.ttlMs === "number" && listed.ttlMs >= 0);
  ok('resources/list is private — it enumerates THIS tenant\'s app names',
    listed.cacheScope === "private", listed.cacheScope);
  ok("per-app read is private", res.cacheScope === "private", res.cacheScope);
  ok("per-app read promises no freshness — the AI can rewrite the app mid-sentence",
    res.ttlMs === 0, String(res.ttlMs));

  const loaderRead = await client.readResource({ uri: "ui://open-mcp-apps/app.html" });
  ok("the loader is public — wrapLoader() is engine-constant, identical for every tenant",
    loaderRead.cacheScope === "public", loaderRead.cacheScope);
  // 🔴 This used to assert ttlMs > 0 — "cacheable for real, a shared gateway fetches the hot path
  // once" — which is the bug written down as a specification. The loader's URI is one constant
  // string for the life of the project, so a freshness promise made by one build outlives it and
  // cannot be withdrawn. Measured on stg 2026-07-29: eight minutes of serving the PREVIOUS build's
  // document after a deploy, with no way for anyone testing to know which side of the line they
  // were on. A promise we cannot keep is not an optimisation.
  ok("🔴 the loader promises NO freshness — its URI never changes, so a window can never be closed",
    loaderRead.ttlMs === 0, String(loaderRead.ttlMs));

  // 🔴 THE OTHER BRANCH — the one SaaS prod actually takes, and it had ZERO coverage while the
  // comment above deploymentSpecific() said, verbatim, "the test pins the two cases". Only the
  // no-domain side was pinned; that sentence was false. Both sides are pinned now.
  //
  // Why it matters: `public` invites a shared gateway to serve one deployment's bytes to another,
  // and the widget security declaration attaches DEPLOYMENT-derived fields (`ui.domain`, and
  // redirect_domains derived from viewBase). Two deployments then answer the same URI with
  // different metadata while both say "public".
  {
    const { openStore: openS } = await import("../src/store.mjs");
    const { createEngine: mkEngine } = await import("../src/engine.mjs");
    const { Client: Cl } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const probe = join(ROOT, "test", "scope-probe.db");
    const scopeOf = async (opts) => {
      for (const f of [probe, probe + "-wal", probe + "-shm"]) if (existsSync(f)) unlinkSync(f);
      const st2 = openS(probe);
      const eng = mkEngine(st2, opts);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const cl = new Cl({ name: "scope-probe", version: "1" }, { capabilities: {} });
      await Promise.all([eng.connect(a), cl.connect(b)]);
      const r = await cl.readResource({ uri: "ui://open-mcp-apps/app.html" });
      await cl.close(); st2.close();
      return { scope: r.cacheScope, ttl: r.ttlMs };
    };
    const plain = await scopeOf({});
    ok("baseline: with no deployment-derived metadata the loader stays public", plain.scope === "public", JSON.stringify(plain));
    const domained = await scopeOf({ widgetDomain: "https://widgets.example.test" });
    ok("🔴 a deployment that sets widgetDomain drops the loader to PRIVATE",
      domained.scope === "private", JSON.stringify(domained));
    const viewed = await scopeOf({ viewBase: "https://viewer.example.test" });
    ok("🔴 …and so does one whose viewBase makes redirect_domains deployment-specific",
      viewed.scope === "private", JSON.stringify(viewed));
    for (const f of [probe, probe + "-wal", probe + "-shm"]) if (existsSync(f)) unlinkSync(f);
  }

  // Pins the premise of calling the template list public. If a store-derived template ever gets
  // registered, this fails and the scope decision comes back up for review.
  const templates = await client.listResourceTemplates();
  ok("resource templates: none registered, so the list is engine-constant",
    (templates.resourceTemplates ?? []).length === 0 && templates.cacheScope === "public",
    `${(templates.resourceTemplates ?? []).length} template(s), scope ${templates.cacheScope}`);
}

// An app now declares itself INSIDE its document, so a test that wants a declaration builds
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

console.log("4. THE LOOP: save a brand-new app at runtime");
const guide = await client.callTool({ name: "get_app_guide", arguments: {} });
ok("guide teaches window.oma", guide.content[0].text.includes("oma.addItem") && guide.content[0].text.includes("oma.sendMessage"));
const noteHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><ul id="l"></ul>
<script type="module">
  const r = (s) => { document.getElementById("l").innerHTML = s.items.map((i) => "<li>" + i.fields.text + "</li>").join(""); };
  oma.ready(r); oma.onChange(r);
</script></body></html>`;
// Overwrites need the version the author read (write-set C contract) — this helper is the test's
// "I just looked" shorthand.
const verOf = async (n) => (await client.callTool({ name: "list_apps", arguments: { name: n } })).structuredContent.apps[0]?.version;
const save = await client.callTool({ name: "save_app", arguments: { name: "smoke-notes", html: noteHtml, description: "simple note list" } });
// The echoed version is the GLOBAL ledger seq (three-axis merge), so it moves whenever the seed
// set grows. The old literal 'v1' check survived v12 only because "v12" CONTAINS "v1" — substring
// luck, not a passing test. Pin the shape, not a number the seed count controls.
ok("saved (fresh app, seq-numbered)", /Saved "smoke-notes" v\d+/.test(save.content[0].text));
({ tools } = await client.listTools());
names = tools.map((t) => t.name);
ok("open_smoke_notes appeared DYNAMICALLY", names.includes("open_smoke_notes"));
ok("open_smoke_notes carries its ui://", tools.find((t) => t.name === "open_smoke_notes")?._meta?.ui?.resourceUri === "ui://open-mcp-apps/smoke-notes.html");
const notesRes = await client.readResource({ uri: "ui://open-mcp-apps/smoke-notes.html" });
ok("new app served shell-wrapped", notesRes.contents[0].text.includes("window.oma") && notesRes.contents[0].text.includes('id="l"'));

console.log("5. app update = new version, served immediately");
const save2 = await client.callTool({ name: "save_app", arguments: { name: "smoke-notes", html: noteHtml.replace('id="l"', 'id="l" class="v2"'), description: "", expected_version: save.structuredContent.version } });
// An app's version is its ledger position too, so "the second save" is a LARGER number, not 2.
ok("the second save advanced the version", /updated/.test(save2.content[0].text) && /Saved "smoke-notes" v\d+/.test(save2.content[0].text));
const notesV2 = await client.readResource({ uri: "ui://open-mcp-apps/smoke-notes.html" });
ok("resource serves v2 live (no re-register)", notesV2.contents[0].text.includes('class="v2"'));
const seedCount = readdirSync(join(ROOT, "components")).filter((f) => f.endsWith(".html")).length;
const listC = await client.callTool({ name: "list_apps", arguments: {} });
ok(`registry lists ${seedCount} seeds + smoke-notes`, listC.structuredContent.apps.length === seedCount + 1);
// Found by the live-model eval (test/eval-live.mjs, task "onboarding"): a brand-new user's registry
// is NOT empty, because we seed three system apps — so the one line that pushed toward BUILDING
// ("Registry is empty…") could never fire, and the model sometimes opened settings/dashboard rather
// than making the user an app. INSTRUCTIONS already forbade that, in prose. Prose lost.
{
  const listText = listC.content.map((c) => c.text).join("\n");
  ok("the seeded apps are marked as the engine's, right where the model is choosing",
    /dashboard[^\n]*ships with the engine/.test(listText), listText.split("\n").slice(0, 4).join(" | "));
  ok("a user-authored app is NOT marked that way",
    /smoke-notes[^\n]*(?!ships with the engine)/.test(listText) && !/smoke-notes[^\n]*ships with the engine/.test(listText));
  ok("with an app of their own, no build nudge is printed", !/NO apps of their own/.test(listText));
}

console.log("6. universal opener: zero-wait open of a just-saved app");
const openTool = tools.find((t) => t.name === "open_app");
ok("open_app is a static tool with the loader ui://", openTool?._meta?.ui?.resourceUri === "ui://open-mcp-apps/app.html");
const loaderRes = await client.readResource({ uri: "ui://open-mcp-apps/app.html" });
ok("loader resource shell-wrapped + has loader", loaderRes.contents[0].text.includes('data-oma="loader"') && loaderRes.contents[0].text.includes("app_html"));
const openNow = await client.callTool({ name: "open_app", arguments: { app: "smoke-notes" } });
ok("open_app works immediately for the fresh app", openNow.structuredContent?.app === "smoke-notes" && openNow.structuredContent?.collection === "smoke-notes");
const chtml = await client.callTool({ name: "app_html", arguments: { name: "smoke-notes" } });
ok("app_html feeds the loader (html in structuredContent)", chtml.structuredContent?.html?.includes('class="v2"') && chtml.structuredContent?.version > 0);
ok("app_html keeps model context tiny", chtml.content[0].text.length < 200);
const openMissing = await client.callTool({ name: "open_app", arguments: { app: "does-not-exist" } });
ok("open_app rejects unknown app", openMissing.isError === true);

console.log("6b. data_collections — discoverability");
const colls = await client.callTool({ name: "data_collections", arguments: {} });
ok("lists the kanban collection with count", colls.structuredContent.collections.some((c) => c.collection === "kanban" && c.items === 1));
ok("model-readable summary", colls.content[0].text.includes("kanban: 1 item"));

console.log("7. guardrails");
const badName = await client.callTool({ name: "save_app", arguments: { name: "Bad Name!", html: noteHtml } });
ok("bad name rejected", badName.isError === true);
const extUrl = await client.callTool({ name: "save_app", arguments: { name: "ext-test", html: noteHtml.replace("<ul", '<script src="https://evil.example/x.js"></script><ul') } });
ok("external URL warned", extUrl.content[0].text.includes("External URLs detected"));
const noOma = await client.callTool({ name: "save_app", arguments: { name: "static-test", html: "<!DOCTYPE html><html><body><h1>static</h1>no api here, just markup filling the minimum size…</body></html>" } });
ok("no-oma warned", noOma.content[0].text.includes("never references the oma API"));
// …and the aliases a real app actually uses do NOT warn. A measured author re-sent an entire
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
    const r = await client.callTool({ name: "save_app", arguments: { name: "lint-" + label.replace(/[^a-z]+/g, "-").replace(/^-|-$/g, ""), html: wrap(js) } });
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
  const { seedSystemApps } = await import("../seed.mjs");
  const st = openStore(fresh);
  seedSystemApps(st);   // a real fresh install is NOT an empty registry — that is the whole point
  const blank = createEngine(st).server._instructions;
  ok("a user with nothing gets the GETTING STARTED onboarding hook", blank.includes("GETTING STARTED"));
  // The positive half of the eval finding: on a fresh install list_apps must SAY the user has
  // nothing, because the registry it shows them is not empty — it holds our three system apps.
  {
    const { InMemoryTransport: IMT } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [ct2, st2] = IMT.createLinkedPair();
    const eng2 = createEngine(st); await eng2.connect(st2);
    const c2 = new Client({ name: "fresh", version: "1.0.0" }); await c2.connect(ct2);
    const txt = (await c2.callTool({ name: "list_apps", arguments: {} })).content.map((c) => c.text).join("\n");
    ok("a fresh install is TOLD the user has no apps yet, and what to do about it",
      /NO apps of their own/.test(txt) && /save_app/.test(txt), txt.slice(-160));
    await c2.close();
  }
  ok("the hook runs a personalized, history-aware onboarding",
    /past conversations/i.test(blank) && /offer a couple more/i.test(blank) && /best work/i.test(blank));
  ok("onboarding step 4 sets the cost expectation + proactivity preference",
    /proactivity/i.test(blank) && /tokens ONCE/i.test(blank) && /on-request/i.test(blank));

  st.execute({ type: "save_app", command_id: "onb-1", name: "expenses-2026",
    html: "<p>x</p>".repeat(200), description: "Expense tracker. Logs spending by merchant.", actor: "agent" });
  const settled = createEngine(st).server._instructions;
  ok("once they own an app, the onboarding procedure is GONE — it would be wrong advice",
    !settled.includes("GETTING STARTED"));
  ok("and it is REPLACED, not just deleted: the model is told apps already exist",
    /THE USER ALREADY HAS APPS HERE/.test(settled));
  ok("it points at the cheap call rather than inlining the answer",
    /list_apps/.test(settled) && /data_collections/.test(settled));
  ok("and warns against recreating or inventing names", /never invent one/i.test(settled) && /new name/i.test(settled));
  // 🔴 The regression this pins: an earlier version listed the user's actual app names here.
  // That put per-user, per-build data into the PREFIX — codex carries these instructions inside
  // tool_search's description, in req.tools — so every save_app would have invalidated the
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
// (d) save_app does NOT bump it (component_saved events carry no `collection`)
await client.callTool({ name: "save_app", arguments: { name: "smoke-notes", html: noteHtml.replace('id="l"', 'id="l" data-r="10"'), description: "", expected_version: await verOf("smoke-notes") } });
ok("save_app leaves settings_version unchanged", (await sv()) === sVer);
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

console.log("12. save_app rejects EVERY reserved name, and says which list it is on");
// This used to iterate a hand-typed copy of the six original names. The set grew to nine
// (`app`, `app`, `loader`) and neither the test nor the refusal text noticed — so the test
// passed while a user naming an app `app` was told it clashed with a settings group, which is not
// the rule that refused it. Both now read the SET, so the next addition is covered by construction.
{
  const { RESERVED_APP_NAMES } = await import("../src/contracts.mjs");
  const reserved = [...RESERVED_APP_NAMES];
  ok(`the reserved set is non-empty and read from source (${reserved.length} names)`, reserved.length >= 6);
  for (const rn of reserved) {
    const rr = await client.callTool({ name: "save_app", arguments: { name: rn, html: noteHtml } });
    ok(`reserved name "${rn}" rejected`, rr.isError === true, rr.content?.[0]?.text);
    // The message must name the whole rule, not a subset of it — that is the whole defect here.
    ok(`…and the refusal lists "${rn}" among the reserved names it is enforcing`,
      rr.isError === true && rr.content[0].text.includes(`"${rn}" is a reserved name`)
      && reserved.every((n) => rr.content[0].text.includes(n)),
      rr.content?.[0]?.text);
  }
}

console.log("12b. locked system apps — settings/library refuse tool-side save, restore & delete (seed/privileged exempt)");
for (const ln of ["settings", "library"]) {
  const lr = await client.callTool({ name: "save_app", arguments: { name: ln, html: noteHtml } });
  ok(`locked "${ln}" refuses save_app`, lr.isError === true && /locked system app/.test(lr.content[0].text));
  const lrr = await client.callTool({ name: "restore_app", arguments: { name: ln, checkpoint: 1 } });
  ok(`locked "${ln}" refuses restore_app`, lrr.isError === true && /locked system app/.test(lrr.content[0].text));
  const lrd = await client.callTool({ name: "delete_app", arguments: { name: ln, command_id: randomUUID() } });
  ok(`locked "${ln}" refuses delete_app`, lrd.isError === true && /locked system app/.test(lrd.content[0].text));
}
// dashboard is intentionally editable (the personal launcher) — a tool-side save must SUCCEED.
const dashSave = await client.callTool({ name: "save_app", arguments: { name: "dashboard", html: noteHtml, description: "editable launcher", expected_version: await verOf("dashboard") } });
ok("dashboard is NOT locked — save_app succeeds", !dashSave.isError && /Saved "dashboard"/.test(dashSave.content[0].text));

console.log("12c. 🔴 A STORE THAT PREDATES A RESERVED NAME MUST STILL BOOT (anti-brick)");
// `app` became a reserved app name on 2026-07-29. Reserving it stops NEW ones; it does
// nothing about a store written before that, and the engine has been public with users in it.
//
// The failure was total, not cosmetic: the per-app resource for an app called `app` claims
// `ui://open-mcp-apps/app.html`, which is the universal loader's own URI, so the loader's
// registration hit "already registered", createEngine threw, and the server did not come up.
// A server that will not start cannot be asked to delete anything — the only way out was editing
// SQLite by hand. Boot must survive its own data.
{
  const { openStore } = await import("../src/store.mjs");
  const { createEngine } = await import("../src/engine.mjs");
  const probe = join(ROOT, "test", "reserved-name-probe.db");
  const HTML = "<!doctype html><html><body>saved before the name was reserved, and still theirs</body></html>";
  const boot = (name) => {
    for (const f of [probe, probe + "-wal", probe + "-shm"]) if (existsSync(f)) unlinkSync(f);
    const st = openStore(probe);
    // The privileged path is how such a row got there: it predates today's reserved-name check.
    st.execute({ type: "save_app", command_id: randomUUID(), name, html: HTML, actor: "seed" });
    let err = null, eng = null;
    try { eng = createEngine(st); } catch (e) { err = e; }
    return { st, err, eng };
  };

  // The one that actually collides — measured, not assumed: only `app` shares the loader's URI.
  const a = boot("app");
  ok("🔴 a store holding an app named `app` still boots", a.err === null,
    a.err && `${a.err.constructor.name}: ${a.err.message}`);
  ok("…and the universal loader keeps its own URI (the app yields, the engine does not)",
    a.err === null && !!a.eng);
  ok("…and the app is still THERE — degraded, never deleted behind the user's back",
    a.st.listApps().some((c) => c.name === "app"));
  a.st.close();

  // The other two reserved names do NOT collide (their URIs are app.html / loader.html).
  // Asserted so nobody "fixes" them by widening the guard into something that skips real apps.
  for (const n of ["app", "loader"]) {
    const b = boot(n);
    ok(`an app named \`${n}\` was never a collision and still is not`, b.err === null,
      b.err && b.err.message);
    b.st.close();
  }
  for (const f of [probe, probe + "-wal", probe + "-shm"]) if (existsSync(f)) unlinkSync(f);
}

console.log("13. THE TOOL-SURFACE INVARIANT (docs/security-model.md §1.5 — lane A item A8)");
// The exact set of tool names the server registers TODAY (hardcoded on purpose: this list is a
// security contract, not something to auto-derive). Per-app openers are the ONLY dynamic
// surface — allowed via the open_<name> regex because this suite runs OMA_DYNAMIC_TOOLS=1.
const KNOWN_SAFE = new Set([
  "open_app", "app_html", "get_app_guide", "list_apps", "get_app", "save_app",
  "data_list", "data_collections", "data_add_item", "data_update_item", "data_move_item", "data_delete_item",
  "security_set",
  // PR-4 (design-system §7.5): both operate ONLY on the app registry table via prepared
  // statements — no process/fs/shell/socket primitive, no generic escape (security-model §1.5).
  "app_history", "delete_app",
  // P1 version-rollback: restore_app re-saves a historical html through the SAME
  // save_app command path (store.execute). No process/fs/shell/socket primitive.
  // (get_app_version RETIRED in write-set C — signed v0.3 break.)
  "restore_app",
  // F2 per-app file plane: all five go through the engine's file channel (src/files.mjs), which
  // confines fs to a per-app, content-addressed, traversal-immune blob store — no generic fs/shell/
  // socket primitive reachable from a tool (security-model §1.5). Bytes ride base64 but only ever
  // land under files/<app>/<sha256>.blob.
  "file_list", "file_read", "file_write", "file_delete",   // file_usage RETIRED in write-set C (file_list reports usage)
  // Chunked large-file write: same channel/backend as file_write — staging lives under the
  // backend's own .tmp (uuid names, never caller input), commit lands through the identical
  // write_file store transaction. No new fs surface beyond src/files.mjs (§1.5).
  "file_write_begin", "file_write_chunk", "file_write_commit", "file_write_abort",
  // data_version: read-only aggregate over change_event via prepared statements — no primitives.
  "data_version",
  // Write-set C additions (§1.5 review): edit_app applies exact-string replacements
  // in-memory and lands through the SAME save_app store path — no new primitive;
  // archive_app flips one registry column through a typed store command. (call_function's
  // seat was PULLED 2026-07-27 — it returns with its executor when OMA_FUNCTIONS lands, and
  // re-enters this list at that review.)
  "edit_app", "archive_app",
  // Library: library_list/library_preview/install_from_library read ONLY repo components/*.html
  // through src/library.mjs, whose name argument is APP_NAME_RE-validated (no dots/slashes
  // → no traversal) and whose dir is fixed at module load; library_preview additionally returns
  // the entry's EMBEDDED fixtures JSON (parsed, fail-null) — still the same fixed dir, no
  // primitives; install writes go through the same save_app store path with actor
  // "library" (provenance stamp; first-party content → local tier, direct render).
  "library_list", "library_preview", "install_from_library",
  // app_permissions: read-only projection of registry rows + tier presets + policy
  // overlays (computeCaps) — same data security_set/settings already expose, no primitives.
  "app_permissions",
  // ui_prefs_schema: returns a static in-engine catalog constant — no store read, no primitives.
  "ui_prefs_schema",
  // render_health: accepts a health report and can only trigger the SAME restore path as
  // restore_app (save_app via store.execute, local-tier + unlocked apps only,
  // 3-per-run budget). No fs/shell/socket primitive; worst abuse = rolling an app back to
  // its own earlier version, which restore_app already allows.
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
const DYNAMIC_OPEN_RE = /^open_[a-z0-9_]+$/; // per-app open_<name> (dynamic tools)
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
// app (engine.mjs: open_<name.replaceAll("-","_")>) — a static tool named open_url would fail here
const compTools = new Set((await client.callTool({ name: "list_apps", arguments: {} })).structuredContent.apps.map((c) => "open_" + c.name.replaceAll("-", "_")));
const rogueOpen = names.filter((n) => !KNOWN_SAFE.has(n) && DYNAMIC_OPEN_RE.test(n) && !compTools.has(n));
ok(
  rogueOpen.length
    ? "ROGUE open_* tool(s) not backed by an app: " + rogueOpen.join(", ")
    : "every dynamic open_* maps to a registered app",
  rogueOpen.length === 0,
);

// ORDERING NOTE: sections 14+ save fixture apps and delete one. Under OMA_DYNAMIC_TOOLS=1
// a deleted app's open_<name> tool lingers until restart (documented behavior), so the
// rogue-open check in section 13 must keep running BEFORE these sections.

console.log("14. app_history — version metadata only, NEVER the html");
const histHtml1 = noteHtml;
const histHtml2 = noteHtml.replace("<ul", '<ul data-hist-v2=""');
await client.callTool({ name: "save_app", arguments: { name: "hist-probe", html: histHtml1, description: "history probe" } });
await client.callTool({ name: "save_app", arguments: { name: "hist-probe", html: histHtml2, description: "", expected_version: await verOf("hist-probe") } });
const hist = await client.callTool({ name: "app_history", arguments: { name: "hist-probe" } });
const hEntries = hist.structuredContent?.history || [];
ok("two saves → two history entries", !hist.isError && hEntries.length === 2);
ok("newest-first ordering", hEntries[0]?.checkpoint > hEntries[1]?.checkpoint);
ok("entries carry numeric html_size matching the saved bytes", hEntries[0]?.html_size === histHtml2.length && hEntries[1]?.html_size === histHtml1.length);
ok("entries carry a ts string", hEntries.every((h) => typeof h.ts === "string" && h.ts.length > 0));
ok("history NEVER carries the html itself", hEntries.every((h) => !("html" in h)) && !JSON.stringify(hist.structuredContent).includes("data-hist-v2"));
const histMissing = await client.callTool({ name: "app_history", arguments: { name: "no-such-comp" } });
ok("unknown app → clean error", histMissing.isError === true && /No history/.test(histMissing.content[0].text));

console.log("14b. checkpoint rollback — get_app_version is RETIRED; restore_app rolls forward a copy");
// hEntries is newest-first, and the vocabulary is now the app's own counter: checkpoint 1 is the
// first save. The ledger seq still exists underneath — it just no longer reaches this surface.
const gvGone = await client.callTool({ name: "get_app_version", arguments: { name: "hist-probe", checkpoint: 1 } });
ok("get_app_version is retired — the seat is gone", gvGone.isError === true && /not found/.test(gvGone.content[0].text));
// restore checkpoint 1 → re-saved as a NEW current one, history preserved, current html reverts.
const restore = await client.callTool({ name: "restore_app", arguments: { name: "hist-probe", checkpoint: 1 } });
ok("restore rolls FORWARD to a new checkpoint (history preserved, never rewritten)",
  !restore.isError && /from checkpoint 1/.test(restore.content[0].text));
const curAfter = await client.callTool({ name: "get_app", arguments: { name: "hist-probe" } });
ok("current source now matches the restored checkpoint (marker gone)", !curAfter.content[0].text.includes("data-hist-v2"));
const histAfter = await client.callTool({ name: "app_history", arguments: { name: "hist-probe" } });
ok("history grew to 3 checkpoints (nothing lost)", !histAfter.isError && histAfter.structuredContent.history.length === 3
  && histAfter.structuredContent.history.map((h) => h.checkpoint).join() === "3,2,1");
const restoreMissing = await client.callTool({ name: "restore_app", arguments: { name: "hist-probe", checkpoint: 99 } });
ok("restore of an unknown checkpoint → clean error", restoreMissing.isError === true && /No checkpoint 99/.test(restoreMissing.content[0].text));

console.log("15. delete_app — tombstone delete, idempotent replay");
await client.callTool({ name: "save_app", arguments: { name: "doomed", html: noteHtml, description: "delete fixture" } });
// a settings row under the app's group must SURVIVE the delete (no cascade — the
// settings app's Orphaned section is the janitor, docs/settings-design.md §7)
const dPref = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "settings", group: "doomed", fields: { key: "kept_after_delete", value: "yes" } } });
ok("settings row under the doomed group written", !dPref.isError);
const delCmdId = randomUUID();
const del1 = await client.callTool({ name: "delete_app", arguments: { name: "doomed", command_id: delCmdId } });
ok("delete succeeds", !del1.isError && del1.content[0].text.includes('Deleted "doomed"'));
const listAfterDel = await client.callTool({ name: "list_apps", arguments: {} });
ok("deleted app gone from list_apps", !listAfterDel.structuredContent.apps.some((c) => c.name === "doomed"));
const openGone = await client.callTool({ name: "open_app", arguments: { app: "doomed" } });
ok("open_app fails gracefully after delete", openGone.isError === true && /No app "doomed" in the registry/.test(openGone.content[0].text));
const histGone = await client.callTool({ name: "app_history", arguments: { name: "doomed" } });
ok("version history retained as tombstone", !histGone.isError && histGone.structuredContent.history.length === 1);
const sAfterDel = await client.callTool({ name: "data_list", arguments: { collection: "settings" } });
ok("settings items under the app's group survive the delete", sAfterDel.structuredContent.items.some((i) => i.group === "doomed" && i.fields.key === "kept_after_delete"));
const del2 = await client.callTool({ name: "delete_app", arguments: { name: "doomed", command_id: delCmdId } });
ok("same command_id replay is a no-op success (idempotent)", !del2.isError && del2.content[0].text.includes("already deleted"));
const delMissing = await client.callTool({ name: "delete_app", arguments: { name: "never-existed", command_id: randomUUID() } });
ok("deleting an unknown app fails cleanly", delMissing.isError === true && /No app "never-existed" in the registry/.test(delMissing.content[0].text));

console.log("15b. delete data:\"cascade\" — the plan is the confirmation, and sharing wins ties");
// "Delete means delete" (Leo 2026-07-28), with the one thing it must never do: break a SECOND app.
// Ownership evidence is weak by measurement (the manifest's collections key has zero real-world
// adoption; the ledger's via is stamped only on widget writes), so the rule is deliberately
// lopsided — an unproven collection is KEPT. Deleting too little leaves rows a user can delete
// again; deleting too much is silent breakage with the data gone.
{
  const mk = async (n) => client.callTool({ name: "save_app", arguments: { name: n, html: noteHtml, description: n } });
  await mk("cascade-app"); await mk("cascade-neighbour");
  const row = (collection, via) => client.callTool({ name: "data_add_item",
    arguments: { command_id: randomUUID(), collection, fields: { t: collection }, ...(via ? { via: { app: via } } : {}) } });
  await row("cascade-app", "cascade-app");            // the app's own, name-matched
  await row("shared-trips", "cascade-app");           // both apps have written here…
  await row("shared-trips", "cascade-neighbour");     // …so it is shared
  await row("orphan-notes", null);                    // AI-written only: nothing links it to anyone

  const planCall = await client.callTool({ name: "delete_app", arguments: { name: "cascade-app", data: "cascade", command_id: randomUUID() } });
  const plan = planCall.structuredContent;
  ok("step 1 returns a plan and deletes NOTHING", plan.ok === false && typeof plan.plan_token === "string"
    && !(await client.callTool({ name: "list_apps", arguments: {} })).structuredContent.apps.every((c) => c.name !== "cascade-app"));
  ok("the plan names the shared collection as kept, with a reason",
    plan.collections.some((c) => c.collection === "shared-trips" && c.verdict === "shared" && /also used by cascade-neighbour/.test(c.why)));
  ok("…and the app's own collection as the only thing it would remove",
    plan.collections.filter((c) => c.verdict === "exclusive").map((c) => c.collection).join() === "cascade-app");
  ok("the plan text says out loud that this cannot be undone", /CANNOT be undone/.test(planCall.content[0].text));

  const wrong = await client.callTool({ name: "delete_app", arguments: { name: "cascade-app", data: "cascade", plan_token: "0".repeat(16), command_id: randomUUID() } });
  ok("a token that does not match the CURRENT world is refused", wrong.structuredContent.ok === false && wrong.structuredContent.reason === "plan_changed");
  ok("…and nothing was deleted by the refused attempt",
    (await client.callTool({ name: "app_history", arguments: { name: "cascade-app" } })).structuredContent?.history?.length === 1
    && (await client.callTool({ name: "data_list", arguments: { collection: "cascade-app" } })).structuredContent.items.length === 1);

  // A collection that was ALREADY THERE when a same-named app arrived is not the app's to delete.
  // Sharing a name proves nothing, and "no other app wrote here" proves nothing either, because the
  // AI writes most rows with no via stamp. (Found by adversarial review; reproduced before fixing:
  // 50 rows of pre-existing user data classified exclusive purely on the name.)
  await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "older-than-its-app", fields: { t: "was here first" } } });
  await client.callTool({ name: "save_app", arguments: { name: "older-than-its-app", html: noteHtml, description: "same name, arrived later" } });
  const squat = (await client.callTool({ name: "delete_app", arguments: { name: "older-than-its-app", data: "cascade", command_id: randomUUID() } })).structuredContent;
  ok("a collection that predates its same-named app is NOT deletable data",
    squat.collections.find((c) => c.collection === "older-than-its-app")?.verdict !== "exclusive",
    JSON.stringify(squat.collections));

  const done = await client.callTool({ name: "delete_app", arguments: { name: "cascade-app", data: "cascade", plan_token: plan.plan_token, command_id: randomUUID() } });
  ok("the matching token executes", done.structuredContent.ok === true && done.structuredContent.removed[0].collection === "cascade-app");
  ok("the app's own rows are GONE", (await client.callTool({ name: "data_list", arguments: { collection: "cascade-app" } })).structuredContent.items.length === 0);
  ok("🔴 the SHARED collection survives — deleting one app never breaks another",
    (await client.callTool({ name: "data_list", arguments: { collection: "shared-trips" } })).structuredContent.items.length === 2);
  ok("a collection nobody can be proven to own survives too",
    (await client.callTool({ name: "data_list", arguments: { collection: "orphan-notes" } })).structuredContent.items.length === 1);
  ok("the neighbour app is untouched",
    (await client.callTool({ name: "list_apps", arguments: {} })).structuredContent.apps.some((c) => c.name === "cascade-neighbour"));
  // The collection's OWN stream has to say what happened to it. component_deleted alone did not:
  // per-collection ledger reads filter on payload.collection, so a widget bound to this collection
  // was told "nothing changed" while every row in it had just been destroyed (adversarial review).
  const evs = await client.callTool({ name: "data_changes", arguments: { collection: "cascade-app", since: 0 } });
  ok("the cleared collection's own stream reports it", !evs.isError && /rows_cleared/.test(evs.content[0].text), evs.content[0].text.slice(0, 160));
}

console.log("15b2. the plan token pins the ROWS, not just how many there were");
// "Confirming means the world still looks like what the user was shown" was the whole claim behind
// hashing the plan. It was only true at the granularity of a row COUNT: the hash covered
// {name, per-collection verdict/rows/why, settings_keys}, so replacing every row while keeping the
// count left a stale token valid — and the rows then destroyed had never appeared in any plan the
// user saw. Between showing a plan and confirming it there is a whole conversational turn, and a
// widget can write in it.
{
  await client.callTool({ name: "save_app", arguments: { name: "token-app", html: noteHtml, description: "token fixture" } });
  const mk = (t) => client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "token-app", fields: { t } } });
  const r1 = await mk("A1");
  const r2 = await mk("A2");

  const planA = (await client.callTool({ name: "delete_app", arguments: { name: "token-app", data: "cascade", command_id: randomUUID() } })).structuredContent;
  ok("a plan is offered for the two rows the user can see", planA.collections.find((c) => c.collection === "token-app")?.rows === 2);

  // The user reads the plan. Before they answer, the widget swaps the contents — same count.
  for (const r of [r1, r2])
    await client.callTool({ name: "data_delete_item", arguments: { command_id: randomUUID(), collection: "token-app", id: r.structuredContent.id } });
  await mk("B1-never-shown");
  await mk("B2-never-shown");

  const stale = await client.callTool({ name: "delete_app", arguments: { name: "token-app", data: "cascade", plan_token: planA.plan_token, command_id: randomUUID() } });
  ok("🔴 the old token is REFUSED once the rows themselves changed",
    stale.structuredContent.ok === false && stale.structuredContent.reason === "plan_changed",
    JSON.stringify(stale.structuredContent).slice(0, 200));
  ok("…and nothing was deleted on the way to saying no",
    (await client.callTool({ name: "data_list", arguments: { collection: "token-app" } })).structuredContent.items.length === 2);
  ok("…and a fresh plan comes back with it, so the user can be re-asked rather than stranded",
    typeof stale.structuredContent.plan_token === "string" && stale.structuredContent.plan_token !== planA.plan_token);

  const good = await client.callTool({ name: "delete_app", arguments: { name: "token-app", data: "cascade", plan_token: stale.structuredContent.plan_token, command_id: randomUUID() } });
  ok("the CURRENT plan's token still executes — the pin did not make cascade unusable",
    good.structuredContent.ok === true && good.structuredContent.removed[0].rows === 2,
    JSON.stringify(good.structuredContent).slice(0, 200));
}

console.log("15c. checkpoints — the number a person reads is not the ledger's");
// `version` IS the global ledger seq (save_app stamps the row with its event's seq — one
// ordinal axis, on purpose). That axis advances for every write in the store, so an app edited
// twice can show v5 then v43 and the user reasonably asks where 38 went. Nothing went anywhere;
// those were their groceries. The fix is presentation-only: the axis stays, the person gets a
// per-app counter. HARD CRITERION (D lane, 2026-07-28): what the user reads must not equal the seq.
{
  // Advance the global axis FIRST, so a coincidental match at 1 cannot make this pass by luck.
  for (let i = 0; i < 5; i++) await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "axis-noise", fields: { i } } });
  await client.callTool({ name: "save_app", arguments: { name: "cp-app", html: noteHtml, description: "checkpoint fixture" } });
  for (let i = 0; i < 7; i++) await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "axis-noise", fields: { j: i } } });
  const cur = (await client.callTool({ name: "get_app", arguments: { name: "cp-app" } })).structuredContent;
  await client.callTool({ name: "save_app", arguments: { name: "cp-app", html: noteHtml.replace("</body>", "<i>v2</i></body>"), expected_version: cur.version } });

  const h = await client.callTool({ name: "app_history", arguments: { name: "cp-app" } });
  const hist = h.structuredContent.history;
  const seq = (await client.callTool({ name: "get_app", arguments: { name: "cp-app" } })).structuredContent.version;
  ok("history counts this app's own saves: 2 checkpoints", hist.map((x) => x.checkpoint).join() === "2,1", JSON.stringify(hist.map((x) => x.checkpoint)));
  ok("…while the ledger seq underneath has jumped well past them", seq > hist.length + 5, `seq ${seq} vs ${hist.length} checkpoints`);
  // Compare the IDENTIFIERS the user reads, not every digit in the string: timestamps are full of
  // numbers, and matching those made this assertion pass or fail on whether the clock happened to
  // contain the current seq. What must never equal the ledger seq is the checkpoint the user is
  // told to name — so that is what is checked.
  const shown = [...h.content[0].text.matchAll(/checkpoint (\d+)/g)].map((m) => Number(m[1]));
  ok("🔴 no checkpoint the user reads equals the ledger seq",
    shown.length > 0 && !shown.includes(seq), `seq ${seq}, shown ${JSON.stringify(shown)}`);
  ok("…and the seq does not even travel in the payload any more", hist.every((x) => x.version === undefined));
  // The verb has to speak the same vocabulary, or the seq comes back through the only remaining door.
  const restored = await client.callTool({ name: "restore_app", arguments: { name: "cp-app", checkpoint: 1, command_id: randomUUID() } });
  ok("restore_app takes a checkpoint, not a version", !restored.isError && /from checkpoint 1/.test(restored.content[0].text));
  const bad = await client.callTool({ name: "restore_app", arguments: { name: "cp-app", checkpoint: 99, command_id: randomUUID() } });
  ok("…and an out-of-range checkpoint fails by saying how many there are", bad.isError === true && /it has \d+/.test(bad.content[0].text));
}

console.log("16. scene now travels in the declaration — valid slug filed, unknown slug warned");
// scene moved out of the tool's parameters and into the document, like everything else an app
// says about itself. The COLUMN still exists and the Library still reads it — it is a projection of
// the declaration, kept so a taxonomy query never has to parse JSON.
const sceneOk = await client.callTool({ name: "save_app", arguments: { name: "scene-probe", description: "scene fixture",
  html: withDecl(noteHtml, { manifest_version: 2, scene: { category_id: "local-tools", tags: ["probe"] } }) } });
ok("a declared scene saves without a warning", !sceneOk.isError && sceneOk.content[0].text.includes('Saved "scene-probe"') && !sceneOk.content[0].text.includes("Unknown scene.category_id"));
const sceneBad = await client.callTool({ name: "save_app", arguments: { name: "scene-bad",
  html: withDecl(noteHtml, { manifest_version: 2, scene: { category_id: "not-a-real-slug" } }) } });
ok("an unknown category_id → the save still succeeds (our taxonomy, not the author's fault)", !sceneBad.isError && sceneBad.content[0].text.includes('Saved "scene-bad"'));
ok("...and the reply says the Library will not file it", /Unknown scene\.category_id "not-a-real-slug"/.test(sceneBad.content[0].text));
const sceneComps = (await client.callTool({ name: "list_apps", arguments: {} })).structuredContent.apps;
ok("a declared scene is projected into the column list_apps reads", sceneComps.find((c) => c.name === "scene-probe")?.category_id === "local-tools");
ok("scene-less apps carry category_id null (uniform schema)", sceneComps.find((c) => c.name === "habit-streaks")?.category_id === null);
// The old parameters are gone, and a caller that still sends them is TOLD rather than silently ignored.
const oldParam = await client.callTool({ name: "save_app", arguments: { name: "scene-probe", html: noteHtml, scene: { category_id: "local-tools" } } });
ok("passing the retired scene/manifest parameter is refused, with where the declaration lives now",
  oldParam.isError === true && /no longer parameters/.test(oldParam.content[0].text) && /oma-manifest/.test(oldParam.content[0].text));

console.log("17. trust tiers & caps — app_html carries {author, tier, caps}");
// (a) local tier: seed/agent/human authors run direct with the all-allow preset
const localTier = (await client.callTool({ name: "app_html", arguments: { name: "habit-streaks" } })).structuredContent;
ok("seed-authored → tier local", localTier.author === "seed" && localTier.tier === "local");
ok("local caps: call_tools is the wildcard", Array.isArray(localTier.caps?.call_tools) && localTier.caps.call_tools.length === 1 && localTier.caps.call_tools[0] === "*");
ok("local caps: messaging + settings allowed, delete_items allow", localTier.caps.send_message === true && localTier.caps.update_context === true && localTier.caps.settings_write === true && localTier.caps.delete_items === "allow");
// (b) NON-local fixture: written through a second store handle on the same file. WAL tolerates
// our short-lived writer next to the server's connection; the write is fully committed (handle
// closed) before the next MCP call, so the server's fresh read transaction sees it.
{
  const direct = openStore(DB);
  const r = direct.execute({ type: "save_app", command_id: randomUUID(), name: "library-fixture",
    html: "<!DOCTYPE html><html><body><div id='lib'>library fixture — not locally authored</div></body></html>",
    actor: "library-test" });
  direct.close();
  ok("fixture written directly with author library-test", r.ok === true);
}
const unrev = (await client.callTool({ name: "app_html", arguments: { name: "library-fixture" } })).structuredContent;
ok("unknown author → tier unreviewed", unrev.author === "library-test" && unrev.tier === "unreviewed");
ok("unreviewed caps: empty call_tools, no messaging", unrev.caps.call_tools.length === 0 && unrev.caps.send_message === false && unrev.caps.update_context === false);
ok("unreviewed caps: delete_items deny; cross/settings/source all denied", unrev.caps.delete_items === "deny" && unrev.caps.cross_collection_read === false && unrev.caps.cross_collection_write === false && unrev.caps.settings_write === false && unrev.caps.read_source === false);
// (c) security:<app>:<cap> overlay via the privileged writer flips exactly ONE cap
const ovr = await client.callTool({ name: "security_set", arguments: { key: "security:library-fixture:send_message", value: "allow" } });
ok("security_set writes the per-app overlay row", !ovr.isError);
const unrev2 = (await client.callTool({ name: "app_html", arguments: { name: "library-fixture" } })).structuredContent;
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
// form-action is pinned with the rest because it is the one directive that does NOT inherit
// default-src: drop it and a form post walks out while every other directive still reads 'none'.
ok("runner CSP policy present (default/connect/frame/form-action all 'none')", loaderDoc.includes("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'"));
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
ok("control-plane denylist present with every registry/policy-mutating tool", runnerSrc.includes("isControlPlaneTool(tl)") && ["security_set", "save_app", "edit_app", "archive_app", "delete_app", "restore_app", "install_from_library", "render_health"].every((n) => policySrc.includes('"' + n + '"')));
ok("control-plane deny also covers future library_* tools AND internal `_` RPC names", policySrc.includes('indexOf("library_") === 0') && policySrc.includes('indexOf("_") === 0'));
ok("control-plane tools rejected with a clear message", runnerSrc.includes("is not available to apps") && loaderDoc.includes("is not available to apps"));
// CSP-first: the runner builds our own <head> with the CSP as the FIRST child; it never anchors
// on the app's own <head> (a pre-<head> script would otherwise run before the policy).
ok("runner builds CSP-first document, not a <head>-anchored splice", runnerSrc.includes('"<!doctype html><html><head>" + RUNNER_CSP') && !/\.replace\(\s*\/<head/.test(runnerSrc) && loaderDoc.includes("<!doctype html><html><head>"));

console.log("19. policy-key naming — snake_case canonical; dotted/unknown stored but inert + warned");
const dottedSet = await client.callTool({ name: "security_set", arguments: { key: "security:habit-streaks:sendMessage", value: "deny" } });
ok("security_set stores an unknown/dotted cap but WARNS", !dottedSet.isError && /send_message|valid cap|unknown cap|snake_case/i.test(dottedSet.content[0].text));
const habitCaps2 = (await client.callTool({ name: "app_html", arguments: { name: "habit-streaks" } })).structuredContent.caps;
ok("dotted cap is inert — computeCaps reads only snake_case (habit-streaks local stays all-allow)", habitCaps2.send_message === true);

console.log("20. save_app scene — change, explicit clear, invalid preserves existing");
await client.callTool({ name: "save_app", arguments: { name: "scene-probe", html: noteHtml, scene: { category_id: "input-cocreate" } } });
await client.callTool({ name: "save_app", arguments: { name: "scene-probe", html: noteHtml, scene: null } });

console.log("21. version continuity — delete then recreate keeps history monotonic");
await client.callTool({ name: "save_app", arguments: { name: "ver-probe", html: noteHtml, description: "v1" } });
await client.callTool({ name: "save_app", arguments: { name: "ver-probe", html: histHtml2, description: "v2", expected_version: await verOf("ver-probe") } });
await client.callTool({ name: "delete_app", arguments: { name: "ver-probe", command_id: randomUUID() } });
await client.callTool({ name: "save_app", arguments: { name: "ver-probe", html: noteHtml, description: "v3", expected_version: await verOf("ver-probe") } });
const verHist = (await client.callTool({ name: "app_history", arguments: { name: "ver-probe" } })).structuredContent.history;
// Continuity across delete/recreate is FREE: the ledger never goes backwards, so a recreated
// app cannot collide with a tombstoned history row — the property the old maxHistVersion+1
// dance existed to hand-maintain.
//
// ⚠️ This assertion was rewritten 2026-07-29, and the rewrite is the interesting part. It used to
// read `verHist.length === 3 && checkpoints "3,2,1"` — three saves across a delete/recreate listed
// as one continuous history. That expression was ALSO the shape of a real defect: a name can be
// reused by an unrelated app, so "restore checkpoint 1" could hand a budget tracker the source of a
// deleted recipe app. History is now scoped to the app's current life, which changes the
// COUNT here without touching the property this test is named for.
//
// So the property is asserted directly instead of through a row count: the recreated app's version
// sits ABOVE the tombstoned ones (no collision, nothing overwritten), and its one checkpoint is its
// own. That the earlier rows survive in the table is pinned store-side, where it is observable —
// test/ledger-smoke.mjs §17 ("the previous life's source is still IN the table").
const verNow = await verOf("ver-probe");
ok("recreate keeps versions monotonic and collision-free (no REPLACE over a tombstone)",
  verNow >= 3 && verHist.length === 1 && verHist[0].checkpoint === 1,
  `version ${verNow}, ${verHist.length} checkpoint(s): ${JSON.stringify(verHist.map((h) => h.checkpoint))}`);

console.log("22. idempotency is bound to the command (type + target)");
const reuseId = randomUUID();
await client.callTool({ name: "save_app", arguments: { name: "reuse-a", html: noteHtml, description: "reuse fixture" } });
const delReuse = await client.callTool({ name: "delete_app", arguments: { name: "reuse-a", command_id: reuseId } });
ok("first delete with the id succeeds", !delReuse.isError);
await client.callTool({ name: "save_app", arguments: { name: "reuse-b", html: noteHtml, description: "second fixture" } });
const reuse = await client.callTool({ name: "delete_app", arguments: { name: "reuse-b", command_id: reuseId } });
ok("reusing a command_id for a DIFFERENT target is rejected (command_id_reused)", reuse.isError === true && /command_id|different command/i.test(reuse.content[0].text));
const stillThere = (await client.callTool({ name: "list_apps", arguments: {} })).structuredContent.apps;
ok("the different target was left untouched", stillThere.some((c) => c.name === "reuse-b"));

console.log("23. FILE PLANE (store-level) — per-app ref index, quota, OCC, idempotency, isolation");
{
  const fstore = openStore(DB);
  const cid = () => randomUUID();
  const shaA = "a".repeat(64), shaB = "b".repeat(64), shaC = "c".repeat(64);
  const w1 = fstore.execute({ type: "write_file", command_id: cid(), app: "file-test-a", path: "logo.png", sha256: shaA, size: 1024, mime: "image/png" });
  ok("write_file creates a ref stamped with its ledger position", w1.ok && w1.created && w1.meta.version > 0 && w1.meta.sha256 === shaA);
  const m1 = fstore.statFile("file-test-a", "logo.png");
  ok("statFile returns the meta", m1 && m1.size === 1024 && m1.mime === "image/png");
  const w2 = fstore.execute({ type: "write_file", command_id: cid(), app: "file-test-a", path: "logo.png", sha256: shaB, size: 2048, mime: "image/png" });
  ok("overwrite advances the version + reports freed_sha", w2.ok && !w2.created && w2.meta.version > w1.meta.version && w2.freed_sha === shaA);
  const wOcc = fstore.execute({ type: "write_file", command_id: cid(), app: "file-test-a", path: "logo.png", sha256: shaC, size: 512, mime: "image/png", expected_version: w1.meta.version });
  ok("stale expected_version → conflict", !wOcc.ok && wOcc.conflict === true && wOcc.expected === w2.meta.version);
  const idc = cid();
  const wi1 = fstore.execute({ type: "write_file", command_id: idc, app: "file-test-a", path: "doc.txt", sha256: shaC, size: 100, mime: "text/plain" });
  const wi2 = fstore.execute({ type: "write_file", command_id: idc, app: "file-test-a", path: "doc.txt", sha256: shaC, size: 100, mime: "text/plain" });
  ok("replayed command_id is idempotent (no new version)", wi1.ok && wi2.idempotent === true && fstore.statFile("file-test-a", "doc.txt").version === wi1.meta.version);
  ok("traversal path rejected", fstore.execute({ type: "write_file", command_id: cid(), app: "file-test-a", path: "../escape", sha256: shaA, size: 1 }).error === "bad_path");
  ok("bad sha256 rejected", fstore.execute({ type: "write_file", command_id: cid(), app: "file-test-a", path: "x.bin", sha256: "nothex", size: 1 }).error === "bad_sha256");
  ok("oversize rejected", fstore.execute({ type: "write_file", command_id: cid(), app: "file-test-a", path: "huge.bin", sha256: shaA, size: 250 * 1024 * 1024 + 1 }).error === "file_too_large");
  fstore.execute({ type: "write_file", command_id: cid(), app: "file-test-b", path: "b-only.dat", sha256: shaA, size: 10 });
  const listA = fstore.listFiles("file-test-a").map((r) => r.path);
  ok("listFiles is per-app scoped (no cross-app leak)", !listA.includes("b-only.dat") && fstore.listFiles("file-test-b").length === 1);
  fstore.execute({ type: "write_file", command_id: cid(), app: "file-test-b", path: "b-copy.dat", sha256: shaA, size: 10 });
  ok("within-app refcount counts a shared sha", fstore.blobRefcount("file-test-b", shaA) === 2);
  const del = fstore.execute({ type: "delete_file", command_id: cid(), app: "file-test-b", path: "b-copy.dat" });
  ok("delete_file frees the sha + drops the ref", del.ok && del.freed_sha === shaA && fstore.statFile("file-test-b", "b-copy.dat") === null && fstore.blobRefcount("file-test-b", shaA) === 1);
  ok("delete of a missing file → not_found", fstore.execute({ type: "delete_file", command_id: cid(), app: "file-test-b", path: "ghost" }).error === "not_found");
  const snapBefore = fstore.snapshot("file-test-a");
  fstore.execute({ type: "write_file", command_id: cid(), app: "file-test-a", path: "another.bin", sha256: shaB, size: 5 });
  const snapAfter = fstore.snapshot("file-test-a");
  ok("files_version bumps on file activity", snapAfter.files_version > snapBefore.files_version);
  ok("settings_version untouched by file activity", snapAfter.settings_version === snapBefore.settings_version);
  // app byte-quota fail-closed — LOGICAL bytes only, so no real bytes are written (the store records the number)
  const big = 250 * 1024 * 1024; // = MAX_FILE_BYTES; 20 × 250MiB = 5000MiB < 5GiB cap, the 21st crosses it
  for (let i = 0; i < 20; i++) fstore.execute({ type: "write_file", command_id: cid(), app: "quota-app", path: "big" + i, sha256: String(i).padStart(64, "0"), size: big });
  const over = fstore.execute({ type: "write_file", command_id: cid(), app: "quota-app", path: "over", sha256: "f".repeat(64), size: big });
  ok("per-app byte quota fails closed at the cap", !over.ok && over.error === "quota_exceeded");
  // OCC create-after-delete must NOT resurrect (review finding 4): a guarded write against a deleted row → conflict
  fstore.execute({ type: "write_file", command_id: cid(), app: "occ-app", path: "c.json", sha256: shaA, size: 10 });
  fstore.execute({ type: "delete_file", command_id: cid(), app: "occ-app", path: "c.json" });
  const resurrect = fstore.execute({ type: "write_file", command_id: cid(), app: "occ-app", path: "c.json", sha256: shaB, size: 10, expected_version: 1 });
  ok("guarded write against a deleted file → conflict (expected 0), NOT silent resurrection", !resurrect.ok && resurrect.conflict === true && resurrect.expected === 0);
  ok("create-if-absent (no expected_version) still works after delete", fstore.execute({ type: "write_file", command_id: cid(), app: "occ-app", path: "c.json", sha256: shaB, size: 10 }).ok);
  // app normalization (finding 5): a whitespace-padded app is rejected consistently, never a false idempotency reuse
  ok("whitespace-padded app rejected as bad_app (no trim asymmetry)", fstore.execute({ type: "write_file", command_id: cid(), app: "padded ", path: "x", sha256: shaA, size: 1 }).error === "bad_app");
  fstore.close();
}

console.log("24. FILE TOOLS (engine) — write/read roundtrip, list, usage, delete, caps seam");
const fcid = () => randomUUID();
const payload = Buffer.from("engine file tools roundtrip ✓ 中文 bytes").toString("base64");
const fw = await client.callTool({ name: "file_write", arguments: { command_id: fcid(), app: "smoke-notes", path: "note.txt", data_base64: payload, mime: "text/plain" } });
ok("file_write stores + returns meta + files_version", !fw.isError && fw.structuredContent.version > 0 && fw.structuredContent.size > 0 && typeof fw.structuredContent.files_version === "number");
const frd = await client.callTool({ name: "file_read", arguments: { app: "smoke-notes", path: "note.txt" } });
ok("file_read returns bytes in structuredContent, NOT the text block", !frd.isError && frd.structuredContent.data_base64 === payload && !frd.content[0].text.includes(payload));
const fls = await client.callTool({ name: "file_list", arguments: { app: "smoke-notes" } });
ok("file_list shows the stored file", !fls.isError && fls.structuredContent.files.some((f) => f.path === "note.txt") && fls.structuredContent.usage.count >= 1);
// file_usage is retired (write-set C): the same totals ride every file_list page.
ok("usage rides file_list — one fact, one spelling (file_usage retired)",
  fls.structuredContent.usage.bytes > 0 && typeof fls.structuredContent.files_version === "number");
const fusGone = await client.callTool({ name: "file_usage", arguments: { app: "smoke-notes" } });
ok("file_usage's seat is gone", fusGone.isError === true && /not found/.test(fusGone.content[0].text));
const frdMissing = await client.callTool({ name: "file_read", arguments: { app: "smoke-notes", path: "ghost.txt" } });
ok("file_read of a missing file → clean error", frdMissing.isError === true && /No file/.test(frdMissing.content[0].text));
const fdel = await client.callTool({ name: "file_delete", arguments: { command_id: fcid(), app: "smoke-notes", path: "note.txt" } });
ok("file_delete removes it", !fdel.isError && fdel.structuredContent.deleted === true);
ok("file_read after delete → gone", (await client.callTool({ name: "file_read", arguments: { app: "smoke-notes", path: "note.txt" } })).isError === true);
const fileCaps = await client.callTool({ name: "app_html", arguments: { name: "smoke-notes" } });
ok("app_html caps carry the new file_read/file_write (local tier = both true)", fileCaps.structuredContent.caps.file_read === true && fileCaps.structuredContent.caps.file_write === true);

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
const manSave = await client.callTool({ name: "save_app", arguments: { name: "man-probe", html: withDecl(noteHtml, manManifest), description: "manifest probe" } });
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
const manBad = await client.callTool({ name: "save_app", arguments: { name: "man-probe", expected_version: await verOf("man-probe"), html: withDecl(noteHtml, { collections: { settings: { fields: { key: { type: "string" } } } } }) } });
ok("a declaration may not govern the settings collection", manBad.isError === true && /reserved "settings"/.test(manBad.content[0].text));
await client.callTool({ name: "save_app", arguments: { name: "man-probe", html: noteHtml, description: "resave with no declaration block", expected_version: await verOf("man-probe") } });
const vStill = await manAdd({ count: 3 });
ok("a document with NO block preserves the stored declaration (bad add still rejects)", vStill.isError === true && /schema_violation/.test(vStill.content[0].text));
await client.callTool({ name: "save_app", arguments: { name: "man-probe", html: withDecl(noteHtml, {}), expected_version: await verOf("man-probe") } });
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
const settingsBefore = bStore.getApp("settings").html;
const bEscape = await client.callTool({ name: "data_batch", arguments: { command_id: randomUUID(), commands: [
  { type: "save_app", name: "settings", html: "<p>overwritten</p>" },
] } });
ok("a non-item command is refused BY NAME instead of opening a second door to core()",
  bEscape.isError === true && /add_item, update_item, move_item, delete_item/.test(bEscape.content[0].text));
ok("...and the system app it aimed at is untouched", bStore.getApp("settings").html === settingsBefore);
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
  const withVia = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "wall-probe", fields: { t: 9 }, via: { app: "widget-x" } } });
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
bStore.execute({ type: "save_app", command_id: randomUUID(), name: "hidden-visual", visibility: "unlisted", actor: "human",
  html: `<p>tucked away</p><script type="application/json" id="oma-manifest">{"manifest_version":2,"kind":"visual"}<` + `/script>` });
const hidFound = await client.callTool({ name: "list_apps", arguments: { name: "hidden-visual" } });
ok("list_apps {name} finds an unlisted non-app instead of reporting it does not exist",
  !hidFound.isError && hidFound.structuredContent.total === 1 && hidFound.structuredContent.apps[0].name === "hidden-visual");
const hidScoped = await client.callTool({ name: "list_apps", arguments: { name: "hidden-visual", kind: "app" } });
ok("...while a filter the caller actually passed still applies", hidScoped.structuredContent.total === 0);

console.log("26c. data_query — the answer travels, the rows do not");
// Off by default: the seat is registered so no cached tool list is ever invalidated by its arrival,
// and calling it says so instead of failing obscurely.
const qOff = await client.callTool({ name: "data_query", arguments: { collection: "batch-probe" } });
ok("with the flag off the seat exists and explains itself", qOff.isError === true && /OMA_QUERY/.test(qOff.content[0].text));

console.log("27b. stewardship declarations — `fields` is optional; declaring a collection ≠ validating it");
const stewSave = await client.callTool({ name: "save_app", arguments: {
  name: "stew-probe", description: "stewardship only",
  html: withDecl(noteHtml, { collections: { "stew-data": {}, "stew-labelled": { label_field: "headline" } } }),
} });
ok("a fields-less declaration is accepted (pure stewardship)", !stewSave.isError && /Saved "stew-probe"/.test(stewSave.content[0].text));
const stewWrite = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "stew-data", fields: { anything: "goes", n: 7 } } });
ok("writing to a stewardship-only collection validates nothing and does not throw", !stewWrite.isError);
const labWrite = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "stew-labelled", fields: { headline: "hi" } } });
ok("label_field alone is a legal declaration", !labWrite.isError);
const strictNoFields = await client.callTool({ name: "save_app", arguments: { name: "stew-probe", expected_version: await verOf("stew-probe"), html: withDecl(noteHtml, { collections: { "stew-data": { strict: true } } }) } });
ok("strict without fields is rejected as a shape error (reads as a typo, never an intent)",
  strictNoFields.isError === true && /strict requires fields/.test(strictNoFields.content[0].text));
const badLabel = await client.callTool({ name: "save_app", arguments: { name: "stew-probe", expected_version: await verOf("stew-probe"), html: withDecl(noteHtml, { collections: { "stew-data": { label_field: "" } } }) } });
ok("label_field must be a non-empty string", badLabel.isError === true && /label_field/.test(badLabel.content[0].text));
// Two apps declaring the same collection: the contract is the UNION, and strict only holds
// if every declarer asked for it — a sibling tightening its own view must not reject our writes.
await client.callTool({ name: "save_app", arguments: { name: "union-a", html: withDecl(noteHtml, { collections: { "union-data": { fields: { a: { type: "string", required: true } } } } }) } });
await client.callTool({ name: "save_app", arguments: { name: "union-b", html: withDecl(noteHtml, { collections: { "union-data": { strict: true, fields: { b: { type: "number", required: true } } } } }) } });
const unionMissing = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "union-data", fields: { a: "x" } } });
ok("union of declarations: b (declared by the other app) is required too",
  unionMissing.isError === true && /schema_violation/.test(unionMissing.content[0].text));
ok("violation names EVERY declarer, not whichever row saved last",
  /union-a/.test(unionMissing.content[0].text) && /union-b/.test(unionMissing.content[0].text));
const unionBoth = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "union-data", fields: { a: "x", b: 1, extra: "kept" } } });
ok("strict is a conjunction: one declarer's strict does not reject the other's undeclared keys", !unionBoth.isError);

console.log("27d. discovery face — the default answers \"open my X\" in one call, and a filtered list says so");
const lcName = await client.callTool({ name: "list_apps", arguments: { name: "man-probe" } });
ok("name is an exact lookup: one row, and the count agrees",
  lcName.structuredContent.total === 1 && lcName.structuredContent.apps[0].name === "man-probe");
const lcMiss = await client.callTool({ name: "list_apps", arguments: { name: "no-such-app" } });
ok("a miss says how to widen instead of looking like an empty registry",
  lcMiss.structuredContent.total === 0 && /No app named/.test(lcMiss.content[0].text));
const lcDefault = await client.callTool({ name: "list_apps", arguments: {} });
const lcAny = await client.callTool({ name: "list_apps", arguments: { kind: "any", visibility: "any" } });
ok("default scope is kind=app + featured/listed (the openable apps)",
  lcDefault.structuredContent.apps.every((c) => c.kind === "app" && ["featured", "listed"].includes(c.visibility)));
ok("kind/visibility any widens to the whole registry", lcAny.structuredContent.total >= lcDefault.structuredContent.total);
const lcCap = await client.callTool({ name: "list_apps", arguments: { limit: 2 } });
ok("limit caps the rows but the reply reports the true match count",
  lcCap.structuredContent.apps.length === 2 && lcCap.structuredContent.total > 2 &&
  new RegExp(`${lcCap.structuredContent.total} match, showing 2`).test(lcCap.content[0].text));
ok("the store's own listApps() is unfiltered — the registry's consumers see everything",
  lcAny.structuredContent.total === lcAny.structuredContent.shown);

console.log("27e. guide chapters — each stands alone; the frozen enum admits what is not built yet");
const gBasics = (await client.callTool({ name: "get_app_guide", arguments: {} })).content[0].text;
const gStyle = (await client.callTool({ name: "get_app_guide", arguments: { topic: "style" } })).content[0].text;
const gFns = (await client.callTool({ name: "get_app_guide", arguments: { topic: "functions" } })).content[0].text;
ok("default chapter carries the API contract AND a working template", /window\.oma API/.test(gBasics) && /Minimal working app/.test(gBasics));
// Cap raised 15,500 → 19,500 (2026-07-27 slimming batch), then → 22,000 (2026-07-27 L0 batch).
// Basics grew by the things a measurement said an author never does unless told: the kit class
// table (CSS was 32-47% of every hand-written app, k- usage 0/4), the
// data-goes-in-the-collection rule (hardcoded 4/4 when unsaid, 0/9 when said), the
// skeleton-then-edit_app workflow, and now the two L0 findings — the empty-app failure
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
// 25,400 (was 25,000): sendMessage's documented semantics were WRONG — the guide said it "sends
// text into the chat AS THE USER", and ChatGPT declines to act on it precisely because an app
// cannot speak with the user's authority (measured 2026-07-28, and the vendor confirms the
// boundary is deliberate). Correcting a false statement about a shipped API is not the kind of
// addition this cap exists to ration; the L0 probation rule is about new guidance competing for
// the author's attention. The correction was still squeezed to ~115 B over by collapsing the
// duplicate "only on an explicit click" rule, and the tool-surface cap it sits next to was NOT
// raised in the same batch — that one was avoidable and got shrunk instead.
ok("default chapter is smaller than the whole guide (the author pays for what they ask for)", gBasics.length < 25400,
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

console.log("27f. open_app binding — the declaration finally participates");
{
  const barrel = await import("../index.mjs");
  const decl = (colls) => `<script type="application/json" id="oma-manifest">\n${JSON.stringify({ manifest_version: 2, collections: colls })}\n</script>`;
  const body = "<h1>t</h1><script type=\"module\">oma.ready(() => {});</scr" + "ipt>";
  const save = (name, colls) => client.callTool({ name: "save_app", arguments: { name, html: `<!DOCTYPE html><html><head>${decl(colls)}</head><body>${body}</body></html>` } });
  const openedOn = async (name, args = {}) => {
    const r = await client.callTool({ name: "open_app", arguments: { app: name, ...args } });
    return r.structuredContent.collection;
  };
  await save("bind-one", { trips: { label_field: "title" } });
  ok("an app declaring exactly ONE collection binds to it — this is the 8-of-9 blank-open bug",
    await openedOn("bind-one") === "trips");
  ok("an explicit collection still wins over the declaration",
    await openedOn("bind-one", { collection: "elsewhere" }) === "elsewhere");
  await save("bind-two", { trips: {}, legs: {} });
  ok("two declared collections ⇒ no single answer, so the app NAME stays the default",
    await openedOn("bind-two") === "bind-two");
  const plain = await client.callTool({ name: "save_app", arguments: { name: "bind-none", html: `<!DOCTYPE html><html><body>${body}</body></html>` } });
  ok("no declaration at all ⇒ unchanged behaviour", !plain.isError && await openedOn("bind-none") === "bind-none");

  // ONE TRUTH, THREE DOORS. The loader now paints from app_html's `collection`, so that
  // answer has to be the SAME answer open_app gives and the same one the per-app resource
  // bakes into its document. Three copies of "what does this app open on" is how a widget ends up
  // reading one collection while its writes land in another; asserting they agree is what keeps
  // the rule in contracts.mjs from being advisory.
  const htmlOf = async (n) => (await client.callTool({ name: "app_html", arguments: { name: n } })).structuredContent;
  for (const [name, expected] of [["bind-one", "trips"], ["bind-two", "bind-two"], ["bind-none", "bind-none"]]) {
    const sc = await htmlOf(name);
    ok(`app_html tells the loader "${name}" opens on "${expected}" — the binding travels with the html`,
      sc.collection === expected, `got ${sc.collection}`);
    ok(`…the same string open_app answers with (one truth, not two)`,
      sc.collection === await openedOn(name));
    const baked = (await client.readResource({ uri: `ui://open-mcp-apps/${name}.html` })).contents[0].text;
    ok(`…and the same one baked into the per-app document`,
      new RegExp(`__OMA_COLLECTION_HINT__\\s*=\\s*"${expected}"`).test(baked)
      || baked.includes(`__OMA_COLLECTION_HINT__=${JSON.stringify(expected)}`),
      baked.slice(baked.indexOf("__OMA_COLLECTION_HINT__"), baked.indexOf("__OMA_COLLECTION_HINT__") + 90));
  }

  // The binding is derived from a APP-AUTHORED manifest, so it is only trustworthy for a
  // app we trust. For an unreviewed one it would let the app pick what it is bound to —
  // and the bound collection is exactly what the runner grants full typed read/write on regardless
  // of cross_collection_read/write. Declaring another app's collection would then hand it those rows.
  ok("an UNREVIEWED app's manifest cannot choose its binding — it gets its own name",
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
const emptyHtml = await client.callTool({ name: "save_app", arguments: { name: "faceless", html: "   \n\t " } });
ok("whitespace-only html → empty_html, and the note says why apps need a face",
  emptyHtml.isError === true && /empty_html/.test(emptyHtml.content[0].text) && /person opens/.test(emptyHtml.content[0].text));
const tinySave = await client.callTool({ name: "save_app", arguments: { name: "tiny-but-real", html: "<p>hi</p>" } });
ok("a 9-char app saves (small is reversible; the old 50-char floor was not the defence)", !tinySave.isError);
ok("save ack reports the size unconditionally", /9 chars/.test(tinySave.content[0].text));
const grown = await client.callTool({ name: "save_app", arguments: { name: "tiny-but-real", html: noteHtml, expected_version: await verOf("tiny-but-real") } });
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
await client.callTool({ name: "delete_app", arguments: { name: "habit-streaks", command_id: randomUUID() } });
const gInst = await client.callTool({ name: "install_from_library", arguments: { name: "habit-streaks" } });
// OSS decision (Leo 2026-07-24): library content is FIRST-PARTY → author "library" is a
// provenance stamp mapping to tier LOCAL (direct render), same standing as the user's own
// apps. The runner + review flow stay dormant until the SaaS publishing pipeline.
ok("after delete, install succeeds at tier local (history continued, version rolls forward)",
  !gInst.isError && gInst.structuredContent.tier === "local" && gInst.structuredContent.version > 0);
const gHtml = (await client.callTool({ name: "app_html", arguments: { name: "habit-streaks" } })).structuredContent;
ok("app_html: author library → tier local (first-party)", gHtml.author === "library" && gHtml.tier === "local");
ok("local caps: full-trust preset (file_read+file_write+send_message all true)", gHtml.caps.file_read === true && gHtml.caps.file_write === true && gHtml.caps.send_message === true);
const gRes = await client.readResource({ uri: "ui://open-mcp-apps/habit-streaks.html" });
ok("direct-mode ui:// resource serves the wrapped app (NOT a runner placeholder)", gRes.contents[0].text.includes("window.oma") && !gRes.contents[0].text.includes("Sandboxed runner required"));
const gAfter = (await client.callTool({ name: "library_list", arguments: {} })).structuredContent.entries.find((e) => e.name === "habit-streaks");
ok("library_list now shows installed + from_library + no update pending", gAfter?.installed === true && gAfter?.from_library === true && gAfter?.update_available === false);
const gAgain = await client.callTool({ name: "install_from_library", arguments: { name: "habit-streaks" } });
ok("re-install is a friendly no-op (already up to date, not an error)", !gAgain.isError && /already installed and up to date/.test(gAgain.content[0].text) && gAgain.structuredContent.updated === false);

console.log("29. chunked file write — begin/chunk/commit lifecycle over MCP");
const b64 = (s) => Buffer.from(s).toString("base64");
const cBeg = await client.callTool({ name: "file_write_begin", arguments: { app: "smoke-notes" } });
ok("begin → upload_id + limits", !cBeg.isError && typeof cBeg.structuredContent.upload_id === "string" &&
  cBeg.structuredContent.chunk_limit_bytes > 0 && cBeg.structuredContent.file_limit_bytes >= cBeg.structuredContent.chunk_limit_bytes);
const upId = cBeg.structuredContent.upload_id;
const ck1 = await client.callTool({ name: "file_write_chunk", arguments: { upload_id: upId, data_base64: b64("hello ") } });
ok("chunk 1 staged (6 bytes)", !ck1.isError && ck1.structuredContent.bytes === 6);
const ck2 = await client.callTool({ name: "file_write_chunk", arguments: { upload_id: upId, data_base64: b64("world") } });
ok("chunk 2 staged (11 bytes total)", !ck2.isError && ck2.structuredContent.bytes === 11);
const cCommit = await client.callTool({ name: "file_write_commit", arguments: { upload_id: upId, path: "big.bin" } });
ok("commit lands big.bin (size 11, file_write result shape)", !cCommit.isError && cCommit.structuredContent.size === 11 &&
  cCommit.structuredContent.version > 0 && cCommit.structuredContent.app === "smoke-notes" && typeof cCommit.structuredContent.files_version === "number");
const cRead = await client.callTool({ name: "file_read", arguments: { app: "smoke-notes", path: "big.bin" } });
ok("file_read returns the assembled bytes + matching sha", !cRead.isError && cRead.structuredContent.data_base64 === b64("hello world") && cRead.structuredContent.sha256 === cCommit.structuredContent.sha256);
const ckLate = await client.callTool({ name: "file_write_chunk", arguments: { upload_id: upId, data_base64: b64("more") } });
ok("chunk after commit → upload gone", ckLate.isError === true && /No such upload/.test(ckLate.content[0].text));
const cBeg2 = await client.callTool({ name: "file_write_begin", arguments: { app: "smoke-notes" } });
const upId2 = cBeg2.structuredContent.upload_id;
await client.callTool({ name: "file_write_chunk", arguments: { upload_id: upId2, data_base64: b64("doomed") } });
const cAb = await client.callTool({ name: "file_write_abort", arguments: { upload_id: upId2 } });
ok("abort discards the upload", !cAb.isError && cAb.structuredContent.aborted === true);
const cAbCommit = await client.callTool({ name: "file_write_commit", arguments: { upload_id: upId2, path: "never.bin" } });
ok("commit after abort → clean error", cAbCommit.isError === true && /No such upload/.test(cAbCommit.content[0].text));
const cBeg3 = await client.callTool({ name: "file_write_begin", arguments: { app: "smoke-notes" } });
const cEmpty = await client.callTool({ name: "file_write_chunk", arguments: { upload_id: cBeg3.structuredContent.upload_id, data_base64: "" } });
ok("empty chunk rejected", cEmpty.isError === true && /Empty chunk/.test(cEmpty.content[0].text));
await client.callTool({ name: "file_write_abort", arguments: { upload_id: cBeg3.structuredContent.upload_id } });

console.log("30. render_health — auto-revert on a failed mount; stale/healthy/locked/non-local/budget guards");
const rhA = noteHtml.replace('id="l"', 'id="l" data-rh="A-marker"');
const rhB = noteHtml.replace('id="l"', 'id="l" data-rh="B-marker"');
// A widget reports the VERSION it actually mounted (its __OMA_APP_VERSION__), which is a
// ledger position — render_health is machinery, not a surface a person reads, so it keeps that
// vocabulary. app_history stopped handing the seq out, so both numbers are read from the
// registry at the moment each save lands.
await client.callTool({ name: "save_app", arguments: { name: "rh-probe", html: rhA, description: "render-health probe" } });
const rhV1 = await verOf("rh-probe");
await client.callTool({ name: "save_app", arguments: { name: "rh-probe", html: rhB, description: "", expected_version: rhV1 } });
const rhV2 = await verOf("rh-probe");
const rh1 = await client.callTool({ name: "render_health", arguments: { app: "rh-probe", version: rhV2, ok: false, error: "boom" } });
ok("failure on the current version → reverted to the previous one, rolled forward as a new version",
  !rh1.isError && rh1.structuredContent.reverted === true && rh1.structuredContent.restored_version === rhV1 && rh1.structuredContent.new_version > rhV2);
const rhCur = await client.callTool({ name: "get_app", arguments: { name: "rh-probe" } });
ok("current source is the restored html again (marker A, served as the new version)",
  rhCur.content[0].text.includes(`rh-probe v${rh1.structuredContent.new_version}`) && rhCur.content[0].text.includes("A-marker") && !rhCur.content[0].text.includes("B-marker"));
const rhStale = await client.callTool({ name: "render_health", arguments: { app: "rh-probe", version: rhV2, ok: false, error: "boom again" } });
ok("stale report (an older version while a newer one is current) → ignored", rhStale.structuredContent.reverted === false && /Stale report/.test(rhStale.structuredContent.note));
const rhOk = await client.callTool({ name: "render_health", arguments: { app: "rh-probe", version: 3, ok: true } });
ok("healthy report never reverts", rhOk.structuredContent.reverted === false);
const settingsVer = (await client.callTool({ name: "app_html", arguments: { name: "settings" } })).structuredContent.version;
const rhLock = await client.callTool({ name: "render_health", arguments: { app: "settings", version: settingsVer, ok: false, error: "boom" } });
ok("locked system app is never auto-reverted", rhLock.structuredContent.reverted === false && /Locked/.test(rhLock.structuredContent.note));
// library-fixture (§17b, author "library-test") is the surviving non-local app now that
// library installs are first-party/local.
const rhNlVer = (await client.callTool({ name: "app_html", arguments: { name: "library-fixture" } })).structuredContent.version;
const rhNl = await client.callTool({ name: "render_health", arguments: { app: "library-fixture", version: rhNlVer, ok: false, error: "boom" } });
ok("non-local app is never auto-reverted", rhNl.structuredContent.reverted === false && /Non-local/.test(rhNl.structuredContent.note));
// Budget is a HARD 3-per-server-run ceiling: healthy (ok:true) reports do NOT reset it — the
// review round proved a resettable budget is hollow (interleaved ok:true reports allowed 8
// forced reverts). rh1 above consumed 1 of 3, so of the next three break+report cycles only
// TWO revert; the third is refused at the cap.
let budgetReverts = 0;
for (let i = 0; i < 3; i++) {
  await client.callTool({ name: "save_app", arguments: { name: "rh-probe", html: noteHtml.replace('id="l"', `id="l" data-rh="broken-${i}"`), description: "", expected_version: await verOf("rh-probe") } });
  const v = (await client.callTool({ name: "app_html", arguments: { name: "rh-probe" } })).structuredContent.version;
  const rep = await client.callTool({ name: "render_health", arguments: { app: "rh-probe", version: v, ok: false, error: "boom " + i } });
  if (rep.structuredContent.reverted === true) budgetReverts++;
}
ok("hard budget: only two more reverts fit (3 total per run; ok:true does NOT reset)", budgetReverts === 2);
await client.callTool({ name: "save_app", arguments: { name: "rh-probe", html: noteHtml.replace('id="l"', 'id="l" data-rh="broken-final"'), description: "", expected_version: await verOf("rh-probe") } });
const vFinal = (await client.callTool({ name: "app_html", arguments: { name: "rh-probe" } })).structuredContent.version;
const rhLimit = await client.callTool({ name: "render_health", arguments: { app: "rh-probe", version: vFinal, ok: false, error: "boom final" } });
ok("the next failure hits the 3-per-run budget → refused with a limit note", rhLimit.structuredContent.reverted === false && /Auto-revert limit reached/.test(rhLimit.structuredContent.note));

console.log("31. ui_prefs_schema + app_permissions — the settings pane's data sources");
const prefsShared = (await client.callTool({ name: "ui_prefs_schema", arguments: {} })).structuredContent.shared;
ok("shared catalog has ≥8 entries", Array.isArray(prefsShared) && prefsShared.length >= 8);
const wpsPref = prefsShared.find((p) => p.key === "widget_poll_seconds");
ok("widget_poll_seconds is a number pref", wpsPref?.type === "number");
const proPref = prefsShared.find((p) => p.key === "proactivity");
ok("proactivity is an enum with 2 options", proPref?.type === "enum" && Array.isArray(proPref.options) && proPref.options.length === 2);
const perms = (await client.callTool({ name: "app_permissions", arguments: {} })).structuredContent.apps;
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
  // 🔴 REWRITTEN 2026-07-29. This asserted `other.events.every(e => e.type !== undefined)` plus a
  // disjointness check against `other.events[0]?.id` — and BOTH halves are vacuously true on an
  // empty array: `every` passes, and `events[0]?.id` is undefined so nothing can equal it. A
  // data_changes that returned NOTHING for kanban passed a test named "scoped to one collection".
  // It asserted "nothing wrong came back", never "the right thing came back" — the bug's shape
  // written down as the specification.
  //
  // The property is two-sided, so both sides are now asserted: this collection's own rows are
  // PRESENT, and the other collection's rows are ABSENT. Verified to fail by hand in both
  // directions (scope ignored ⇒ foreign ids appear; scope over-applied ⇒ own rows vanish).
  const otherEvents = other.structuredContent.events;
  const kanbanIds = new Set(otherEvents.map((e) => e.id));
  const replayIds = new Set(replay.structuredContent.events.map((e) => e.id));
  ok("scoped to one collection — kanban's OWN rows come back",
    otherEvents.length > 0 && otherEvents.every((e) => e.type),
    `${otherEvents.length} event(s): ${JSON.stringify(otherEvents.map((e) => e.type))}`);
  ok("…and NONE of the other collection's rows leak into it (disjoint, both ways)",
    [...kanbanIds].every((id) => !replayIds.has(id)) && [...replayIds].every((id) => !kanbanIds.has(id)),
    `kanban=${[...kanbanIds]} other=${[...replayIds]}`);
}

console.log("34. write-set C — windows, the edit loop, archive, and the seats");
{
  // An app bigger than one window, so the walk is real.
  const bigBody = `<!DOCTYPE html><html><body><div id="pad">${"lorem-ipsum-".repeat(4000)}</div><ul id="l"></ul>
<script type="module">oma.ready(() => {});</script></body></html>`;
  await client.callTool({ name: "save_app", arguments: { name: "win-probe", html: bigBody, description: "window probe" } });
  const w1 = (await client.callTool({ name: "get_app", arguments: { name: "win-probe" } })).structuredContent;
  ok("a big source comes back as a WINDOW, not whole",
    w1.text.length < bigBody.length && w1.total === bigBody.length && typeof w1.next_offset === "number");
  ok("…bounded by the result budget", JSON.stringify(w1).length <= 36_000);
  let assembled = w1.text, wOff = w1.next_offset;
  while (wOff != null) {
    const wn = (await client.callTool({ name: "get_app", arguments: { name: "win-probe", offset: wOff } })).structuredContent;
    assembled += wn.text; wOff = wn.next_offset;
  }
  ok("the window walk reassembles the EXACT source", assembled === bigBody);

  const noVer = await client.callTool({ name: "save_app", arguments: { name: "win-probe", html: bigBody } });
  ok("overwrite without expected_version is refused BY NAME, carrying the current version",
    noVer.isError === true && noVer.structuredContent?.reason === "expected_version_required" &&
    noVer.structuredContent?.version === w1.version);
  const staleSave = await client.callTool({ name: "save_app", arguments: { name: "win-probe", html: bigBody, expected_version: 1 } });
  ok("a stale expected_version is a conflict carrying the CURRENT version",
    staleSave.isError === true && staleSave.structuredContent?.reason === "version_conflict" &&
    staleSave.structuredContent?.expected_version === w1.version);

  const e1 = await client.callTool({ name: "edit_app", arguments: { command_id: randomUUID(), app: "win-probe",
    expected_version: w1.version, edits: [{ old_string: 'id="l"', new_string: 'id="l" data-edited="1"' }] } });
  ok("an edit lands without round-tripping the source",
    !e1.isError && e1.structuredContent.ok === true && e1.structuredContent.applied === 1 && e1.structuredContent.version > w1.version);
  const spot = (await client.callTool({ name: "get_app", arguments: { name: "win-probe", offset: bigBody.indexOf('id="l"'), length: 60 } })).structuredContent;
  ok("…and really changed the source at that spot", spot.text.includes('data-edited="1"'));
  const eMiss = await client.callTool({ name: "edit_app", arguments: { command_id: randomUUID(), app: "win-probe",
    expected_version: e1.structuredContent.version, edits: [{ old_string: "NOT-IN-THE-DOCUMENT", new_string: "x" }] } });
  ok("a 0-match edit refuses and applies NOTHING", eMiss.isError === true && /0 matches/.test(eMiss.content[0].text));
  const eMulti = await client.callTool({ name: "edit_app", arguments: { command_id: randomUUID(), app: "win-probe",
    expected_version: e1.structuredContent.version, edits: [{ old_string: "lorem-ipsum-", new_string: "x" }] } });
  ok("an ambiguous edit names the count and demands anchoring or replace_all",
    eMulti.isError === true && /matches \d+ times/.test(eMulti.content[0].text));
  const eStale = await client.callTool({ name: "edit_app", arguments: { command_id: randomUUID(), app: "win-probe",
    expected_version: w1.version, edits: [{ old_string: 'data-edited="1"', new_string: "" }] } });
  ok("an edit against a stale version is a conflict — NOTHING was applied", eStale.isError === true && /re-read/.test(eStale.content[0].text));

  const arch = await client.callTool({ name: "archive_app", arguments: { command_id: randomUUID(), app: "win-probe", archived: true } });
  ok("archive flips visibility and stamps the one axis",
    !arch.isError && arch.structuredContent.visibility === "archived" && typeof arch.structuredContent.version === "number");
  const shelf = (await client.callTool({ name: "list_apps", arguments: {} })).structuredContent;
  ok("an archived app leaves the default shelf", !shelf.apps.some((c) => c.name === "win-probe"));
  const archShelf = (await client.callTool({ name: "list_apps", arguments: { visibility: "archived", kind: "any" } })).structuredContent;
  ok("…and shows under visibility: archived", archShelf.apps.some((c) => c.name === "win-probe"));
  const unarch = await client.callTool({ name: "archive_app", arguments: { command_id: randomUUID(), app: "win-probe", archived: false } });
  ok("unarchive brings it back", !unarch.isError && unarch.structuredContent.visibility === "listed");
  const lockArch = await client.callTool({ name: "archive_app", arguments: { command_id: randomUUID(), app: "settings", archived: true } });
  ok("a system app cannot be shelved", lockArch.isError === true);

  const cfTools = await client.listTools();
  ok("call_function has NO seat until the function pillar ships (pulled 2026-07-27)",
    !cfTools.tools.some((t) => t.name === "call_function"));

  const chWhole = (await client.callTool({ name: "app_html", arguments: { name: "win-probe" } })).structuredContent;
  ok("app_html zero-param carries the WHOLE document (the widget cannot assemble windows)",
    chWhole.html.length === e1.structuredContent.size);
  const chWin = (await client.callTool({ name: "app_html", arguments: { name: "win-probe", offset: 0, length: 1000 } })).structuredContent;
  ok("…and windows only when asked", chWin.html.length === 1000 && typeof chWin.next_offset === "number");

  const fbytes = Buffer.from("0123456789".repeat(400));
  await client.callTool({ name: "file_write", arguments: { command_id: randomUUID(), app: "win-probe", path: "win.bin", data_base64: fbytes.toString("base64") } });
  const fw1 = (await client.callTool({ name: "file_read", arguments: { app: "win-probe", path: "win.bin", length: 1500 } })).structuredContent;
  ok("file_read windows by BYTES and says where to continue", fw1.returned === 1500 && fw1.next_offset === 1500 && fw1.total === 4000);
  const fw2 = (await client.callTool({ name: "file_read", arguments: { app: "win-probe", path: "win.bin", offset: 1500 } })).structuredContent;
  const joined = Buffer.concat([Buffer.from(fw1.data_base64, "base64"), Buffer.from(fw2.data_base64, "base64")]);
  ok("decoded windows reassemble the exact bytes", fw2.next_offset === null && joined.equals(fbytes));
  for (const p of ["a.txt", "b.txt", "c.txt"])
    await client.callTool({ name: "file_write", arguments: { command_id: randomUUID(), app: "win-probe", path: p, data_base64: Buffer.from(p).toString("base64") } });
  const fl1 = (await client.callTool({ name: "file_list", arguments: { app: "win-probe", limit: 2 } })).structuredContent;
  ok("file_list pages with an explicit end", fl1.files.length === 2 && fl1.total === 4 && typeof fl1.next_cursor === "string");
  const fl2 = (await client.callTool({ name: "file_list", arguments: { app: "win-probe", limit: 2, cursor: fl1.next_cursor } })).structuredContent;
  ok("…second page completes the walk", fl2.files.length === 2 && fl2.next_cursor === null);

  console.log("34b. C-review residue pins");
  // A lost-reply retry of a CREATE must return the receipt, not die on the overwrite guard.
  const cRid = randomUUID();
  const c1 = await client.callTool({ name: "save_app", arguments: { command_id: cRid, name: "retry-probe", html: noteHtml, description: "retry probe" } });
  const c2 = await client.callTool({ name: "save_app", arguments: { command_id: cRid, name: "retry-probe", html: noteHtml, description: "retry probe" } });
  ok("a created app's lost-reply retry returns the original receipt",
    !c2.isError && c2.structuredContent.version === c1.structuredContent.version && /Already saved/.test(c2.content[0].text));
  const eRid = randomUUID();
  const ed1 = await client.callTool({ name: "edit_app", arguments: { command_id: eRid, app: "retry-probe",
    expected_version: c1.structuredContent.version, edits: [{ old_string: 'id="l"', new_string: 'id="lx"' }] } });
  const ed2 = await client.callTool({ name: "edit_app", arguments: { command_id: eRid, app: "retry-probe",
    expected_version: c1.structuredContent.version, edits: [{ old_string: 'id="l"', new_string: 'id="lx"' }] } });
  ok("an edit's lost-reply retry replays — even though the original edit consumed its own old_string",
    !ed2.isError && ed2.structuredContent.version === ed1.structuredContent.version && /Already applied/.test(ed2.content[0].text));
  await client.callTool({ name: "delete_app", arguments: { name: "retry-probe", command_id: randomUUID() } });
  const res = await client.callTool({ name: "save_app", arguments: { name: "retry-probe", html: noteHtml, expected_version: ed1.structuredContent.version } });
  ok("saving over a DELETED app with a version token is a conflict, never a silent resurrection",
    res.isError === true && /DELETED after you read/.test(res.content[0].text) &&
    (await client.callTool({ name: "list_apps", arguments: { name: "retry-probe" } })).structuredContent.total === 0);
  const longGrp = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "batch-probe", group: "g".repeat(600), fields: { t: 1 } } });
  ok("an essay-sized group is refused by name (the one uncapped hole in a row's size)",
    longGrp.isError === true && /group_too_long/.test(longGrp.content[0].text));
  const vPage = (await client.callTool({ name: "data_list", arguments: { collection: "batch-probe", limit: 1 } })).structuredContent;
  ok("a page carries the version trio stamped in its own transaction, and the runtime's host",
    typeof vPage.version === "number" && typeof vPage.settings_version === "number" && typeof vPage.host === "string");
  const winText = (await client.callTool({ name: "get_app", arguments: { name: "win-probe" } })).content[0].text;
  ok("a continuing window never says 'no more'", /continue at offset/.test(winText) && !/no more/.test(winText));
  const ahead = (await client.callTool({ name: "data_changes", arguments: { collection: "batch-probe", since: 9999999 } })).structuredContent;
  ok("a mark ahead of the ledger is re-anchored loudly, not silently pinned",
    ahead.events.length === 0 && ahead.next_since === ahead.latest_seq && /ahead of this ledger/.test(ahead.note));
  const aRid = randomUUID();
  await client.callTool({ name: "archive_app", arguments: { command_id: aRid, app: "hidden-visual", archived: true } });
  await client.callTool({ name: "archive_app", arguments: { command_id: randomUUID(), app: "hidden-visual", archived: false } });
  const aReplay = await client.callTool({ name: "archive_app", arguments: { command_id: aRid, app: "hidden-visual", archived: true } });
  ok("an archive replayed after an unarchive reports the ORIGINAL flip, not current state",
    !aReplay.isError && aReplay.structuredContent.visibility === "archived" && /idempotent replay/.test(aReplay.content[0].text));
  const badFc = await client.callTool({ name: "file_list", arguments: { app: "win-probe", cursor: "@@bad@@" } });
  ok("file_list refuses a corrupted cursor exactly like data_list", badFc.isError === true && /Invalid cursor/.test(badFc.content[0].text));
  // Auto-revert must restore the previous DIFFERENT document — version flips (archive) write no html.
  await client.callTool({ name: "save_app", arguments: { name: "rv-probe", html: noteHtml, description: "rv" } });
  await client.callTool({ name: "save_app", arguments: { name: "rv-probe", html: histHtml2, description: "", expected_version: await verOf("rv-probe") } });
  await client.callTool({ name: "archive_app", arguments: { command_id: randomUUID(), app: "rv-probe", archived: true } });
  const rvCur = await verOf("rv-probe");
  const rh = await client.callTool({ name: "render_health", arguments: { app: "rv-probe", version: rvCur, ok: false, error: "boom" } });
  const rvNow = (await client.callTool({ name: "get_app", arguments: { name: "rv-probe" } })).structuredContent;
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
  const vw = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "via-e2e", fields: { t: 1 }, actor: "human", via: { app: "some-widget" } } });
  ok("a via-stamped write acks normally over MCP", vw.structuredContent.ok === true);
  const vch = await client.callTool({ name: "data_changes", arguments: { collection: "via-e2e", since: 0 } });
  ok("data_changes strips via from the event", vch.structuredContent.events.length === 1 && !("via" in vch.structuredContent.events[0]));
  const vlist = await client.callTool({ name: "data_list", arguments: { collection: "via-e2e" } });
  ok("data_list rows carry no via either (items never grew a shadow column)",
    vlist.structuredContent.items.every((i) => !("via" in i)) && !vch.content[0].text.includes("some-widget"));
  const junk = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "via-e2e", fields: { t: 2 }, garbage_key: { nested: true } } });
  ok("unknown keys pass the schema and die in store.core() — the write still lands clean", junk.structuredContent.ok === true);
  // Passthrough must NOT let a caller pick the dispatch `type`: data_add_item carrying
  // type:"save_app" would be a data-plane → control-plane escape (adversarial D review).
  await client.callTool({ name: "save_app", arguments: { command_id: randomUUID(), name: "victim-probe", html: "<p>ORIGINAL</p>" } });
  const escape = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "via-e2e", fields: { t: 3 }, type: "save_app", name: "victim-probe", html: "<p>PWNED</p>" } });
  const victim = (await client.callTool({ name: "get_app", arguments: { name: "victim-probe" } })).structuredContent;
  ok("a caller-supplied `type` cannot hijack the command — the item write stays an item write",
    escape.structuredContent.ok === true && victim.text.includes("ORIGINAL") && !victim.text.includes("PWNED"));
}

await client.close();

console.log("32. package barrel + embed hooks (the library-consumer surface)");
const barrel = await import("../index.mjs");
ok("barrel exposes the embed surface", typeof barrel.openStore === "function" && typeof barrel.createEngine === "function" &&
  typeof barrel.wrapApp === "function" && typeof barrel.wrapLoader === "function" &&
  typeof barrel.tierOf === "function" && typeof barrel.openFileChannel === "function" &&
  typeof barrel.seedSystemApps === "function" && typeof barrel.GUIDE === "string");
// brandCss was removed (dead API + a </style>-breakout XSS vector): an app-supplied brand
// layer must NEVER be injectable into a served widget. Passing it is now inert.
const plain32 = barrel.wrapApp("<div>x</div>", {});
const branded32 = barrel.wrapApp("<div>x</div>", { brandCss: "</style><script>1</script>" });
ok("brandCss removed: no brand style block, and a passed value can't inject markup",
  !plain32.includes('data-oma="brand"') && !branded32.includes('data-oma="brand"') &&
  !branded32.includes("<script>1</script>"));
ok("wrapLoader emits no brand layer", !barrel.wrapLoader().includes('data-oma="brand"'));
// tokens: the SUPPORTED way for an embedder to supply the host token layer brandCss was reaching
// for. A map, validated on both halves — the breakout brandCss allowed must be impossible here,
// and an invalid name or value is a hard error rather than a silently dropped declaration.
const toked32 = barrel.wrapApp("<div>x</div>", {
  tokens: { "--color-text-info": "#326E64", "--color-ring-primary": "light-dark(#326E64, #58b0a0)" },
});
ok("tokens: emitted as one :root block AFTER the neutral fallbacks (so the embedder wins)",
  toked32.includes('<style data-oma="host-tokens">:root{--color-text-info:#326E64;--color-ring-primary:light-dark(#326E64, #58b0a0)}</style>') &&
  toked32.indexOf('data-oma="tokens"') < toked32.indexOf('data-oma="host-tokens"'));
ok("tokens: absent/empty emits nothing", !plain32.includes("host-tokens") &&
  !barrel.wrapApp("<div>x</div>", { tokens: {} }).includes("host-tokens"));
const tokenThrows = (tokens) => {
  try { barrel.wrapApp("<div>x</div>", { tokens }); return false; } catch { return true; }
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
const lc33 = await c33.callTool({ name: "list_apps", arguments: {} });
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
  ok("the theme layer is re-applied at ready-flush, once app identity is settled",
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
  const comps = readFileSync(join(ROOT, "src", "tools", "apps.mjs"), "utf-8");
  ok("the opt-in per-app open_<name> tools use the SAME binding rule as open_app",
    (comps.match(/defaultCollectionFor\(/g) || []).length >= 2);
  // viewBase reaches the runtime only when an operator set one — passing it always would turn every
  // in-app link absolute (127.0.0.1) and break the ordinary localhost:PORT visit.
  ok("the viewer passes viewBase to apps only when OMA_VIEW_BASE is set",
    /process\.env\.OMA_VIEW_BASE \? \{ viewBase:/.test(httpSrc));
}
await c32.close();
store32.close();

for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
