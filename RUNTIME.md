# The runtime contract — `window.oma`

**Contract version: 4** (4 = data is opt-in: the collection is read only once the app subscribes
with `onChange` — an app that read `state.items` in `ready()` without subscribing now sees none —
and `oma.contract` / `oma.toolInput` are gone. 3 made the write verbs resolve to an `OmaAck`;
2 was the 2026-08-04 name removals. An app built against an earlier number that used none of the
changed surfaces runs unchanged.)

This is the contract for writing an app **outside** this repo — in your own editor, with your own
bundler — and installing it with `install-app.mjs`. If an AI is writing your app it doesn't need
this file: it calls `get_app_guide`, which teaches the same API plus the design direction, and it
is writing against the engine it is already running on. You are not. That asymmetry is what this
document is for.

Everything below was measured against a real engine in a real browser, not read off the source.

> ### 🔴 This file is the API surface. It is not the whole contract.
>
> The complete authoring contract — the API **plus** the two ways to write an app, the design
> direction and the worked examples — is the `GUIDE` the engine hands its AI, **24,484 bytes** of it.
> This file used to be a third of that, and the argument for reading the GUIDE was simply that it
> was the bigger document. It isn't much bigger any more — the gap closed from **this** side, when
> §8 and §9 were added — but neither of them is the worked examples. Size was never the reason;
> scope was. Until this file existed the only human-readable pointer to the GUIDE was a
> comment in `install-app.mjs`. Print it:
>
> ```bash
> node -e 'import("./src/guide.mjs").then(m => console.log(m.GUIDE))'
> ```
>
> §8 below inlines the parts you cannot skip. **Read the GUIDE anyway if you are writing more than
> one app** — it has the examples, and it is regenerated from the same source the AI reads, so it
> cannot go stale the way a copy can.

---

## 1. What an app is

Two slots, saved together as one version: `ui` — one self-contained HTML document — and
`manifest` — a JSON object declaring what the app is (its collection, fields, settings).
On disk (an App Store entry, or an app you build yourself) that is a directory:
`<name>/ui.html` + `<name>/manifest.json`. An optional third slot, `skill` (`<name>/skill.md`),
tells an AI how to *use* the app (§5.2).

| | |
|---|---|
| Size | no cap. The engine refuses an empty document (`empty_ui`) and nothing else about size |
| Network | scripts, styles, fonts and images may load from the platform's CDNs — cdnjs, jsdelivr, unpkg, Tailwind's play script, jQuery's CDN, Google Fonts (`store.PLATFORM_CSP`). The iframe's CSP is otherwise `default-src 'none'`: nothing else loads and `fetch`/XHR fail, unless you declare it (§5.1) and the deployment allows it. **This is not a data-egress guarantee**: CSP does not govern a page navigating itself, so treat anything your app can read as something it could also send somewhere. Don't put secrets in an app you wouldn't publish |
| Provided for you | the host's design tokens as CSS variables (with fallbacks), a minimal base (`box-sizing`, `body` margin 0 and the host font, `[hidden]`, safe-area defaults) and `window.oma` — all injected at serve time. No classes: the look is yours (§8) |
| Declaration | the manifest slot, naming your collection and its fields (§5). NOT inside the html — a document carrying a legacy `#oma-manifest` block is refused on save |

Bundle whatever you like into it. The cap that used to live here is gone: the only size that still
costs you anything is on the READ side, where `get_app` returns the source in windows — so a large
app is not refused, it is merely read in more trips. Data still belongs in the collection rather
than in the document, and a library belongs on its CDN rather than inlined, so most documents that
grew large did so for a reason worth fixing anyway.

## 2. Your script must be a module

```html
<script type="module"> … </script>     <!-- correct -->
<script> … </script>                   <!-- window.oma is undefined here, in direct mode -->
```

The runtime is a deferred module, and a classic inline `<script>` runs at parse time — *before* it.
So `const oma = window.oma` at the top of a classic script reads `undefined` and your app dies with
`Cannot convert undefined or null to object`.

The trap is that this is **mode-dependent**: behind the sandboxed runner the bridge is a classic
inline script that runs first, so the exact same file works there and fails in direct mode. Use a
module and the question never arises.

