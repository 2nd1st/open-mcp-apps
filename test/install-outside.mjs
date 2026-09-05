// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/install-outside.mjs — an app BUILT OUTSIDE the chat: pushed as a template + a bundle,
// served as one document, read-only to the AI.
//
// The claim under test is a chain, and every link of it fails silently on its own:
//
//   · a template is stored VERBATIM (get_app must not show the model a bundle it cannot edit),
//   · every serve-time seam inlines the bundle (a seam that forgot serves a document whose script
//     tag points at `oma-asset:app.js` — a URL no browser resolves, no CSP allows, and no error
//     message mentions: a blank widget),
//   · a MISSING asset is loud (same blank widget, different cause, and the author has nothing to
//     go on either way),
//   · the model cannot write over it (an edit_app that "succeeded" would desynchronise the
//     template from the build that made it, and render perfectly while doing so).
//
// §2 walks all three serve-time seams by NAME, because "we wired the one we were looking at" is
// exactly how the second and third get missed: the per-app ui:// resource, get_app_html (what the
// universal loader mounts, and what every sandboxed tier reaches through the runner), and
// GET /view (the browser viewer).
//
// Run: node test/install-outside.mjs
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { openStore, HUMAN_HISTORY_KEEP_DAYS } from "../src/store.mjs";
import { openFileChannel } from "../src/files.mjs";
import Database from "better-sqlite3";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, "test", "tmp-install-outside");
const DB = join(TMP, "store.db");
const PORT = Number(process.env.OMA_TEST_PORT_OUTSIDE) || 18947;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

// ── the fixture: what a build pipeline emits ────────────────────────────────────────────────
// A mount point, two asset references, and a function body that had to survive the bundler (the
// store's functionsJoinError refuses the pair unless the declared function has its block IN THE
// DOCUMENT — which is precisely why RUNTIME.md §6.1 tells a build to emit these, not bundle them).
const S = "script";
const CLOSE = "</" + S + ">";
//
// The script reference is written the way a BUNDLER writes it — `type="module"`, in <head>,
// before the mount point — because that is the shape the door actually receives and the one that
// used to arrive broken (see §2's module/stage assertions).
const TEMPLATE = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="stylesheet" media="all" href="oma-asset:app.css">
<${S} type="module" crossorigin src="oma-asset:app.js">${CLOSE}
</head><body><div id="root"></div>
<${S} type="text/oma-function" data-fn="tally">
return { n: api.read().length };
${CLOSE}
</body></html>`;
// Both bundles carry the byte sequence that would break out of the tag they are inlined into —
// the escape is not decoration, it is the difference between an app and an injection. The JS also
// carries the literal characters `<body>`: a bundle is TEXT, and the one rewrite that used to
// reach into it (the stage class) turned that text into a syntax error.
const BUNDLE_JS = `const o = window.oma; o.ready(function(s){ document.getElementById("root").textContent = "items: " + s.items.length; });\nexport const mounted = "the <body> element";\n// literal close: ${CLOSE} and ${"</SCRIPT>"}`;
const BUNDLE_CSS = `#root { color: var(--color-text-primary); }\n/* literal close: </style> */`;
const MANIFEST = { manifest_version: 2, kind: "app", collections: { outside: {} },
  // A declared stage width is what makes stampStage run at all — without one it no-ops and the
  // seam order it belongs to is untested.
  stage: { width: "column" },
  functions: { tally: { description: "count the rows" } } };

writeFileSync(join(TMP, "ui.html"), TEMPLATE);
writeFileSync(join(TMP, "app.js"), BUNDLE_JS);
writeFileSync(join(TMP, "app.css"), BUNDLE_CSS);
writeFileSync(join(TMP, "manifest.json"), JSON.stringify(MANIFEST, null, 2));

const install = (args) => execFileSync("node", [join(ROOT, "install-app.mjs"), ...args],
  { encoding: "utf-8", env: { ...process.env, OMA_DB: DB } });

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("1. the push — one command carries the template, the declaration and the bundle");
let out;
try {
  out = install([join(TMP, "ui.html"), "--name", "outside-app", "--db", DB,
    "--manifest", join(TMP, "manifest.json"), "--asset", join(TMP, "app.js"), "--asset", join(TMP, "app.css")]);
} catch (e) {
  out = String(e.stdout || "") + String(e.stderr || "");
}
ok("install-app.mjs reports success", /✓ installed "outside-app"/.test(out), out.slice(-600));
ok("...naming the shape it recognised", /TEMPLATE \+ BUNDLE/.test(out), out.slice(0, 600));
ok("...and saying the AI cannot edit it", /built outside/i.test(out), out.slice(-600));

