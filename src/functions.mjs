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
// ── why the body is SYNCHRONOUS, and why that is a feature ───────────────────────────────────────
// The store is synchronous (better-sqlite3), so a function needs no await to do everything it is
// for. Making that the CONTRACT — the body is a plain synchronous closure, a returned thenable is
// an error — is what turns the time budget from a wish into a guarantee: vm's timeout interrupts
// running code, but only code it is running; an async body escapes onto the host's microtask queue
// where nothing can interrupt it, and "cancel" becomes a second protocol. Synchronous, the whole
// call lives inside one runInContext window: the timeout is real, cancellation is the timeout,
// and there is no partially-awaited state to reason about. (This also closes the async exfil
// shapes for free — nothing in the sandbox can schedule work to happen after the window.)
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
//   network / keys   the sandbox context contains ONLY `args` and `api` plus JS builtins: no
//                    require, no process, no fetch, no timers, and codeGeneration is off so a
//                    string cannot become code. NOTE vm is an isolation seam, not a hardened
//                    boundary — the trust model is the same as app JS (the author's code already
//                    runs with these caps in the user's own browser), which is exactly why the
//                    seat defaults OFF in createEngine and only the local entrypoints turn it on:
//                    a multi-tenant hosted plane must not inherit same-process execution by
//                    accident (hosted execution is post-poned until container isolation, ruled).
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

import vm from "node:vm";

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
// collection — not from what the machine can take. A body that outgrows these has become a batch
// job, and batch jobs are the model's verb (data_batch), not a widget-reachable closure's.
export const FN_TIME_BUDGET_MS = 2_000;
export const FN_WRITE_BUDGET = 100;
export const FN_READ_BUDGET = 200;
export const MAX_FUNCTION_RESULT = 32_768; // serialized chars — leaves envelope room under RESULT_BUDGET

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

/** Build the executor over one store. One per engine; compiled bodies are memoized per
 *  app@version (saving bumps the version, so staleness is impossible by construction). */
export function makeFunctionHost(store) {
  const compiled = new Map();   // "name@version" → { bodies, scripts: Map(fn → vm.Script) }
  const compiledFor = (comp) => {
    const key = comp.name + "@" + comp.version;
    let c = compiled.get(key);
    if (!c) {
      const ex = extractFunctionBodies(comp.ui);
      c = ex.ok ? { bodies: ex.bodies, scripts: new Map() } : { bad: ex };
      compiled.set(key, c);
      // Bounded: old versions are unreachable (calls resolve the head), so drop eldest.
      if (compiled.size > 64) compiled.delete(compiled.keys().next().value);
    }
    return c;
  };

  /** Run one declared function. Returns store-style results — {ok:true, result, writes, reads}
   *  or {ok:false, error, …} with fail-with-schema payloads — never throws for a caller mistake. */
  function call({ app, function: fn, args, actor = "agent", host = null, command_id }) {
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
    const allowed = new Set([own]);
    if (manifest && manifest.collections && typeof manifest.collections === "object")
      for (const k of Object.keys(manifest.collections)) if (k.trim()) allowed.add(k.trim());
    allowed.delete("settings");   // the settings wall — functions do not write preferences
    const collOf = (c2) => {
      const coll = String(c2 ?? own).trim();
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
    // Everything crossing the membrane is JSON-cloned: vm objects never leak host prototypes in,
    // host rows never hand live references out.
    const toGuest = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
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

    let value;
    try {
      let script = c.scripts.get(fnName);
      if (!script)
        c.scripts.set(fnName, script = new vm.Script(
          `(function (args, api) { "use strict";\n${body}\n})(args, api)`,
          { filename: `oma-function:${own}/${fnName}` }));
      const sandbox = { args: toGuest(args) ?? {}, api };
      const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
      value = script.runInContext(context, { timeout: FN_TIME_BUDGET_MS });
    } catch (e) {
      if (e instanceof FnAbort)
        return { ok: false, error: e.receipt.error || "write_failed", detail: failDetail(e.receipt),
                 receipt: e.receipt, writes: receipts };
      if (e && (e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /Script execution timed out/.test(String(e.message))))
        return { ok: false, error: "function_timeout", limit_ms: FN_TIME_BUDGET_MS, writes: receipts };
      return { ok: false, error: "function_threw",
               detail: String(e && e.message || e).slice(0, 500), writes: receipts };
    }
    if (value && typeof value.then === "function")
      return { ok: false, error: "async_not_supported",
               detail: "a function body is a synchronous closure — the store is synchronous, so nothing here needs await, and the time budget is only real without it", writes: receipts };
    let result = null;
    if (value !== undefined) {
      let s;
      try { s = JSON.stringify(value); } catch {
        return { ok: false, error: "unserializable_result", writes: receipts };
      }
      if (s === undefined) s = "null";
      if (s.length > MAX_FUNCTION_RESULT)
        return { ok: false, error: "result_too_large", size: s.length, limit: MAX_FUNCTION_RESULT, writes: receipts };
      result = JSON.parse(s);
    }
    return { ok: true, result, writes: receipts, reads };
  }

  return { call };
}

// The store's refusal, restated for a caller that will read it inside a function-call reply.
function failDetail(r) {
  if (r.error === "collection_not_allowed") return `collection "${r.collection}" is outside this app's declared collections — a function reaches its own binding and what its manifest stewards, nothing else`;
  if (r.error === "read_budget_exceeded") return `the function exceeded its read budget (${r.limit} reads per call)`;
  if (r.error === "write_budget_exceeded") return `the function exceeded its write budget (${r.limit} writes per call)`;
  if (r.error === "not_found") return `item ${r.id} is not in collection "${r.collection}"`;
  if (r.error === "schema_violation") return `a write was rejected by the collection's manifest: ${(r.violations || []).join("; ")}`;
  return r.detail || r.error || "write failed";
}
