// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/csp-passthrough.mjs — an app declares where it reaches, the user adds to it, the engine
// relays the union. This file guards the whole path: the save door, the privileged settings writer,
// the merge, the `_meta` a host reads, and the two policies we enforce ourselves.
//
// TWO KINDS OF ASSERTION, and the second kind is the one that pays for this file:
//
//   · POSITIVE — a declaration reaches the wire. Easy to write, and easy to make pass by accident.
//   · FLOOR — an app that declares NOTHING gets byte-for-byte what this engine emitted before any
//     of this existed. Those bytes are hard-coded LITERALS below, captured from the previous commit
//     and never re-derived from the code under test: comparing runnerCspFor() against
//     RUNNER_CSP_POLICY would only prove the code agrees with itself, and the whole risk of a
//     "widen it per app" change is that the floor quietly widens for everybody.
//
// Run: node test/csp-passthrough.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { openStore, cspShapeError, cspFor, manifestShapeError } from "../src/store.mjs";
import { runnerCspFor, RUNNER_CSP_POLICY, composeChildDoc } from "../src/runner.mjs";
import { viewCspFor } from "../src/http.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "csp-passthrough.db");
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

// ─────────────────────────────────────────────────────────────────────────── the frozen baselines
// Captured on 6258a87 (v0.5.9), the commit before apps could declare anything. Written out in full
// rather than imported: an imported constant follows the code it is supposed to be pinning.
const FLOOR_RUNNER = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'";
const FLOOR_VIEW = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'; connect-src 'self'; frame-src 'none'; form-action 'none'";
const FLOOR_META = '{"ui":{"csp":{"connectDomains":[],"resourceDomains":[]}},"openai/widgetCSP":{"connect_domains":[],"resource_domains":[]}}';

const PLAIN_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="a">x</div><script type="module">window.oma.ready(()=>{});</scr' + 'ipt></body></html>';

console.log("1. shape — what an origin is, said once and refused clearly");
{
  ok("a good declaration passes", cspShapeError({ connectDomains: ["https://api.github.com"] }) === null);
  ok("wss:// is an origin (the spec's own connectDomains example is one)",
    cspShapeError({ connectDomains: ["wss://live.example.com:8443"] }) === null);
  ok("a wildcard subdomain is an origin", cspShapeError({ resourceDomains: ["https://*.example.com"] }) === null);
  ok("an empty array is allowed — it is a positive statement, not a mistake",
    cspShapeError({ connectDomains: [] }) === null);
  ok("an omitted key is allowed (it IS the spec's secure default)", cspShapeError({}) === null);
  ok("all four spec keys are known", cspShapeError({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }) === null);
  ok("an unknown key is ignored, not refused — a doc written for a newer engine must still save",
    cspShapeError({ futureDomains: ["nonsense"] }) === null);

  ok("a non-object is refused", /must be an object/.test(cspShapeError("https://x.com") || ""));
  ok("an array is refused", /must be an object/.test(cspShapeError(["https://x.com"]) || ""));
  const notArray = cspShapeError({ connectDomains: "https://api.github.com" }) || "";
  ok("a bare string where an array belongs is refused, and the message shows the array",
    /must be an array of origins/.test(notArray) && notArray.includes('["https://api.example.com"]'), notArray);
  const notOrigin = cspShapeError({ connectDomains: ["api.github.com"] }) || "";
  ok("a bare host is refused, and the message says what to write instead",
    /is not an origin/.test(notOrigin) && notOrigin.includes("scheme://host[:port]"), notOrigin);
  ok("a path is refused — CSP source expressions match by origin",
    /is not an origin/.test(cspShapeError({ connectDomains: ["https://api.github.com/v3"] }) || ""));
  ok("a non-string member is refused", /is not an origin/.test(cspShapeError({ connectDomains: [42] }) || ""));
  ok("the seat is named in the refusal", (cspShapeError({ connectDomains: [1] }, "policy:csp:*") || "").startsWith("policy:csp:*.connectDomains"));

  // 🔴 THE ONE THAT IS NOT COSMETIC. These strings are concatenated into our own two CSP policies,
  // so a value carrying `;` or whitespace is directive injection — "widen my connect-src" becomes
  // "and by the way allow every script". Refusing anything that is not an origin is what makes it
  // impossible, rather than trusting some downstream escaper that does not exist.
  for (const evil of ["https://x.com; script-src *", "https://x.com 'unsafe-eval'", "https://x.com\nscript-src *", "'unsafe-inline'", "*"]) {
    ok(`directive injection refused: ${JSON.stringify(evil)}`, cspShapeError({ connectDomains: [evil] }) !== null);
  }
}

