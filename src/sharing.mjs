// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// sharing.mjs — cross-account sharing, the engine's half: who is calling, what other accounts have
// shared with them, and how a `@owner/name` handle resolves to the one wall that may answer it.
//
// The engine owns tool SEMANTICS (what a handle in a collection argument means, what a viewer may
// do, what a receipt says). The DEPLOYMENT owns the grant RECORDS (who invited whom, which link,
// which account accepted) and the stores themselves. The two meet at the three createEngine options
// typed below, and nowhere else. A local install passes none of them and none of this runs: no
// handle resolves, no tool is added, every answer is what it was before sharing existed.
//
// Design: docs/sharing-design-2026-10-02.md (§10 overrides the recommendations above it).

import { scopeStore, SHARE_ROLES } from "./store.mjs";
import { openFileChannel } from "./files.mjs";
import { answer, toMcp } from "./contracts.mjs";

/**
 * WHO is calling — an identity the deployment AUTHENTICATED (a verified token, a session). Every
 * write the engine performs on this caller's behalf, in their own store or in an owner's store
 * through a share, carries `principal` in the ledger (store.mjs principalScope).
 * @typedef {Object} Caller
 * @property {string} principal  stable account id (e.g. the identity provider's user id). Opaque to
 *                               the engine: compared for equality, stored, never parsed.
 * @property {string} [label]    what a person reads for this account (an email). Display only.
 */

/**
 * One app another account has shared with the caller, as the deployment's records say RIGHT NOW.
 * @typedef {Object} Grant
 * @property {string} alias     the caller-side name for the OWNER, the `leo` in `@leo/trips`.
 *                              /^[a-z0-9][a-z0-9-]{0,23}$/, unique per (caller, owner). Every grant
 *                              from one owner carries the same alias; the engine never invents one.
 * @property {string} owner     opaque id of the owner's store (a tenant id). Grants that share an
 *                              alias MUST share an owner — an alias whose grants disagree is treated
 *                              as not shared at all.
 * @property {string} ownerLabel what a person reads for the owner ("leo@example.com").
 * @property {string} app       the app's name in the OWNER's store.
 * @property {number} appBirth  store.appBirth(app) in the owner's store when the share was made —
 *                              the engine passes it to SharingProvider.invite and the deployment
 *                              stores it with the grant. A grant whose app has since been deleted
 *                              or recreated is dead (MountsProvider.ended reports it).
 * @property {"viewer"|"editor"} role
 * @property {() => object} store  the owner's store (openStore's object). Called lazily, at most
 *                              once per owner per tool call; the deployment acquires and releases
 *                              it around the request.
 */

/**
 * The RECIPIENT side. Called on every tool call that needs it — never cached by the engine — so a
 * revoked grant is gone on the next call (possession of a handle is not authorization).
 * @typedef {Object} MountsProvider
 * @property {() => Grant[] | Promise<Grant[]>} grants  every ACTIVE grant held by THIS caller.
 *            The provider is constructed for one caller; it must never return another's.
 * @property {(dead: Array<{alias: string, owner: string, app: string, appBirth: number}>) => void} [ended]
 *            optional: the engine found these grants dead (app deleted or reborn under the same
 *            name). The deployment closes them; until it does, they simply reach nothing.
 */