{
  const store = openStore(DB);
  const comp = store.getApp("outside-app");
  ok("the app exists, authored `human`", !!comp && comp.author === "human");
  // The template is stored VERBATIM: the store keeps source, not the document it serves.
  ok("the stored ui is the TEMPLATE, byte for byte", comp.ui === TEMPLATE,
    `stored ${comp && comp.ui.length} B vs template ${TEMPLATE.length} B`);
  ok("...so the bundle is NOT in the ui slot", !comp.ui.includes("o.ready(function"));
  ok("the manifest FILE became the manifest slot",
    JSON.parse(comp.manifest || "null")?.functions?.tally != null, comp.manifest);
  const files = store.listFiles("outside-app").map((f) => f.path).sort();
  ok("both assets are in this app's file plane", JSON.stringify(files) === JSON.stringify(["app.css", "app.js"]), JSON.stringify(files));
  store.close();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n2. every serve-time seam inlines the bundle — named one by one");

// The inlined marks: content that exists only in the bundles, and the absence of the scheme.
const inlined = (doc) => doc.includes("o.ready(function") && doc.includes("#root { color:")
  && !doc.includes("oma-asset:");
// …and the escape, which is what keeps an inlined bundle from ending the tag that holds it.
const escaped = (doc) => doc.includes("<\\/" + S) && doc.includes("<\\/SCRIPT") && doc.includes("<\\/style");

// THE TAG THE AUTHOR WROTE SURVIVES. `type="module"` is not cosmetic: dropping it turns a bundle
// into a classic script, which is a SyntaxError for ESM and — for anything that does parse — runs
// at parse time, before the deferred runtime module and before the mount point exists. The fetch
// attributes go, because there is nothing left to fetch.
const keptModule = (doc) => /<script data-oma="asset" data-oma-asset="app\.js" type="module">/.test(doc)
  && /<style data-oma="asset" data-oma-asset="app\.css" media="all">/.test(doc)
  && !/crossorigin/.test(doc);
// THE BUNDLE IS NOT REWRITTEN. The stage class belongs on the app's own <body>; the bundle merely
// contains those characters, and a document that stamped THEM shipped a broken string literal.
const bundleIntact = (doc) => doc.includes(`"the <body> element"`);
// …and it lands on the REAL body, which is the one the mount point is inside. Asserting only the
// class would pass on the broken document too — the bundle's rewritten string contains those same
// characters, which is exactly how a stamp that hit the wrong tag could read as a stamp that worked.
const stagedBody = (doc) => doc.includes(`<body class="stage-column"><div id="root">`);

const client = new Client({ name: "install-outside", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: "node", args: [join(ROOT, "src", "server.mjs")],
  env: { ...process.env, OMA_DB: DB, OMA_HOST: "outside-test", OMA_DYNAMIC_TOOLS: "1", OMA_VIEWER: "0" },
}));
const textOf = (r) => (r.content || []).map((c) => c.text || "").join("\n");

