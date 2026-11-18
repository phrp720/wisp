import { copyFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitepress";

const here = dirname(fileURLToPath(import.meta.url));
// Links are relative, so they work on whatever address the site is served from.
const site = "";

/**
 * /llms.txt, in the shape llmstxt.org sets out: what Wisp is, then links to the docs as
 * Markdown-friendly pages. /llms-full.txt is the whole reference, the same text as
 * docs/SPEC.md and `wisp help agents`, so there is one copy to keep right.
 */
const LLMS = `# Wisp

> Wisp starts a project's working context with one word: the folders, links, apps and commands a task needs, opened and running in order. A \`.wisp.json\` next to the code describes it; \`wisp <bolt>\` runs it. Free and open source, for macOS, Linux and Windows.

The complete reference for agents, the file format, every command, JSON output and exit codes, is [llms-full.txt](${site}/llms-full.txt). The installed CLI prints the same text with \`wisp help agents\`.

## Docs

- [Getting started](${site}/docs/getting-started): install, write the first bolt, run it
- [The .wisp.json file](${site}/docs/file): every kind of step, dependencies, several operating systems
- [Jobs and history](${site}/docs/jobs): runs that stop at the first failure, kept like CI runs
- [What's running](${site}/docs/running): background commands, logs, stopping, restart on crash
- [Trust](${site}/docs/trust): why a cloned repository's commands wait for approval
- [Commands](${site}/docs/commands): every command and its options

## Optional

- [The TUI](${site}/docs/tui): the full-screen view, for people at a terminal
`;

const description = "Start your working context with one word: the folders, links, apps and commands a task needs, opened and running in order. Free and open source.";

export default defineConfig({
  async buildEnd(config) {
    await writeFile(join(config.outDir, "llms.txt"), LLMS);
    await copyFile(join(here, "..", "..", "docs", "SPEC.md"), join(config.outDir, "llms-full.txt"));
  },
  title: "Wisp",
  titleTemplate: ":title · Wisp",
  description,
  lang: "en",
  // /docs/trust rather than /docs/trust.html; the Worker serves both.
  cleanUrls: true,
  appearance: "dark",
  lastUpdated: false,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }],
    ["meta", { name: "theme-color", content: "#8b5cf6" }],
    ["meta", { property: "og:title", content: "Wisp" }],
    ["meta", { property: "og:description", content: description }],
  ],
  themeConfig: {
    logo: { src: "/logo.svg", alt: "" },
    nav: [
      // Every docs page but the agents' one, which has its own item beside it.
      { text: "Docs", link: "/docs/getting-started", activeMatch: "^/docs/(?!agents)" },
      { text: "For agents", link: "/docs/agents" },
      { text: "Releases", link: "https://github.com/phrp720/wisp/releases" },
    ],
    sidebar: {
      "/docs/": [
        {
          text: "Start here",
          items: [
            { text: "Getting started", link: "/docs/getting-started" },
            { text: "Why Wisp", link: "/docs/why" },
          ],
        },
        {
          text: "Using it",
          items: [
            { text: "The TUI", link: "/docs/tui" },
            { text: "The .wisp.json file", link: "/docs/file" },
            { text: "Jobs and history", link: "/docs/jobs" },
            { text: "What's running", link: "/docs/running" },
            { text: "Trust", link: "/docs/trust" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "Commands", link: "/docs/commands" },
            { text: "For AI agents", link: "/docs/agents" },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: "https://github.com/phrp720/wisp" }],
    search: { provider: "local" },
    outline: { level: [2, 3], label: "On this page" },
    editLink: { pattern: "https://github.com/phrp720/wisp/edit/main/website/:path", text: "Edit this page on GitHub" },
    footer: {
      message: 'Released under the <a href="https://github.com/phrp720/wisp/blob/main/LICENSE">MIT License</a>.',
    },
  },
});
