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
import { dirname, join, resolve as resolvePath } from "node:path";
import { openStore } from "./store.mjs";
import { createEngine, tierOf, defaultCollectionFor } from "./engine.mjs";
import { wrapApp, wrapLoader } from "./shell.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ONE viewer per process. These are assigned by startViewer() rather than at import time, because
// the embedded case (src/server.mjs) MUST hand us ITS store: two openStore() handles in one
// process would be two file channels, and a chunked upload begun on one would be invisible to the
// other (see the memoization note above openFileChannel in engine.mjs). Importing this module
// therefore has to be free of side effects — nothing binds, nothing opens, until asked.
let store = null;
let PORT = Number(process.env.PORT || 8787);
// Every app link handed to the model is built from this. A process cannot discover the address
// the outside world reaches it by: put this server behind a tunnel or a reverse proxy — which is
// exactly how it gets connected to a hosted chat — and the loopback URL it prints is dead for the
// only reader that matters. So it is loopback by DEFAULT (right for the local case) and overridable
// by the operator who does know. Trailing slashes are trimmed where it is used.
let VIEW_BASE = null;
let viewerClient = null;
let started = null;

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
// (curl, MCP clients, tunnel ingress), THIS viewer's own loopback origin, or the origin the
// operator already declared via OMA_VIEW_BASE (the shell served THROUGH a tunnel fetches /rpc
// with the tunnel's Origin — refusing it would kill the tunneled browser viewer).
// Anything else → 403. The hosted deployment is out of scope here: its Origin/CSRF story
// belongs to the BFF (see docs/spec-conformance.md).
//
// 🔴 2026-07-31 — this used to read "a loopback origin, ANY PORT — local pages are not the
// rebinding threat", and that sentence was wrong in a way that cost us the whole tool surface.
// Measured, not theorised: a page on http://localhost:3000 POSTing here with
// `Content-Type: text/plain` (a CORS *simple request*, so no preflight the browser could fail)
// got 200 and its write landed. The premise behind the old sentence was "anything that can
// reach this port is a local process, and a local process can just read the SQLite file" —
// A WEB PAGE IS NOT A LOCAL PROCESS. It cannot read the file, but it can absolutely reach the
// port, and every dev server, docs site and localhost app the user has open is such a page.
//
// Two independent locks now, deliberately (either alone would close today's exploit; the pair
// survives one of them being wrong):
//   1. HERE — the loopback allowance is narrowed to OUR OWN PORT, not any port. Every loopback
//      spelling still passes (localhost / 127.0.0.1 / [::1] are the same server, and pinning the
//      spelling would break the ordinary `localhost:PORT` visit — see the note at the /view
//      route), but a different port is a different application and gets no say here.
//   2. requireBrowserWriteHeader() below — a custom request header on browser-initiated writes,
//      which no simple request can set. That one does not depend on this function parsing
//      Origin correctly at all.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const portOf = (u) => u.port || (u.protocol === "https:" ? "443" : "80");
const originAllowed = (origin) => {
  if (!origin) return true;
  let o;
  try { o = new URL(origin); } catch { return false; } // includes Origin: null
  if (LOOPBACK_HOSTS.has(o.hostname) && portOf(o) === String(PORT)) return true;
  if (process.env.OMA_VIEW_BASE) {
    try { if (o.origin === new URL(process.env.OMA_VIEW_BASE).origin) return true; } catch {}
  }
  return false;
};

// Lock 2: force a CORS preflight on anything a browser initiates against the tool surface.
//
// The exploit that got in was a *simple request* — the browser sends it without asking us first,
// so no CORS decision of ours is ever consulted; we only see it after it has already arrived, and
// by then the write has a body. A request carrying a header outside the CORS-safelisted set can
// no longer be simple: the browser must preflight it, we answer no `Access-Control-Allow-Origin`
// (we set no CORS headers anywhere — see the note on Mcp-Method/Mcp-Name), and the browser drops
// it before our handler exists. The header's VALUE is worthless as a secret and is not treated as
// one; what protects us is that a cross-origin page cannot get the header sent at all.
//
// Scope is deliberately narrow, and each exclusion is load-bearing:
//   · POST only — GET /view and the /events SSE stream stay untouched. EventSource CANNOT set
//     request headers, so requiring one there would break realtime for good.
//   · Origin present only — curl, MCP clients and tunnel ingress send none and are unaffected.
//     That keeps this a browser-shaped lock, which is the only shape the threat has.
const BROWSER_WRITE_HEADER = "x-oma-viewer";
const browserWriteAllowed = (req) =>
  !req.headers.origin || req.method !== "POST" || req.headers[BROWSER_WRITE_HEADER] != null;

