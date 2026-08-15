// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// version.mjs — what build is this, really?
//
// Exists because we could not answer that question about our own deployment. The production
// data plane's image carried no labels, no .git and a package.json version that lagged the
// repo, so "which engine commit is actually serving traffic" had to be reconstructed from the
// image's creation timestamp against git log. That works once; it is not a mechanism.
//
// The failure it prevents is not downtime — it is MISREADING. A host tests the deployment while
// a developer reasons about local HEAD, they draw conclusions about different code, and nothing
// in the loop reveals it. So the version travels with the build and is reported to the host in
// the MCP server info, where whoever is running the test can see it.
//
// OMA_BUILD is optional and set by the image build (see the SaaS repo's Dockerfile): a commit
// SHA, so a hosted deployment identifies an exact commit rather than a release number that may
// cover dozens of them. Running from a checkout, the package version alone is right.
//
// OMA_BUILD_FILE is the same fact by path, and it exists because the first attempt was fragile:
// the image resolved the SHA at build time and injected it inline in CMD. That reached the server
// process and nothing else — invisible to `docker inspect`, invisible to any diagnostic shell, and
// dependent on a shell-form CMD. A path in ENV is discoverable and every process in the container
// resolves the same value.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkgVersion = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8")).version;
  } catch {
    return "0.0.0-unknown"; // never crash a server over a version string
  }
})();

const readIfSet = (path) => {
  if (!path) return "";
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return ""; // provenance is nice to have; never let it stop a server booting
  }
};

const build = (process.env.OMA_BUILD || readIfSet(process.env.OMA_BUILD_FILE)).trim().slice(0, 40);

/** e.g. "0.2.0" from a checkout, "0.2.0+ecc60fa" from an image built at that commit. */
export const ENGINE_VERSION = build ? `${pkgVersion}+${build}` : pkgVersion;
