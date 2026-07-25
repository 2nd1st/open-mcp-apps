// Minimal type surface for library consumers. Intentionally loose: the engine
// is plain ESM JavaScript; these declarations exist so TypeScript embedders get
// named-import resolution and basic signatures, not a full model of the store.

export interface EngineOptions {
  /** Fixed host label stamped on change events; when absent, derived per-session from the MCP initialize clientInfo. */
  hostLabel?: string;
  /** Replace the default initialize instructions wholesale (hosted deployments may need their own copy). */
  instructions?: string;
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

/** Idempotently install the built-in system components (settings/dashboard/gallery) into a store — embedders call this after openStore() to provision a fresh registry. */
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
