<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ name: "dev" | "verify" }>();

type Node = { x: number; y: number; w: number; kind: string; label: string };
type Diagram = { width: number; height: number; nodes: Node[]; edges: string[]; note: string; alt: string };

const DIAGRAMS: Record<"dev" | "verify", Diagram> = {
  dev: {
    width: 600,
    height: 152,
    nodes: [
      { x: 10, y: 16, w: 100, kind: "docker", label: "db" },
      { x: 150, y: 16, w: 100, kind: "run", label: "api" },
      { x: 290, y: 16, w: 110, kind: "wait", label: ":3000" },
      { x: 10, y: 96, w: 100, kind: "run", label: "web" },
      { x: 450, y: 56, w: 140, kind: "link", label: "localhost:5173" },
    ],
    edges: ["M110,36 H146", "M250,36 H286", "M400,36 C425,36 422,76 446,76", "M110,116 H400 C425,116 422,76 446,76"],
    note: "db and web start together · api waits for db · the page waits for both",
    alt: "The Dev pipeline: db and web start together; api waits for db; a wait for port 3000 waits for api; the page opens once both are done",
  },
  verify: {
    width: 340,
    height: 172,
    nodes: [
      { x: 10, y: 16, w: 100, kind: "run", label: "lint" },
      { x: 10, y: 66, w: 100, kind: "run", label: "types" },
      { x: 10, y: 116, w: 100, kind: "run", label: "test" },
      { x: 220, y: 66, w: 110, kind: "run", label: "build" },
    ],
    edges: ["M110,36 C165,36 160,86 216,86", "M110,86 H216", "M110,136 C165,136 160,86 216,86"],
    note: "lint, types and test start together · build waits for all three",
    alt: "The Verify pipeline: lint, types and test start together, and build waits for all three",
  },
};

const diagram = computed(() => DIAGRAMS[props.name]);
</script>

<template>
  <figure class="pipeline">
    <svg :viewBox="`0 0 ${diagram.width} ${diagram.height}`" :style="{ maxWidth: `${diagram.width}px` }" role="img" :aria-label="diagram.alt">
      <defs>
        <marker :id="`arrow-${name}`" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" class="arrow" />
        </marker>
      </defs>
      <path v-for="edge in diagram.edges" :key="edge" class="edge" :d="edge" :marker-end="`url(#arrow-${name})`" />
      <g v-for="node in diagram.nodes" :key="node.label">
        <rect class="node" :x="node.x" :y="node.y" :width="node.w" height="40" rx="9" />
        <text class="kind" :x="node.x + 12" :y="node.y + 15">{{ node.kind }}</text>
        <text class="label" :x="node.x + 12" :y="node.y + 32">{{ node.label }}</text>
      </g>
    </svg>
    <figcaption>{{ diagram.note }}</figcaption>
  </figure>
</template>

<style scoped>
.pipeline { margin: 20px 0; padding: 16px; border-radius: 14px; border: 1px solid var(--wisp-line); background: var(--wisp-terminal-bg); }
svg { display: block; width: 100%; height: auto; margin: 0 auto; }
.edge { fill: none; stroke: var(--wisp-dim); stroke-width: 1.5; }
.arrow { fill: var(--wisp-dim); }
.node { fill: var(--vp-c-bg-soft); stroke: var(--vp-c-brand-1); stroke-opacity: 0.55; }
.kind { fill: var(--wisp-dim); font-family: var(--vp-font-family-mono); font-size: 10px; }
.label { fill: var(--wisp-terminal-fg); font-family: var(--vp-font-family-mono); font-size: 13px; }
figcaption { margin-top: 10px; text-align: center; font-size: 13px; color: var(--vp-c-text-2); }
</style>