Same rule for a **bundle** you reference with `oma-asset:` (§6.1) — write `type="module"` on the
tag and the engine keeps it when it inlines the bytes. That is what puts your code after the
runtime module and after your mount point, both for free.

## 3. Two runtimes, one vocabulary

An app runs in one of two modes, decided by its **provenance**, not by anything in the file:

| | direct | behind the runner |
|---|---|---|
| when | author is local (the AI, you via `install-app.mjs`, a seed, the App Store) | any other author — `install-app.mjs --sandboxed`, and whatever a hosted publishing pipeline installs |
| where it runs | in the widget document itself | in an `about:srcdoc` iframe, `sandbox="allow-scripts allow-forms"` (opaque origin — the parent cannot read into it, and it cannot read out; `allow-forms` buys the `submit` **event**, which Chrome otherwise never dispatches — the submission itself is cancelled in the bridge and blocked by CSP) |
| `window.oma` | the real object | a message-passing bridge with the same names |
| capability limits | none — co-equal with the AI | enforced per call; a refusal rejects the promise |
| collection binding | what it declared, else its own name | **always its own name**, whatever it declared |

**The shape is the same; the enforcement is not.** That is the design: you write one file, and
where it lands decides what it is allowed to do, not what it is allowed to say.

What a sandboxed app can still do, with *no* capabilities granted: read and write its own bound
collection (the typed verbs go through the bridge and are always available) and read preferences.
What it cannot: `callTool` (rejects with `tool "…" not allowed`), reads or writes to any other
collection, its files (`oma.files` rejects), `sendMessage`, `setPref`, deleting items.

## 4. The API

### Available in BOTH modes — the portable surface (17)

```js
oma.state                           // {collection, items:[{id, group, position, fields, version}], version, total, truncated,
                                    //  app, host} — app is which app this is; host is a LABEL (usually empty), never a branch
                                    // truncated: the read stopped at its page cap — items are the first part
                                    // of `total` rows; say "N of M", never treat them as the whole (same on readCollection)
oma.ready(cb)                       // cb(state) once connected AND the first data has arrived — START HERE
oma.onChange(cb)                    // cb(state) after every change, including your own writes.
                                    // Subscribing is what loads the collection: an app that never
                                    // calls it is a page — no reads, no polling, ready() at once.
oma.refresh()                       // re-read the bound collection

oma.addItem({group, fields, position})   // → Promise<ack>  — see "what a write resolves to" below
oma.updateItem(id, fields)               // shallow merge; null deletes a key
oma.moveItem(id, group, position)
oma.deleteItem(id)                       // confirm_delete is ENFORCED BY THE ENGINE: when on, the shell
                                         // shows its own confirmation and your await resolves after the
                                         // user answers (ok:false if they cancel). Never build your own.
oma.readCollection(name)                 // read ANY collection (full paged walk) without touching your own state
oma.callTool(name, args)                 // escape hatch to the raw tool surface
oma.callFunction(fn, args)               // run a function THIS app declares (manifest.functions) —
                                         // data in, data out, engine-side. Resolves the ack body
                                         // ({ok, result, writes}) or the typed refusal ({ok:false,
                                         // reason, …}); a refusal is an ANSWER, not an exception.
                                         // You can only reach your OWN functions — the callee is
                                         // forced. get_app_guide {topic:"functions"} for authoring.

oma.pref(key, fallback)             // merged: your override ▸ global ▸ fallback. The fallback's TYPE coerces
oma.onPrefChange(cb)                // cb({key, value, oldValue, scope})
oma.setPref(key, value)             // your own settings only; scalars only — resolves the same ack

oma.files.list()                    // → {files:[{path, size, mime, version}], total, next_cursor, …} — the first page
oma.files.read(path)                // → Uint8Array
oma.files.url(path)                 // → object URL (cached), for <img src>

oma.sendMessage(text)               // PROPOSES text into the chat — only on an explicit click.
                                    // The host may run it, ask the user to confirm it, or refuse
                                    // it (ChatGPT declines app-authored text as untrusted tool
                                    // content). It does NOT carry the user's authority.

oma.standalone                      // true in a plain browser page (no chat attached)
```

### What a write resolves to

Every write verb — `addItem`, `updateItem`, `moveItem`, `deleteItem`, `setPref` — resolves the
same **ack**, in both runtimes and in a preview:

