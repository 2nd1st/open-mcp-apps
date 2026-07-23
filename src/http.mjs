// http.mjs — the HTTP entry point. Same engine, same SQLite, three doors:
//
//   POST /mcp            Streamable HTTP MCP (stateless) — for ChatGPT Developer Mode /
//                        claude.ai custom connectors / any remote MCP host (via a tunnel).
//   POST /rpc            plain {name, arguments} -> CallToolResult — used by the browser
//                        viewer's standalone shell (no MCP host in a plain browser tab).
//   GET  /view/<name>    render a component in the browser (CLI-friendly: the AI works in
//                        the terminal, the human watches/edits the same data in a tab).
//   GET  /               index of components with /view links.
//
// Run: node src/http.mjs   (PORT=8787 by default)
// NOTE: anything that can reach this port can read/write the store — keep it local, and
// treat a tunnel URL as a secret while it's up.

import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openStore } from "./store.mjs";
import { createEngine, tierOf, RUNNER_REQUIRED_HTML } from "./engine.mjs";
import { wrapComponent } from "./shell.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const store = openStore(); // fixed per-user data dir (see store.mjs) — OMA_DB overrides

// ---- a resident in-process MCP client for /rpc (the browser viewer's backend) ----------
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const viewerEngine = createEngine(store, { hostLabel: "browser-viewer" });
await viewerEngine.connect(serverTransport);
const viewerClient = new Client({ name: "browser-viewer", version: "0.1.0" });
await viewerClient.connect(clientTransport);

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body)); };
const html = (res, code, body, headers) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers }).end(body); };

// /view CSP (docs/security-model.md §5 v0.2) — closes the browser viewer's network-egress gap
// (threat H): no host iframe CSP exists in a plain tab, so the response header is the boundary.
// Deviation from the doc's literal string, stated honestly: connect-src 'self' instead of 'none'.
// The doc's string was written for the runner srcdoc (no /rpc fetch exists there); /view serves
// the STANDALONE shell whose entire data path is fetch("/rpc") on this same origin — 'none'
// would kill the browser viewer outright. Everything else stays the doc's strict policy.
// frame-src 'none' is safe for settings' Library preview: about:srcdoc frames are exempt from
// frame-src and inherit this policy instead (verified in Chrome — the srcdoc child renders,
// its inline scripts/styles ride on 'unsafe-inline', and external egress stays blocked).
const VIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'; connect-src 'self'; frame-src 'none'";
const readBody = (req) => new Promise((resolve, reject) => {
  let data = "";
  req.on("data", (c) => { data += c; if (data.length > 2_000_000) { reject(new Error("body too large")); req.destroy(); } });
  req.on("end", () => resolve(data));
  req.on("error", reject);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    // ---- MCP over Streamable HTTP (stateless: a fresh engine per request; the tool list
    // is rebuilt from the live registry every time, so new components appear immediately) ----
    if (url.pathname === "/mcp") {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "null") : undefined;
      // Host label is REQUEST-SCOPED (no cross-client globals — stateless requests must not
      // inherit another client's identity). Priority: this request's own initialize
      // clientInfo → User-Agent product token → generic "remote-http". Provenance
      // annotation for the ledger, not a security property.
      let hostLabel = null;
      for (const msg of Array.isArray(body) ? body : body ? [body] : []) {
        if (msg && msg.method === "initialize" && msg.params?.clientInfo?.name) hostLabel = msg.params.clientInfo.name;
      }
      if (!hostLabel) {
        const ua = String(req.headers["user-agent"] || "").trim();
        hostLabel = ua ? "http:" + ua.split(/[\s/]/)[0].toLowerCase().slice(0, 32) : "remote-http";
      }
      const engine = createEngine(store, { hostLabel });
      await engine.connect(transport);
      await transport.handleRequest(req, res, body);
      res.on("close", () => { transport.close(); engine.close?.(); });
      return;
    }

    // ---- plain RPC for the standalone shell ----
    if (url.pathname === "/rpc" && req.method === "POST") {
      const { name, arguments: args } = JSON.parse((await readBody(req)) || "{}");
      if (!name) return json(res, 400, { isError: true, content: [{ type: "text", text: "name required" }] });
      const result = await viewerClient.callTool({ name, arguments: args || {} });
      return json(res, 200, result);
    }

    // ---- browser viewer ----
    const view = url.pathname.match(/^\/view\/([a-z][a-z0-9-]{0,31})$/);
    if (view && req.method === "GET") {
      const comp = store.getComponent(view[1]);
      if (!comp) return html(res, 404, `<h3>No component "${view[1]}"</h3>`);
      // Tier gate (docs/security-model.md §2.3): /view serves DIRECT mode — the real
      // window.oma, and this route's connect-src 'self' reaches /rpc. Non-local tiers fail
      // closed to the placeholder (no runner exists on this path yet); every component today
      // is local, so nothing changes until one isn't.
      if (tierOf(comp.author) !== "local")
        return html(res, 403, RUNNER_REQUIRED_HTML, { "content-security-policy": VIEW_CSP });
      const collection = url.searchParams.get("collection") || view[1];
      return html(res, 200, wrapComponent(comp.html, {
        standalone: { endpoint: "/rpc", collection, component: view[1] },
      }), { "content-security-policy": VIEW_CSP });
    }

    if (url.pathname === "/" && req.method === "GET") {
      const comps = store.listComponents();
      return html(res, 200, `<!DOCTYPE html><meta charset="utf-8"><title>open-mcp-apps</title>
<body style="font-family:system-ui;max-width:560px;margin:40px auto;color-scheme:light dark">
<h2>open-mcp-apps</h2><p>${comps.length} component(s) in the registry:</p>
<ul>${comps.map((c) => `<li><a href="/view/${c.name}">${c.name}</a> v${c.version} — ${c.description || ""}</li>`).join("")}</ul>
<p style="opacity:.6">MCP endpoint: <code>POST /mcp</code></p></body>`);
    }

    res.writeHead(404).end("not found");
  } catch (e) {
    console.error("[http]", req.method, url.pathname, e);
    if (!res.headersSent) json(res, 500, { isError: true, content: [{ type: "text", text: String(e && e.message || e) }] });
  }
});

// Bind to loopback ONLY. Both /rpc and /mcp are unauthenticated; a default (all-interfaces)
// bind would let anyone on the LAN read and write your data. Remote hosts (ChatGPT/claude.ai)
// reach /mcp through an OUTBOUND tunnel that connects to 127.0.0.1 locally, so restricting the
// listener to loopback costs nothing. (Data-layer exposure only — even so, the tool surface
// caps a caller to SQLite ops; see docs/security-model.md §1.5 Layer C.)
server.listen(PORT, "127.0.0.1", () => {
  console.log(`open-mcp-apps http listening on http://localhost:${PORT}`);
  console.log(`  browser viewer:  http://localhost:${PORT}/`);
  console.log(`  MCP endpoint:    http://localhost:${PORT}/mcp   (tunnel this for ChatGPT/claude.ai)`);
});