// SEP-2575's per-request identity key, namespaced exactly as the 2026-07-28 spec writes it.
// One named constant because it is the single string the dual-era read below depends on: if the
// final spec text spells it differently, this is the one line that changes.
const CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (!originAllowed(req.headers.origin)) {
      return json(res, 403, { isError: true, content: [{ type: "text", text: "forbidden origin" }] });
    }
    // Distinct message on purpose: a stripped header and a wrong origin are different failures and
    // land on different people. If a reverse proxy ever drops `x-oma-viewer`, the viewer breaks —
    // and this line is what makes that five seconds to diagnose instead of an afternoon.
    if (!browserWriteAllowed(req)) {
      return json(res, 403, { isError: true, content: [{ type: "text",
        text: `browser writes must send the ${BROWSER_WRITE_HEADER} header (forces a CORS preflight)` }] });
    }
    // ---- MCP over Streamable HTTP (stateless: a fresh engine per request; the tool list
    // is rebuilt from the live registry every time, so new apps appear immediately) ----
    if (url.pathname === "/mcp") {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "null") : undefined;
      // Host label is REQUEST-SCOPED (no cross-client globals — stateless requests must not
      // inherit another client's identity). TWO PROTOCOL ERAS answer "who is calling", and this
      // reads both, first hit wins:
      //   · ≤ 2026-06-18 — `initialize` carries clientInfo once, when the connection opens.
      //   · 2026-07-28 + — `initialize`/`initialized` are DELETED (SEP-2575); every request
      //     carries `_meta["io.modelcontextprotocol/clientInfo"]` instead. It is a SHOULD, so it
      //     can still be absent, and the fallbacks below stay load-bearing.
      // Reading both costs one branch, and means the migration does not have to touch this line.
      //
      // The new era is not merely a replacement, it is a REPAIR — and the repair lands before the
      // migration does: this transport is stateless, so a tool call is its OWN HTTP request with
      // no initialize in it, which is why nearly every remote call today falls through to the
      // User-Agent token (test/http-smoke.mjs pins exactly that fallback). A per-request
      // clientInfo names THE CALL rather than whichever connection happened to open first — also
      // the shape that answers "one claude.ai user presents three clientInfo names" (measured;
      // see the note in src/store.mjs where the per-host watermark died of it).
      //
      // ⚠️ MEASURED, and it changes how to read the first bullet: the `initialize` branch is
      // UNREACHABLE on this wire today. A handshake is its own HTTP request and writes nothing, so
      // its label can only reach the ledger batched with a call — and the transport refuses that
      // (`-32600 Only one initialization request is allowed`; pinned in test/http-smoke.mjs). It is
      // kept because it is the old era's sole possible carrier and costs one ternary, NOT because
      // it is known to fire. Do not read this loop as two working paths: one works, one is a
      // placeholder honest enough to say so.
      //
      // Chain: either era's clientInfo → User-Agent product token → generic "remote-http".
      // Provenance annotation for the ledger, not a security property.
      let hostLabel = null;
      for (const msg of Array.isArray(body) ? body : body ? [body] : []) {
        if (!msg) continue;
        // New era first: in a message carrying both, the per-request value is the more specific
        // claim — it describes this call, not the session that opened the connection.
        const ci = msg.params?._meta?.[CLIENT_INFO_META]
          || (msg.method === "initialize" ? msg.params?.clientInfo : null);
        if (ci && typeof ci.name === "string" && ci.name) { hostLabel = ci.name; break; }
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

    // A constant answer, no store access: this exists so a SECOND instance of us can ask
    // "is the process on this port one of us?" before adopting its URL (see startViewer). It
    // deliberately reports no version — it is reachable through a tunnel, and the adoption check
    // does not need one, so there is nothing to fingerprint.
    if (url.pathname === "/healthz" && req.method === "GET") {
      return json(res, 200, { service: "open-mcp-apps" });
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

/**
 * Start the local viewer. Returns { url, port, adopted } — or null when there is no viewer to
 * hand out links for. NEVER throws: the caller is usually an MCP server whose actual job is the
 * stdio protocol, and a browser convenience must not be able to take that down.
 *
 * @param opts.store  the caller's store. Omit ONLY when this process has no other one (the
 *                    standalone `node src/http.mjs` path) — see the note at the top.
 * @param opts.port   overrides PORT.
 */
export async function startViewer({ store: ownStore, port } = {}) {
  if (started) return started;
  try {
    store = ownStore || openStore();
    PORT = port ?? Number(process.env.PORT || 8787);
    VIEW_BASE = process.env.OMA_VIEW_BASE || `http://127.0.0.1:${PORT}`;

    // The resident in-process MCP client for /rpc (the browser viewer's backend).
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const viewerEngine = createEngine(store, { hostLabel: "browser-viewer", viewBase: VIEW_BASE });
    await viewerEngine.connect(serverTransport);
    viewerClient = new Client({ name: "browser-viewer", version: "0.1.0" });
    await viewerClient.connect(clientTransport);

    // Bind to loopback ONLY. Both /rpc and /mcp are unauthenticated; a default (all-interfaces)
    // bind would let anyone on the LAN read and write your data. Remote hosts (ChatGPT/claude.ai)
    // reach /mcp through an OUTBOUND tunnel that connects to 127.0.0.1 locally, so restricting the
    // listener to loopback costs nothing. (Data-layer exposure only — even so, the tool surface
    // caps a caller to SQLite ops; see docs/security-model.md §1.5 Layer C.)
    const bound = await new Promise((resolve) => {
      const onError = (e) => { server.removeListener("listening", onListening); resolve({ error: e }); };
      const onListening = () => { server.removeListener("error", onError); resolve({ ok: true }); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(PORT, "127.0.0.1");
    });

    if (bound.ok) {
      started = { url: VIEW_BASE, port: PORT, adopted: false };
      return started;
    }
    // Several hosts share ONE store by design (Claude Desktop + Claude Code + Codex, all launched
    // separately), so losing the race for the port is the NORMAL case, not an error — and the
    // process that won is serving the very same data. Adopt its URL rather than leaving every host
    // after the first with no link to hand out, which is exactly the CLI case this feature is for.
    // But adopt only after ASKING: a port can be held by something that is not us, and handing the
    // model a link into a stranger's server is worse than handing it none.
    if (bound.error?.code === "EADDRINUSE") {
      const mine = await isOurViewer(VIEW_BASE);
      note(mine
        ? `viewer: port ${PORT} already served by another open-mcp-apps process — sharing it`
        : `viewer: port ${PORT} is taken by something else — no viewer, no links (set PORT= to move)`);
      started = mine ? { url: VIEW_BASE, port: PORT, adopted: true } : null;
      return started;
    }
    note(`viewer: could not start (${bound.error?.message || bound.error}) — continuing without it`);
    return (started = null);
  } catch (e) {
    note(`viewer: could not start (${e && e.message}) — continuing without it`);
    return (started = null);
  }
}

/** Is the thing already on this port one of us? One constant-shaped answer, no store access. */
async function isOurViewer(base) {
  try {
    const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.json())?.service === "open-mcp-apps";
  } catch { return false; }
}

// stderr, ALWAYS. src/server.mjs speaks the MCP protocol over stdout, so one console.log from the
// viewer would corrupt the JSON-RPC stream of the process it is a guest in. There is no mode where
// writing to stdout from here is safe, so this module never does.
function note(line) { try { console.error(`[oma] ${line}`); } catch {} }

// Standalone: `node src/http.mjs` (npm run serve). OMA_VIEWER is deliberately NOT read here —
// it means "do not start a viewer I did not ask for", and running this file IS asking.
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const v = await startViewer();
  if (v) {
    note(`http listening on ${v.url}`);
    note(`  browser viewer:  ${v.url}/`);
    note(`  MCP endpoint:    ${v.url}/mcp   (tunnel this for ChatGPT/claude.ai)`);
  } else {
    process.exitCode = 1;
  }
}