```js
{ ok: true, id, collection, seq, prev_collection_seq,
  item: {id, group, position, fields, version} }   // `deleted: true` and no item, on a delete
```

A REFUSAL is an ANSWER, not an exception: `{ok:false, reason, note}` — a version conflict, a
policy denial, or the user answering No to the engine's delete confirmation
(`reason: "confirmation_declined"`). So the one test to write is `if (!ack.ok)`. What still
THROWS is the other two kinds of trouble: an argument the runtime rejects before it sends
anything (`setPref` with a reserved key or a non-scalar value, `addItem` before a collection is
bound), and a transport failure — the host declining the call, the bridge dropping it.

`ack.item.version` is the version the row now has, and it is what lets an app recognise the echo
of its own write: remember it, and skip every change event at or below it. An app with an outside
source of truth (an editor, a two-way bridge) needs exactly that, or it writes the stale copy back
over what the user is typing.

Do NOT expect `{content, structuredContent}` here. That is the raw MCP envelope, and it is what
`oma.callTool` — the escape hatch to the raw tool surface — still resolves, deliberately. The
typed verbs hand you the ack out of it. (Before 2026-08-23 they did not, and every shipped app carried its own adapter for the
difference; most of those adapters were wrong.)

### The two numbers on an item

`position` is scoped to **(collection, group)** — not to the collection. Appending takes that
GROUP's highest position + 1, so every group owns its own `1`, `2`, `3`, and the same number
appears once per group. Sorting a cross-group list by `position` therefore interleaves the groups
while looking like a real order: four rows written `a1, b1, a2, b2` into two groups come back
`b1, a1, b2, a2` by position alone (measured 2026-08-22). Compare positions only WITHIN one group
— which is also why `oma.moveItem(id, group, position)` takes the group and the position together.

`version` is the ledger seq of the write that produced the row, and there is ONE ledger for the
whole store. So it is globally monotonic and comparable across groups and collections — the key to
sort by when you want "which happened first" and the rows do not share a group — and it **jumps**:
consecutive rows of your own collection read `version` 1 and 4 when other writes landed in between
(measured 2026-08-22). Never read it as a per-item revision count, never expect +1, and never
subtract two of them. It is the same number a conditional update compares against; one number, two
uses, not two numbers.

### Direct mode only (8)

```js
oma.openLink(url) -> {ok}           // ask the host to open a URL (ui/open-link) — the direct
                                    // counterpart to sendMessage: no model, no trust decision.
                                    // Standalone opens a tab; a host that will not open links
                                    // resolves {ok:false}. A URL carries data, so a sandboxed
                                    // app does not get a link opener.
oma.embed(name, opts)               // mount another app inside this one (depth 1 — a child cannot embed)
oma.embed("@live", opts)            // ONE reserved name: a region showing the app the AI opened
                                    // LAST, swapping itself as it opens others. Extra opt:
                                    // onApp(name|null), fired on every switch. Standalone follows;
                                    // in a chat it is a static tile that reads nothing. An app
                                    // carrying one declares "live_frame": true (§5).
                                    // The switch rides /events (SSE) and nothing else — no poll
                                    // behind it. A dropped feed leaves the last app on screen;
                                    // EventSource reconnects and the connect frame carries the
                                    // current pointer, so the display catches up by itself.
oma.viewBase                        // base path for app→app links, default "/view/"
oma.display                         // "inline" (a card in the chat) | "fullscreen" (the host gave
                                    // the app the view). Also <html data-oma-display="…"> for CSS.
                                    // Pad what the device/host covers with var(--oma-safe-top)
                                    // (/right/bottom/left) — host-reported or env(), the larger.
                                    // On a card whose host can go fullscreen, the runtime draws a
                                    // 40px bar above the app (the way in; the host's ✕ is the way
                                    // out) and pads <html> for it — nothing to do in the app.
oma.displayModes                    // what this host will switch to, e.g. ["inline","fullscreen"]
oma.requestDisplay(mode)            // ask for "fullscreen" / "inline" from a click → {ok, mode}
oma.onDisplayChange(cb)             // cb(mode) — the host's own expand/close controls fire it too
oma.tools.register({ name, description, inputSchema, annotations, run })
                                    // a tool of the app's own, for the AI to call by name; returns
                                    // the function that removes it. See "The app's own tools".
```

