// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// zod-jitless.js — turn OFF zod's `new Function` fast path, in the WIDGET bundle only.
//
// WHY THIS FILE EXISTS AT ALL, AND WHY IT IS AN IMPORT RATHER THAN A LINE OF CODE.
//
// The widget's CSP is `script-src 'unsafe-inline'` with no `'unsafe-eval'` — the wall that says
// an app cannot turn a string into code. zod v4 compiles an optimised object validator with
// `new Function`, and before it does, it PROBES whether that is allowed (`util.allowsEval`:
// `new Function("")` in a try/catch). Under our policy the probe throws, zod swallows it and
// takes the interpreted path — everything works. But the browser reports the attempt anyway:
// one `securitypolicyviolation` on `script-src ← eval`, in EVERY app author's console, on every
// mount, before a line of their own code has run (measured 2026-08-16 across three frameworks).
//
// That is the engine's noise printed into the author's debugging surface, and the one fix that
// is NOT available is widening the policy: `'unsafe-eval'` would relax the app sandbox to quiet
// a message we ourselves produce. zod's own source names this exact situation and provides the
// switch — "Skip the probe under `jitless`: strict CSPs report the caught `new Function` as a
// `securitypolicyviolation` even though the throw is swallowed" (zod/v4/core/util.js).
//
// NOTHING IS LOST. `fastEnabled = jit && allowsEval.value`, and `allowsEval` is false here no
// matter what — the fast path was never reachable inside a widget. `jitless` skips a probe whose
// answer was already no; it does not change which code path validates a message.
//
// ORDER IS THE WHOLE POINT, and it is why this is a separate module. `jit` is read when a schema
// is CONSTRUCTED, and @modelcontextprotocol/ext-apps builds its schemas at module-evaluation
// time. A statement in shell-runtime.js's own body would run far too late — imports evaluate
// first. An import declaration placed ABOVE the ext-apps one evaluates before it, which is the
// only position from which this setting can be true in time.
//
// WIDGET ONLY: the server never imports this module (shell.mjs reads dist/shell.js as TEXT, it
// does not import it), so the engine process keeps zod's fast path, where eval is allowed and
// the compiled validator is worth having.

import { config } from "zod/v4/core";

config({ jitless: true });

// Belt and braces, and cheap: zod reads its global config off `globalThis.__zod_globalConfig`
// (`globalConfig ?? (globalConfig = {})`), so a SECOND copy of zod arriving through some other
// dependency's own resolution would still find this set rather than start fresh. The import
// above is the supported API; this line is the one that does not depend on module identity.
try {
  const g = globalThis;
  g.__zod_globalConfig = Object.assign(g.__zod_globalConfig || {}, { jitless: true });
} catch { /* a frozen globalThis is not a reason to fail to boot */ }
