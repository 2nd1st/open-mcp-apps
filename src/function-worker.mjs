// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// function-worker.mjs — where an app function's body actually runs.
//
// One worker thread per call. The body gets its own event loop, so `await fetch(...)` is just
// what it looks like; it gets its own heap, so a runaway allocation costs one call instead of the
// engine; and it gets a hard end, because `worker.terminate()` from the parent stops everything
// this thread was doing — running code, pending timers, in-flight sockets — which is a stronger
// cancel than vm's timeout ever was (vm interrupts the code it is *running*, and an awaited body
// is, by definition, not running).
//
// Two things about this file are deliberate and easy to undo by accident:
//
//   · it imports NOTHING from src/. Only `node:worker_threads` and `node:vm`. Every call pays this
//     module's load time (measured ~15 ms for the whole worker boot), and one careless import of
//     store.mjs would drag better-sqlite3's native addon into every function call.
//   · it holds a KEEP-ALIVE handle for the life of the call. Without it a body that parks on a
//     promise nothing ever settles drains the worker's event loop, and Node exits the thread on
//     the spot — so "my function hangs" would report as a crash when the body awaited a dead
//     promise and as a timeout when it awaited a dead socket. One stuck-body outcome is worth one
//     idle timer: the DEADLINE in the parent is the only thing that ends a call that will not end.
//
// The store stays SYNCHRONOUS to the body (`api.list(...)` returns rows, not a promise) across a
// thread boundary: every api call is a blocking round trip — postMessage, Atomics.wait, and
// receiveMessageOnPort to pick the reply off the port without going through the event loop, which
// is the point, since this thread's event loop is where the body's own awaits live. The PARENT
// never blocks: it answers on its message handler while awaiting this worker's result. Everything
// the store owns — budgets, receipts, derived command_ids, the `via` stamp, the abort vocabulary —
// stays in the parent, where it was, because it is the parent that has the store and the ledger.

import { workerData, parentPort, receiveMessageOnPort } from "node:worker_threads";
import vm from "node:vm";

const { port, flag, body, app, fn, args, maxResult, egress } = workerData;

// See the header: the parent's deadline is the single end of a call that will not end.
const keepAlive = setInterval(() => {}, 1_000);

// Errors this module raised because the PARENT said no. A WeakSet rather than a marker property,
// so a body that catches an abort cannot mint a second one by copying what it saw.
const aborts = new WeakSet();

/** One synchronous store round trip. Blocks THIS thread; the parent stays on its event loop. */
function rpc(method, payload) {
  Atomics.store(flag, 0, 0);
  port.postMessage({ method, payload });
  let reply;
  for (;;) {
    Atomics.wait(flag, 0, 0);
    const m = receiveMessageOnPort(port);
    if (m) { reply = m.message; break; }
    // The flag moved but the message is not on the port yet: yield a millisecond rather than
    // spin. (The parent posts before it stores, so this branch should be unreachable — it is
    // here because "should be" is not a synchronisation primitive.)
    Atomics.wait(flag, 0, 1, 1);
  }
  if (reply.abort) { const e = new Error(reply.error || "aborted"); aborts.add(e); throw e; }
  if (reply.dead) throw new Error("this call already ended — the store is closed to it");
  if (reply.threw) throw new Error(reply.threw);
  return reply.value;
}

// Everything crossing the thread is JSON-cloned, the same doctrine the vm boundary already had:
// no live references out, no host prototypes in, and a body that hands us something structured
// clone would refuse (a function, a class instance) gets the same shape it got before.
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const api = Object.freeze({
  list: (opts) => clone(rpc("list", { opts: clone(opts) })),
  count: (collection) => rpc("count", { collection: collection === undefined ? undefined : String(collection) }),
  add: (row) => clone(rpc("add", { row: clone(row) })),
  update: (row) => clone(rpc("update", { row: clone(row) })),
  // Reserved, on purpose, and refused by the PARENT so the refusal is one sentence in one place:
  // a name that exists and says "not yet" is what keeps the next release from having to rename it.
  secret: (name) => rpc("secret", { name: name === undefined ? undefined : String(name) }),
  // Still NO delete: destructive verbs keep the engine's confirmation chokepoint.
});

