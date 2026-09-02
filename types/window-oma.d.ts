// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// window-oma.d.ts — types for the API an APP sees: `window.oma`, inside the widget.
//
// Not to be confused with `index.d.ts`, which types the engine's Node API (createEngine, openStore)
// — the surface an EMBEDDER uses. These two never meet: an app runs in a sandboxed iframe with no
// Node at all, and until this file existed a TypeScript project building an app had nothing to
// import and typed `window.oma` as an error. Its sibling `types/oma-function.d.ts` is the third
// surface: what a function BODY sees, engine-side, where there is no window at all.
//
//     /// <reference types="@2nd1st/open-mcp-apps/types/window-oma" />
//
// That line resolves through package.json's `exports` map, which is what "bundler" and "node16"
// moduleResolution read INSTEAD of the file tree. Both are checked (test/runtime-contract.mjs);
// they have to be, because until 2026-08-16 the map declared only "." and this exact line was
// TS2688 under both — the file existed, shipped nowhere, and typed nothing. `import type
// { Oma } from "@2nd1st/open-mcp-apps/types/window-oma"` resolves through the same entry.
//
// The names here are the ones RUNTIME.md §4 documents and test/runtime-contract.mjs pins against
// both runtimes; doc-facts pins RUNTIME.md against that same list, and a test in
// runtime-contract.mjs pins THIS FILE against it too — so a name cannot appear in one of the four
// and be missing from another.
//
// That claim used to stop at the top-level members and leave `OmaState` unpinned, which is where
// it drifted: `oma.state` hands back the runtime's own state object, `app` and `host` included,
// so `oma.state.app` had an answer at runtime and a TS2339 in an editor. A .d.ts that ERRORS on
// correct code is the failure mode this file exists to prevent, so the state shape is pinned to
// the runtime's own initialiser now (runtime-contract.mjs §2b).
//
// The 19 PORTABLE names are declared required and the 3 direct-only names OPTIONAL, which is the
// literal truth of the two runtimes: an app running behind the sandboxed runner reads `undefined`
// for `embed`, `openLink` and `viewBase` (RUNTIME.md §4, "Reading one of these in a sandboxed app
// gives undefined"). Optional members make the compiler ask for the feature-detection the prose
// asks for.

export interface OmaItem {
  id: string;
  group: string;
  /** Order WITHIN this item's group — the scope is (collection, group), not the collection, so
   *  every group owns its own 1, 2, 3 and the same number recurs once per group. Sorting a
   *  cross-group list by this reads as an order and is not one (RUNTIME.md §4). */
  position: number;
  fields: Record<string, unknown>;
  /** The ledger seq of the write that produced this row — ONE counter for the whole store, so it
   *  is globally monotonic and sortable across groups and collections (the key for "which happened
   *  first" when the rows are in different groups), and it JUMPS: never a per-item revision count,
   *  never +1, never a number to subtract. Also the token a conditional update compares. */
  version: number;
}

export interface OmaState {
  collection: string | null;
  items: OmaItem[];
  version: number;
  total?: number;
  truncated?: boolean;
  /** WHICH APP this document is. Not decoration: the universal loader reads exactly this to
   *  decide what to mount (`src/shell.mjs`, "state.app is where the loader reads the name"), and
   *  it survives a re-render the host bound to another call. `null` on a document that has not
   *  been told yet — the loader before it resolves, or a host that replayed nothing. */
  app: string | null;
  /** The host's own name for itself ("browser-viewer" in the engine's viewer, a client name when
   *  one arrives). A LABEL, never a branch: MCP dropped the `initialize` handshake in 2026-07-28,
   *  so most hosts never name themselves and the engine's honest answer is the empty one — an
   *  `=== "claude-ai"` test reads false ON claude.ai (measured 2026-08-13, src/engine.mjs). When
   *  you want a capability, feature-detect it; `oma.standalone` is the one environment fact worth
   *  branching on. `oma.host` was a second door to this same field and was removed 2026-08-04. */
  host: string | null;
}

export interface OmaFileMeta {
  path: string;
  size: number;
  mime: string;
  version: number;
}

/** Read side of this app's own file plane. Writes go through the AI (file_write) or
 *  `install-app.mjs --asset`; an app renders what is there. */
export interface OmaFiles {
  list(): Promise<{ files: OmaFileMeta[] }>;
  read(path: string): Promise<Uint8Array>;
  /** An object URL, cached per path — drop it straight into <img src> / <a href>. */
  url(path: string): Promise<string>;
}

/** The ack body of a data write, or the typed refusal. A refusal is an ANSWER, not an exception.
 *
 *  This is what EVERY write verb resolves to, in every runtime — the direct one, the sandboxed
 *  runner, and both inert previews. Until 2026-08-23 that was true only of the declaration: the
 *  two live runtimes resolved the raw MCP envelope (`{content, structuredContent}`) and the
 *  previews a bare `{ok:true}`, so `ack.ok` read `undefined` after a write that had SUCCEEDED and
 *  `if (!ack.ok)` reported every success as a failure. The runtimes were brought to the contract
 *  rather than the contract to the runtimes (src/runtime-core.mjs `ackOf`, test/write-ack.mjs).
 *
 *  The fields mirror `ackSchema` in src/contracts.mjs, which is what the tools actually emit. They
 *  are optional because a refusal carries `reason`/`note` and no row, and a delete carries no row
 *  either — `ok` is what says which of those you are holding. The index signature stays: the ack
 *  is an open shape and a reader must not be stopped from looking at a key added since. */
