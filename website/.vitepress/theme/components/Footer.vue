<script setup lang="ts">
import { useSidebar } from "vitepress/theme";

// A quiet row at the bottom of every page, like Ghostty's: the name, the year, the places to go.
const { hasSidebar } = useSidebar();
const year = new Date().getFullYear();
const links = [
  { text: "Docs", href: "/docs/getting-started" },
  { text: "For agents", href: "/docs/agents" },
  { text: "Releases", href: "https://github.com/phrp720/wisp/releases" },
  { text: "npm", href: "https://www.npmjs.com/package/@squaredasher/wisp" },
  { text: "GitHub", href: "https://github.com/phrp720/wisp" },
];
</script>

<template>
  <footer class="wisp-footer" :class="{ 'has-sidebar': hasSidebar }">
    <div class="row">
      <a class="brand" href="/">
        <img src="/logo.svg" alt="" width="18" height="18" />
        <span>Wisp</span>
        <span class="year">© {{ year }}</span>
      </a>
      <nav aria-label="Footer">
        <a v-for="link in links" :key="link.text" :href="link.href">{{ link.text }}</a>
      </nav>
    </div>
  </footer>
</template>

<style scoped>
.wisp-footer { border-top: 1px solid var(--vp-c-divider); background: var(--vp-c-bg); padding: 22px 24px; }
.row { max-width: 1152px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: center; justify-content: space-between; }
.brand { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: var(--vp-c-text-1); text-decoration: none; }
.year { font-weight: 400; color: var(--vp-c-text-3); }
nav { display: flex; flex-wrap: wrap; gap: 6px 20px; }
nav a { font-size: 14px; color: var(--vp-c-text-2); text-decoration: none; transition: color 0.2s; }
nav a:hover { color: var(--vp-c-brand-1); }

/* On docs pages the sidebar is fixed on the left: start where the content starts. */
@media (min-width: 960px) {
  .wisp-footer.has-sidebar { padding-left: calc(var(--vp-sidebar-width) + 32px); }
}
@media (min-width: 1440px) {
  .wisp-footer.has-sidebar { padding-left: calc((100vw - var(--vp-layout-max-width)) / 2 + var(--vp-sidebar-width) + 32px); }
}
</style>
