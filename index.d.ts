// Minimal type surface for library consumers. Intentionally loose: the engine
// is plain ESM JavaScript; these declarations exist so TypeScript embedders get
// named-import resolution and basic signatures, not a full model of the store.

export interface EngineOptions {
  /** Fixed host label stamped on change events; when absent, derived from the caller's clientInfo —
   *  per-session from `initialize` up to MCP 2026-06-18, per-request from `_meta` on 2026-07-28+. */
  hostLabel?: string;
  /** Replace the MANUAL layer of the instructions (hosted deployments carry their own behaviour
   *  text). The two engine-composed segments (onboarding vs inventory, proactivity stance) appear
   *  where the manual carries their placeholders (__ONBOARDING_OR_INVENTORY__,
   *  __PROACTIVITY_STANCE__); a manual that omits a placeholder omits that segment. */
  instructions?: string;
  /** Base URL of a browser viewer for this store (e.g. "http://127.0.0.1:8787"). When present,
   *  list_apps prints a real <viewBase>/view/<name> link per app; absent = no link. */
  viewBase?: string;
  /** Register the `call_function` seat. `false` (the default here; the npx server and viewer pass
   *  `true` unless OMA_FUNCTIONS=0) = no seat, and the authoring guide
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
  /** Where widgets may load from. Default: the platform base (CDN script hosts and Google Fonts),
   *  widened by each app's manifest.csp and the user's `policy:csp:*` rows. A hosted plane passes
   *  `extensible: false` (and its own `base` if it needs one) so every widget's network policy is the
   *  operator's one statement. A malformed `base` throws. */
  csp?: { base?: CspDomains; extensible?: boolean };
  /** Tool names to register but NOT list. They stay callable through `tools/call`; they simply
   *  stop appearing in `tools/list` — for seats whose only real callers are widgets, on a
   *  deployment whose public tool list is read by people. Default `[]`, and an empty set leaves
   *  the wire byte-identical. */
  unlisted?: string[];
  /** Allow PINNED apps their own `open_<name>` tool. Default `true`: an app the user pins in the
   *  settings app (settings key `open_tool`, group = the app's name) gets one, every other app opens
   *  through `open_app`, and `tools/list` moves only when the user pins, unpins or deletes a pinned
   *  app. `false` = never any per-app tool and a constant `tools/list` — pass it on any deployment
   *  that has to be able to state what its tool list is. */
  dynamicTools?: boolean;
  /** WHO is calling — an identity the deployment authenticated. Every write made on this engine
   *  (its own store, or another account's through a share) carries `principal` in the ledger,
   *  stamped server-side; no argument can set it. Absent ⇒ nothing is stamped. */
  caller?: Caller;
  /** What other accounts shared with the caller. Present ⇒ `@owner/name` handles resolve in every
   *  tool, re-read on every call. Requires `caller`. Adds no tool. */
  mounts?: MountsProvider;
  /** The caller's own shares. Present ⇒ the `share` and `copy_app` tools are registered (after
   *  every other tool). Requires `mounts`. */
  sharing?: SharingProvider;
}

// ── cross-account sharing (src/sharing.mjs carries the same contract as JSDoc) ────────────────
export type ShareRole = "viewer" | "editor";

export interface Caller {
  /** Stable account id (e.g. the identity provider's user id); opaque, compared for equality. */
  principal: string;
  /** What a person reads for this account (an email). Display only. */
  label?: string;
}

/** One app another account shared with the caller, as the deployment's records say right now. */
export interface Grant {
  /** Caller-side name for the owner: the `leo` in `@leo/trips`. /^[a-z0-9][a-z0-9-]{0,23}$/,
   *  unique per (caller, owner); every grant from one owner carries the same alias. */
  alias: string;
  /** Opaque id of the owner's store. Grants sharing an alias must share an owner, or the alias is
   *  treated as not shared at all. */
  owner: string;
  ownerLabel: string;
  /** The app's name in the owner's store. */
  app: string;
  /** The owner store's appBirth(app) at share time (handed to SharingProvider.invite). A grant whose
   *  app was since deleted or recreated reaches nothing and is reported via MountsProvider.ended. */
  appBirth: number;
  role: ShareRole;
  /** The owner's store, acquired lazily (at most once per owner per tool call). */
  store(): Store;
}

export interface MountsProvider {
  /** Every ACTIVE grant held by THIS caller — asked once per tool call, never cached by the engine. */
  grants(): Grant[] | Promise<Grant[]>;
  /** Optional: grants the engine found dead (app deleted or reborn); the deployment closes them. */
  ended?(dead: Array<{ alias: string; owner: string; app: string; appBirth: number }>): void;
}

