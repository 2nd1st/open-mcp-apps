// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// functions.mjs — the function pillar (W3): declared, callable, data→data closures.
//
// An app's function is the app acting without its UI on screen: a signature the app DECLARES
// (manifest.functions — the structured save_app parameter, same door as every other declaration)
// and a body the app CARRIES in its own document. Two axioms, both signed (vision-synthesis §2):
//
//   · execution position is unique — calling semantics never depend on render state. A function
//     runs HERE, engine-side, whether or not any widget is mounted, on a bare MCP host with no
//     iframe anywhere.
//   · a function does not touch UI — it is data→data. Widgets react to its writes through the
//     same change feed every other write drives; there is no side channel back into a view.
//
// ── the store is synchronous TO THE BODY; the body is not ────────────────────────────────────────
// The store is synchronous (better-sqlite3) and it stays synchronous to the body: `api.list(...)`
// returns rows, not a promise, even though the rows now cross a thread. That half of the original
// contract is unchanged, and it is the half worth keeping — a function is a rollup, an RSVP, a
// vote, and none of those read better with an await in front of them.
//
// The other half is gone, deliberately (2026-08-16). Until then the BODY was a synchronous closure
// too and a returned thenable was an ERROR, for a reason that was sound at the time: vm's timeout
// can only interrupt code it is RUNNING, so an awaited body would sit on the microtask queue where
// nothing could reach it and "cancel" would become a second protocol. The remedy chosen then was
// to forbid await. The remedy now is to put the body somewhere that CAN be stopped — a worker
// thread, ended by worker.terminate(), which takes running code, pending timers and in-flight
// sockets with it in one call. Cancellation got STRONGER, not weaker, and the thread buys the
// thing that made it worth doing: a body can `await fetch(...)`, so an app's function is where an
// app reaches the outside world, on every host that speaks MCP, today, with nothing to declare and
// nothing for a host to honour. A synchronous body is the degenerate case of an async one, so
// every function written against the old executor still means exactly what it meant.
//
// What DIED with that trade is the sentence "nothing in the sandbox can schedule work to happen
// after the window". A body can now start something that outlives its own return. Two reasons that
// is acceptable, and they only work read together. First, terminate is not a request: past the
// deadline there is no thread left to run the thing that was scheduled, so "after the window"
// shrank to "after the return but before the deadline" instead of "forever". Second, residue was
// never zero. A function's writes commit one command at a time and are RECEIPTED one at a time, so
// a call that dies mid-body has always left its landed writes behind — that is what the `writes`
// array in a timeout reply is FOR, and why the derived command_ids make a retry idempotent rather
// than making a rollback necessary. The engine never promised a transaction. It promised an honest
// receipt, and that promise is untouched.
//
// ── the §2.5-D pre-flight list, mapped ──────────────────────────────────────────────────────────
//   authority        `actor` rides the call envelope (closed set, store-enforced); the anon face
//                    does NOT exist yet — `public: true` is validated, stored, and consumed by
//                    nothing (the B2 wave builds its gate; shape reserved per the ruling).
//   callable list    the declaration IS the whitelist: only manifest.functions names resolve.
//                    Cross-app calls are unreachable by shape (the runner forces the callee to
//                    the calling app; the model is the trusted caller on the tool face). The
//                    `callable` cap joins when a second caller class exists — a grant with no
//                    grantee today would be A4 again (a promise, not a feature).
//   depth / fanout   depth is 1 by construction — the api has no `call`, so a function cannot
//                    reach another function. Fanout is the write/read budgets below.
//   idempotency      inner command_ids are DERIVED (`${command_id}#w${n}`, issue order), so a
//                    retried call replays into the ledger's own dedup: writes that landed ack
//                    idempotently instead of landing twice. Cancel = the timeout (see above).
//   network / keys   the sandbox contains `args`, `api`, and an EXPLICIT capability list written
//                    out in function-worker.mjs: fetch, AbortController/AbortSignal, URL,
//                    URLSearchParams, setTimeout/clearTimeout, TextEncoder/TextDecoder, atob/btoa.
//                    Still no require, no process, no module scope, and codeGeneration is off so
//                    a string cannot become code. (vm contextifies a `console` of its own that
//                    measurably writes to neither stream — 0 bytes on stdout, 0 on stderr — so it
//                    is neither a capability nor a leak; the worker's real stdout is kept off the
//                    parent's, because on the stdio transport the parent's stdout IS the protocol
//                    channel.) EGRESS IS NOT FILTERED, and this engine will not
//                    filter it: it runs on the user's own machine over the user's own network, and
//                    a domain allowlist compiled into an OSS module is a promise the deployment
//                    cannot keep. The place that line belongs is a hosted plane's egress. KEYS are
//                    reserved, not delivered: `api.secret` exists and refuses, and settings keys
//                    under `secret:` are refused by the generic data_* writers AND by security_set,
//                    so nothing can squat the namespace before the release that fills it.
//                    NOTE vm is an isolation seam, not a hardened boundary — measured, not assumed:
//                    under the OLD executor `api.list.constructor("return typeof process")()`
//                    already answered "object", because any host function handed into a context
//                    carries that context's way back out. The trust model is unchanged (the
//                    author's code already runs with these caps in the user's own browser), which
//                    is exactly why the seat defaults OFF in createEngine and only the local
//                    entrypoints turn it on: a multi-tenant hosted plane must not inherit
//                    same-process execution by accident (hosted execution is post-poned until
//                    container isolation, ruled). What the worker changes is what is on the far
//                    side of that seam: a thread of its own, started with an EMPTY env, so the
//                    escape that used to reach the engine process's environment — which on a
//                    developer's machine is where the API keys live — now reaches an empty object.
//   via propagation  every inner write is STAMPED via:{app, function} by this module — never
//                    taken from the body's own args — so the ledger can always answer "which
//                    function wrote this". The runner independently forces the same stamp on the
//                    call envelope itself.
//
// ── the byte grammar (same doctrine as manifest-block.mjs, which see) ───────────────────────────
// A body block opens with this tag, byte for byte:
//     <script type="text/oma-function" data-fn="NAME">
// and runs to the first `</script`. A <script> tag that mentions the type in ANY other spelling
// is refused BY NAME rather than ignored — "I wrote a function and it silently does nothing" is
// the worst outcome available here, the exact lesson the manifest reader was built on. Prose (and
// the bodies themselves) may mention the marker freely; the check looks for a tag, not a word.
//
// Declaration and body are validated as a JOIN at the save door (store.mjs save_app): a declared
// name with no body, or a body with no declaration, refuses the save with a message that says
// what to add. Both directions, because each is the same silence wearing a different hat.