console.log("\n2. the save door refuses a bad declaration through manifestShapeError");
{
  ok("manifest.csp with a bad member is refused by the same grammar — ONE definition, three callers",
    /is not an origin/.test(manifestShapeError({ csp: { connectDomains: ["api.github.com"] } }) || ""));
  ok("manifest.csp non-object is refused", /manifest\.csp must be an object/.test(manifestShapeError({ csp: [] }) || ""));
  ok("a good manifest.csp saves", manifestShapeError({ csp: { connectDomains: ["https://api.github.com"] } }) === null);
  ok("no csp at all is still a valid manifest (nothing became mandatory)", manifestShapeError({ kind: "app" }) === null);
}

console.log("\n3. the merge — declaration ∪ policy:csp:<app> ∪ policy:csp:*, deduped, ordered");
{
  const store = openStore(DB);
  store.execute({ type: "save_app", command_id: "m-1", name: "merge-fixture", ui: PLAIN_HTML,
    manifest: { csp: { connectDomains: ["https://api.github.com"] } }, actor: "seed" });
  const comp = () => store.getApp("merge-fixture");

  ok("declaration alone", JSON.stringify(cspFor(comp(), store)) === '{"connectDomains":["https://api.github.com"]}');
  ok("an app with no declaration merges to {} — every key empty is every key omitted",
    JSON.stringify(cspFor({ name: "nothing", manifest: null }, store)) === "{}");

  const set = (key, value) => store.executePrivileged({ type: "add_item", command_id: "s-" + key + value,
    collection: "settings", fields: { key, value }, actor: "human", host: "test" });

  set("policy:csp:merge-fixture", JSON.stringify({ connectDomains: ["https://api.stripe.com"] }));
  ok("policy:csp:<app> unions with the declaration",
    JSON.stringify(cspFor(comp(), store)) === '{"connectDomains":["https://api.github.com","https://api.stripe.com"]}',
    JSON.stringify(cspFor(comp(), store)));

  set("policy:csp:*", JSON.stringify({ connectDomains: ["https://api.stripe.com", "https://cdn.jsdelivr.net"], frameDomains: ["https://www.youtube.com"] }));
  const merged = cspFor(comp(), store);
  ok("policy:csp:* unions on top, and a duplicate appears ONCE",
    JSON.stringify(merged.connectDomains) === '["https://api.github.com","https://api.stripe.com","https://cdn.jsdelivr.net"]',
    JSON.stringify(merged.connectDomains));
  ok("the global row reaches a key the app never declared", JSON.stringify(merged.frameDomains) === '["https://www.youtube.com"]');
  ok("keys nobody declared stay omitted", merged.resourceDomains === undefined && merged.baseUriDomains === undefined);
  ok("the global row applies to an app that declared nothing at all",
    JSON.stringify(cspFor({ name: "other", manifest: null }, store).frameDomains) === '["https://www.youtube.com"]');

  // The gate belongs on the road the value LEAVES by, not only on the way in: a settings row can
  // predate this gate, or be written by an older engine sharing the same SQLite file.
  const clean = JSON.stringify(cspFor({ name: "unpoisoned", manifest: null }, store));
  set("policy:csp:poisoned", JSON.stringify({ connectDomains: ["https://ok.example.com", "https://x.com; script-src *"] }));
  const poisoned = cspFor({ name: "poisoned", manifest: null }, store);
  ok("a settings row that would inject a directive contributes NOTHING — whole, not half",
    !JSON.stringify(poisoned).includes("script-src") && !JSON.stringify(poisoned).includes("ok.example.com"),
    JSON.stringify(poisoned));
  ok("…and the OTHER sources are untouched by that rejection (only the bad row drops out)",
    JSON.stringify(poisoned) === clean, JSON.stringify(poisoned) + " vs " + clean);
  set("policy:csp:garbage", "not json at all");
  ok("an unparseable settings row contributes nothing and throws nothing",
    JSON.stringify(cspFor({ name: "garbage", manifest: null }, store)) === clean);
  store.close();
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);
}