export type ShareFailure = { ok: false; error: string; detail?: string };
export interface ShareLink {
  id: string;
  app: string;
  role: ShareRole;
  access: "restricted" | "anyone";
  /** Who may claim it (restricted); [] for anyone. */
  accounts: string[];
  /** The claim URL — on invite, and on list while the link is live. */
  url?: string;
  expires_at?: string;
  revoked?: boolean;
}
export interface GrantInfo {
  app: string;
  /** The grantee's label. */
  account: string;
  role: ShareRole | "owner";
  since?: string;
}

export interface SharingProvider {
  /** Make a claim link. restricted: only `accounts` (lower-cased emails) may claim; anyone: whoever
   *  holds it may. Claimants sign in; a claim becomes an account × role grant. */
  invite(req: { app: string; appBirth: number; role: ShareRole; access: "restricted" | "anyone"; accounts: string[] }):
    Promise<{ ok: true; link: ShareLink } | ShareFailure>;
  /** `{app?}`: the caller's own shares. `{alias, app}`: participants of an app shared WITH the caller. */
  list(req: { app?: string } | { alias: string; app: string }):
    Promise<{ ok: true; links: ShareLink[]; grants: GrantInfo[] } | ShareFailure>;
  /** `link`: stop new claims on it (existing grants stay). `accounts`: end their grants on the app. */
  revoke(req: { app: string; link?: string; accounts?: string[] }): Promise<{ ok: true; revoked: number } | ShareFailure>;
  setRole(req: { app: string; accounts: string[]; role: ShareRole }): Promise<{ ok: true; changed: number } | ShareFailure>;
  /** The CALLER gives up a grant they hold. */
  leave(req: { alias: string; app: string }): Promise<{ ok: true } | ShareFailure>;
  /** Optional audit hook: the caller copied a shared app into their own store. */
  copied?(req: { alias: string; owner: string; app: string; as: string; with_data: boolean }): void;
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

/** A widget network policy, in the MCP Apps `_meta.ui.csp` shape. */
export interface CspDomains {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
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
 * chrome:false renders the BARE widget (no viewer bar/card) for shells that own the chrome;
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
/** The page base every composed document carries besides the tokens: box-sizing, body
 *  margin/font/colour from the tokens, a `[hidden]` that stays hidden, and the --oma-safe-*
 *  variables defined to 0. No layout. wrapApp/wrapLoader inject it themselves; pass it to
 *  composePreviewDoc so a server-composed preview shows the same widget the runtime would. */
export const BASE_CSS: string;
/** The base as a head <style> with the data-oma marker every composer agrees on. */
export function baseStyle(css: string): string;
/** The child-document CSP as a <meta> tag (composeChildDoc puts it FIRST in head). */
export const RUNNER_CSP: string;
/** The same policy as a bare string — send it as an HTTP header on served preview documents. */
export const RUNNER_CSP_POLICY: string;
/** Host design-token custom-property names the machine re-emits into child documents. */
export const TOKEN_NAMES: string[];
/** The child mini-bridge script (window.oma proxy over postMessage, message keys omaRun*). */
export const BRIDGE: string;
/** CSP-first sandboxed child document: untrusted markup rides wholesale in OUR body. */
export function composeChildDoc(html: string, opts?: { tokenCss?: string; baseCss?: string; fallbackCss?: string; bridge?: string }): string;
/** A complete, self-contained INERT preview document (stub oma seeded with fixture items) —
 *  what a hosted App Store preview server serves instead of keeping hand-synced copies. */
export function composePreviewDoc(html: string, opts?: { name?: string; items?: unknown[]; apps?: unknown[]; prefs?: Record<string, unknown>; tokenCss?: string; baseCss?: string; csp?: CspDomains }): string;
/** The inert stub window.oma script for a standalone preview document. */
export function stubOmaScript(name: string, items?: unknown[], apps?: unknown[], prefs?: Record<string, unknown>): string;
/** Build the parent-side caps chokepoint every sandboxed child call funnels through. */
export function makeGuard(cfg: {
  name: string;
  coll: string;
  caps?: Record<string, unknown>;
  tier?: string;
  preset?: "live" | "inert";
  io: Record<string, unknown>;
}): (method: string, args: Record<string, unknown>) => Promise<unknown>;
/** Walk file_read's byte windows; parts decode-and-concatenate byte-wise (never assume 3-alignment). */
export function readFileParts(
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  app: string,
  path: string,
): Promise<{ mime?: string; sha256?: string; size?: number; parts: string[] }>;