import { Worker, MessageChannel } from "node:worker_threads";
// The one answer to "which collection is this app's, when nobody said" — the widget binds by it
// (tools/apps.mjs, http.mjs), so the function api reads it rather than keeping a second rule.
// contracts.mjs imports only zod, so this cannot close a cycle with store.mjs's import of us.
import { defaultCollectionFor } from "./contracts.mjs";

const WORKER_URL = new URL("./function-worker.mjs", import.meta.url);

/** The one spelling, written out so a grep in an app finds what the engine looks for. */
export const FUNCTION_OPEN_PREFIX = '<script type="text/oma-function" data-fn="';
const CLOSE = "</script";
// Any script TAG that mentions the type without being the canonical opening — the near-miss that
// must fail loudly. Scoped to a tag so prose and body text stay free to discuss the marker.
const NEAR_MISS = /<script\b[^>]*text\/oma-function/i;

export const FN_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_FUNCTION_BODY = 32_768;   // per body — a bound on what save must hold and the executor must compile
export const MAX_FUNCTIONS = 32;           // per app — a roster, not a codebase

// Execution budgets. Sized from what a function is FOR — an RSVP, a vote, a rollup over one
// collection, and now one or two calls to somebody else's API — not from what the machine can
// take. A body that outgrows these has become a batch job, and batch jobs are the model's verb
// (data_batch), not a widget-reachable closure's. (The write/read/result budgets below keep that
// shape; only the wall clock's story changed.)
//
// The wall clock is only a DEFAULT — a gentle suggestion for a body that declares nothing. It went
// 2 s → 10 s when the body gained the network: two seconds was sized for "some arithmetic over
// local rows", and a single HTTPS round trip on a bad day eats most of it. A manifest may declare
// functions[name].timeout_ms as any positive integer, and this engine puts NO policy ceiling on it.
// The real limit is the HOST's tool-call timeout: call_function is an MCP tool call, and the host
// sits with the request open waiting for the result — run past that and the body is only spinning
// against a result nobody will read. That number is the host's to measure, not ours to pick (the
// 30 s ceiling we used to keep here was our own policy, and it is gone).
//
// A deadline still MUST exist, and does: it covers the whole call — worker start, body, and every
// await inside it — and is enforced by terminate(), the hard cancel for a runaway loop or a hung
// fetch that would otherwise pin a worker slot forever. Its only real cost is that slot (see
// MAX_CONCURRENT_FUNCTION_CALLS below): a long call keeps a live thread — not a one-shot charge —
// and on a single-tenant OSS engine that thread is the user's own resource. A SaaS sandbox that
// wants a cap sets one; the OSS engine does not.
export const FN_TIME_BUDGET_MS = 10_000;
// NOT a policy ceiling (the engine sets none) — the largest delay Node's setTimeout can actually
// hold, in its 32-bit signed timer. Past 2^31−1 ms (~24.8 days) the timer overflows and silently
// re-arms at 1 ms, which would BREAK the deadline rather than extend it. So a declared timeout_ms
// above this is refused at the save door and clamped by the executor. A mechanism bound, like the
// deadline itself — not a limit on how long a function is allowed to run.
export const FN_TIME_TIMER_MAX_MS = 2_147_483_647;
export const FN_WRITE_BUDGET = 100;
export const FN_READ_BUDGET = 200;
export const MAX_FUNCTION_RESULT = 32_768; // serialized chars — leaves envelope room under RESULT_BUDGET
// Threads are a PROCESS resource, so the ceiling and its queue are per process, not per engine:
// two engines over two stores in one process share these eight. Sized to be unremarkable on any
// machine that can run the engine at all; the day it binds is the day pooling earns its place
// (ruled 2026-08-16: start one per call, pool when the volume asks).
export const MAX_CONCURRENT_FUNCTION_CALLS = 8;
// A runaway allocation used to be the engine's problem, because vm shares the process heap. With
// a heap of its own it costs one call: V8 raises ERR_WORKER_OUT_OF_MEMORY, the worker's `error`
// event fires, and the call answers function_threw like any other body that blew up.
const FN_MAX_HEAP_MB = 256;

