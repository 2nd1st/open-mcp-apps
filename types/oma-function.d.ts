// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// oma-function.d.ts — types for the OTHER side of an app: the body of a declared function, which
// runs engine-side with no browser around it.
//
// Three type surfaces ship in this package and they never meet:
//   · index.d.ts          the engine's Node API (createEngine, openStore) — for an EMBEDDER
//   · types/window-oma    `window.oma`, inside the widget — for the app's UI code
//   · types/oma-function  `args` and `api`, inside a function body — for the app's back end
//
//     /// <reference types="@2nd1st/open-mcp-apps/types/oma-function" />
//
// WHAT A FUNCTION BODY IS, EXACTLY. The engine stores the body as the text of a
// `<script type="text/oma-function" data-fn="NAME">` block and runs it as
//
//     (async function (args, api) { "use strict"; …your body… })(args, api)
//
// (src/function-worker.mjs). So the body is an async function body with those two parameters in
// scope, it may `await`, and whatever it `return`s — JSON-serializable, 32 KB ceiling — is the
// reply. `OmaFunctionBody` below is that signature written down; a build step that emits bodies
// from typed source (see RUNTIME.md §6.1) can typecheck against it and emit the body alone.
//
// THE API IS SYNCHRONOUS AND IT IS NOT A PROMISE. `api.list(...)` returns rows, not a thenable,
// even though the rows cross a thread to get there — the worker blocks on Atomics while the
// engine answers. `await api.list(...)` is not wrong, it is just pointless.
//
// THERE IS NO api.delete, and its absence is a design decision rather than an omission:
// destructive verbs keep the engine's confirmation chokepoint, which a body cannot reach.

// TWO DOORS, ONE SET OF TYPES. The names below are declared GLOBALLY, because a function body is
// not a module — it imports nothing and cannot, so a type it can only reach through an import
// would be a type it can never use. They are re-exported at the bottom for anyone who would
// rather write `import type { OmaFunctionApi } from "@2nd1st/open-mcp-apps/types/oma-function"`,
// e.g. a build step that types bodies before emitting them.
//
// `args` and `api` are declared global too, and that is a deliberate, narrow cost: they are the
// two names the engine puts in a body's scope, so nothing else can be honest. A module that
// declares its own `args` or `api` at top level shadows them and is unaffected — which is every
// file in an ordinary app, since modules do not share the global scope.
declare global {

/** One stored row, as a function body sees it. Same shape `window.oma` reports, minus nothing. */
interface OmaFunctionItem {
  id: string;
  group: string;
  position: number;
  fields: Record<string, unknown>;
  version: number;
}

/** What a write answers with. `collection` is the one the write actually landed in — worth
 *  reading when you did not name one, since the default is the app's BOUND collection. */
interface OmaFunctionWriteAck {
  id: string;
  seq: number;
  collection: string;
}

interface OmaFunctionListOptions {
  /** Defaults to this app's bound collection — the same one its widget opens on. */
  collection?: string;
  group?: string;
  /** Field predicates. An unknown operator is REFUSED, never silently matched. */
  match?: Record<string, unknown>;
  limit?: number;
}

interface OmaFunctionAddRow {
  collection?: string;
  group?: string;
  fields: Record<string, unknown>;
  position?: number;
}

interface OmaFunctionUpdateRow {
  collection?: string;
  id: string;
  fields: Record<string, unknown>;
}

/** The five names a body is handed. An explicit list, not a filter: the sandbox contains exactly
 *  `args`, `api`, and the capabilities function-worker.mjs writes out (fetch, AbortController,
 *  AbortSignal, URL, URLSearchParams, setTimeout/clearTimeout, TextEncoder/TextDecoder,
 *  atob/btoa) — no require, no process, no module scope.
 *
 *  Every reachable collection is this app's own: the one it is BOUND to (its single declared
 *  collection, else its name) plus whatever else its manifest declares. Anything else refuses
 *  with `collection_not_allowed`, and `settings` refuses always. */
interface OmaFunctionApi {
  /** Rows, synchronously. Reads are budgeted (200 per call). */
  list(opts?: OmaFunctionListOptions): OmaFunctionItem[];
  /** How many rows, without carrying them. Omit the name for the bound collection. */
  count(collection?: string): number;
  /** Writes are budgeted (100 per call) and individually receipted — a call that dies mid-body
   *  leaves the writes that already landed, which is what the reply's `writes` array is for. */
  add(row: OmaFunctionAddRow): OmaFunctionWriteAck;
  /** Refuses `not_found` when the id is not in a collection this app may touch — membership is
   *  checked BEFORE the write, so a guessed id cannot reach another app's row. */
  update(row: OmaFunctionUpdateRow): OmaFunctionWriteAck;
  /** RESERVED AND REFUSING. The name exists so it cannot be squatted and so an author discovers
   *  it; credentials arrive in a later release, through the viewer's settings UI and never
   *  through a model-facing tool. Calling it throws. */
  secret(name?: string): never;
}

/** The signature the engine wraps a body in. Write your body as this function's body:
 *
 *      const rsvp: OmaFunctionBody<{ name: string; coming: boolean }, { total: number }> =
 *        (args, api) => {
 *          const existing = api.list({ match: { name: args.name } })[0];
 *          if (existing) api.update({ id: existing.id, fields: { coming: args.coming } });
 *          else api.add({ fields: { name: args.name, coming: args.coming } });
 *          return { total: api.count() };
 *        };
 *
 *  `Args` is whatever your manifest's `params` validate to; `Result` must be JSON-serializable
 *  and must fit 32 KB — a function fetches and DISTILLS. */
type OmaFunctionBody<Args = Record<string, unknown>, Result = unknown> =
  (args: Args, api: OmaFunctionApi) => Result | Promise<Result>;

/** The validated call arguments, in scope inside a body. `params` in the manifest is what the
 *  engine validates against; narrow it yourself at the top of the body, or type the whole body
 *  with OmaFunctionBody and let the parameter carry the shape. */
const args: Record<string, unknown>;
/** The data plane, in scope inside a body. See OmaFunctionApi. */
const api: OmaFunctionApi;

}

// The import door onto the same declarations.
export type {
  OmaFunctionItem, OmaFunctionWriteAck, OmaFunctionListOptions,
  OmaFunctionAddRow, OmaFunctionUpdateRow, OmaFunctionApi, OmaFunctionBody,
};