console.log("\n4. the two policies we enforce ourselves");
{
  // FLOOR. Hard-coded literals, captured before any of this existed.
  ok("runnerCspFor() with no declaration is byte-identical to v0.5.9", runnerCspFor() === FLOOR_RUNNER, runnerCspFor());
  ok("…and so is an explicitly empty declaration", runnerCspFor({}) === FLOOR_RUNNER);
  ok("…and so is a declaration whose every array is empty",
    runnerCspFor({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }) === FLOOR_RUNNER);
  ok("viewCspFor() with no declaration is byte-identical to v0.5.9", viewCspFor() === FLOOR_VIEW, viewCspFor());
  ok("the exported floor constant still IS the floor the builder produces (the anti-drift pin)",
    RUNNER_CSP_POLICY === FLOOR_RUNNER && runnerCspFor() === RUNNER_CSP_POLICY);
  ok("composeChildDoc with no csp is unchanged — the option cost the old callers nothing",
    composeChildDoc("<p>x</p>").includes('content="' + FLOOR_RUNNER + '"'));

  // WIDENING, directive by directive, against the spec's own mapping.
  const connect = runnerCspFor({ connectDomains: ["https://api.github.com"] });
  ok("connectDomains reaches connect-src, REPLACING 'none' (which may not be combined)",
    connect.includes("connect-src https://api.github.com;") && !connect.includes("connect-src 'none'"), connect);
  const view = viewCspFor({ connectDomains: ["https://api.github.com"] });
  ok("…but in the viewer it JOINS 'self', because losing 'self' would cut /rpc",
    view.includes("connect-src 'self' https://api.github.com;"), view);

  const res = runnerCspFor({ resourceDomains: ["https://cdn.jsdelivr.net"] });
  ok("resourceDomains reaches all five resource directives, keeping each floor",
    res.includes("style-src 'unsafe-inline' https://cdn.jsdelivr.net;")
    && res.includes("img-src data: https://cdn.jsdelivr.net;")
    && res.includes("font-src data: https://cdn.jsdelivr.net;")
    && res.includes("script-src 'unsafe-inline' https://cdn.jsdelivr.net;")
    && res.includes("media-src https://cdn.jsdelivr.net;"), res);
  ok("media-src appears ONLY when resourceDomains is declared (absent, it falls back to default-src 'none')",
    !runnerCspFor({ connectDomains: ["https://x.example.com"] }).includes("media-src"));

  const frame = runnerCspFor({ frameDomains: ["https://www.youtube.com"] });
  ok("frameDomains reaches frame-src, replacing 'none'",
    frame.includes("frame-src https://www.youtube.com;") && !frame.includes("frame-src 'none'"), frame);
  ok("…and frame-src stays 'none' when nothing declared it", runnerCspFor({ connectDomains: ["https://x.example.com"] }).includes("frame-src 'none'"));

  ok("baseUriDomains reaches base-uri, and appears only when declared",
    runnerCspFor({ baseUriDomains: ["https://cdn.example.com"] }).endsWith("base-uri https://cdn.example.com")
    && !runnerCspFor({ connectDomains: ["https://x.example.com"] }).includes("base-uri"));

  ok("form-action 'none' survives every widening — the one directive that does not inherit default-src",
    runnerCspFor({ connectDomains: ["https://a.example.com"], resourceDomains: ["https://b.example.com"],
      frameDomains: ["https://c.example.com"], baseUriDomains: ["https://d.example.com"] }).includes("form-action 'none'"));
  ok("default-src 'none' survives every widening",
    runnerCspFor({ connectDomains: ["https://a.example.com"], resourceDomains: ["https://b.example.com"] }).startsWith("default-src 'none';"));
  ok("composeChildDoc carries the widened policy when a declaration is handed down",
    composeChildDoc("<p>x</p>", { csp: { connectDomains: ["https://api.github.com"] } }).includes("connect-src https://api.github.com"));
}