/** The one sentence the secret reservation is allowed to say, in all three places that say it:
 *  the generic data_* writers, security_set, and api.secret. One wording so a model that hits any
 *  of the three learns the same thing about the other two. */
export const SECRETS_RESERVED_NOTE =
  "reserved for a later release; secrets will be entered through the viewer settings UI, never through a model-facing tool";

// ── the concurrency gate ────────────────────────────────────────────────────────────────────────
// A plain FIFO. Waiting does NOT burn the caller's deadline: the clock starts when the call gets a
// slot and a thread, because a timeout for work that never started would teach the author to
// shorten a body that was never the problem.
let running = 0;
const waiting = [];
function acquireSlot() {
  if (running < MAX_CONCURRENT_FUNCTION_CALLS) { running++; return null; }
  return new Promise((go) => waiting.push(go));
}
function releaseSlot() {
  const next = waiting.shift();
  if (next) next(); else running--;   // hand the slot over, or give it back
}

/** Pull every body block out of a document. Returns {ok:true, bodies:{name→body}} or
 *  {ok:false, error, detail}. CRLF-normalised like every document grammar here, so a body edited
 *  on Windows is the same body everywhere. */
export function extractFunctionBodies(src) {
  const html = String(src ?? "").replace(/\r\n?/g, "\n");
  const bodies = Object.create(null);
  const spans = [];
  let at = 0;
  for (;;) {
    const open = html.indexOf(FUNCTION_OPEN_PREFIX, at);
    if (open === -1) break;
    const nameStart = open + FUNCTION_OPEN_PREFIX.length;
    const quote = html.indexOf('"', nameStart);
    if (quote === -1 || html.slice(quote, quote + 2) !== '">')
      return { ok: false, error: "function_block_malformed",
        detail: `a function block must open with exactly: ${FUNCTION_OPEN_PREFIX}NAME"> — no other attributes` };
    const name = html.slice(nameStart, quote);
    if (!FN_NAME_RE.test(name))
      return { ok: false, error: "bad_function_name",
        detail: `function name "${name}" — lowercase letters, digits and underscores, starting with a letter (max 64 chars)` };
    if (name in bodies)
      return { ok: false, error: "duplicate_function_body",
        detail: `two body blocks declare data-fn="${name}" — a function has exactly one body` };
    const bodyStart = quote + 2;
    const close = html.indexOf(CLOSE, bodyStart);
    const end = close === -1 ? html.length : close;
    const body = html.slice(bodyStart, end);
    if (body.length > MAX_FUNCTION_BODY)
      return { ok: false, error: "function_body_too_large",
        detail: `body of "${name}" is ${body.length} chars, limit ${MAX_FUNCTION_BODY}` };
    bodies[name] = body;
    spans.push([open, end]);
    at = end;
  }
  // Near-miss check on the RESIDUE — the document minus the canonical blocks (bodies may
  // legitimately mention the marker; a tag elsewhere may not).
  let residue = "";
  let cursor = 0;
  for (const [s, e] of spans) { residue += html.slice(cursor, s); cursor = e; }
  residue += html.slice(cursor);
  if (NEAR_MISS.test(residue))
    return { ok: false, error: "function_block_malformed",
      detail: `a <script> tag mentions text/oma-function without the canonical opening ${FUNCTION_OPEN_PREFIX}NAME"> — refused rather than ignored` };
  return { ok: true, bodies };
}