export interface OmaAck {
  ok: boolean;
  /** The row this write was about — the id you just created, updated, moved or deleted. */
  id?: string;
  collection?: string;
  /** Where this write landed on the ledger, and where the collection stood just before it. */
  seq?: number;
  prev_collection_seq?: number;
  /** ONE key for the row, not two: on success the row as written, on a conflict the row as it
   *  actually stands — which is what the retry needs. Absent on a delete and on a bare refusal.
   *  `item.version` is the token an app keys its own echo on: remember it after a write and skip
   *  every change at or below it, and a two-way bridge stops overwriting what the user is typing. */
  item?: OmaItem;
  /** Present and true when the row is gone. */
  deleted?: boolean;
  /** Only on `ok:false`. A cancelled confirmation is `"confirmation_declined"`. */
  reason?: string;
  violations?: string[];
  /** Prose for a human, on either verdict. */
  note?: string;
  [key: string]: unknown;
}

/** What `oma.callFunction` resolves to — the tool's own outputSchema (tools/apps.mjs
 *  call_function), one field at a time. A REFUSAL is `{ok:false}` with a `reason`, not an
 *  exception; `null` means the call itself never produced structured content. */
export interface OmaFunctionCallResult<T = unknown> extends OmaAck {
  /** Whatever the body returned. Absent when the body returned nothing. */
  result?: T;
  /** Every write the body landed, receipted one by one — a call that timed out mid-body still
   *  reports the ones that committed. */
  writes?: Array<{ op: string; id: string; collection: string; seq: number; idempotent?: boolean }>;
  /** On `ok:false`: the names this app actually declares, when the refusal was an unknown one. */
  available?: string[];
  violations?: string[];
  note?: string;
}

export interface OmaEmbedOptions {
  into: Element;
  preset?: "live" | "inert";
  collection?: string;
  html?: string;
  caps?: Record<string, unknown>;
  tier?: string;
  /** `@live` only: fired on every switch. */
  onApp?: (name: string | null) => void;
  [key: string]: unknown;
}

export interface Oma {
  // ── the portable surface (19) — present in BOTH runtimes ────────────────────────────────────
  /** This contract's version. Adding a name does not bump it; feature-detect instead. */
  readonly contract: number;
  readonly state: OmaState;
  /** cb(state) once connected AND the first data has arrived — START HERE. Released after a
   *  deadline with an empty snapshot if the host never delivers, so it always fires. */
  ready(cb: (state: OmaState) => void): void;
  /** cb(state) after every change, including your own writes. */
  onChange(cb: (state: OmaState) => void): void;
  refresh(): Promise<OmaState | void>;

  addItem(item: { group?: string; fields?: Record<string, unknown>; position?: number }): Promise<OmaAck>;
  /** Shallow merge; a null value deletes that key. */
  updateItem(id: string, fields: Record<string, unknown>): Promise<OmaAck>;
  moveItem(id: string, group: string, position: number): Promise<OmaAck>;
  /** When confirm_delete is on, the shell asks the user and this resolves after they answer. */
  deleteItem(id: string): Promise<OmaAck>;
  /** Read ANY collection (full paged walk) without touching your own state. */
  readCollection(name: string): Promise<{ items: OmaItem[] } & Record<string, unknown>>;

  /** Escape hatch to the raw tool surface. */
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Run a function THIS app declares (manifest.functions) — data in, data out, engine-side.
   *  The type argument is what the BODY returns: `callFunction<{total:number}>("rsvp", {…})`.
   *  It is unchecked by construction (the body is text the engine ran, not code this project
   *  compiled) — it says what you expect, so the call site reads as data rather than as `any`. */
  callFunction<T = unknown>(fn: string, args?: unknown): Promise<OmaFunctionCallResult<T> | null>;

  /** Merged: your override ▸ global ▸ fallback. The fallback's TYPE coerces the stored value. */
  pref<T>(key: string, fallback: T): T;
  onPrefChange(cb: (change: { key: string; value: unknown; oldValue: unknown; scope: string }) => void): void;
  /** Your own settings only; scalars only. */
  setPref(key: string, value: string | number | boolean): Promise<OmaAck>;

  readonly files: OmaFiles;

  /** PROPOSES text into the chat — only on an explicit click. The host may run it, ask the user,
   *  or refuse it; it does NOT carry the user's authority. */
  sendMessage(text: string): Promise<unknown>;

  /** true in a plain browser page (no chat attached). */
  readonly standalone: boolean;
  /** Arguments of the call that mounted this widget. */
  readonly toolInput: Record<string, unknown> | null;

  // ── direct mode only (3) — `undefined` behind the sandboxed runner ──────────────────────────
  /** Mount another app inside this one (depth 1). `oma.embed("@live", …)` is the reserved name. */
  embed?(name: string, opts: OmaEmbedOptions): Promise<unknown>;
  /** Ask the host to open a URL. Resolves {ok:false} on a host that will not, never throws. */
  openLink?(url: string): Promise<{ ok: boolean }>;
  /** Base path for app→app links, default "/view/". */
  readonly viewBase?: string;
}

declare global {
  interface Window {
    oma: Oma;
  }
}

export {};
