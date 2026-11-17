import { posixCommandLine } from "../core/shell.js";
import type { Invocation } from "../core/types.js";

/**
 * A terminal Wisp knows how to hand a command to.
 *
 * `args` builds what goes after the terminal's own program name — or after `open -na App
 * --args` on macOS, which is the same thing. Each terminal has its own way of being told
 * "run this": WezTerm wants `start --`, kitty takes the program bare, most want `-e`.
 */
export interface TerminalSpec {
  name: string;
  /** Other names it answers to: a macOS bundle id, a binary name. */
  aliases: string[];
  /** The binary on PATH, where it is launched as one. */
  binary?: string;
  args: (invocation: Invocation, title: string) => string[];
}

const argv = (invocation: Invocation): string[] => [invocation.file, ...invocation.args];

export const CROSS_PLATFORM_TERMINALS: TerminalSpec[] = [
  {
    name: "Ghostty",
    aliases: ["com.mitchellh.ghostty", "ghostty"],
    binary: "ghostty",
    args: (invocation, title) => [`--title=${title}`, "-e", ...argv(invocation)],
  },
  {
    name: "WezTerm",
    aliases: ["com.github.wez.wezterm", "wezterm"],
    binary: "wezterm",
    args: (invocation) => ["start", "--", ...argv(invocation)],
  },
  {
    name: "kitty",
    aliases: ["net.kovidgoyal.kitty"],
    binary: "kitty",
    args: (invocation, title) => ["--title", title, ...argv(invocation)],
  },
  {
    name: "Alacritty",
    aliases: ["org.alacritty", "alacritty"],
    binary: "alacritty",
    args: (invocation, title) => ["--title", title, "-e", ...argv(invocation)],
  },
];

export const LINUX_TERMINALS: TerminalSpec[] = [
  ...CROSS_PLATFORM_TERMINALS,
  {
    name: "foot",
    aliases: [],
    binary: "foot",
    args: (invocation, title) => ["--title", title, ...argv(invocation)],
  },
  {
    name: "GNOME Terminal",
    aliases: ["gnome-terminal", "gnome"],
    binary: "gnome-terminal",
    args: (invocation, title) => ["--title", title, "--", ...argv(invocation)],
  },
  {
    name: "Ptyxis",
    aliases: ["ptyxis"],
    binary: "ptyxis",
    args: (invocation) => ["--new-window", "--", ...argv(invocation)],
  },
  {
    name: "Konsole",
    aliases: ["konsole"],
    binary: "konsole",
    args: (invocation) => ["-e", ...argv(invocation)],
  },
  {
    name: "Xfce Terminal",
    aliases: ["xfce4-terminal", "xfce"],
    binary: "xfce4-terminal",
    args: (invocation, title) => ["--title", title, "-x", ...argv(invocation)],
  },
  {
    name: "Tilix",
    aliases: ["tilix"],
    binary: "tilix",
    // Tilix takes its command as a single string, not as separate arguments.
    args: (invocation, title) => ["--title", title, "-e", posixCommandLine(invocation)],
  },
  {
    name: "xterm",
    aliases: [],
    binary: "xterm",
    args: (invocation, title) => ["-T", title, "-e", ...argv(invocation)],
  },
  {
    // Debian's alternatives link: whatever the system says the terminal is.
    name: "x-terminal-emulator",
    aliases: [],
    binary: "x-terminal-emulator",
    args: (invocation) => ["-e", ...argv(invocation)],
  },
];

/** Multiplexers count as terminals everywhere they run: a new window is a new window. */
export const MULTIPLEXERS = ["tmux", "zellij"] as const;

/**
 * The terminal a reference means: its name, an alias, or — as everywhere in Wisp — a
 * prefix only one of them has. `ghost` is only ever Ghostty.
 */
export function findIn(specs: { name: string; aliases: string[] }[], ref: string): string | undefined {
  const needle = ref.trim().toLowerCase();
  if (!needle) return undefined;

  const exact = specs.find(
    (spec) => spec.name.toLowerCase() === needle || spec.aliases.some((alias) => alias.toLowerCase() === needle),
  );
  if (exact) return exact.name;

  const byPrefix = specs.filter((spec) => spec.name.toLowerCase().startsWith(needle));
  return byPrefix.length === 1 ? byPrefix[0]?.name : undefined;
}
