// SPDX-License-Identifier: MIT
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
// There is no /live route. An always-on display — a spare tablet on a wall showing whatever the
// AI just opened — is an APP that places the `@live` brick (shell-runtime.js), opened at
// /view/<its name> like any other. The engine's half is the pointer this file already pushes on
// the /events frame; the screen's half belongs to whoever designs the screen.
//
// Run: node src/http.mjs   (PORT=8787 by default)
// NOTE: anything that can reach this port can read/write the store — keep it local, and
// treat a tunnel URL as a secret while it's up.

import http from "node:http";
import { createMcpHandler, InMemoryTransport, CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { Client, ProtocolError } from "@modelcontextprotocol/client";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { openStore, APP_NAME_RE } from "./store.mjs";
import { createEngine, hostContext, tierOf, defaultCollectionFor, stageWidthFor, stageDisplayFor } from "./engine.mjs";
import { wrapApp, wrapLoader } from "./shell.mjs";
import { RUNNER_CSP_POLICY } from "./runner.mjs";

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
let mcpNode = null;   // the /mcp request handler, built in startViewer once the store exists
let started = null;

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body)); };
const html = (res, code, body, headers) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers }).end(body); };

// /view CSP (docs/security-model.md §5 v0.2) — closes the browser viewer's network-egress gap
// (threat H): no host iframe CSP exists in a plain tab, so the response header is the boundary.
// DERIVED from the runner's policy, one delta, spelled as a replace so the two can never drift
// apart again (W4 — this used to be a hand-retyped copy, and it HAD drifted: it silently lost
// `form-action 'none'`, the one outbound shape that does not fall back to default-src).
// The delta, stated honestly: connect-src 'self' instead of 'none'. The runner srcdoc has no
// /rpc fetch; /view serves the STANDALONE shell whose entire data path is fetch("/rpc") on this
// same origin — 'none' would kill the browser viewer outright.
// frame-src 'none' is safe for the settings app's thumbnail grid: about:srcdoc frames are exempt
// from frame-src and inherit this policy instead (verified in Chrome — the srcdoc child renders,
// its inline scripts/styles ride on 'unsafe-inline', and external egress stays blocked).
const VIEW_CSP = RUNNER_CSP_POLICY.replace("connect-src 'none'", "connect-src 'self'");
// The index page carries no scripts and no frames — it gets the same wall minus nothing it
// needs: inline styles and data: glyphs only.
const INDEX_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'";
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
// The fix: the loopback allowance is narrowed to OUR OWN PORT, not any port. Every loopback
// spelling still passes (localhost / 127.0.0.1 / [::1] are the same server, and pinning the
// spelling would break the ordinary `localhost:PORT` visit — see the note at the /view route),
// but a different port is a different application and gets no say here.
// (A second belt — the x-oma-viewer custom header forcing a CORS preflight on browser writes —
// rode alongside this from 2026-07-31 to 2026-08-04. Retired, elegance C1: this exact-origin
// gate independently closes the measured exploit, and the header's only remaining job was
// insuring against a bug in the four lines above — one invariant, one belt.)
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


