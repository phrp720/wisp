/**
 * The symbols the TUI draws with, and a plain fallback.
 *
 * Like btop's TTY mode: a Linux console, an old Windows console or a non-UTF-8 locale
 * shows `?` boxes for anything outside ASCII, so those get the plain set.
 */
export interface Glyphs {
  pointer: string;
  ok: string;
  fail: string;
  skip: string;
  pending: string;
  running: string[];
  dot: string;
  here: string;
  arrow: string;
  /** Before each bolt's name: what you run. Empty where emoji would show as boxes. */
  bolt: string;
  border: "round" | "classic";
}

const UNICODE: Glyphs = {
  pointer: "❯",
  ok: "✓",
  fail: "✗",
  skip: "–",
  pending: "·",
  running: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  dot: "●",
  here: "●",
  arrow: "›",
  bolt: "⚡ ",
  border: "round",
};

const ASCII: Glyphs = {
  pointer: ">",
  ok: "+",
  fail: "x",
  skip: "-",
  pending: ".",
  running: ["|", "/", "-", "\\"],
  dot: "*",
  here: "*",
  arrow: ">",
  bolt: "",
  border: "classic",
};

export function supportsUnicode(env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  if (env["WISP_ASCII"]) return false;
  if (platform === "win32") return Boolean(env["WT_SESSION"] || env["TERM_PROGRAM"]);
  if (env["TERM"] === "linux") return false;
  return /utf-?8/i.test(env["LC_ALL"] || env["LC_CTYPE"] || env["LANG"] || "");
}

export function glyphs(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Glyphs {
  return supportsUnicode(env, platform) ? UNICODE : ASCII;
}
