# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — open a
[GitHub security advisory](https://github.com/2nd1st/open-mcp-apps/security/advisories/new) on this
repository. Don't file a public issue for a vulnerability. We'll acknowledge it and work on a fix.

## Trust model (current)

open-mcp-apps runs UI apps inside the host's widget sandbox and tiers trust by where an app
came from. There are **two tiers**: `local` and `unreviewed`.

- **Locally-authored and system apps** are `local` and run in **direct mode** — you or your AI wrote
  them; they're as trusted as your own code.
- Everything else is `unreviewed` — assume hostile. The engine ships a **sandboxed runner** — a
  `srcdoc` iframe at an opaque origin (`sandbox="allow-scripts"`, no `allow-same-origin`) under a
  `default-src 'none'` CSP — as the mandatory execution mode for any app that isn't locally trusted.
  Its bridge is **narrow, not read-only**: an app may read *and write* the collection it is bound to.
  Everything else is off by default and granted per tier or per app — cross-collection access, file
  reads and writes, settings writes, source reads, host messaging — while the generic tool passthrough
  is an explicit allowlist and item deletion is confirmed or refused by policy. A short denylist of
  control-plane tools (policy writes, app save/delete/restore/install) is unreachable from any child
  at any tier.

**Honest status:** the runner is *built and tested but not yet load-bearing*. Everything installable today
is first-party — apps you or your AI author, the seeded set, and `install_from_app_store` entries,
which ship with the engine — and all of it runs in direct mode. No third-party content reaches the runner
until a user-publishing pipeline lands, so treat it as a foundation, not a shipped guarantee.

A few rules are enforced in the store, so they bind **every** caller and transport: reserved
`security:*` / `policy:*` config keys that generic data writes can't touch, an out-of-band privileged
writer, and a per-item size cap. The HTTP transport binds to `127.0.0.1`.

## Known issues

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for current host and sandbox limitations.