// ── egress: the body's fetch, pointed at the host's gateway ─────────────────────────────────────
// Present only when the PARENT passed one ({gateway, token}); on every local install `egress` is
// undefined and `fetch` below is the platform's, untouched. This is DEPTH, not the boundary: vm is
// an isolation seam, and a body that escapes it reaches the thread's realm — which is why the
// wrapper is installed on `globalThis` too, and why the thing that actually holds the line is the
// network the host runs this process on. The wrapper's job is that the normal path goes through
// the gateway (where the allowlist, the private-IP check and the secret injection live) and that
// a denial comes back as an error the body can read.
//
// The wire is the gateway's, written out here because this file must import NOTHING from src/:
//   POST/GET/... {gateway}/egress    method, body and headers are the body's own
//   X-Egress-Url:   the absolute target URL          (overwrites anything the body set)
//   X-Egress-Token: the tenant token from workerData (same)
//   redirect: "manual"               the gateway follows redirects itself, re-checking each hop
//   X-Egress-Error on the response ⇒ throw — a refusal reaches the body as a rejected fetch,
//   which is the shape a body already handles, carrying the gateway's own code.
function makeEgressFetch({ gateway, token }) {
  const base = String(gateway).replace(/\/+$/, "") + "/egress";
  return async function fetch(url, init) {
    const o = init && typeof init === "object" ? init : {};
    // string | URL | Request-shaped. A Request carries a method of its own, and an init that names
    // one still wins — same precedence the platform has.
    const reqLike = url !== null && typeof url === "object" && typeof url.url === "string" ? url : null;
    const raw = reqLike ? reqLike.url : String(url);
    let target;
    try { target = new URL(raw).toString(); }
    catch {
      throw new TypeError(`fetch("${raw}") needs an ABSOLUTE url — a function body has no page to resolve a relative one against`);
    }
    const headers = new Headers(o.headers ?? (reqLike ? reqLike.headers : undefined));
    // The gateway's own headers are the wrapper's to set: a body that writes them is overwritten,
    // never trusted. (Its `Authorization` is a different header and rides through untouched — that
    // one is the body's credential for the TARGET api.)
    for (const k of [...headers.keys()]) if (k.toLowerCase().startsWith("x-egress-")) headers.delete(k);
    headers.set("X-Egress-Url", target);
    headers.set("X-Egress-Token", String(token));
    const res = await platformFetch(base, {
      method: o.method ?? (reqLike ? reqLike.method : undefined) ?? "GET",
      headers,
      ...(o.body === undefined || o.body === null ? {} : { body: o.body }),
      ...(o.signal ? { signal: o.signal } : {}),
      // The body's own `redirect` is IGNORED on purpose: hops are the gateway's to follow, because
      // only it can re-run the allowlist and the private-address check on each new location.
      redirect: "manual",
    });
    const denied = res.headers.get("X-Egress-Error");
    if (denied) {
      let why = "";
      try { why = (await res.text()).slice(0, 200); } catch {}
      throw new Error(`egress_denied: ${denied}${why ? ": " + why : ""}`);
    }
    return res;
  };
}

const platformFetch = fetch;
const egressFetch = egress && egress.gateway ? makeEgressFetch(egress) : null;
// Both places, deliberately: the sandbox object is what a well-behaved body sees, and `globalThis`
// is what an escaped one sees. A wrapper on only the first would be a wrapper on only the path
// that did not need watching.
if (egressFetch) globalThis.fetch = egressFetch;

// The names a body sees. An explicit list, not a filter — the sandbox is empty except for what is
// written here, so adding a capability is an edit to this object and nothing else. `fetch` and the
// URL/abort/encoding types around it are what make this step the app's back end; timers are what
// make an await-shaped body honest. No `require`, no `process`, no module scope, and codeGeneration
// off below so a string cannot become code. (vm contextifies its own `console` regardless of what
// is listed here; measured, its `log` writes to neither stream, so a body's debug line goes
// nowhere rather than onto the parent's stdio protocol channel.)
const sandbox = {
  args: clone(args) ?? {},
  api,
  fetch: egressFetch || fetch,
  AbortController,
  AbortSignal,
  URL,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  TextEncoder,
  TextDecoder,
  atob,
  btoa,
};

const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

(async () => {
  let done;
  try {
    // ASYNC wrapper: the body may `await` at its top level, and whatever it returns is awaited
    // before it counts as a value. A body with no await in it is the degenerate case of this one
    // — which is why every function written against the synchronous executor still runs here.
    const script = new vm.Script(
      `(async function (args, api) { "use strict";\n${body}\n})(args, api)`,
      { filename: `oma-function:${app}/${fn}` },
    );
    const value = await script.runInContext(context);
    if (value === undefined) {
      done = { done: "value", json: null };
    } else {
      let s;
      try { s = JSON.stringify(value); } catch { s = false; }
      if (s === false) done = { done: "unserializable" };
      else {
        if (s === undefined) s = "null";   // a lone undefined-producing value (a function, a symbol)
        done = s.length > maxResult ? { done: "too_large", size: s.length } : { done: "value", json: s };
      }
    }
  } catch (e) {
    done = aborts.has(e)
      ? { done: "abort" }
      : { done: "threw", detail: String((e && e.message) || e).slice(0, 500) };
  }
  parentPort.postMessage(done);
  // NOT clearing keepAlive: the parent terminates this thread once it has the answer, and that is
  // the only exit path worth having — a thread that decides on its own when it is finished would
  // race the message it just posted.
})();