#### The app's own tools

What the app can do, named for the AI — "show day 3", "add a stop" — so the AI calls the app's own
function instead of reading the screen and pressing buttons (ext-apps draft, *App-provided tools*):

```js
oma.tools.register({
  name: "show_day",                                   // letters, digits, _ - . (≤ 128); ≤ 50 per app
  description: "Open one day of the trip and get its stops.",
  inputSchema: { properties: { day: { type: "string" } }, required: ["day"] },   // plain JSON Schema
  annotations: { readOnlyHint: true },                // optional MCP hints
  run({ day }) { go(day); return summaryOf(day); },   // string | JSON value | CallToolResult; may be async
});
```

The input is checked against `required` and each property's `type` / `enum` before `run` sees it;
a mismatch or a throw goes back to the AI as a tool error carrying the message, so it can correct
itself. Registrations belong to the page: never stored, gone on reload, and registering a name again
replaces it. The AI reaches them natively on a host that sends `tools/list` to the app (the runtime
declares the `tools` capability and answers it), and otherwise through the screen relay — listed in
`screen_read`, called with `screen_act {tool, input}`.

The same document is shown on a phone and on a desktop, as a card and (where the host offers it)
fullscreen. **Width decides layout** — `@media` or container queries on width; a phone's fullscreen
is as narrow as its card, a desktop's is several times wider. The mode is yours to use or ignore: a
card can be a glance and fullscreen the whole app, or the page can simply respond to its width. In
a chat the engine draws no frame and fixes no height; the host sizes the card to your content.

The browser viewer is always `"fullscreen"`, and frames the page: a top bar, and `body` on a padded
card. `?chrome=0` — or `"live_frame": true` in the manifest — serves it bare.

Reading one of these in a sandboxed app gives `undefined`. If your app needs them, it needs to be
installed as local — which means the person installing it has decided to trust it.

### The pattern

Render everything from `state` inside one `render(state)` function; register it with **both**
`ready()` and `onChange()`. Mutations just call `oma.*` and do not touch local state — the engine
echoes the new snapshot back, which re-renders. The shell polls while visible and fires `onChange`
only on real changes, so edits from the AI or another tab appear on their own; never poll yourself.

Data is optional. A calculator, a game, a one-off chart needs none of it: leave `onChange` out and
the app is a plain page — `ready()` still fires, `oma.pref` and the theme still apply, and nothing
reads or polls a collection.

Because a re-render can arrive at any moment, keep transient UI state (an open input, a drag in
flight) in variables *outside* `render()`.

## 5. Declaring yourself

The manifest is its own file (`manifest.json` beside `ui.html`), stored as its own slot:

```json
{ "manifest_version": 2,
  "collections": { "trips": { "fields": { "place": {"type":"string","required":true},
                                          "days":  {"type":"number"} },
                              "label_field": "place", "strict": true } },
  "settings": [ {"key":"compact","type":"boolean","label":"Compact rows","default":false} ] }
```

Slot semantics on save: an omitted manifest keeps the stored one; an object replaces it whole;
`null` clears it. Every save snapshots both slots as one version, so restore/undo bring back the
pair — a document is never paired with a declaration from a different save.

`fields` values are objects (`{"type":"string"}`), not type names — `{"place":"string"}` is rejected
with `field trips.place must be an object`. Declaring `fields` makes the engine validate **every**
write to that collection, from your app, from the AI, from anywhere.

### 5.1 Network: declare what you connect to

Every app may already load scripts, styles, fonts and images from the platform's CDNs
(`store.PLATFORM_CSP`: cdnjs, jsdelivr, unpkg, cdn.tailwindcss.com, code.jquery.com, Google Fonts)
and reaches no server. Say where else you need to go, and the engine relays it:

```json
{ "csp": { "connectDomains":  ["https://api.example.com", "wss://live.example.com"],
           "resourceDomains": ["https://cdn.example.com", "https://*.example.com"],
           "frameDomains":    ["https://www.youtube.com"],
           "baseUriDomains":  ["https://cdn.example.com"] } }
```

