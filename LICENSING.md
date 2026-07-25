# Licensing

open-mcp-apps ships under **two licenses**, split by directory, plus a
**trademark reservation** and a **contributor agreement**. This file is the map;
the license texts themselves are authoritative.

Copyright © 2026 **2nd1st**, for both halves. Every source file carries its own
`SPDX-License-Identifier`, so a scanner does not have to infer any of this.

## The engine — AGPL-3.0-only

Everything in this repository **except** the `components/` directory is the
engine: the registry, the shell runtime, the data/command layer, the host
adapters, the HTTP/stdio servers, and the build. It is licensed under the
**GNU Affero General Public License, version 3.0** (see [`LICENSE`](LICENSE)).

The AGPL is a network copyleft license: anyone who runs a modified version of
the engine as a network service must offer the source of their modified version
to the users of that service (AGPL §13). This keeps the engine — and any
improvements to it — open for everyone who builds on it.

SPDX identifier: `AGPL-3.0-only`.

## The components / library — MIT

The `components/` directory is the official **components/library** layer: the
single-file HTML apps (dashboard, settings, gallery, and the example apps),
their fixtures, the `_system.css` design kit, and the demo data. These are
licensed under the **MIT License** (see [`components/LICENSE`](components/LICENSE)).

The apps a person runs and edits are content, not engine internals. MIT means
users may open, copy, modify, fork, and redistribute any component freely —
including the ones we ship — without the copyleft obligations that govern the
engine. The permissive license here is deliberate: it must never be a legal
question whether you can change your own dashboard.

SPDX identifier: `MIT`.

## Which file is under which license

| Path | License |
| --- | --- |
| `components/**` | MIT |
| everything else (`src/`, `index.mjs`, `*.mjs`, build, tests, docs) | AGPL-3.0-only |

When in doubt, the `LICENSE` file nearest a file (walking up the tree) governs
it: `components/LICENSE` covers that directory, the root `LICENSE` covers the rest.

## Trademarks — not granted by either license

Neither the AGPL nor the MIT license grants any right to the project's names or
logos. The names **"open-mcp-apps"**, **"openmcp.app"**, **"SecondFirst"**, and
**"2nd1st"**, and any associated logos, are reserved. See [`TRADEMARKS.md`](TRADEMARKS.md).

## Contributing

What a contribution needs depends on which half of the split it lands in.

**`components/` (MIT)** — nothing beyond the usual. Inbound is MIT, outbound is
MIT, and MIT already grants everything the project would otherwise ask for. No
agreement to sign, now or later.

**The engine (AGPL)** — a Contributor License Agreement is intended, because the
project keeps the engine under the AGPL while retaining the right to offer it
under other terms (e.g. embedded in the maintainers' own hosted service), and a
single merged contribution could otherwise bind the whole project to the AGPL,
its own maintainers included. [`CLA.md`](CLA.md) is a **draft and not yet in
effect** — the grantee is deliberately unfilled until there is a settled legal
entity to name. Until it is finalised, open an issue before a non-trivial engine
change and provenance gets sorted out with you directly.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the working details.