console.log("\n5. on the wire — what a host actually reads");
const client = new Client({ name: "csp", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: "node",
  args: [join(ROOT, "src", "server.mjs")],
  // OMA_DYNAMIC_TOOLS=1 is what makes a host able to reach a PER-APP resource at all (see §6).
  env: { ...process.env, OMA_DB: DB, OMA_HOST: "csp-test", OMA_VIEWER: "0", OMA_DYNAMIC_TOOLS: "1" },
}));

const save = (name, manifest) => client.callTool({ name: "save_app", arguments: { name, ui: PLAIN_HTML, ...(manifest ? { manifest } : {}) } });
const metaOf = async (name) => (await client.readResource({ uri: `ui://open-mcp-apps/${name}.html` })).contents[0]._meta;

{
  await save("csp-quiet", { kind: "app" });
  const quiet = await metaOf("csp-quiet");
  // THE FLOOR, on the wire, byte for byte. Every app shipped today is in this state.
  ok("an app that declares nothing produces the v0.5.9 _meta, byte for byte",
    JSON.stringify(quiet) === FLOOR_META, JSON.stringify(quiet));

  await save("csp-loud", { kind: "app", csp: { connectDomains: ["https://api.github.com"] } });
  const loud = await metaOf("csp-loud");
  ok("a declared connectDomains reaches _meta.ui.csp (the spec key)",
    JSON.stringify(loud.ui.csp.connectDomains) === '["https://api.github.com"]', JSON.stringify(loud.ui.csp));
  ok("…and ChatGPT's snake_case twin agrees",
    JSON.stringify(loud["openai/widgetCSP"].connect_domains) === '["https://api.github.com"]');
  ok("the twin gets no invented keys — it carries only the two fields ChatGPT documents",
    Object.keys(loud["openai/widgetCSP"]).join(",") === "connect_domains,resource_domains");
  ok("resourceDomains stays present-and-empty (a positive 'reaches nothing' a reviewer can read)",
    Array.isArray(loud.ui.csp.resourceDomains) && loud.ui.csp.resourceDomains.length === 0);
  ok("frameDomains/baseUriDomains stay ABSENT when undeclared — declaring an empty one invites a stricter review",
    loud.ui.csp.frameDomains === undefined && loud.ui.csp.baseUriDomains === undefined);

  await save("csp-framer", { kind: "app", csp: { frameDomains: ["https://www.youtube.com"], baseUriDomains: ["https://cdn.example.com"] } });
  const framer = await metaOf("csp-framer");
  ok("frameDomains and baseUriDomains reach _meta when they ARE declared",
    JSON.stringify(framer.ui.csp.frameDomains) === '["https://www.youtube.com"]'
    && JSON.stringify(framer.ui.csp.baseUriDomains) === '["https://cdn.example.com"]');

  // The save door, over the wire this time — the message has to be readable by whoever typed it.
  const bad = await save("csp-bad", { kind: "app", csp: { connectDomains: ["api.github.com"] } });
  ok("save_app refuses a non-origin and says what to write instead",
    bad.isError === true && /is not an origin/.test(bad.content[0].text) && bad.content[0].text.includes("scheme://host[:port]"),
    bad.content?.[0]?.text);
  const badShape = await save("csp-bad2", { kind: "app", csp: { connectDomains: "https://api.github.com" } });
  ok("save_app refuses a bare string where an array belongs",
    badShape.isError === true && /must be an array of origins/.test(badShape.content[0].text));
}