/** The save-door JOIN: does the resolved document carry exactly the bodies the resolved manifest
 *  declares? Returns a human sentence, or null when the two agree. Cheap for the common case —
 *  a document with no marker and a manifest with no functions never runs the scanner. */
export function functionsJoinError(manifest, ui) {
  const declared = manifest && manifest.functions && typeof manifest.functions === "object"
    ? Object.keys(manifest.functions) : [];
  const html = String(ui ?? "");
  if (declared.length === 0 && !/text\/oma-function/i.test(html)) return null;
  const ex = extractFunctionBodies(html);
  if (!ex.ok) return ex.detail;
  for (const name of declared) {
    if (!(name in ex.bodies))
      return `function "${name}" is declared in manifest.functions but the document has no body block — add <script type="text/oma-function" data-fn="${name}">…<\/script>`;
  }
  for (const name of Object.keys(ex.bodies)) {
    if (!declared.includes(name))
      return `the document carries a body block data-fn="${name}" that manifest.functions does not declare — declare it or remove the block (an undeclared body silently doing nothing is the outcome this check refuses)`;
  }
  return null;
}

// ── argument validation against the declared params (fail-with-schema) ──────────────────────────
// The params grammar is the manifest FIELD grammar (one schema language, ruled) — store.mjs
// validates the declaration side at save; this validates the CALL side, and its refusals carry
// the declared schema back so the caller's retry needs no extra read (the dispatcher-tax remedy).
const typeOk = (t, v) =>
  t === "string" ? typeof v === "string"
  : t === "number" ? typeof v === "number" && Number.isFinite(v)
  : t === "boolean" ? typeof v === "boolean"
  : t === "array" ? Array.isArray(v)
  : t === "object" ? (v !== null && typeof v === "object" && !Array.isArray(v))
  : false;

function argViolations(params, args) {
  const spec = params && typeof params === "object" ? params : {};
  const got = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const out = [];
  for (const [k, p] of Object.entries(spec)) {
    const v = got[k];
    if (v === undefined || v === null) {
      if (p.required) out.push(`"${k}" is required (${p.type})`);
      continue;
    }
    if (!typeOk(p.type, v)) out.push(`"${k}" must be a ${p.type}`);
    else if (p.enum && !p.enum.includes(v)) out.push(`"${k}" must be one of ${JSON.stringify(p.enum)}`);
  }
  for (const k of Object.keys(got))
    if (!(k in spec)) out.push(`"${k}" is not a declared parameter`);
  return out;
}

