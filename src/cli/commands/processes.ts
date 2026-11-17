import { createReadStream } from "node:fs";

import { SpecterError } from "../../core/errors.js";
import { tildify } from "../../core/paths.js";
import {
  clearFinishedRuns,
  listRuns,
  logSize,
  matchRun,
  stopRun,
  tail,
  type RunStatus,
} from "../../core/processes.js";
import { ago, bold, dim, green, plural, yellow } from "../format.js";
import { emitJson } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";

export const ps: CommandDef<{ all?: boolean; clear?: boolean; json?: boolean }> = {
  name: "ps",
  summary: "List the commands Specter is running in the background",
  options: [
    ["-a, --all", "include ones that have finished"],
    ["--clear", "forget finished ones and delete their logs"],
    ["--json", "print them as JSON"],
  ],
  examples: ["specter ps", "specter ps --all", "specter logs <id>", "specter stop <id>"],

  async run(_args, options) {
    if (options.clear) {
      const count = await clearFinishedRuns();
      console.log(dim(`Cleared ${plural(count, "finished run")}.`));
      return;
    }

    const runs = await listRuns();
    const shown = options.all ? runs : runs.filter((run) => run.alive);
    if (options.json) return emitJson(shown);

    if (shown.length === 0) {
      const finished = runs.length - runs.filter((run) => run.alive).length;
      console.log(dim(finished > 0 ? `Nothing running. ${plural(finished, "finished run")} — \`specter ps --all\`` : "Nothing running."));
      return;
    }

    // A table, as a process manager shows one: what it is, how it is, for how long.
    const { tail: readTail } = await import("../../core/processes.js");
    const rows = await Promise.all(
      shown.map(async (run) => {
        const restarts = run.log ? ((await readTail(run.log, 2000)).match(/\[specter\] restarting/g)?.length ?? 0) : 0;
        return [
          run.alive ? green("● running") : dim("○ stopped"),
          bold(run.id),
          run.label,
          run.workspaceName,
          run.alive ? ago(run.startedAt) : "",
          restarts > 0 ? yellow(`${restarts}×`) : dim("–"),
          run.kind === "window" ? dim(run.where ?? "window") : dim("background"),
        ];
      }),
    );
    printTable(["STATUS", "ID", "NAME", "WORKSPACE", "UP", "RESTARTS", "WHERE"], rows);
    console.log(dim(`\n\`specter logs <name> -f\` follows one · \`specter stop <name>\` stops it`));
  },
};

/** Columns padded to their widest cell, measured without colour codes. */
function printTable(headings: string[], rows: string[][]): void {
  const visible = (text: string) => text.replace(/\u001B\[[0-9;]*m/g, "").length;
  const widths = headings.map((heading, at) => Math.max(heading.length, ...rows.map((row) => visible(row[at] ?? ""))));
  const line = (cells: string[]) => cells.map((cell, at) => cell + " ".repeat((widths[at] ?? 0) - visible(cell))).join("  ").trimEnd();
  console.log(dim(line(headings)));
  for (const row of rows) console.log(line(row));
}

export const logs: CommandDef<{ follow?: boolean; lines?: string }> = {
  name: "logs",
  summary: "Show what a background command has printed",
  args: [["[run]", "its id or name; omitted means the one running, if there is one"]],
  options: [
    ["-f, --follow", "keep printing as it writes"],
    ["-n, --lines <count>", "how many lines from the end", "100"],
  ],
  examples: ["specter logs", "specter logs dev -f", "specter logs 3fa9"],

  async run([query], options) {
    const run = pick(query, await listRuns());
    const lines = Number.parseInt(options.lines ?? "100", 10) || 100;

    // A command in a window prints to its window; Specter never sees that output.
    if (!run.log) {
      console.log(dim(`${run.label} runs in ${run.where ?? "a terminal window"} — its output is there.`));
      return;
    }
    const log = run.log;

    // macOS's `script` opens a log with an echoed ^D and two backspaces; not output.
    process.stdout.write((await tail(log, lines)).replace(/^\^D\u0008\u0008/, ""));
    if (!options.follow) return;

    // Polled rather than watched: `fs.watch` is unreliable across filesystems, and twice a
    // second is all a log needs.
    let offset = await logSize(log);
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const size = await logSize(log);
      if (size > offset) {
        await new Promise<void>((resolve, reject) => {
          createReadStream(log, { start: offset, end: size - 1 })
            .on("data", (chunk) => process.stdout.write(chunk))
            .on("end", resolve)
            .on("error", reject);
        });
        offset = size;
      }
    }
  },
};

export const stop: CommandDef<{ all?: boolean }> = {
  name: "stop",
  summary: "Stop a background command, and everything it started",
  args: [["[run]", "its id or name"]],
  options: [["-a, --all", "stop every one that is running"]],
  examples: ["specter stop dev", "specter stop --all"],

  async run([query], options) {
    const running = (await listRuns()).filter((run) => run.alive);
    const targets = options.all ? running : [pick(query, running)];

    if (targets.length === 0) {
      console.log(dim("Nothing running."));
      return;
    }
    for (const run of targets) {
      const stopped = stopRun(run);
      console.log(stopped ? `${green("✓")} stopped ${bold(run.id)} ${run.label}` : dim(`${run.id} ${run.label} had already stopped`));
    }
  },
};

/** The run a command means: the one named, or — when only one is running — that one. */
function pick(query: string | undefined, runs: RunStatus[]): RunStatus {
  if (!query) {
    const alive = runs.filter((run) => run.alive);
    if (alive.length === 1) return alive[0] as RunStatus;
    if (runs.length === 0) throw new SpecterError("Specter has not run anything in the background", "NOT_FOUND");
    throw new SpecterError(
      alive.length === 0 ? "Nothing is running — name a finished run, from `specter ps --all`" : `${plural(alive.length, "command")} running — name one: ${alive.map((run) => `${run.id} (${run.label})`).join(", ")}`,
      "AMBIGUOUS",
    );
  }

  const { match, candidates } = matchRun(query, runs);
  if (match) return match;
  if (candidates.length > 1) {
    throw new SpecterError(`"${query}" matches several: ${candidates.map((run) => `${run.id} (${run.label})`).join(", ")}`, "AMBIGUOUS");
  }
  throw new SpecterError(`No run called "${query}" — see \`specter ps --all\``, "NOT_FOUND");
}
