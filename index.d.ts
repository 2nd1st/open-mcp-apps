// Minimal type surface for library consumers. Intentionally loose: the engine
// is plain ESM JavaScript; these declarations exist so TypeScript embedders get
// named-import resolution and basic signatures, not a full model of the store.

export interface EngineOptions {
  /** Fixed host label stamped on change events; when absent, derived per-session from the MCP initialize clientInfo. */
  hostLabel?: string;
  /** Replace the MANUAL layer of the instructions (hosted deployments carry their own behaviour
   *  text). The engine-composed dynamic segments (onboarding vs inventory, proactivity stance,
   *  later the roster) cannot be removed: a manual carrying the placeholders
   *  (__ONBOARDING_OR_INVENTORY__, __PROACTIVITY_STANCE__) positions them; one that omits them
   *  gets them appended. */
  instructions?: string;
  /** Base URL of a browser viewer for this store (e.g. "http://127.0.0.1:8787"). When present,
   *  list_components prints a real <viewBase>/view/<name> link per app; absent = no link. */
  viewBase?: string;
}

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
 *  #oma-manifest declares, else its own name. Use it wherever you MOUNT a component, so an
 *  embedding shell binds by the same rule as open_component and the engine's own viewer. */
export function defaultCollectionFor(
  component: { name?: string; manifest?: string | null } | null | undefined,
): string | null;

/** Wrap component HTML into the final widget document (injects the oma runtime).
 * standalone (browser-viewer mode, no MCP host): endpoint/events default to "/rpc" and
 * "/events" — an embedding front door points them at its own same-origin proxy paths;
 * chrome:false renders the BARE widget (no viewer bar/stage) for shells that own the chrome;
 * viewBase is the component→component link base surfaced as window.oma.viewBase (default
 * "/view/") — an embedding shell points it at its own mount base.
 * tokens are the embedder's host design tokens, written after the neutral fallbacks so they
 * win: components read the host token layer, so an embedder without one renders them foreign
 * to its own product. Custom-property names must match /^--[a-z][a-z0-9-]*$/ and values are
 * restricted to a CSS-value charset (no <, >, ;, braces, backslash); anything else throws. */
export function wrapComponent(componentHtml: string, opts?: {
  standalone?: { endpoint?: string; events?: string; collection?: string; component?: string; chrome?: boolean; viewBase?: string };
  component?: string;
  version?: number;
  tokens?: Record<string, string>;
}): string;
/** The universal-loader ui:// document served for the static open_component tool. */
export function wrapLoader(): string;

/** Per-store file channel (opaque user-file storage); memoized per store. */
export function openFileChannel(store: Store): unknown;

export const GUIDE: string;

/** Idempotently install the built-in system components (settings/dashboard/library) into a store — embedders call this after openStore() to provision a fresh registry. */
export function seedSystemComponents(store: Store, opts?: { log?: (line: string) => void }): Array<{
  name: string;
  action: "seeded" | "unchanged" | "skipped" | "error";
  version?: number;
  error?: string;
}>;

export const SCHEMA_VERSION: number;
export const COMPONENT_NAME_RE: RegExp;
export const MAX_COMPONENT_HTML: number;
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

/** The canonical no-host design-token fallback stylesheet (what wrapComponent injects). */
export const TOKEN_FALLBACK_CSS: string;
/** The system UI kit CSS (components/_system.css, MIT), read from disk on first call.
 *  wrapComponent/wrapLoader inject it themselves; pass it to composePreviewDoc so a
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
export function composePreviewDoc(html: string, opts?: { name?: string; items?: unknown[]; tokenCss?: string; kitCss?: string }): string;
/** The inert stub window.oma script for a standalone preview document. */
export function stubOmaScript(name: string, items?: unknown[]): string;
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
  component: string,
  path: string,
): Promise<{ mime?: string; sha256?: string; size?: number; parts: string[] }>;
