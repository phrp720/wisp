import { createInterface, emitKeypressEvents, type Interface } from "node:readline";

import { WispError } from "../core/errors.js";
import { bold, cyan, dim, green } from "./format.js";

const inverse = (text: string) => `\u001B[7m${text}\u001B[27m`;

/**
 * Thin wrapper over readline so commands stay free of prompt plumbing.
 *
 * Lines are queued rather than read with `rl.question`: when stdin is a pipe,
 * readline emits every buffered line in one burst, and anything arriving while
 * no question is pending would otherwise be dropped.
 */
export class Prompter {
  private readonly rl: Interface;
  private readonly buffered: string[] = [];
  private waiting: ((line: string | undefined) => void) | undefined;
  private ended = false;

  constructor() {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
    });

    this.rl.on("line", (line) => this.deliver(line));
    // Ctrl+C at a question means "never mind": without this, readline swallows it and the
    // question just sits there.
    this.rl.on("SIGINT", () => {
      process.stdout.write("\n");
      this.rl.close();
    });
    this.rl.on("close", () => {
      this.ended = true;
      this.deliver(undefined);
    });
  }

  async ask(question: string, defaultValue = ""): Promise<string> {
    const suffix = defaultValue ? dim(` (${defaultValue})`) : "";
    this.rl.setPrompt(`${question}${suffix}: `);
    this.rl.prompt();

    const line = await this.nextLine();
    if (line === undefined) throw new WispError("Cancelled. Nothing changed", "CANCELLED");

    return line.trim() || defaultValue;
  }

  /** Like {@link ask}, but an explicit `-` clears the existing value. */
  async askOptional(question: string, defaultValue = ""): Promise<string> {
    const answer = await this.ask(question, defaultValue);
    return answer === "-" ? "" : answer;
  }

  async confirm(question: string, defaultValue = false): Promise<boolean> {
    const hint = defaultValue ? "Y/n" : "y/N";
    this.rl.setPrompt(`${question} ${dim(`[${hint}]`)}: `);
    this.rl.prompt();

    const line = await this.nextLine();
    // Ctrl+C or no more input is "never mind", not the default: a default of yes would go
    // ahead on the very key meant to stop it.
    if (line === undefined) throw new WispError("Cancelled. Nothing changed", "CANCELLED");
    const answer = line.trim().toLowerCase();
    return answer ? answer.startsWith("y") : defaultValue;
  }

  close(): void {
    this.rl.close();
  }

  private deliver(line: string | undefined): void {
    const resolve = this.waiting;
    if (resolve) {
      this.waiting = undefined;
      resolve(line);
      return;
    }
    if (line !== undefined) this.buffered.push(line);
  }

  private nextLine(): Promise<string | undefined> {
    const queued = this.buffered.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

/** One line of a {@link checklist}: the name, and a few words on what it is. */
export interface ChecklistItem {
  label: string;
  /** Shown after the name, like "job". */
  tag?: string;
  /** What it does, in grey, cut to fit the line. */
  hint?: string;
}

/**
 * Pick several of a list, in place, the way `npm create` asks: ↑↓ move, space ticks, a
 * ticks all, n none, ⏎ confirms (none ticked is a fine answer), esc or Ctrl+C cancels.
 * Everything starts ticked; the current row is highlighted. Each line is kept within the
 * terminal's width, so redrawing in place stays exact. Resolves with the labels kept, or
 * nothing when cancelled. Needs a terminal.
 */
export async function checklist(question: string, items: ChecklistItem[]): Promise<string[] | undefined> {
  const { stdin, stdout } = process;
  const width = Math.max(40, stdout.columns || 80);
  const fit = (text: string, room: number) => (text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`);
  const names = items.map((item) => (item.tag ? `${item.label}  ${item.tag}` : item.label));
  const nameWidth = Math.min(Math.max(...names.map((name) => name.length)), Math.floor(width / 2));
  const keys = "↑↓ move · space ticks · a all · n none · ⏎ write · esc cancel";

  let at = 0;
  const on = items.map(() => true);
  let drawn = 0;
  const draw = () => {
    if (drawn > 0) stdout.write(`\u001B[${drawn}A\r\u001B[0J`);
    const lines = [`${cyan("?")} ${bold(fit(question, width - 2))}`];
    items.forEach((item, index) => {
      const name = fit(names[index] as string, nameWidth).padEnd(nameWidth);
      const room = width - nameWidth - 6;
      const hint = item.hint && room > 8 ? `  ${dim(fit(item.hint, room))}` : "";
      const box = on[index] ? green("◉") : dim("◯");
      // The row you're on is highlighted, as in the dashboard; the box says ticked or not.
      const shown = index === at ? inverse(` ${name} `) : ` ${on[index] ? name : dim(name)} `;
      lines.push(`${box}${shown}${hint}`);
    });
    const count = on.filter(Boolean).length;
    lines.push(dim(fit(count === 0 ? "none ticked: ⏎ writes the file with no bolts · esc cancel" : keys, width)));
    stdout.write(`${lines.join("\n")}\n`);
    drawn = lines.length;
  };

  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdout.write("\u001B[?25l");
  draw();

  const chosen = await new Promise<string[] | undefined>((resolve) => {
    const onKey = (input: string | undefined, key: { name?: string; ctrl?: boolean } = {}) => {
      if (key.ctrl && key.name === "c") return finish(undefined);
      if (key.name === "escape" || input === "q") return finish(undefined);
      if (key.name === "up" || input === "k") at = Math.max(0, at - 1);
      else if (key.name === "down" || input === "j") at = Math.min(items.length - 1, at + 1);
      else if (key.name === "space" || input === " ") on[at] = !on[at];
      else if (input === "a") on.fill(true);
      else if (input === "n") on.fill(false);
      else if (key.name === "return") return finish(items.filter((_, index) => on[index]).map((item) => item.label));
      else return;
      draw();
    };
    const finish = (result: string[] | undefined) => {
      stdin.off("keypress", onKey);
      resolve(result);
    };
    stdin.on("keypress", onKey);
  });

  // The list folds away into one line that says what was chosen.
  stdout.write(`\u001B[${drawn}A\r\u001B[0J`);
  stdout.write(chosen ? `${green("✓")} ${bold(question)} ${dim(chosen.length > 0 ? chosen.join(", ") : "none")}\n` : `${dim("✗")} ${dim(question)} ${dim("cancelled")}\n`);
  stdout.write("\u001B[?25h");
  stdin.setRawMode?.(wasRaw ?? false);
  stdin.pause();
  return chosen;
}
