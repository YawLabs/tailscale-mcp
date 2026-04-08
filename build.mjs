/**
 * Bundles the MCP server into a single self-contained file.
 *
 * Why: `npx` has to install all runtime dependencies on every cold start.
 * With 74 MB of node_modules (MCP SDK + zod), this takes 5-10 minutes on
 * Windows.  By bundling everything into one file and declaring zero runtime
 * dependencies, npx downloads only the tarball (~50 KB) and runs immediately.
 */

import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: "dist/index.js",
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  // Node built-ins are provided by the runtime, not bundled
  external: ["node:*"],
  sourcemap: true,
  // Keep readable for debugging MCP issues
  minify: false,
});