- **`connectDomains`** — `fetch` / `XHR` / WebSocket targets.
- **`resourceDomains`** — where images, scripts, stylesheets, fonts and media are loaded from.
- **`frameDomains`** — origins you may put in a nested `<iframe>`.
- **`baseUriDomains`** — origins allowed in a `<base>` tag.

Each is an array of origins (`scheme://host[:port]`, or `https://*.example.com` for subdomains) —
no paths, no trailing slash. The user can add origins of their own on top of yours, per app or
globally, through the settings keys `policy:csp:<app>` and `policy:csp:*`.

**Hosts enforce this, per the MCP Apps spec; the engine relays the platform base ∪ your declaration
∪ the user's additions.** A hosted deployment may fix the policy to its own base
(`createEngine({csp: {extensible: false}})`), and then declarations are stored but not relayed —
`save_app` names any origin your document loads from that the policy will not allow. Whether a given
host honours a declaration is that host's business — test where you ship.

### 5.2 Skill: how an AI uses your app

The skill slot is text in the Agent Skills `SKILL.md` format — YAML frontmatter, then Markdown:

```markdown
---
name: trips
description: Plans trips day by day. Use when the user is planning, changing or reviewing a trip.
---
Add one `trips` row per stop: `place` required, `days` as a number. …
```

- `description` is required: one line, at most 1,024 characters, saying what the app does and when
  to use it. `name` is optional. The engine reads only these two keys (single-line `key: value`,
  optionally quoted) and stores everything verbatim. The whole skill is at most 16,384 bytes.
- The description becomes the app's description everywhere it is listed. `open_app` and
  `install_from_app_store` add one line naming it, `data_list` over one of the app's collections
  points at it, and `get_app_skill` returns the whole text — to the AI as reference with the author
  named, never as the user's instruction.
- Same slot rules as the manifest: omitted keeps it, `null` clears it, a string replaces it whole;
  every save snapshots it with the other two, so restore/undo bring it back with them.
- It travels with the app — installed from the App Store, shared, copied. Never put keys or secrets
  in it. A copied app's skill keeps its original author's name (shown wherever the skill is) until
  the skill is rewritten.

## 6. Installing, and what provenance means

```bash
node install-app.mjs ./my-app.html              # local: full trust, direct mode
node install-app.mjs ./my-app.html --sandboxed  # untrusted: behind the runner
node install-app.mjs ./my-app.html --update     # replace an app of the same name
node install-app.mjs --list                     # what's installed, and under whose provenance
```

**Then look at it**: open `http://127.0.0.1:8787/view/<name>`. Every install runs that viewer on
its own — one page per app, the same data the AI reads, and the only way to see an app at all from
a terminal host. `README.md` §"The browser viewer, and the port it binds" covers the two env vars
and why there is no password; this line exists so you don't have to already know it is there.

**Provenance is not overwritable in either direction.** An app installed `--sandboxed` stays
sandboxed until it is deleted: the AI cannot save over it (it would be re-stamping the file as its
own and changing what it may do), and neither can undo, restore, or the render-health auto-revert.
The reverse is refused too. Re-installing over your own app with the same door is normal and keeps
its version history.

The trade you are accepting: **the AI can no longer iterate on this app.** Your file is the source
of truth; you rebuild and re-install. It can still read the source, and the app shares the user's
data like any other.

### 6.1 Building an app outside the chat

A bundler's output is not source, so the registry does not store it as source. Emit a readable
**template** — a mount point plus references to your build output — and push the output as files:

```html
<link rel="stylesheet" href="oma-asset:app.css">
<div id="root"></div>
<script type="module" src="oma-asset:app.js"></script>
```

```bash
node install-app.mjs ./ui.html --name my-app --manifest ./manifest.json --skill ./skill.md \
     --asset ./dist/app.js --asset ./dist/app.css --update
```

The engine replaces each reference with its bytes and **keeps the tag you wrote** — only the fetch
attributes (`src`/`href`/`crossorigin`/`integrity`) go. So `type="module"` is the one attribute that
matters: it makes your bundle deferred, which puts it after the runtime module (`window.oma` is
already there) and after your mount point is parsed. Vite emits exactly this tag; leave it alone. A
whole document and a fragment are both fine — the shell wraps whichever it is handed.

Target notes for whoever writes the build step, each one a constraint the door actually has:

