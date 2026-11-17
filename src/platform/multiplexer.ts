import { spawnSync } from "node:child_process";

import { posixCommandLine } from "../core/shell.js";
import type { Invocation } from "../core/types.js";
import { run } from "./spawn.js";

/** The tmux session commands go to when you are not already inside one. */
export const TMUX_SESSION = "specter";

export interface MultiplexerResult {
  /** Said when the window is somewhere you will have to go and look. */
  note?: string;
}

/**
 * The commands that put an invocation in a new tmux window.
 *
 * Inside tmux, a window in the current session — next to where you are, without switching
 * to it: a bolt that starts three commands must not leave you staring at the last one's
 * output, or pull the TUI out from under you. Outside tmux, a detached `specter` session
 * that collects every command, so on a server you can run a bolt, log out, and
 * `tmux attach -t specter` later to find it all still going.
 */
export function tmuxPlan(invocation: Invocation, title: string, inside: boolean, sessionExists: boolean): string[][] {
  const line = posixCommandLine(invocation);
  if (inside) return [["new-window", "-d", "-n", title, line]];
  if (!sessionExists) return [["new-session", "-d", "-s", TMUX_SESSION, "-n", title, line]];
  return [["new-window", "-d", "-t", `${TMUX_SESSION}:`, "-n", title, line]];
}

export async function runInTmux(invocation: Invocation, title: string, inside: boolean): Promise<MultiplexerResult> {
  const exists = inside ? true : spawnSync("tmux", ["has-session", "-t", TMUX_SESSION]).status === 0;
  for (const args of tmuxPlan(invocation, title, inside, exists)) await run("tmux", args);
  return inside
    ? { note: `in tmux window "${title}"` }
    : { note: `in tmux session "${TMUX_SESSION}" — tmux attach -t ${TMUX_SESSION}` };
}

/** `zellij run` opens a pane in the session you are in; there is no detached equivalent. */
export function zellijPlan(invocation: Invocation, title: string): string[] {
  return ["run", "--name", title, "--", invocation.file, ...invocation.args];
}

export async function runInZellij(invocation: Invocation, title: string, inside: boolean): Promise<MultiplexerResult> {
  if (!inside) throw new Error("zellij can only open a pane from inside a zellij session");
  await run("zellij", zellijPlan(invocation, title));
  return {};
}
