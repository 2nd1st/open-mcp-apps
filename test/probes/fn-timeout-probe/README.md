# `fn-timeout-probe` — how long does THIS host wait on `call_function`?

The engine sets no ceiling on a function's `timeout_ms` (CHANGELOG, Unreleased): the real limit is
the host's own tool-call timeout, and nothing in this repository can find out what that is. This app
measures it from the outside, and checks along the way that a function can reach the network.

Two functions, no UI to speak of:

- `egress {url?}` — `await fetch(url)` inside the sandbox; returns `{status, bytes, ms, sample}`.
- `slow {seconds}` — sleeps, then returns `{slept_seconds, finished_at}`. Declared `timeout_ms` is
  one hour, so the engine never gives up first — whatever gives up is the host, or the path to it.

Every call writes a `start` row and an `end` row into the app's collection (`fn`, `phase`, `note`,
`at`). **Those rows are the instrument.** They outlive the chat, and they answer the one question
a host error message never does — did the call reach the engine, and did the body finish?

## Install

```bash
node install-app.mjs test/probes/fn-timeout-probe/ui.html --name fn-timeout-probe \
  --manifest test/probes/fn-timeout-probe/manifest.json --description "function timeout probe"
```

## Run

Ask the host, one call at a time:

> Call fn-timeout-probe function "egress" with no args and report exactly what came back.

> Call fn-timeout-probe function "slow" with args {"seconds": 30} and tell me exactly what came
> back or what error you saw.

Then climb: 60, 120, 240 … until the host errors, and bisect between the last pass and the first
fail. Two or three more calls pin the number to within a minute.

## Reading it

After each call, `data_list` the collection (locally, not through the host) and look at the rows:

| rows for that call | host said | meaning |
|---|---|---|
| `start` + `end` | result | pass — the host waited that long |
| `start` + `end` | error | **the host gave up** while the body was still running: that is the host's tool-call limit |
| `start` only | error | the body was killed — the engine's own deadline, which this app sets to an hour, so look for a crash |
| no rows | error | the call never arrived — the tunnel or proxy in front of the engine dropped it, not the host |

The last row matters most. A remote host reaches a local engine through some tunnel or reverse
proxy, and free tunnels have idle policies and hostname rotation of their own; a failure with no
`start` row is theirs. When in doubt, drive the same `slow` call through the tunnel with `curl`
(the same MCP `tools/call` body, `Accept: application/json, text/event-stream`): if `curl` gets a
200 after N seconds and the host does not, the host is the one that stopped waiting.

The engine's own reading of the result matters too: the reply's text channel carries the return
value (`Ran app.fn → {…} — N writes`), because some hosts hand the model only `content[].text`.
If the host reports "no return value", check that line before suspecting the function.