- **One chunk.** Code splitting cannot work here: a dynamic import resolves against the *document*
  URL, which is not the file plane, and the widget CSP blocks the fetch either way (measured —
  `script-src-elem` refusal, blank app). Rollup: `inlineDynamicImports: true`.
- **No external URLs.** The engine inlines at serve time because the CSP forbids a subresource and
  a host iframe could not reach your machine anyway.
- **Stable output names**, or pass `--prune-assets`. The file plane is keyed (app, path), so a
  content-hashed name leaves the previous build stored forever with nothing referencing it. Pin the
  names (`entryFileNames: "app.js"`) or let the flag sweep what this push neither carried nor
  referenced.
- **The manifest is its own JSON file**, never an in-document block. A reference names the file's
  **basename** in this app's file plane.
- **Function bodies must survive the bundler**: `<script type="text/oma-function" data-fn="…">`
  blocks are declarations the engine reads, and a bundler that treats them as code will inline or
  drop them — emit them into the template instead. Inside one, `api.count()` with no collection
  named reads the same collection your widget opens on.

Types for both halves ship with the package: `types/window-oma` for `window.oma`,
`types/oma-function` for the `args`/`api` a function body sees. An app with asset references is
**read-only to the AI**: `get_app` returns the template, `edit_app` and the AI's `save_app` refuse
it, and re-running the command above is the edit.

## 7. Versioning

The contract version is the number at the top of this file. It bumps only on a change an existing
app could notice — a name removed, a signature or return shape changed, a documented behaviour
altered. **Adding a name does not bump**, so an app built against one version keeps running on an
engine that has grown since, and feature-detects anything new:

```js
if (typeof oma.somethingNew === "function") { … }
```


`test/runtime-contract.mjs` pins every **API name** listed here against the two runtimes' actual
sources, so the API surface cannot drift from them silently — a name that disappears, or one that
appears without being documented, fails the suite. It does not pin the prose.

## 8. The visual layer — the part with no error message

An app that ignores all of this installs, runs, writes data, and simply looks wrong. There is no
warning, because nothing is broken.

### 8.1 What the engine gives you, and what it doesn't

The engine injects the host's design tokens (§8.2) and a minimal base: `*{box-sizing:border-box}`,
`body{margin:0}` in the host font and text colour, `[hidden]{display:none!important}`, and
`--oma-safe-*` defaults. That is all — no classes, no fixed heights. A bare
`<button>` gets the browser's default look, so style it: your own CSS, Tailwind's play script
(`<script src="https://cdn.tailwindcss.com"></script>`, tokens as arbitrary values like
`bg-[var(--color-background-secondary)]`), or a component library loaded from the platform CDNs.

Two ways to write an app are supported: plain HTML with vanilla DOM, and React from cdnjs's UMD
builds with htm for markup (there is no JSX compiler — `GUIDE` has both templates). Library
`<script src>` tags go before your module and load in document order. Other frameworks load the same
way and usually work, but are not promised.

**Never write `overflow: hidden` on `html` or `body`.** In a fixed-height frame that is the
scrollport's own overflow — the wheel stops working and everything below the fold is unreachable.

### 8.2 Colour: structure from the host, identity from the app

ChatGPT and Claude publish the same rule for apps shown in their chats, and their directory review
holds apps to it: the **structure** — backgrounds, text, borders, dividers, icons — takes the host's
tokens, so the app follows the user's theme; the **identity** — one accent — is the app's own. For
your own apps this is the recommended default, not a requirement: a person who asks for a look of
their own should get it. Apps in the App Store (`@openmcp-app/oma-store`) follow it strictly.

Written out rather than as `--color-text-primary|secondary|…`, so that searching this file for the
token you are about to type actually finds it:

```
--color-background-primary   --color-background-secondary   --color-background-tertiary
--color-background-inverse   --color-background-danger      --color-background-success
--color-text-primary         --color-text-secondary         --color-text-tertiary
--color-text-inverse         --color-text-danger            --color-text-success
--color-text-warning         --color-text-info
--color-border-primary       --color-border-secondary
--color-ring-primary         --color-ring-info

--font-sans  --font-mono  --font-text-sm-size  --font-text-md-size
--border-radius-sm  --border-radius-md  --border-radius-lg  --border-radius-full
--shadow-xs  --shadow-sm  --shadow-md  --shadow-lg
```

