// confirmation.mjs — the confirmation-policy chokepoint (W-S, redesign §2.5-A/B).
//
// One question, answered in one place: "does THIS command need the user's explicit
// confirmation before it runs?" The old shape — every component remembering to build its own
// arm-then-delete UI — failed exactly the way the adversarial panel predicted: an author who
// forgets loses the user's data silently. Here forgetting is impossible by construction:
//   · every store command type MUST appear in CONFIRMATION_CLASSES (store.mjs asserts the
//     two tables cover each other at module load — an unclassified new command refuses to boot);
//   · the demand is enforced INSIDE the store's command transaction, so no tool path,
//     bridge path or batch can route around it.
//
// Delivery is the fail-closed out-of-band two-step (§2.5-A path ②), which needs nothing from
// the host: the first call comes back `ok:false, reason:"confirmation_required"` carrying an
// opaque `request_state` plus a human preview; whoever faces the user (the shell's overlay for
// widgets, the model's own chat turn for agents — piloted in W1 by delete_app's cascade) shows
// the preview and re-sends the same command with `request_state` attached. MRTR
// (`input_required`) stays a second delivery route IN RESERVE: W-M measured elicitation dead on
// all ten host faces (2026-08-05, four distinct failure modes), so the adapter slot waits on a
// host capability — the policy layer here does not change when one appears.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Every store command, classified. `confirm: true` marks the commands whose HUMAN-actor calls
// must present a verified `request_state` while the user's `confirm_delete` pref is on.
// `why` on the exempt rows is load-bearing documentation: the next reader (or judge) should not
// have to re-derive the reasoning, and a row without a reason is a row nobody argued about.
export const CONFIRMATION_CLASSES = {
  add_item:    { confirm: false, why: "creates — nothing to lose" },
  update_item: { confirm: false, why: "ledger keeps the whole pre-image; undo reverses it" },
  move_item:   { confirm: false, why: "placement only — fields untouched" },
  delete_item: { confirm: true },
  save_app:    { confirm: false, why: "checkpointed — restore_app recovers any version" },
  // `confirm` here governs the HUMAN-actor, pref-gated demand only. The cascade disposition
  // (data:"cascade") carries its OWN unconditional two-step inside the store's delete_app
  // handler — every actor, pref ignored — because it destroys whole collections with no undo.
  delete_app:  { confirm: false, why: "keep-data tombstone is recoverable (history survives); cascade demands unconditionally in the command handler" },
  archive_app: { confirm: false, why: "visibility flip, trivially reversible" },
  // NOT because an overwrite is recoverable — it is not. contracts.mjs classifies it DESTRUCTIVE
  // in as many words: the previous blob is orphaned and the GC sweep unlinks the bytes. What this
  // row records is the SCOPE of the promise: this layer covers the explicit delete verbs, where
  // the user's intent is "make this go away", and leaves overwrite-loss to the annotation that
  // already asks the host to confirm it. Do not restate the old reason here — it claimed the
  // ledger kept the sha lineage, which is false and would have made this exemption look safe.
  write_file:  { confirm: false, why: "explicit delete verbs only in this wave — overwrite-loss rides the DESTRUCTIVE annotation (contracts.mjs)" },
  // A hard loss — the content blob is freed — and LIVE: file_delete publishes `actor`, the
  // channel forwards it with `request_state`, and both runtimes run the same confirm-and-resend
  // flow they run for items. One limitation, stated because it is the only one left: the file
  // plane carries no `via`, so the confirmation caller is the actor alone and the per-app
  // `confirm_delete` override cannot reach a file delete. The global preference does.
  delete_file: { confirm: true },
};

const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** The signing secret for ONE store, shared by every process that opens it.
 *
 *  It lives in a file beside the database rather than in a table, and that is a deliberate
 *  trade: a table would mean a schema version and a second rung on a migration ladder that was
 *  just cut down to one, for a value with no history, no queries and no relationship to any row.
 *  A sibling file gets the same property for free — every engine opening this database finds the
 *  same key — and app code cannot read it, because app code has no filesystem.
 *
 *  Putting it next to the data is not a weakening: it protects the minting of a ten-minute
 *  confirmation token, and anyone who can read this file can already read the database it sits
 *  next to. Losing it costs one round of pending confirmations, which fail CLOSED and are simply
 *  asked again. An in-memory store has no path and gets a process key, which is correct: nothing
 *  else can open it.
 */
export function storeSecret(dbPath, { readOnly = false } = {}) {
  if (!dbPath || dbPath === ":memory:") return randomBytes(32);
  const keyPath = dbPath + ".confirm-key";
  try {
    const held = readFileSync(keyPath);
    if (held.length >= 32) return held;
  } catch { /* absent or unreadable — fall through */ }
  const fresh = randomBytes(32);
  if (readOnly) return fresh;   // a read-only opener never writes beside the database
  try {
    writeFileSync(keyPath, fresh, { mode: 0o600, flag: "wx" });   // wx: lose the race, read the winner
    return fresh;
  } catch {
    try { const raced = readFileSync(keyPath); if (raced.length >= 32) return raced; } catch {}
    return fresh;   // unwritable directory — degrade to a process key rather than refuse to boot
  }
}

