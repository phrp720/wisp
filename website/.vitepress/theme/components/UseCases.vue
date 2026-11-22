<script setup lang="ts">
import { icons, svgAttrs, uses } from "../useCases";
</script>

<template>
  <ul class="use-cases">
    <li v-for="use in uses" :key="use.title" class="card">
      <a class="head" :href="use.link">
        <span class="icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <component :is="tag" v-for="([tag, attrs], at) in icons[use.icon]" :key="at" v-bind="svgAttrs(attrs)" />
          </svg>
        </span>
        <span class="title">{{ use.title }}</span>
      </a>
      <ul class="examples">
        <li v-for="example in use.examples" :key="example.link">
          <a :href="example.link">{{ example.title }}</a>
        </li>
      </ul>
    </li>
  </ul>
</template>

<style scoped>
.use-cases { list-style: none; padding: 0; margin: 24px 0 8px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.use-cases > li { margin: 0; }
.card { padding: 16px 18px 14px; border: 1px solid var(--wisp-line); border-radius: 12px; background: var(--vp-c-bg-soft); transition: border-color 0.2s; }
.card:hover { border-color: color-mix(in srgb, var(--vp-c-brand-1) 45%, var(--wisp-line)); }
.head { display: flex; align-items: center; gap: 10px; text-decoration: none; color: var(--vp-c-text-1); font-weight: 600; }
.head:hover .title { color: var(--vp-c-brand-1); }
.icon { flex-shrink: 0; width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); border: 1px solid rgba(167, 139, 250, 0.25); }
.title { font-size: 15px; line-height: 1.3; transition: color 0.2s; }
.examples { list-style: none; padding: 0; margin: 10px 0 0 42px; }
.examples li { margin: 0; padding: 2px 0; font-size: 14px; line-height: 1.45; }
.examples a { color: var(--vp-c-text-2); text-decoration: none; transition: color 0.2s; }
.examples a:hover { color: var(--vp-c-brand-1); }
@media (max-width: 640px) {
  .use-cases { grid-template-columns: minmax(0, 1fr); }
}
</style>
