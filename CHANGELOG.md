# Changelog

Notable changes to open-mcp-apps. Releases are curated snapshots — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for what that means.

This project follows [semantic versioning](https://semver.org/). While the major
version is `0`, the engine's public API may still change between minor releases;
each such change is called out here.

## 0.7.0 — 2026-09-05

**Getting the contract straight before a directory carries it.** Submitting to a host's app
directory turns tool metadata into a published, versioned contract, so this release spends the
last cheap window on the things that stop being cheap afterwards: seven tools renamed to lead
with a verb, with the old names still answering as unlisted aliases; annotations that say what
each tool actually does; and `open_app` back to the pure read its `readOnlyHint` claims. Beside
that, the `functions` seat grew the two seams a host needs to run bodies somewhere other than
in-process — an egress gateway the body's `fetch` speaks to, and a replaceable executor — and a
hosted deployment can now settle its own public face (which tools are listed, whether telemetry
is recorded, which widget domain each host is told) through `createEngine` rather than through
environment variables. `oma.contract` stays 3: the runtime an app talks to is unchanged, and
every change here is on the tool wire or on the host's side of it.

### Breaking

- **Seven tools were renamed to lead with a verb.** The old names still work — they are registered
  as aliases onto the same handlers, with the same schemas and annotations — but they are no
  longer listed, so nothing written against today's `tools/list` learns them. An app saved before
  this release keeps calling the name it was written with.

  | was | is |
  |---|---|
  | `app_html` | `get_app_html` |
  | `app_history` | `list_app_checkpoints` |
  | `data_batch` | `apply_data_writes` |
  | `data_version` | `get_data_version` |
  | `data_collections` | `list_data_collections` |
  | `ui_prefs_schema` | `get_ui_preference_schema` |
  | `app_store_preview` | `preview_app_store_entry` |

  The timing is the whole reason it is happening now: a directory listing turns tool metadata into
  a versioned contract, and after the first submission a rename stops being a rename and becomes a
  breaking change to a published integration. This is the last window in which it is cheap. Both
  runtime guards canonicalise a name before deciding what it may do, so a retired spelling meets
  exactly the same wall as the current one.

### Added

- **`createEngine(store, { telemetry })` and `{ dynamicTools }`.** Two things a local install and a
  hosted deployment should be able to answer differently, and until now only an environment
  variable could answer either. `telemetry` defaults to `true` — the edit tripwire's JSONL sidecar,
  beside the database, on the user's own machine — and `false` makes the recorder a no-op so the
  file is never created (declining a collection has to mean no bytes, not bytes nobody reads).
  `dynamicTools` decides the per-app `open_<name>` openers when it is passed and leaves
  `OMA_DYNAMIC_TOOLS` in charge when it is not: an env flag is the right control for a person
  running this locally and the wrong one for a deployment that has to be able to state what its
  tool list is, since a per-app opener makes `tools/list` move whenever a user saves an app.

- **`createEngine(store, { unlisted })` registers a tool without listing it.** The names it is
  given stay reachable through `tools/call` and disappear from `tools/list` — which is what a
  deployment needs for the four seats whose only real callers are widgets (`get_app_html`,
  `preview_app_store_entry`, `get_ui_preference_schema`, `security_set`), whose descriptions say
  "internal" and which a person reading a public tool list should not have to discount. The engine
  puts every retired tool name in the same set unconditionally. Default `[]`, and with an empty set
  the filter is not installed at all: the wire is byte-identical to a build that never had the
  option, which is what the tool-surface golden checks.

- **The `functions` seat grew two seams for hosts that do not want same-process execution.**
  `createEngine(store, { functions })` still takes `false` (the default — no `call_function`) and
  `true` (the local product's shape: bodies on a worker thread, the machine's own network). It now
  also takes an object with either or both of:
  - `egress: { gateway, token }` — the body's `fetch` is rewritten, inside the worker, to speak to
    that gateway (`POST <gateway>/egress`, the target in `X-Egress-Url`, the tenant's token in
    `X-Egress-Token`, the body's own headers and method passed through, redirects left for the
    gateway to follow). A response carrying `X-Egress-Error` rejects with `egress_denied: <code>`,
    so a refusal reaches the body as a failed fetch rather than a silent hole. The wrapper is
    installed on the sandbox's `fetch` **and** the worker realm's `globalThis.fetch`, because
    `vm` is an isolation seam and not a hardened boundary — it is depth, not the boundary. The
    engine ships **no allowlist and no policy**: what a gateway permits is the host's to decide,
    on a network the host owns.
  - `executor` — where a body runs. Anything honouring the call/outcome shape of the newly
    exported `runFunctionBody` (`src/functions.mjs`, also reachable as the package subpath
    `@2nd1st/open-mcp-apps/functions`) can replace the local worker: a container, a socket,
    another machine. Everything belonging to the store stays on the engine's side of it — budgets,
    receipts, derived command ids, the `via` stamp, the abort vocabulary — so a remote executor
    reports the *fact* of a store refusal and the engine reads back the receipt it minted itself.
    The parent's message pump now tolerates an async `dispatch`; the synchronous local path is
    unchanged, byte for byte. A refusal is recognised by **shape** — anything thrown with a
    `receipt` whose `error` is a string — so a host that moves `dispatch` across a wire too can
    rebuild one on the far side without this module's class; that class (`FnAbort`) is exported as
    well, for the callers that can hold it, and identity is still tried first.

  The subpath ships **types** of its own (`functions.d.ts`): `runFunctionBody`'s signature, the
  `FunctionOutcome` union an executor must resolve with, `FunctionCall`, `FunctionEgress`,
  `FunctionsSeat` and `FnAbort`. A separate file from `index.d.ts` because it is a separate entry
  point with a separate audience — pointing the subpath's `types` at `index.d.ts` would have
  declared `runFunctionBody` a root export, which it is not. A `.d.ts` has three homes (the exports
  map, `files`, and the publish allowlist npm packs from) and an invariant now derives all three
  from the exports map rather than trusting a list.

  A malformed seat throws a `TypeError` from `createEngine` instead of degrading, because the
  failure it would otherwise produce is silent: a host that meant to hand over a gateway and
  mistyped a key would get same-process execution with the machine's own network. Neither seam
  moves `oma.contract`, adds an environment flag, or changes anything an app or a host can see —
  the local entrypoints keep passing `true` and behave exactly as before.

- **`install_from_app_store` says which of the three things happened.** Its reply carries
  `outcome: "installed" | "updated" | "current"`. The `updated` boolean it already had could name
  only two of the three — it is `!!cur`, so a first install and an already-current one both report
  `false` — and the difference lived nowhere but the human sentence, which itself said "Installed"
  for an app the user already had. Now the sentence follows the outcome and the structured field
  says the same thing, so a model reading the text and a caller reading the field are not told
  different things. `updated` is unchanged and still there; nothing has to be migrated.

### Changed

- **`createEngine(store, { widgetDomain })` takes the two wire keys apart.** It fed
  `_meta.ui.domain` and `_meta["openai/widgetDomain"]` the same string, which is only harmless
  while a deployment faces one host: Claude wants the bare host
  `{sha256(connector URL).hex[0:32]}.claudemcpcontent.com` and validates it — a wrong value is
  `Invalid ui.domain format` and the app does not render — while ChatGPT wants a scheme-bearing
  origin the deployment owns (`https://example.com`), required to submit a plugin with UI and
  unique per plugin. No one string is both. The option now also accepts
  `{ ui?, openai? }`, each half feeding only its own key and an omitted half declaring nothing;
  a plain string still writes both, byte for byte as before, and a malformed shape throws a
  `TypeError` at construction rather than silently declaring neither. A local stdio install has no
  URL to hash and should keep setting neither. Evidence and the host quotes:
  `docs/host-policies-2026-09-03.md`.
- **Instructions, tool descriptions and empty-state notes are now statements of what this server
  does, not directions to the model.** Three shapes came out of every model-visible string, because
  the app-directory rules of both hosts name all three: text asking the model to draw on its memory
  or on past conversations (the onboarding hook, `data_list` and `data_collections` empty-state
  notes, `install_from_app_store`'s and `data_batch`'s descriptions); text placing this server
  ahead of other tools or connectors (INSTRUCTIONS' opening line, the "get_app_guide FIRST" and
  "prefer opening it" lines); and descriptions telling the model how to behave rather than what a
  tool does (`get_app_guide`, `list_apps`, `open_app`, `data_version`, `file_write`), including
  `get_app`'s account of why reads are windowed, which described the failure as a host defect.
  Nothing about the wire shape changed — same 33 tools, same names, same schemas, same response
  fields — and the retrieval vocabulary the returning-user segment exists for (trackers, boards,
  logs, budgets, reading lists…) is kept word for word.
- **A hosted `instructions` override that omits a placeholder now omits that segment.** It used
  to be appended instead, which meant a deployment carrying its own manual had no configuration by
  which to drop the engine's onboarding or proactivity prose. Positioning still works the same way
  — a manual carrying `__ONBOARDING_OR_INVENTORY__` / `__PROACTIVITY_STANCE__` gets them filled in
  place — and the engine's own default manual, which carries both, is unaffected.
- **Annotations say what the tools actually do.** The read preset now declares
  `destructiveHint: false` and `idempotentHint: true` — the MCP spec gives those meaning only when
  `readOnlyHint` is false, but a form that asks for three values per tool reads an absent field as
  "not assessed" rather than "not applicable". `call_function` moves off the ordinary write preset
  onto `destructiveHint: true` + `openWorldHint: true`: the body is the app author's code and it
  holds `fetch`, so it is the one seat whose effects can land outside this store, and its
  description now says so.

- **`security_set` is no longer advertised as widget-callable, and the two gates are now stated as
  two gates.** `openai/widgetAccessible: true` is the HOST gate — "the top-level widget you
  rendered may call this back" — and the control-plane list is the NESTING gate — "an app embedded
  inside another app may never reach this". They answer different questions, so a name on both is
  the ordinary shape of a first-party system app: the App Store app may install at the top level,
  and no nested child may install anything. Three App Store seats sit on both lists on purpose
  (`app_store_list`, `preview_app_store_entry`, `install_from_app_store`) and a test pins the
  overlap to exactly those three. `security_set` is the one name that came off the host gate, and
  the reason is in kind rather than in degree: it rewrites the policy the other walls are made of,
  and it has no widget caller at all — the settings pane drives it through the direct runtime's
  passthrough. The policy file's own claim was corrected in the same pass: the control-plane list
  is enforced at ONE chokepoint (the runner guard), not two — the direct runtime never consulted
  it, which is deliberate (it mounts local-authored documents only) and was simply described
  wrongly.

- **The live pointer moved from "the model opened it" to "a host rendered it".** `open_app` and the
  per-app `open_<name>` tools declare `readOnlyHint: true` and now deserve it: neither writes any
  more. The record of which app is on screen — the row the `@live` wall display follows — is
  written on the two paths that witness a render, and nowhere else:

  - a host READING an app's per-app `ui://` resource, which is the fetch it makes to put that
    widget in front of somebody;
  - the universal loader calling `get_app_html {name, mount: true}`. The loader resource is one
    document for every app, so it cannot witness anything by being read — which app it is about to
    mount is known only to the loader itself, on the one call that carries the name. `mount` is a
    claim the caller opts into: an ordinary refetch and the `@live` brick reading the app it FRAMES
    both leave it unset, so a wall cannot re-elect whatever it is already showing.

  Together they close the hole the first path left: with the per-app openers off — the hosted
  shape — a chat host used to move nothing at all, and an `@live` wall stayed dark. A host that
  caches the per-app resource still records the first render and not the repeats. The price of the
  second path is one honest annotation: `get_app_html` no longer claims `readOnlyHint: true`, since
  a tool that writes a row naming an app is not that. It is an internal, widget-only seat that
  hosted deployments leave unlisted, so no model-facing behaviour changes. A display app records
  nothing on either path — a frame must not aim the wall at itself, whichever door it was mounted
  through.

- **Tool results stopped carrying the engine's own bookkeeping.** Three fields, three reasons:
  `edit_app`'s success message no longer splices in a telemetry milestone (an internal edit
  counter, a local script path and a maintainer's name, in the model's context, on somebody
  else's machine — the tripwire's data still lands in the sidecar beside the database, which is
  where an instrument belongs); `open_app`'s sentence no longer recites the store's global ledger
  `seq`, the number that makes a user who edited an app twice wonder why it jumped from 5 to 43;
  and `host` — the caller's own client name, a provenance annotation for the ledger — left
  `open_app`, the per-app openers, `data_list` and the shared snapshot schema. Its only real
  reader is `oma.state.host` inside a widget, so it now rides `get_app_html`, the widget-only
  channel the loader already fetches on mount. Nothing an app can see changed.

- **`apply_data_writes` (was `data_batch`) no longer carries deletion.** Its `type` is a declared
  enum of `add_item | update_item | move_item`, so a delete cannot be expressed on the seat at all
  and `destructiveHint: false` is a claim the wire enforces. Row deletion goes through
  `data_delete_item`, where the confirmation gate can pin one row — which is why a batch could
  never confirm properly in the first place. The batch's two-phase confirmation fields
  (`request_state`, `expires_at`, `preview`) left the output schema with the verb that needed
  them. The store's own batch-delete path and its confirmation semantics are unchanged.

### Fixed

- **The authoring guide follows the seat.** `get_app_guide {topic: "functions"}` on a deployment
  that registers no `call_function` used to teach the whole pillar in detail — a chapter and a
  tool list that disagreed, with the chapter being the one an author reads. It now says plainly
  that this host runs no functions, and what the save door still does with a declaration
  (`manifest.functions` is validated and stored, and the declaration↔body pairing is still
  enforced — it simply never runs). The `basics` chapter's directory line follows. With `egress`
  configured, the functions chapter also states that a fetch outside the host's allowlist rejects.

## 0.6.0 — 2026-09-02

**The engine becomes a runtime, not just a container.** One release, built over two weeks
(plan: engine repo `docs/runtime-plan-2026-08-16.md`, internal): apps written outside a chat
and installed from a file, functions that run on their own thread and reach the network, widgets
that declare what they connect to, and the author-side kit those three make possible.
`oma.contract` is 3 — see **Fixed** for the one change an existing app can notice.

### Changed

- **An app document has no size cap.** The 200,000-unit write-side ceiling (`MAX_APP_HTML` and
  the `ui_too_large` refusal behind it) is gone — from the store, from `install-app.mjs`, and
  from the package barrel. The only size that ever did load-bearing work is on the READ side,
  where `get_app` returns the source in windows, so a large app now costs windows rather than a
  refusal. `empty_ui` stays: it is a validity rule (an app is something a person opens), never a
  size floor. The `/rpc` and `/mcp` request-body limit moves 2 MB → 64 MB and is named
  `MAX_BODY_BYTES`, because it is transport self-defence and was never a statement about how big
  an app may be.
- **App functions run on a worker thread, not a synchronous `vm` closure.** A body may
  `await`; the store stays synchronous to it (`api.list(...)` returns rows) over a blocking
  cross-thread call. The time budget is enforced by `worker.terminate()`, which ends running code,
  pending timers and in-flight sockets — a harder cancel than `vm`'s timeout, which could only
  interrupt code it was running. Every function written for the old executor runs unchanged; the
  `async_not_supported` error is gone (a returned promise is awaited). Default per-call wall clock
  2 s → 10 s, sized for one HTTPS round trip; the other budgets (100 writes, 200 reads, 32 KB
  result) are unchanged. Up to 8 calls run concurrently; further calls queue without burning their
  own deadline. `src/functions.mjs`'s header now says why the old "synchronous is the contract" argument
  was right then and what replaces it — including the one property that was given up (no work
  after the window) and why the receipts already covered it.
- **A per-app `ui://` resource's `_meta.ui.csp`** (and the `openai/widgetCSP` twin) is computed
  per read from the app's declaration ∪ the user's additions, instead of a constant empty
  allowlist. The engine adjudicates nothing: it merges and relays; hosts enforce. An app that
  declares nothing produces byte-identical metadata to 0.5.9. The engine's own two policies — the
  runner child's CSP meta and the `/view` response header — are built from that same merged
  declaration, so an app that works in a host works in the browser viewer; both floors are
  unchanged byte for byte. `app_html` returns the merged `csp`, which is how the loader gives a
  sandboxed child its policy.
