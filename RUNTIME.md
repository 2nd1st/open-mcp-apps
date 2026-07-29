# The runtime contract — `window.oma`

**Contract version: 1** (read it at runtime as `oma.contract`)

This is the contract for writing an app **outside** this repo — in your own editor, with your own
bundler — and installing it with `install-app.mjs`. If an AI is writing your app it doesn't need
this file: it calls `get_app_guide`, which teaches the same API plus the house style, and it
is writing against the engine it is already running on. You are not. That asymmetry is what this
document is for.

Everything below was measured against a real engine in a real browser, not read off the source.

---

## 1. What an app is

One self-contained HTML document. That is the whole packaging format.

| | |
|---|---|
| Size | ≤ 200,000 bytes (`html_too_large` above it) |
| Network | none — the runtime iframe's CSP is `default-src 'none'`. Inline every asset (`data:` URIs are allowed for images and fonts) |
| Provided for you | the kit CSS, the host's design-token layer, and `window.oma` — all injected at serve time, so don't ship your own copy |
| Declaration | an `#oma-manifest` block naming your collection and its fields (§5) |

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
| when | author is local (the AI, you via `install-app.mjs`, a seed, the library) | any other author — `install-app.mjs --sandboxed`, and whatever a hosted publishing pipeline installs |
| where it runs | in the widget document itself | in an `about:srcdoc` iframe, `sandbox="allow-scripts"` (opaque origin — the parent cannot read into it, and it cannot read out) |
| `window.oma` | the real object | a message-passing bridge with the same names |
| capability limits | none — co-equal with the AI | enforced per call; a refusal rejects the promise |
| collection binding | what it declared, else its own name | **always its own name**, whatever it declared |

**The shape is the same; the enforcement is not.** That is the design: you write one file, and
where it lands decides what it is allowed to do, not what it is allowed to say.

What a sandboxed app can still do, with *no* capabilities granted: read and write its own bound
collection (the typed verbs go through the bridge and are always available), read and write its own
files, read preferences. What it cannot: `callTool` (rejects with `tool "…" not allowed`), reads or
writes to any other collection, `sendMessage`, `updateContext`, `setPref`, deleting items.

## 4. The API

### Available in BOTH modes — the portable surface (21)

```js
oma.contract                        // number — this contract's version (1)
oma.state                           // {collection, items:[{id, group, position, fields, version}], version, total, truncated}
oma.ready(cb)                       // cb(state) once connected AND the first data has arrived — START HERE
oma.onChange(cb)                    // cb(state) after every change, including your own writes
oma.refresh()                       // re-read the bound collection

oma.addItem({group, fields, position})   // → Promise
oma.updateItem(id, fields)               // shallow merge; null deletes a key
oma.moveItem(id, group, position)
oma.deleteItem(id)
oma.readCollection(name, opts)           // read ANY collection without touching your own state
oma.callTool(name, args)                 // escape hatch to the raw tool surface
oma.callFunction(name, args)             // call a function this app exposes

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
oma.updateContext(text)             // silently updates the AI's context for its next turn

oma.bind(collection)                // DIRECT MODE ONLY. Bind this runtime to a collection, once,
                                    // from a value the SERVER computed. One caller: the universal
                                    // loader, which is a single document serving every app and so
                                    // cannot be baked with a binding the way a per-app document is.
                                    // First call wins; never recompute the binding yourself.

oma.host                            // "claude-ai" | "chatgpt" | "browser-viewer" | …
oma.standalone                      // true in a plain browser page (no chat attached)
oma.toolInput                       // arguments of the call that mounted this widget
```

### Direct mode only (3)

```js
oma.embed(name, opts)               // mount another app inside this one (depth 1 — a child cannot embed)
oma.viewBase                        // base path for app→app links, default "/view/"
oma.isControlPlaneTool(name)        // for EMBEDDERS building their own bridge, not for ordinary apps
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

```html
<script type="application/json" id="oma-manifest">
{ "manifest_version": 2,
  "collections": { "trips": { "fields": { "place": {"type":"string","required":true},
                                          "days":  {"type":"number"} },
                              "label_field": "place", "strict": true } },
  "settings": [ {"key":"compact","type":"boolean","label":"Compact rows","default":false} ],
  "kind": "app" }
</script>
```

Write the opening tag **exactly** as shown — same attributes, same order, double quotes. The engine
finds the block by that literal line, and any other spelling is a rejected save naming the correct
line. Exactly one block per document; two is a rejection, not a tiebreak.

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

`test/runtime-contract.mjs` pins every name listed here against the two runtimes' actual sources, so
this document cannot drift from them silently — a name that disappears, or one that appears without
being documented, fails the suite.
