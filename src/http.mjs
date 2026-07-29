// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// http.mjs — the HTTP entry point. Same engine, same SQLite, three doors:
//
//   POST /mcp            Streamable HTTP MCP (stateless) — for ChatGPT Developer Mode /
//                        claude.ai custom connectors / any remote MCP host (via a tunnel).
//   POST /rpc            plain {name, arguments} -> CallToolResult — used by the browser
//                        viewer's standalone shell (no MCP host in a plain browser tab).
//   GET  /view/<name>    render an app in the browser (CLI-friendly: the AI works in
//                        the terminal, the human watches/edits the same data in a tab).
//   GET  /               index of apps with /view links.
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
import { createEngine, tierOf, defaultCollectionFor } from "./engine.mjs";
import { wrapApp, wrapLoader } from "./shell.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const store = openStore(); // fixed per-user data dir (see store.mjs) — OMA_DB overrides

// ---- a resident in-process MCP client for /rpc (the browser viewer's backend) ----------
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
// Every app link handed to the model is built from this. A process cannot discover the address
// the outside world reaches it by: put this server behind a tunnel or a reverse proxy — which is
// exactly how it gets connected to a hosted chat — and the loopback URL it prints is dead for the
// only reader that matters. So it is loopback by DEFAULT (right for the local case) and overridable
// by the operator who does know. Trailing slashes are trimmed where it is used.
const VIEW_BASE = process.env.OMA_VIEW_BASE || `http://127.0.0.1:${PORT}`;
const viewerEngine = createEngine(store, { hostLabel: "browser-viewer", viewBase: VIEW_BASE });
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

