import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitepress";

const here = dirname(fileURLToPath(import.meta.url));
const site = "https://willowisp.dev";

/**
 * Each docs page as plain Markdown beside its HTML, at /docs/<page>.md, as llmstxt.org
 * suggests: an agent reads the text and the pipelines to copy, without the page around them.
 * The site's own pieces (recordings, diagrams, the use-case cards) are left out, and links
 * point to the other Markdown pages.
 */
async function markdownPages(outDir: string): Promise<void> {
  const docs = join(here, "..", "docs");
  await mkdir(join(outDir, "docs"), { recursive: true });
  for (const name of (await readdir(docs)).filter((file) => file.endsWith(".md"))) {
    let text = await readFile(join(docs, name), "utf8");
    for (const [, path] of [...text.matchAll(/<!--@include: (.+?)-->/g)]) {
      text = text.replace(`<!--@include: ${path}-->`, await readFile(resolve(docs, path as string), "utf8"));
    }
    text = text
      .replace(/^---\n[\s\S]*?\n---\n+/, "")
      .replace(/^<(Recording|Pipeline|UseCases)\b[^>]*\/>\n+/gm, "")
      .replace(/^::: ?(tip|warning|info|danger|details) ?(.*)$/gm, (_line, kind: string, title: string) => {
        const said = title || `${kind[0]?.toUpperCase()}${kind.slice(1)}`;
        return `**${said}${/[?:.!]$/.test(said) ? "" : ":"}**`;
      })
      .replace(/^:::$/gm, "")
      .replace(/\]\(\.\/([\w-]+)(#[^)]*)?\)/g, (_link, page: string, anchor?: string) => `](${site}/docs/${page}.md${anchor ?? ""})`)
      .replace(/\n{3,}/g, "\n\n");
    await writeFile(join(outDir, "docs", name), text);
  }
}

/**
 * /llms.txt, in the shape llmstxt.org sets out: what Wisp is, then links to the docs as
 * Markdown pages. /llms-full.txt is the whole reference, the same text as
 * docs/SPEC.md and `wisp help agents`, so there is one copy to keep right.
 */
const LLMS = `# Wisp

> Wisp runs pipelines on your own machines: a dev stack, checks before a push, a deploy, a backup. A pipeline is steps that run side by side or wait for what they need: commands, Docker services, waits for a port or a website, other pipelines, and links, folders and apps to open. It lives in a \`.wisp.json\` next to the code, or in a personal workspace, and runs with \`wisp <workspace> <pipeline>\` from whatever folder you're in, on the machine Wisp is installed on: a laptop or a server. Wisp keeps track of everything it starts, keeps every run like CI, and runs nothing from a cloned repository until a person allows it. Free and open source, for macOS, Linux and Windows.

The complete reference for agents, the file format, every command, JSON output and exit codes, is [llms-full.txt](${site}/llms-full.txt). The installed CLI prints the same text with \`wisp help agents\`. Pipelines to copy for common jobs are in [Use cases](${site}/docs/use-cases.md). Every page below is Markdown.

## Docs

- [What is Wisp](${site}/docs/introduction.md): pipelines on your own machines, in one page
- [Getting started](${site}/docs/getting-started.md): install, let Wisp write the first pipeline, allow it, run it
- [Use cases](${site}/docs/use-cases.md): pipelines to copy: a dev stack, checks before a push, a release, a deploy that asks first, running an app on a server, scheduled backups, a check that a site is up, an SSH tunnel
- [Pipelines](${site}/docs/pipelines.md): the .wisp.json file, a pipeline's name, wisp init
- [Steps](${site}/docs/steps.md): run a command, start Docker services, run a pipeline, wait, open a website, folder, file or app
- [Order](${site}/docs/order.md): steps side by side or in order, with after
- [Commands](${site}/docs/commands.md): keeps running or finishes, failures, timeouts, restart on crash
- [Docker](${site}/docs/docker.md): compose services, waiting until healthy, failing at once when Docker isn't running
- [Pipelines as steps](${site}/docs/pipelines-as-steps.md): one pipeline as a step of another
- [Inputs](${site}/docs/inputs.md): values a pipeline asks for each run
- [Asking first](${site}/docs/asking-first.md): a question before a pipeline runs
- [Workspaces](${site}/docs/workspaces.md): projects, .wisp.local.json and personal workspaces
- [Running pipelines](${site}/docs/running-pipelines.md): running by name from any folder, dry runs, stopping
- [What's running](${site}/docs/whats-running.md): background commands, logs, crashes, commands that ask something
- [History](${site}/docs/history.md): every run kept like CI, retry what failed
- [Hooks and cron](${site}/docs/hooks-and-cron.md): git hooks, schedules, scripts
- [Notifications](${site}/docs/notifications.md): on screen, and by webhook to Slack, Discord, Teams, ntfy or any address
- [Trust](${site}/docs/trust.md): why a cloned repository's commands wait for approval
- [Secrets](${site}/docs/secrets.md): fetching secrets in a step
- [CLI](${site}/docs/cli.md): every command, option and environment variable
- [File reference](${site}/docs/reference.md): every field of a .wisp.json
- [Questions](${site}/docs/questions.md): short answers to common questions

## Optional

- [The dashboard](${site}/docs/dashboard.md): the screen \`wisp\` opens in your terminal
- [Settings](${site}/docs/settings.md): what opens folders and files, where commands run
`;

const description = "Pipelines for your own machines: steps that run side by side or wait for what they need. Your dev stack, checks, deploys and backups, run by name from whatever folder you're in, the same on your laptop and on your servers. Free and open source.";

export default defineConfig({
  async buildEnd(config) {
    await writeFile(join(config.outDir, "llms.txt"), LLMS);
    await copyFile(join(here, "..", "..", "docs", "SPEC.md"), join(config.outDir, "llms-full.txt"));
    await markdownPages(config.outDir);
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
  markdown: {
    config(md) {
      const inline = md.renderer.rules.code_inline;
      md.renderer.rules.code_inline = (tokens, at, options, env, self) => {
        const html = inline ? inline(tokens, at, options, env, self) : self.renderToken(tokens, at, options);
        return html.replace(/^<code/, "<code v-pre");
      };
    },
  },
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
      { text: "Docs", link: "/docs/introduction", activeMatch: "^/docs/(?!agents)" },
      { text: "For agents", link: "/docs/agents" },
      { text: "Releases", link: "https://github.com/phrp720/wisp/releases" },
    ],
    sidebar: {
      "/docs/": [
        {
          text: "Start here",
          items: [
            { text: "What is Wisp", link: "/docs/introduction" },
            { text: "Getting started", link: "/docs/getting-started" },
            { text: "Use cases", link: "/docs/use-cases" },
          ],
        },
        {
          text: "Pipelines",
          items: [
            { text: "Pipelines", link: "/docs/pipelines" },
            { text: "Steps", link: "/docs/steps" },
            { text: "Order", link: "/docs/order" },
            { text: "Commands", link: "/docs/commands" },
            { text: "Docker", link: "/docs/docker" },
            { text: "Pipelines as steps", link: "/docs/pipelines-as-steps" },
            { text: "Inputs", link: "/docs/inputs" },
            { text: "Asking first", link: "/docs/asking-first" },
            { text: "Workspaces", link: "/docs/workspaces" },
          ],
        },
        {
          text: "Running",
          items: [
            { text: "Running pipelines", link: "/docs/running-pipelines" },
            { text: "What's running", link: "/docs/whats-running" },
            { text: "History", link: "/docs/history" },
            { text: "Hooks and cron", link: "/docs/hooks-and-cron" },
            { text: "Notifications", link: "/docs/notifications" },
          ],
        },
        {
          text: "Safety",
          items: [
            { text: "Trust", link: "/docs/trust" },
            { text: "Secrets", link: "/docs/secrets" },
          ],
        },
        {
          text: "Tools",
          items: [
            { text: "The dashboard", link: "/docs/dashboard" },
            { text: "Settings", link: "/docs/settings" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "CLI", link: "/docs/cli" },
            { text: "File reference", link: "/docs/reference" },
            { text: "For AI agents", link: "/docs/agents" },
            { text: "Questions", link: "/docs/questions" },
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
