/**
 * Colours for pipelines and workspaces, picked so each is told apart at a glance.
 *
 * A fixed set first — chosen to be readable on dark and light terminals alike, and far
 * enough apart that no two are confused — taken in random order, never one already in
 * use. Past the end of the set, a new hue as far from every colour in use as can be found.
 */
export const PALETTE = [
  "#a78bfa", // violet
  "#60a5fa", // blue
  "#34d399", // green
  "#f472b6", // pink
  "#fbbf24", // amber
  "#f87171", // red
  "#22d3ee", // cyan
  "#a3e635", // lime
  "#fb923c", // orange
  "#c084fc", // purple
  "#2dd4bf", // teal
  "#818cf8", // indigo
  "#e879f9", // fuchsia
  "#facc15", // yellow
  "#38bdf8", // sky
  "#4ade80", // emerald
];

/** A colour none of `used` already is. */
export function pickColor(used: (string | undefined)[], random: () => number = Math.random): string {
  const taken = new Set(used.filter((color): color is string => Boolean(color)).map((color) => color.toLowerCase()));
  const free = PALETTE.filter((color) => !taken.has(color));
  if (free.length > 0) return free[Math.floor(random() * free.length)] as string;

  // Every colour of the set is in use: the hue furthest from all of them.
  const hues = [...taken].map(hueOf).filter((hue): hue is number => hue !== undefined);
  let best = 0;
  let bestGap = -1;
  for (let candidate = 0; candidate < 360; candidate += 3) {
    const gap = Math.min(...hues.map((hue) => Math.min(Math.abs(hue - candidate), 360 - Math.abs(hue - candidate))));
    if (gap > bestGap) {
      bestGap = gap;
      best = candidate;
    }
  }
  const color = hslToHex(best, 0.75, 0.65);
  return taken.has(color) ? hslToHex((best + 7) % 360, 0.75, 0.6) : color;
}

/** Several colours at once, none repeating — for a file with many new pipelines. */
export function pickColors(count: number, used: (string | undefined)[] = [], random: () => number = Math.random): string[] {
  const picked: string[] = [];
  for (let at = 0; at < count; at += 1) picked.push(pickColor([...used, ...picked], random));
  return picked;
}

function hueOf(hex: string): number | undefined {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return undefined;
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => Number.parseInt(part as string, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return undefined;
  const delta = max - min;
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (hue * 60 + 360) % 360;
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - chroma / 2;
  const [r, g, b] =
    hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${[r, g, b].map((part) => Math.round((part + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}