console.log("\n6. app_html carries the merge (the loader's channel to the runner child)");
{
  const sc = (await client.callTool({ name: "app_html", arguments: { name: "csp-loud" } })).structuredContent;
  ok("app_html declares csp in structuredContent", JSON.stringify(sc.csp) === '{"connectDomains":["https://api.github.com"]}', JSON.stringify(sc.csp));
  ok("…and it is the MERGE, not the raw declaration `declaration` already carries",
    sc.declaration.csp !== undefined && sc.csp !== sc.declaration.csp);
  const quiet = (await client.callTool({ name: "app_html", arguments: { name: "csp-quiet" } })).structuredContent;
  ok("an app that declares nothing reports {} — the child then gets the floor", JSON.stringify(quiet.csp) === "{}");
}

console.log("\n7. security_set — the user's own additions");
{
  const bad = await client.callTool({ name: "security_set", arguments: { key: "policy:csp:csp-quiet", value: "https://api.github.com" } });
  ok("security_set refuses a non-JSON value and shows the shape",
    bad.isError === true && /JSON object of origin arrays/.test(bad.content[0].text) && bad.content[0].text.includes("connectDomains"),
    bad.content?.[0]?.text);
  const badShape = await client.callTool({ name: "security_set", arguments: { key: "policy:csp:*", value: JSON.stringify({ connectDomains: ["api.github.com"] }) } });
  ok("security_set refuses a non-origin member, naming the key",
    badShape.isError === true && /is not an origin/.test(badShape.content[0].text) && badShape.content[0].text.includes("policy:csp:*"),
    badShape.content?.[0]?.text);
  ok("…and NOTHING was written — a refusal that half-applied would be worse than no gate",
    /NOTHING was written/.test(badShape.content[0].text)
    && JSON.stringify((await metaOf("csp-quiet"))) === FLOOR_META);

  const good = await client.callTool({ name: "security_set", arguments: { key: "policy:csp:csp-quiet", value: JSON.stringify({ connectDomains: ["https://api.stripe.com"] }) } });
  ok("security_set accepts a well-shaped declaration", !good.isError, good.content?.[0]?.text);
  ok("…and it reaches the resource _meta the host reads, with no save_app in between",
    JSON.stringify((await metaOf("csp-quiet")).ui.csp.connectDomains) === '["https://api.stripe.com"]');
  ok("…which proves the per-app _meta is computed per READ, not captured at registration",
    JSON.stringify((await metaOf("csp-quiet"))["openai/widgetCSP"].connect_domains) === '["https://api.stripe.com"]');

  await client.callTool({ name: "security_set", arguments: { key: "policy:csp:*", value: JSON.stringify({ connectDomains: ["https://api.github.com", "https://global.example.com"] }) } });
  const loud = await metaOf("csp-loud");
  ok("the global row unions with an app's own declaration and dedupes across sources",
    JSON.stringify(loud.ui.csp.connectDomains) === '["https://api.github.com","https://global.example.com"]',
    JSON.stringify(loud.ui.csp.connectDomains));
}

