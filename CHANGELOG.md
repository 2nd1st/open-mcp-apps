# Changelog

Notable changes to open-mcp-apps. Releases are curated snapshots — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for what that means.

This project follows [semantic versioning](https://semver.org/). While the major
version is `0`, the engine's public API may still change between minor releases;
each such change is called out here.

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
  PR, in the PR ([`CLA.md`](CLA.md)).
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