const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (!originAllowed(req.headers.origin)) {
      return json(res, 403, { isError: true, content: [{ type: "text", text: "forbidden origin" }] });
    }
    // ---- MCP over Streamable HTTP ----
    // Served by the SDK's per-request entry (built in startViewer): a fresh engine per request,
    // so the tool list is rebuilt from the live registry every time and new apps appear
    // immediately. The entry owns the era decision (SEP-2575) — a 2026-07-28 envelope claim gets
    // the modern wire (per-request `_meta`, `server/discover`, `Mcp-Method`/`Mcp-Name` header
    // validation → -32020), everything else falls back to old-school stateless legacy serving —
    // and the SAME factory backs both, so the two eras can never drift apart.
    if (url.pathname === "/mcp") {
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "null") : undefined;
      // Host-label FALLBACK, request-scoped (no cross-client globals — stateless requests must
      // not inherit another client's identity). The most specific claim — this call's own
      // clientInfo in the 2026-07-28 `_meta` envelope — is read per call inside the engine
      // (perCallHost, engine.mjs); this feeds hostContext the tail of the chain:
      //   · a claimless `_meta` clientInfo in the single body message (measured: ChatGPT sent
      //     the per-request form before the spec landed, without the protocolVersion claim);
      //   · else the User-Agent product token (what nearly every remote call resolves to today —
      //     test/http-smoke.mjs pins exactly that fallback); else generic "remote-http".
      // ONE message, no batch walk, no `initialize` arm (elegance A6): this wire accepts a single
      // JSON-RPC message per request — a batched initialize is refused by the transport (pinned in
      // http-smoke) — so states the old loop handled could never arrive here.
      // Provenance annotation for the ledger, not a security property.
      const ci = body?.params?._meta?.[CLIENT_INFO_META_KEY];
      const ua = String(req.headers["user-agent"] || "").trim();
      const hostLabel = (ci && typeof ci.name === "string" && ci.name)
        || (ua ? "http:" + ua.split(/[\s/]/)[0].toLowerCase().slice(0, 32) : "remote-http");
      // hostContext.run scopes the fallback to THIS dispatch: everything the handler awaits —
      // factory, era routing, tool handlers — runs inside, and a concurrent request gets its own.
      return hostContext.run({ fallback: hostLabel }, () => mcpNode(req, res, body));
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
      // /rpc's contract is the CallToolResult envelope, always. The v2 client THROWS on JSON-RPC
      // errors (unknown/disabled tool = -32602) where v1 answered in-band — without this catch the
      // outer handler turns a retired tool name in stale app code into a bare HTTP 500, and the
      // shell runtime surfaces "HTTP 500" with the useful message discarded.
      try {
        const result = await viewerClient.callTool({ name, arguments: args || {} });
        return json(res, 200, result);
      } catch (e) {
        if (e instanceof ProtocolError)
          return json(res, 200, { isError: true, content: [{ type: "text", text: e.message }] });
        throw e; // transport/internal failures keep their 500 — those are OUR bugs, not the caller's
      }
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
      const v0 = store.dataVersion();
      let lastSeq = v0.seq, lastLiveN = v0.live_n;
      // TWO AXES, ONE FRAME. `live` is which app was opened last (store.touchLiveApp) — a key
      // ADDED to the payload, never one changed, because every client in the wild reads `d.seq`
      // and ignores the rest (src/shell-runtime.js onmessage), so a second event type would only
      // be a channel nothing old subscribes to. Null until an app has been opened at all.
      const send = () => {
        const p = store.livePointer();
        try { res.write(`data: ${JSON.stringify({ seq: lastSeq, live: p ? { app: p.app, ts: p.ts } : null })}\n\n`); } catch {}
      };
      // Connect = the CURRENT state, whole. A display is opened long after the app it should
      // be showing was; waiting for the next change would leave it blank until the AI happened to
      // do something, which on a screen nobody is sitting at could be hours.
      send();
      const onChange = (ev) => { if (ev.seq !== lastSeq) { lastSeq = ev.seq; send(); } };
      const onLive = (ev) => { if (ev.n !== lastLiveN) { lastLiveN = ev.n; send(); } };
      store.events.on("change", onChange);
      store.events.on("live", onLive);
      // The cross-process fallback now watches both axes: the chat host that opens an app is
      // usually a DIFFERENT process from this viewer (stdio server vs `npm run serve`), and its
      // "live" emit cannot reach our emitter any more than its "change" can. live_n is the counter
      // that makes the switch visible here — the app name alone could not (opening the same app
      // twice is a real event on a display that has since been reloaded).
      const probe = setInterval(() => {
        try {
          const d = store.dataVersion();
          if (d.seq !== lastSeq || d.live_n !== lastLiveN) { lastSeq = d.seq; lastLiveN = d.live_n; send(); }
        } catch {}
      }, 2000);
      const beat = setInterval(() => { try { res.write(":hb\n\n"); } catch {} }, 25000);
      req.on("close", () => {
        store.events.off("change", onChange);
        store.events.off("live", onLive);
        clearInterval(probe); clearInterval(beat);
      });
      return; // response stays open — the SSE stream owns it from here
    }

    // ---- browser viewer ----
    const view = url.pathname.match(/^\/view\/([a-z][a-z0-9-]{0,31})$/);
    if (view && req.method === "GET") {
      const comp = store.getApp(view[1]);
      if (!comp) return html(res, 404, `<h3>No app "${view[1]}"</h3>`);
      // Same binding rule the open_app tool uses — one answer to "what does this app open on".
      const collection = url.searchParams.get("collection") || defaultCollectionFor(comp);
      // ?chrome=0 — serve the BARE widget: no viewer bar, no page stage (shell-runtime.js
      // `SA.chrome !== false`). The switch already existed for the hosted shell; the URL is
      // how a LOCAL embedder reaches it. Both parts of that chrome are wrong inside a host
      // panel: the bar carries an "All apps" link OUT of the app — which a shell that opened
      // this app as a dedicated place must not offer — and the stage draws a page-sized card
      // around a widget that is already framed by the panel it sits in. Opt-in and default-off:
      // a person who opens /view in a tab still gets the tab's chrome.
      //
      // EXCEPT for an app that declared itself a display (`manifest.stage.display` — contracts.mjs
      // stageDisplayFor). That declaration already says what the chrome asks: this app IS the
      // frame, not a widget someone framed. A wall on a spare tablet with an "← All apps" bar
      // above it and a rounded card under it is the viewer decorating a screen the app was written
      // to own, edge to edge — the same double bezel the stage contract removed one level down.
      // So the default flips for those apps only, and `?chrome=1` is the way back: a person
      // developing a wall still wants a tab to look like a tab. Both doors below read this one
      // answer, because a display served through the loader (non-local tier) is the same screen.
      const chromeParam = url.searchParams.get("chrome");
      const chrome = chromeParam === "0" || (chromeParam !== "1" && stageDisplayFor(comp)) ? { chrome: false } : {};
      // ?nav=intent — app→app links stop navigating this document and become a message to the
      // embedder instead (shell-runtime.js SA.navIntent). Orthogonal to chrome=0 on purpose:
      // chrome is about what this page DRAWS, this is about who decides where a link GOES. A
      // panel host that opens each app as its own place needs the second and usually wants the
      // first; a plain tab wants neither. Default off — the link works as written.
      const nav = url.searchParams.get("nav") === "intent" ? { navIntent: true } : {};
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
      // settings' App Store preview has relied on exactly this since it shipped).
      if (tierOf(comp.author) !== "local")
        return html(res, 200, wrapLoader({
          standalone: { endpoint: "/rpc", collection, app: view[1], ...chrome, ...nav,
            ...(process.env.OMA_VIEW_BASE ? { viewBase: VIEW_BASE.replace(/\/+$/, "") + "/view/" } : {}) },
        }), { "content-security-policy": VIEW_CSP });
      return html(res, 200, wrapApp(comp.ui, {
        // The width track the app declared, written onto its body for the kit (contracts.mjs
        // stageWidthFor / shell.mjs stampStage). Same rule the ui:// resource applies, from the
        // same function — a second copy would be a second answer waiting to disagree.
        stage: stageWidthFor(comp),
        // viewBase reaches the RUNTIME only when the operator set one. App→app links
        // default to a relative "/view/", which is correct for a plain local server and wrong behind
        // a path-prefixed proxy — where OMA_VIEW_BASE is exactly the operator saying what the prefix
        // is. Passing it unconditionally would turn every in-app link absolute (127.0.0.1), which
        // silently breaks the ordinary `localhost:PORT` visit: different origin, same server.
        standalone: { endpoint: "/rpc", collection, app: view[1], ...chrome, ...nav, ...(process.env.OMA_VIEW_BASE ? { viewBase: VIEW_BASE.replace(/\/+$/, "") + "/view/" } : {}) },
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
      const SYSTEM_ORDER = ["dashboard", "app-store", "settings"];
      const system = SYSTEM_ORDER.map((n) => comps.find((c) => c.name === n)).filter(Boolean);
      const apps = comps.filter((c) => !SYSTEM_ORDER.includes(c.name));
      const sysIcon = { dashboard: "M3 3h7v7H3zM12 3h7v4h-7zM12 9h7v10h-7zM3 12h7v8H3z", "app-store": "M4 5h16v14H4zM4 15l4-4 3 3 5-5 4 4", settings: "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 12h2m12 0h2M12 4v2m0 12v2" };
      const card = (c, big) => `<a class="card${big ? " big" : ""}" href="/view/${esc(c.name)}">
        ${big ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${sysIcon[c.name] || sysIcon.dashboard}"/></svg>` : ""}
        <span class="n">${esc(c.name)}</span><span class="v">v${c.version}</span>
        <span class="d">${esc(c.description || (c.author === "library" ? "App Store app" : "app"))}</span></a>`;
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
    : `<div class="empty">No apps yet. Ask your AI in chat to build one — or open the <a href="/view/app-store">App Store</a> and install a ready-made app.</div>`}
  <p class="foot">MCP endpoint: <code>POST /mcp</code> · store: shared with every chat host on this machine</p>
</div></body></html>`, { "content-security-policy": INDEX_CSP });
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
 */
export async function startViewer({ store: ownStore } = {}) {
  try {
    store = ownStore || openStore();
    PORT = Number(process.env.PORT || 8787);
    VIEW_BASE = process.env.OMA_VIEW_BASE || `http://127.0.0.1:${PORT}`;

    // The resident in-process MCP client for /rpc (the browser viewer's backend).
    // Legacy wire on purpose: InMemoryTransport is not era-classifying, and an internal
    // same-process client gains nothing from the per-request envelope.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // Local-product entrypoints opt INTO the function pillar (see server.mjs / createEngine docs);
    // OMA_FUNCTIONS=0 is the kill-switch for both the viewer's /rpc engine and /mcp.
    const functions = process.env.OMA_FUNCTIONS !== "0";
    const viewerEngine = createEngine(store, { hostLabel: "browser-viewer", viewBase: VIEW_BASE, functions });
    await viewerEngine.connect(serverTransport);
    viewerClient = new Client({ name: "browser-viewer", version: "0.1.0" });
    await viewerClient.connect(clientTransport);

    // The /mcp entry (see the route above for what it serves). Built here because it closes over
    // the store; ONE handler for the process, engines minted per request by the factory.
    mcpNode = toNodeHandler(
      createMcpHandler(() => createEngine(store, { viewBase: VIEW_BASE, functions }),
        { onerror: (e) => note(`mcp: ${e && e.message || e}`) }),
      { onerror: (e) => note(`mcp: ${e && e.message || e}`) },
    );

    // Bind to loopback ONLY. Both /rpc and /mcp are unauthenticated; a default (all-interfaces)
    // bind would let anyone on the LAN read and write your data. Remote hosts (ChatGPT/claude.ai)
    // reach /mcp through an OUTBOUND tunnel that connects to 127.0.0.1 locally, so that door pays
    // nothing for the restriction. (Data-layer exposure only — even so, the tool surface caps a
    // caller to SQLite ops; see docs/security-model.md §1.5 Layer C.)
    // /view DOES pay, and 0.5.1 set the price (repriced 2026-08-16 — this used to say loopback
    // "costs nothing"): `@live`'s whole point is a SECOND screen — wall tablet, old phone, e-ink —
    // and those live on the LAN, so reaching them costs you a bridge you stand up yourself. The
    // price stands until device pairing ships; a bind flag alone is not the fix, and the reasoning
    // for that is docs/open-decisions.md D-15.
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
