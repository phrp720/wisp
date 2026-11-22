import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Config and trust are read from WISP_HOME at call time, so each file gets its own
    // process and can point Wisp at its own temp directory without racing the others.
    isolate: true,
    env: { WISP_NOTIFY: "off" },
    testTimeout: 15000,
    retry: process.env["CI"] ? 2 : 0,
  },
});