- **An app whose `ui` carries asset references is read-only to the model**: `get_app` returns
  the template, while `edit_app`, the model's `save_app`, `restore_app` and `promote_app` refuse
  with `built_outside` ("source lives outside this store; rebuild and re-install with
  install-app.mjs"). Rebuilding and re-pushing is the edit. Detection is structural — what the
  stored document is, never an `author` string. Human-pushed apps keep no version stock: after a
  human push onto a human-authored app, revisions older than 7 days (`HUMAN_HISTORY_KEEP_DAYS`)
  are dropped; the current revision is never swept, and AI-authored apps keep everything.
  `save_app` refuses `bad_asset_ref` for a reference the file plane could never store; existence
  is deliberately not checked at save (a push is two writes and either order must work) — a
  missing asset is reported loudly, in the widget, at serve time.
- **The authoring guide's "keep it under ~100KB" is advice again**, and now says what it was
  actually about: do not write a complex app in one shot — save a skeleton, then grow it with
  `edit_app`; data belongs in the collection; source is read in windows.

### Added

- **`fetch` in function bodies**, with `AbortController`/`AbortSignal`, `URL`,
  `URLSearchParams`, `setTimeout`/`clearTimeout`, `TextEncoder`/`TextDecoder`, `atob`/`btoa`.
  Egress is not filtered: the engine runs on the user's own machine over the user's own network.
  The worker has an empty `env` and its own 256 MB heap, and its stdout never reaches the parent's
  (which, on the stdio transport, is the protocol channel).
- **`manifest.functions[name].timeout_ms`** — a per-function deadline, declared where the signature
  is. The engine sets **no policy ceiling** on it: the real limit is the host's own tool-call
  timeout, since `call_function` is an MCP tool call the host waits on — past it the body only spins
  against a result nobody reads. The default, when nothing is declared, is 10 s. The save door keeps
  only a sanity floor (a positive integer the timer can hold), not a cap on how long a function may
  run. The deadline covers the whole call — thread start, body, and every await inside it — and is
  enforced by `worker.terminate()`, the cancel that keeps a runaway loop or a hung fetch from pinning
  a worker slot. (A SaaS sandbox that wants a cap sets its own; the OSS engine does not.)
- **Secrets are reserved, not delivered**: `api.secret` exists and refuses, and settings keys under
  `secret:` are refused by the generic `data_*` writers and by `security_set` alike — the namespace
  is held empty for the release that fills it (entry will be the viewer's settings UI, never a
  model-facing tool).
- **Apps can declare where they reach.** A manifest may carry `csp` with the four keys from the
  MCP Apps spec — `connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains` —
  validated for shape at the save door (RUNTIME.md §5.1). Users can add origins of their own, per
  app or globally, through the reserved settings keys `policy:csp:<app>` and `policy:csp:*`
  (written with `security_set`, which now refuses a value that is not a well-shaped JSON object of
  origins). `open_app` renders through the universal loader — one resource serving every app — so
  that resource's `_meta.ui.csp` now carries the **union** of everything declared in the store
  (every app's `manifest.csp` ∪ the user's additions), computed per read: hosts are asked to allow
  the union, and the runner child inside the loader is narrowed back to its own app. A store with
  no declarations serves the 0.5.9 bytes exactly. The per-app resource (`OMA_DYNAMIC_TOOLS=1`)
  still carries only its own app's declaration, and the engine's own viewer and runner always
  build from the same merge. The loader's public cache hint is gone with this: its answer is
  store-derived, so it is not the same for everybody. Whether a host reads the list-time or the
  read-time `_meta` is a host-matrix question, not settled here.
- **Apps built outside the chat.** An app produced by a build pipeline now installs as a readable
  **template** plus its **bundle**: the template references its own build output
  (`<script src="oma-asset:app.js">`, `<link rel="stylesheet" href="oma-asset:app.css">`) and the
  files live in that app's file plane. The engine inlines every reference at serve time — the
  widget CSP allows no external subresource, and a host iframe could not reach this machine
  anyway. Documents with no references are served byte-identically to before.
  `install-app.mjs --manifest <manifest.json>` (the declaration as its own file, the shape a build
  emits) and repeatable `--asset <path>` (build output into the app's file plane, keyed by the
  file's basename); `--update` is unchanged. `types/window-oma.d.ts` types the API an **app** sees
  (`index.d.ts` types the engine's Node API, which an app never touches), pinned against the same
  name list `RUNTIME.md` and `test/runtime-contract.mjs` share. RUNTIME.md §6.1 is the target a
  build step has to hit — including the one thing bundlers get wrong: `<script
  type="text/oma-function">` blocks must be emitted into the template, never bundled.
- **A host-CSP probe app under `test/probes/host-csp-probe/`**: install it, open it in a host, and
  it writes what that host does with an app's `csp` declaration into its own collection — nine
  cells (declared connect, loopback connect, resource, frame, function fetch, a two-step
  list-vs-read `_meta` test, an undeclared-origin control, blob Worker, WebAssembly), each with
  the policy the browser actually applied, captured from `securitypolicyviolation`. Two of the
  cells measure something no app can declare — `McpUiResourceCsp` is four lists of domains, so
  there is no way to ask for a Worker or for WebAssembly, and this engine's own floor grants
  neither (open-decisions D-20). The README is the run-book, one row per host and per door
  (`open_app` vs `open_<name>`).
- **`types/oma-function.d.ts`** — the `args`/`api` a function body sees; and both type files now
  actually ship: they are in the published snapshot and declared in the package `exports`, so
  `/// <reference types="@2nd1st/open-mcp-apps/types/window-oma" />` resolves under `bundler`
  and `node16` (it was `TS2688` under both — the file existed in the repo and never reached
  npm). `oma.callFunction<T>()` is generic over what the body returns.
- **`install-app.mjs --prune-assets`** — opt-in removal of files this push neither carried nor
  referenced, for builds with content-hashed output names (without it every rebuild leaves the
  previous bundle behind in the app's file plane).
- **`list_apps` rows carry a `functions` count** when an app's manifest declares any:
  `· N function(s)` in the text line, `functions: n` in the structured row, and absent — not
  `0` — when there are none. Names and signatures stay one `get_app {slot:"manifest"}` away.
  No `outputSchema` was added, so `tools/list` is byte-identical.

### Fixed

- **`call_function` now says what the function returned on the text channel too.** The reply
  carried the return value in `structuredContent` only, and the text was a bare receipt
  (`Ran app.fn — 2 writes`). On claude.ai the model is handed `content[].text` alone
  (`docs/spec-conformance.md`, measured again 2026-09-02 through a live connector), so a
  function that fetched a URL and returned `{status, bytes, ms}` looked, from the chat, like it
  had returned nothing. The text now reads `Ran app.fn → {…} — 2 writes (…)`; the same-body rule
  in `test/two-channel.mjs` gains its assertion in `test/functions.mjs`.
- **A write now resolves the ack `types/window-oma.d.ts` promises, on every runtime.** The five
  write verbs (`addItem`, `updateItem`, `moveItem`, `deleteItem`, `setPref`) are declared
  `Promise<OmaAck>` and delivered three different things instead: the direct runtime and the
  sandboxed bridge both resolved the raw MCP envelope (`{content, structuredContent}`) and the two
  inert previews a bare `{ok:true}`. Measured in Chrome against `/view`: `ack.ok` read `undefined`
  after a write that had SUCCEEDED, so `if (!ack.ok)` reported every success as a failure and
  `if (ack.ok === false)` reported every refusal as a success; `ack.id` and `ack.item` were
  invisible, so an app could not recognise the echo of its own write and a two-way bridge wrote
  the stale server copy back over what the user was typing — silently, since nothing had failed.
  One normaliser (`ackOf`, in `src/runtime-core.mjs`, injected into the sandboxed child the way
  the height helpers travel) now sits on each of the four `window.oma` surfaces; the inert
  previews answer a complete synthetic ack instead of a shared frozen `{ok:true}` that handed
  every writer in a document the same object. `oma.callTool` is deliberately unchanged — it is
  the raw escape hatch, typed `Promise<unknown>`, and the embedder's own continuity rule reads
  the envelope the runner's chokepoint returns. `OmaAck` now NAMES the fields it always carried
  (`id`, `seq`, `item`, `deleted`, `note`, mirroring `ackSchema`), so `ack.item.version` type-checks
  for the apps that need it. No contract bump: the published declaration is what apps were written
  against, and every consumer surveyed either ignored the return value or was carrying a
  hand-rolled adapter this makes unnecessary. Pinned by `test/write-ack.mjs` (real engine, the
  shipped bridge source, both previews, and a loop-guard scenario).
- **Assets referenced with `oma-asset:` keep the tag the author wrote when they are inlined**;
  only `src`/`href`/`crossorigin`/`integrity` are dropped. A bundler's `<script type="module">`
  arrived as a classic script, so default ESM output was a SyntaxError and anything that did
  parse ran before the runtime and before its mount point — the reason every framework sample
  needed an iife build and a boot shim. Measured after the fix: default vite ESM output from
  Preact 10, Svelte 5 and React 19 (production and the 1 MB development bundle) renders, adds
  rows and calls its function with no shim at all.
- **The stage class and the shell injection find the document's own `<body>`/`<head>` element**
  rather than the first matching characters — which could be a string inside an inlined bundle
  (React's development build carries `<head` ten times). One element-aware scan serves
  `stampStage` and both `wrapApp` branches.
- **A function body's implicit collection is the one its app is bound to** — the same one its
  widget opens on. An app declaring a single collection had `api.count()` silently read an empty
  one while the widget showed rows.
- **A parse-time error in an app's script produces the visible notice in the browser viewer**;
  `/view` now stamps the app name that notice was gated on, so a blank card is no longer the
  only symptom.
- **The widget runtime no longer trips a CSP `eval` violation on every mount.** The MCP Apps SDK
  builds zod schemas at module-eval time and zod probes `new Function` for its fast path; under
  the widget policy that path was never reachable, so the violation was pure noise. zod's
  `jitless` mode is set before the SDK loads.
- `install-app.mjs --help` printed every top-level comment in the file — 25 lines of internal
  commentary alongside the usage; it now prints the header block only. And it located the html
  file by `argv.indexOf`, which answers for a string's *first* occurrence, so two identical
  arguments could make it treat an option's value as the document.
- `src/engine.mjs` no longer promises an INSTRUCTIONS "roster" for when the function pillar
  lands. The pillar shipped in 0.4.x, and the roster deliberately stays out of INSTRUCTIONS —
  they are a prompt-cache prefix, and a segment that moved whenever any app declared a function
  would invalidate it for every conversation. Discovery lives on the `list_apps` row instead.

- **`install-app.mjs` is reachable through the exports map** (`"./install-app.mjs"`), not only
  through `files`. A strict consumer resolving the subpath got `ERR_PACKAGE_PATH_NOT_EXPORTED`
  while the file itself shipped — two of three gates were standing, and the toolkit's push CLI
  had to locate the script by walking from `package.json` instead of asking the resolver.
- **`install-app.mjs` prints sizes in bytes, not UTF-16 code units.** Three sites printed
  `html.length` as `… B`; multibyte content under-reported (a 2,025-byte document said 1,581).
  One `Buffer.byteLength` helper serves all three.
- **The guide's environment section teaches `oma.standalone`, not `oma.host`.** The `host`
  getter left the runtime surface on 2026-08-04 with zero consumers; the guide kept teaching a
  name that reads `undefined` for twelve days because nothing watched it. Now something does: a
  contract gate scans every `oma.<name>` the guide mentions against the runtime's real surface.
- **`OmaState` declares `app` and `host`.** The runtime's state object always carried both —
  `state.app` decides what the loader mounts — but the type contract omitted them, so a strict
  TypeScript consumer got TS2339 on fields that answer at runtime. The type now pins the
- **A standalone server that adopts an already-running sibling says so** instead of printing
  `http listening` plus a viewer URL and an MCP endpoint that all point at the *other* process's
  store. The adopted branch now names the `OMA_DB` that is not being served and how to serve it.
- **`data_batch` no longer carries a dead `randomUUID()` fallback for `command_id`** — the schema
  has always required the field, so the fallback could never run but read as "optional" to anyone
  writing a client from the source. Replay of the same `command_id` still returns the same ids.
- **`position` is documented as scoped to (collection, group)** — sorting by it across groups
  yields an interleaving that looks like an order and isn't. RUNTIME and the `OmaItem` type now
  say so; `version` — globally monotonic, jumping, sortable across collections — is documented
  as the cross-group ordering key it always was.
- **The guide tells the truth about data freshness**: adaptive polling plus tab-refocus in a chat
  host, near-instant push (SSE) in the standalone viewer — measured at 7 ms, where the old text
  taught "~20s".
- **The guide warns that an inlined dependency may write generic names onto `window`** — shared
  with the shell in a local install, own realm under the sandboxed runner.

- **The five write verbs resolve to the `OmaAck` the type contract always promised** — on every
  `window.oma` surface. Before, direct/standalone and the sandboxed runner handed back the raw
  MCP envelope and the inert previews a bare (and shared, frozen) `{ok:true}`, so `ack.ok` read
  `undefined` on success, `ack.item.version` was invisible, and a loop guard keyed on it failed
  silently — the human's own edit came back and overwrote itself two seconds later. One `ackOf()`
  now serves all four surfaces; a cancelled delete confirmation resolves
  `{ok:false, reason:"confirmation_declined"}` as RUNTIME always claimed. A 25-assertion gate
  (`test/write-ack.mjs`) holds the shape on every surface. `oma.callTool` and the runner-guard
  envelope are deliberately unchanged — eight apps read `.structuredContent` off the former, the
  embedder's continuity redraw off the latter. **`oma.contract` bumps 2 → 3** for this: an app
  that read `.ok`/`.id`/`.item` off a write call got `undefined` on 2 and a real answer on 3, which
  is exactly the "a return shape an existing app could notice" that the number exists to signal.

  runtime's own initialiser, key for key, and a gate keeps the two from drifting again.
## 0.5.9 — 2026-08-16

**What `initialize` declares, the engine now does.** The handshake every MCP host reads first is a
set of promises about verbs, and two of them had never been kept: `resources.subscribe: true` was
declared from the first release while `resources/subscribe` answered *Method not found* on every
legacy wire era the SDK negotiates, and `tools.listChanged` — written to be `true` only with the
per-app openers on — was `true` in every mode. Both are kept now, and a new suite calls the verbs
those bits promise before a release goes out. Around that: an issue form on the public repository built on
the four things a report needs, one sentence for the person who runs the server by hand and sees
nothing, a net under every tool call so `undefined` can never again reach the model as prose, and a
head comment in `src/server.mjs` brought back in line with the README it contradicted. The tool
surface did not move — 44,911 B, byte-identical to 0.5.8 — because none of this rides `tools/list`.

### Fixed

- **Two capability bits declared things the engine did not do.** `initialize` is the first thing
  every host reads, and its `capabilities` object is a set of claims about verbs; nothing in this
  repository ever called the verbs the claims were about, which is how both stayed false for as
  long as they did.

  `resources: { subscribe: true }` had been declared since the first release. A legacy-era client —
  which every shipping host is today — that took the declaration at its word and sent
  `resources/subscribe` got `-32601 Method not found` back, on every legacy protocol version the SDK
  negotiates (measured 2026-08-16, `2024-11-05` through `2025-11-25`). The engine had never tracked
  subscribers and did not need to: for every app-plane write it already sends
  `notifications/resources/updated` to everyone on the connection, which is the larger promise. What
  was missing was a handler that accepts the request. `resources/subscribe` and
  `resources/unsubscribe` now answer `{}`. The declaration is kept rather than withdrawn, because on
  the 2026-07-28 wire the same bit is what makes a `subscriptions/listen` filter naming our URIs
  honourable — and that verb the SDK serves itself.

  `tools.listChanged` was written as a conditional: add the key only when `OMA_DYNAMIC_TOOLS=1` turns
  the per-app openers on, so that a tool surface which is fixed for the life of the process would
  not invite a host to re-list it. It said `true` in every mode for as long as it existed — an
  absent key is not `false` to the SDK, which fills the bit in with `?? true` the moment a tool is
  registered. Measured in all three settings (`0`, `1`, unset): `{"listChanged":true}` each time. It
  is now written out unconditionally, `true` with the openers on and `false` without — the shape
  `prompts.listChanged: false` already had on the line beside it. The comment above the declaration
  described a behaviour that had never once been observed; it now describes this one.

  A new suite, `test/capabilities.mjs`, is the gate. It starts the server over real stdio, reads what
  was declared, and then calls each declared verb: `subscribe` and `unsubscribe` must be answered on
  the legacy wire, the old verb must be refused *by era* on 2026-07-28 and its replacement routed,
  and both `listChanged` bits are pinned as exact objects in both modes. Every call carries a
  timeout, because a suite that can hang on a missing handler is a suite nobody waits for. Run
  against the code as it was, three assertions went red by name.
- **A comment at the top of `src/server.mjs` said the repository must not advertise `npx`, and the
  README's first install path is `npx`.** The line — "nothing in this repository may advertise the
  npx form" — was written when the only name on npm was somebody else's, and it stayed after
  `@2nd1st/open-mcp-apps` (0.5.4) became this project's and the README's fact table opened with
  `npx -y @2nd1st/open-mcp-apps`. The README was right and the comment was stale: the rule is
  *scoped only* — bare `npx open-mcp-apps` still runs a stranger's package and always will. The
  comment now says exactly that, records what it used to say and why, and names the coupling
  `test/invariants.mjs` actually pins.

### Added

- **A bug-report form on the public repository, built around the four things a report needs.**
  Nearly every defect in this project's history has been a property of *host × host version ×
  channel × surface* rather than of the engine alone — `KNOWN-ISSUES.md` names the host in the first
  word of most entries, and the same host has given opposite readings on two of its surfaces. So the
  form's first four fields are that tuple: a host dropdown spelled the way the README's Host support
  table spells them (Claude Desktop split into chat, cowork and Code mode; ChatGPT web and desktop
  each split into chat and Work; Codex desktop apart from the CLI), the exact build rather than
  "latest", local stdio or a remote connector, and where it broke (the widget card in the chat, the
  browser viewer, an `@live` screen, an app embedded in another app's panel, the installer, the
  engine process, the store, the authoring contract). Those, the engine version, what happened and
  what you expected are required, plus one checkbox saying you looked at `KNOWN-ISSUES.md` first;
  everything else is optional, because every required field costs completions. One template rather
  than three: whether a report is a host defect or an engine bug is the triage question, and a
  reporter cannot be asked to answer it. Blank issues stay enabled, and three contact links route
  around the form — `KNOWN-ISSUES.md` before filing, Discussions for questions, ideas and app
  wishes, and the private security-advisory channel `SECURITY.md` names. There is deliberately no
  "app request" template: this project's answer to *I want an app* is to have your AI build it.
- **The server says one sentence when a person runs it by hand.** Pasting the README's
  `npx -y @2nd1st/open-mcp-apps` into a terminal produced, measured 2026-08-16 in a clean
  environment, about a minute of install, then a viewer URL on stderr and a cursor that stopped —
  zero bytes on stdout, because a stdio MCP server prints nothing until a host speaks on stdin.
  Every next guess a person makes from there (Ctrl-C; open the URL and find an empty *Apps · 0*;
  assume it installed and go looking in a host) leads nowhere near a widget. Nothing was broken;
  nothing had said what the process was. Now, when — and only when — `stdin` is a terminal, one line
  goes to stderr: this is a stdio MCP server, run by hand it will just sit here, put the command in
  your host's MCP config and let the host start it. A host spawning the server over pipes never sees
  the line, so no host transcript changes and stdout stays the protocol's alone. Both READMEs' fact
  table renamed the row that invited the paste from **Run it** to **Command**, and it now says what
  that line is for.
- **A net under every tool call, so `undefined`, `NaN` and `[object Object]` cannot reach the model
  as prose.** 0.5.7 fixed one row of `list_apps` that had told the model every app was `undefined`
  characters long, and pinned that one row. The defect is a species, not a row: about twenty
  templates across the engine render model-visible text, and pinning each is a bet on remembering
  the twenty-first. `test/server-smoke.mjs` now wraps `callTool` once per client it opens and reads
  every text part of every result the way the model reads it, peeling off only the places where the
  words are somebody else's bytes (the authoring guide; an app's own source inside `get_app`) and
  the SDK's echo of a caller's malformed arguments. A row of `app_history` deliberately broken to
  print `undefined chars` was caught by name, on calls no existing assertion had been reading; the
  tree as shipped scans clean.

## 0.5.8 — 2026-08-16

**Four green lights that could not have gone red.** The largest group below shares a shape rather
than a subject: a reading was trusted for an answer it was structurally incapable of giving.
`install.mjs --check` called a Codex entry clean by parsing a line on which every value is printed
`*****`. The MCP Registry badge read `servers[0]` off an endpoint that returns every version ever
published under a name, oldest first. The link-closure gate this project added one release ago
printed CLEAN over the densest batch of relative links in the repository, because one regex read
left to right can only ever see the inner half of a nested badge. And `openai/codex#28912` closing
as *completed* was quoted in the place a reader looks to find out whether a failure still bites —
the closure of an umbrella, which cannot speak for any single failure filed beneath it. None of the
four was a wrong number waiting to be corrected. Each was an instrument reporting on itself while
wearing the clothes of a report about the world, which is why each one had gone unnoticed for as
long as it had: the answer it gave was the answer it always gives.

The rest is the first five minutes of an install, from both ends. The sentence the README asked a
brand-new user to *copy* is now an MCP prompt a host can put in a menu, and the `OMA_DYNAMIC_TOOLS=1`
the installer had been writing into two host entries is gone — which takes one approval dialog per
app off every install made from here on, and off existing ones on the next re-run. The tool surface
did not move: 44,911 B, byte-identical to its golden and so to 0.5.7's, because prompts ride
`prompts/list` and structurally cannot enter `tools/list`.

### Added

- **The engine's first MCP prompt: `get_started`.** Until now the README's Usage section opened by
  asking a brand-new user to *type a sentence* — "I just installed open-mcp-apps — show me how to use
  it with a couple of examples, and suggest a few apps that fit how I work." A sentence a project
  prints for people to copy is a prompt template by definition; this one was simply living in a
  document instead of on the wire, where a host can put it in a menu and a click can deliver it.
  It now is one: a host that surfaces prompts lists **Get started with open-mcp-apps**, and hosts
  that render prompts as slash commands spell it `/mcp__open-mcp-apps__get_started`. Where a host
  does not surface prompts nothing is lost — the sentence still works typed, and both READMEs say
  so rather than promising a menu entry we cannot see from here.

  One prompt, and no arguments, decided rather than defaulted. A prompt's name is public contract
  from the moment it ships and a menu has no redirects, so renaming is a break with no deprecation
  path; argument names are the second surface that can break the same way, and the only shape that
  can never break on its arguments is the one that has none. The wording behind the name stays free
  to change: `test/prompt-surface.mjs` pins the name, the absence of arguments, and every byte of
  the body against a golden, which makes a rewording deliberate without making it expensive.

  **The body is an instruction, not a copy of the authoring guide.** The craft of writing an app has
  exactly one home — `GUIDE` in `src/guide.mjs`, 29 KB, pinned by `doc-facts`' `exportBytes` — and
  this repository has spent real time on what happens when one fact acquires two homes. So the
  prompt routes instead of teaching: look at what the user already has (`list_apps`,
  `data_collections`) and at what the App Store already offers (`app_store_list`,
  `install_from_app_store`), call `get_app_guide` *before* writing any HTML, ask at most two
  questions, then build one app that fits this particular person and `open_app` it. Two machine
  criteria hold that line, because a golden only proves bytes did not move and not that they were
  ever true: every tool name the body mentions must exist in the live `tools/list`, and no long line
  of the body may appear verbatim in `GUIDE`.

  Default-on, including for hosted deployments, which share the same `createEngine`. There is no
  opt-in seat here and that is the ruling, not an omission: seats exist for capabilities that carry
  risk — `call_function` gates same-process execution that way — and a prompt is inert until a
  person picks it out of a menu. The cost is as small as that implies: `prompts/list` is 277 B
  fetched about once per connection, the body is 748 B and only travels when someone asks for it,
  and the capability declaration adds 32 B to `initialize`. The tool surface — the number that is
  resident in every conversation, and the one the byte ratchet guards — did not move a single byte:
  prompts ride `prompts/list`, a different verb, so they structurally cannot enter `tools/list`.

### Removed

- **The `OMA_DYNAMIC_TOOLS=1` that the installer wrote into two hosts.** Since 2026-07-28 it had
  registered Claude Desktop and Claude Code with that flag, and the reason was real: Desktop
  1.24012.9 silently dropped the loader widget's boot-time bridge calls, so an app opened through the
  universal `open_app` sat on "Loading app…" and never moved, while the per-app `open_<name>` tools'
  direct-embed path drew and worked. A good trade to make that week and a bad one to keep, because
  of what paid for it: one tool per app is one approval dialog per app, permanently, in a product
  whose entire permission story is that a single `open_app` grant covers every app the AI will ever
  build for you. The flag never bought Claude Code's terminal anything either — a terminal has no
  inline widget surface to fix.

  Re-measured 2026-08-16 on Desktop **1.30096.5**, with both registrations tried. A second
  registration carrying no flag at all opened an app through `open_app`: it rendered, its controls
  wrote, and the writes were still there after a full quit and relaunch. The original registration,
  flag still on, rendered through both doors. On the Claude app's **Code** surface — a face with a
  UI, unlike the terminal — `open_app` rendered as well. The universal path therefore works on both
  Anthropic surfaces that can draw, and all three hosts are registered the same way again, which is
  also one fewer way for two hosts to drift apart.

  What was measured is the absence of a symptom on one build, not a repair. Nobody here can read the
  host's source, so neither the code nor [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md) says upstream fixed
  anything; the dated record of the original failure stands verbatim and the new reading sits after
  it under its own date. The comment in `install.mjs` keeps both dates rather than disappearing —
  the next person to read that file should be able to find out what used to be there and on what
  evidence it went.

  **An existing install keeps the flag until the installer is re-run** — deleting code cannot edit a
  file already on disk, and doing nothing would mean paying those prompts forever. So `node
  install.mjs --check` now reports such an entry as `stale` on **all three** hosts, and a re-run
  removes exactly that one key: `PORT`, `OMA_DB`, a corporate proxy, any sibling field — all left
  where they are, with the run printing what it removed and how to put it back. Only the literal
  value the installer itself wrote is touched, so an `OMA_DYNAMIC_TOOLS=0` that somebody set as their
  own opt-out is not disturbed. The setting remains supported (README → Configuration); what ended is
  the installer choosing it on your behalf.

  *All three* took a second defect out of the way first. When this entry was first written the
  cleanup reached two hosts, because on the third the installer could not see the key it was
  cleaning — see **`--check` called a Codex entry clean…** below.

### Fixed

- **`--check` called a Codex entry clean by reading a line that could not have shown otherwise.**
  `codex mcp get` prints an entry's env as `KEY=*****` — the keys are real, every value is masked —
  and the installer parsed only `command` and `args` out of it. So a Codex registration carrying
  `OMA_DYNAMIC_TOOLS=1` came back indistinguishable from one that never had it, `--check` answered
  `already current`, and the retirement above skipped the one host that still needed it. This
  project's own machine is the example: the key sits in its `~/.codex/config.toml` to this day
  (measured 2026-08-16). The miss is the small half. The large half is what the miss licensed —
  *Codex never got this key* was concluded from a reading incapable of showing it either way, which
  is a statement about the instrument wearing the clothes of a statement about the world.

  The probe now reads env in two passes with two different jobs. The masked line settles which keys
  **exist**, and that much it settles conclusively. The **value** comes from `codex mcp get --json`,
  codex's own resolution of its own config — which beats re-parsing the file by hand, since the
  quoting, the layering and the `-c` overrides are already applied — falling back to the
  `[mcp_servers.<name>.env]` sub-table in `~/.codex/config.toml` on builds without that flag, and
  counting a value that comes back masked there too as unread rather than as absent. When no pass
  can produce the value the entry reads `stale`, and the status line says the value is the thing that
  could not be read. What it will never do is report unknown as clean: a re-run somebody did not need
  costs a minute, while `already current` over an entry that is still dirty costs an approval dialog
  per app for as long as they keep the install.

  A value that cannot be read is also a value that will not be overwritten. Correcting a Codex entry
  means re-registering it, and re-registering hands every env key back **by value** — so a run that
  could not read them changes nothing, says exactly that, and prints the two commands that finish the
  job by hand. `updated` over a run that deliberately did nothing is the same defect as `unchanged`
  over a run that did something.

  Carried out with it, from the same place: a stale Codex entry used to be re-added with **no `env`
  at all**, silently discarding a proxy or an `OMA_DB` somebody had put there. That is the same
  defect a re-install once had on Claude Desktop — fixed there when it was found, still live under a
  different host's name — and every key that is not ours now goes back through `codex mcp add
  --env`. Covered in `test/install-paths.mjs` §6–§7: §6 drives a stand-in `codex` for the two
  readings a current binary cannot produce (a build with no `--json`, an env laid out where the file
  fallback cannot parse it), §7 checks the real CLI still answers the way the stand-in assumes, and
  says so out loud when there is no `codex` to ask.

- **Every visitor to the npm package page has been reading the Chinese README.** The defect exists
  on exactly one surface — `npmjs.com` renders whatever the registry's packument names as the
  readme, and for this package that field has never said `README.md`. Measured on 2026-08-16,
  `npm view @2nd1st/open-mcp-apps readmeFilename` returns `README.zh-CN.md` and the `readme` body is
  25,466 bytes of Chinese; every version still on the registry (0.5.4, 0.5.6, 0.5.7) carries both
  files at the root of its tarball. Nothing about any of those releases was done wrong, which is why
  no release checklist could have caught it: npm ALWAYS packs a `README*` found at the package root,
  and `package.json`'s `files` array is powerless against it — that array only ever *adds*, and root
  READMEs are one of the classes it can never subtract. So both files went in regardless, npm chose
  between them, and it chose the second one. Republishing the same layout reproduces the same page.

  The fix is deliberately *not* a better guess at how npm chooses. Dictionary order, readdir order,
  last-one-wins — each story fits the evidence, and a fix resting on one of them holds only until an
  undocumented implementation detail moves. The criterion sits one level below that question: the
  package root now holds exactly ONE `README*`, so there is nothing left to choose between. The
  Chinese README moved to `i18n/README.zh-CN.md`, where the forced-inclusion rule does not reach —
  it is a rule about the package root, not about subdirectories — and where a reader on GitHub still
  arrives in one click from the English one. All 24 of its relative links and images gained a `../`,
  because a file that changes directory takes every promise it made about its neighbours with it;
  `publish.mjs`'s link-closure check is the thing that says so out loud, and the same move is carried
  through its `ALLOWLIST` (as the directory `i18n`, so the next translation cannot silently miss the
  public snapshot), its `SECURITY.md` scrub, and the one forbidden-token exemption that names this
  file by path. That last one is also how this paragraph got shorter: naming the token here would
  have published it outside the handful of files allowed to say it, and the scan said so.

  This reaches the page on the next `npm publish` and not before: `readme` and `readmeFilename` are
  written into the packument at publish time, so 0.5.7's page keeps showing Chinese until a newer
  version replaces it. Verify it there — on those two packument fields — and not in the tarball,
  which was never the thing that was wrong.
- **The MCP Registry badge on both READMEs printed a version that gets staler with every release.**
  It read `$.servers[0].server.version` off `…/v0/servers?search=open-mcp-apps`, and that endpoint
  does not return *the* server — it returns every version ever published under that name, oldest
  first. So `[0]` was never "the current one": it was pinned to the first release the registry ever
  saw, and each release since widened the gap by one. Measured on 2026-08-16 the array was
  `[0]=0.5.4` (`isLatest=false`), `[1]=0.5.7` (`isLatest=true`), and the badge at the top of both
  READMEs said `v0.5.4` while the package said 0.5.7. The subscript is what hid it: `servers[0]`
  reads like a lookup of the one thing you asked for, and is in fact an assumption about array
  order. Both badges now ask the registry for the answer rather than picking a row — `version=latest`
  returns exactly one entry, and is spelled `%26version%3Dlatest` because it lives *inside* shields'
  own `url` parameter; the other honest criterion, had the filter not existed, is
  `_meta["io.modelcontextprotocol.registry/official"].isLatest`. The badge's link target carries the
  same filter, so a reader who clicks through sees the version the badge just claimed instead of the
  list that produced the wrong one.
- **Six passages in the READMEs that only a stranger could trip over.** They have no defect type in
  common — a diagram, a pair of dates, an undisclosed path, a URL that does not back its own sentence
  — only a *reader* in common. Each is a place where someone inside this repository supplies a
  premise on the way past and never notices doing it: that `OMA_DYNAMIC_TOOLS` is off unless you
  switched it on, that the installer clones to `~/open-mcp-apps`, that `claude.ai` in a list of
  MCP-Apps hosts means the hosted deployment and not the engine you just put on your laptop. Someone
  arriving from outside holds none of those, reads the same sentence, and receives a different
  sentence — and in the first two cases acts on it, since one of them is a diagram an AI will copy
  and the other is a decision made before a URL goes into a shell.

  The diagram under `## The loop` taught `open_kanban`: a per-app tool that does not exist unless
  `OMA_DYNAMIC_TOOLS=1`, which is not the default and is documented as not the default three other
  times in the same file. A default `tools/list` answers with 33 tools and exactly one `open_*` among
  them (`open_app`), so both diagrams now show `open_app {app: "kanban"}` — the call the default
  configuration actually answers. `install.sh` clones into `${OMA_DIR:-$HOME/open-mcp-apps}`, and
  neither of those strings appeared anywhere in the public documentation: the destination was first
  disclosed by the script's own echo, which happens after you have already piped a URL into `sh`. The
  path, the override, and the fact that `uninstall.mjs` never removes that folder are now stated
  before the one-liner instead of after it.

  The other four are claims that had stopped being checkable. "GA since January 2026" linked to a
  page containing neither word; what the official announcement says verbatim, dated 26 January 2026,
  is "MCP Apps is now live as the first official MCP extension" — so the sentence now claims that,
  and links to the post that carries it. Two upstream issues were quoted in the present tense long
  after they closed: `openai/codex#28912` as *completed* on 2026-08-05, `anthropics/claude-code#56954`
  as *not planned* on 2026-06-23. Both now carry their state and date — and the Codex one carries a
  second correction that nearly went the other way. Reading only the state would have let this file
  hint that widget-adds are fixed on Codex now; `docs/host-matrix.json` had recorded, first-hand on
  2026-07-29, that #28912 was never this defect. Re-checked here: #28912 is labelled `enhancement`
  and titled "make MCP apps work end-to-end in the Codex GUI" — an umbrella whose closure says
  nothing about one failure inside it — while `openai/codex#30092`, labelled `bug` and reproduced on
  that host by a third party with the same error string, was still open on 2026-08-16. Both READMEs
  now name both issues and what each one is, and the host-support cell deliberately stays `◐`: an
  issue closing upstream is not a re-test here, and this repository does not get to mark a host
  working on the strength of someone else's tracker. The table's
  live-test dates are untouched for the same reason — dating a reading honestly is the whole value of
  it; what was missing was the sentence saying both dates precede 0.5.0 and nothing has been re-run
  since. Last, `claude.ai` sat in the opening list of hosts and on no other host-facing surface,
  while the roadmap's unticked remote box dropped the word *self-hosted* that the paragraph above it
  had kept — which reads, to precisely the reader that box is written for, as "this does not work
  with claude.ai today", when the hosted deployment is the thing built for them. The box stays
  unticked, because self-hosted remote is genuinely not done; the qualifier and the bridge between
  the two facts are what got added.
- **`KNOWN-ISSUES.md` pointed at an issue that was never this defect, and that issue had closed.**
  Both READMEs send a reader there to settle one question — is the Codex widget-add block still
  live? — and the entry's `Upstream:` line named
  [openai/codex#28912](https://github.com/openai/codex/issues/28912), closed as *completed* on
  2026-08-05. A closed link standing in that position answers the question by itself, and answers it
  wrong. Re-read first-hand on 2026-08-16: #28912 is labelled `enhancement` and titled "make MCP
  apps work end-to-end in the Codex GUI" — an umbrella, whose closure says the effort was wrapped up
  and nothing about whether one add gets through — while
  [#30092](https://github.com/openai/codex/issues/30092), labelled `bug`, is a third party
  reproducing this exact failure on this exact host, with their server-side operations all
  succeeding and only the in-app card failing, which is the shape measured here. It was still open.
  The entry now names both and says what each one is.

  Two kinds of text live in that file and only one of them was touched. The dated lines — `confirmed
  2026-07-28`, `measured in-widget 2026-07-28`, `confirmed 2026-08-05 on the wire` — are a verbatim
  record and are byte-identical; an `Upstream:` line carries no date and claims no observation, so
  it is a live pointer, and a live pointer that no longer points is simply wrong. The entry also now
  states its own tense: our add-block reading is the 2026-07-28 one and has not been re-taken since
  that closure, so nothing in the file can be read as saying the block lifted. The host-support cell
  stays `◐` for the same reason — an issue closing upstream is not a re-test here. The READMEs' half
  of this correction is the last of the six passages above.
- **The Host support table gave one row to a product with two surfaces, only one of which can
  draw.** `Claude Code` was a single row whose *Renders widgets* cell read `— in the chat, by
  design`: true of a terminal, false of the Code surface inside the Claude app, which has a UI. On
  2026-08-16 an app opened there through the universal `open_app` rendered inline, the same shape
  the chat surface gives — the same measurement session described under **The `OMA_DYNAMIC_TOOLS=1`
  that the installer wrote into two hosts** above. So the row became two, and the terminal row kept
  every word of its own, including its link to *A screen beside the terminal* — a section that
  exists precisely because "does not render in the chat" is not "has no UI", and that a table
  reshuffle must not quietly drop. The new row's *Human clicks widget* cell says **not measured on
  this surface**: rendering is what was seen there, clicking is not, and one reading does not get to
  fill in its neighbours. The table's header sentence was narrowed in the same pass — it declares
  that nothing in the table has been re-tested since before 0.5.0, which a cell carrying its own
  2026-08-16 date falsifies the moment it lands, so it now exempts exactly the dated cells. The
  codex CLI row has no new reading behind it and is untouched.

  **And that screen beside the terminal was documented as costlier than it is.** The section led
  with a second monitor and a spare tablet, and never named the cheapest form: a browser pane one
  column over in the same tiled workspace, in the window you are already working in. Same machine,
  no tunnel, no second device — most terminal setups can put a browser next to a shell, and that is
  the whole requirement. That is now the form it leads with; a second monitor is the same idea with
  more desk, and another device is the same idea again with the caveat that was already there. The
  binding sentence is untouched, because it is what makes the caveat true: the viewer listens on
  `127.0.0.1` only.
- **Three comments in files that ship had stopped being true, and not one of them by drifting off a
  number.** `src/http.mjs` defends binding the viewer to loopback, and it had priced that decision:
  remote hosts reach `/mcp` through an outbound tunnel that connects to `127.0.0.1` locally, "so
  restricting the listener to loopback costs nothing." That was priced when the viewer was your own
  browser. 0.5.1's `@live` changed what the viewer is *for* — its headline use is a **second**
  screen, a wall tablet, a retired phone, an e-ink panel — and every one of those sits on the LAN,
  on the far side of that bind. So `/mcp` pays nothing and `/view` pays, and the comment now says
  which is which. The behaviour did not move a byte (`server.listen(PORT, "127.0.0.1")` is
  unchanged) and neither did the security argument, which still holds exactly as written: `/rpc` and
  `/mcp` are both unauthenticated, so an all-interfaces bind hands your data to anyone on the
  segment. The price stands until device pairing exists — a bind flag on its own is not that fix,
  it is a different shape, and shipping a shape already known to need withdrawing is worse than
  charging for the bridge in the meantime.

  The `Dockerfile`'s head comment gave the wrong reason for the file's own existence: that a
  directory which grades MCP servers builds them from it. Measured 2026-08-16 — that grader reads no
  Dockerfile out of this repository at all, and generates an image definition from a form in its own
  admin, which is the only place its start command can be set. The file is genuinely wanted by
  `docker/mcp-registry`, and by us: building it is how this server is shown to start in a container,
  and its `ENTRYPOINT` is where the start command every directory ends up asking for comes from. The
  refuted half stays as a dated negative rather than being deleted, because the next person to hold
  that belief will otherwise go looking in the repository for something to change. The same pass
  re-ran the hardcoded reading instead of editing it: `docker build` on both architectures, then a
  real `initialize` + `tools/list` over stdin, answers 33 tools with an empty stderr on
  `linux/arm64` and on `linux/amd64` alike.

  And `build.mjs` said the Glama build of this repository "has never gone green" — present perfect,
  true when written and false since the `prepare` fix in 0.5.5, whose effect is exactly what turned
  that build green (it passes `pnpm install` on the tree pinned at v0.5.7). One word: *had*.
- **The link-closure gate printed CLEAN over the densest batch of relative links in the
  repository.** 0.5.7 added it to `scripts/publish.mjs` — every relative markdown link in a
  published `.md` must resolve inside the published file set — and markdown nests, while one regex
  read left to right can only ever see the inner nest. A badge is an image inside a link:
  `[![license](https://img.shields.io/…)](LICENSE)`. The scan matched the image, its cursor landed
  past *that* `)`, and the outer `](LICENSE)` was unmatchable from then on. What got checked was the
  shields URL — absolute, skipped on sight — and the half a reader actually clicks was never parsed
  at all. The blind spot sat where the shape is densest: the badge row at the top of a README is
  nearly all of that file's relative links, and every badge in it has this shape. The gate did not
  find this either; moving the Chinese README under `i18n/` left `../LICENSE` and `../package.json`
  to be worked out by hand, and the gate agreed with a count that never held them.

  Teaching one regex to swallow the outer level as well would only move the blind spot to whatever
  nests next, so the scan is two passes. The first lifts every image out — keeping its own target,
  since a relative image `src` is a link too — and leaves a placeholder containing none of
  `[ ] ( ) !`; the second runs over text with no images left in it, where a badge now reads as an
  ordinary link whose text happens to be a word. The per-target filtering, counting and resolution
  are untouched, so the count still means what it meant. Verified by probe rather than by reading
  the diff: a deliberately broken badge target inserted into `README.md` left the old code at
  `EXIT=0` with its count unmoved, while the new code exits 2 and names the file and the missing
  path. With the probe removed, the same tree counts 55 links before the change and 59 after — and
  those four are `README.md`'s `LICENSE` and `package.json` plus `i18n/`'s `../LICENSE` and
  `../package.json`, with no image target lost anywhere.

## 0.5.7 — 2026-08-16

**Everything a stranger receives, and everything this repository says about itself.** Three of the
defects below were found by looking at what someone on the other side actually gets: the text an MCP
client is handed by `list_apps`, a link a reader on GitHub clicks, the security alerts the public
repository page shows. The rest is the same question asked of prose and of copied constants —
statements in the files that ship had quietly stopped being true, and three homes of the version
number had nothing counting them. Exactly one item here had a gate, and that gate had been red for
some time on `doc-facts --deep`, a branch `npm test` does not run. The runtime's only behavioural
change is that one line of listing text — the tool surface is otherwise byte-identical to 0.5.6.

*This section was completed after `v0.5.7` was tagged. All of it shipped in that release; only the
first entries were written down at the time, and the rest reach the public face with the next
snapshot.*

### Fixed

- **`list_apps` told the model every app was `undefined` characters long.** The rendered row read a
  row field named `html_size`; the query behind it has produced `length(ui) AS ui_size` since the
  manifest split, and a missing property in JavaScript is `undefined`, not an error. So every row of
  every listing, in every host, printed `(undefined chars, by …)` — while the structured half stayed
  correct, because it spreads the store row rather than naming fields. Found by driving the
  *published* npm package as a client would (`npx -y @2nd1st/open-mcp-apps`, initialize → `save_app`
  → `list_apps`), which is also why the test now asserts on the rendered text and not on the
  structured payload.
- **A link in this file 404'd for every reader.** The v0.3.0 entry links `CLA.md`, which was deleted
  in 0.5.4 with the MIT relicense. It now points at the file inside the last release that carried
  it. `doc-facts` had the name exempted — correctly, as a record of what once was — but an
  exemption for a *name* cannot see that the name is wrapped in a *hyperlink*.
- **A capability claim in this file had no preconditions.** The 0.5.1 entry says to install `live`
  on a spare tablet, open `/view/live`, and the display is done — but the viewer binds `127.0.0.1`,
  so a *separate* device reaches it only through a tunnel you start yourself, while on the machine
  running the engine it is simply a second window. The claim was not impossible, it was
  unconditioned — an operating instruction with its preconditions missing. The sentence is
  untouched and carries a parenthetical now: a release history is a record, and rewriting one is
  worse than letting it age, so a repair to it has to be legible as an annotation.
- **Nine Dependabot alerts on the public repository, not one of them on a dependency we declare.**
  Every one of them arrived through somebody else's `package.json`: `hono` and `@hono/node-server`
  by two paths at once (`@modelcontextprotocol/node` and `@modelcontextprotocol/sdk`, deduped to a
  single copy), `ip-address` under the sdk's `express-rate-limit`, `fast-uri` under its `ajv`. Every
  repair was a patch release that already sat inside a `^` range we had written — hono
  4.12.31→4.13.2, `@hono/node-server` 1.19.14→1.19.17, fast-uri 3.1.4→3.1.5, ip-address
  10.2.0→10.5.0 — so `npm audit fix` *without* `--force` was the entire fix: `package.json` did not
  change by one byte, and `package-lock.json` moved twelve lines. `npm audit --omit=dev` reports 0
  afterwards. Dependency updates enter through this repository and reach the public one with the
  next snapshot, which is why the alert PRs raised over there get closed rather than merged: that
  repository's history is a fast-forward of curated snapshots, and a merge commit of its own would
  make the following release unpushable.
- **`TRADEMARKS.md` still described the licence, in the present tense, as AGPL.** It opened on "the
  open-source licenses that cover this project — the GNU Affero General Public License v3.0 for the
  engine, and the MIT License for the `components/` directory", a split that ended in 0.5.4 — while
  the same file already said MIT about itself further down. This one is doubly exposed — it is in
  `publish.mjs`'s `ALLOWLIST` *and* in `package.json`'s `files`, so it goes out both with the public
  repository and inside the npm tarball. It now says what `LICENSING.md` says: the MIT License, for
  every file in the repository. Nothing was moved into the past tense, because the file carries no
  historical sentence that needed preserving.
- **"Until v0.5.2" read two ways, and only one of them was true.** Three independent pieces of
  evidence say v0.5.2 itself was still the split licence: `components/LICENSE` is present in
  `git ls-tree v0.5.2` and gone by v0.5.4; `v0.5.2:LICENSE` opens with GNU AFFERO where v0.5.4 opens
  with MIT; and the 0.5.4 entry below states in its own words that `v0.5.3` never existed.
  `LICENSING.md` now reads "Up to and including v0.5.2" and names where the split ended, so both
  ends are pinned and there is no second reading left. `README.zh-CN.md` had resolved the same
  ambiguity the other way — 「v0.5.2 之前」, exclusive — and now agrees.
- **The reason given for reading the `GUIDE` was a size gap that has since closed.** `RUNTIME.md`
  sent you there because it was the bigger document — 28,588 bytes against its own 10,559 — and
  `CONTRIBUTING.md` quoted the same ratio as "roughly three times". Both numbers were stale, and
  putting the true ones in dissolves the argument they were carrying: `GUIDE` measures 29,022 bytes
  and `RUNTIME.md` is no longer far behind it. So the argument was replaced rather than the numbers,
  and on evidence — v0.4.0's `RUNTIME.md` was exactly 10,559 bytes and stopped at §7; the §8 and §9
  that v0.4.2 added are what grew it, and neither of them is the house style or the worked examples.
  It now says the gap closed from the *other* side, and that size was never the reason — scope was.
  `RUNTIME.md`'s own byte count is gone rather than corrected, since writing that number down is the
  act that falsifies it; `GUIDE`'s is the single home left, and it is pinned now (below).
  `CONTRIBUTING.md` carried a second falsehood in the same sentence — that everything about layout
  and the CSS kit lives only in the guide — and now draws the line where it actually falls.
- **`CONTRIBUTING.md` described the test surface as three suites, in three places.** The `test`
  script in `package.json` chains far more than three. The repair was deliberately *not* to write
  the new number down — an ungated number is the species this release was spent removing — but to
  point at that script as the authoritative list, which is the only answer that cannot drift. The
  same pass added `doc-facts --deep` to the suites a developer runs on their own, and said plainly
  that `npm test` runs that one without the flag.
- **Both READMEs quoted 427 assertions where `test/server-smoke.mjs` reports 428.** This is the one
  item in this release a machine was already watching, and it had been failing: `doc-facts` checks
  the number, but only under `--deep`, and `npm test` runs the version without it — so the gate was
  red on a path nobody walks. One more bilingual mismatch went out with it: the Chinese README's
  roadmap line had dropped the parenthetical its English counterpart carries, "(review + runner
  sandbox activate here)".
- **`lhm.plugin.json` sat at 0.5.4 through two releases, and it cost a directory listing.**
  `lhm plugin update` answered `Updated 2nd1st-open-mcp-apps@0.5.4 (merged into the existing
  version)` — the update was folded into an *old* version's entry, so LobeHub's `validated` flag
  never moved and its badge still prints a description from before the app rename. The version
  number has homes outside `package.json`: the lockfile's two copies are held by
  `test/invariants.mjs` and both READMEs' fact tables by `doc-facts`, but `server.json`'s two
  version fields and this one had nothing counting them at all — grepping `test/` and the doc-facts
  config for either filename returned zero hits. All three are counted now (below).

### Changed

- **`scripts/publish.mjs` now checks link closure over the staged snapshot** (step 7b): every
  relative markdown link in a published `.md` must resolve inside the published file set. This
  covers the two cases nothing else could — a target deleted from the repo, and a target that
  exists here but is not in the `ALLOWLIST`, which no check run against the internal tree can
  detect by construction. It aborts before any push and names which of the two it hit.
- **`test/invariants.mjs` now counts every copy of the version that leaves with a release** —
  `server.json`'s top-level `version` and each entry of its `packages[]`, plus `lhm.plugin.json`'s
  `version`. The fields are reached by path rather than copied by value or frozen at index 0, so a
  second `packages` entry — a `pypi` or `oci` registry type, say — grows the check instead of
  slipping past it, and every failure names the file, the key, what it says and what to set it to.
  It lives in invariants rather than `doc-facts` for one reason: `doc-facts` exits 0 on a tree with
  no `docs/`, which is what a public snapshot always is, while both of these files ride out in that
  snapshot. A gate belongs on the road its file travels. Three name couplings are pinned alongside
  it, all three measured as already correct: `server.json`'s npm `identifier` is the package this
  repository publishes, its `name` equals `package.json`'s `mcpName` — the pair the registry proves
  ownership with — and `lhm.plugin.json`'s `identifier` is frozen as a literal rather than derived
  from the package name, because LobeHub keys its catalogue on that string. Changing it does not
  rename the listing; it abandons the claimed one and opens a second, empty one.
- **`doc-facts` gained a declarative compute kind, `exportBytes`**, and the `GUIDE` size quoted in
  `RUNTIME.md` is the first fact under it — the number that had gone stale by more than a factor of
  two, with an argument resting on it and nothing watching. It imports the module and
  measures the exported string rather than the bytes on disk: `GUIDE` is a template literal, so its
  file bytes and its runtime bytes differ by every escape written into it, and scraping the literal
  with a regex is the kind of check that stops matching the day someone adds an interpolation. Two
  fields, `file` and `export` — a config that can express arbitrary code is a config nobody can
  audit. It sits in the always-on `DERIVED` pass rather than under `--deep`, because `--deep` is
  exactly the branch `npm test` does not run, and a companion `format` spells the computed value the
  way a document writes it so a pin cannot fail on a thousands separator alone.

### Added

- **Both READMEs gained a section called "A screen beside the terminal".** The Host support table's
  two `—` cells for Claude Code and the codex CLI were literally correct and read wrong: what a
  reader took away was "terminal hosts have no UI", and since 0.5.1's live pointer that conclusion
  is false. An app opened from a terminal host appears on a browser screen next to it and swaps
  itself when the AI opens another. So the cells were narrowed rather than flipped — `—` *in the
  chat*, by design — and they now point at a section that says how to get there (install `live`,
  open the viewer in a window you then leave alone) and what it costs. The costs are stated as
  plainly as the capability: there is still no widget in the transcript; `sendMessage` degrades to a
  notice on a standalone page, exactly as the **Browser viewer** row already said; the viewer has to
  be running with a browser pointed at it; and the listener binds `127.0.0.1`, so "a spare tablet on
  the wall" means *this machine's* screen unless you put up the tunnel described above it. Inside a
  chat host the same region deliberately draws a placeholder instead of following anything. The
  section says in its own text that it is described from the code as built and not measured on a
  host — the live-test dates above it cover the table, not it.
- **A CI badge on both READMEs.** It was held back until the public workflow actually went green,
  which it first did on the 0.5.6 snapshot. The test for hanging one is what the SVG prints, not
  whether the URL resolves: a badge that reads `failing` is worse than no badge.

## 0.5.6 — 2026-08-16

**The public CI is green for the first time.** 0.5.5 fixed two of the three things that broke the
chain there; the third was standing behind them. `npm test` stops at the first failure, so each
repair only revealed the next one — and this one was invisible to me for a second reason worth
recording: I verified 0.5.5 by running the snapshot on *this* machine, where Claude Desktop is
installed. The runner has no MCP host at all.

### Fixed

- **`test/install-paths.mjs` could never pass on Linux.** Its fixtures build a fake `HOME` and
  write Claude Desktop's config into it — at `Library/Application Support/Claude`, which is the
  macOS shape. On Linux the installer looks under `~/.config`, found no host, exited 1, and took
  the suites behind it down with it. The fixture now resolves that path the way `install.mjs` does,
  per platform. Measured both ways: 30/30 on macOS, and 23 suites green in a Linux container.
- **The same fixtures could write into the person running them.** A fake `HOME` is a complete
  boundary only on macOS; elsewhere the installer honours `XDG_CONFIG_HOME` and `APPDATA`, which on
  a developer machine point at the real user. The sandbox now names those too.

## 0.5.5 — 2026-08-16

**Everything here is about the copy of this repository other people get.** The runtime did not
change — the tool surface is byte-identical to 0.5.4 — but three things that only ever failed
*somewhere else* are fixed, and the files other machines read about us now live in the repo
instead of in someone's head.

### Fixed

- **`pnpm install` had never worked, on any version.** The `prepare` script bundles the widget
  runtime and, on the way, collects the licences of everything it bundles — reading each
  dependency's `package.json` at `node_modules/<name>`. That path is npm's layout. pnpm's is
  `node_modules/.pnpm/<name>@<version>/node_modules/<name>`, so the first segment after
  `node_modules` is `.pnpm` — the content-addressed store, not a package — and reading *its*
  `package.json` is an `ENOENT` that fails `prepare` and with it the entire install. The package
  root now comes out of the bundler's own input paths (their **last** `node_modules` segment), so
  both layouts state their own truth; assembling the path by hand could never have worked under
  pnpm, where transitive dependencies are not at the root at all. Measured on the published tree:
  `pnpm install` reproduced the failure, and reproduces success after. npm's output is unchanged,
  byte for byte. This is also why the Glama build of this repo had never gone green.
- **The public repository's CI had never been green either, and nobody could see why.** `npm test`
  is an `&&` chain with `doc-facts` second, and `doc-facts` reads `docs/` — which never enters a
  public snapshot, while `test/` always does. So it exited 1 on every push and **the other 21
  suites had never run there at all**. Both documentation-reading runners now distinguish *no
  `docs/` at all* (nothing to check — skip, and say so) from *a `docs/` with no rules describing
  it* (the defect they were written for — still loud). Verified against the real public snapshot:
  `npm ci`, `node build.mjs`, `npm test` all exit 0, 21 suites green, two honest skips.
- **The package would not let you read its own `package.json`.** `exports` is a closed list, and
  that path was not on it — so the single most common line tooling and agents use to learn a
  package's version threw `ERR_PACKAGE_PATH_NOT_EXPORTED`. It is on the list now, and nothing else
  was opened.

### Added

- **A Dockerfile that is an entry point, not a badge** — directories that grade MCP servers do it
  by building them, and one that withholds servers whose build does not reproduce. Two measured
  traps are recorded in the file itself: `better-sqlite3` ships no install script but does ship a
  `binding.gyp`, so npm implicitly runs `node-gyp rebuild` and dies without a toolchain — to
  produce a binary the loader then ignores in favour of the prebuilt one it shipped; and
  `node:22-slim`/`24-slim` are Debian bookworm (glibc 2.36) while that prebuilt wants GLIBC_2.38,
  which builds green and dies on the first query. Hence `--ignore-scripts` and a trixie base.
  Verified on arm64 and amd64: a real `initialize` answers, `tools/list` returns 33.
- **The contracts other people's machines read**: `server.json` (the official MCP Registry, where
  this server is now listed), `.mcp.json` (a standard client config sample), `glama.json`,
  `lhm.plugin.json`. They were living in a scratch directory and on a laptop; a file whose whole
  purpose is that a stranger can check it against what a directory says should be in the repo.
- **Docs**: `docs/ecosystem-listings.md` (who lists us, and which of those entries has gone stale)
  and `docs/official-directories.md` (what the ChatGPT and Claude directories actually require,
  read from their own pages).

### Changed

- **The READMEs were rebuilt for the reader they actually have.** Both are read by an assistant far
  more often than by a person browsing: someone pastes the page and asks how to install this. So a
  fact table and three complete, runnable host-config blocks come first, the deep material moved
  below, and `will`/`soon` promises became unchecked roadmap items. Two of the five assertion counts
  quoted in them turned out to be wrong, and one machine-checked pin had been silently dead since
  the App Store rename.
- One sentence per medium, instead of three drifting ones: the npm description, the registry entry
  and the GitHub About now say the same thing at three lengths.

## 0.5.4 — 2026-08-15

**The whole repository is now MIT.** The engine was AGPL-3.0-only and `components/` was MIT; that
directory split is gone and the root `LICENSE` governs everything. No engine behavior changed in
this release — the tool surface is byte-for-byte the document it was in 0.5.2.

> **Why the version jumps from 0.5.2 to 0.5.4.** A failed npm publish followed by an unpublish of
> the whole package burned the version numbers `0.5.2` and `0.5.3` on the registry — npm never lets
> an unpublished version number be reused. Skipping to `0.5.4` keeps the GitHub tag and the npm
> version 1:1, which is worth more than a contiguous sequence. **`v0.5.3` never existed**; the
> GitHub tag `v0.5.2` is unaffected and still points at the release it always did.

### License

- **Relicensed the engine from AGPL-3.0-only to MIT**, and folded `components/LICENSE` into the
  single root [`LICENSE`](LICENSE). Every `SPDX-License-Identifier` header moved with it.
- **Why.** The AGPL was chosen to keep engine improvements open, and it does do that — but it was
  costing the engine the thing it exists for, which is being embedded. This project is a *library
  and a server other people's software runs*, and the ecosystem it has to sit inside is uniformly
  permissive: the MCP SDKs are MIT, the reference hosts and the surrounding tooling are MIT, and
  container registries and app directories routinely refuse GPL-family dependencies outright. Every
  one of those is a place where an AGPL engine is not evaluated and rejected so much as never picked
  up — the license does its filtering before anyone reads the code. Network copyleft protects
  against a competitor running a closed fork as a service; embedding is the growth surface that
  matters far more here, and the AGPL taxed the second to insure against the first.
- **For existing users this is strictly a loosening.** MIT removes obligations, it adds none: every
  freedom the AGPL granted, MIT still grants, and the §13 duty to publish the source of a modified
  hosted version is simply gone. Nothing that was permitted becomes forbidden. Code already
  received under the AGPL stays validly licensed under it — that grant is irrevocable — so no
  downstream user has to do anything.
- **The trademark reservation is unchanged.** The project's names and logos are still reserved and
  are still not granted by the license — the reserved list is in [`TRADEMARKS.md`](TRADEMARKS.md),
  unedited by this release. Brand protection does not travel with the copyright license, and a more
  permissive license is exactly when that distinction earns its keep: fork the code freely, and give
  your fork its own name.
- **The CLA is retired.** `CLA.md` and the `.github/workflows/cla.yml` check are removed. The CLA
  existed for one reason — keeping the engine under copyleft while retaining the right to offer it
  under other terms required contributors to grant those terms explicitly. Under MIT, inbound is
  outbound: every patch already arrives under the license the project ships, so the signing ceremony
  had nothing left to do. Contributions now need nothing signed, engine and apps alike. Anyone who
  signed previously is unaffected; that agreement only ever granted rights MIT grants anyway.
- **DCO sign-off (`git commit -s`) still applies.** It is a provenance record, not a license grant,
  so the relicense leaves it exactly where it was.

## 0.5.2 — 2026-08-15

**Packaging only: the engine is now on npm, so installing it no longer requires cloning it.** Not
one line of engine behavior changed in this release — the tool surface is byte-for-byte the same
document it was in 0.5.1, and a store written by either release is readable by the other. What
changed is how the code reaches a machine.

Until now the only ways in were a shell script that clones the repository or a `git clone` you ran
yourself. Both work, and both stay. But they ask a user to adopt a checkout — a directory that has
to live somewhere, and that they are now responsible for updating — in order to run a server they
never intend to edit. `npx` asks for none of that.

- **Published as `@2nd1st/open-mcp-apps`.** The name is scoped because the unscoped one is not ours:
  `open-mcp-apps` on the registry is an unrelated package by another author, and it was there first.
  Both READMEs said so already, as a warning to stay off npm entirely; they now say it as a
  disambiguation, which is the more useful form of the same fact and a more necessary one — the risk
  of installing the wrong thing goes *up*, not down, on the day we start telling people to type a
  name that close to it.
- **`npx -y @2nd1st/open-mcp-apps` is a working MCP server**, so a host config can be three lines of
  JSON with no path in it: `{"command": "npx", "args": ["-y", "@2nd1st/open-mcp-apps"]}`. The
  package declares `open-mcp-apps` as its `bin`, pointing at the same `src/server.mjs` that a clone
  has always run. The **stdio and HTTP faces are the same two faces** — nothing about the transport,
  the store location, or the environment variables is special to an npm install.
- **The MCP server still identifies itself as `open-mcp-apps`** at initialize. The package name is
  scoped; the *server* name is not, and deliberately — it is what already-registered hosts match on,
  so scoping the npm name is not allowed to rename anyone's server out from under them.
- **Your data does not move.** The store is a fixed per-user path, not a file inside the install, so
  an `npx` server and a cloned one open the same apps and the same data — and switching between them
  is not a migration.
- **The package claims a name in the official MCP Registry.** `mcpName` declares
  `io.github.2nd1st/open-mcp-apps`, the namespace that GitHub identity entitles us to. The registry
  verifies the claim by reading this field back out of the published tarball, which is why it has to
  travel *inside* the package rather than only in a submission form — a listing nobody can trace
  back to a published artifact is exactly what that check exists to refuse. Directories that index
  the registry rather than crawling npm follow from the same field.
- **What is in the tarball is now a decided list rather than a leftover.** `files` ships the engine,
  the apps, the built runtime, the installer/uninstaller and the licences; the test suite, the
  internal documents and every database stay out. `prepack` rebuilds `dist/shell.js` before the
  tarball is sealed, and unlike the `prepare` hook beside it, it is not allowed to skip quietly when
  its bundler is missing — a published package with a stale runtime in it is exactly the failure
  that hook exists to prevent.

## 0.5.1 — 2026-08-15

**An app stops being a guest in someone's conversation and starts owning a screen.** 0.5.0 made an
app's declaration a first-class object; this release asks the question that follows from it — *where
is this app standing?* — and finds that there are three answers, not one. **In a chat** it is a card
floating in a conversation and something has to draw that card. **On a page it owns** — the browser
viewer, a display on a wall — the frame is already there, and a second border inside it is a double
bezel. **Inside a panel host** it is neither: a region the host has laid out, which wants no chrome
of ours and treats "open another app" as a request rather than as navigation.

Three things came out of that. The **stage contract** lets an app name which ground it is on and
hand the drawing to the kit — every one of the twenty-one apps that predate it is converted, and the
twenty-second was born under it, so no app in the store draws its own card or carries a root width
in CSS any more. **`@live`** is a brick rather than a route: a region that shows whatever the AI
opened last and switches by itself, and the wall built out of it is an ordinary app you can restyle,
split, or throw away and rewrite. And the **panel host becomes a context the engine can be told
about**, through two opt-in URL words that a normal tab never sees.

Underneath, three defects that had been shipping in silence: no sandboxed app could submit a form,
no sandboxed app had ever reported its height, and a viewer whose app did not fit simply lost
whatever fell below the fold.

### Breaking

- **Store schema v6 → v7 — a store opened by this release cannot be opened by 0.5.0.** The upgrade
  is one added table written on first open, and it is disposable: losing it costs a wall display its
  first frame and nothing else. The refusal is the point rather than a side effect, for the reason
  spelled out under `@live` below — several hosts share one store, and a 0.5.0 process would go on
  serving `open_app` while never moving a pointer it has never heard of, leaving a display parked on
  an app nobody is looking at. v4, v5 and v6 stores all upgrade in place, as before.
- **Nothing else breaks.** No tool was added, removed or renamed and no tool's input schema moved —
  the served tool surface is byte-identical to the one 0.5.0 shipped, so no host has to re-approve
  anything. `oma.contract` stays at **2**: the widget runtime lost no name, and additions never bump
  it. `manifest.stage` is a new **optional** field, and an app that declares nothing gets a
  byte-identical document — which is exactly what made it safe to ship the contract under a fleet
  before converting the fleet.

### The stage contract — an app stops drawing its own card

An app is shown in two places that want opposite chrome. **In a chat** it is a card floating in
someone's conversation, and something has to draw that card. **On a screen it owns** — the browser
viewer, a panel host — the page is framed already, and the app's own border inside that frame is a
double bezel. Every app in the store answered this privately: nine drew a full card, four a light
one, three folded it into a gradient; twenty-one carried a root `max-width`, in ten different
numbers; seven pinned `overflow: hidden` on `html`/`body`, which on a fixed-height frame kills the
scroll wheel outright.

The kit now owns the answer, and an app opts in by naming it. Put your root container in `<body>`,
give it **`.k-stage`**, and add `if (oma.standalone) document.body.classList.add("standalone")`. The
kit draws the border, radius, surface and shadow in a chat, **drops the frame entirely below 560px**
(where the host's own widget frame is the card, and a rounded box inside it is the same double bezel
one level up), and draws nothing at all when standalone. `.k-appbar` is the matching header recipe —
a content header with no rule of its own, which becomes the card's title bar in a chat.

How wide the page may get becomes a **declaration** instead of a number in CSS. `manifest.json`
takes an optional `"stage": {"width": "column" | "wide" | "fluid"}` — 760px reading column (the
default), 1120px for boards and calendars, or unbounded for a layout with its own rail. The engine
writes the answer onto `<body>` as `stage-column|wide|fluid` on all three doors that serve an app
(`/view`, the per-app `ui://` resource, and the universal loader's mount source); an app that
declares nothing gets no class and a byte-identical document, which is what makes this safe to ship
under a fleet that has not adopted it. An unknown track name falls back to the default rather than
failing, the same way the store ignores a manifest key it has not heard of: a document written for a
newer engine must still open on an older one. **No tool surface changed** — the class travels in the
document's bytes, not in a new result field.

`habit-streaks` and `project-pulse` are the first two apps converted, as the reference diff for the
rest of the fleet. Both declare `wide`: the board's three lanes had been sharing a 760px column
(214px minimums plus gaps ate 662 of it), and now get 356px each.

**The remaining nineteen followed**, so every app in the store now answers the question the same
way: no app draws its own card, none carries a root width in CSS, and the seven `html`/`body`
`overflow: hidden` declarations are gone — that last one is a bug fix, not tidiness, because on a
fixed-height frame it was the root's overflow and the scroll wheel simply died. Of those nineteen,
eleven declare `column` and eight `wide` — eleven and ten across the whole converted fleet — and not
one of them needed `fluid`; `meal-planner` gave up the library's widest
private value (1240px) once its calendar's real requirement was measured at `126 + 7 × 122 = 980px`.
Two apps that used to **hide** their Ask-AI control when standalone now keep it: `oma.sendMessage`
falls back to the clipboard there, so hiding it removed a working feature from the browser view.
Every hand-off is awaited, disables its button in flight, and judges failure as
`isError === true && !degraded` — a clipboard degradation is not an error, and reading `isError`
alone would put a red strip under every successful standalone click.

The one thing that needed care in every app: **stripping a frame must not strip a face.** Six apps
had painted their identity onto the very element the contract deletes — `companion`'s four-layer
pearl gradient, `wonder-atlas`'s blue-and-gold on a 28px radius, `job-kit`'s grid texture and
masthead bar, and the decorative rings in `client-pipeline` and `hydration-tally`. Each moved into
a content section rather than disappearing with the border. `wonder-atlas` also kept its sticky
top bar working, which is only possible because the kit clips with `overflow: clip` and never
`hidden`: `hidden` would make an ancestor a scrollport and strand the sticky element inside it.
(`dashboard` carried the fleet's last `overflow-x: hidden` on a `body`, and now clips too.)

**A mounted child inherits the page's context.** The contract's judge is `oma.standalone`, and
behind the sandboxed runner that value was hard-coded `false` — so an app mounted by `oma.embed`
was told it sat in a chat no matter what it was actually standing on. On a page that owns its
screen that is the double bezel again, one level further in: a card with its own border and radius
floating inside a region that was supposed to be its ground. It shows brightest on a wall built
from `oma.embed("@live")`, where that region is the whole display. A child now reads the
embedder's own answer instead. **One preset is exempt on purpose**: `inert` is not a mount but a
*picture* of an app, and what the App Store's grid depicts is the widget as a chat would show it —
those thumbnails keep their card whichever page the store itself is open on. The fact travels in
the composed document's bytes, and the line carrying it is written **only when true** — so a
chat-side child is composed exactly as it was before the option existed. The bridge in every child
did gain the getter that reads it; with no flag present it computes the same `false` the hard-coded
literal used to return.

### `@live` — a brick, not a route: the screen that shows whatever the AI just opened

A display nobody is sitting at — a spare tablet on a wall, a second monitor — should show the app
the AI opened last and **switch by itself** when it opens another. This release builds that, and
the shape it settled on is the news.

The first cut was a route, `GET /live`. It never shipped: a route is a screen the engine designed,
and the engine has no business designing screens. So the engine's half is a **primitive** now —
**`oma.embed("@live", {into})`**, a region any app can place — and the screen is an **app**, opened
at `/view/<its name>` like every other app, which you can restyle, split in two, put a clock beside,
or throw away and write your own. `@` cannot begin an app name (`APP_NAME_RE` starts at `[a-z]`), so
the brick borrows a name space no app can ever collide with, and the depth budget is untouched: the
app the brick resolves **is** the one level of nesting `embed` allows.

The brick has two faces, because it is asked in two places. **On a standalone page** it follows the
pointer: mount, and on every switch unmount the old app and mount the new one — through the sandboxed
embed, including for a local app, which every other path mounts directly. A direct mount cannot be
undone; app code runs in the display's own document, so the second app's top-level declarations
collide with the first's and it dies before its first line while nothing removes the first's
listeners and timers. Local apps lose no capability by it. **Inside a chat** it is a quiet tile
saying what it is, and reads nothing at all — no pointer, no poll, no data dependency. The stream it
would need is same-origin to the engine and a widget in a chat host has no such origin; and a region
that swapped apps under someone's conversation would be wrong even if it could.

What makes it work is one field. The app opened last is stored as a **single overwritten row**
(`live_pointer`, schema v7) and **appends nothing to the ledger** — opening an app is not a data
change, and an event per open would both bury the record of what was actually done under a stream of
glances and move the global `seq` that every widget on every host polls, so a glance would refresh
the world. Both doors that open an app record it (`open_app` and the opt-in per-app `open_<name>`),
and only after the app is known to exist — a failed open puts nothing on screen, so it moves nothing.
`/events` carries the pointer alongside `seq` on the same frame, sent once at connect (a display
opened hours later must not sit blank waiting for the next open) and again on every switch, with a
counter behind it so the switch is visible to a viewer in a different process from the chat host
that caused it.

Making the display an app creates one problem a route did not have: **the display can be opened**.
`manifest.json` takes an optional `"stage": {"display": true}` — the sibling of `stage.width`,
because both answer "how does this app sit on a screen" — and it buys two walls. An open door does
not move the pointer for an app that declares it, so the wall is never aimed at itself; and the brick
refuses to mount a declared display however the pointer came to name one, which covers a row written
by an older build or a store edited by hand. Two walls rather than one because they fail differently:
the first keeps the bad value from being written, the second holds when it was written anyway.

**A store opened by this release cannot be opened by 0.5.0** (schema v7). That is the point rather
than a side effect: several hosts share one store, and an older process would go on serving
`open_app` without ever moving a pointer it has never heard of, leaving the display parked on an app
nobody is looking at. The upgrade itself is one added table on first open, and it is disposable —
losing it costs the display its first frame and nothing else.

**A declared display opens chrome-less.** `/view/<name>` puts a viewer bar above the app and a
page-sized card around it — right for a tab, wrong for a screen the app was written to own, where
it is that same double bezel one level up: an "← All apps" link over a wall nobody is standing at,
and a rounded card under a region meant to reach every edge. `stage.display: true` already says
this app is the frame rather than the picture, so it now decides this too, and **`?chrome=1`** is
the way back for anyone building one in a tab. Both doors read the one answer, because a display
served through the universal loader (a non-local tier) is the same screen. Nothing else moves:
`/view` still defaults to the tab's chrome for every app that declares no display, and `?chrome=0`
still strips it for any of them.

**The App Store ships one, and it is the worked example.** `live` is the twenty-second app on the
shelf — a full-bleed `@live` region under a bar that says only what it is — and it is the reference
for the whole `stage.display` class, the way `habit-streaks` is the reference for the width tracks.
It is also the only app in the store that needed `stage.width: "fluid"`. Install it on a spare
tablet, open it at `/view/live`, and the display is done (note: the viewer binds `127.0.0.1`, so a
*separate* device reaches `/view/live` only through a tunnel you start yourself — see README's
"The browser viewer, and the port it binds"; on this machine it is a second window, no tunnel); the
point of making it an app rather than a route is that the next line you write in it is yours.

One property is worth stating because it is not obvious from the API: **the switch rides `/events`
and nothing else.** There is no poll behind it. A dropped feed leaves the last app on screen,
`EventSource` reconnects on its own, and the connect frame carries the current pointer — so a
display that missed a switch catches up rather than staying wrong. That is a different axis from
data freshness, which does have a poll behind it; `RUNTIME.md` and the authoring guide now say so in
both places, so nobody carries the guarantee across from one to the other.

### The panel host — a region someone laid out, not a page

A third kind of ground showed up in real use: a host that opens an app inside a panel it manages,
with its own tabs, sessions and containers around it. Two things we do are wrong there, and neither
is visible from inside the app, so the engine now lets **whoever opens the page** say so. Both are
**opt-in** and orthogonal on purpose — `chrome` is about what this page *draws*, `nav` is about
where a link *goes*; a panel host usually wants both, a plain tab wants neither.

- **`?chrome=0`** opens a URL door onto the switch `/view` already had: no "← All apps" bar, no
  page-sized stage, just the app. (`?chrome=1` is the way back for a display, which now defaults the
  other way — see above.)
- **`?nav=intent`** turns app→app links into a message instead of a navigation. There is exactly one
  way apps link to each other — `<a href="{oma.viewBase}{name}">`, which is the App Store's Open
  button and the settings link in every widget's corner — and in a browser tab following it is
  exactly right. In a panel host it replaces the document *underneath* the destination the host had
  prepared, so a click on Open leaves the store's own frame showing a different app while every
  container the host built goes unused. With this on, the runtime catches such clicks in the capture
  phase and posts `{type: "openmcp:open-app", name}` to the embedder instead, which is the word the
  hosted shell was already listening for. **Three cases are deliberately not intercepted**, each for
  its own reason: a top-level page (`parent === window`), where there is nobody to tell and
  `preventDefault` would merely break every link; a link that is not under this document's
  `viewBase` or whose last segment is not an app name, because this only claims our own navigation
  vocabulary; and a click carrying a modifier key or a `target`, where the user is talking to the
  browser and that request is not ours to rewrite. Known boundary: an app on a non-local tier runs
  inside the runner's sandboxed child, which this listener cannot reach — every AI-written app and
  every App Store install is local.

### Fixed

- **No sandboxed app could submit a form**, which is to say the "add an item" half of most apps was
  dead everywhere the runner mounts them — every app inside an `@live` region, every `oma.embed`
  child, and the hosted `/app` shell built on the same loader. The frame carried
  `sandbox="allow-scripts"`, and the missing
  token was read for years as "the app cannot POST a form off-site." It is not: Chrome refuses a
  sandboxed form inside `PrepareForSubmission`, **before it dispatches `submit`**, so the app's own
  `onsubmit` handler never ran and the `preventDefault()` inside it never got the chance. Nothing
  went wrong on screen — no error the user could see, no request on the wire, just a button that did
  nothing — while the same app opened at `/view`, where a local app is direct-mounted, worked
  perfectly. 17 of the 23 apps in `components/` hang their add/edit form off that handler.
  `allow-forms` is granted now, and the submission stays closed by three walls that each block the
  navigation while leaving the event alone: the child's `form-action 'none'`, the embedder's
  `frame-src 'none'`, and an unconditional cancel in the bridge. That third one is what makes the
  grant free rather than merely safe — an app that forgets `preventDefault()` behaves exactly as it
  did before instead of navigating its own frame to a blocked page and going blank. This is also the
  bill for a piece of depth bought in July: `form-action 'none'` was added to the runner CSP
  specifically so that no exfiltration channel would depend on one attribute staying absent, and
  that is precisely what let the attribute be granted the moment it turned out to be blocking
  something else.

- **No sandboxed app has been able to report its height since the runner shipped**, so every
  embedded frame sat at its initial 140px for the life of the page — the app inside it scrolling in a
  letterbox — on the settings badge's live embed and on every loader embed alike. The child's
  height machinery is injected by `toString()`, and one injected body calls a sibling **by name**;
  `dist/shell.js` is minified, so the name that body asked for was the bundler's two-letter one while
  the helper beside it was declared under the name written in the source. The ReferenceError landed
  inside the broadcast's own `catch` and was perfectly silent. Nothing could see it either: every
  test reads the source module, where the two names already agree. The helper is now declared under
  the name it has at runtime, and a test builds the real artifact and runs the injected source the
  way the browser does. Frames that never grew now size to their content (measured in Chrome:
  140px → 413px); `fit` thumbnails, which never used this channel, are unaffected.

- **An app taller than the viewer's window lost everything below the fold.** The viewer is a window
  onto an app, and the height of that page belongs to the window (in a tab) or to the frame (in a
  panel host that lays one out) — never to the app. Seven of the shipped apps declared
  `html, body { overflow: hidden }`, which is right on a host that gives an app whatever height it
  asks for and is a dead scroll wheel on a fixed-height frame: the root element's overflow *is* the
  viewport's. Measured on a 537px-tall frame holding a 1127px document, there was not one scrollable
  element in the whole tree, and 590px of the app was unreachable — the same reading in an ordinary
  537px browser tab, so this long predates any panel host. Two independent repairs: those seven
  declarations are gone with the stage contract above, and the viewer's standalone path now puts
  `overflow-y: auto` on the root element unconditionally, so an app that reintroduces the mistake —
  or that is simply taller than the window — still scrolls. It costs nothing when the app fits: no
  overflow, no scrollbar. `body` is deliberately left alone, because an auto-height `body` is a
  scroll container that can never scroll, and binding one strands every `position: sticky`
  descendant inside it — which is exactly the shape of the App Store's and settings' pinned bars.

- **A release could silently skip an edit the publisher was told it MUST make.** The snapshot
  publisher applies a short list of scrubs to the temp copies before staging — two of them rewrite
  the READMEs' link to the internal security document into a link to `SECURITY.md`, because the
  internal `docs/` tree never enters a public snapshot. A scrub whose literal text had drifted
  (someone reworded that paragraph) pushed a `NO-OP` line into a summary that is only ever printed
  and the run continued, so the release went out reporting success with a README pointing at a file
  no reader has. The field is called `mustFind` and now means it: a miss aborts the run, names the
  scrub and the pattern, and says the two honest ways forward — retarget it, or delete the entry so
  that dropping a scrub is a decision somebody made rather than a miss nobody read. Found by the
  guards-with-escape-hatches sweep on 2026-08-04 as its fifth instance of one shape — *a guard that,
  under some condition, stops judging, and nothing guards that condition.*

### Also

- **Both READMEs were realigned to what the engine actually does**, which mostly meant repairing
  three places where the document was older than the code: the MCP Apps extension is described by
  its current identifier and status rather than by the SEP number it carried while it was still a
  proposal; "from that moment `open_<name>` is a tool" became true only under `OMA_DYNAMIC_TOOLS=1`,
  and the paragraph now says which two hosts the installer turns it on for, that the price is one
  approval prompt per app, and that it is a deliberate and temporary workaround with a
  `KNOWN-ISSUES.md` entry behind it; and the host matrix carries the ChatGPT-web data-after-refresh
  caveat instead of a row that read unqualified green. The install section also states its
  prerequisites (Node 22 or newer, and `git`) rather than letting the installer be the one to
  mention them.
- **`RUNTIME.md` and the authoring guide** gained the `@live` brick and both halves of the `stage`
  declaration, so the two things an app *author* can reach for in this release are reachable from
  the documents they are actually pointed at. The two URL words are addressed to whoever **opens**
  the page rather than to whoever writes the app, and this entry is their contract.
- **Three reported "upstream drifts" were the instrument moving, not upstream.** The dependency
  watcher was reading a search API whose result window shifts on its own, so it kept reporting
  changes nobody had made. Fixed at the instrument before the baseline was refreshed — a baseline
  rebuilt on top of a lying probe would have made the lie permanent.
- **Release tooling**: the rule that used to be enforced by a directory's existence now lives in the
  publisher's forbidden-path families, so it holds after the directory is gone; and the dead-name
  list learned the 0.5.0 generation of renamed tools, so a grep that lands on an old name reports it
  instead of returning a plausible-looking hit.

## 0.5.0 — 2026-08-14

**Breaking, and the largest change since the engine existed.** Three things moved at once: an app's
declaration left its own document and became a first-class object the engine stores; deleting a row
stopped being something every app had to remember to ask about and became something the engine
enforces; and an app can now expose a **function** — a data→data closure the AI can call without
rendering anything.

Under all of it the SDK moved from v1 to v2 and the tool surface got audited by asking one question
of every line — *"rebuilding this module today, knowing everything we have measured, would this line
exist?"* — which took the surface from 36 tools to 33 and removed roughly a thousand lines of layers
built for an era, a product or a caller that never arrived.

### Breaking

- **Five tools are gone.** `app_permissions` (its answer was already inside `app_html`, which
  settings calls for every app anyway — that result now carries `locked`, and `list_apps` rows do
  too); `archive_app` (the seat, not the concept — the store command, the ledger event and the
  restore path are untouched, and the seat comes back the day something calls it); `data_query`
  (with its `OMA_QUERY` flag and the whole DSL behind it — it shipped dormant and stayed dormant, and
  the measured incident that motivated it was not being solved by a seat nobody could reach);
  `file_write_abort` (the 30-minute TTL already reclaimed abandoned uploads, and the abort verb was
  what created the abort-vs-commit race that 0.4.2 had to fix); `render_health` and its automatic
  source rollback (never once triggered on a real host — a failed mount now says so and points at
  `app_history` → `restore_app`).
- **Two tools are new**: `promote_app` and `call_function`. Both are described below.
- **`save_app` takes `ui`, not `html`, and `manifest` is a parameter again.** An app's declaration
  used to live in an `#oma-manifest` block inside the document, and the stored `manifest` column was
  a projection of it. That is inverted: the column is authoritative, the document is pure UI, and
  **a document containing the block is now refused** (`embedded_manifest_block`) with a pointer at
  the parameter. The three states are explicit — absent inherits the head revision, an object
  replaces wholesale, `null` clears (and resets everything derived from it), and `{}` is refused
  (`empty_manifest_use_null`) because it looked like both a legal empty declaration and the old
  "empty block means clear".
- **`get_app` takes `slot: "ui" | "manifest"`** (default `ui`, window semantics unchanged), and
  `promote_app` / `edit_app` operate on the slots rather than on bytes inside the document.
  `app_html` keeps its name and its `html` field: it returns the wrapped product, not a slot.
- **The library is now the App Store, and four tool names change with it**: `library_list` →
  `app_store_list`, `library_preview` → `app_store_preview`, `install_from_library` →
  `install_from_app_store`, and the system app `library` → `app-store` (so its per-app opener,
  under `OMA_DYNAMIC_TOOLS`, is `open_app_store`). The old names are gone rather than aliased — a
  call to `library_list` now fails as an unknown tool, and any host holding a cached tool list must
  re-list. One output key moves with them: `app_store_list` entries report `from_app_store` where
  they used to report `from_library`. Two things deliberately did **not** move. The provenance
  stamp an install writes is still the actor `library`, because that value is already sitting in
  every existing store and renaming it would be a data migration bought for a word; and the
  reserved control-plane prefix follows the tools, so `app_store_*` is what a sandboxed app is now
  refused by (`library_*` no longer means anything). **Upgrading an existing store replaces the old
  app rather than leaving it behind**: the first `seedSystemApps` run after the upgrade deletes the
  `library` row it originally wrote and installs `app-store` in the same pass. The delete goes
  through the store like any other, so it is one `component_deleted` in the ledger and the bytes
  stay recoverable from `app_history`. Only a row this seeder authored is touched — an app **you**
  named `library` has a different author and is left exactly where it is, with a line in the seed
  log saying so.
- **The App Store ships as directories**: `components/<name>/{ui.html, manifest.json, fixtures.json}`
  instead of one flat `<name>.html`. Anyone maintaining an entry out of tree moves two files.
- **`app_html` lost its `offset`/`length` window, `list_apps` lost `limit`,** and `save_app` lost the
  retired `manifest`/`scene` shapes it was still declaring in order to reject them. Only tests were
  calling any of them.
- **The widget runtime lost four names**: `oma.updateContext`, `oma.host`,
  `oma.isControlPlaneTool` and the public `oma.bind` (now an internal hook for the universal loader,
  its only caller). `oma.readCollection` no longer takes options — its one consumer never passed
  them, and the paged walk is what it always did. `oma.callFunction` is the reverse case: it existed
  as a method that could only fail, was removed for that reason, and **returns in this release with
  an executor behind it**. Accordingly **`oma.contract` bumps 1 → 2** — the number exists precisely
  for removals an externally-authored app could notice; additions never bump it.
- **The `update_context` capability left the permission surface.** It was the one capability in
  `CAP_NAMES` with no enforcement point anywhere — the runner never read it, because the method it
  was supposed to gate left the runtime above — and yet `security_set` accepted
  `security:<app>:update_context`, `app_html` served it in `caps`, and the Permissions pane drew a
  switch for it. A switch a person can set that can never take effect is worse than no switch: it is
  the panel telling them something about their own security that is not true. The name is gone from
  `CAP_NAMES`, from both tier presets, from the served caps shape and from the pane. Existing
  `security:<app>:update_context` rows need no migration — `computeCaps` only ever looks up the caps
  it knows, so a legacy row is read past in silence; writing a new one now lands on the unknown-cap
  path, which stores the key and says in the receipt that it has no effect.
- **Store schema v6, and pre-v4 stores are refused.** The upgrade path is below.

### The declaration is now an object, and history keeps both slots

`app_history` became a revision table: every save snapshots **both** slots (`ui` and `manifest`), so
`restore_app` and undo bring back the pair rather than the document alone. Version numbers, the OCC
token and the checkpoint numbering a person reads are all unchanged — the ledger position is still
the single axis, and this deliberately did **not** become a content-addressed store with parent
commits. A single-headed linear history can derive the parent; the packaging boundary does not
depend on CAS; and the second real source slot (a backend, a script) does not exist yet.
`manifest`-only saves produce a real revision, and their receipt says `manifest_action:
inherited | replaced | cleared` so a save that changed only the declaration does not read as a
no-op.

`app_store_list` compares **both** slots when deciding whether a shipped app is newer than the
installed one. It compared only the HTML before, which meant a manifest-only update to an App Store
app could never install.

### Migration

`MIGRATIONS` runs v4 → v5 → v6 on first open, in one transaction each, and a store from **0.4.2
upgrades in a single open with nothing lost**. v5 drops the columns that were reserved for shapes
that never arrived; v6 rebuilds the app and history tables, renames `html` to `ui`, and backfills
every revision's manifest by **replaying the ledger** rather than by re-parsing what happens to be
on disk — so a document that was saved without a declaration inherits the previous revision's, and
an app deleted and recreated under the same name starts a new life instead of inheriting through the
tombstone. The block is then stripped from every stored revision by exact byte deletion, because a
block left behind would be a declaration that is present and silently inert.

Two deliberate refusals: a manifest that will not parse **fails the whole migration** and leaves the
store on v5, naming every offending revision, rather than quarantining anything — salvaging a broken
declaration means deciding on the author's behalf what they declared. And a store older than v4 is
refused without a byte being written; the version gate now runs **before** the WAL switch, which is
also a fix (see below).

**A store opened by this release cannot be opened by 0.4.x.** Every host registration and the
browser viewer must be running the new code after the upgrade.

### Deletion is confirmed by the engine, not by each app

Every app that could delete a row used to implement its own "click once to arm, again to delete".
Twelve did; the ones that forgot simply deleted. That is now the engine's job, at the point where it
cannot be routed around — inside the store transaction that every tool, every batch and every widget
bridge passes through.

- A human-initiated delete with the `confirm_delete` preference on comes back **not as an error** but
  as a demand: `confirmation_required`, a server-derived preview, an expiry, and a `request_state`.
  Re-sending the same call with that state performs it. The state is an HMAC over the actor, the
  target and **the target row's ledger position**, so it is single-use by construction rather than by
  a table of spent nonces: the row it names cannot exist at that position twice.
- **The shell renders the card; app authors write nothing.** In direct mode `oma.deleteItem` raises
  it; in an embedded sandbox the runner intercepts the demand and suspends the child's promise. The
  eleven apps carrying their own arm-then-delete had it removed — with it in place, a user with the
  preference on had to click three times.
- **A burst becomes one card.** Settings' "Reset all" fired a card per row. Demands arriving while a
  card is open now merge into it (*"Delete N items, including …"*), answered once; each row still
  spends its own `request_state`, so the engine's per-row ledger model is untouched and the card is
  only plural in the UI. The card's deadline is the shortest of its members' — an answer must not
  outlive the shortest-lived thing it authorises.
- **The keys are process-local and random**, so they never reach disk and a restart invalidates
  every outstanding demand. Fail-closed is the right direction for a question about deleting.

Two verbs are exempt on purpose and say so: ledger reversal and `security_set` (an undo *is* the
user's explicit statement about a ledger fact), and file **overwrite** is left to the existing
destructive annotation rather than being quietly folded in.

**`delete_app` can take the data with it again.** Cascade returned, rebuilt on the same
`request_state` machinery instead of the hand-rolled plan token it used to carry: the first call
comes back with the full disposition — which collections would go, which are kept, and the engine's
reason for each — and the state binds the app's version, every candidate collection's ledger
position and the settings stream, so any write in between invalidates it and the caller gets a fresh
plan rather than executing a stale one. The demand is unconditional, ignoring the `confirm_delete`
preference: that preference governs recoverable row deletes, and this destroys whole collections with
no undo. A collection another app also uses, or one whose ownership cannot be established, is never
deleted. Settings grows a **"Delete its data too"** checkbox that renders the plan and re-sends it
verbatim.

### Functions

An app can declare functions in its manifest — `{name: {description?, params?, public?}}` — and carry
their bodies in the document as `<script type="text/oma-function" data-fn="NAME">`. A declaration
without a body, or a body without a declaration, is a **loud refusal in both directions**: the two
silences are the same mistake.

- They run in the engine, in `node:vm`, against a frozen `api` of `list` / `count` / `add` /
  `update` over the app's own binding plus the collections its manifest stewards. Settings are
  walled off permanently.
- **Bodies are synchronous, and that is the design rather than a limitation.** The store is
  synchronous, so a synchronous body makes the vm's timeout a real budget — an async body escapes to
  the host's microtask queue where nothing can interrupt it. Returning a thenable is
  `async_not_supported`. Code generation from strings is off; there is no `require`, `process`,
  `fetch` or timer.
- Budgets: 2s wall clock, 100 writes, 200 reads, a 32 KB result that is **refused rather than
  truncated**. Depth is 1 by construction — the api has no `call`, so a function cannot reach a
  function.
- **There is no `api.delete`.** The confirmation gate above lives in the engine and has no delivery
  channel from inside a function on any host we have measured; the verb arrives when that channel
  does.
- Every write a function makes is stamped `via: {app, function}` **by the engine**, never from the
  function's own arguments, with the originating actor passed through. That stamp lands in the raw
  ledger and deliberately does not reach the AI-facing change feed.
- `call_function {app, function, args, command_id}` is a single dispatcher that fails with schema:
  an unknown name answers with the roster, bad arguments answer with the violations and the declared
  parameters, so a retry needs no extra read. Its `app` and `function` parameters carry
  `x-mcp-header` annotations, so an edge can see which function was called rather than only the
  dispatcher.
- **The seat is opt-in at `createEngine` and absent by default.** Only this engine's own local
  entry points ask for it; `OMA_FUNCTIONS=0` turns it off. A hosted, multi-tenant deployment cannot
  inherit in-process execution by construction — the vm is an isolation seam, not a hardening
  boundary, and the trust level here is the same as the app's own browser JavaScript.

### Added

- **`promote_app`** — one call turns a `visual` into an `app`. It rides the same `save_app` store
  command, so the provenance lock, undo, the history row, the invalidation bridge and idempotent
  replay all hold without a second copy of any rule, and the whole promotion is the single
  `component_saved` event it always was. Only that direction: demotion is an author's edit, not a
  lifecycle verb. Alongside it, `save_app` and `edit_app` receipts carry **one sentence** of
  diagnosis when an app still declares itself `visual` while its source binds persistent data — as
  prose, never as a structured field, because the arbitration that permitted the diagnosis forbade
  anything downstream consuming it, and unreachability enforces that where good intentions do not.
- **Edits by range.** `get_app`'s window now returns a `hash` covering exactly the text it returned,
  and `edit_app` accepts `{offset, length, expect_hash, new_string}` alongside the existing
  exact-string form. Having read a window, a model can edit it without sending an anchor back up.
  The hash does not defend against concurrency — OCC already does — it defends against the caller:
  a mistyped offset used to be a **silent wrong cut into someone's source**, and is now a clean
  `hash_mismatch` telling you to re-read that window. `get_app` also takes `node`, which snaps the
  window to a `data-oma-node="…"` element; the locator lives on the read side on purpose, where an
  ambiguity costs one more question instead of a bad edit.
- **The host is told when its list of apps goes stale.** `registerApp` has always registered the
  `ui://` resource the moment the AI saves an app, and nothing ever notified anybody — so a client
  that had listed resources once held a stale list for the rest of the session, and **an app created
  mid-conversation was invisible to every direct embed path until reconnect**. The engine now
  declares `resources: {subscribe, listChanged}` and emits `resource_updated` for a change to a
  registered document, `resources_list_changed` when the set itself changes. A burst of saves folds
  into one notification per class. Item, settings and file writes deliberately emit **nothing** —
  MCP models no collection as a resource, so there is nothing in the host's hands to invalidate, and
  inventing per-collection resources to have something to invalidate would be adding surface for the
  mechanism rather than for the user. `tools/list_changed` is declared and sent only when dynamic
  tools are on: with them off the tool surface is a constant, and announcing a change would spend
  every user's prompt cache on a fact that did not happen.
- **A row of system badges on every app** — refresh, **⚙ open settings**, **⧉ open in the browser** —
  built out of machinery that already existed (`oma.embed` for the settings pane, the host's
  `ui/open-link` for the browser). The browser badge is not created at all when the engine has no
  viewer (`OMA_VIEWER=0`), rather than being created and inert. Two measured limits are written down
  rather than discovered again later: the embedded settings pane is a sandboxed child, so it can
  change preferences and data but not delete, restore or install apps; and a child cannot embed, so
  its own thumbnails degrade to skeletons.
- **Four new App Store apps, taking the store from 17 entries to 21**: `client-pipeline` (the
  overdue invoice and the next follow-up, neither of them missable), `job-kit` (a phone-first field
  board for tool locations, live jobs and site hand-overs), `meeting-actions` (meeting notes turned
  into what you own, what you are waiting on, and what is blocking the work) and `wonder-atlas` (the
  questions worth keeping). The seventeen entries that were already there were reworked in the same
  pass, narrow widths in particular — these apps are what a new user browses before installing
  anything, so how they read on a phone is not a detail of the store, it is the store.
- **Preview documents can carry preferences, and one of them freezes the clock.**
  `composePreviewDoc` and `stubOmaScript` take a `prefs` object, and the inert `oma.pref` answers
  from it instead of always handing back the caller's fallback. The one that earns its place is
  `preview_date`: a `YYYY-MM-DD` string that shadows `Date` inside the preview document, so a sample
  month written for 2026-08-06 reads the same for a visitor arriving three weeks later instead of
  quietly filling with overdue rows. It is scoped to the inert document by construction — the live
  app runtime never receives the preference and never gets a shimmed clock.
- **Editing telemetry, for one decision.** Every edit — succeeded or failed, because the failures are
  the denominator — appends a line to a JSONL sidecar next to the database, and
  `scripts/edit-telemetry-report.mjs` computes the two numbers that decide whether the range-edit
  primitive is enough or whether this engine needs a source graph. The script reports; it does not
  rule. The file is blocked from both the git index and the publish snapshot: it carries host names.

### Changed

- **`@modelcontextprotocol/sdk` v1 → `@modelcontextprotocol/{server,client,node}` v2**, with
  `2026-07-28` in the supported protocol versions and per-request `_meta` carrying `clientInfo` for
  identity. Caching hints are now expressed as a policy module over the SDK's native hint mechanism.
  The tool schemas read identically under either JSON Schema dialect.
- **The audit that removed the tools above also removed the layers behind them**: the pre-v4
  migration ladder, the ledger retention/pruning subsystem (zero production callers — and with it the
  branch defending against pruning erasing cascade evidence), the remote file-backend seam and its
  `OMA_FILE_BACKEND` flag, five reserved columns and two dormant dimensions, the per-iframe rate
  limiter (its thresholds admitted in their own comment to being guesses, and the only time it ever
  fired it interrupted a legitimate dashboard preview), the `readonly` sandbox preset, and 93 lines
  of forensics that ran when a widget lost its identity and always reached the same conclusion.
  Net: −2,556 lines.
- **Internal tools are marked `visibility: ["app"]`** per the MCP Apps standard — `app_html`,
  `app_store_preview`, `ui_prefs_schema`, `security_set`. Nothing is removed and no behaviour changes;
  they simply stop occupying the model's attention, which cut the model-visible surface by 29% at
  the point it landed.
- The tool surface is **33 tools / 44,911 B** (cap 47,935), down from 36 / 47,890 B in 0.4.2.
  As in 0.4.0, renamed and removed tools mean **hosts will ask you to approve the tools again** and
  the prompt cache misses once.
- One policy now has one home. The set of tools that carry a widget's *human* action was written
  twice — once for direct mode, once for the sandbox bridge — and had already drifted once
  (`file_delete` was missing from one of them). The CSP policy string was also written twice, and
  that copy had drifted too: the viewer's had lost `form-action 'none'`, the one outbound shape that
  does not inherit `default-src`. Both are single-sourced, and the engine's index page — which had
  no CSP at all — got one.
- **`oma.embed` takes `fit: {width}`.** Settings and the App Store each had their own thumbnail
  scaling, by different mechanisms at different natural widths; both now declare a width and use the
  shared one. The two widths are kept at their existing values rather than unified, because that is
  a visual decision and not this change's to make.
- **A widget can no longer reach `data_batch` through the generic `oma.callTool` door.** One call
  could clear a collection with every row attributed to an agent in the ledger, and the ledger half
  is append-only — unfixable after the fact. Apps delete row by row, each with its own confirmation.
  For the same reason the four data-writing tools are stamped `actor: "human"` when a widget calls
  them by name: the same deletion should not depend on which method name was used to reach it.
- **Settings and the App Store were rebuilt.** They are the two system apps a user actually sits in
  front of, and they were the two apps least like the ones they present. The App Store is a
  storefront now: a fixed left rail (search, Discover, featured, category counts, how many entries
  are on the shelf), one large featured card, a row of editors' picks, a wall of category cards, and
  the drawer replaced by a real detail page — preview, install, metadata strip, related apps. At
  narrow widths the rail becomes a top bar with a horizontally scrolling category strip. Settings
  gets the same treatment: left-rail navigation, row-grouped cards, its drawer replaced by an
  in-place detail page, a top tab bar when the window is narrow. Both are fully bilingual (en/zh)
  and take every colour from a host token rather than a literal — the rule the rest of the store
  already followed and these two did not. Thumbnails are budgeted rather than unbounded: settings
  mounts at most six preview iframes and none at all when the window is narrow.

### Security

- **`security_set` failed open on a value it did not recognise.** Given a known capability with an
  unknown value — `ask`, which the tool's own parameter description advertised and which has never
  existed — it silently fell back to the tier default, and on the local tier that default is
  permissive. So a caller could set a restriction, receive a success receipt, and have nothing
  restricted. It now refuses loudly, lists the legal values for that capability (read from the same
  place the coercion reads, so the wording cannot drift from the check), and says explicitly that
  **nothing was written**. The parameter description no longer advertises a value that does not
  exist.
- **The refusal to open a future-schema store used to modify the file first.** The version check
  ran after the WAL switch, so a store from a newer engine was told it could not be downgraded —
  after its header had already been rewritten. The gate now runs before anything is written, and the
  refusal leaves the file byte-identical.
- **Development note (never shipped):** the confirmation layer above was built, adversarially
  reviewed twice, and four routes around its own guarantee were found and closed before any of it
  left the repository — a declined confirmation returning the credential back into the sandbox where
  the child could replay it, a preference parser that disagreed with the one the settings UI
  displays, the generic `callTool` door, and a classification table that named `delete_file` as
  requiring confirmation while nothing was wired to it. Each is now pinned by a test that goes red.
  The last one is the one worth naming: **a protection that is declared and not connected is worse
  than one that was never declared**, because it reads as done.

### Fixed

- **A refreshed widget on ChatGPT could come back permanently empty.** The host replays *a different
  call's* envelope after a refresh, so none of the three triggers that start a data walk ever fired —
  the UI painted and the data was never requested again, while a single write from the widget
  restored everything, because the write path forces a walk on completion. The identity was already
  being written to a note the host carries across renders; nothing was kicking the walk after
  reading it back. Two additions: a recovery ladder at 0.8s / 2.5s / 7s after connect that re-binds
  from the note and re-walks, stopping the moment a full read succeeds (on a healthy host the first
  walk beats the first rung, so the ladder is never felt), and — if the ladder finishes with nothing
  loaded — a **`↻ Load data`** badge, which also serves as a user gesture on hosts that gate tool
  calls behind one, and retires itself on success. **This is a mitigation of someone else's
  behaviour, and it has not been re-measured on that host since.** `KNOWN-ISSUES.md` says so.
- **`restore_app` counted a retry as a restore.** Replaying the same `command_id` restored again
  each time — measured going from checkpoint 1 to 4 across three replays of one request — so a
  caller who lost the response could not tell a completed restore from a failed one, and retrying
  moved the app. It now returns the original receipt.
- **Two writes were skipping the version check entirely.** `restore_app` read history outside the
  transaction and saved without `expected_version`, and `install_from_app_store` did the same; both
  now carry it. (`delete_app` still deletes the current head unconditionally — deliberate for now,
  and recorded as an open question rather than fixed quietly.)
- **The upgrade from 0.4.2 refused almost every real store.** Rehearsed against read-only copies of
  six production stores, the v5 → v6 rung refused five — and not one of the five was corrupt. It was
  strict about its own *assumptions* rather than about the data, in two places. First, it
  cross-checked each app's head declaration against the materialised `manifest` column and called
  any disagreement `projection_mismatch` — but 0.4.2's projection had gaps in both directions. It
  never materialised a declaration carrying no `collections` key, which is the `uses_shared`-only
  form every App Store app ships, so **any store that had ever installed one was refused**; and its
  upsert could carry a previous projection forward across a save whose document had dropped the
  block, leaving a column the document is silent about. Where only one side ever spoke, that side is
  now taken as the declaration — adopted at the head slot, and on the head revision too, or the next
  ui-only edit would inherit a null and quietly clear it — and a value adopted from the column has to
  be one this build would still accept at the save door. Where **both** sides speak and differ, the
  migration refuses exactly as before: that is the case with real ambiguity in it, and "refuse rather
  than guess" was never meant to cover a one-sided statement. Second, it addressed each revision by
  `(aggregate_id, seq)`, which is exact only for revisions written by 0.4.x — seed-era rows are
  numbered by a per-app counter, and one system app was renamed in place, so the ledger says
  `gallery` where the tables say `library`. A revision and its event are written in one transaction
  from one clock read, so when that key misses, the timestamp identifies the row: consulted only
  after the key misses, required to land on exactly one revision that no other event claims, and
  never inventing anything. A save event with no revision anywhere — or an ambiguous timestamp — is
  still fatal.
- **`oma.updateContext` resolved with `null` when the sandbox refused it**, so a caller could not
  distinguish "updated" from "refused" — flatly contradicting the sentence in `RUNTIME.md` that says
  a refusal rejects the promise. The method had no callers and is gone; the contradiction goes with
  it.
- **`data_query`'s enabled handler had never been executed by a test.** It is no longer in the
  surface, which resolves the gap in the only way that does not involve believing an untested path.
- **Five design tokens the whole store was already using had never been defined.**
  `--color-text-warning` and `--color-text-info` are named by 20 and 22 of the apps in `components/`
  and `--shadow-md` by 14, but no layer under them ever gave them a value — so every one of those
  references fell through to whatever literal the author had typed after the comma. That is exactly
  the hardcoded colour this token layer exists to prevent, and it was invisible precisely because
  the fallback looked fine. The five now have values, chosen so the common fallbacks resolve to the
  same paint they were already showing; `--shadow-xs` also joins the set forwarded into embedded
  children, and `RUNTIME.md`'s token table lists all five, because a token an app cannot look up is
  a token an app will hardcode.
- **A filtered or tabbed app could not shrink back down.** Height was reported as
  `document.documentElement.scrollHeight`, and Chromium keeps that at least as tall as the viewport —
  so feeding it back into the iframe meant an app that had once been tall stayed tall, with a long
  blank tail under the content. Height is measured from the body's real children now
  (`measureNaturalBodyHeight`), and both height broadcasters — the sandboxed bridge and the
  standalone preview document — call the same function, so the two cannot drift apart again.
- **The App Store showed half a sentence for four of its apps.** The blurb parser let either quote
  character close the attribute regardless of which one had opened it, so a `content="…"` holding an
  apostrophe ended at the apostrophe: `elder-days` advertised itself as "A clear daily care record
  for today". The closing quote is a back-reference to the opening one now, and a test sweeps every
  shipped entry to assert the blurb that came back still sits between its own quotes in the source.
- **Four defects the rebuilt system apps only revealed in a real browser.** The App Store's left-rail
  search box, a flex child in a column, grew to 3,618 px and pushed the navigation off the bottom of
  the page; the featured card's 3-D tilt left its preview iframe intermittently unpainted; the
  preview budget's "evict the oldest, then re-observe" pass was an ownerless race (eight previews
  declared live, five actually mounted) and is now one idempotent pass ordered by distance from the
  viewport centre; and every store card read a `list_apps` field that does not exist, so all of them
  displayed `NaNk`.
- **Nine App Store apps crashed on their first open in a chat** — `Cannot set properties of null
  (setting 'content')`, leaving the title bar and an empty body. Each of them wrote its localised
  page description back into `<meta name="description">` at runtime, which is meaningful on a web
  page and is nothing here: the App Store reads that blurb from the source bytes, never from the
  DOM. It survived because the two paths a developer looks at both keep the tag — the browser
  viewer wraps the app's own `<head>`, and so does the per-app resource — while `open_app`, the
  door a chat actually uses, mounts through the universal loader, which copies `head style` and the
  body and drops everything else in the head. So the write was dead code on every path and a
  guaranteed `TypeError` on the one path most users take. The nine writes are gone; the
  `document.title` assignment beside each of them stays, because the viewer shows it.
- **The settings app and the App Store rendered with no card around them inside a chat**, tab strip
  and search bar butted straight against the conversation, while every other app in the store draws
  itself an app-bar over a bordered surface. Their narrow form had been rebuilt around a desktop
  rail and lost the capsule on the way. Both draw it again — mark, eyebrow, name, status over a
  bordered, rounded surface — and the condition is the **context, not the width**: hanging it on
  `(max-width: 560px)` fixed nothing on the machine that reported it, because a desktop chat widget
  is about 736px wide and never matched. It is `:not(.standalone)` now, so a card in a conversation
  is framed at any width — the wide form keeps its rail-and-main layout *inside* the capsule, with
  the app bar spanning both columns and flattening to a single line — and the browser viewer is
  never framed, because the runtime's own stage already does it.
- **That capsule then let the App Store's app bar float in the middle of its own content.** Scrolled,
  the sticky bar stopped 12px short of the frame's top edge and the band above it kept painting
  whatever had scrolled past — on Leo's transcript, the bottom half of the featured title, with the
  bar reading as suspended in the content rather than capping it. The 12px was the capsule's inset,
  written as the scroller's *padding* — and a scroll container is asymmetric about its own padding,
  clipping at the padding box while constraining a sticky box to the *content* box, so the two edges
  were 12px apart by construction. The same inset is the card's own margin now, which puts both
  edges at zero whoever the scroll container turns out to be — the bar sticks flush to the top, and
  nothing can paint above it. The resting state is unchanged: the gap above the card is still 12px,
  it just scrolls away with the card now.
- **The engine stopped inventing the name `unknown` for a host that never named itself.** That
  literal was the last step of the host-label chain, and it is a claim: it travelled in the ledger's
  `host` column and, through `app_html`/`open_app`, into `oma.state.host`, where the settings app
  printed it in the capsule badge and under the identity line as this machine's client. A host that
  does not name itself is the ordinary case since the `initialize` handshake that label came from
  left the spec, so the honest value is the empty one — which every reader already treats as "say
  nothing" (the ledger column is nullable; settings' own label helper hides an empty string). Fixed
  at the source rather than by teaching each display to special-case the sentinel.
- **A settings row with a long description and a wide control squeezed the copy into a sliver.**
  The stacked form that answers this was hung on `(max-width: 560px)` — a viewport query, when the
  thing that decides is the width the *row* gets: a 736px chat widget puts a 200px rail beside the
  content, so the row is 451px wide, the query never matched, and the *AI proactivity* description
  wrapped into eight two-word lines with the select hanging beside the middle of it. It is a
  `@container` query on the group now, so every preference row — including the ones inside *More
  options* and each per-app section — takes the stacked shape whenever its own box is under 620px:
  tile and bold label on the first line with whatever tail the row carries, the description as its
  own full-width paragraph under them at a size meant to be read, and the control on the last line
  indented to the copy's left edge. Full width, too — the narrow rules never actually reached the
  controls, whose own `select`/`input[type=…]` widths outranked them. In the wide form the
  description gets a measure (64ch) and a looser line-height instead of running the full width of
  a 900px column.
- **An app that grew stopped being re-measured, and could ask to be taller than the screen.** The
  height a sandboxed child broadcasts to its embedder was observed on `document.body` alone — but a
  widget body is routinely pinned, by the frame's own viewport or by an app that writes
  `html,body{overflow:hidden}`, so appending a row changed what was on screen without changing the
  one box being watched. Measured against a fixture with a pinned body: five appended rows produced
  **zero** further reports and the frame stayed at its first height. Both broadcasters now watch the
  body *and each of its direct children*, re-attach when that child list changes (apps rewrite
  `body.innerHTML` wholesale), and coalesce a burst instead of posting per observation — the same
  fixture now reports each step.
- **An app that pinned its own `html`/`body` could never be seen to grow in a chat.** The height a
  chat host acts on is not a number we send: measured on claude.ai, the host injects its **own**
  reporter inside the widget iframe, posting `ui/notifications/size-changed {width, height}` — a
  string that appears nowhere in this engine — reading the document's own `scrollHeight` and
  re-reading on mutation (a captured sequence: 755 → 1004 → 755). So the only lever we hold is **the
  DOM that reporter measures**, and what a pinned app hands it is not a fact about the app:
  `overflow:hidden` on `html` and/or `body` (seven of the 24 shipped apps) or `body{min-height:100vh}`
  (the dashboard) make the measured height equal the frame height the host set from its own last
  reading, so the number freezes and appending a row moves nothing. Every document a host measures
  is now injected with one exported source, byte for byte, as a classic script armed ahead of the
  runtime module — the runner's two sandboxed children *and* the top-level widget documents the
  shell composes (the universal loader for `open_app`, the per-app `ui://` resource under
  `OMA_DYNAMIC_TOOLS`), which broadcast nothing and so had been missed. As soon as a body exists it
  sets `height:auto`, `min-height:0` and `overflow-y:visible` on both boxes, inline and `!important`,
  because what it overrides is the app's own stylesheet. Measured in a 736×500 frame against a
  fixture with the pinned shape: 8 → 14 → 20 rows report **584px → 992px → 1400px** of document,
  while the same app with those three declarations removed reports **500px at 20, 26 and 46 rows** —
  the frame height, forever. It applies only when something is embedding us *and* that embedder is
  not a shell: a top-level page (`/view`) has nobody deriving its size from our document, and a
  shell hands us a viewport-fixed frame and expects the app to lay itself out inside it.
  **The engine sets no ceiling of its own** — a widget is as tall as its content and the host's own
  published limit decides the rest, so an app's internal scrolling stays the app's (a long list at
  430×844 keeps a 5442px document and scrolls in the frame the host gives it). The number a
  sandboxed child *broadcasts* to an embedder inside this engine — `oma.embed`'s frames, the store's
  inert previews, the one path where we are the embedder — is still bounded at the device screen
  height (floored at 320px, and an unreadable `window.screen.height` means no bound at all).
- **The App Store forced a horizontal scrollbar on every widget narrower than ~780px.** Its featured
  card declared `minmax(220px, .82fr) minmax(300px, 1.4fr)`, and a grid track's minimum is a floor
  that does not shrink: it overflows and takes the document's width with it. Once the rail and the
  page padding are removed from a 620px viewport the main column is ~380px, so the card pushed the
  document 126px past its own frame (48px at 700px; the app detail header carried the same 490px
  floor one screen deeper). The proportions were the design, the floors were not — both are
  `minmax(0, …)` now, with the grid items allowed to shrink. Both app roots also carry
  `overflow-x: clip` as a belt (`clip`, not `hidden`, so nothing turns into a scroll container).
  Measured at 430 / 560 / 620 / 700 / 736 / 800 / 860 / 900px before and after: 126px and 48px of
  overflow → 0 everywhere.
- **The App Store put its whole catalogue into a conversation, and two dozen preview windows with
  it.** Discover drew a shelf for each of the nine categories the shipped registry carries, up to
  four cards apiece, every card built around a live preview — so the card in a transcript measured
  **6,065px at 390px and 5,825px at a 736px widget**. Two things changed, and the split is the
  context rather than the width. **A chat host now mounts no speculative iframe at all**: the
  featured hero's preview, the editorial rail's and every list card's are gone there (at 736px it
  was laying out 25 preview windows, six of them mounted and the rest empty grey boxes), and the one
  live preview left is the single frame inside a detail view the user opened — the small ones are
  exactly the ones reported blank on a real desktop host, and static screenshots take their place in
  a later version. The hero keeps its second half as a drawn plate of host tokens instead of an empty
  window. **And Discover became a shop window rather than the inventory**: a shelf shows two entries
  in a conversation and three in the browser viewer's wide form, with the heading's *See all* and the
  category nav — the pill strip, or the rail — carrying the rest; the category view itself is
  uncapped as before. The cap is a ROW, not a number, and only the viewer has one: at 1280px the
  grid is three 440px tracks, while a 736px chat widget spends 202px on its rail and lays out a
  single 330px-minimum track, so three cards there are three rows rather than one glance — 272px of
  card height for a shelf nobody reads across. A card with no picture is
  a row now — mark, title, one truncated line, the action — **56px against the 185px (390) and 206px
  (736) the stacked form measured**, having dropped the category eyebrow (it repeats the shelf
  heading it sits under), the publisher line (the same words on every entry in this store) and the
  state chip (the button beside it already says Open / Update / Unavailable). All of it is one tap
  away in the detail view. Measured after: **2,170px and 1,961px**, and zero preview windows on
  Discover. The browser viewer is unchanged — every preview it drew before, it still draws.
- **Three shipped apps carried defects with no way around them.** `spending-journal` rendered a
  permanently empty list whenever it had data — a local DOM variable named `copy` shadowed the
  module-level i18n lookup of the same name. `client-pipeline` threw `RangeError` out of render and
  went white when a client row's free-text `currency` was not an ISO-4217 code. And `bill-calendar`
  honoured `preview_date` on any row: since the app declares no collections, the store accepts that
  key on a real bill too, and one stray field silently backdated the whole app's idea of today. It
  is now honoured only on the row the fixture file actually ships.
- **A release could land on one remote and not the other.** `publish.mjs` pushed the public tag and
  reported success; the deployment mirror it is also supposed to reach was not part of the run, and
  the build that reads the public repo then clones the private mirror failed to find the commit.
  The publish run now pushes the same tag to the mirror, prints `deploy mirror:` in the summary so
  arrival is visible on screen rather than buried in warnings, never prints the remote URL (it
  carries a token), and a re-run with nothing to publish says so and exits 0 instead of aborting
  with what looked like an error.
- **The lockfile guard checked one value; the same defect happened again with a different key.**
  0.4.1 added an assertion that `package.json` and `package-lock.json` agree on `version`; then
  `bin` was added to one and not the other, and the guard said nothing. It now checks the
  *relationship*: top-level version, every shared key's value, every mirrored key `package.json`
  declares, and the completeness of the mirrored-key list itself — so the day npm starts mirroring a
  key this repository has not heard of, the check says so instead of silently losing coverage.
- `.gitignore` carried a trailing comment on the same line as a pattern, which meant `*.confirm-key`
  matched nothing at all.

### Also

- `SECURITY.md` was rewritten against `src/contracts.mjs` as the source of truth: the
  `library-reviewed` trust tier retired with the dormant surface above, leaving two, and eight
  occurrences of the pre-0.4.0 vocabulary went with it. It ships in the public snapshot, which is
  why it is worth saying it was wrong.
- `RUNTIME.md` and the authoring guide teach the manifest parameter and the slot model instead of
  the block grammar, teach range edits ("if you have read it, do not send anchors back"), and carry
  the functions chapter as real instruction rather than as "not available yet".
- `install-app.mjs` — the path a human uses to install an app they wrote themselves — **extracts** an
  embedded declaration block and moves it to the manifest slot, where the tool surface refuses it
  outright. Re-running a CLI is cheap; hand-editing bytes is not.
- Seven App Store apps shipped with a block of stale build notes in their header telling the reader
  the app declares an embedded `#oma-manifest` block — the grammar this release refuses. These files
  go out in the public snapshot, so the notes were teaching the wrong thing to exactly the audience
  most likely to copy them. They are gone.

## 0.4.2 — 2026-07-31

A patch release about one thing: **a receipt that does not match what happened.** Every fix below
is a case where the engine told you it had done something other than what it did — a dry run that
migrated your store, an abort that let the write land, a "nothing changed" that deleted your
settings. Two of them could leave data unreachable.

**Upgrade if you are on 0.4.0 or 0.4.1**, particularly before running an install or a dry run.

### Data you could have lost

- **A store could be left permanently unopenable, and the obvious recovery made it worse.** If the
  v4 upgrade failed between renaming the tables and recording the new schema version, the store was
  left half-migrated. Going back to 0.3.x — the natural reaction — did not open it either, and
  created an empty old-shaped table on the way out, after which *both* versions refused it: one
  because the columns were gone, the other because it now found two shapes and would not guess
  which was live. The data was intact the whole time and unreachable by any documented path.
  The rename and the version stamp are now a single transaction, so the half state cannot be
  produced; a store already in it **heals on open** when one of the two shapes is empty (an empty
  one is residue, which is a fact rather than a guess), and when both hold rows the refusal now
  carries the recovery steps instead of just a message. `KNOWN-ISSUES.md` has the manual route.
- **The v4 upgrade could merge a deleted app's history into one of yours.** Picking a free name only
  looked at apps that still exist, while `app_history` and the file index keep rows for deleted ones
  — so an app of yours named `app` could be renamed onto a tombstone. Where their version numbers
  collided the upgrade aborted and left the store in the half state above; where they did not, the
  merge was silent and your app's history quietly gained someone else's versions.
- **`install-app --dry-run` migrated your store and reported "nothing written".** It opened the
  store for writing, which upgrades the schema — irreversibly — and on a machine with no store yet
  it created one. `--list` did the same. Both now open read-only: no create, no migrate, and a
  clear message when the schema does not match.
- **Re-running the installer deleted custom `env` entries from a Claude Desktop registration and
  reported `unchanged`.** It now leaves a current entry alone, and when it does write, it merges
  rather than replaces — your keys and any field we do not own survive.
- **`file_write` accepted malformed base64 and destroyed the file it was overwriting.** The guard
  relied on `Buffer.from(value, "base64")` throwing, which Node does not do; it drops invalid
  characters instead. Writing `!!!not-base64!!!` over a file reported success and left seven bytes
  of garbage where the content had been. The chunked path had no check at all.

### Told you it worked when it did not

- **`file_write_abort` always said the upload was discarded.** When a commit already held the lock
  the lower layer refused the abort, and the tool discarded that answer and replied
  `"Upload discarded."` anyway — while the commit went on to write the file.
- **`data_batch` accepted items the single-item tools would have rejected.** It validated only that
  each command was an object, so `fields: "text"` was stored as `{}` — the value silently gone, with
  `ok: true` returned — and `fields: []` was stored as an array, after which reading that collection
  failed outright. Batch commands are now validated against the same shapes as the tools they mirror.
- **A failed host registration still printed `✅` and exited 0.** A host whose config could not be
  parsed was logged to stderr and skipped; the run then reported success. Since `install.md` is
  followed by coding agents — which often capture stdout only — the whole install looked clean.
  Any unregistered host now fails the run: the verdict names it on stdout and the exit code is
  non-zero. `install.md` said this was already the behaviour; now it is.

### Security

- **The browser viewer accepted writes from any other page on your machine.** Its origin check
  allowed every loopback origin on the reasoning that local pages are not the DNS-rebinding threat
  — true, but it left any page served from another local port able to POST to the full tool surface
  with a simple request, no preflight required. A page on `localhost:3000` could add, change, or
  delete your data; it could not read the response, which made it silent. Two independent locks
  now: the allowed origin is the viewer's own, and a header only same-origin script can set is
  required, which forces a preflight. Tunnel deployments that declare `OMA_VIEW_BASE` are unaffected.
  Still no token — the reasoning for that is unchanged and written down; what changed is that a
  browser page is not a local process, and the old check treated it as one.
- **`settings_write: false` stopped enforcing anything if the runner's startup read failed.** The
  check asked whether a target id was in the set of settings ids; that set starts empty, the startup
  read that fills it swallowed its own failure, and the app mounted anyway — so the membership test
  answered "no" for everything and every write went through. Reserved `security:*` / `policy:*` keys
  were never exposed (the server checks those by pattern), so this was not privilege escalation.

### Fixed

- **Settings' "Reset all" asks first.** One click used to delete every stored value in a section
  and flash "Saved" — no confirmation, nothing to undo with — while the delete-app button in the
  same panel asked twice, and the button's own tooltip already said *"Delete every stored value in
  this section"*. It now honours the same **Confirm before delete** preference as everything else:
  click once to arm, again to run, and it disarms itself after four seconds. Turning that
  preference off restores the single click.
- **`hidden` now works on elements carrying kit classes.** The system UI kit sets `display` on ten
  of its classes, and each of them quietly outranked the browser's own `[hidden]` rule — so
  `el.hidden = true` on, say, a `.k-btn` left the element on screen with nothing reported anywhere.
  A shipped library app was hiding a button this way and it was never hidden.

### Added

- **The browser viewer starts on its own, and the AI hands you the link.** Seeing an app outside a
  chat window used to mean knowing to run `npm run serve` and knowing the port. Now every install
  serves <http://127.0.0.1:8787>, and `save_app` / `open_app` come back with a real URL for the app
  in question. The case this is really for is a terminal host: there is no widget channel in a CLI,
  so an app can be built and never drawn, and until now nothing told you where to look.
  **`OMA_VIEWER=0` turns it off** and `PORT=` moves it — documented in the README rather than left
  to be discovered, because a port bound without being asked is a thing people notice.
  There is no token in front of it, deliberately: the listener is hard-wired to `127.0.0.1` so
  there is no configuration in which it answers off-box, and any local process that could reach the
  port can read the SQLite file directly. The one route outward is a tunnel the user starts, which
  is unchanged by this and still carries no authentication of its own.
- **A named command, `open-mcp-apps`.** The package declares a `bin`, so `npm install -g .` from a
  clone (or `npm link`) puts the server on your PATH and a host entry can name a command instead of
  an absolute path into a checkout. It does **not** make `npx open-mcp-apps` work: that name on the
  npm registry belongs to an unrelated package, so the npx form would fetch and run somebody else's
  code. Keep installing from this repository.

### Changed

- **The universal loader's cache scope is now `private` on a default install.** Nothing about the
  rule changed — the scope is read off the answer, and a running viewer puts its own origin into the
  widget security declaration, which is deployment-specific by definition (two machines on different
  ports do not serve the same answer). It was already `private` for any hosted deployment, which set
  a view base anyway; what is new is that a bare local install no longer advertises a shareable
  document. `OMA_VIEWER=0` restores `public` for anyone running behind a shared gateway who wants it.
- **Host identification reads both protocol eras.** MCP 2026-07-28 deletes the `initialize`
  handshake (SEP-2575) and carries `clientInfo` in every request's `_meta` instead, so the HTTP
  entry now accepts either and takes whichever arrives first. This is written ahead of the
  migration, which is separately blocked on the SDK, but it is not only future-proofing: the
  `/mcp` transport is stateless, so a tool call is its own request with no handshake in it, and
  remote calls have therefore been labelled with a User-Agent token rather than the caller. A
  per-request `clientInfo` names the call that made the write, the moment a host sends one.

### Tests that were not testing

- **`UPDATE_GOLDEN=1` made unrelated failures pass.** The manifest grammar suite exited 0 whenever
  blessing was on, regardless of what else had failed — and rewrote the golden file while a real
  failure was outstanding.
- **A missing golden file rebuilt itself and passed.** `tool-surface` treated absent as "create a
  baseline", so a rebase that dropped the file, or a checkout without it, silently re-blessed
  whatever the surface happened to be — the one guard whose entire job is to notice that it changed.
- Both are the same shape, and the sweep that followed found five guards with an escape hatch. The
  survey is in the repo; the two above are the ones that could pass while something was wrong.

### Also

- **Documentation that contradicted the code**, found by having an agent build an app using only
  the public files: `RUNTIME.md` now carries the CSS kit's class and token lists (it said "do not
  ship your own CSS" and never said what was provided), points at the full authoring guide on the
  first screen, and says how to look at what you built. Dead tool names from the 0.4.0 rename are
  gone from the shipped docs — including an issue title in `KNOWN-ISSUES.md` and a tool name in
  `install.md`, which agents execute.
- The installer pins the node binary it ran with, but now writes the most durable path that reaches
  it: a stable launcher like `/opt/homebrew/bin/node` when it resolves to the same binary, instead
  of a versioned cellar path that disappears on the next `brew upgrade node` and takes every host
  registration down with it. The test is binary identity, not a nicer-looking path.

## 0.4.1 — 2026-07-29

### Fixed

- **The lockfile in 0.4.0 still said `0.3.2`.** The version bump reached `package.json` and not
  `package-lock.json`. `npm ci` never noticed — it validates the dependency tree, not this field,
  and installs cleanly — so nothing broke; the release simply shipped a file stating the wrong
  version of itself. A release whose notes ask people to read carefully before upgrading should not
  also carry a stale number, and the first person to look closely found it.
  `test/invariants.mjs` now asserts that both places inside the lockfile agree with `package.json`,
  so the next bump that misses one fails here instead of on the public repo.

## 0.4.0 — 2026-07-29

**Breaking.** The engine calls its unit of work an **app**, everywhere. It was called a
*component* — a word borrowed from front-end frameworks, where it means a piece of a page. What
this engine builds is not a piece of anything: it is a thing a person opens, keeps, and comes back
to. `app` is also the word the MCP specification uses (MCP Apps), so the engine now speaks one
vocabulary with the protocol it implements instead of two.

### Four things you will notice

- **Twelve tool names changed.** `open_component` → `open_app`, `component_html` → `app_html`,
  `get_component_guide` → `get_app_guide`, `list_components` → `list_apps`, `get_component` →
  `get_app`, `save_component` → `save_app`, `edit_component` → `edit_app`, `archive_component` →
  `archive_app`, `component_history` → `app_history`, `restore_component` → `restore_app`,
  `delete_component` → `delete_app`, `component_permissions` → `app_permissions`. No aliases are
  kept: an alias costs bytes in `tools/list`, which every conversation pays for on every turn.
  Tool **count**, order and membership are unchanged — 36 seats, as before.
- **Claude Desktop will ask you to approve the tools again.** Permission grants are keyed by tool
  name, so renamed tools are new tools as far as the host is concerned. Approve once.
- **One prompt-cache miss, once.** The tool surface is part of the cached prefix; changing it
  invalidates that cache a single time, for everyone. It refills on the next turn.
- **The store schema moves to v4 and does not move back.** A store opened once by v0.4 cannot be
  opened by v0.3.x — that build refuses a schema newer than it understands, by design, rather than
  writing old-shaped events into it. Downgrading means restoring a copy taken beforehand.

### Migration

`MIGRATIONS[4]` runs on first open. It renames the `component` / `component_history` tables and the
`file` table's owner column, and it moves any app of yours that is *named* `app`, `component` or
`loader` to the first free name beside it (`app` → `app-1`, and so on). Those became reserved words
only in v0.3.2, and a reserved word is refused when an app is created — it was never enforced
against apps that already existed. Under v0.4 an app called `app` would claim the universal
loader's own resource. **Every such rename is written to the ledger** (`component_renamed`, with
the old and new names and the reason): a name changing under you without a record is
indistinguishable from the app having been deleted.

### Three things that deliberately did NOT change

Recorded here because an undocumented deliberate choice gets "fixed" by whoever finds it next.

- **On-disk file storage keeps its `files/<app-name>/` layout.** Renaming it would turn one SQL
  transaction into a two-phase migration across the filesystem, where a partial failure leaves
  orphaned blobs — and nothing outside the engine ever sees that path.
- **The `components/` directory keeps its name.** It is the boundary named verbatim by
  `components/LICENSE` and `LICENSING.md`: the engine is AGPL-3.0-only and the apps shipped in that
  directory are MIT. Moving the directory would leave the licence pointing at a path that no longer
  exists, which is the one file where a stale path is not a cosmetic problem.
- **The ledger's event vocabulary stays `component_saved` / `component_deleted` /
  `component_archived`** — for new events too, not only historical ones. The ledger is an
  append-only record, and a record with two vocabularies makes every reader carry both forever;
  worse, someone who later filters on `app_saved` by intuition would get rows on their own machine
  and silently miss all pre-v0.4 history on a user's. One word makes that mistake fail immediately
  instead of quietly. The settings UI renders these as plain English, so the retired word is not
  shown to anyone.

### Also changed

- **Undocumented change, listed for anyone who relied on it:** the snapshot object handed to a
  widget renamed its `component` key to `app`. It was never part of the published `oma.state`
  contract in `RUNTIME.md`, so no alias is kept. The injected globals `__OMA_COMPONENT__` /
  `__OMA_COMPONENT_VERSION__` became `__OMA_APP__` / `__OMA_APP_VERSION__` for the same reason.
- npm consumers: `wrapComponent` → `wrapApp`, `seedSystemComponents` → `seedSystemApps`,
  `COMPONENT_NAME_RE` → `APP_NAME_RE`, and `MAX_COMPONENT_HTML` → `MAX_APP_HTML`.
  `composePreviewDoc` and `stubOmaScript` take `apps` where they took `components`.
- The tool surface shrank from 48,589 B to 47,890 B, and the budget cap came **down** with it
  (48,600 → 47,935) rather than being left as unaudited headroom.

### ⚠️ Not verifiable from this repository

The hosted control plane calls the engine over HTTP with **literal** tool names and has no
compile-time dependency on it. Renaming the tools cannot break its build: a hosted deployment that
has not been updated in step will show **zero apps**, with typechecks and this repository's test
suite entirely green. That surface must be exercised by hand — open the app shell and one app-store
page and see a non-zero list — before a release is considered done. No test here can stand in for it.

## 0.3.2 — 2026-07-29

### Added

- **A preview document now tells its embedder how tall it is.** `composePreviewDoc` broadcasts the
  same `omaRunHeight` message the sandboxed runner has always sent. Preview iframes are
  `sandbox="allow-scripts"` with no `allow-same-origin` — deliberately, so an embedder cannot read
  the document's height and has to be told. It never was, so every embedder had to guess a fixed
  window, and an app taller than the guess was cut off with nothing to distinguish "short app" from
  "truncated". Embedders that already handle `omaRunHeight` from the runner need no new code.

- **Deleting an app can now take its data with it.** `delete_component` gained
  `data: "keep" | "cascade"`. Cascade is two steps on purpose: the first call returns a PLAN —
  which collections would go, which would be kept, and the evidence for each — and only a second
  call carrying that plan's token performs it. A collection another app also uses is never
  deleted, and neither is one whose ownership cannot be established. Cascade is permanent and says
  so; `archive_component` remains the keep-everything half of the pair.

### Changed

- **Version numbers a person reads are now checkpoints.** A component's `version` is its position
  on the store's single ordinal axis, which advances for every write — so an app edited twice could
  show "v5" then "v43" and invite the obvious question. History, the settings UI and
  `restore_component` now speak per-app checkpoints (1 = the oldest); the axis itself is unchanged
  and still drives concurrency control. `restore_component` takes `checkpoint` instead of `version`.
- **Caching hints on every cacheable result.** `resources/list`, `resources/read` and
  `resources/templates/list` now carry `ttlMs`/`cacheScope` alongside `tools/list`, per SEP-2549.
  Anything derived from the store is `private`; the engine-constant loader document is `public`.
- **Widget resources declare their security posture.** `ui://` resources now carry
  `_meta.ui.csp` with empty `connectDomains`/`resourceDomains` — the honest declaration for a
  self-contained document, and the strictest one available. ChatGPT's `openai/widgetCSP`
  compatibility key is sent alongside and agrees. `frameDomains` is deliberately not declared.
  A deployment that needs a dedicated widget origin can set `createEngine(store, { widgetDomain })`;
  the engine never invents one, because that value must be unique per submission.
- The sandboxed preview policy adds `form-action 'none'` — the one outbound shape that does not
  inherit `default-src`, previously closed only by the iframe's missing `allow-forms`.
- `@modelcontextprotocol/sdk` 1.29 → 1.30.
- **A widget no longer announces a capability it does not implement.** Every `ui/initialize`
  declared a `tools` capability. Nothing in the runtime serves a tool call or lists tools, and a
  declared capability is meant to be backed by one — so the declaration was a claim made to every
  host on every mount. It is now empty.

### Fixed

- 🔴 **A refreshed widget that used to spin forever now says something.** Everything the loader
  could say — its retry ladder, its error messages — lived inside `oma.ready(...)`, so if the host
  never delivered initial state (or the runtime failed to load at all) nothing spoke and no request
  was ever made. Two additions, because the two causes look identical from outside: `oma.ready` now
  releases its callbacks on a deadline instead of waiting forever, and the loader document carries a
  plain-script watchdog that is armed before the runtime and says something human if the loader
  never starts.
  **This is a failure surface, not the fix.** A released callback paints an *empty* app rather than
  a spinning one. What a refresh actually comes back with was measured afterwards rather than
  inferred, and it turned out to be three different things — two of them ours, both now fixed (see
  the two entries below), and a third that is the host handing this render an envelope addressed to
  a **different call in the same turn**. That last one is not ours, but 0.3.2 survives it by writing
  the app's identity somewhere the host carries across re-renders; KNOWN-ISSUES has the readings and
  the limits of that workaround.
- 🔴 **A widget could not learn which app it was, once that app had data.** `open_component`'s
  result carries the app's name and the host's, but the runtime recorded them only inside the step
  that adopts new rows — and that step refuses an opening result on purpose, because it carries
  zero rows and the collection's *real* total. The refusal is right for rows and wrong for labels:
  an app's identity does not go stale. So for any app with at least one row, a perfectly delivered
  result was discarded along with its own name (measured: `host: null` on ChatGPT web, first open).
  Identity is now read before that check, first-writer-wins. The freshness check itself is
  unchanged — no rows were ever adopted that should not have been, and none are now.
- 🔴 **Reusing an app's name no longer lets it inherit the previous app's data or history.** A
  delete is a tombstone, so everything the previous holder of a name left behind stays in the store
  — and two destructive decisions were reading those leftovers as if they described the app that
  bears the name *now*. Deleting an app, writing rows into a same-named collection while nothing
  owned it, then creating a new app under that name made those rows look "created for this app",
  and `data: "cascade"` would have taken them. Separately, `component_history` listed every
  checkpoint ever saved under the name, so restoring "checkpoint 1" of a budget tracker could hand
  back a deleted recipe app's source, with nothing on screen marking the boundary. Both now scope
  to the app's current life. Nothing was deleted from the store to achieve it: the earlier rows are
  still there, still a tombstone, simply not this app's to roll back to — and an app that was
  deleted and *not* recreated still lists its own checkpoints exactly as before.
- **A pruned history no longer makes a cascade delete confident about data it cannot account for.**
  Deciding whether a collection belongs to an app rests on which came first, read off the ledger.
  A retention policy deletes a collection's *oldest* events — exactly the ones showing that data
  the user built up over months predates an app that later took the same name — and from the
  inside a truncated history is indistinguishable from a short one. The judge would have read
  "created for this app" and `data: "cascade"` would have taken it. Pruning now records where a
  collection's history stops being complete, and an unaccounted-for gap makes ownership
  *unknowable* rather than certain — which means kept, and said so in the plan. Nothing prunes by
  default, so no existing deployment was exposed.
- **Confirming a cascade now means the rows are still the ones you were shown.** The plan's token
  hashed each collection's verdict and *row count*, so replacing every row while keeping the count
  left a stale token valid — and the rows then destroyed had never appeared in any plan a person
  read. Between being shown a plan and confirming it there is a whole conversational turn, and a
  widget can write during it. The token now covers each collection's position in the ledger, which
  any write moves.
- **A cascading delete can be retried.** If the response was lost, repeating the confirmed request
  with the same `command_id` now reports that it already happened, instead of "no such app" — a
  caller could not tell a completed irreversible delete from a failed one. That report now also
  checks *which* delete it is confirming: an id first used for a keep-delete no longer answers
  "already applied" to a cascade retry while every row is still on disk.
- **A cascade cannot be killed by an earlier caller's choice of id.** Each cleared collection leaves
  a receipt, and those receipts took ids derived from the caller's own `command_id`; a prior write
  that happened to use that shape made the whole delete fail on a uniqueness violation. The receipts
  now carry opaque ids — idempotence was never theirs to provide, since a replay stops at the
  command.
- **A collection may be called `__proto__`.** The standalone preview document tallied collections in
  a plain object, so a collection with that name disappeared from its own answer and one called
  `constructor` reported a function where a count belonged.
- `oma.ready` now re-arms its deadline. It released the callbacks waiting at the time and then kept
  a spent timer, so anything registering later — a lazy pane, a click handler — waited forever,
  which is the failure the deadline exists to prevent.
- `oma.openLink` reports `{ok: false}` when a popup blocker stops the tab from opening. A blocked
  `window.open` returns null rather than throwing, so callers were told a link had opened and
  suppressed their own fallback.

- 🔴 **An app named `app`, `component` or `loader` could stop the server from starting.** With
  per-app tools enabled, every installed app registers one, and those three names collide with tools
  the engine registers itself. The collision threw during startup — so the server never came up, and
  `delete_component` was unreachable precisely when it was needed; the only way out was editing the
  database by hand. Those names are reserved as of this release, but reserving them only stops new
  ones: an app named that way before today was always legal. Startup now skips the per-app tool for a
  colliding name and says so, instead of refusing to start.
- **The refusal for a reserved name explained the wrong thing.** Naming an app `app` produced a
  message about settings groups, because the refusal text carried its own hard-coded list instead of
  reading the one that does the rejecting.
- `index.d.ts`: `stubOmaScript` takes a third argument (`components`); the declaration listed two.

### Added (continued)

- `oma.bind(collection)` — direct mode only, first call wins. It exists for the universal loader,
  which is one document serving every app and so cannot carry a binding of its own. Sandboxed
  components do not get it: a child that could rebind itself could read another app's rows.

### Removed

- **The notice `sendMessage` showed after a host accepted a message.** It read "Check the chat — you
  may need to confirm or send it", and was defended on the grounds that it would still read
  correctly on a host that delivers immediately. Live testing showed otherwise in both directions:
  on desktop the message had already been delivered and the notice fired anyway, and on mobile the
  notice fired while an empty message arrived in the chat. The protocol reports nothing about what
  happens after the host accepts, so the runtime cannot be right on every host and no longer
  guesses; apps that want to say something still can. This restores the earlier behaviour where a
  chat button gives no feedback of its own — a known limitation, written up in KNOWN-ISSUES rather
  than papered over.
- **Previews answer the two questions a meta app asks first.** Both preview machines — the embedded
  one and the one that composes standalone pages — now derive `data_collections` from their snapshot
  and hand back the app roster when the composer supplies it. A dashboard-style app previewed as
  though the user owned nothing.
- **Data that outlived its app is labelled, not faked.** Deleting an app has always kept its
  collection — the data is yours and the app is one view of it — so a collection can still be there
  when its component is not. The dashboard drew those as ordinary app cards that offered to open an
  app that no longer exists. They now say so, and offer to have a new app built for the data
  instead. (Two real tenants had one each.)
- **Every library entry previews.** `library_preview` declared full store-item shape for its
  fixture rows, while the documented fixture convention is `{collection, group, fields}` — so an
  entry that followed the convention exactly failed output validation and its card read "preview
  unavailable" on every host. The library component also now logs why a preview failed instead of
  swallowing it.
- **Development note (never shipped):** while building the thumbnail change below, one snapshot was
  briefly shared with every preview at once rather than sliced per app. It was found and fixed
  inside this same release and no published build ever contained it.
- **App thumbnails no longer starve themselves.** The Installed grid mounted each thumbnail as a
  live sandboxed child that fetched its own data, so a component rendering a card per collection
  exhausted its own refresh budget on mount — and the resulting notice named the app rather than
  the preview. Thumbnails now render from one snapshot the pane fetches once.
- Rate-limit notices say whose budget ran out, and say it once per episode rather than once per
  refused call.
- Previews composed for standalone pages (`composePreviewDoc`) answer reads from their fixture
  snapshot instead of an empty envelope — a component that fetches its own collections rendered as
  broken rather than as empty.

## 0.3.1 — 2026-07-28

### Fixed

- Public CI: the migration drill's real-database section now skips loudly when its
  internal-only fixture is absent — real databases never ship (the publish snapshot bans
  `*.db` wholesale), and the public tree crashed on the missing file. The full drill still
  runs on every internal checkout.

## 0.3.0 — 2026-07-28

The read/write surface was rebuilt around one self-evident envelope, the authoring
contract moved into the component document, and the library got its real name.
Stores upgrade themselves on first open (schema v3) — see the upgrade notes.

### Breaking

- **`gallery` is now `library`** everywhere: `gallery_list` → `library_list`,
  `gallery_preview` → `library_preview`, `install_from_gallery` → `install_from_library`;
  the system component `gallery` → `library`; the provenance stamp `author: "gallery"` →
  `"library"` (both migrated automatically).
- **`save_component` shrank**: inputs are `name`, `html`, `description?`, `expected_version` —
  and `expected_version` is **required when overwriting** (a save that never read the current
  source is exactly how a stub eats a live component). The nested `manifest`/`scene` inputs are
  gone from the schema: a component's declaration now lives **in its own document**, in the
  `#oma-manifest` block. Strict SDK clients reject the old call shape client-side; the server
  schema simply no longer carries those keys.
- **`get_component_version` removed** — `component_html` / `get_component` serve **windowed
  reads** (`offset`/`length`/`next_offset`), and `restore_component` rolls a historical version
  forward as a new copy.
- **`file_usage` removed; `file_read` is windowed; `file_list` is paged.** Nothing is "too
  large to inline" any more — you read it in windows, and the whole-file `sha256` makes
  reassembly checkable. `file_write` over the single-call cap now points at the chunked path
  (`file_write_begin` → `chunk` → `commit`), which has existed since 0.2.0.
- **One result envelope**: every tool result rides a single envelope with one `RESULT_BUDGET`;
  the per-tool ceilings and their silent-truncation modes are gone. Short deliveries are
  self-evident (`returned`/`total`); cut deliveries say so.
- **`call_function` has no seat** until the function pillar ships (`OMA_FUNCTIONS`, a later
  release). It briefly existed as an always-refusing placeholder; it returns with its executor.
- **Origin is validated** on `/mcp` and `/rpc` (spec MUST): no-Origin, loopback on any port,
  and the configured `OMA_VIEW_BASE` origin pass; everything else is 403.
- **Schema v3**: opening a 0.2.0 store migrates it forward automatically (row versions become
  ledger positions; the library rename lands in the data). One-way — an upgraded store refuses
  to open under an older build.

### Added

- **Eight new library apps** — companion (an AI character with shared memory and real
  generated portrait art), family-week, study-cards, knowledge-cards (photo-seeded),
  elder-days, project-pulse, training-log, builder-progress — the built-in library now
  ships 16 ready-made apps, with screenshots in the README.
- **Bridge resilience** — every widget→host call now carries a 10s deadline (a silently
  dropped request rejects instead of wedging the poll/prefs/walk machinery forever), and the
  loader's first paint retries on growing windows with visible progress instead of hanging on
  a single send. Defends against a Claude Desktop 1.24012.9 / Claude Code early-mount window
  that drops bridge calls (being reported upstream).
- **Multi-collection previews** — the library's inert preview sandbox now answers
  `data_list`/`readCollection` per collection from the fixture snapshot, so apps that fetch
  what they render preview live instead of erroring.
- **GUIDE: multi-collection chapter** — binding is singular; fetch what you render
  (`oma.readCollection` + pull on ready/onChange + a modest interval), plus the
  unknown-`group` fallback-section rule.
- **`data_changes`** — what happened in a collection after a mark YOU hold, including the
  user's own widget edits, attributed (`human` vs `agent`), with `next_since` to continue.
- **`data_batch`** — up to 200 typed writes in one transaction (seed an app in one call);
  all-or-nothing.
- **`data_query`** — server-side count/sum/min/max/avg + group-by, behind `OMA_QUERY=1`.
- **`edit_component`** — exact-string replacements landing through the same save path; grow an
  app one feature per call instead of re-emitting the document.
- **`archive_component`** — retire an app from the shelf without touching its data, files,
  history, or openability.
- **Off-platform authoring**: `install-app.mjs` installs an app you wrote yourself
  (`--sandboxed` for untrusted code), and **`RUNTIME.md`** is the versioned runtime contract,
  pinned two-way by tests. `oma.contract` reports the runtime contract version.
- **Provenance wall**: a save can never change a component's trust tier — an app installed
  sandboxed stays sandboxed until deleted.
- Widget runtime: **self-pagination** for large collections, 0-RTT write continuity, `via`
  provenance on widget writes, a per-app **files read side** (`oma.files.list/read/url` —
  object URLs straight into `<img src>`), and a **Data pane** in settings (collections,
  ownership, ledger + undo in the browser view).
- **GUIDE: time-derived rendering** — the largest measured defect class (apps lying about
  time weeks after they were built) gets rules, a correct snippet (UTC parse, DST, off-by-one
  all handled), and a 45-day self-check.
- **CLA in effect** for engine contributions — individual grantee, signed once on your first
  PR, in the PR ([`CLA.md`](https://github.com/2nd1st/open-mcp-apps/blob/v0.5.2/CLA.md) — the
  file was deleted in v0.5.4 with the MIT relicense, so this points at the last release that
  carried it; a relative link here 404s for every reader).
- The seeder **never overwrites a component it didn't write**: a user app that took a system
  name survives upgrades; the system component ships degraded instead.

### Changed

- **INSTRUCTIONS rewritten under an explicit channel policy**: 9.4 KB → 2.4 KB (settled) /
  3.3 KB (first run), with behavior verified unchanged by live-model regression arms.
- Tool face: 33 → 36 seats, net of the removals and renames above.
- `library_*` browse tools are control-plane — unavailable to sandboxed child components.

### Upgrade notes

- The store migrates on first open. **Back up the db file first if it matters to you** — a
  plain file copy while your hosts are fully quit is enough.
- After migration, versions are **ledger positions** (large, non-consecutive numbers). An
  in-flight caller holding a pre-migration number gets one conflict and retries;
  `render_health` auto-revert and `restore_component` operate on the migrated numbering.
- If your store already had an app named `library` (yours, pre-0.3.0), it is kept untouched
  and the system library app is simply not installed — rename yours to free the slot.

## 0.2.0 — 2026-07-25

### Licensing

- The **engine** (everything outside `components/`) is now **AGPL-3.0-only**;
  the official **components** in `components/` are **MIT**. Project names are
  reserved as trademarks. See [`LICENSING.md`](LICENSING.md). Earlier releases
  were MIT throughout, and that grant is irrevocable — anything already
  published under it stays available under it.
- Every source file now carries an `SPDX-License-Identifier`, and `dist/shell.js`
  reproduces the licences of the packages it bundles.
- Contributions to `components/` need nothing signed. A CLA is intended for the
  engine but is still a draft — open an issue first. DCO sign-off
  (`git commit -s`) applies to both.

### Added

- **File storage.** Components can store binary files alongside their items,
  with per-app and per-store quotas, content-addressed dedup, and resumable
  chunked uploads.
- **Realtime.** A change feed pushes updates to every open view of a component
  instead of making them poll.
- **Live gallery previews.** Browse the built-in apps with their demo data
  rendered, rather than picking from a list of names.
- **Package barrel and embed hooks** (`index.mjs`, `index.d.ts`): `createEngine`,
  `openStore`, `wrapComponent`, `seedSystemComponents` and the standalone
  document contract are now a documented surface for embedders, typed for
  TypeScript consumers.
- **Host design tokens.** `wrapComponent` accepts a validated `tokens` map so an
  embedder can render components in its own palette without touching them.

### Changed

- **The component library is new.** Eight apps — bill calendar, event
  countdowns, habit streaks, hydration tally, keep in touch, meal planner,
  savings goals, spending journal — replace the earlier demo set (todo, kanban,
  notes, pomodoro, reading list, expense split). They share one app shell so
  they read as a family, and contain zero literal colours: every colour comes
  from a host design token, so they inherit the theme of whatever renders them.
- **Node 22 or newer is required** (was 18). The SQLite binding the engine
  stores apps in no longer builds on older versions; the installer now says so
  before doing any work.
- The child sandbox's tool policy is a denylist of control-plane tools rather
  than an allowlist of data tools, so a component cannot reach the registry.

### Fixed

- Widget clicks use last-write-wins, so two quick edits no longer raise a
  spurious version conflict.
- The library page no longer brands itself "App Store" (display copy → "Library").
- The installer registers a stable node launcher when it matches the running binary, so
  `brew upgrade node` no longer strands every host on a vanished versioned cellar path
  (existing installs read `stale` on `--check`; re-run to heal).
- Direct-embed mode refuses a write before a collection is bound instead of sending
  `collection: null`; the dashboard tile label fallback prefers a human string over a bare
  ISO date; bill-calendar's streak stat can no longer truncate into nonsense.
- Per-component (direct-embed) documents now carry their collection binding, so widget writes
  work on hosts whose pushes never deliver one; the installer registers Claude Desktop and
  Claude Code with `OMA_DYNAMIC_TOOLS=1` as a shipped workaround for their chat-surface
  loader hang (see KNOWN-ISSUES) — re-run the installer to pick both up.
