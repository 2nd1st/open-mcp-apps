// Minimal type surface for library consumers. Intentionally loose: the engine
// is plain ESM JavaScript; these declarations exist so TypeScript embedders get
// named-import resolution and basic signatures, not a full model of the store.

export interface EngineOptions {
  /** Fixed host label stamped on change events; when absent, derived from the caller's clientInfo —
   *  per-session from `initialize` up to MCP 2026-06-18, per-request from `_meta` on 2026-07-28+. */
  hostLabel?: string;
  /** Replace the MANUAL layer of the instructions (hosted deployments carry their own behaviour
   *  text). The engine-composed dynamic segments (onboarding vs inventory, proactivity stance,
   *  later the roster) cannot be removed: a manual carrying the placeholders
   *  (__ONBOARDING_OR_INVENTORY__, __PROACTIVITY_STANCE__) positions them; one that omits them
   *  gets them appended. */
  instructions?: string;
  /** Base URL of a browser viewer for this store (e.g. "http://127.0.0.1:8787"). When present,
   *  list_apps prints a real <viewBase>/view/<name> link per app; absent = no link. */
  viewBase?: string;
  /** Register the `call_function` seat. `false` (the default) = no seat, and the authoring guide
   *  says so rather than teaching a tool this deployment does not have. `true` / `{}` = the seat,
   *  with bodies on a local worker thread and the machine's own network — right for a local
   *  install, wrong for a multi-tenant plane. The object form carries the two seams a host needs:
   *  `egress` rewrites the body's `fetch` to speak to the host's own gateway (allowlist,
   *  private-address check and secret injection all live THERE, never here), and `executor`
   *  replaces where a body runs — a container, a socket, another machine — honouring
   *  `runFunctionBody`'s call/outcome shape. */
  functions?: boolean | {
    egress?: { gateway: string; token: string };
    executor?: (call: {
      body: string; app: string; fn: string; args: unknown; limitMs: number;
      dispatch: (method: string, payload: unknown) => unknown;
      egress?: { gateway: string; token: string };
    }) => Promise<FunctionOutcome>;
  };
  /** Dedicated origin for this deployment's widget sandbox. Feeds two wire keys whose hosts want
   *  incompatible values, so they can be set separately: `ui` → `_meta.ui.domain` (Claude; the bare
   *  host `{sha256(connector URL).hex[0:32]}.claudemcpcontent.com`, validated — a wrong value does
   *  not render, and a stdio connector has no URL to hash so it must not be set), `openai` →
   *  `_meta["openai/widgetDomain"]` (ChatGPT; a scheme-bearing origin the deployment owns, required
   *  to submit a plugin with UI and unique per plugin). A plain string sets both to that value.
   *  An omitted half leaves its key undeclared; a malformed shape throws. */
  widgetDomain?: string | { ui?: string; openai?: string };
  /** Tool names to register but NOT list. They stay callable through `tools/call`; they simply
   *  stop appearing in `tools/list` — for seats whose only real callers are widgets, on a
   *  deployment whose public tool list is read by people. The engine already hides every retired
   *  tool name it still answers to; this adds to that set, it does not replace it. Default `[]`,
   *  and an empty set leaves the wire byte-identical. */
  unlisted?: string[];
  /** Record the edit tripwire's JSONL sidecar beside the database. Default `true` — a local
   *  install measuring its own editing path, in a file the user can read and delete. `false`
   *  makes the recorder a no-op and the file is never created. */
  telemetry?: boolean;
  /** Register a per-app `open_<name>` tool for every app. When passed it decides; when omitted,
   *  `OMA_DYNAMIC_TOOLS=1` still does. Pass `false` explicitly on any deployment that has to be
   *  able to state what its tool list is — per-app openers make `tools/list` move whenever a user
   *  saves an app. */
  dynamicTools?: boolean;
}

/** What an `executor` resolves with — the same tagged shape `runFunctionBody` produces. An abort
 *  carries NO receipt: the store's refusal was minted by the engine, which still holds it. */
export type FunctionOutcome =
  | { kind: "value"; json: string | null }
  | { kind: "abort" }
  | { kind: "timeout" }
  | { kind: "threw"; detail: string }
  | { kind: "unserializable" }
  | { kind: "too_large"; size: number };

export interface Store {
  close(): void;
  /** Directory the db file lives in; the file backend roots per-app blobs at <dataDir>/files/. */
  dataDir: string;
  [key: string]: unknown;
}

/** One SQLite file = one isolation unit. Always pass an explicit absolute path in multi-tenant embeddings; no-arg falls back to OMA_DB or the fixed per-user default db. */
export function openStore(path?: string): Store;
export function defaultDbDir(): string;
export function defaultDbPath(): string;

/** Build a fully-wired McpServer over a store; connect it to any MCP transport. */
export function createEngine(store: Store, opts?: EngineOptions): unknown;

export function tierOf(author: string | null | undefined): "local" | "unreviewed";
export const RUNNER_REQUIRED_HTML: string;
/** Which collection an app opens on when the caller names none: the one collection its
 *  manifest declares, else its own name. Use it wherever you MOUNT an app, so an
 *  embedding shell binds by the same rule as open_app and the engine's own viewer. */
