# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — open a
[GitHub security advisory](https://github.com/2nd1st/open-mcp-apps/security/advisories/new) on this
repository. Don't file a public issue for a vulnerability. We'll acknowledge it and work on a fix.

## Trust model

open-mcp-apps runs UI apps inside the host's widget sandbox and tiers trust by where an app came from.

- **`local` — direct mode, full trust.** Apps you or your AI wrote, the system apps, and everything
  installed from the App Store — **including apps from folders named in `OMA_APP_STORE_DIRS`**. A
  local app holds the real `window.oma`: it reads and writes every collection, file and setting. Only
  point `OMA_APP_STORE_DIRS` at folders whose contents you would run yourself.
- **Sandboxed — behind the runner.** An app installed with `install-app.mjs --sandboxed`, or opened
  through a share on a deployment that has sharing. The runner is a `srcdoc` iframe at an opaque
  origin (`sandbox="allow-scripts allow-forms"`, no `allow-same-origin`) under a `default-src 'none'` CSP. Its
  bridge is narrow, not read-only: the app may read and write the collection it is bound to;
  everything else (other collections, files, settings, source, host messaging) is off unless granted,
  tool passthrough is an allowlist, and deletion is confirmed or refused by policy. Control-plane
  tools (policy writes, app save/delete/restore/install) are unreachable from it at any tier.

## What runs on your machine

- **App functions are on by default.** An app may declare functions (`manifest.functions`) that the
  AI runs with `call_function`. A body runs in a worker thread on your machine and **can `fetch` any
  URL** — requests leave from your computer. Its `vm` context is an isolation seam, not a security
  boundary: treat a body like any other code you run. Turn functions off with `OMA_FUNCTIONS=0`.
- **The AI can use the app on screen.** `screen_read` / `screen_act` are always registered: the AI
  reads the open app and presses, fills or selects its controls, and runs tools the app registers —
  what you could do in that app. With `confirm_delete` on (the default) it still cannot delete for
  you: the engine's confirmation card is hidden from the relay (`data-oma-chrome`) and accepts only a
  real click (`isTrusted`).
- **What a widget may load or connect to** is the platform CDN allowlist plus the app's own
  `manifest.csp`, relayed to the host, which enforces it.

Rules enforced in the store bind **every** caller and transport: reserved `security:*` / `policy:*`
config keys that generic data writes can't touch, an out-of-band privileged writer, and a per-item
size cap. The HTTP transport binds to `127.0.0.1`.

## Known issues

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for current host and sandbox limitations.