- **Accent**: ONE per app, its own hue with a light and a dark value —
  `--accent: light-dark(#c2381f, #ff8a6e);` — spent where identity lives: the primary action,
  badges, the signature view, a progress mark. (An app with no identity of its own can borrow the
  host's: `var(--color-text-info, var(--color-ring-primary, #3b6cf6))`.)
- **No page backgrounds, gradients or patterns** of your own; root on transparent or
  `var(--color-background-primary)`. **Tints**: `color-mix(in oklab, <token> 10-12%, transparent)`.
- **Type**: `var(--font-sans)`, no other families. Personality comes from scale and weight. Amounts get
  `font-variant-numeric: tabular-nums`.
- **Pictures are content**: inline SVG line art that carries meaning (a route, a place, a state), in
  the accent or text colour — never wallpaper behind text.
- **Motion**: 120–260ms `cubic-bezier(.2,.8,.3,1)`; one springy `cubic-bezier(.34,1.56,.64,1)` on
  the action that matters. Wrap **all** of it in `@media (prefers-reduced-motion: no-preference)`.
- Empty state: a friendly line **plus what to say to the AI to fill it** — never a bare "no data".

### 8.3 Lead with the subject, not a template

There is no shared app shell to copy. Ask what this app IS at a glance — a route, a wall of days, a
jar filling, a desk of cards — and make that the first screen, with the one number that matters at
display size beside it. A generic header + stats band + tabs is what every app looks like when
nobody asked that question (measured: the same model, given the old shell prescription, built an
admin dashboard; without it, it built the subject). Match the occasion — a one-off can be a
keepsake, a daily tool should be quiet and fast.

Two habits keep a live app feeling alive:

- **Update, don't redraw.** On `onChange`, change what changed in place. Rebuilding the whole page
  on every refresh replays entrance animations and cuts your own confirmation animation short.
- **Answer the click at once.** Show the result optimistically; the write's ack, or the next
  `onChange`, confirms or corrects it.

Where the AI can do something the UI can't, a quiet secondary button calling `oma.sendMessage` is
the hand-off — or register the action with `oma.tools.register` and let the AI call it (§4).

## 9. Traps that only bite authors who aren't the AI

The AI gets these from the GUIDE on every run. You get them here, or you get them by debugging.

### 9.1 Three dialogs that fail silently

`confirm()`, `alert()` and `prompt()` are **blocked by the sandbox and return without error** —
`confirm()` yields `false`. **Never gate an action on `confirm()`**: the user clicks Delete, your
code asks for confirmation, gets `false`, and does nothing. Forever. Deletes need no gate of
yours at all — the engine enforces `confirm_delete` and the shell renders the confirmation
(§ oma.deleteItem above); for anything else, act and offer an undo.

`target="_blank"` and `window.open()` are blocked too (no `allow-popups`). An external link may
simply not open. Show the URL as selectable text; an `<a target="_blank" rel="noopener">` is fine
as an addition, never as the only way to reach it.

Any origin that is neither a platform CDN nor in your `csp` declaration (§5.1) is denied by CSP, with
no error you can catch. Your data moves through `window.oma`.

### 9.2 The host sizes you by your content

The host grows the frame to fit what you render — so a list of 500 rows becomes a 500-row-tall
widget, not a scrollbar. **Cap your own long regions** (`max-height` + `overflow:auto`) and page or
virtualise beyond a few hundred rows. Nothing will tell you; it will just get very tall.

### 9.3 Shared preferences

Some prefs belong to the user across every app. Read them with `oma.pref(key, fallback)` and honour
them; declare which ones you honour so the settings app groups them with you:

```
currency ("USD")        density ("comfortable"|"compact")        confirm_delete (true)
```

```json
"uses_shared": ["confirm_delete"]
```

### 9.4 Seeding data without a chat

Writing rows by hand (fixtures, a migration) goes through `POST /rpc` on the viewer's origin, with
a plain `{name, arguments}` body. **`command_id` is required** on every single-write data tool — it
is the idempotency key. Omit it and the call comes back **HTTP 200 with `isError: true`**, which is
easy to read as success if you are only checking the status code. Generate a fresh UUID per action.
