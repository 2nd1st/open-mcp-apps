# Known issues

## Claude Desktop 1.24012.9 / Claude Code: `open_component` chat widgets hang at "Loading component…"

**Symptom.** In Claude Desktop's chat surface (and Claude Code), opening an app through the
universal `open_component` tool sticks on the loader placeholder forever. The cowork surface
renders the same widgets fine; Codex renders them fine.

**Cause.** A host regression introduced with Desktop 1.24012.9 (2026-07-25 auto-update):
widget→host bridge calls from a freshly mounted loader widget are silently dropped — no reply,
no error, ever (the renderer logs `oncalltool handler replaced. Previous handler will no longer
be called.` on each mount). The loader's first paint depends on exactly one such call. The
engine now retries with fresh reads on growing windows and a hard deadline, but on this host
*every* call from the loader widget is swallowed, so retries cannot land either. Being reported
upstream.

**Workaround (shipped).** The installer registers Claude Desktop and Claude Code with
`OMA_DYNAMIC_TOOLS=1`: every app gets its own `open_<name>` tool whose per-component resource
uses the direct-embed path, which these hosts render and operate correctly (the registry
listing points the model at those tools). The document now also carries its collection binding,
so widget clicks write normally. Re-run `./install.sh` (or `node install.mjs`) to pick this up
— `--check` shows `stale` until you do. Freshly saved components gain their `open_<name>` tool
after the host refreshes its tool list, which Desktop does lazily; reopening the conversation
hurries it along.

## Codex / ChatGPT desktop: widget ADDS fail with MCP error -32000 (updates now pass)

**Symptom.** In Codex / the ChatGPT desktop app, a widget control that *adds* an item shows a
red banner: `Not saved: MCP error -32000: MCP proxy request failed — the host may have blocked
the call`. Toggling/updating an existing item **works** (confirmed 2026-07-28: widget updates
commit to the store with full provenance; add attempts never reach the server).