{ // SEAM 1 — the per-app ui:// resource (tools/apps.mjs registerApp), the direct-mode document.
  const r = await client.readResource({ uri: "ui://open-mcp-apps/outside-app.html" });
  const doc = r.contents[0].text;
  ok("SEAM ui:// resource — bundle inlined, no oma-asset: left", inlined(doc), doc.slice(0, 400));
  ok("...with the close-tag escape applied in both languages", escaped(doc));
  ok("...keeping type=module and media, dropping the fetch attributes", keptModule(doc), doc.slice(0, 500));
  ok("...with the bundle's own bytes untouched by the stage stamp", bundleIntact(doc));
  ok("...and the class on the app's real body", stagedBody(doc));
}
{ // SEAM 2 — get_app_html, what the universal loader mounts (and what oma.embed hands the runner).
  const r = await client.callTool({ name: "get_app_html", arguments: { name: "outside-app" } });
  const doc = r.structuredContent.html;
  ok("SEAM get_app_html — bundle inlined, no oma-asset: left", inlined(doc), doc.slice(0, 400));
  ok("...keeping type=module and media, dropping the fetch attributes", keptModule(doc), doc.slice(0, 500));
  ok("...with the bundle's own bytes untouched by the stage stamp", bundleIntact(doc));
  ok("...and the class on the app's real body", stagedBody(doc));
}
{ // …and the one read that must NOT inline: source is source.
  const r = await client.callTool({ name: "get_app", arguments: { name: "outside-app" } });
  const src = r.structuredContent.text;
  ok("get_app returns the TEMPLATE — references intact, bundle absent",
    src.includes("oma-asset:app.js") && !src.includes("o.ready(function"), src.slice(0, 300));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n3. read-only to the AI — two refusals and one permission");
const version = () => { const s = openStore(DB); const v = s.getApp("outside-app").version; s.close(); return v; };
{
  const v = version();
  const r = await client.callTool({ name: "edit_app", arguments: {
    command_id: randomUUID(), app: "outside-app", expected_version: v,
    edits: [{ old_string: "<div id=\"root\">", new_string: "<div id=\"root\" data-ai=\"1\">" }],
  } });
  ok("edit_app REFUSES", r.isError === true, textOf(r).slice(0, 200));
  ok("...saying where the source lives", /Source lives outside this store/.test(textOf(r)), textOf(r).slice(0, 300));
  ok("...and naming the way back in", /install-app\.mjs/.test(textOf(r)));
  ok("...NOTHING was applied", version() === v);
}
{
  // The replacement document is a LEGAL one — same manifest, same function block — so the only
  // thing that can refuse it is the gate under test. A stub here would be refused by
  // functionsJoinError instead, and this assertion would pass while the gate was gone.
  const v = version();
  const r = await client.callTool({ name: "save_app", arguments: {
    command_id: randomUUID(), name: "outside-app",
    ui: TEMPLATE.replace("<div id=\"root\">", "<div id=\"root\" data-ai=\"1\">"),
    description: "", expected_version: v,
  } });
  ok("the AI's save_app REFUSES", r.isError === true, textOf(r).slice(0, 200));
  ok("...naming the error", /built_outside/.test(textOf(r)), textOf(r).slice(0, 300));
  ok("...and nothing was written", version() === v);
}
{
  // The forgeable-actor hole: edit_app's inputSchema carries cmdArgs, whose `actor` the CALLER
  // chooses and the handler passes to the store. A gate that only lived in the store's actor
  // branch would open for any model that typed actor:"human".
  // The edit targets a string the FIRST attempt above did not consume, and reads a fresh version —
  // otherwise a suite run with the gate removed would see "0 matches" / a version conflict and
  // report this refusal as if the gate had produced it.
  const v = version();
  const r = await client.callTool({ name: "edit_app", arguments: {
    command_id: randomUUID(), app: "outside-app", expected_version: v, actor: "human",
    edits: [{ old_string: "<link rel=\"stylesheet\"", new_string: "<link data-ai=\"1\" rel=\"stylesheet\"" }],
  } });
  ok("edit_app refuses EVEN WITH actor:\"human\" (the field is caller-chosen, not authority)",
    r.isError === true && /Source lives outside this store/.test(textOf(r)), textOf(r).slice(0, 300));
  ok("...and nothing was applied", version() === v);
}
{
  const r = await client.callTool({ name: "restore_app", arguments: { name: "outside-app", checkpoint: 1 } });
  ok("restore_app is refused too — an old template with today's bundle is a state no build made",
    r.isError === true, textOf(r).slice(0, 200));
}
{
  // The manifest slot is part of the build too (install-app.mjs --manifest), so the one verb that
  // writes ONLY that slot is refused on the same grounds. Pinned because it is a CONSEQUENCE of
  // where the gate sits, and a consequence nobody asserted is a consequence someone will "fix".
  // Its own fixture: promote_app short-circuits on an app already kind "app", and a test that
  // green-lit on THAT would be asserting nothing at all.
  {
    const store = openStore(DB);
    store.execute({ type: "save_app", command_id: randomUUID(), name: "outside-visual",
      ui: `<html><body><div id="root"></div><${S} src="oma-asset:app.js">${CLOSE}</body></html>`,
      manifest: { manifest_version: 2, kind: "visual" }, description: "", actor: "human", host: "outside-test" });
    store.close();
  }
  const r = await client.callTool({ name: "promote_app", arguments: { name: "outside-visual" } });
  ok("promote_app — manifest-only, and refused on the same grounds (the declaration is a build file)",
    r.isError === true && /built_outside/.test(textOf(r)), textOf(r).slice(0, 200));
}
await client.close();

{
  // …and the CLI is allowed: same app, same command, a new build.
  const before = version();
  writeFileSync(join(TMP, "app.js"), BUNDLE_JS + "\n// build 2");
  const out2 = install([join(TMP, "ui.html"), "--name", "outside-app", "--db", DB, "--update",
    "--manifest", join(TMP, "manifest.json"), "--asset", join(TMP, "app.js"), "--asset", join(TMP, "app.css")]);
  ok("re-pushing with --update succeeds (actor human — this door IS the edit)", /✓ installed/.test(out2), out2.slice(-400));
  // NOT "+1": `version` is the global ledger seq, and the two file writes above advance it too.
  // The invariant is that it MOVED FORWARD, which is what version means here.
  ok("...and the version moved forward", version() > before, `${before} → ${version()}`);
  const store = openStore(DB);
  const got = await openFileChannel(store).get("outside-app", "app.js");
  ok("...and the file plane holds the NEW build's bytes", got.bytes.toString("utf-8").endsWith("// build 2"));
  store.close();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n4. GET /view — the third seam, over real HTTP");
const proc = spawn("node", [join(ROOT, "src", "http.mjs")], {
  env: { ...process.env, OMA_DB: DB, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
});
proc.stdout.on("data", () => {});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("viewer didn't start")), 8000);
  proc.stderr.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(t); resolve(); } });
  proc.on("exit", () => reject(new Error("viewer exited early")));
});
try {
  const doc = await (await fetch(`http://127.0.0.1:${PORT}/view/outside-app`)).text();
  ok("SEAM /view — bundle inlined, no oma-asset: left", inlined(doc), doc.slice(0, 400));
  ok("...and it is the SECOND build being served (no stale copy anywhere)", doc.includes("// build 2"));
  ok("...keeping type=module and media, dropping the fetch attributes", keptModule(doc), doc.slice(0, 500));
  ok("...with the bundle's own bytes untouched by the stage stamp", bundleIntact(doc));
  ok("...and the class on the app's real body", stagedBody(doc));
  // The runtime module the shell injects must come BEFORE the app's, or `window.oma` is undefined
  // exactly when the bundle's top level runs. Both are modules, and modules run in document order.
  ok("...with the engine's runtime module ahead of the app's",
    doc.indexOf(`data-oma="runtime"`) < doc.indexOf(`data-oma-asset="app.js"`),
    `${doc.indexOf(`data-oma="runtime"`)} vs ${doc.indexOf(`data-oma-asset="app.js"`)}`);
  // WHO WE ARE, at parse time: the early-error notice is gated on the app's name, and /view used
  // to hand it over only inside the standalone block — read after the buffer was already drained.
  ok("...and __OMA_APP__ stamped, so a parse-time error has a name to report under",
    /window\.__OMA_APP__="outside-app"/.test(doc));

  // ── the loud failure ──────────────────────────────────────────────────────────────────────
  // Delete one asset out from under the app. Nothing about the template changes; what must change
  // is that the document SAYS SO, in the widget and in the console, instead of rendering a page
  // with a silently absent stylesheet.
  {
    const store = openStore(DB);
    await openFileChannel(store).del("outside-app", "app.css", { command_id: randomUUID() });
    store.close();
  }
  const broken = await (await fetch(`http://127.0.0.1:${PORT}/view/outside-app`)).text();
  // Everything below is read out of the BLOCK, not out of the page: `console.error` and the string
  // "app.css" both occur in an unresolved document too (the injected runtime has one, the template
  // has the other), so a page-wide match would report the error block as present when what is
  // actually being served is a dead `oma-asset:` link.
  const block = /<script data-oma="asset-error">([\s\S]*?)<\/script>/.exec(broken);
  ok("a MISSING asset is loud on screen", !!block, broken.slice(0, 300));
  ok("...and in the console", !!block && block[1].includes("console.error"));
  ok("...naming the file that is not there", !!block && block[1].includes("app.css"));
  ok("...and telling the author how to push it", !!block && /--asset/.test(block[1]));
  ok("...while the asset that IS there still inlines", broken.includes("o.ready(function") && !broken.includes("oma-asset:"));

// THE SHAPE RUNTIME.md §6.1 PRINTS IS A FRAGMENT — no <html>, no <head>, no <body> — and wrapApp
// builds the document around it. It picks where to inject by finding the first <head>, over a
// string that by then already CONTAINS the bundle. React's development build says "<head>" in an
// error message, so the whole shell went inside a JS string literal: measured, byte 846,769 of a
// 1.5 MB document, `Invalid or unexpected token`, blank card. Same species as the stage stamp, a
// second consumer, found by grepping the bundles for the other two structural tags.
console.log("\n5a. a FRAGMENT template whose bundle merely MENTIONS <head> and <html>");
{
  const FRAG = `<link rel="stylesheet" href="oma-asset:frag.css">
<div id="root"></div>
<${S} type="module" src="oma-asset:frag.js">${CLOSE}`;
  // The three structural tags, as text, the way an unminified framework build carries them.
  writeFileSync(join(TMP, "frag.js"),
    `const hint = "move the <style> tag to the <head> or add precedence";\n` +
    `const other = "expected <html> to be the root, and <body> to hold it";\nexport { hint, other };`);
  writeFileSync(join(TMP, "frag.css"), `#root { color: var(--color-text-primary); }`);
  writeFileSync(join(TMP, "frag-ui.html"), FRAG);
  writeFileSync(join(TMP, "frag-manifest.json"),
    JSON.stringify({ manifest_version: 2, kind: "app", collections: { fragdata: {} }, stage: { width: "wide" } }));
  install([join(TMP, "frag-ui.html"), "--name", "frag-app", "--db", DB, "--update",
    "--manifest", join(TMP, "frag-manifest.json"),
    "--asset", join(TMP, "frag.js"), "--asset", join(TMP, "frag.css")]);
  const doc = await (await fetch(`http://127.0.0.1:${PORT}/view/frag-app`)).text();
  ok("the served document is a document — it STARTS with the one we built",
    /^<!DOCTYPE html><html><head>/.test(doc), doc.slice(0, 120));
  ok("…the shell is injected before the app's bundle, not inside it",
    doc.indexOf(`data-oma="runtime"`) < doc.indexOf(`data-oma-asset="frag.js"`),
    `${doc.indexOf(`data-oma="runtime"`)} vs ${doc.indexOf(`data-oma-asset="frag.js"`)}`);
  ok("…and every structural tag the bundle merely MENTIONS is still text",
    doc.includes(`the <style> tag to the <head> or`)
      && doc.includes(`expected <html> to be the root, and <body> to hold it`));
  ok("…with the stage class on the body wrapApp built (a fragment has none of its own)",
    /<body class="stage-wide">/.test(doc), (doc.match(/<body[^>]*>/) || [""])[0]);
}

} finally {
  proc.kill();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log(`\n5. app_history retention — a human push keeps ${HUMAN_HISTORY_KEEP_DAYS} days, never the head`);
{
  // Three human saves, then the oldest two are back-dated past the window. A save is what runs the
  // sweep (there is no timer), so the fourth save is the act under test.
  const store = openStore(DB);
  const doc = (n) => `<!DOCTYPE html><html><body><div>v${n}</div>` +
    `<${S}>window.oma && 0${CLOSE}</body></html>`;
  const push = (n) => {
    const cur = store.getApp("retention-app");
    return store.execute({ type: "save_app", command_id: randomUUID(), name: "retention-app",
      ui: doc(n), description: "", actor: "human", host: "outside-test",
      ...(cur ? { expected_version: cur.version } : {}) });
  };
  for (let i = 1; i <= 3; i++) ok(`push v${i}`, push(i).ok);
  const rows = () => { const d = new Database(DB); const r = d.prepare("SELECT version, ts FROM app_history WHERE name = 'retention-app' ORDER BY version").all(); d.close(); return r; };
  ok("three revisions on file", rows().length === 3, JSON.stringify(rows().map((r) => r.version)));

  // Back-date the two oldest well past the window. Written through SQL because the alternative is
  // a test that has to wait a week.
  const old = new Date(Date.now() - (HUMAN_HISTORY_KEEP_DAYS + 3) * 86_400_000).toISOString();
  {
    const d = new Database(DB);
    const vs = rows().map((r) => r.version);
    d.prepare("UPDATE app_history SET ts = ? WHERE name = 'retention-app' AND version IN (?, ?)").run(old, vs[0], vs[1]);
    d.close();
  }
  const head3 = store.getApp("retention-app").version;
  ok("push v4 (the save that sweeps)", push(4).ok);
  const after = rows();
  ok("the two back-dated revisions are gone", !after.some((r) => r.ts === old), JSON.stringify(after));
  ok("...the recent one survived", after.some((r) => r.version === head3), JSON.stringify(after.map((r) => r.version)));
  ok("...and so did the new head", after.some((r) => r.version === store.getApp("retention-app").version));
  ok("the app itself is untouched — head revision still readable", /v4/.test(store.getApp("retention-app").ui));

  // The other half of the rule: an AGENT-authored app keeps everything, however old.
  const agentDoc = (n) => `<!DOCTYPE html><html><body><div>a${n}</div><${S}>window.oma && 0${CLOSE}</body></html>`;
  for (let i = 1; i <= 2; i++) {
    const cur = store.getApp("kept-app");
    store.execute({ type: "save_app", command_id: randomUUID(), name: "kept-app", ui: agentDoc(i),
      description: "", actor: "agent", host: "outside-test", ...(cur ? { expected_version: cur.version } : {}) });
  }
  {
    const d = new Database(DB);
    d.prepare("UPDATE app_history SET ts = ? WHERE name = 'kept-app'").run(old);
    d.close();
  }
  const cur = store.getApp("kept-app");
  store.execute({ type: "save_app", command_id: randomUUID(), name: "kept-app", ui: agentDoc(3),
    description: "", actor: "agent", host: "outside-test", expected_version: cur.version });
  const d = new Database(DB);
  const kept = d.prepare("SELECT COUNT(*) AS n FROM app_history WHERE name = 'kept-app'").get().n;
  d.close();
  ok("an AI-authored app keeps every revision, back-dated or not (retention is the human-push rule)",
    kept === 3, `got ${kept}`);

  // …and the way that rule could still eat an AI app's history: undoLast re-saves the previous
  // revision with actor "human", and agent↔human are the SAME tier, so nothing else separates
  // them. One Undo in the Data pane would have swept every checkpoint older than the window off
  // an app the human never pushed — a recovery action deleting the recovery points. Pinned as a
  // COUNT, before and after, because the failure is silent by construction.
  {
    const d2 = new Database(DB);
    const before = d2.prepare("SELECT COUNT(*) AS n FROM app_history WHERE name = 'kept-app'").get().n;
    d2.close();
    const r = store.undoLast("kept-app");
    ok("undo on an AI app works", r && r.ok !== false, JSON.stringify(r).slice(0, 160));
    const d3 = new Database(DB);
    const after = d3.prepare("SELECT COUNT(*) AS n FROM app_history WHERE name = 'kept-app'").get().n;
    d3.close();
    ok("…and it swept NOTHING (undo writes as `human`; the app is the AI's)", after === before + 1,
      `${before} → ${after}`);
  }
  store.close();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A file plane is keyed (app, path), so a build whose output NAME changes — every content-hashed
// bundler, by default — leaves the last build's file behind with nothing referencing it and
// nothing collecting it. --prune-assets is the opt-in that clears them, and "opt-in" is the whole
// design: the plane also holds whatever the AI wrote there with file_write, which a build step
// must not sweep away.
console.log("\n5b. --prune-assets — the orphan a hashed filename leaves behind");
{
  const tplFor = (js) => `<!DOCTYPE html><html><head><meta charset="UTF-8">
<${S} type="module" src="oma-asset:${js}">${CLOSE}
</head><body><div id="root"></div></body></html>`;
  const push = (js, extra = []) => {
    writeFileSync(join(TMP, js), `console.log("build ${js}");`);
    writeFileSync(join(TMP, "hash-ui.html"), tplFor(js));
    return install([join(TMP, "hash-ui.html"), "--name", "hash-app", "--db", DB, "--update",
      "--asset", join(TMP, js), ...extra]);
  };
  const plane = () => {
    const s = openStore(DB);
    const names = (s.listFiles("hash-app") || []).map((f) => f.path).sort();
    s.close();
    return names;
  };
  push("app-a1b2c3.js");
  ok("build A is stored", plane().join() === "app-a1b2c3.js", plane().join());
  push("app-d4e5f6.js");
  ok("build B WITHOUT the flag leaves A behind — this is the leak, and it is the default",
    plane().join() === "app-a1b2c3.js,app-d4e5f6.js", plane().join());

  // A file the AI put there — the reason this is not the default. It must survive a prune that
  // was aimed at a bundle.
  {
    const s = openStore(DB);
    await openFileChannel(s).put("hash-app", "notes.txt", Buffer.from("written by the AI"),
      { mime: "text/plain", command_id: randomUUID() });
    s.close();
  }
  const dry = push("app-d4e5f6.js", ["--prune-assets", "--dry-run"]);
  ok("--dry-run NAMES what it would prune and writes nothing",
    /prune\s+2 file\(s\)/.test(dry) && /app-a1b2c3\.js/.test(dry) && /notes\.txt/.test(dry)
      && plane().length === 3, dry.slice(-500));

  const out = push("app-g7h8i9.js", ["--prune-assets"]);
  ok("…and with the flag the real run prunes them", /✓ pruned "app-a1b2c3\.js"/.test(out), out.slice(-600));
  ok("only the build this push carried is left", plane().join() === "app-g7h8i9.js", plane().join());
  // The one that MUST be surprising if it ever changes: an opt-in sweep is still a sweep.
  ok("…and the AI's own file went with it — which is exactly why the flag is opt-in",
    !plane().includes("notes.txt"));
  const again = push("app-g7h8i9.js", ["--prune-assets"]);
  ok("a second prune with nothing to do says so rather than acting",
    /no orphans/.test(again) && plane().join() === "app-g7h8i9.js", again.slice(-400));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n6. the save gate checks reference SYNTAX, and only syntax");
{
  const store = openStore(DB);
  const bad = store.execute({ type: "save_app", command_id: randomUUID(), name: "bad-ref-app",
    ui: `<html><body><${S} src="oma-asset:../../etc/passwd">${CLOSE}</body></html>`,
    description: "", actor: "human", host: "outside-test" });
  ok("a traversal path is refused", bad.ok === false && bad.error === "bad_asset_ref", JSON.stringify(bad));
  // …and a reference to a file that does not exist YET is ACCEPTED, because a push is two writes
  // and neither order may be the wrong one.
  const good = store.execute({ type: "save_app", command_id: randomUUID(), name: "future-asset-app",
    ui: `<html><body><${S} src="oma-asset:not-yet.js">${CLOSE}</body></html>`,
    description: "", actor: "human", host: "outside-test" });
  ok("a reference to a file not stored yet is ACCEPTED (template first, bundle second)", good.ok === true, JSON.stringify(good));
  store.close();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// This door is also a PACKAGE ENTRY POINT. The tool package `@2nd1st/oma` drives it from its own
// bin, and `files` has carried install-app.mjs since it was written — but `files` is only the
// first gate on the road out. The second is scripts/publish.mjs's ALLOWLIST (npm packs from the
// public checkout), and the third is the `exports` map, which is what a modern resolver reads
// INSTEAD of the file tree. Measured before this section existed: the file shipped, and
// `import.meta.resolve("@2nd1st/open-mcp-apps/install-app.mjs")` was still
// ERR_PACKAGE_PATH_NOT_EXPORTED — so the consumer had to go around, via createRequire on
// package.json and a hand-joined path.
//
// The check RESOLVES rather than reading the key, and the control below is what makes that worth
// doing: `src/store.mjs` is in `files` too, and it must still be refused. A probe that passed for
// both would be reading the file tree, and would have said yes on the broken map as well.
console.log("\n8. the door resolves as a package subpath — the third gate, not just `files`");
{
  const consumer = join(TMP, "consumer");
  mkdirSync(join(consumer, "node_modules", "@2nd1st"), { recursive: true });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", type: "module", version: "1.0.0" }));
  let linked = true;
  try {
    symlinkSync(ROOT, join(consumer, "node_modules", "@2nd1st", "open-mcp-apps"),
      process.platform === "win32" ? "junction" : "dir");
  } catch (e) { linked = false; console.log(`  ⚠ SKIPPED — could not link the package into a consumer tree: ${e.message}`); }
  if (linked) {
    const resolve1 = (spec) => {
      try {
        return { ok: true, url: execFileSync("node", ["--input-type=module", "-e", `console.log(import.meta.resolve(${JSON.stringify(spec)}))`],
          { cwd: consumer, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
      } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; }
    };
    const sub = resolve1("@2nd1st/open-mcp-apps/install-app.mjs");
    ok("`@2nd1st/open-mcp-apps/install-app.mjs` resolves", sub.ok, sub.err);
    ok("...to this repo's install-app.mjs", sub.ok && sub.url === pathToFileURL(join(ROOT, "install-app.mjs")).href,
      sub.ok ? sub.url : "(did not resolve)");
    // The control. Without it this section would also have passed against the broken map, because
    // a probe that reached the file tree would find every shipped file.
    const unexported = resolve1("@2nd1st/open-mcp-apps/src/store.mjs");
    ok("...and a path the map does NOT declare is still refused (so the MAP is what answered)",
      !unexported.ok && /ERR_PACKAGE_PATH_NOT_EXPORTED/.test(unexported.err), unexported.ok ? unexported.url : unexported.err);
    const root = resolve1("@2nd1st/open-mcp-apps");
    ok("...and the root entry still resolves", root.ok && root.url === pathToFileURL(join(ROOT, "index.mjs")).href,
      root.ok ? root.url : root.err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// "size 153 B" for a 185-byte file. A JS string's `.length` is UTF-16 code units; the door was
// printing it after the letter B. It agrees with the byte count for pure ASCII and drifts with
// exactly the content that makes a document worth installing — prose, an emoji, any non-Latin
// script. The number is the whole point of the line, and nothing downstream would ever contradict
// it, so it was a wrong answer nobody could catch by reading the output.
//
// Three printed numbers, one fixture: the push readout, its `(replacing … B)` half, and the
// refusal a second push without --update prints. The `--asset` line is deliberately NOT in this
// list: those bytes arrive as a Buffer, whose `.length` already IS a byte count.
console.log("\n9. every `N B` this door prints is measured in BYTES, not UTF-16 code units");
{
  // Big enough that toLocaleString actually groups (so the assertion sees the real printed form),
  // and multi-byte enough that the two measurements cannot coincide.
  const prose = "记一笔账 — 中文正文、emoji 🎈, and a Latin tail so the file is not uniform.\n";
  const MB_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>字节</title></head><body>\n`
    + `<div id="root"></div>\n<!-- ${prose.repeat(20)} -->\n`
    + `<${S}>window.oma.ready(function (s) { document.getElementById("root").textContent = s.items.length; });${CLOSE}\n`
    + `</body></html>`;
  const realBytes = Buffer.byteLength(MB_HTML, "utf8");
  const units = MB_HTML.length;
  // The fixture has to be able to TELL THE TWO APART, or every assertion below passes vacuously.
  ok(`the fixture separates the two measurements (${realBytes} B vs ${units} UTF-16 units)`, realBytes !== units);
  const shownBytes = realBytes.toLocaleString(), shownUnits = units.toLocaleString();
  const mbFile = join(TMP, "byte-count.html");
  writeFileSync(mbFile, MB_HTML);

  const dry = install([mbFile, "--name", "byte-count-app", "--db", DB, "--dry-run"]);
  ok(`the push readout says ${shownBytes} B`, new RegExp(`size\\s+${shownBytes} B`).test(dry), dry.slice(0, 400));
  ok("...and never the code-unit count", !dry.includes(`${shownUnits} B`), dry.slice(0, 400));

  install([mbFile, "--name", "byte-count-app", "--db", DB]);
  {
    const store = openStore(DB);
    // The stored ui is this document verbatim (no legacy declaration block to lift out), so the
    // two readouts below are quoting the same bytes the assertions above measured.
    ok("the stored ui is the fixture, byte for byte", store.getApp("byte-count-app").ui === MB_HTML);
    store.close();
  }
  const again = install([mbFile, "--name", "byte-count-app", "--db", DB, "--update", "--dry-run"]);
  // The version is NOT pinned: `version` is the store's global ledger seq, so it depends on how
  // many writes the sections above did — a number this section has no business asserting.
  ok(`the \`replacing …\` half says ${shownBytes} B too`, new RegExp(`replacing ${shownBytes} B at v\\d+`).test(again), again.slice(0, 400));

  let refusal = "";
  try { install([mbFile, "--name", "byte-count-app", "--db", DB]); }
  catch (e) { refusal = String(e.stdout || "") + String(e.stderr || ""); }
  ok("the second push is refused without --update", /already exists/.test(refusal), refusal.slice(-300));
  ok(`...and that refusal quotes ${shownBytes} B`, refusal.includes(`${shownBytes} B, by human`), refusal.slice(-300));
  ok("...never the code-unit count", !refusal.includes(`${shownUnits} B`), refusal.slice(-300));
}

for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
