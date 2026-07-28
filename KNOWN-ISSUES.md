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