// A store refusal inside the body aborts the call carrying the store's own answer — thrown as a
// marked error so the boundary can tell "the store said no" from "the body threw".
class FnAbort extends Error {
  constructor(r) { super(r.error || "write_failed"); this.receipt = r; }
}

/** Build the executor over one store. One per engine; extracted bodies are memoized per
 *  app@version (saving bumps the version, so staleness is impossible by construction). The
 *  COMPILED form is not memoized any more and cannot be: a vm.Script belongs to the isolate that
 *  made it, and the isolate that runs a body now exists only for the length of one call. What is
 *  saved here is the document scan, which is the part that grows with the app. */
export function makeFunctionHost(store) {
  const compiled = new Map();   // "name@version" → { bodies } | { bad }
  const compiledFor = (comp) => {
    const key = comp.name + "@" + comp.version;
    let c = compiled.get(key);
    if (!c) {
      const ex = extractFunctionBodies(comp.ui);
      c = ex.ok ? { bodies: ex.bodies } : { bad: ex };
      compiled.set(key, c);
      // Bounded: old versions are unreachable (calls resolve the head), so drop eldest.
      if (compiled.size > 64) compiled.delete(compiled.keys().next().value);
    }
    return c;
  };

  /** Run one declared function. ASYNC since 2026-08-16 — the body runs on a worker thread, so the
   *  answer arrives on a promise even when the body itself never awaits anything. Returns
   *  store-style results — {ok:true, result, writes, reads} or {ok:false, error, …} with
   *  fail-with-schema payloads — and never throws for a caller mistake. */
  async function call({ app, function: fn, args, actor = "agent", host = null, command_id }) {
    if (!command_id) throw new Error("command_id required (idempotency key)");
    const name = String(app ?? "").trim();
    const fnName = String(fn ?? "").trim();
    const comp = store.getApp(name);
    if (!comp) return { ok: false, error: "no_such_app", app: name };
    let manifest = null;
    try { manifest = comp.manifest ? JSON.parse(comp.manifest) : null; } catch {}
    const roster = manifest && manifest.functions && typeof manifest.functions === "object"
      ? manifest.functions : {};
    const decl = Object.prototype.hasOwnProperty.call(roster, fnName) ? roster[fnName] : null;
    if (!decl || typeof decl !== "object") {
      // Fail WITH the roster: the retry should need no extra read.
      return { ok: false, error: "no_such_function", app: name, function: fnName,
               available: Object.keys(roster) };
    }
    const violations = argViolations(decl.params, args);
    if (violations.length)
      return { ok: false, error: "bad_args", app: name, function: fnName, violations,
               params: decl.params || {} };

    const c = compiledFor(comp);
    if (c.bad) return { ok: false, error: c.bad.error, detail: c.bad.detail };
    const body = c.bodies[fnName];
    // A manifest can predate the join check (unknown keys were once ignored at save) — the
    // executor refuses what the door could not, with the same sentence.
    if (body === undefined)
      return { ok: false, error: "function_body_missing",
               detail: `"${fnName}" is declared but the saved document carries no body block — re-save the app with <script type="text/oma-function" data-fn="${fnName}">…<\/script>` };

    // ── the capability surface the body sees ────────────────────────────────────────────────
    // Collections the function may touch: the app's own binding plus what it stewards. The same
    // tier gate defaultCollectionFor applies is inherited by construction — an unreviewed app's
    // manifest cannot bind it elsewhere, so its functions reach only its own name.
    const own = comp.name;
    // WHICH ONE IS "THIS APP'S COLLECTION" WHEN NOBODY SAYS. One question, one answer, and until
    // 2026-08-16 there were two: the widget asked defaultCollectionFor (an unambiguous declaration
    // wins, else the app's name) and the function api asked nothing at all — it fell back to the
    // NAME, full stop. An app declaring a single collection therefore had `api.count()` read an
    // empty collection while its own widget showed rows, with no error anywhere: the app name is
    // in the allowed set, so the read succeeded and simply found nothing. Same word, same answer.
    const bound = defaultCollectionFor(comp) || own;
    const allowed = new Set([own, bound]);
    if (manifest && manifest.collections && typeof manifest.collections === "object")
      for (const k of Object.keys(manifest.collections)) if (k.trim()) allowed.add(k.trim());
    allowed.delete("settings");   // the settings wall — functions do not write preferences
    const collOf = (c2) => {
      const coll = String(c2 ?? bound).trim();
      if (!allowed.has(coll)) throw new FnAbort({ ok: false, error: "collection_not_allowed", collection: coll });
      return coll;
    };
    const via = { app: own, function: fnName };
    const receipts = [];
    let reads = 0, writes = 0, wseq = 0;
    const spendRead = () => { if (++reads > FN_READ_BUDGET) throw new FnAbort({ ok: false, error: "read_budget_exceeded", limit: FN_READ_BUDGET }); };
    const write = (type, cmd) => {
      if (++writes > FN_WRITE_BUDGET) throw new FnAbort({ ok: false, error: "write_budget_exceeded", limit: FN_WRITE_BUDGET });
      // Derived id, issue order — the whole idempotent-retry story in one line.
      const r = store.execute({ ...cmd, type, command_id: `${command_id}#w${wseq++}`, actor, host, via });
      if (!r.ok) throw new FnAbort(r);
      receipts.push({ op: type, id: r.id, collection: r.collection, seq: r.seq,
                      ...(r.idempotent ? { idempotent: true } : {}) });
      return { id: r.id, seq: r.seq, collection: r.collection };
    };
    // Everything crossing the membrane is JSON-cloned: guest objects never leak host prototypes
    // in, host rows never hand live references out. That was true of the vm boundary and it is
    // true of the thread boundary, which structured clone would otherwise cross more generously.
    const toGuest = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    // The api the body calls is CONSTRUCTED in the worker; these are the implementations behind
    // it, and they stay here because everything they touch is here — the store, the budget
    // counters, the receipt list, the derived command_ids, the `via` stamp, the abort vocabulary.
    // The worker holds names; the parent holds authority.
    const api = Object.freeze({
      list: (opts) => {
        spendRead();
        const o = opts && typeof opts === "object" ? opts : {};
        const coll = collOf(o.collection);
        const q = store.queryItems(coll, {
          group: o.group == null ? undefined : String(o.group),
          match: o.match && typeof o.match === "object" ? toGuest(o.match) : undefined,
          limit: o.limit,
        });
        // The store's refusal stays a refusal — a typo'd operator silently matching nothing is
        // the exact wrong answer queryItems was taught to refuse (unknown_operator, which see).
        if (q.error) throw new FnAbort({ ok: false, error: q.error, ...(q.detail ? { detail: q.detail } : {}) });
        return toGuest(q.items || []);
      },
      count: (collection) => { spendRead(); return store.countItems(collOf(collection)); },
      add: (row) => {
        const r = row && typeof row === "object" ? row : {};
        return write("add_item", {
          collection: collOf(r.collection),
          ...(r.group == null ? {} : { group: String(r.group) }),
          fields: r.fields && typeof r.fields === "object" ? toGuest(r.fields) : {},
          ...(typeof r.position === "number" ? { position: r.position } : {}),
        });
      },
      update: (row) => {
        const r = row && typeof row === "object" ? row : {};
        const coll = collOf(r.collection);
        const id = String(r.id ?? "");
        // Membership BEFORE the write — the store resolves an id globally, and a function must
        // not reach a row outside its collections through a guessed id (the one-missing-line
        // cross-app escape, again).
        spendRead();
        if (!(store.snapshot(coll).items || []).some((i) => i.id === id))
          throw new FnAbort({ ok: false, error: "not_found", id, collection: coll });
        return write("update_item", { id,
          fields: r.fields && typeof r.fields === "object" ? toGuest(r.fields) : {} });
      },
      // NO delete, by design and not omission: destructive verbs keep the engine's confirmation
      // chokepoint, whose in-call delivery is MRTR — gated on host capability (redesign A7 row).
      // When that gate opens, delete arrives here WITH its demand path, not before.
    });

    // One entry point for every synchronous round trip the worker makes. `secret` is the reserved
    // name: it resolves, so an author discovers it exists, and it refuses, so nobody builds on it.
    const dispatch = (method, p) => {
      if (method === "list") return api.list(p.opts);
      if (method === "count") return api.count(p.collection);
      if (method === "add") return api.add(p.row);
      if (method === "update") return api.update(p.row);
      if (method === "secret") throw new FnAbort({ ok: false, error: "secrets_not_available", detail: SECRETS_RESERVED_NOTE });
      throw new FnAbort({ ok: false, error: "unknown_api_method", detail: `there is no api.${method}` });
    };

    // The effective deadline. There is NO policy ceiling — a declared timeout_ms is used as-is.
    // The only bound left is the mechanism's own: the value must be a positive integer setTimeout
    // can actually hold (see FN_TIME_TIMER_MAX_MS), or it falls back to the default rather than
    // silently arming a 1 ms timer. This re-checks what the save door already checked, for the same
    // reason function_body_missing exists: a manifest can predate the check, and the executor is the
    // last reader either way.
    const declared = decl.timeout_ms;
    const limitMs = Number.isInteger(declared) && declared >= 1 && declared <= FN_TIME_TIMER_MAX_MS
      ? declared : FN_TIME_BUDGET_MS;

    let guestArgs;
    try { guestArgs = toGuest(args) ?? {}; }
    catch (e) {
      return { ok: false, error: "function_threw",
               detail: String(e && e.message || e).slice(0, 500), writes: receipts };
    }

    const wait = acquireSlot();
    if (wait) await wait;
    let outcome;
    try {
      outcome = await runOnWorker({ body, app: own, fn: fnName, args: guestArgs, limitMs, dispatch });
    } finally {
      releaseSlot();
    }

    if (outcome.kind === "abort") {
      // The receipt is the PARENT's — the one it minted when it refused — never a shape the body
      // reported back. A body may catch an abort; it may not author one.
      const r = outcome.receipt;
      if (!r)
        return { ok: false, error: "function_threw",
                 detail: "the body reported a store refusal that never happened", writes: receipts };
      return { ok: false, error: r.error || "write_failed", detail: failDetail(r),
               receipt: r, writes: receipts };
    }
    if (outcome.kind === "timeout")
      return { ok: false, error: "function_timeout", limit_ms: limitMs, writes: receipts };
    if (outcome.kind === "threw")
      return { ok: false, error: "function_threw", detail: outcome.detail, writes: receipts };
    if (outcome.kind === "unserializable")
      return { ok: false, error: "unserializable_result", writes: receipts };
    if (outcome.kind === "too_large")
      return { ok: false, error: "result_too_large", size: outcome.size, limit: MAX_FUNCTION_RESULT, writes: receipts };
    return { ok: true, result: outcome.json === null ? null : JSON.parse(outcome.json),
             writes: receipts, reads };
  }

  return { call };
}

