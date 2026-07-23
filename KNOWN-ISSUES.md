# Known issues

## Codex / ChatGPT desktop: widget writes fail with MCP error -32000

**Symptom.** In Codex / the ChatGPT desktop app, an open-mcp-apps widget renders correctly, but
clicking a control that *writes* data (advance a step, add/delete an item) shows a red banner:
`Not saved: MCP error -32000: MCP proxy request failed — the host may have blocked the call`.

**Cause.** The host's widget→server proxy for tool calls made from inside the iframe isn't wired up
yet. Upstream: [openai/codex#28912](https://github.com/openai/codex/issues/28912) (OPEN).

**Scope.** Codex / ChatGPT desktop only. Claude Desktop's full widget→server loop works
(`sendMessage` + `data_*` from the widget). AI-side data operations work on every host.

**Workaround.** None on our side — everything rides the standard bridge, so this fixes itself when
the host ships the proxy. Until then, on Codex you can still drive data by *asking the AI* ("mark
step 2 done") instead of clicking the widget.

## Widget sandbox blocks `confirm()` / `alert()` / `prompt()` and `target="_blank"`

The host renders widgets in a sandboxed iframe where these are silently blocked (confirm() returns
false; `target="_blank"`/`window.open()` don't open). The authoring guide forbids them and shows
sandbox-safe patterns (inline two-step confirm; render URLs as selectable text). Noted here because
any component written *before* that guidance may have a non-working delete button or link.

## `readOnlyHint` tools still prompt for approval (Claude Desktop)

`get_component_guide`, `list_components`, `data_collections` carry `readOnlyHint: true`, which was
expected to skip the first-run approval dialog; in the current Claude Desktop they still prompt.
Pick **"Always allow"** once. Cosmetic; host behavior may change.