/**
 * The OWNER side, plus `leave` for a recipient. Every method returns (or resolves to)
 * `{ ok: true, ... }` or `{ ok: false, error: string, detail?: string }`; `detail` is shown to the
 * model as-is, so it must be a sentence a person can act on. The engine has already checked what
 * it can check (the app exists and is the caller's own, the role is one of the two, the caller is
 * not re-sharing a share) — the deployment checks the rest (accounts, quotas, link state).
 * @typedef {Object} SharingProvider
 * @property {(req: {app: string, appBirth: number, role: "viewer"|"editor",
 *                   access: "restricted"|"anyone", accounts: string[]}) =>
 *            Promise<{ok: true, link: ShareLink} | ShareFailure>} invite
 *            Make a claim link. `restricted`: only `accounts` (lower-cased emails) may claim it.
 *            `anyone`: whoever holds the link may claim it (`accounts` is empty). Either way the
 *            claimant must sign in, and a claim becomes an account × role grant.
 * @property {(req: {app?: string} | {alias: string, app: string}) =>
 *            Promise<{ok: true, links: ShareLink[], grants: GrantInfo[]} | ShareFailure>} list
 *            `{app?}`: the caller's OWN shares (all apps, or one). `{alias, app}`: the participants
 *            of an app shared WITH the caller (participants can see each other).
 * @property {(req: {app: string, link?: string, accounts?: string[]}) => Promise<{ok: true, revoked: number} | ShareFailure>} revoke
 *            `link`: stop that link from being claimed (existing grants stay). `accounts`: end
 *            those accounts' grants on the app.
 * @property {(req: {app: string, accounts: string[], role: "viewer"|"editor"}) => Promise<{ok: true, changed: number} | ShareFailure>} setRole
 * @property {(req: {alias: string, app: string}) => Promise<{ok: true} | ShareFailure>} leave
 *            the CALLER gives up a grant they hold.
 * @property {(req: {alias: string, owner: string, app: string, as: string, with_data: boolean}) => void} [copied]
 *            optional audit hook: the caller copied a shared app into their own store.
 *
 * @typedef {{ok: false, error: string, detail?: string}} ShareFailure
 * @typedef {Object} ShareLink
 * @property {string} id         link id (for revoke)
 * @property {string} app
 * @property {"viewer"|"editor"} role
 * @property {"restricted"|"anyone"} access
 * @property {string[]} accounts  who may claim (restricted); [] for anyone
 * @property {string} [url]       the claim URL — present on invite; present on list while the link is live
 * @property {string} [expires_at]
 * @property {boolean} [revoked]
 * @typedef {Object} GrantInfo
 * @property {string} app
 * @property {string} account     the grantee's label
 * @property {"viewer"|"editor"|"owner"} role
 * @property {string} [since]
 */

/** The caller-side owner alias, exactly. No case folding, no normalisation: a handle either spells
 *  one of the caller's aliases byte for byte or it names nothing. */
export const ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** `@alias/name` → {alias, name}, or null. Only the SHAPE is read here; whether it names anything
 *  is the router's question, asked against the caller's own grants. */
export function parseHandle(h) {
  if (typeof h !== "string" || h.charAt(0) !== "@") return null;
  const slash = h.indexOf("/");
  if (slash < 2) return null;
  const alias = h.slice(1, slash), name = h.slice(slash + 1);
  return ALIAS_RE.test(alias) && name ? { alias, name } : null;
}
export const isHandle = (v) => typeof v === "string" && v.charAt(0) === "@";
export const handleOf = (alias, name) => `@${alias}/${name}`;

/** The three options, read once by createEngine. Malformed shapes THROW: a deployment that meant
 *  to pass an identity and passed a typo would otherwise run shares with nobody's name on the
 *  writes — the attribution this whole axis exists for, missing in silence. */
export function normalizeSharing({ caller, mounts, sharing } = {}) {
  let who = null;
  if (caller !== undefined && caller !== null) {
    if (typeof caller !== "object" || typeof caller.principal !== "string" || !caller.principal)
      throw new TypeError("createEngine: caller must be {principal: non-empty string, label?: string}");
    if (caller.label !== undefined && typeof caller.label !== "string")
      throw new TypeError("createEngine: caller.label must be a string");
    who = Object.freeze({ principal: caller.principal, ...(caller.label ? { label: caller.label } : {}) });
  }
  if (mounts != null) {
    if (typeof mounts !== "object" || typeof mounts.grants !== "function")
      throw new TypeError("createEngine: mounts must be {grants(): Grant[] | Promise<Grant[]>, ended?(dead)} — see src/sharing.mjs");
    if (!who) throw new TypeError("createEngine: mounts needs caller — a share is reached BY an account, and every write through it is stamped with that account");
  }
  if (sharing != null) {
    for (const m of ["invite", "list", "revoke", "setRole", "leave"])
      if (typeof sharing[m] !== "function") throw new TypeError(`createEngine: sharing.${m} must be a function — see src/sharing.mjs`);
    if (!mounts) throw new TypeError("createEngine: sharing needs mounts — `leave` and `copy_app` act on what was shared with the caller");
  }
  return { caller: who, mounts: mounts ?? null, sharing: sharing ?? null };
}

/**
 * The per-engine resolver for `@` handles. A tool call opens ONE session and resolves through it:
 * the provider is asked once per session (so a 200-command batch is one grant read, not 200) and
 * never across sessions — a revocation is in force on the very next call.
 */
export function makeRouter(mounts) {
  return { session: () => routerSession(mounts) };
}

