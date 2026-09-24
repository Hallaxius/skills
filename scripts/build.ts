/**
 * Builds the publishable bundle with Bun's native bundler.
 *
 * - target="node": the output runs on plain Node >=18 (what npx consumers get),
 *   while development/testing keeps using Bun as the primary runtime.
 * - packages="external": runtime dependencies (@modelcontextprotocol/sdk, zod)
 *   stay in package.json "dependencies" and are resolved from node_modules.
 * - Ensures the first line of dist/index.js is "#!/usr/bin/env node" so npm
 *   bin shims (Unix exec + Windows cmd-shim) launch it correctly.
 */
import { readFile, rm, stat, writeFile } from "node:fs/promises";

const entry = Bun.fileURLToPath(new URL("../src/index.ts", import.meta.url));
const outdir = Bun.fileURLToPath(new URL("../dist", import.meta.url));
const outFile = Bun.fileURLToPath(new URL("../dist/index.js", import.meta.url));
const SHEBANG = "#!/usr/bin/env node";

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [entry],
  outdir,
  target: "node",
  packages: "external",
  sourcemap: "none",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const code = await readFile(outFile, "utf8");
if (!code.startsWith("#!")) {
  await writeFile(outFile, SHEBANG + "\n" + code);
}

const size = (await stat(outFile)).size;
console.log(`build ok: dist/index.js (${size} bytes)`);
