// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// index.mjs — package barrel: the public API for library consumers
// (npm users, embedders, hosted multi-tenant back ends). Everything here is a
// re-export of symbols that already exist in src/*.mjs — no logic lives here.
//
// The engine stays single-tenant and transport-agnostic: a consumer picks the
// isolation unit by the path it passes to openStore (one SQLite file = one
// tenant), builds an engine per transport with createEngine(store, opts), and
// serves widgets via the wrapApp/wrapLoader documents. See README.

export { createEngine, tierOf, RUNNER_REQUIRED_HTML, defaultCollectionFor } from "./src/engine.mjs";
export {
  openStore, defaultDbDir, defaultDbPath,
  SCHEMA_VERSION,
  APP_NAME_RE, SETTINGS_COLLECTION,
  RESERVED_KEY_RE, MAX_ITEM_FIELDS_BYTES,
  FILE_PATH_RE, MAX_FILE_BYTES, MAX_FILE_INLINE_BYTES,
  MAX_APP_FILE_BYTES, MAX_APP_FILE_COUNT,
  MAX_TOTAL_FILE_BYTES, MAX_TOTAL_FILE_COUNT,
} from "./src/store.mjs";
export { wrapApp, wrapLoader, TOKEN_FALLBACK_CSS, KIT_CSS } from "./src/shell.mjs";
// The ONE sandbox/preview machine (write-set D): embedding shells compose preview documents
// and enforcement from these instead of keeping hand-synced copies.
export {
  RUNNER_CSP, RUNNER_CSP_POLICY, TOKEN_NAMES, BRIDGE, kitStyle,
  composeChildDoc, composePreviewDoc, stubOmaScript, makeGuard, readFileParts,
} from "./src/runner.mjs";
export { openFileChannel } from "./src/files.mjs";
export { GUIDE } from "./src/guide.mjs";
export { seedSystemApps } from "./seed.mjs";
