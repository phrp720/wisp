import { createInterface, type Interface } from "node:readline";

import { WispError } from "../core/errors.js";
import { dim } from "./format.js";

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
    const answer = (line ?? "").trim().toLowerCase();
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