export function defaultCollectionFor(
  app: { name?: string; manifest?: string | null } | null | undefined,
): string | null;

/** Wrap app HTML into the final widget document (injects the oma runtime).
 * standalone (browser-viewer mode, no MCP host): endpoint/events default to "/rpc" and
 * "/events" — an embedding front door points them at its own same-origin proxy paths;
 * chrome:false renders the BARE widget (no viewer bar/stage) for shells that own the chrome;
 * viewBase is the app→app link base surfaced as window.oma.viewBase (default
 * "/view/") — an embedding shell points it at its own mount base.
 * tokens are the embedder's host design tokens, written after the neutral fallbacks so they
 * win: apps read the host token layer, so an embedder without one renders them foreign
 * to its own product. Custom-property names must match /^--[a-z][a-z0-9-]*$/ and values are
 * restricted to a CSS-value charset (no <, >, ;, braces, backslash); anything else throws. */
export function wrapApp(appHtml: string, opts?: {
  standalone?: { endpoint?: string; events?: string; collection?: string; app?: string; chrome?: boolean; viewBase?: string };
  app?: string;
  version?: number;
  tokens?: Record<string, string>;
}): string;
/** The universal-loader ui:// document served for the static open_app tool. */
export function wrapLoader(): string;

/** Per-store file channel (opaque user-file storage); memoized per store. */
export function openFileChannel(store: Store): unknown;

export const GUIDE: string;

/** Idempotently install the built-in system apps (settings/dashboard/app-store) into a store — embedders call this after openStore() to provision a fresh registry. Also retires seed-authored rows left behind by a system-app rename ("retired"/"kept"). */
export function seedSystemApps(store: Store, opts?: { log?: (line: string) => void }): Array<{
  name: string;
  action: "seeded" | "unchanged" | "skipped" | "retired" | "kept" | "conflict" | "error";
  version?: number;
  error?: string;
}>;

export const SCHEMA_VERSION: number;
export const APP_NAME_RE: RegExp;
export const SETTINGS_COLLECTION: string;
export const RESERVED_KEY_RE: RegExp;
export const MAX_ITEM_FIELDS_BYTES: number;
export const FILE_PATH_RE: RegExp;
export const MAX_FILE_BYTES: number;
export const MAX_FILE_INLINE_BYTES: number;
export const MAX_APP_FILE_BYTES: number;
export const MAX_APP_FILE_COUNT: number;
export const MAX_TOTAL_FILE_BYTES: number;
export const MAX_TOTAL_FILE_COUNT: number;

// ── the sandbox/preview machine (write-set D: src/runner.mjs, one copy) ──────────────────────

/** The canonical no-host design-token fallback stylesheet (what wrapApp injects). */
export const TOKEN_FALLBACK_CSS: string;
/** The system UI kit CSS (components/_system.css, MIT), read from disk on first call.
 *  wrapApp/wrapLoader inject it themselves; pass it to composePreviewDoc so a
 *  server-composed preview shows the same widget the runtime would. */
export function KIT_CSS(): string;
/** The kit as a head <style> with the data-oma marker every composer agrees on. */
export function kitStyle(css: string): string;
/** The child-document CSP as a <meta> tag (composeChildDoc puts it FIRST in head). */
export const RUNNER_CSP: string;
/** The same policy as a bare string — send it as an HTTP header on served preview documents. */
export const RUNNER_CSP_POLICY: string;
/** Host design-token custom-property names the machine re-emits into child documents. */
export const TOKEN_NAMES: string[];
/** The child mini-bridge script (window.oma proxy over postMessage, message keys omaRun*). */
export const BRIDGE: string;
/** CSP-first sandboxed child document: untrusted markup rides wholesale in OUR body. */
export function composeChildDoc(html: string, opts?: { tokenCss?: string; kitCss?: string; bridge?: string }): string;
/** A complete, self-contained INERT preview document (stub oma seeded with fixture items) —
 *  what a hosted /library preview server serves instead of keeping hand-synced copies. */
export function composePreviewDoc(html: string, opts?: { name?: string; items?: unknown[]; apps?: unknown[]; prefs?: Record<string, unknown>; tokenCss?: string; kitCss?: string }): string;
/** The inert stub window.oma script for a standalone preview document. */
export function stubOmaScript(name: string, items?: unknown[], apps?: unknown[], prefs?: Record<string, unknown>): string;
/** Build the parent-side caps chokepoint every sandboxed child call funnels through. */
export function makeGuard(cfg: {
  name: string;
  coll: string;
  caps?: Record<string, unknown>;
  tier?: string;
  preset?: "live" | "readonly" | "inert";
  io: Record<string, unknown>;
}): (method: string, args: Record<string, unknown>) => Promise<unknown>;
/** Walk file_read's byte windows; parts decode-and-concatenate byte-wise (never assume 3-alignment). */
export function readFileParts(
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  app: string,
  path: string,
): Promise<{ mime?: string; sha256?: string; size?: number; parts: string[] }>;
