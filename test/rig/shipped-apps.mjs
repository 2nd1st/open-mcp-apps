// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/rig/shipped-apps.mjs — where the apps a test means by "shipped" live on disk.
// System apps (settings · dashboard · app-store) are the engine's own, in components/. The App
// Store's apps are the `@openmcp-app/oma-store` package's apps/ — read from the INSTALLED
// dependency, the same path src/app-store.mjs resolves, never from a copy. Not installed is a
// broken checkout, so this throws rather than letting a test pass over an empty store.
import { readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SYSTEM_APPS_DIR = join(ROOT, "components");
export const STORE_APPS_DIR = join(dirname(createRequire(import.meta.url).resolve("@openmcp-app/oma-store/package.json")), "apps");

const appsIn = (dir) => readdirSync(dir).filter((n) => existsSync(join(dir, n, "ui.html"))).sort();
export const SYSTEM_APP_NAMES = appsIn(SYSTEM_APPS_DIR);
export const STORE_APP_NAMES = appsIn(STORE_APPS_DIR);

/** The folder of a shipped app (system first — a store app can never take a system name). */
export const appDir = (name) => join(SYSTEM_APP_NAMES.includes(name) ? SYSTEM_APPS_DIR : STORE_APPS_DIR, name);
/** Every shipped app: [{name, dir}], system apps then store apps. */
export const shippedApps = () => [...SYSTEM_APP_NAMES, ...STORE_APP_NAMES].map((name) => ({ name, dir: appDir(name) }));
