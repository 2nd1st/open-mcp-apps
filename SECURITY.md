# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — open a
[GitHub security advisory](https://github.com/2nd1st/open-mcp-apps/security/advisories/new) on this
repository. Don't file a public issue for a vulnerability. We'll acknowledge it and work on a fix.

## Trust model (current)

open-mcp-apps runs UI components inside the host's widget sandbox and tiers trust by where a component
came from:

- **Locally-authored and system components** run in **direct mode** — you or your AI wrote them; they're
  as trusted as your own code.
- The engine also ships a **sandboxed runner** — a CSP-first `srcdoc` iframe with a minimal, read-scoped
  bridge — as the mandatory execution mode for any component that isn't locally trusted.

**Honest status:** the runner is *built and tested but dormant*. There is no install-from-elsewhere path
yet, so nothing untrusted actually reaches it today. It exists so the door is already the right shape
when a shared component library lands — treat it as a foundation, not a shipped guarantee.

A few rules are enforced in the store, so they bind **every** caller and transport: reserved
`security:*` / `policy:*` config keys that generic data writes can't touch, an out-of-band privileged
writer, and a per-item size cap. The HTTP transport binds to `127.0.0.1`.

## Known issues

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for current host and sandbox limitations.
