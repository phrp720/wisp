/**
 * Compile `wisp` into standalone binaries with Bun.
 *
 * Ink loads `react-devtools-core` only when DEV=true, but the bundler cannot know that
 * and fails to find it — so it is swapped for an empty stub here rather than shipped.
 *
 *   bun scripts/compile.ts                       # this machine → bin/wisp
 *   bun scripts/compile.ts linux-x64 windows-x64 # → bin/wisp-<target>[.exe]
 */
const targets = process.argv.slice(2);

const noDevtools = {
  name: "no-react-devtools",
  setup(build: { onResolve: Function; onLoad: Function }) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default { initialize() {}, connectToDevTools() {} };",
      loader: "js",
    }));
  },
};

for (const target of targets.length > 0 ? targets : [undefined]) {
  const outfile = target ? `bin/wisp-${target}${target.startsWith("windows") ? ".exe" : ""}` : "bin/wisp";
  const result = await Bun.build({
    entrypoints: ["src/cli/index.ts"],
    minify: true,
    plugins: [noDevtools],
    // @ts-ignore — `compile` is newer than some Bun type definitions.
    compile: { outfile, ...(target ? { target: `bun-${target}` } : {}) },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`compiled ${outfile}`);
}
