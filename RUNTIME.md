# The runtime contract — `window.oma`

**Contract version: 2** (read it at runtime as `oma.contract`; 2 = the 2026-08-04 name
removals below — an app built against 1 that used none of the removed names runs unchanged)

This is the contract for writing an app **outside** this repo — in your own editor, with your own
bundler — and installing it with `install-app.mjs`. If an AI is writing your app it doesn't need
this file: it calls `get_app_guide`, which teaches the same API plus the house style, and it
is writing against the engine it is already running on. You are not. That asymmetry is what this
document is for.

Everything below was measured against a real engine in a real browser, not read off the source.

> ### 🔴 This file is the API surface. It is not the whole contract.
>
> The complete authoring contract — the API **plus** the visual kit, the house style, the app-shell
> bones and the worked examples — is the `GUIDE` the engine hands its AI, **29,022 bytes** of it.
> This file used to be a third of that, and the argument for reading the GUIDE was simply that it
> was the bigger document. It isn't much bigger any more — but the gap closed from **this** side,
> when §8 and §9 were added, and neither of them is the house style or the examples. Size was never
> the reason; scope was. Until this file existed the only human-readable pointer to the GUIDE was a
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
`manifest` — a JSON object declaring what the app is (its collection, fields, settings, kind).
On disk (an App Store entry, or an app you build yourself) that is a directory:
`<name>/ui.html` + `<name>/manifest.json`.

| | |
|---|---|
| Size | ui ≤ 200,000 bytes (`ui_too_large` above it) |
| Network | no requests — the runtime iframe's CSP is `default-src 'none'`, so `fetch`/XHR fail and remote images, fonts and scripts do not load. Inline every asset (`data:` URIs are allowed for images and fonts). **This is not a data-egress guarantee**: CSP does not govern a page navigating itself, so treat anything your app can read as something it could also send somewhere. Don't put secrets in an app you wouldn't publish |
| Provided for you | the kit CSS, the host's design-token layer, and `window.oma` — all injected at serve time, so don't ship your own copy |
| Declaration | the manifest slot, naming your collection and its fields (§5). NOT inside the html — a document carrying a legacy `#oma-manifest` block is refused on save |

Bundle whatever you like into those bytes. 200 KB is a real constraint but not a small one — it
holds a compiled framework and a substantial app, as long as you are not shipping a design system
the engine already gave you.

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
collection (the typed verbs go through the bridge and are always available), read and write its own
files, read preferences. What it cannot: `callTool` (rejects with `tool "…" not allowed`), reads or
writes to any other collection, `sendMessage`, `setPref`, deleting items.

## 4. The API

### Available in BOTH modes — the portable surface (19)

```js
oma.contract                        // number — this contract's version (1)
oma.state                           // {collection, items:[{id, group, position, fields, version}], version, total, truncated}
oma.ready(cb)                       // cb(state) once connected AND the first data has arrived — START HERE
oma.onChange(cb)                    // cb(state) after every change, including your own writes
oma.refresh()                       // re-read the bound collection

oma.addItem({group, fields, position})   // → Promise
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
oma.setPref(key, value)             // your own settings only; scalars only

oma.files.list()                    // → [{path, size, mime, …}]
oma.files.read(path)                // → Uint8Array
oma.files.url(path)                 // → object URL (cached), for <img src>

oma.sendMessage(text)               // PROPOSES text into the chat — only on an explicit click.
                                    // The host may run it, ask the user to confirm it, or refuse
                                    // it (ChatGPT declines app-authored text as untrusted tool
                                    // content). It does NOT carry the user's authority.
oma.openLink(url) -> {ok}           // DIRECT MODE ONLY. Ask the host to open a URL
                                    // (ui/open-link) — the direct counterpart to sendMessage:
                                    // no model, no trust decision. Standalone opens a tab; a
                                    // host that will not open links resolves {ok:false} rather
                                    // than throwing. Sandboxed (embedded/previewed) apps
                                    // do NOT get this: a URL carries data, so a link opener is
                                    // an outbound channel, and the sandbox closes those.

oma.standalone                      // true in a plain browser page (no chat attached)
oma.toolInput                       // arguments of the call that mounted this widget
```

Retired from this surface 2026-08-04 (each returns WITH its real consumer, never ahead of it):
`updateContext` (ships with the view-context bridge), `host` and `isControlPlaneTool` (zero
consumers), `bind` (was loader-only — now the internal `__OMA_BIND__` hook, not author API).
`callFunction` returned 2026-08-05 exactly on that condition — W3 shipped the server seat.

### Direct mode only (2)

