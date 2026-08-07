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
  target: "node20",
  format: "esm",
  outfile: "dist/index.js",
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  // Node built-ins are provided by the runtime, not bundled
  external: ["node:*"],
  // No sourcemap on purpose. package.json `files` publishes dist/index.js only,
  // so emitting one left a `//# sourceMappingURL=index.js.map` reference in the
  // published bundle pointing at a file that wasn't in the tarball. Shipping the
  // map instead would more than double the download (the map is ~2 MB against a
  // ~1.2 MB bundle), which fights the whole reason this file exists -- a small
  // tarball so npx cold-starts fast. `minify: false` below is what actually
  // keeps the bundle debuggable; the map added little on top of readable output.
  // If you re-enable this, add "dist/index.js.map" to package.json `files`.
  sourcemap: false,
  // Keep readable for debugging MCP issues
  minify: false,
});