console.log("\n8. the universal loader carries the UNION of every app's declaration (plan §7-8, option A)");
{
  // ONE resource serves every app, and `open_app` — the door every host takes by default — points
  // its resourceUri at exactly this resource, so no single app's declaration could ride it. Leo's
  // ruling (2026-08-16): the host is asked to allow the union of everything declared in this store
  // (apps' manifest.csp ∪ the user's per-app and global additions), and the runner child inside the
  // loader is narrowed back to its own app by composeChildDoc (parent ∩ own). Two apps are in this
  // store: csp-loud declares api.github.com, csp-quiet was granted api.stripe.com by the user in §7.
  const loader = (await client.readResource({ uri: "ui://open-mcp-apps/app.html" })).contents[0]._meta;
  const conn = loader?.ui?.csp?.connectDomains || [];
  ok("the loader's _meta.ui.csp.connectDomains is the union of what the store's apps may reach",
    conn.includes("https://api.github.com") && conn.includes("https://api.stripe.com"), JSON.stringify(loader));
  ok("…and the ChatGPT twin agrees",
    JSON.stringify(loader["openai/widgetCSP"].connect_domains) === JSON.stringify(conn), JSON.stringify(loader["openai/widgetCSP"]));
  // NOT asserted: the resources/list `_meta` for the loader. That one is a REGISTRATION snapshot
  // (taken when the engine was built — before any app in this store existed), the same way every
  // per-app resource's list-time `_meta` is a snapshot of its first registration. resources/read is
  // the live answer. Which of the two a given host reads is a host-matrix question【未验】, recorded
  // in the plan's to-test list, not something this suite can settle.
  const openApp = (await client.listTools()).tools.find((t) => t.name === "open_app");
  ok("open_app still points at the loader, so this is the DEFAULT path — and now the union rides it",
    openApp._meta.ui.resourceUri === "ui://open-mcp-apps/app.html", openApp._meta?.ui?.resourceUri);
  const perApp = (await client.listTools()).tools.find((t) => t.name === "open_csp_loud");
  ok("the per-app tool still points at the per-app resource — the NARROW path, one app's own declaration",
    perApp?._meta?.ui?.resourceUri === "ui://open-mcp-apps/csp-loud.html", perApp?._meta?.ui?.resourceUri);
  // The floor: a store with nothing declared anywhere serves the loader with the 0.5.9 bytes.
  const quietDb = DB + ".quiet";
  for (const f of [quietDb, quietDb + "-wal", quietDb + "-shm"]) if (existsSync(f)) unlinkSync(f);
  const c2 = new Client({ name: "csp-quiet-store", version: "1.0.0" });
  await c2.connect(new StdioClientTransport({
    command: "node", args: [join(ROOT, "src", "server.mjs")],
    env: { ...process.env, OMA_DB: quietDb, OMA_HOST: "csp-test", OMA_VIEWER: "0" },
  }));
  const quietLoader = (await c2.readResource({ uri: "ui://open-mcp-apps/app.html" })).contents[0]._meta;
  ok("a store with no declarations anywhere: the loader's _meta is the 0.5.9 floor, byte for byte",
    JSON.stringify(quietLoader) === FLOOR_META, JSON.stringify(quietLoader));
  await c2.close();
  for (const f of [quietDb, quietDb + "-wal", quietDb + "-shm"]) if (existsSync(f)) unlinkSync(f);
}

