/**
 * A little light while you wait: a few words that change every couple of seconds wherever the
 * TUI is busy (loading, a run starting), always next to what is really happening, never
 * instead of it.
 *
 * All of them are the will-o'-the-wisp's: the light over the marsh that leads the way. Its
 * lantern, the fens and moors it is seen on, and the names the old stories give it, which are
 * public domain: ignis fatuus ("foolish fire"), Jack-o'-lantern, the hinkypunk of Somerset,
 * Joan-in-the-wad of Cornwall, the Scots spunkie. A wisp itself is a twist of straw, lit as a
 * torch: Will with his wisp.
 */
export const SPELLS = [
  "Lighting the wisp",
  "Raising the lantern",
  "Leading the way",
  "Flickering",
  "Over the marsh",
  "Through the mist",
  "Kindling the wisp",
  "Crossing the fen",
  "Glimmering",
  "Lighting the path",
  "Through the reeds",
  "Hovering low",
  "Ignis fatuus",
  "Trimming the wick",
  "Out on the moor",
  "Following the glow",
  "Fairy fire",
  "Twisting the straw",
  "Dancing on the bog",
  "Waking the marsh",
  "A light ahead",
  "Asking the hinkypunk",
  "Jack and his lantern",
  "Joan-in-the-wad",
  "Calling the spunkie",
  "A faint blue glow",
  "Lights on the water",
  "Past the willows",
  "Tending the flame",
  "Mist rising",
  "A lantern in the dark",
  "Following the light",
] as const;

/**
 * The words for now: they change every 2.5 seconds, and `seed` keeps two places from showing
 * the same ones. `max`: only words that fit in that many characters, for a narrow place (the
 * shortest when none does), so they are never cut off.
 */
export function spell(seed = 0, now = Date.now(), max = Infinity): string {
  const fitting = SPELLS.filter((words) => words.length <= max);
  const list = fitting.length > 0 ? fitting : [SPELLS.reduce((shortest, words) => (words.length < shortest.length ? words : shortest))];
  const at = Math.floor(now / 2500) + seed;
  return list[((at % list.length) + list.length) % list.length] as string;
}
