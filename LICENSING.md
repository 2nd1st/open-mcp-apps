# Licensing

open-mcp-apps ships under **one license — MIT** — for every file in the
repository, plus a **trademark reservation**. This file is the map; the license
text itself is authoritative.

Copyright © 2026 **2nd1st**. The engine's source files carry an
`SPDX-License-Identifier: MIT` header, so a scanner does not have to infer the
license from this document.

## Everything — MIT

The engine (the registry, the shell runtime, the data/command layer, the host
adapters, the HTTP/stdio servers, the build) and the `components/` library (the
single-file HTML apps, their fixtures, the `_system.css` design kit, and the demo
data) are all licensed under the **MIT License** — see the single root
[`LICENSE`](LICENSE), which governs the whole tree.

MIT means you may use, copy, modify, merge, publish, distribute, sublicense, and
sell copies of any part of this project, including running a modified version as
a hosted service, with no obligation to publish your changes. The one condition
is the usual one: keep the copyright notice and the permission notice with any
substantial portion you redistribute.

SPDX identifier: `MIT`.

**Until v0.5.2 this repository was split by directory** — the engine was
AGPL-3.0-only and `components/` was MIT, under a separate `components/LICENSE`.
That split is gone: the root `LICENSE` is now the single source of truth, and
`components/` inherits it like every other directory. Nothing was taken away —
the engine moved to strictly more permissive terms, and the apps are governed by
the same MIT text they always were.

## Trademarks — not granted by the license

The MIT license does not grant any right to the project's names or logos. The
names **"open-mcp-apps"**, **"openmcp.app"**, **"SecondFirst"**, and
**"2nd1st"**, and any associated logos, are reserved. See
[`TRADEMARKS.md`](TRADEMARKS.md).

This is deliberate and it does not move with the license. Fork the code freely;
give your fork its own name.

## Contributing

Nothing to sign. Inbound is MIT, outbound is MIT, and MIT already grants
everything the project would otherwise ask for — so there is no agreement to
execute, now or later, for any part of the tree.

**There used to be a CLA** covering engine contributions. Its only reason to
exist was the split: keeping the engine under a copyleft license while retaining
the right to offer it under other terms required contributors to grant those
terms explicitly. Under MIT the grant is already in the license every
contributor's patch arrives under, so the signing ceremony has nothing left to
do. `CLA.md` and the CLA check workflow were removed in v0.5.4; contributors who
signed it previously are unaffected — that agreement only ever granted rights
that MIT grants anyway.

**Sign your commits off** (`git commit -s`). That adds a `Signed-off-by:` line
asserting the [Developer Certificate of Origin](https://developercertificate.org/)
— that the work is yours to submit. DCO is a provenance record, not a license
grant, so it is unaffected by the relicense and still applies.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the working details.
