# `host-csp-probe` — what does THIS host do with an app's `csp` declaration?

An app declares where it reaches (`manifest.csp`); the engine merges that with the user's own
additions (`policy:csp:<app>`, `policy:csp:*`) and relays the result in the resource's
`_meta.ui.csp`, per the MCP Apps spec. **Whether a host turns that into a real
Content-Security-Policy is the host's business, and nothing in this repository can find out.**
`test/csp-passthrough.mjs` proves our half — the declaration is validated, merged and put on the
wire byte for byte. This app is the other half: install it, open it once in a host, press **Run
all**, and the host answers nine questions about itself.

Each answer is written as a row in the app's own collection, so the reading outlives the widget,
the conversation and the host. That is the whole point — a widget is gone the moment the chat
scrolls, and a screenshot cannot be diffed.

```
{ probe, ok, detail, at, host, door }
```

`host` is a `platform_keys` spelling from the host matrix (`docs/host-matrix.json`, internal tree
only); `door` is which tool opened the widget. Rows are grouped by `host`, and they are
append-only: a second run in the same host is a second reading, not a correction of the first.

## Install

```bash
node install-app.mjs test/probes/host-csp-probe/ui.html \
  --name host-csp-probe \
  --manifest test/probes/host-csp-probe/manifest.json
```

Add `--update` to re-install over an earlier copy, and `--db <path>` (or `OMA_DB`) to target a
store other than the default one. Installing this way makes it a **local** app: it runs in direct
mode, which is what lets it call `app_html` to show you the merged policy the engine computed.

Then restart the host so it re-reads the server's tools and resources.

## The two doors, and why every host needs both cells

The same probe has to run twice in each host:

| door | how you open it | what rides on it |
|---|---|---|
| `open_app` | the default. Ask the assistant to *open host-csp-probe* | One universal loader resource serves every app, so the `_meta.ui.csp` on it is the **union** of everything declared in the store plus the user's global additions |
| `open_host_csp_probe` | needs `OMA_DYNAMIC_TOOLS=1` in the server's environment; then ask the assistant to use that tool by name | The per-app `ui://` resource, carrying **only this app's** merged declaration |

The app detects which one it is in by itself (it looks for the loader module in its own document,
and at `oma.standalone` for the browser viewer) and preselects the **Door** dropdown. If it guesses
wrong — a host that re-renders a cached widget can strand it — set the dropdown by hand before
running, because a row labelled with the wrong door is worse than no row.

## Per host

Nothing below changes what you press; it is only how each host gets the server in front of it.

- **Claude Desktop** — stdio. `node install.mjs` writes the entry; `⌘Q` and relaunch after any
  install, because the tool and resource lists are read at connect time. For the second cell, add
  `"OMA_DYNAMIC_TOOLS": "1"` to that entry's `env` and relaunch again.
- **claude.ai** — the remote `/mcp` endpoint (`node src/http.mjs` behind whatever tunnel you use).
  A new tunnel URL is a new connector; re-add it rather than editing one in place. Same
  `OMA_DYNAMIC_TOOLS=1` for the second cell, set on the process before it starts.
- **ChatGPT** — same `/mcp` endpoint, added as a connector. Expect `connect-loopback` to be the
  interesting cell here and expect `sendMessage`-shaped affordances elsewhere in the engine to
  behave differently; neither affects these nine.
- **dsh** — the plugin loads the engine's `/view/<app>` page in an iframe, so what you are reading
  there is **the engine's own viewer policy**, not a host's. Record it as such: it is a useful
  control, not a fourth host reading.

## The nine

| probe | asks | reads as |
|---|---|---|
| `connect` | a declared `connectDomains` origin (`https://api.github.com`) | `pass` = the host honoured `connectDomains` |
| `connect-loopback` | this engine's own `http://127.0.0.1:<port>` viewer, from an `https` widget | `pass` = a local OSS install can talk to itself from inside a chat host |
| `resource` | a declared `resourceDomains` origin, as an `<img>` | `pass` = the host honoured `resourceDomains` |
| `frame` | a declared `frameDomains` origin, as a nested `<iframe>` | `pass` = the host honoured `frameDomains` **and** the target site allows framing |
| `function-fetch` | `oma.callFunction("net_probe")`, which fetches from the **engine process** | `pass` expected on every host — it is an MCP tool call, no declaration, no host cooperation. A `fail` here means the machine has no network and every other reading is void |
| `which-meta` | two origins at once — see the two-step below | tells you whether the host resolved the policy at registration or at read time |
| `undeclared` | an origin declared nowhere (`https://example.com`) | **inverted**: `pass` means the fetch was BLOCKED, which is correct. A `fail` means the host let it through, i.e. it is not enforcing declarations at all |
| `worker` | `new Worker` from a `blob:` URL | `pass` = off-main-thread libraries (PDF.js, Perspective, anything with a worker in it) can run here |
| `wasm` | compiling the 8-byte empty WebAssembly module | `pass` = WebAssembly can run here |

