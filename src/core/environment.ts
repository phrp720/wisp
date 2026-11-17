import { currentOS } from "./paths.js";
import type { OS } from "./types.js";

/** What Wisp can reach from where it is running. */
export interface Environment {
  os: OS;
  /** There is a display to open windows on. */
  gui: boolean;
  /** Reached over SSH: anything Wisp opens would open on the other machine, or nowhere. */
  ssh: boolean;
  /** Running inside a terminal multiplexer, which can take a command as a new window. */
  multiplexer?: "tmux" | "zellij";
}

/**
 * Work out what this session can do.
 *
 * Over SSH a browser or editor opened by Wisp appears on the server, not in front of
 * you, so that counts as no display even on a Mac. On Linux a display is an X or Wayland
 * session; a bare console or a container has neither. `WISP_HEADLESS` settles it either
 * way, for the cases detection gets wrong.
 */
export function detectEnvironment(env: NodeJS.ProcessEnv = process.env, os: OS = currentOS()): Environment {
  const ssh = Boolean(env["SSH_CONNECTION"] || env["SSH_TTY"] || env["SSH_CLIENT"]);

  let gui: boolean;
  if (os === "linux") gui = Boolean(env["DISPLAY"] || env["WAYLAND_DISPLAY"]) && !ssh;
  else gui = !ssh;

  const forced = env["WISP_HEADLESS"]?.trim().toLowerCase();
  if (forced === "1" || forced === "true") gui = false;
  if (forced === "0" || forced === "false") gui = true;

  const multiplexer = env["TMUX"] ? "tmux" : env["ZELLIJ"] !== undefined ? "zellij" : undefined;

  return { os, gui, ssh, ...(multiplexer ? { multiplexer } : {}) };
}