```js
oma.embed(name, opts)               // mount another app inside this one (depth 1 — a child cannot embed)
oma.embed("@live", opts)            // ONE reserved name: a region showing the app the AI opened
                                    // LAST, swapping itself as it opens others. Extra opt:
                                    // onApp(name|null), fired on every switch. Standalone follows;
                                    // in a chat it is a static tile that reads nothing. An app
                                    // carrying one declares "stage": {"display": true} (§8.1.1).
                                    // The switch rides /events (SSE) and nothing else — no poll
                                    // behind it. A dropped feed leaves the last app on screen;
                                    // EventSource reconnects and the connect frame carries the
                                    // current pointer, so the display catches up by itself.
oma.viewBase                        // base path for app→app links, default "/view/"
```

Reading one of these in a sandboxed app gives `undefined`. If your app needs them, it needs to be
installed as local — which means the person installing it has decided to trust it.

### The pattern

Render everything from `state` inside one `render(state)` function; register it with **both**
`ready()` and `onChange()`. Mutations just call `oma.*` and do not touch local state — the engine
echoes the new snapshot back, which re-renders. The shell polls while visible and fires `onChange`
only on real changes, so edits from the AI or another tab appear on their own; never poll yourself.

Because a re-render can arrive at any moment, keep transient UI state (an open input, a drag in
flight) in variables *outside* `render()`.

## 5. Declaring yourself

The manifest is its own file (`manifest.json` beside `ui.html`), stored as its own slot:

```json
{ "manifest_version": 2,
  "collections": { "trips": { "fields": { "place": {"type":"string","required":true},
                                          "days":  {"type":"number"} },
                              "label_field": "place", "strict": true } },
  "settings": [ {"key":"compact","type":"boolean","label":"Compact rows","default":false} ],
  "kind": "app" }
```

Slot semantics on save: an omitted manifest keeps the stored one; an object replaces it whole;
`null` clears it. Every save snapshots both slots as one version, so restore/undo bring back the
pair — a document is never paired with a declaration from a different save.

`fields` values are objects (`{"type":"string"}`), not type names — `{"place":"string"}` is rejected
with `field trips.place must be an object`. Declaring `fields` makes the engine validate **every**
write to that collection, from your app, from the AI, from anywhere.

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

## 7. Versioning

`oma.contract` is `1`. It bumps only on a change an existing app could notice — a name removed, a
signature or return shape changed, a documented behaviour altered. **Adding a name does not bump**,
so an app built against 1 keeps running on an engine that has grown since, and feature-detects
anything new:

```js
if (typeof oma.somethingNew === "function") { … }
```


`test/runtime-contract.mjs` pins every **API name** listed here against the two runtimes' actual
sources, so the API surface cannot drift from them silently — a name that disappears, or one that
appears without being documented, fails the suite. `test/doc-facts.mjs` pins §8's kit inventory the
same way. Neither pins the prose.

## 8. The visual layer — the part with no error message

§1 says the kit CSS is injected and tells you not to ship your own. That sentence is where authors
who are not the AI get lost, and the way they find out is **that they don't**: an app that ignores
all of this installs, runs, writes data, and simply looks wrong. There is no warning, because
nothing is broken.

### 8.1 The kit selects nothing on its own

The kit is **30 classes**, and it styles **only** those classes. It does not touch `button`,
`input`, `h1`, `table` or any other bare element — a hand-written `<button>` gets the browser's
1996 default, next to a `.k-btn` that looks native to the host. That contrast **is** the bug
report; there will not be another one.

```
layout    .k-row (flex row + gap)   .k-grow (fill)   .k-grid (auto card grid)   .k-li (list line)
text      .k-h1  .k-sub  .k-mut  .k-num (tabular)  .k-code  .k-ellip / .k-ellip2 (clamp)
surfaces  .k-card (+ .is-click for the hover lift)     .k-empty (empty state)
controls  .k-btn (+ .sec .ghost .danger)   .k-chip (+ .on .static)   .k-field (input/select)
          .k-switch (styled checkbox)      .k-tabs > .k-tab (+ .on)
status    .k-badge (+ .info .ok .warn .bad)   .k-dot (group colour)   .k-icon (16px inline SVG)
motion    .k-stagger (list entrance; set style="--i:N")   .k-pop   .k-skel (loading shimmer)
page      .k-stage (your root container)   .k-appbar (+ .k-appmark .k-appcopy .k-eyebrow)
```

The kit already sets `*{box-sizing:border-box}`, a sensible `body`, and reduced-motion handling —
don't re-declare those. Write your own CSS for what makes **this** app different from every other
one. If you catch yourself styling a button, chip, card, input or empty state from scratch, use the
class; if you need a variant, override the kit class rather than inventing a parallel one.

### 8.1.1 `.k-stage` — do not draw your own card