### The last two ask something no app can declare

`worker` and `wasm` are not about honouring a declaration, because there is nothing to declare.
`McpUiResourceCsp` has four keys and all four are lists of **domains** — the spec has no spelling
for "this app needs a Worker" or "this app needs WebAssembly", and neither does this engine. An app
gets whatever the policy on its document happens to permit, and nobody asked for it.

So for these two the interesting question is **which layer said no**, and the only way to answer it
is to run the same probe twice:

1. **This engine's own viewer first** (`/view/host-csp-probe`). That policy is *ours* —
   `viewCspFor` / `runnerCspFor` in `src/http.mjs` and `src/runner.mjs`. Today's floor has no
   `worker-src` at all and no `'wasm-unsafe-eval'` in `script-src`, so **both are expected to fail
   here**, and that failure is a fact about us, not about any host.
2. **Then the host.** If a host permits what our own floor refuses, the host is the more permissive
   layer and the gap is ours to close; if the host refuses too, an app needing either capability
   cannot ship on that host at all until the spec grows a way to ask.

Record both rows. A `worker`/`wasm` reading with no viewer reading beside it cannot be attributed,
and an unattributed reading is what sends someone to fix the wrong layer.

### Reading a `fail` honestly

A CSP refusal is not an exception you can catch — `fetch` rejects with the same bare
`TypeError: Failed to fetch` a DNS failure produces. The app separates them with the
`securitypolicyviolation` event, and reports one of four verdicts in `detail`:

| verdict | means |
|---|---|
| `allowed` | the request left the page and the answer was readable |
| `allowed-opaque` | the request left the page; only the **CORS** read was refused. The host's CSP said yes — which is the question being asked, so this counts as reached |
| `csp-blocked` | a `securitypolicyviolation` naming this URL. The only positive evidence of enforcement |
| `error` | neither. **Not a CSP reading.** Offline, DNS, a corporate proxy — or, on `connect-loopback` specifically, Private Network Access refusing a public page's request to a loopback address, which is a browser rule and not the host's policy at all |

The first time anything is blocked, the host's real policy string arrives with the event
(`originalPolicy`) and is shown in **What the host enforced**. Copy that string into the matrix
row's evidence — it is the only place a widget can ever see what the host actually applied, and
it settles arguments that no amount of probing otherwise can.

The panel above it, **What the engine relayed**, is the merged declaration read back live through
`app_html`. Compare the two: that comparison *is* the measurement.

### `which-meta`, the two-step

A widget cannot ask a host "did you read my policy from `resources/list` or from `resources/read`".
It can only be told two different answers at two different times and see which one arrived. So:

1. Install and open the probe **once**. `A` (`https://api.github.com`) is in the manifest; `B`
   (`https://api.ipify.org`) is in nothing. Expect A reachable, B blocked.
2. Add B to this app's policy **without touching the app**, and **without restarting the server**:

   ```
   security_set { key: "policy:csp:host-csp-probe",
                  value: "{\"connectDomains\":[\"https://api.ipify.org\"]}" }
   ```

3. **Close the widget and open the app again** — ideally in a new conversation. This is not
   optional and it is the step everyone skips: a document's CSP is fixed when it is created, so
   fetching B inside the already-rendered widget can only ever fail, and that failure is not
   evidence of anything. Then run `which-meta` again.

Read it:

| after step 3 | means |
|---|---|
| A and B both reachable | the host resolved the policy at **read** time (`resources/read`) — a user addition takes effect on the next open |
| A reachable, B not | the host is using a **snapshot** taken when the resource was registered (`resources/list`) — a user addition needs a reconnect |
| neither reachable | this host did not honour the declaration at all; the `undeclared` row tells you whether it is enforcing anything |

The probe refuses that verdict in the two states where it would be a confident wrong answer, and it
refuses them by asking the engine rather than by trusting you to have read this:

- **step 2 not done** — B is not in what the engine relays, so there is nothing a host could have
  honoured. Recorded as `STEP 1 BASELINE ONLY`.
- **step 3 skipped** — B *is* relayed now, but the policy changed after this document was created,
  so this document's CSP predates it and B is refused for a reason that has nothing to do with the
  host. Recorded as `POLICY CHANGED AFTER THIS DOCUMENT WAS CREATED`, with both readings printed.
  This is the one everybody walks into, because "A reachable, B not" looks exactly like a
  registration snapshot from the inside.

One precondition is left that the probe cannot check for you, so put it in the row's `detail`:
**the engine process must not be restarted between step 1 and step 3.** A restart re-registers
every resource, which puts B into the snapshot too and destroys the distinction being measured.

### `undeclared`, and the one way it could lie

On the `open_app` door the loader carries the **union of every app in the store** plus
`policy:csp:*`. If some other app in that store declared `https://example.com`, or the user did
globally, then reaching it proves nothing about the host. The probe rules that out itself — when
the fetch gets through it asks the engine whether the origin was in the relayed set and says which
of the two happened — but the check depends on `app_html`, so an installation that cannot call it
(a sandboxed install) reports the row as inconclusive rather than guessing.

