// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// build.mjs — bundle the shell runtime (App bridge + window.oma) into dist/shell.js.
// Run: node build.mjs             — fail loudly if esbuild is missing
//      node build.mjs --optional  — no-op instead, for the `prepare` hook: npm runs
//        it on plain installs (where devDependencies, and so esbuild, are present)
//        but ALSO on `npm ci --omit=dev`, where they are not.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// MIT and ISC both require their copyright + permission notice to travel with every copy of the
// code. The bundled packages carry that notice in a LICENSE file rather than in a source comment,
// so esbuild's legalComments has nothing to preserve and we have to emit it ourselves. Derived from
// what was actually bundled (esbuild's metafile), so it cannot drift from the dependency list.
function thirdPartyNotices(metafile) {
  const names = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const m = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (m) names.add(m[1]);
  }
  const blocks = [...names].sort().map((name) => {
    const root = join(HERE, "node_modules", name);
    const { version, license } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    let text = null;
    for (const f of ["LICENSE", "LICENSE.md", "LICENCE", "LICENSE.txt"]) {
      try { text = readFileSync(join(root, f), "utf8").trim(); break; } catch { /* try the next name */ }
    }
    if (!text) throw new Error(`${name}@${version} is bundled but ships no LICENSE file — cannot attribute it`);
    return `${name}@${version} — ${license ?? "see below"}\n\n${text}`;
  });
  return `/*!\n * This file bundles the following third-party packages. Their licences are reproduced\n * in full, as those licences require.\n *\n${
    blocks.join("\n\n" + "-".repeat(76) + "\n\n").split("\n").map((l) => ` * ${l}`.trimEnd()).join("\n")
  }\n */\n`;
}

let build;
try {
  ({ build } = await import("esbuild"));
} catch (err) {
  // Only a genuinely absent esbuild is optional — a broken one still throws.
  if (err?.code !== "ERR_MODULE_NOT_FOUND" || !process.argv.includes("--optional")) throw err;
  console.log("dist/shell.js skipped — esbuild not installed (--optional)");
  process.exit(0);
}

const out = await build({
  entryPoints: [join(HERE, "src", "shell-runtime.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  // minify strips comments, so the bundle's own licence has to be stated in a banner, and the
  // bundled packages' notices appended from their LICENSE files (see thirdPartyNotices).
  banner: { js: "/*! SPDX-License-Identifier: AGPL-3.0-only | Copyright (C) 2026 2nd1st */" },
  metafile: true,
  write: false,
});
mkdirSync(join(HERE, "dist"), { recursive: true });
const js = out.outputFiles[0].text + "\n" + thirdPartyNotices(out.metafile);
writeFileSync(join(HERE, "dist", "shell.js"), js);
console.log(`dist/shell.js written — ${js.length} chars`);
