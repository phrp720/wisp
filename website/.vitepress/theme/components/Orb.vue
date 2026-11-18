<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

/**
 * Wisp's crystal ball in the hero. The ball, its base and the flame stay still; the fire's
 * glow follows the mouse: inside the glass it drifts toward the cursor, and the soft light
 * behind the ball moves with it, both brightening as the cursor comes closer.
 * Still for people who ask for less motion. The same drawing as public/logo.svg.
 */
const root = ref<HTMLElement>();
const pointer = ref({ x: 0, y: 0, near: 0 });
let frame = 0;

function onMove(event: PointerEvent) {
  if (!root.value) return;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const box = root.value!.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    const distance = Math.hypot(dx, dy);
    // Which way the cursor is, at most 1 either way; how near, from 1 on the ball to 0 far off.
    const reach = Math.min(distance, 420) / 420;
    pointer.value = {
      x: distance ? (dx / distance) * reach : 0,
      y: distance ? (dy / distance) * reach : 0,
      near: Math.max(0, 1 - distance / 650),
    };
  });
}

onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  window.addEventListener("pointermove", onMove, { passive: true });
});
onBeforeUnmount(() => {
  window.removeEventListener("pointermove", onMove);
  cancelAnimationFrame(frame);
});
</script>

<template>
  <div ref="root" class="orb" :style="{ '--mx': pointer.x, '--my': pointer.y, '--near': pointer.near }" aria-hidden="true">
    <div class="glow" />
    <svg class="ball" viewBox="0 0 128 128">
      <defs>
        <radialGradient id="o-glass" cx="50%" cy="38%" r="70%">
          <stop offset="0" stop-color="#5b21b6" />
          <stop offset="0.55" stop-color="#2e1065" />
          <stop offset="1" stop-color="#14062e" />
        </radialGradient>
        <radialGradient id="o-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0" stop-color="#f5d0fe" stop-opacity="0.9" />
          <stop offset="0.35" stop-color="#e879f9" stop-opacity="0.55" />
          <stop offset="1" stop-color="#c026d3" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="o-flame" x1="0.5" y1="1" x2="0.5" y2="0">
          <stop offset="0" stop-color="#8b5cf6" />
          <stop offset="0.5" stop-color="#d946ef" />
          <stop offset="1" stop-color="#fbcfe8" />
        </linearGradient>
        <linearGradient id="o-core" x1="0.5" y1="1" x2="0.5" y2="0">
          <stop offset="0" stop-color="#f5d0fe" />
          <stop offset="1" stop-color="#ffffff" />
        </linearGradient>
        <linearGradient id="o-rim" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#e9d5ff" stop-opacity="0.7" />
          <stop offset="0.5" stop-color="#a78bfa" stop-opacity="0.12" />
          <stop offset="1" stop-color="#c4b5fd" stop-opacity="0.45" />
        </linearGradient>
        <linearGradient id="o-metal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#78350f" />
          <stop offset="0.18" stop-color="#d97706" />
          <stop offset="0.4" stop-color="#fde68a" />
          <stop offset="0.5" stop-color="#fef3c7" />
          <stop offset="0.66" stop-color="#f59e0b" />
          <stop offset="0.86" stop-color="#92400e" />
          <stop offset="1" stop-color="#78350f" />
        </linearGradient>
        <linearGradient id="o-shade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#451a03" stop-opacity="0" />
          <stop offset="1" stop-color="#451a03" stop-opacity="0.5" />
        </linearGradient>
        <radialGradient id="o-top" cx="50%" cy="40%" r="60%">
          <stop offset="0" stop-color="#fffbeb" />
          <stop offset="0.55" stop-color="#fbbf24" />
          <stop offset="1" stop-color="#b45309" />
        </radialGradient>
        <radialGradient id="o-cast" cx="50%" cy="50%" r="50%">
          <stop offset="0" stop-color="#f0abfc" stop-opacity="0.85" />
          <stop offset="1" stop-color="#f0abfc" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="o-ground" cx="50%" cy="50%" r="50%">
          <stop offset="0" stop-color="#000000" stop-opacity="0.55" />
          <stop offset="1" stop-color="#000000" stop-opacity="0" />
        </radialGradient>
        <clipPath id="o-inside">
          <circle cx="64" cy="54" r="44" />
        </clipPath>
      </defs>
      <ellipse cx="64" cy="122.5" rx="38" ry="3" fill="url(#o-ground)" />
      <path d="M38 103 L90 103 L97 116 Q64 123 31 116 Z" fill="url(#o-metal)" />
      <path d="M38 103 L90 103 L97 116 Q64 123 31 116 Z" fill="url(#o-shade)" />
      <path d="M31 116 Q64 123 97 116" fill="none" stroke="#451a03" stroke-opacity="0.55" stroke-width="1" />
      <ellipse cx="64" cy="103" rx="26" ry="4.5" fill="url(#o-top)" />
      <ellipse cx="64" cy="103" rx="26" ry="4.5" fill="none" stroke="#fef3c7" stroke-opacity="0.75" stroke-width="0.8" />
      <ellipse cx="64" cy="103" rx="18" ry="3.2" fill="url(#o-cast)" />
      <g transform="translate(64 60) scale(0.92) translate(-64 -54)">
        <circle cx="64" cy="54" r="45" fill="url(#o-glass)" />
        <g clip-path="url(#o-inside)">
          <!-- The fire's glow: the only part that moves, toward the cursor. -->
          <circle class="fireglow" cx="64" cy="62" r="30" fill="url(#o-glow)" />
          <g>
            <path d="M64 22 C70 36 84 46 83 66 C82 80 74 88 64 88 C54 88 46 80 46.5 69 C47 58 54.5 53 57.5 43 C59 50 61.5 53.5 63.5 55 C62 45 60.5 33 64 22 Z" fill="url(#o-flame)" />
            <path d="M63.5 55 C69 61 73 67.5 72 76 C71 82.5 67.5 85 63.5 85 C59 85 56 81 56.5 75.5 C57 69 61 65 63.5 55 Z" fill="url(#o-core)" />
          </g>
        </g>
        <circle cx="64" cy="54" r="44.25" fill="none" stroke="url(#o-rim)" stroke-width="1.5" />
        <path d="M33 37 A36 36 0 0 1 55 17" fill="none" stroke="#ffffff" stroke-opacity="0.4" stroke-width="3.5" stroke-linecap="round" />
        <circle cx="88" cy="30" r="2" fill="#f5d0fe" />
        <circle cx="40" cy="62" r="1.5" fill="#f5d0fe" />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.orb {
  --mx: 0;
  --my: 0;
  --near: 0;
  position: relative;
  display: grid;
  place-items: center;
  width: 280px;
  height: 280px;
  margin: 0 auto;
}
@media (min-width: 960px) {
  .orb { width: 340px; height: 340px; }
}
/* The light behind the ball: it drifts toward the cursor and brightens as it nears. */
.glow {
  position: absolute;
  width: 70%;
  height: 70%;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(217, 70, 239, 0.7) 0%, rgba(139, 92, 246, 0.4) 40%, transparent 72%);
  filter: blur(42px);
  opacity: calc(0.45 + var(--near) * 0.55);
  transform: translate(calc(var(--mx) * 40px), calc(var(--my) * 40px));
  transition: transform 0.5s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.5s ease;
}
.ball {
  position: relative;
  width: 220px;
  height: 220px;
  overflow: visible;
}
@media (min-width: 960px) {
  .ball { width: 260px; height: 260px; }
}
/* The fire's glow inside the glass: it drifts toward the cursor and brightens as it nears. */
.fireglow {
  transform-box: view-box;
  transform-origin: 64px 60px;
  transform: translate(calc(var(--mx) * 26px), calc(var(--my) * 24px)) scale(calc(0.9 + var(--near) * 0.35));
  opacity: calc(0.65 + var(--near) * 0.35);
  transition: transform 0.45s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.45s ease;
}
</style>
