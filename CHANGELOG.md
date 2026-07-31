# Changelog

Notable changes to open-mcp-apps. Releases are curated snapshots — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for what that means.

This project follows [semantic versioning](https://semver.org/). While the major
version is `0`, the engine's public API may still change between minor releases;
each such change is called out here.

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