Your app is shown in two places and they want opposite chrome. **In a chat** it is a card floating
in someone's conversation, and something has to draw that card. **On a screen it owns** — the
browser viewer, a panel host — the page is framed already, and a second frame inside the first is a
double bezel your users will see as sloppiness.

You do not decide which one you are in. Put your root container inside `<body>`, give it
`k-stage`, and add one line at mount:

```html
<body>
  <main class="k-stage">…your whole page…</main>   <!-- a fixed-position modal stays OUTSIDE -->
</body>
```
```js
if (oma.standalone) document.body.classList.add("standalone");
```

That is the whole contract. The kit draws the border, radius, surface and shadow in a chat, drops
them entirely on a phone-width frame (where the host's own frame is the card), and draws nothing at
all when `standalone`. **Do not** put a border, border-radius, box-shadow or `max-width` on that
element yourself, and do not set `padding` or `background` on `body` — those are exactly the
declarations this contract exists to own.

How wide the page may get is a **declaration**, not a number in your CSS. In `manifest.json`:

```json
"stage": { "width": "column" }
```

`column` (the default; omit the key and you get it) is a 760px reading column — lists, counters,
forms. `wide` is 1120px — calendars, boards, anything with lanes or many columns. `fluid` has no
limit, for a layout with its own sidebar. The engine writes the answer onto `<body>` as
`stage-column|wide|fluid`; you never read it.

The same object takes `"display": true` — "this app is a frame for OTHER apps", which is what an
always-on screen built on `oma.embed("@live")` is (§4, direct mode). Declaring it exempts your app
from the last-opened pointer, so opening the frame never aims the frame at itself.

Your header goes in `.k-appbar` — a content header, so no rule and no fill of its own; the kit adds
the rule under it in a chat, where the bar is the card's title bar:

```html
<header class="k-appbar">
  <span class="k-appmark">…your icon…</span>       <!-- the kit sizes it, YOU paint it -->
  <div class="k-appcopy"><p class="k-eyebrow">SECTION</p><h1>App name</h1></div>
  <div class="tail">…buttons…</div>
</header>
```

Finally: **never write `overflow: hidden` on `html` or `body`.** In a fixed-height frame that is the
scrollport's own overflow — the wheel stops working and everything below the fold becomes
unreachable. `overflow-x: clip` on your `.k-stage` is the belt you actually wanted.

### 8.2 Colour comes from the host, never from you

Hardcode a colour and your app is the one thing on screen that ignores the user's theme.

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
--k-s1 --k-s2 --k-s3 --k-s4  = 4/8/12/16px      --k-t-fast  --k-t  --k-t-slow
--k-ease  standard                              --k-spring  for the one confirming action
```

- **Accent**: `var(--color-text-info, var(--color-ring-primary, #3b6cf6))` — never a brand colour.
  The chain ends in a guaranteed shell fallback; the first token is used only if the host offers it.
- **Tints**: `color-mix(in oklab, <token> 10-12%, transparent)`. Hover wash:
  `color-mix(in oklab, var(--color-text-primary) 4%, transparent)`. These flip with the theme.
- **Motion**: 120–260ms `cubic-bezier(.2,.8,.3,1)`; one springy `cubic-bezier(.34,1.56,.64,1)` on
  the action that saves. Wrap **all** of it in `@media (prefers-reduced-motion: no-preference)`.
- Hover `translateY(-1px)`, press `scale(.96–.985)`. Amounts get `font-variant-numeric: tabular-nums`.
- Empty state: a friendly line **plus what to say to the AI to fill it** — never a bare "no data".
- Don't root on white or black. Root on transparent or `var(--color-background-primary)`.

### 8.3 The shell every app shares

Apps read as a family because they share bones. Build them out of the kit classes:

- **App bar** — a ~42px square mark holding one inline SVG glyph (1px token border, radius-lg,
  `aria-hidden`), then the identity block, then any action pushed right with `margin-left:auto`.
- **Identity** — an EYEBROW above the app's name: `var(--font-mono)`, ~10px, weight 700,
  letter-spacing `.11em`, uppercase, `var(--color-text-tertiary)`. It names the beat this app keeps
  — "PERSONAL LEDGER", "DAILY RHYTHM" — not a tagline. The app's name sits under it at heading size.
- **AI hand-off** — where the AI can do something the UI can't, a quiet `.k-btn.sec` in the bar
  calling `oma.sendMessage`. Same weight in every app, so it reads as the same affordance everywhere.

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

There is no network: `fetch`/XHR/WebSocket and external `<script>`/`<img>`/`<link>`/`@import` are
all denied by CSP. Inline everything; all data moves through `window.oma`.

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