**Cause.** The host's widget→server tool proxy is now partially wired: it forwards
`data_update_item` but blocks `data_add_item`, even though both carry identical annotations
(`idempotentHint: true`) and the same passthrough schema shape — the selection is host-side.
Every widget-callable tool here declares `_meta["openai/widgetAccessible"]: true` (the switch
OpenAI's reference documents for exactly this), verified on the wire — the block persists
regardless, so the current build's policy ignores the documented flag for adds (ChatGPT
surfaces gate widget calls behind per-call permission dialogs the codex surface may never
show — see openai/openai-apps-sdk-examples#163). The proxy policy is not in the open-source
codex CLI. Upstream: [openai/codex#28912](https://github.com/openai/codex/issues/28912),
related [#30092](https://github.com/openai/codex/issues/30092). Deletes untested.

**Scope.** Codex / ChatGPT desktop only. Claude hosts' widget→server loop works (via the
direct-embed path — see the entry above). AI-side data operations work on every host.

**Workaround.** None needed for ticking/toggling. For new rows, ask the AI ("add soy sauce to
the list") — AI-side `data_add_item` works everywhere. A client-side bypass is impossible:
the codex widget sandbox's CSP blocks ALL `connect-src` (measured in-widget 2026-07-28 —
loopback and external fetches alike are refused, origin `codex-sandbox://…`), so every write
must ride the host's proxy. The fix has to come from the host.

## Deleting an app with `data: "cascade"` can remove a collection another app READS

**Symptom.** App A owns collection `A` and app B renders the same collection — but B declares
nothing in its manifest and has never written to it (it only reads). Deleting A with
`data: "cascade"` classifies `A` as exclusively A's and deletes the rows, so B renders empty.

**Why.** Ownership is established from three signals: a manifest declaration, a widget write
recorded in the ledger, and the collection's name. **Reads leave no trace at all**, so a
read-only dependency is invisible to the engine. This is a limit of the evidence, not a missing
check — nothing in the store records that B ever looked.

**What protects you meanwhile.** Cascade is never silent: it is a two-step action, and the first
step returns a plan naming every collection it would delete, with row counts, before anything
happens. A collection another app *declares* or *has written to* is always kept. `archive_component`
keeps everything, and plain `delete_component` (no `data:` argument) still keeps all data.

**Fix direction.** Claim-on-first-write — the first time an app's widget writes to an unclaimed
collection, record the claim — which grows the missing map going forward without migrating history.
Tracked as a design item; not scheduled here.

## A button that talks to the AI may look like it did nothing

**Symptom.** You press something in an app that asks the assistant to do something ("Make an app
for this", "Show me the ready-made apps"). Nothing visibly happens in the app. Depending on the
host, the text is sitting in the chat composer waiting for you to press send, or a confirmation
dialog appeared, or the assistant simply answers.

**Why.** `oma.sendMessage` is a *proposal*, not an action: the host decides whether to run it,
confirm it with you, or refuse it — an app cannot speak with your authority. The call resolves as
soon as the host **accepts the request**, and what happens after that is never reported back on any
wire. So the engine genuinely does not know whether anything reached the chat.

**Why we do not paper over it.** 0.3.2 briefly showed a fixed notice ("Check the chat — you may
need to confirm or send it") after every accepted call. Live testing killed it: on desktop the
message had already been delivered and the notice fired anyway — crying wolf on the healthy path —
and on mobile the notice fired while an *empty* message arrived in the chat. A notice that appears
when nothing needs doing is worse than silence, so it was removed rather than reworded. Apps that
want to say something can; the runtime no longer guesses on their behalf.

**Fix direction.** The gap is in the protocol, not in this engine: there is no faithful way to
represent "a person pressed this button" — the intent can only be flattened into free text, and
app-authored free text is exactly what a careful host must not trust. A structured, trustworthy
user action is the missing primitive; we are raising it upstream.

## Refreshing the page may leave a widget blank — mostly fixed in 0.3.2; reopen if it happens

**Symptom.** You refresh the browser tab. The widget comes back blank, or says it lost track of
which app it is, or refuses a write with "No collection bound yet". Asking the assistant to open
the app again always fixes it.

**Why — and this changed in 0.3.2, because we finally measured it instead of inferring it.**

A widget does not carry its own identity: which app it is, and which collection it reads, are told
to it by the host after the document loads. On a re-render the host replays that telling. What it
replays is **not always about this widget**.

**Measured** — ChatGPT web, 2026-07-29, read out of the widget itself (the diagnostic panel below
prints it): when one assistant turn makes several tool calls, a later re-render replays the turn's
**first** call verbatim — its arguments *and* its tool definition — regardless of which call
actually opened the widget. Two turns, two readings:

```
turn: get_component{name:"dev-probe"} → open_component{…}
  after refresh the widget was handed  toolInput = {"name":"dev-probe"}   tool = get_component
turn: data_collections{}              → open_component{…}
  after refresh the widget was handed  toolInput = {}                     tool = data_collections
```

So the earlier description here — "the host sent nothing" — was wrong in both halves. The host
sends something; it is **addressed to a different call**. And it is not unfixable: an envelope that
names the call it belongs to is something we can *read*.

| what came back | what you see | ours? |
|---|---|---|
| the tool's *result* only, no input | (0.3.2 and earlier: lost) | **was ours — fixed.** The result carries the app's name; the runtime was discarding it |
| the app's name, but no collection | app renders, writes refused | **was ours — fixed.** The engine now sends the binding with the document instead of waiting to be told |
| an envelope addressed to a **different call** in the same turn | (0.3.2 and earlier: lost) | **not ours, but survivable — and now survived.** See below |

**What 0.3.2 does about the third row.** The first mount always knows which app it is, so it writes
that down where the host itself will carry it across re-renders. On ChatGPT that is
`window.openai.setWidgetState` — vendor API, feature-detected, kept under a single namespaced key,
and a failed write is not fatal. On a re-render we read it back before trusting anything the host
replayed. A host without such a channel loses nothing it had before.

⚠️ **What this is not.** It is not a general fix, and we are not claiming the problem is gone. It is
one vendor's state channel, verified on one host (ChatGPT web) on one build; hosts without an
equivalent still depend on being told correctly. And the underlying behaviour is the host's to
change, not ours — this is a workaround sitting on top of it.

Two things genuinely have no answer from here, and they are worth stating plainly: the standard has
no widget-state persistence of its own, and `_meta.ui.resourceUri` can be declared on a **tool** or
a **resource** but never on a tool's **result** — so one generic opener cannot hand back a per-app
document. That is why the workaround is a vendor channel rather than a protocol one.

**If it still happens**, the widget now says so in detail rather than going blank: it names every
channel it checked, and when the host told us which call it bound the render to, it names that call
outright. That panel is copyable and is exactly what an upstream report needs.

**What to do meanwhile.** Ask your assistant to open the app again. Nothing is lost — the data
lives in the store, not in the widget.

## "ChatGPT" is ambiguous: web and desktop have different answers

**ChatGPT web (Work mode): verified 2026-07-28 over a remote HTTPS `/mcp` endpoint — widgets
render at full height and a widget button's write reached the store. Codex / ChatGPT desktop
renders too, but widget-initiated *adds* are still refused host-side (see the entry above).**

中文同义：**ChatGPT web(Work mode):2026-07-28 经远程 HTTPS `/mcp` 实测通过——widget 满高
渲染,widget 按钮的写入落盘。Codex / ChatGPT desktop 也能渲染,但 widget 发起的*新增*仍被
宿主拒绝(见上一条)。**

This entry exists so every user-visible host-matrix statement — this README, the hosted
`/beta` and `/get-started` pages — can cite ONE source instead of each re-deriving it.
Quote it verbatim.

**Read it precisely**, because the near miss is easy: "ChatGPT" without a surface qualifier
is ambiguous, and the two surfaces do NOT agree. Web renders and accepts widget writes;
desktop renders but refuses widget-initiated adds. Neither answer transfers to the other.

⚠️ **History, kept on purpose.** Until 2026-07-28 this entry read *"protocol-wise supported;
not yet verified by us — rendering is not claimed"*, and it asked to be quoted verbatim. It
was honest then and stale within the day. If you are reading a downstream page that still
carries the old sentence, that page is out of date — the single-source mechanism only works
if the source is re-checked when the fact moves.

## Widget sandbox blocks `confirm()` / `alert()` / `prompt()` and `target="_blank"`

The host renders widgets in a sandboxed iframe where these are silently blocked (confirm() returns
false; `target="_blank"`/`window.open()` don't open). The authoring guide forbids them and shows
sandbox-safe patterns (inline two-step confirm; render URLs as selectable text). Noted here because
any component written *before* that guidance may have a non-working delete button or link.

## Codex: widgets render in a short fixed viewport (internal scroll)

The same component that auto-fits its height in Claude Desktop shows inside a shorter, fixed-height
frame with an internal scrollbar in Codex. The inline widget iframe's height is **host-controlled**
and the MCP Apps direct-mode API has no "request height" call, so this cannot be fixed from inside
the component. One component-side case *is* fixable: CSS `height: 100vh` / `min-height: 100vh` /
fixed pixel heights make the short viewport worse — size to content instead (the authoring guide's
first-screen rules). Otherwise: host behavior, tracked as a host limitation, not chased here.

## `readOnlyHint` tools still prompt for approval (Claude Desktop)

`get_component_guide`, `list_components`, `data_collections` carry `readOnlyHint: true`, which was
expected to skip the first-run approval dialog; in the current Claude Desktop they still prompt.
Pick **"Always allow"** once. Cosmetic; host behavior may change.