console.log("\n9. the probe app this repo ships to ask a HOST the same questions");
{
  // Everything above measures OUR half: the declaration is validated, merged, and put on the wire.
  // The other half — whether a host turns `_meta.ui.csp` into a real Content-Security-Policy — is
  // unreachable from here by construction, and `test/probes/host-csp-probe` is how it gets asked.
  // What this section guards is the part of that probe a test CAN own: that the file as shipped
  // still installs, that the three keys it declares still arrive where a host reads them, and that
  // its engine-side function still runs. A probe that no longer installs is worse than no probe —
  // you find out in front of the host, with the reading you came for un-taken.
  const dir = join(ROOT, "test", "probes", "host-csp-probe");
  const ui = readFileSync(join(dir, "ui.html"), "utf8");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));

  const saved = await client.callTool({ name: "save_app", arguments: { name: "host-csp-probe", ui, manifest } });
  ok("the probe as shipped passes the save door — including the declaration↔body JOIN for net_probe",
    saved.isError !== true, saved.content?.[0]?.text);

  const meta = await metaOf("host-csp-probe");
  const csp = meta?.ui?.csp || {};
  ok("its connectDomains reach the per-app _meta a host reads",
    (csp.connectDomains || []).includes("https://api.github.com")
    && (csp.connectDomains || []).some((o) => o.startsWith("http://127.0.0.1:")), JSON.stringify(csp));
  ok("…and so do resourceDomains and frameDomains — three of the four spec keys on one app",
    JSON.stringify(csp.resourceDomains) === '["https://raw.githubusercontent.com"]'
    && JSON.stringify(csp.frameDomains) === '["https://www.youtube-nocookie.com"]', JSON.stringify(csp));
  // The control group has to BE a control: the probe fetches https://example.com expecting a
  // REFUSAL, so the day someone "helpfully" adds it to the manifest, the seventh reading silently
  // stops measuring anything and starts agreeing with whatever the host does.
  const declared = [].concat(...Object.values(manifest.csp || {}));
  ok("the origin the probe deliberately does NOT declare is absent from its own manifest",
    !declared.includes("https://example.com"), JSON.stringify(manifest.csp));
  const relayed = [].concat(csp.connectDomains || [], csp.resourceDomains || [], csp.frameDomains || [], csp.baseUriDomains || []);
  ok("…and from what the engine relays for it in this store", !relayed.includes("https://example.com"), JSON.stringify(csp));
  // …but "in this store" is the whole caveat, and it is worth pinning rather than describing. §7
  // above wrote a GLOBAL policy row on this same store, and it is now riding this app's relayed
  // policy without the app having said a word. On the open_app door the loader carries the union of
  // every app as well. So a host reaching an "undeclared" origin is only evidence of a host not
  // enforcing when the reader has first checked that the origin really was absent from what we
  // relayed — which is exactly the step the probe's README makes mandatory.
  ok("a user's global row reaches this app's relayed policy though its manifest never named it — the confound the README makes the reader rule out",
    relayed.includes("https://global.example.com"), JSON.stringify(csp));

  // net_probe, against a server in THIS process. The first pipe is an MCP tool call — no CSP, no
  // host — so the assertion has no business reaching the internet to prove it.
  const { createServer } = await import("node:http");
  const PAYLOAD = "practicality beats purity, and a test that needs the internet beats neither";
  const srv = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(PAYLOAD); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/zen`;
  const fn = await client.callTool({ name: "call_function", arguments: {
    command_id: "probe-fn-1", app: "host-csp-probe", function: "net_probe", args: { url } } });
  const sc = fn.structuredContent || {};
  ok("net_probe fetches from the ENGINE process — nothing declared, nothing for a host to honour",
    sc.ok === true && sc.result && sc.result.status === 200 && sc.result.ok === true, JSON.stringify(sc).slice(0, 300));
  ok("…and returns the first 40 characters, which is what its manifest promises a reader",
    sc.result && sc.result.text === PAYLOAD.slice(0, 40), JSON.stringify(sc.result));
  ok("…and it wrote nothing: a probe that fetches must not also mutate the store it reports into",
    Array.isArray(sc.writes) && sc.writes.length === 0, JSON.stringify(sc.writes));
  await new Promise((r) => srv.close(r));

  // The probe's last two cells (worker, wasm) measure something NO app can declare: the spec's
  // McpUiResourceCsp is four lists of domains, so there is no key for "I need a Worker" or "I need
  // WebAssembly". What an app gets is whatever the policy on its document happens to permit. These
  // two assertions state where OUR OWN floor stands today, so that the viewer reading the probe
  // takes is attributable rather than mysterious — and so that widening the floor is a deliberate
  // act that has to come here and say so.
  const anyCsp = { connectDomains: ["https://api.github.com"], resourceDomains: ["https://cdn.example.com"] };
  for (const [where, policy] of [["the runner child", runnerCspFor(anyCsp)], ["the viewer page", viewCspFor(anyCsp)]]) {
    ok(`${where} emits no worker-src, so a blob: Worker falls through to script-src and is refused`,
      !policy.includes("worker-src"), policy);
    ok(`${where} carries no 'wasm-unsafe-eval', so WebAssembly cannot compile there`,
      !policy.includes("wasm-unsafe-eval"), policy);
  }
}

await client.close();
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

console.log(`\ncsp-passthrough: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
