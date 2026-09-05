// Type surface for the `@2nd1st/open-mcp-apps/functions` subpath — the function pillar's seam.
//
// A SEPARATE file from index.d.ts on purpose: this is a different entry point with a different
// audience. index.d.ts types the engine's Node API (`openStore`, `createEngine`, the runtime and
// preview machinery); this types what a HOST that runs function bodies somewhere else imports —
// `runFunctionBody` as the shape its own executor must honour, and `FnAbort` for a dispatch it
// writes itself. Pointing the subpath's `types` at index.d.ts would have meant declaring
// `runFunctionBody` as a root export, which it is not: `import { runFunctionBody } from
// "@2nd1st/open-mcp-apps"` typechecks nowhere and fails at runtime.
//
// Loose in the same way index.d.ts is loose: the engine is plain ESM JavaScript and these
// declarations exist so a TypeScript embedder gets named-import resolution and the seam's
// signatures, not a full model of the store.

/** What a body's run resolves with — the tagged shape `runFunctionBody` produces and any
 *  `executor` must too. An abort carries NO receipt: the store's refusal was minted by the engine,
 *  which still holds it (a receipt that crossed a wire is a shape the far side could author).
 *  Kept identical to `FunctionOutcome` in index.d.ts, which is the same union seen from the
 *  `createEngine({ functions: { executor } })` side. */
export type FunctionOutcome =
  | { kind: "value"; json: string | null }
  | { kind: "abort" }
  | { kind: "timeout" }
  | { kind: "threw"; detail: string }
  | { kind: "unserializable" }
  | { kind: "too_large"; size: number };

/** The two fields a host hands its own egress gateway. The engine carries no egress POLICY — no
 *  allowlist, no private-address check, no secret store; those live in the gateway. */
export interface FunctionEgress {
  gateway: string;
  token: string;
}

/** Everything one call hands the thing that runs a body. `dispatch` is the store, and it MAY be
 *  async (a remote executor's round trip is a network hop); it throws for a refusal. */
export interface FunctionCall {
  body: string;
  app: string;
  fn: string;
  args: unknown;
  limitMs: number;
  dispatch: (method: string, payload: unknown) => unknown;
  egress?: FunctionEgress;
}

/** The `functions` seat of `createEngine`, written out as one name because a host configuring a
 *  deployment reasons about the whole value: `false` (the default — no `call_function` tool at
 *  all), `true` (bodies on a local worker thread, the machine's own network), or the object form
 *  carrying either seam. */
export type FunctionsSeat =
  | boolean
  | {
      egress?: FunctionEgress;
      executor?: (call: FunctionCall) => Promise<FunctionOutcome>;
    };

/** A store refusal raised inside a body's round trip, carrying the store's own answer.
 *
 *  Exported for a host that writes its own `dispatch` in this process. A host whose dispatch
 *  crossed a wire does not need it: the engine recognises a refusal by SHAPE — anything thrown
 *  with a `receipt` whose `error` is a string. */
export class FnAbort extends Error {
  constructor(receipt: { error?: string; [key: string]: unknown });
  receipt: { error?: string; [key: string]: unknown };
}

/** Run one body on a worker thread of its own and end the thread, whatever happens. Never rejects:
 *  every way a run can end is one of `FunctionOutcome`'s tags, because a call that produced no tag
 *  would hang the tool handler. This is both the default executor and the written-out contract an
 *  `executor` replaces. */
export function runFunctionBody(call: FunctionCall): Promise<FunctionOutcome>;

/** Build the engine-side function host over one store: budgets, receipts, derived command ids, the
 *  `via` stamp and the abort vocabulary all stay here, whichever side of the seam the body runs on.
 *  `call` returns store-style results and never throws for a caller mistake. */
export function makeFunctionHost(
  store: unknown,
  opts?: { executor?: (call: FunctionCall) => Promise<FunctionOutcome>; egress?: FunctionEgress },
): {
  call(args: {
    app: string;
    function: string;
    args?: unknown;
    actor?: string;
    host?: string | null;
    command_id: string;
  }): Promise<Record<string, unknown>>;
};

/** Pull every body block out of a document. */
export function extractFunctionBodies(
  src: string,
): { ok: true; bodies: Record<string, string> } | { ok: false; error: string; detail: string };

/** The save-door JOIN: a human sentence when the document and the manifest disagree about which
 *  functions exist, or `null` when they agree. */
export function functionsJoinError(
  manifest: { functions?: Record<string, unknown> } | null | undefined,
  ui: string | null | undefined,
): string | null;

/** The canonical opening of a body block, written out so a grep in an app finds what the engine
 *  looks for. */
export const FUNCTION_OPEN_PREFIX: string;
export const FN_NAME_RE: RegExp;
export const MAX_FUNCTION_BODY: number;
export const MAX_FUNCTIONS: number;
/** The DEFAULT wall clock for a body that declares no `timeout_ms`. Not a ceiling — this engine
 *  puts none; `FN_TIME_TIMER_MAX_MS` is a mechanism bound (Node's 32-bit timer), not a policy. */
export const FN_TIME_BUDGET_MS: number;
export const FN_TIME_TIMER_MAX_MS: number;
export const FN_WRITE_BUDGET: number;
export const FN_READ_BUDGET: number;
export const MAX_FUNCTION_RESULT: number;
/** Per PROCESS, not per engine: threads are a process resource. */
export const MAX_CONCURRENT_FUNCTION_CALLS: number;
export const SECRETS_RESERVED_NOTE: string;
