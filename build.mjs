// build.mjs — bundle the shell runtime (App bridge + window.oma) into dist/shell.js.
// Run: node build.mjs
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const out = await build({
  entryPoints: [join(HERE, "src", "shell-runtime.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
});
mkdirSync(join(HERE, "dist"), { recursive: true });
writeFileSync(join(HERE, "dist", "shell.js"), out.outputFiles[0].text);
console.log(`dist/shell.js written — ${out.outputFiles[0].text.length} chars`);
