import { defineConfig } from "vitepress";

const description = "Start your working context with one word: the folders, links, apps and commands a task needs, opened and running in order. Free and open source.";

export default defineConfig({
  title: "Wisp",
  titleTemplate: ":title · Wisp",
  description,
  lang: "en",
  // /docs/trust rather than /docs/trust.html; the Worker serves both.
  cleanUrls: true,
  appearance: "dark",
  lastUpdated: false,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#8b5cf6" }],
    ["meta", { property: "og:title", content: "Wisp" }],
    ["meta", { property: "og:description", content: description }],
  ],
  themeConfig: {
    logo: { src: "/favicon.svg", alt: "" },
    nav: [
      { text: "Docs", link: "/docs/getting-started", activeMatch: "^/docs/" },
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
      message: "Free and open source, under the MIT license.",
      copyright: "Wisp, as in will-o'-the-wisp: the little light that leads the way.",
    },
  },
});