/** HMAC-signed, short-lived request state (§2.5-B) — it authorizes AT MOST ONE SUCCESSFUL
 *  delete of the row at the pinned version. Not "single-use": a state survives attempts that
 *  fail for unrelated reasons (measured — three OCC conflicts in a row left it valid, and the
 *  fourth attempt succeeded), which is what you want, because an answer the user already gave
 *  should not be destroyed by someone else's version conflict.
 *
 *  The state binds everything the confirmation was ABOUT: the command type, the CALLER it was
 *  issued to, the target row, and the row's version at issue time.
 *
 *  `caller` is deliberately not called a principal. §2.5-B asks for an authenticated principal
 *  and there is no authenticated identity in this engine to bind: what it carries is `actor` plus
 *  the via-app, both caller-SUPPLIED and forgeable by the model. That is sufficient for what this
 *  binding is for — keeping one confirmation from being spent by a different caller than the one
 *  the user answered for — and it is not authentication. When W5 brings a real authenticated
 *  identity, it joins this string; naming the field for a property it does not yet have would
 *  have made the gap invisible exactly where someone would look for it.
 *  Verification re-derives that binding from the CURRENT command and CURRENT row — re-authorizing
 *  at execute time, not trusting the token's memory of the world.
 *
 *  Single consumption is structural, not a table: the state pins the target's version, versions
 *  are ledger seqs and the ledger never goes backwards, so once the delete runs the row is gone
 *  and no future row — not even an undo re-creating the same id — can ever carry that version
 *  again. A consumed-nonce table would be a second belt on the same invariant.
 *
 *  The secret comes from the STORE, not from the process — see storeSecret(). A per-process key
 *  was the first shape and it was wrong for a reason that is already true today: N hosts share
 *  one database (the viewer even says so when it finds a sibling process on its port), so a
 *  confirmation issued by one engine and answered through another verified against a different
 *  key and died as `confirmation_invalid` with nothing to explain it. Hosted deployments, where
 *  workers are interchangeable by design, would have failed every confirmation.
 */
export function createRequestStateCodec({ secret = randomBytes(32), ttlMs = 10 * 60_000 } = {}) {
  const mac = (body) => createHmac("sha256", secret).update(body).digest();
  return {
    ttlMs,
    issue({ type, caller, target, version }) {
      const exp = Date.now() + ttlMs;
      const body = b64u(JSON.stringify({ n: randomBytes(12).toString("hex"), t: type, p: caller, g: target, v: version, exp }));
      return { state: body + "." + b64u(mac(body)), expires_at: new Date(exp).toISOString() };
    },
    verify(state, { type, caller, target, version }) {
      if (typeof state !== "string") return { ok: false, error: "confirmation_invalid" };
      const dot = state.lastIndexOf(".");
      if (dot < 1) return { ok: false, error: "confirmation_invalid" };
      const body = state.slice(0, dot);
      // Node's base64url decoder SKIPS characters it does not recognise, so `<state>!` and
      // `<state>===` decode to the same bytes as `<state>` and used to verify (codex review).
      // Nothing is forgeable that way — but a credential with more than one spelling is a
      // credential you cannot reason about, so only the canonical spelling is a state.
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(state)) return { ok: false, error: "confirmation_invalid" };
      let given, want, p;
      try {
        given = Buffer.from(state.slice(dot + 1), "base64url");
        want = mac(body);
        if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, error: "confirmation_invalid" };
        p = JSON.parse(Buffer.from(body, "base64url").toString());
      } catch { return { ok: false, error: "confirmation_invalid" }; }
      if (!(typeof p.exp === "number" && p.exp >= Date.now())) return { ok: false, error: "confirmation_expired" };
      if (p.t !== type || p.p !== caller || p.g !== target || p.v !== version) return { ok: false, error: "confirmation_invalid" };
      return { ok: true };
    },
  };
}

/** One human line naming what a delete is about to remove — shown in the confirmation, derived
 *  from the row at the bound version (so the version check above is also the preview's
 *  freshness check: a row edited after issue fails verify, and the stale preview dies with it). */
export function deletePreview(fields) {
  const f = fields && typeof fields === "object" ? fields : {};
  let text = "";
  for (const k of ["title", "name", "label", "text", "summary", "description"]) {
    if (typeof f[k] === "string" && f[k].trim()) { text = f[k].trim(); break; }
  }
  if (!text) for (const k of Object.keys(f)) {
    if (typeof f[k] === "string" && f[k].trim()) { text = f[k].trim(); break; }
  }
  if (!text) return "(item)";
  return text.length > 64 ? text.slice(0, 63) + "…" : text;
}
