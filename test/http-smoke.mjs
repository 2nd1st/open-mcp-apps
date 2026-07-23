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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "http-smoke.db");
const PORT = 8931;
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

{ // seed
  const store = openStore(DB);
  for (const file of readdirSync(join(ROOT, "components")).filter((f) => f.endsWith(".html"))) {
    store.execute({ type: "save_component", command_id: "seed-" + file, name: basename(file, ".html"),
      html: readFileSync(join(ROOT, "components", file), "utf-8"), actor: "seed" });
  }
  // a NON-local fixture (author not in {agent,human,seed}) — proves /view fails closed for it
  store.execute({ type: "save_component", command_id: "seed-nonlocal", name: "nonlocal-fixture",
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
  ok("tools served over HTTP", tools.some((t) => t.name === "open_component") && tools.some((t) => t.name === "data_add_item"));
  ok("per-component tools OFF by default (fewer permission prompts)", !tools.some((t) => t.name === "open_kanban"));
  const res = await client.readResource({ uri: "ui://open-mcp-apps/kanban.html" });
  ok("ui:// resource served over HTTP", res.contents[0].mimeType === "text/html;profile=mcp-app");
  const add = await client.callTool({ name: "data_add_item", arguments: { command_id: randomUUID(), collection: "kanban", group: "To Do", fields: { title: "from http" } } });
  ok("write over HTTP works", add.structuredContent.items.some((i) => i.fields.title === "from http"));
  ok("host label is request-scoped (UA fallback, no cross-client globals)", typeof add.structuredContent.host === "string" && (add.structuredContent.host.startsWith("http:") || add.structuredContent.host === "remote-http"));

  console.log("2. just-saved component opens immediately via the universal opener");
  const mkHtml = `<!DOCTYPE html><html><body><div id="x"></div><script type="module">oma.ready(s=>{document.getElementById("x").textContent=s.items.length});</script></body></html>`;
  await client.callTool({ name: "save_component", arguments: { name: "counter", html: mkHtml } });
  const client2 = new Client({ name: "second-host", version: "1.0.0" });
  await client2.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  const openCounter = await client2.callTool({ name: "open_component", arguments: { component: "counter" } });
  ok("fresh connection opens the new component with zero waiting", openCounter.structuredContent?.component === "counter");
  ok("no per-component tool appeared (default off)", !(await client2.listTools()).tools.some((t) => t.name === "open_counter"));

  console.log("3. /rpc — the standalone shell backend");
  const rpc = await fetch(`${BASE}/rpc`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "data_list", arguments: { collection: "kanban" } }) });
  const rpcResult = await rpc.json();
  ok("rpc returns a CallToolResult", Array.isArray(rpcResult.content) && rpcResult.structuredContent.collection === "kanban");
  ok("rpc identifies as browser-viewer", rpcResult.structuredContent.host === "browser-viewer");

  console.log("4. /view — browser viewer page");
  const viewResp = await fetch(`${BASE}/view/kanban`);
  const page = await viewResp.text();
  // security-model §5 v0.2: /view is CSP-locked at the response header; connect-src 'self' is
  // the documented deviation (the standalone shell's whole data path is fetch("/rpc") same-origin)
  const viewCsp = viewResp.headers.get("content-security-policy") || "";
  ok("/view carries the CSP header (default/frame 'none', connect-src 'self')",
    viewCsp.includes("default-src 'none'") && viewCsp.includes("connect-src 'self'") && viewCsp.includes("frame-src 'none'"));
  ok("standalone config injected before runtime", page.indexOf('data-oma="standalone"') < page.indexOf('data-oma="runtime"') && page.includes("__OMA_STANDALONE__"));
  ok("component + shell both present", page.includes('id="board"') && page.includes("window.oma"));
  const idx = await (await fetch(`${BASE}/`)).text();
  ok("index lists components", idx.includes("/view/kanban") && idx.includes("/view/counter"));
  const missing = await fetch(`${BASE}/view/nope`);
  ok("unknown component 404s", missing.status === 404);
  // security-model §2.3: a non-local component must NOT render with full trust on the /view path —
  // it fails closed (403 + a shell-free placeholder, no window.oma) until runner mode exists there.
  const nonlocalResp = await fetch(`${BASE}/view/nonlocal-fixture`);
  const nonlocalPage = await nonlocalResp.text();
  ok("/view fails closed for a non-local component (403, no shell)",
    nonlocalResp.status === 403 && !nonlocalPage.includes("window.oma") && !nonlocalPage.includes("id='x'") && (nonlocalResp.headers.get("content-security-policy") || "").includes("default-src 'none'"));

  console.log("5. host identity reaches the ledger");
  const db = new Database(DB, { readonly: true });
  const hosts = db.prepare("SELECT DISTINCT host FROM change_event WHERE host IS NOT NULL ORDER BY host").all().map((r) => r.host);
  db.close();
  ok("ledger recorded a request-scoped http host label", hosts.some((h) => h.startsWith("http:") || h === "remote-http"));

  await client.close(); await client2.close();
} finally {
  proc.kill();
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);
}
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
