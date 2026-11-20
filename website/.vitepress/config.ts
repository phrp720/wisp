import { copyFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitepress";

const here = dirname(fileURLToPath(import.meta.url));
const site = "https://willowisp.dev";

/**
 * /llms.txt, in the shape llmstxt.org sets out: what Wisp is, then links to the docs as
 * Markdown-friendly pages. /llms-full.txt is the whole reference, the same text as
 * docs/SPEC.md and `wisp help agents`, so there is one copy to keep right.
 */
const LLMS = `# Wisp

> Wisp runs everyday tasks with one word each: start a project's database, server and page; run the checks; back up; redeploy. A \`.wisp.json\` next to the code, or a workspace of your own, lists each task's steps; \`wisp <bolt>\` runs them from any terminal, on a laptop or a server. Free and open source, for macOS, Linux and Windows.

The complete reference for agents, the file format, every command, JSON output and exit codes, is [llms-full.txt](${site}/llms-full.txt). The installed CLI prints the same text with \`wisp help agents\`.

## Docs

- [Getting started](${site}/docs/getting-started): install, write the first bolt, run it
- [Recipes](${site}/docs/recipes): the dev stack, checks before a push, a deploy that asks first, a nightly backup that tells you if it fails
- [The .wisp.json file](${site}/docs/file): every kind of step, dependencies, several operating systems
- [Runs and history](${site}/docs/runs): commands that finish, failures, and every run kept like a CI run
- [What's running](${site}/docs/running): background commands, logs, stopping, restart on crash
- [Settings](${site}/docs/settings): which editor opens folders and files, where commands run, notifications
- [Trust](${site}/docs/trust): why a cloned repository's commands wait for approval
- [Commands](${site}/docs/commands): every command, option and environment variable
- [File reference](${site}/docs/reference): every field of a .wisp.json
- [Questions](${site}/docs/questions): short answers to common questions

## Optional

- [The dashboard](${site}/docs/dashboard): the screen \`wisp\` opens in your terminal
`;

const description = "Your everyday tasks, one word each: start the dev stack, run the checks, back up, redeploy. Written once, run from any terminal, on your laptop or a server. Free and open source.";

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
  sitemap: { hostname: site },
  appearance: "dark",
  lastUpdated: false,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }],
    ["meta", { name: "theme-color", content: "#8b5cf6" }],
    ["meta", { property: "og:title", content: "Wisp" }],
    ["meta", { property: "og:url", content: site }],
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
            { text: "Recipes", link: "/docs/recipes" },
            { text: "Questions", link: "/docs/questions" },
          ],
        },
        {
          text: "Use it",
          items: [
            { text: "The dashboard", link: "/docs/dashboard" },
            { text: "What's running", link: "/docs/running" },
            { text: "Runs and history", link: "/docs/runs" },
          ],
        },
        {
          text: "Set it up",
          items: [
            { text: "The .wisp.json file", link: "/docs/file" },
            { text: "Settings", link: "/docs/settings" },
            { text: "Trust", link: "/docs/trust" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "Commands", link: "/docs/commands" },
            { text: "File reference", link: "/docs/reference" },
            { text: "For AI agents", link: "/docs/agents" },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: "https://github.com/phrp720/wisp" }],
    search: { provider: "local" },
    outline: { level: [2, 3], label: "On this page" },
    editLink: { pattern: "https://github.com/phrp720/wisp/edit/main/website/:path", text: "Edit this page on GitHub" },
  },
});
