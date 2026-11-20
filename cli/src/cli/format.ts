import type { StepKind, Workspace } from "../core/types.js";

const enabled =
  process.env["FORCE_COLOR"] !== undefined ||
  (process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb" && process.stdout.isTTY);

function wrap(open: string, value: string): string {
  return enabled ? `\u001B[${open}m${value}\u001B[0m` : value;
}

export const bold = (value: string): string => wrap("1", value);
export const dim = (value: string): string => wrap("2", value);
export const red = (value: string): string => wrap("31", value);
export const green = (value: string): string => wrap("32", value);
export const yellow = (value: string): string => wrap("33", value);
export const cyan = (value: string): string => wrap("36", value);

/**
 * Paint text in a hex colour. Truecolor only where the terminal says it has it — a 256
 * colour terminal shown a 24-bit escape prints garbage, so plain text is the fallback.
 */
export function tint(value: string, color?: string): string {
  const rgb = color ? parseHex(color) : undefined;
  const truecolor = /truecolor|24bit/i.test(process.env["COLORTERM"] ?? "") || process.env["FORCE_COLOR"] === "3";
  if (!rgb || !enabled || !truecolor) return value;
  return `\u001B[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${value}\u001B[0m`;
}

export function parseHex(color: string): [number, number, number] | undefined {
  const hex = color.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((char) => char + char).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return undefined;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** `🏢 Acme` — icon plus name in the workspace colour. */
export function title(workspace: Workspace): string {
  const name = bold(tint(workspace.name, workspace.color));
  return workspace.icon ? `${workspace.icon} ${name}` : name;
}

export function counts(workspace: Workspace): string {
  return dim(workspace.bolts.length > 0 ? plural(workspace.bolts.length, "bolt") : "no bolts yet");
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function kindLabel(kind: StepKind): string {
  return {
    app: "app   ",
    command: "run   ",
    folder: "folder",
    file: "file  ",
    link: "link  ",
    wait: "wait  ",
    bolt: "needs ",
    compose: "docker",
  }[kind];
}

/** `3m`, `2h`, `5d` — how long ago, as briefly as it can be said. */
export function ago(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
