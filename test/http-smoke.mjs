// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/http-smoke.mjs — proves the HTTP entry: /mcp (real Streamable HTTP MCP client),
// /rpc (standalone shell backend), /view (browser viewer), and host identification
// (clientInfo.name → ledger host column). Run: node test/http-smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import Database from "better-sqlite3";
import { openStore } from "../src/store.mjs";
import { wrapApp } from "../src/shell.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "http-smoke.db");
// High default so a dev server on the classic 89xx range can't wedge the suite; override to
// taste with OMA_TEST_PORT (the fixture also binds PORT+1).
const PORT = Number(process.env.OMA_TEST_PORT) || 18931;
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

{ // seed
  const store = openStore(DB);
  for (const file of readdirSync(join(ROOT, "components")).filter((f) => f.endsWith(".html"))) {
    store.execute({ type: "save_app", command_id: "seed-" + file, name: basename(file, ".html"),
      html: readFileSync(join(ROOT, "components", file), "utf-8"), actor: "seed" });
  }
  // a NON-local fixture (author not in {agent,human,seed}) — proves /view fails closed for it
  store.execute({ type: "save_app", command_id: "seed-nonlocal", name: "nonlocal-fixture",
    html: "<!DOCTYPE html><html><body><div id='x'>nonlocal</div></body></html>", actor: "library-test" });
  store.close();
}

let pass = 0, fail = 0;
const ok = (name, cond) => (cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name)));

const proc = spawn("node", [join(ROOT, "src", "http.mjs")], {
  env: { ...process.env, OMA_DB: DB, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("server didn't start")), 8000);
  proc.stdout.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(t); resolve(); } });
  proc.on("exit", () => reject(new Error("server exited early")));
});