## The reference reading — run this first, every time

Before pointing the probe at any host, run it in this engine's own viewer. That policy is one this
repository builds from the same declaration (`viewCspFor`), so the viewer is the one place where
the *right* answer is known in advance. **If the probe disagrees with the column below, the probe
is broken — do not carry it to a host.**

```bash
OMA_DB=/tmp/probe.db node install-app.mjs test/probes/host-csp-probe/ui.html \
  --name host-csp-probe --manifest test/probes/host-csp-probe/manifest.json
OMA_DB=/tmp/probe.db PORT=18787 node src/http.mjs
# then open http://127.0.0.1:18787/view/host-csp-probe and press Run all
```

Measured 2026-08-16, Chrome, on a clean store:

| probe | viewer | why |
|---|---|---|
| `connect` | pass | `connect-src` carries the declared origin |
| `connect-loopback` | pass | **but same-origin** — the viewer *is* the loopback origin, so `'self'` covers it. This cell says nothing about the cross-origin case a chat host presents, which is the whole reason the cell exists |
| `resource` | pass | 288×288 image loaded |
| `frame` | pass | cross-origin document, 320×180 box |
| `function-fetch` | pass | ~320ms through the engine process |
| `which-meta` | `STEP 1 BASELINE ONLY`, then pass after step 2 | the viewer computes its policy per request, so a user addition lands on the next page load — the read-time reference behaviour |
| `undeclared` | pass (blocked) | `connect-src` refused `https://example.com` |
| `worker` | **fail** | `worker-src blocked blob` — expected; our floor has no `worker-src` |
| `wasm` | **fail** | `script-src refused the compile (wasm-eval)` — expected; our floor has no `'wasm-unsafe-eval'` |

The last two failing is the correct reading, not a defect in the probe.

## Getting the readings out

```
data_list { collection: "host-csp-probe" }
```

or open the viewer's Data pane at `/view/host-csp-probe`. Every run also writes one `env` row
(`ok: true`, `probe: "env"`) carrying the door evidence, the engine's host label, the page origin,
`oma.viewBase`, the merged policy and the host's enforced policy — that row is the context the
nine readings have to be read against, so copy it out with them.

## Where a reading lands

Readings go into the host matrix at `docs/host-matrix.json` (internal tree; it is not part of the
public snapshot). Use the file's existing row shape — do not invent fields for it. One row per
question, with the per-host cells carrying the door in the note, looks like this:

```json
{
  "id": "csp.connect-domains-honored",
  "source": "runtime-plan-2026-08-16 §3 step 3",
  "platforms_class": "host-behavior",
  "clause": "manifest.csp.connectDomains relayed in _meta.ui.csp — does the host turn it into connect-src?",
  "verdict": "PARTIAL",
  "impl": "src/store.mjs cspFor + src/tools/apps.mjs resource _meta",
  "evidence": "host-csp-probe rows, collection host-csp-probe, probe=connect. Engine relayed {\"connectDomains\":[\"https://api.github.com\"]}; host-enforced policy string captured in the env row.",
  "how_to_check": "install test/probes/host-csp-probe, open it, press Run all, read the rows",
  "platforms": {
    "claude-desktop-chat-mcp": "ok(open_app door)",
    "claude-web-chat-plugin": "无读数"
  },
  "measured_date": "2026-08-__",
  "status": "assertable",
  "verified_by": "firsthand",
  "measured_by": "host-csp-probe"
}
```

The cell vocabulary is the file's own: `ok` / `fail` / `无读数` / `n/a`. `undeclared` inverts, so
spell it out in the cell — `ok(blocked, as required)` — rather than leaving a bare `ok` for a
future reader to misread.

One row per probe, so nine rows in all. Seven of them are `platforms_class: "host-behavior"` and
describe what the host did with a declaration. The last two are not:

```json
{
  "id": "csp.worker-from-blob",
  "clause": "new Worker(blob:) — no manifest.csp key can ask for it (McpUiResourceCsp is four domain lists)",
  "impl": "src/runner.mjs runnerCspFor + src/http.mjs viewCspFor — neither emits worker-src",
  "evidence": "host-csp-probe probe=worker. OUR OWN viewer: <reading>. Host: <reading>. The pair is what attributes it.",
  "platforms": { "browser-viewer": "fail(our floor has no worker-src)" }
}
```

and the same shape for `csp.wasm-compile` (`script-src` carries no `'wasm-unsafe-eval'`). Both rows
are meaningless without the viewer cell beside the host cell — that is the pair that says which
layer refused.

## Why this is not in `components/`

It is not a product app. It writes a diagnostic log, it deliberately declares an origin it does not
need, and it exists to be pointed at a host once and then read. It lives under `test/` with the
rest of the machinery that checks whether this engine tells the truth.