/** Start one worker, run one body on it, and end it — whatever happens. Resolves with a tagged
 *  outcome and never rejects: every way a thread can end (an answer, a throw, a crash, an exit, a
 *  deadline) is one of the tags, because a call that produced no tag would hang the tool handler.
 *
 *  The channel is deliberately two channels. `parentPort` carries the one message that ENDS the
 *  call; the MessageChannel carries the store round trips, which the worker reads with
 *  receiveMessageOnPort while blocked in Atomics.wait. Mixing them would put the answer in a queue
 *  that only a blocked thread ever drains. */
function runOnWorker({ body, app, fn, args, limitMs, dispatch }) {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    const flag = new Int32Array(new SharedArrayBuffer(4));
    let settled = false, lastAbort = null, worker = null, timer = null;
    const wake = () => { Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); };
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Terminate before resolving, so the slot the caller releases next is a slot whose thread is
      // really gone. This is also the cancel path: it ends the body, its timers and its sockets.
      const ended = worker ? worker.terminate().catch(() => {}) : Promise.resolve();
      ended.then(() => { try { port1.close(); } catch {} resolve(outcome); });
    };

    // The clock starts HERE — before the worker exists — so that a slow thread start is on the
    // deadline's side of the ledger rather than free time added to every call.
    timer = setTimeout(() => finish({ kind: "timeout" }), limitMs);

    port1.on("message", (req) => {
      if (settled) { port1.postMessage({ dead: true }); wake(); return; }
      let reply;
      try {
        reply = { value: dispatch(req.method, req.payload) };
      } catch (e) {
        if (e instanceof FnAbort) { lastAbort = e.receipt; reply = { abort: true, error: e.receipt.error }; }
        else reply = { threw: String((e && e.message) || e).slice(0, 500) };
      }
      // Post FIRST, then raise the flag: the worker wakes on the flag and reads the port, so the
      // message has to be there before the wake can be seen.
      port1.postMessage(reply);
      wake();
    });

    try {
      worker = new Worker(WORKER_URL, {
        workerData: { port: port2, flag, body, app, fn, args, maxResult: MAX_FUNCTION_RESULT },
        transferList: [port2],
        // An EMPTY environment, not the engine's. A body that crosses the vm seam (see the header)
        // lands in this thread's realm, and this thread's realm knows nothing about the machine it
        // is running on. Nothing here reads env, so nothing here loses anything.
        env: {},
        resourceLimits: { maxOldGenerationSizeMb: FN_MAX_HEAP_MB },
        // The worker's stdout is NOT the parent's. On the stdio transport the parent's stdout IS
        // the protocol channel, and one stray line on it is a parse error the user reads as "the
        // server broke". Nothing legitimate is lost: the sandbox has no `process`, and vm's own
        // contextified `console` measurably writes to neither stream. Route both to stderr, which
        // is where anything that does escape belongs.
        stdout: true,
        stderr: true,
      });
      // `on("data")` rather than `pipe`: pipe registers unpipe/error/close/finish handlers on
      // process.stderr that outlive the worker, and eight concurrent calls is already enough to
      // trip Node's max-listeners warning. These handlers live on the worker's own streams and
      // die with the thread.
      const toStderr = (chunk) => { try { process.stderr.write(chunk); } catch {} };
      worker.stdout.on("data", toStderr);
      worker.stderr.on("data", toStderr);
    } catch (e) {
      finish({ kind: "threw", detail: `the function's worker could not start: ${String((e && e.message) || e)}`.slice(0, 500) });
      return;
    }

    worker.on("message", (m) => {
      if (m.done === "value") finish({ kind: "value", json: m.json });
      else if (m.done === "abort") finish({ kind: "abort", receipt: lastAbort });
      else if (m.done === "unserializable") finish({ kind: "unserializable" });
      else if (m.done === "too_large") finish({ kind: "too_large", size: m.size });
      else finish({ kind: "threw", detail: String(m.detail || "the function's worker sent no reason").slice(0, 500) });
    });
    worker.on("error", (e) =>
      finish({ kind: "threw", detail: String((e && e.message) || e).slice(0, 500) }));
    // Any exit that beats an answer is a failure, including a CLEAN one: a body that reaches
    // process.exit(0) through the seam must not be able to report success it never returned.
    worker.on("exit", (code) =>
      finish({ kind: "threw", detail: `the function's worker exited (code ${code}) before returning a value` }));
  });
}

// The store's refusal, restated for a caller that will read it inside a function-call reply.
function failDetail(r) {
  if (r.error === "collection_not_allowed") return `collection "${r.collection}" is outside this app's declared collections — a function reaches the collection its app is BOUND to (the same one its widget opens on) and what its manifest stewards, nothing else`;
  if (r.error === "read_budget_exceeded") return `the function exceeded its read budget (${r.limit} reads per call)`;
  if (r.error === "write_budget_exceeded") return `the function exceeded its write budget (${r.limit} writes per call)`;
  if (r.error === "not_found") return `item ${r.id} is not in collection "${r.collection}"`;
  if (r.error === "schema_violation") return `a write was rejected by the collection's manifest: ${(r.violations || []).join("; ")}`;
  return r.detail || r.error || "write failed";
}
