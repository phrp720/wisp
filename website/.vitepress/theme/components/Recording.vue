<script setup lang="ts">
const props = defineProps<{ name: string; alt: string }>();

const SIZES: Record<string, [number, number]> = {
  cli: [1200, 560],
  dashboard: [1400, 860],
  editor: [1400, 760],
  init: [1400, 720],
  jobs: [1400, 760],
  server: [1400, 720],
  settings: [1400, 760],
};
const [width, height] = SIZES[props.name] ?? [1400, 760];
</script>

<template>
  <span class="recording">
    <img class="on-dark" :src="`/demo/${name}.gif`" :width="width" :height="height" loading="lazy" :alt="alt" />
    <img class="on-light" :src="`/demo/${name}-light.gif`" :width="width" :height="height" loading="lazy" :alt="alt" />
  </span>
</template>

<style scoped>
.recording { display: block; }
.recording img { display: block; width: 100%; height: auto; border-radius: 12px; border: 1px solid var(--wisp-line); box-shadow: var(--wisp-shadow); }
.on-dark { background: #1e1e2e; }
.on-light { background: #eff1f5; }
</style>
