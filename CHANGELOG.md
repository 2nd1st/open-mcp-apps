# Changelog

Notable changes to open-mcp-apps. Releases are curated snapshots — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for what that means.

This project follows [semantic versioning](https://semver.org/). While the major
version is `0`, the engine's public API may still change between minor releases;
each such change is called out here.

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
tablet, open it at `/view/live`, and the display is done; the point of making it an app rather than
a route is that the next line you write in it is yours.

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