// Origin validation (MCP transports spec, MUST): a web page that DNS-rebinds its domain to
// 127.0.0.1 can POST here same-origin — and /rpc is the full unauthenticated tool surface.
// Such requests carry the attacker page's Origin; everything legitimate carries either none
// (curl, MCP clients, tunnel ingress), a loopback origin (the standalone shell's own fetches,
// any port — local pages are not the rebinding threat), or the origin the operator already
// declared via OMA_VIEW_BASE (the shell served THROUGH a tunnel fetches /rpc with the tunnel's
// Origin — refusing it would kill the tunneled browser viewer). Anything else → 403.
// The hosted deployment is out of scope here: its Origin/CSRF story belongs to the BFF
// (see docs/spec-conformance.md).
const originAllowed = (origin) => {
  if (!origin) return true;
  let o;
  try { o = new URL(origin); } catch { return false; } // includes Origin: null
  if (o.hostname === "localhost" || o.hostname === "127.0.0.1" || o.hostname === "[::1]") return true;
  if (process.env.OMA_VIEW_BASE) {
    try { if (o.origin === new URL(process.env.OMA_VIEW_BASE).origin) return true; } catch {}
  }
  return false;
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (!originAllowed(req.headers.origin)) {
      return json(res, 403, { isError: true, content: [{ type: "text", text: "forbidden origin" }] });
    }
    // ---- MCP over Streamable HTTP (stateless: a fresh engine per request; the tool list
    // is rebuilt from the live registry every time, so new apps appear immediately) ----
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
      const engine = createEngine(store, { hostLabel, viewBase: VIEW_BASE });
      await engine.connect(transport);
      await transport.handleRequest(req, res, body);
      res.on("close", () => { transport.close(); engine.close?.(); });
      return;
    }

    // ---- plain RPC for the standalone shell ----
    if (url.pathname === "/rpc" && req.method === "POST") {
      const { name, arguments: args } = JSON.parse((await readBody(req)) || "{}");
      if (!name) return json(res, 400, { isError: true, content: [{ type: "text", text: "name required" }] });
      // Internal `_` methods (write-set D): the Data pane's non-tool verbs — undo and the
      // via-bearing ledger view. Deliberately NOT MCP tools (the ledger stays off the AI face,
      // §9-4: "undo = a store verb + a Data pane entry, not a tool"), so they exist only on
      // this browser-session transport; the runner denies the `_` prefix to sandboxed children.
      if (name === "_undo_last") {
        const a = args || {};
        const r = store.undoLast(String(a.target || ""), a.expected_seq != null ? { expectedSeq: a.expected_seq } : {});
        return json(res, 200, {
          content: [{ type: "text", text: r.ok ? "undone" : r.error === "stale_undo" ? "That entry changed since you looked — reload." : String(r.error || "failed") }],
          structuredContent: r, ...(r.ok ? {} : { isError: true }),
        });
      }
      if (name === "_ledger_recent") {
        const a = args || {};
        const events = store.recentEvents({ collection: a.collection, limit: a.limit });
        return json(res, 200, { content: [{ type: "text", text: `${events.length} event(s)` }], structuredContent: { events } });
      }
      if (name.startsWith("_")) {
        return json(res, 200, { isError: true, content: [{ type: "text", text: `unknown internal method "${name}"` }] });
      }
      const result = await viewerClient.callTool({ name, arguments: args || {} });
      return json(res, 200, result);
    }

    // ---- SSE change feed (fable A2 tier 2): pushes the global ledger seq the moment anything
    // commits IN THIS PROCESS (store.events), plus a cheap 2s cross-process fallback probe —
    // another process sharing the db (a chat host's stdio server) can't reach our emitter, so
    // the probe closes that gap at seq-poll cost. Clients (standalone shell, dashboard) refetch
    // on any seq they haven't seen; the adaptive widget poll remains the transport of last resort.
    if (url.pathname === "/events" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      });
      res.write("retry: 3000\n\n");
      let lastSeq = store.dataVersion().seq;
      const send = (seq) => { try { res.write(`data: ${JSON.stringify({ seq })}\n\n`); } catch {} };
      send(lastSeq);
      const onChange = (ev) => { if (ev.seq !== lastSeq) { lastSeq = ev.seq; send(lastSeq); } };
      store.events.on("change", onChange);
      const probe = setInterval(() => {
        try { const s = store.dataVersion().seq; if (s !== lastSeq) { lastSeq = s; send(s); } } catch {}
      }, 2000);
      const beat = setInterval(() => { try { res.write(":hb\n\n"); } catch {} }, 25000);
      req.on("close", () => { store.events.off("change", onChange); clearInterval(probe); clearInterval(beat); });
      return; // response stays open — the SSE stream owns it from here
    }

    // ---- browser viewer ----
    const view = url.pathname.match(/^\/view\/([a-z][a-z0-9-]{0,31})$/);
    if (view && req.method === "GET") {
      const comp = store.getApp(view[1]);
      if (!comp) return html(res, 404, `<h3>No app "${view[1]}"</h3>`);
      // Same binding rule the open_app tool uses — one answer to "what does this app open on".
      const collection = url.searchParams.get("collection") || defaultCollectionFor(comp);
      // Tier branch (docs/security-model.md §2.3). DIRECT mode — the real window.oma, and this
      // route's connect-src 'self' reaches /rpc — is for local apps only. A non-local one
      // gets the universal loader instead, which reads app_html over /rpc, sees the tier and
      // hands the source to oma.embed → the runner, with engine-computed caps. Before this branch
      // the route fail-closed to a placeholder, which was correct while non-local apps could
      // not exist; the local install door (install-app.mjs --sandboxed) is what made them exist,
      // and an app you cannot open in the viewer is an app you cannot develop against.
      //
      // No CSP change: about:srcdoc frames are exempt from frame-src and inherit this policy, so
      // the runner's child renders under the same wall the direct path uses (see VIEW_CSP above —
      // settings' Library preview has relied on exactly this since it shipped).
      if (tierOf(comp.author) !== "local")
        return html(res, 200, wrapLoader({
          standalone: { endpoint: "/rpc", collection, app: view[1],
            ...(process.env.OMA_VIEW_BASE ? { viewBase: VIEW_BASE.replace(/\/+$/, "") + "/view/" } : {}) },
        }), { "content-security-policy": VIEW_CSP });
      return html(res, 200, wrapApp(comp.html, {
        // viewBase reaches the RUNTIME only when the operator set one. App→app links
        // default to a relative "/view/", which is correct for a plain local server and wrong behind
        // a path-prefixed proxy — where OMA_VIEW_BASE is exactly the operator saying what the prefix
        // is. Passing it unconditionally would turn every in-app link absolute (127.0.0.1), which
        // silently breaks the ordinary `localhost:PORT` visit: different origin, same server.
        standalone: { endpoint: "/rpc", collection, app: view[1], ...(process.env.OMA_VIEW_BASE ? { viewBase: VIEW_BASE.replace(/\/+$/, "") + "/view/" } : {}) },
        version: comp.version,   // render-health identity (auto-revert reports)
      }), { "content-security-policy": VIEW_CSP });
    }

    if (url.pathname === "/" && req.method === "GET") {
      const comps = store.listApps();
      const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const SYSTEM_ORDER = ["dashboard", "library", "settings"];
      const system = SYSTEM_ORDER.map((n) => comps.find((c) => c.name === n)).filter(Boolean);
      const apps = comps.filter((c) => !SYSTEM_ORDER.includes(c.name));
      const sysIcon = { dashboard: "M3 3h7v7H3zM12 3h7v4h-7zM12 9h7v10h-7zM3 12h7v8H3z", library: "M4 5h16v14H4zM4 15l4-4 3 3 5-5 4 4", settings: "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 12h2m12 0h2M12 4v2m0 12v2" };
      const card = (c, big) => `<a class="card${big ? " big" : ""}" href="/view/${esc(c.name)}">
        ${big ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${sysIcon[c.name] || sysIcon.dashboard}"/></svg>` : ""}
        <span class="n">${esc(c.name)}</span><span class="v">v${c.version}</span>
        <span class="d">${esc(c.description || (c.author === "library" ? "library app" : "app"))}</span></a>`;
      return html(res, 200, `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>open-mcp-apps</title><style>
  :root{color-scheme:light dark}
  body{margin:0;padding:48px 20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:Canvas;color:CanvasText}
  .wrap{max-width:880px;margin:0 auto}
  h1{margin:0;font-size:26px;letter-spacing:-.03em}
  .sub{margin:6px 0 26px;color:color-mix(in srgb,CanvasText 55%,Canvas);font-size:14px}
  h2{margin:26px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:color-mix(in srgb,CanvasText 45%,Canvas)}
  .grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
  .card{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:4px 10px;padding:14px 16px;border:1px solid color-mix(in srgb,CanvasText 14%,Canvas);border-radius:14px;text-decoration:none;color:inherit;background:color-mix(in srgb,CanvasText 3%,Canvas);transition:border-color .15s,transform .15s,box-shadow .15s}
  .card:hover{transform:translateY(-1px);border-color:color-mix(in srgb,#3b6cf6 45%,Canvas);box-shadow:0 6px 22px color-mix(in srgb,CanvasText 10%,transparent)}
  .card svg{width:26px;height:26px;grid-row:span 2;color:#3b6cf6}
  .card .n{font-weight:650}
  .card .v{font-size:11.5px;color:color-mix(in srgb,CanvasText 40%,Canvas);font-variant-numeric:tabular-nums}
  .card .d{grid-column:2/4;font-size:12.5px;color:color-mix(in srgb,CanvasText 55%,Canvas);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .card.big{background:linear-gradient(135deg,color-mix(in srgb,#3b6cf6 9%,Canvas),color-mix(in srgb,CanvasText 3%,Canvas))}
  .empty{padding:28px;border:1px dashed color-mix(in srgb,CanvasText 20%,Canvas);border-radius:14px;color:color-mix(in srgb,CanvasText 55%,Canvas);font-size:14px}
  .foot{margin-top:34px;font-size:12.5px;color:color-mix(in srgb,CanvasText 42%,Canvas)}
  code{font-family:ui-monospace,Menlo,monospace;background:color-mix(in srgb,CanvasText 7%,Canvas);padding:1px 6px;border-radius:6px}
</style></head><body><div class="wrap">
  <h1>open-mcp-apps</h1>
  <p class="sub">Your apps and their data, rendered in the browser — the same store your AI edits in chat.</p>
  ${system.length ? `<h2>System</h2><div class="grid">${system.map((c) => card(c, true)).join("")}</div>` : ""}
  <h2>Apps · ${apps.length}</h2>
  ${apps.length ? `<div class="grid">${apps.map((c) => card(c, false)).join("")}</div>`
    : `<div class="empty">No apps yet. Ask your AI in chat to build one — or open the <a href="/view/library">library</a> and install a ready-made app.</div>`}
  <p class="foot">MCP endpoint: <code>POST /mcp</code> · store: shared with every chat host on this machine</p>
</div></body></html>`);
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