function routerSession(mounts) {
  let groupsP = null;
  const faces = new Map();
  function byAlias() {
    if (!groupsP) groupsP = readGrants();
    return groupsP;
  }
  async function readGrants() {
    const list = await mounts.grants();
    const groups = new Map();
    const conflicted = new Set();
    for (const g of Array.isArray(list) ? list : []) {
      if (!g || !ALIAS_RE.test(String(g.alias ?? "")) || typeof g.owner !== "string" || typeof g.app !== "string"
          || !Number.isInteger(g.appBirth) || !SHARE_ROLES.includes(g.role) || typeof g.store !== "function") continue;
      const at = groups.get(g.alias);
      if (!at) groups.set(g.alias, [g]);
      else if (at[0].owner !== g.owner) conflicted.add(g.alias);
      else at.push(g);
    }
    // Fail closed: an alias naming two owners is a provider bug, and guessing which owner was meant
    // is the one thing this layer must never do.
    for (const a of conflicted) groups.delete(a);
    return groups;
  }
  function mountOf(alias, gs) {
    if (!faces.has(alias)) faces.set(alias, openMount(alias, gs));
    return faces.get(alias);
  }
  function openMount(alias, gs) {
    const store = gs[0].store();
    const face = scopeStore(store, { grants: gs, files: openFileChannel(store) });
    const dead = face.scope().ended;
    if (dead.length && typeof mounts.ended === "function") {
      try { mounts.ended(dead.map((d) => ({ alias, owner: gs[0].owner, ...d }))); } catch { /* reporting is best-effort */ }
    }
    return { alias, owner: gs[0].owner, ownerLabel: String(gs[0].ownerLabel ?? alias), face };
  }
  async function mount(alias) {
    const gs = (await byAlias()).get(alias);
    return gs ? mountOf(alias, gs) : null;
  }
  return {
    /** Every owner who shares anything with the caller: [{alias, owner, ownerLabel, face}]. */
    async all() {
      const out = [];
      for (const [alias, gs] of await byAlias()) out.push(mountOf(alias, gs));
      return out;
    },
    mount,
    /** A collection handle → {m, name, role} or null. */
    async collection(h) {
      const p = parseHandle(h);
      if (!p) return null;
      const m = await mount(p.alias);
      const role = m && m.face.roleOf(p.name);
      return role ? { m, name: p.name, role } : null;
    },
    /** An app handle → {m, app, role, collections} or null. */
    async app(h) {
      const p = parseHandle(h);
      if (!p) return null;
      const m = await mount(p.alias);
      const a = m && m.face.scope().apps.find((x) => x.app === p.name);
      return a ? { m, app: a.app, role: a.role, row: a } : null;
    },
    /** Which shared collection holds this row, when the caller's own store does not: {m, name} for
     *  exactly one hit across every owner, else null (an ambiguous id is not guessed at). */
    async item(id) {
      const hits = [];
      for (const [alias, gs] of await byAlias()) {
        const m = mountOf(alias, gs);
        const c = m.face.itemCollection(id);
        if (c != null) hits.push({ m, name: c });
      }
      return hits.length === 1 ? hits[0] : null;
    },
    /** An upload id minted through a share (`@alias/<id>`) → {m, id} or null. */
    async upload(uploadId) {
      const p = parseHandle(uploadId);
      if (!p) return null;
      const m = await mount(p.alias);
      return m ? { m, id: p.name } : null;
    },
  };
}

// ── the answers a handle gets, one sentence each, so every tool says the same thing ────────────
/** Not shared — the SAME answer for a handle that names nothing, a collection the owner keeps but
 *  did not share, an alias that is not the caller's, and a malformed handle. */
export const notShared = (h) => toMcp(answer.fail("not_shared", {},
  `not_shared — "${String(h)}" is not shared with you (or does not exist). list_apps and list_data_collections show what is shared with you.`), { isError: true });

/** Code, history, functions and policy of a shared app are its owner's. */
export const sharedLocked = (h, ownerLabel) => toMcp(answer.fail("shared_app_locked", { name: String(h) },
  `shared_app_locked — "${String(h)}" was shared with you by ${ownerLabel}: you can use it and its data, but its code, history and functions stay theirs. copy_app {app: "${String(h)}", with_data: true|false} makes an editable copy of your own.`), { isError: true });

export const readOnlyNote = (h, ownerLabel) =>
  `read_only — "${String(h)}" is shared with you read-only by ${ownerLabel}; nothing was written.`;

/** The line a shared read leads with: where it came from and what the caller may do with it. */
export const provenanceLine = (ownerLabel, role) =>
  `Shared with you by ${ownerLabel} · ${role === "editor" ? "you can EDIT DATA" : "READ-ONLY"}.`;
