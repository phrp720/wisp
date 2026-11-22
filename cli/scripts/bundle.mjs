import { chmod, rm } from "node:fs/promises";

import { build } from "esbuild";

const noDevtools = {
  name: "no-react-devtools",
  setup(bundler) {
    bundler.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    bundler.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default { initialize() {}, connectToDevTools() {} };", loader: "js" }));
  },
};

await rm("dist/bin", { recursive: true, force: true });
await build({
  entryPoints: { wisp: "src/cli/index.ts" },
  outdir: "dist/bin",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  minify: true,
  legalComments: "none",
  banner: { js: "import { createRequire as __wispRequire } from 'node:module'; const require = __wispRequire(import.meta.url);" },
  plugins: [noDevtools],
  logLevel: "warning",
});
await chmod("dist/bin/wisp.js", 0o755);
