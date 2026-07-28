# Changelog

Notable changes to open-mcp-apps. Releases are curated snapshots — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for what that means.

This project follows [semantic versioning](https://semver.org/). While the major
version is `0`, the engine's public API may still change between minor releases;
each such change is called out here.

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
