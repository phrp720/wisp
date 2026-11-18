/**
 * A little magic while you wait: a word that changes every couple of seconds wherever the TUI
 * is busy (loading, a run starting), always next to what is really happening, never instead
 * of it. Wisp is a will-o'-the-wisp, after all. Our own words, and the old public-domain ones.
 */
export const SPELLS = [
  "Conjuring",
  "Summoning",
  "Lighting the wisp",
  "Casting",
  "Brewing",
  "Scrying",
  "Weaving",
  "Enchanting",
  "Hocus pocus",
  "Abracadabra",
  "Following the light",
  "Gathering sparks",
  "Stirring the cauldron",
  "Waving the wand",
  "Whispering to the servers",
  "Shimmering",
] as const;

/** The word for now: it changes every 2.5 seconds, and `seed` keeps two places from showing the same one. */
export function spell(seed = 0, now = Date.now()): string {
  const at = Math.floor(now / 2500) + seed;
  return SPELLS[((at % SPELLS.length) + SPELLS.length) % SPELLS.length] as string;
}