try {
  const BASE = `http://127.0.0.1:${PORT}`;

  console.log("1. /mcp — a real Streamable HTTP MCP client");
  const client = new Client({ name: "http-smoke-host", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  const { tools } = await client.listTools();
  ok("tools served over HTTP", tools.some((t) => t.name === "open_app") && tools.some((t) => t.name === "data_add_item"));
  ok("per-app tools OFF by default (fewer permission prompts)", !tools.some((t) => t.name === "open_habit_streaks"));
  const res = await client.readResource({ uri: "ui://open-mcp-apps/habit-streaks.html" });
  ok("ui:// resource served over HTTP", res.contents[0].mimeType === "text/html;profile=mcp-app");
  const add = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "kanban", group: "To Do", fields: { title: "from http" } } });
  ok("write over HTTP works", add.structuredContent.item.fields.title === "from http");
  // The host label's home is the LEDGER (each event is attributed to the host that wrote it) —
  // pages stopped carrying an ambient `host` key with the envelope rewrite. The invariant is the
  // same one: derived per request, never a module global shared between clients.
  const chg = await client.callTool({ name: "data_changes", arguments: { collection: "kanban", since: add.structuredContent.seq - 1 } });
  const evHost = chg.structuredContent.events[0]?.host;
  ok("host label is request-scoped (UA fallback, no cross-client globals) — attributed on the event",
    typeof evHost === "string" && (evHost.startsWith("http:") || evHost === "remote-http"));

  console.log("2. just-saved app opens immediately via the universal opener");
  const mkHtml = `<!DOCTYPE html><html><body><div id="x"></div><script type="module">oma.ready(s=>{document.getElementById("x").textContent=s.items.length});</script></body></html>`;
  await client.callTool({ name: "save_app", arguments: { name: "counter", html: mkHtml } });
  const client2 = new Client({ name: "second-host", version: "1.0.0" });
  await client2.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  const openCounter = await client2.callTool({ name: "open_app", arguments: { app: "counter" } });
  ok("fresh connection opens the new app with zero waiting", openCounter.structuredContent?.app === "counter");
  ok("no per-app tool appeared (default off)", !(await client2.listTools()).tools.some((t) => t.name === "open_counter"));

  console.log("3. /rpc — the standalone shell backend");
  const rpc = await fetch(`${BASE}/rpc`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "data_list", arguments: { collection: "kanban" } }) });
  const rpcResult = await rpc.json();
  ok("rpc returns a CallToolResult", Array.isArray(rpcResult.content) && rpcResult.structuredContent.collection === "kanban");
  // The viewer's identity shows where identities live now: on the events its writes produce.
  const rpcWrite = await fetch(`${BASE}/rpc`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "kanban", fields: { title: "from the viewer" } } }) });
  const rpcAck = await rpcWrite.json();
  const rpcChg = await client.callTool({ name: "data_changes", arguments: { collection: "kanban", since: rpcAck.structuredContent.seq - 1 } });
  ok("rpc identifies as browser-viewer — on the event it wrote", rpcChg.structuredContent.events[0]?.host === "browser-viewer");

  console.log("4. /view — browser viewer page");
  const viewResp = await fetch(`${BASE}/view/dashboard`);
  const page = await viewResp.text();
  // security-model §5 v0.2: /view is CSP-locked at the response header; connect-src 'self' is
  // the documented deviation (the standalone shell's whole data path is fetch("/rpc") same-origin)
  const viewCsp = viewResp.headers.get("content-security-policy") || "";
  ok("/view carries the CSP header (default/frame 'none', connect-src 'self')",
    viewCsp.includes("default-src 'none'") && viewCsp.includes("connect-src 'self'") && viewCsp.includes("frame-src 'none'"));
  ok("standalone config injected before runtime", page.indexOf('data-oma="standalone"') < page.indexOf('data-oma="runtime"') && page.includes("__OMA_STANDALONE__"));
  ok("app + shell both present", page.includes('id="grid"') && page.includes("window.oma"));
  const idx = await (await fetch(`${BASE}/`)).text();
  ok("index lists apps", idx.includes("/view/dashboard") && idx.includes("/view/counter"));
  const missing = await fetch(`${BASE}/view/nope`);
  ok("unknown app 404s", missing.status === 404);
  // security-model §2.3: a non-local app must NOT render with full trust on /view. It used to
  // fail closed to a placeholder because this route had no runner; now it serves the UNIVERSAL
  // LOADER, which reads app_html over /rpc, sees the tier, and hands the source to the runner
  // (verified live in Chrome: the child mounts in an about:srcdoc frame with sandbox="allow-scripts",
  // its typed writes land through the bridge, and oma.callTool comes back "not allowed").
  //
  // The property under test is unchanged and is the one that matters: THE SOURCE IS NOT IN THIS
  // DOCUMENT. Direct mode inlines an app's markup beside the real window.oma; the loader
  // delivers neither — the html arrives later, over /rpc, into a sandboxed child. So the assertion
  // is not "no window.oma anywhere" (the loader legitimately ships the runtime that owns embed) but
  // "this app's markup never reached a full-trust document".
  const nonlocalResp = await fetch(`${BASE}/view/nonlocal-fixture`);
  const nonlocalPage = await nonlocalResp.text();
  ok("/view serves the loader for a non-local app, never its source",
    nonlocalResp.status === 200 && !nonlocalPage.includes("id='x'") && !nonlocalPage.includes("nonlocal</div>")
    && nonlocalPage.includes('data-oma="loader"') && nonlocalPage.includes("Loading app"));
  ok("...with the standalone config, before the runtime, so the loader can reach /rpc",
    nonlocalPage.includes("__OMA_STANDALONE__") && nonlocalPage.includes('"app":"nonlocal-fixture"')
    && nonlocalPage.indexOf('data-oma="standalone"') < nonlocalPage.indexOf('data-oma="runtime"'));
  ok("...under the same CSP as direct mode (srcdoc children are exempt from frame-src)",
    (nonlocalResp.headers.get("content-security-policy") || "").includes("default-src 'none'"));
  // A LOCAL app must still take the direct path — the loader is the exception, not the rule,
  // and a regression that routed everything through it would cost every app an extra round trip.
  ok("...while a local app still mounts directly (source inlined, no loader)",
    page.includes('id="grid"') && !page.includes('data-oma="loader"'));
  // JSON-in-script hardening: ?collection= is caller-controlled and lands inside an inline
  // <script> via wrapApp — "</script>" in it must never terminate the tag (XSS class).
  const evil = "</script><img src=x onerror=alert(1)>";
  const evilPage = await (await fetch(`${BASE}/view/dashboard?collection=${encodeURIComponent(evil)}`)).text();
  ok("standalone JSON escapes < (no </script> break-out from ?collection=)",
    !evilPage.includes(evil) && evilPage.includes("\\u003c/script>"));
  // Embedder contract (hosted shell): endpoint/events proxy paths + chrome:false ride
  // opts.standalone verbatim, and the runtime consumes them (EventSource path + bare-widget gate).
  const embedded = wrapApp("<div id='w'></div>", {
    standalone: { endpoint: "/app/api/rpc", events: "/app/api/events", collection: "t", app: "t", chrome: false },
  });
  ok("wrapApp carries endpoint/events/chrome for an embedding shell",
    embedded.includes('"endpoint":"/app/api/rpc"') && embedded.includes('"events":"/app/api/events"') && embedded.includes('"chrome":false'));
  const runtimeSrc = readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf-8");
  ok("runtime honors SA.events and SA.chrome (invariant)",
    runtimeSrc.includes('SA.events || "/events"') && runtimeSrc.includes("SA.chrome !== false"));

  console.log("5. host identity reaches the ledger");
  const db = new Database(DB, { readonly: true });
  const hosts = db.prepare("SELECT DISTINCT host FROM change_event WHERE host IS NOT NULL ORDER BY host").all().map((r) => r.host);
  db.close();
  ok("ledger recorded a request-scoped http host label", hosts.some((h) => h.startsWith("http:") || h === "remote-http"));

  console.log("6. SSE /events — a streaming fetch sees the seq move after a write");
  {
    const ctl = new AbortController();
    const killer = setTimeout(() => ctl.abort(), 12_000); // hard stop — the suite must never hang on the stream
    const seqs = [];
    try {
      const evRes = await fetch(`${BASE}/events`, { signal: ctl.signal });
      ok("/events answers as text/event-stream", evRes.ok && (evRes.headers.get("content-type") || "").includes("text/event-stream"));
      // Node 18+ fetch stream: pump the body in the background, harvest complete "data:" lines.
      const reader = evRes.body.getReader();
      const dec = new TextDecoder();
      const pump = (async () => {
        let buf = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop(); // keep the trailing partial line
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              try { const o = JSON.parse(line.slice(5).trim()); if (typeof o.seq === "number") seqs.push(o.seq); } catch {}
            }
          }
        } catch {} // aborting the controller lands here — expected teardown
      })();
      const waitSeqs = async (n, ms) => { const dl = Date.now() + ms; while (seqs.length < n && Date.now() < dl) await new Promise((r) => setTimeout(r, 25)); return seqs.length >= n; };
      const gotFirst = await waitSeqs(1, 4000);
      ok("first event arrives with a numeric seq", gotFirst && typeof seqs[0] === "number");
      const firstSeq = seqs[0] ?? -1;
      await fetch(`${BASE}/rpc`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "kanban", group: "To Do", fields: { title: "sse ping" } } }) });
      const gotNext = await waitSeqs(2, 4000);
      ok("a further event with a strictly higher seq arrives after the write", gotNext && seqs[seqs.length - 1] > firstSeq);
      ctl.abort();
      await pump;
    } catch (e) {
      ok(`SSE flow completed without throwing (got: ${(e && e.message) || e})`, false);
      ctl.abort();
    } finally {
      clearTimeout(killer);
    }
  }

  console.log("7. chunked upload lifecycle ACROSS stateless /mcp requests (memoized per-store channel)");
  // /mcp builds a FRESH engine per request; before the per-store channel memoization the upload
  // begun in request 1 was invisible to request 2 (empty uploads Map) and chunked upload was
  // 100% dead on exactly the remote-host transport. Each callTool below is its own HTTP request.
  {
    const b = await client.callTool({ name: "file_write_begin", arguments: { app: "httpchunk" } });
    ok("begin over /mcp returns an upload_id", !b.isError && typeof b.structuredContent?.upload_id === "string");
    const uid = b.structuredContent.upload_id;
    const c1 = await client.callTool({ name: "file_write_chunk", arguments: { upload_id: uid, data_base64: Buffer.from("hello ").toString("base64") } });
    ok("chunk in a SECOND stateless request finds the same upload", !c1.isError && c1.structuredContent?.bytes === 6);
    await client.callTool({ name: "file_write_chunk", arguments: { upload_id: uid, data_base64: Buffer.from("remote").toString("base64") } });
    const cm = await client.callTool({ name: "file_write_commit", arguments: { upload_id: uid, path: "over-mcp.txt", mime: "text/plain" } });
    ok("commit in a THIRD request lands the file", !cm.isError && cm.structuredContent?.size === 12);
    const rd = await client.callTool({ name: "file_read", arguments: { app: "httpchunk", path: "over-mcp.txt" } });
    ok("file reads back intact over /mcp", !rd.isError && Buffer.from(rd.structuredContent.data_base64, "base64").toString() === "hello remote");
  }

  console.log("8. internal `_` RPC — the Data pane's non-tool verbs (write-set D)");
  // undo and the via-bearing ledger view exist ONLY on /rpc: never registered as MCP tools
  // (the ledger stays off the AI face), denied to sandboxed children by the `_` prefix rule.
  {
    const post = async (name, args) => (await fetch(`${BASE}/rpc`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, arguments: args }) })).json();
    const w = await post("data_add_item", { command_id: "via-http-1", collection: "panecoll", fields: { t: "x" }, actor: "human", via: { app: "pane-app" } });
    ok("a via-stamped write transits /rpc (passthrough end to end)", w.structuredContent?.ok === true);
    const led = await post("_ledger_recent", { collection: "panecoll", limit: 10 });
    const ev = led.structuredContent?.events?.[0];
    ok("_ledger_recent serves the shadow edge + the undoable mark", !!ev && ev.via?.app === "pane-app" && ev.undoable === true);
    const ch = await post("data_changes", { collection: "panecoll", since: 0 });
    ok("data_changes (the AI face) strips via on the SAME event", ch.structuredContent.events.length > 0 && ch.structuredContent.events.every((e) => !("via" in e)));
    const un = await post("_undo_last", { target: ev.id });
    ok("_undo_last reverses the aggregate's last event", un.structuredContent?.ok === true && un.structuredContent.deleted === true);
    const bad = await post("_nonexistent", {});
    ok("an unknown internal method answers isError, never falls through to tool dispatch", bad.isError === true);
    const viaMcp = await client.callTool({ name: "_undo_last", arguments: { target: "x" } });
    ok("internal methods are NOT MCP tools — /mcp refuses them as unknown", viaMcp.isError === true && /not found|unknown/i.test(viaMcp.content?.[0]?.text || ""));
  }

  console.log("9. Origin validation — the DNS-rebinding door (MCP transports MUST)");
  // Threat: a web page rebinds its domain to 127.0.0.1 and POSTs to /rpc (full unauthenticated
  // tool surface) or /mcp. Such requests arrive with the attacker page's Origin. Policy:
  // no Origin → allow (curl, MCP clients, tunnel ingress send none); localhost/127.0.0.1 any
  // port → allow (the standalone shell's own fetches); OMA_VIEW_BASE's origin → allow (the
  // shell served through a tunnel fetches /rpc with the tunnel's Origin); anything else → 403.
  {
    const rpcBody = JSON.stringify({ name: "data_list", arguments: { collection: "kanban" } });
    const post = (path, origin, body = rpcBody) => fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}),
        ...(path === "/mcp" ? { accept: "application/json, text/event-stream" } : {}) },
      body,
    });
    const mcpBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const evilRpc = await post("/rpc", "http://evil.example");
    ok("/rpc 403s a foreign Origin (rebinding attack blocked)", evilRpc.status === 403);
    const evilMcp = await post("/mcp", "http://evil.example", mcpBody);
    ok("/mcp 403s a foreign Origin", evilMcp.status === 403);
    const nullOrigin = await post("/rpc", "null");
    ok("/rpc 403s Origin: null (sandboxed foreign frames)", nullOrigin.status === 403);
    const noOrigin = await post("/rpc", null);
    ok("/rpc still serves Origin-less callers (curl/MCP clients)", noOrigin.status === 200 && (await noOrigin.json()).structuredContent.collection === "kanban");
    const selfOrigin = await post("/rpc", `http://localhost:${PORT}`);
    ok("/rpc serves its own localhost origin (standalone shell)", selfOrigin.status === 200);
    const loopbackOtherPort = await post("/rpc", "http://127.0.0.1:3000");
    ok("/rpc serves 127.0.0.1 on any port (local pages are not the rebinding threat)", loopbackOtherPort.status === 200);
    const evilView = await fetch(`${BASE}/view/dashboard`, { headers: { origin: "http://evil.example" } });
    ok("a foreign-Origin GET is refused too (no cross-origin reads of app source)", evilView.status === 403);
  }

  console.log("10. Origin validation behind a tunnel — OMA_VIEW_BASE's origin is allowed");
  // The survey's three-way policy alone would break the tunneled browser viewer: the /view page
  // served through the tunnel fetches /rpc with the TUNNEL's Origin. OMA_VIEW_BASE is already
  // the operator declaring that address; its origin must pass.
  {
    const PORT2 = PORT + 1;
    const proc2 = spawn("node", [join(ROOT, "src", "http.mjs")], {
      env: { ...process.env, OMA_DB: DB, PORT: String(PORT2), OMA_VIEW_BASE: "https://tunnel-fixture.example/oma" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("tunnel-config server didn't start")), 8000);
        proc2.stdout.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(t); resolve(); } });
        proc2.on("exit", () => reject(new Error("tunnel-config server exited early")));
      });
      const post2 = (origin) => fetch(`http://127.0.0.1:${PORT2}/rpc`, {
        method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify({ name: "data_list", arguments: { collection: "kanban" } }),
      });
      const tunnelOk = await post2("https://tunnel-fixture.example");
      ok("the OMA_VIEW_BASE origin passes (tunneled viewer keeps working)", tunnelOk.status === 200);
      const stillEvil = await post2("http://evil.example");
      ok("a foreign Origin still 403s with OMA_VIEW_BASE set", stillEvil.status === 403);
    } finally {
      proc2.kill();
    }
  }

  await client.close(); await client2.close();
} finally {
  proc.kill();
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);
}
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
