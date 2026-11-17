import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { WispError } from "../../core/errors.js";
import { getHistory, listHistory, type HistoryEntry } from "../../core/history.js";
import { tildify } from "../../core/paths.js";
import { downBolt, resolveBolt, switchToWorkspace } from "../../core/switch.js";
import type { Bolt, WorkspaceRead } from "../../core/types.js";
import { ago, bold, dim, green, kindLabel, plural, red, title, yellow } from "../format.js";
import { emitJson, findWorkspaceForDependency, maybeProject, resolveRun } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";
import { named, resultLine } from "../lib/render.js";

/** The bolt a lifecycle command means, by the same rules as running one. */
async function target(first: string | undefined, second: string | undefined): Promise<{ read: WorkspaceRead; bolt: Bolt }> {
  const { read, bolt } = await resolveRun(first, second, undefined);
  if (!bolt) throw new WispError("Name the bolt: `wisp down api`", "NO_BOLT");
  return { read, bolt: resolveBolt(read.workspace, bolt) };
}

export const down: CommandDef<{ deps?: boolean; dryRun?: boolean; json?: boolean }> = {
  name: "down",
  summary: "Stop what a bolt started, then run its `down` steps",
  args: [
    ["[workspace]", "workspace name or file; omitted uses this directory's project"],
    ["[bolt]", "which bolt"],
  ],
  options: [
    ["--deps", "take the bolts it depends on down too"],
    ["-n, --dry-run", "show what would stop, and stop nothing"],
    ["--json", "print the result as JSON"],
  ],
  examples: ["wisp down api", "wisp down api --deps   # the database too"],

  async run([first, second], options) {
    const { read, bolt } = await target(first, second);
    const result = await downBolt(
      read.workspace,
      bolt,
      { deps: options.deps ?? false, dryRun: options.dryRun ?? false, echo: !options.json },
      { findWorkspace: findWorkspaceForDependency },
    );

    if (options.json) {
      return emitJson({ stopped: result.stopped.map((run) => ({ id: run.id, label: run.label })), teardown: result.teardown?.targets ?? [] });
    }

    console.log(`${options.dryRun ? yellow("dry run") : green("down")} ${title(read.workspace)} ${dim("·")} ${bold(bolt.label)}`);
    if (result.stopped.length === 0 && !result.teardown) console.log(dim("  nothing of it was running"));
    for (const run of result.stopped) console.log(`  ${green("■")} ${dim("stop  ")} ${run.label} ${dim(`(${run.id})`)}`);
    for (const step of result.teardown?.targets ?? []) console.log(resultLine(step));
    if (result.teardown && !result.teardown.ok) process.exitCode = 1;
  },
};

export const restart: CommandDef<{ deps?: boolean }> = {
  name: "restart",
  summary: "Take a bolt down and run it again",
  args: [
    ["[workspace]", "workspace name or file; omitted uses this directory's project"],
    ["[bolt]", "which bolt"],
  ],
  options: [["--deps", "restart the bolts it depends on too"]],
  examples: ["wisp restart api"],

  async run([first, second], options) {
    const { read, bolt } = await target(first, second);
    const find = { findWorkspace: findWorkspaceForDependency };
    const stopped = await downBolt(read.workspace, bolt, { deps: options.deps ?? false, echo: true }, find);
    console.log(`${green("down")} ${title(read.workspace)} ${dim("·")} ${bold(bolt.label)} ${dim(`— ${plural(stopped.stopped.length, "command")} stopped`)}`);

    // Give stopped servers a moment to let go of their ports.
    if (stopped.stopped.length > 0) await new Promise((done) => setTimeout(done, 500));

    console.log(`${green("running")} ${title(read.workspace)} ${dim("·")} ${bold(bolt.label)}`);
    const result = await switchToWorkspace(read.workspace, { bolt: bolt.id, echo: true, onResult: (step) => console.log(resultLine(step)) }, find);
    if (!result.ok) process.exitCode = 1;
  },
};

export const history: CommandDef<{ all?: boolean; log?: string; json?: boolean }> = {
  name: "history",
  summary: "Past runs: what ran, how long it took, what passed — and what each step printed",
  args: [["[run]", "a run's id for its details, or a bolt name to list its runs"]],
  options: [
    ["-a, --all", "every workspace, not only this directory's project"],
    ["--log <step>", "print what one step printed (its number in the details)"],
    ["--json", "print it as JSON"],
  ],
  examples: ["wisp history", "wisp history check", "wisp history 3f2a1b", "wisp history 3f2a1b --log 2"],

  async run([query], options) {
    const entry = query ? await getHistory(query) : undefined;
    if (entry) return showEntry(entry, options);

    const here = options.all ? undefined : await maybeProject();
    const entries = await listHistory({ ...(here ? { workspace: here.workspace.file } : {}), ...(query ? { bolt: query } : {}) });
    if (options.json) return emitJson(entries);

    if (entries.length === 0) {
      console.log(dim(query ? `No runs of "${query}" yet.` : "Nothing has run yet."));
      return;
    }
    for (const run of entries.slice(0, 30)) {
      const mark = run.ok ? green("✓") : red("✗");
      const where = here ? "" : dim(` · ${run.workspaceName}`);
      const tag = run.job ? dim(" job") : "";
      const context = [TRIGGERS[run.trigger ?? ""], run.git ? `${run.git.branch} @ ${run.git.commit}` : ""].filter(Boolean).join(" · ");
      const number = run.number ? dim(` #${run.number}`) : "";
      console.log(`${mark} ${bold(run.id)}  ${run.bolt}${number}${tag}${where} ${dim(`· ${ago(run.startedAt)} ago · ${duration(run)}${context ? ` · ${context}` : ""}`)}`);
    }
    if (entries.length > 30) console.log(dim(`… ${entries.length - 30} older`));
  },
};

async function showEntry(entry: HistoryEntry, options: { log?: string; json?: boolean }): Promise<void> {
  if (options.log !== undefined) {
    const step = entry.steps[Number.parseInt(options.log, 10) - 1];
    if (!step) throw new WispError(`Run ${entry.id} has no step ${options.log}`, "NOT_FOUND");
    if (!step.log) throw new WispError(`Step ${options.log} kept no output — it ran in its own window`, "NOT_FOUND");
    process.stdout.write(await readFile(step.log, "utf8").catch(() => ""));
    return;
  }
  if (options.json) return emitJson(entry);

  const mark = entry.ok ? green("passed") : red("failed");
  const context = [TRIGGERS[entry.trigger ?? ""] ? `from ${TRIGGERS[entry.trigger ?? ""]}` : "", entry.git ? `${entry.git.branch} @ ${entry.git.commit}` : ""].filter(Boolean).join(" · ");
  console.log(`${mark} ${bold(entry.bolt)} ${dim(`· ${entry.workspaceName} · ${new Date(entry.startedAt).toLocaleString()} · ${duration(entry)}${context ? ` · ${context}` : ""}`)}`);
  entry.steps.forEach((step, index) => {
    const markStep = !step.ok ? (step.skipped ? dim("–") : red("✗")) : step.skipped ? dim("–") : green("✓");
    const time = step.durationMs >= 1000 ? dim(` ${(step.durationMs / 1000).toFixed(1)}s`) : "";
    const detail = step.error ? ` ${red(step.error)}` : step.note ? ` ${dim(step.note)}` : "";
    const log = step.log ? dim(`  [--log ${index + 1}]`) : "";
    console.log(`  ${dim(String(index + 1).padStart(2))} ${markStep} ${dim(kindLabel(step.kind))} ${named(step.label, step.value)}${time}${detail}${log}`);
  });
}

const TRIGGERS: Record<string, string> = { tui: "the TUI", cli: "the command line", hook: "a git hook", retry: "a retry" };

function duration(entry: HistoryEntry): string {
  const ms = Math.max(0, Date.parse(entry.finishedAt) - Date.parse(entry.startedAt));
  if (ms < 1000) return `${ms}ms`;
  return ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

/** Hooks git runs where checking first makes sense. */
const HOOKS = ["pre-commit", "pre-push", "commit-msg", "post-merge", "post-checkout"];

const MARKER = "# Added by wisp";

export const hook: CommandDef<{ remove?: boolean; list?: boolean; force?: boolean }> = {
  name: "hook",
  summary: "Run a bolt from a git hook — a job before every push, say",
  args: [
    ["[hook]", `which hook: ${HOOKS.join(", ")}`],
    ["[bolt]", "the bolt it runs"],
  ],
  options: [
    ["--list", "show the hooks Wisp has installed here"],
    ["--remove", "take a hook back out"],
    ["-f, --force", "replace a hook that Wisp did not write"],
  ],
  examples: ["wisp hook pre-push check", "wisp hook --list", "wisp hook pre-push --remove"],

  async run([name, boltRef], options) {
    const dir = hooksDir();

    if (options.list || !name) {
      const files = await readdir(dir).catch(() => []);
      let found = 0;
      for (const file of files) {
        const text = await readFile(join(dir, file), "utf8").catch(() => "");
        if (!text.includes(MARKER)) continue;
        found += 1;
        const bolt = /wisp use '[^']*' '([^']*)'/.exec(text)?.[1] ?? "?";
        console.log(`  ${bold(file)} ${dim("→")} ${bolt}`);
      }
      if (found === 0) console.log(dim("No Wisp hooks here. `wisp hook pre-push check` adds one."));
      return;
    }

    if (!HOOKS.includes(name)) throw new WispError(`"${name}" is not a hook Wisp installs — ${HOOKS.join(", ")}`, "INVALID_INPUT");
    const path = join(dir, name);
    const existing = await readFile(path, "utf8").catch(() => undefined);

    if (options.remove) {
      if (!existing) return console.log(dim(`No ${name} hook here.`));
      if (!existing.includes(MARKER)) throw new WispError(`${name} was not written by Wisp — leaving it alone`, "NOT_OURS");
      await rm(path);
      console.log(`${green("✓")} removed ${name}`);
      return;
    }

    if (!boltRef) throw new WispError(`Say which bolt ${name} runs: \`wisp hook ${name} check\``, "NO_BOLT");
    if (existing && !existing.includes(MARKER) && !options.force) {
      throw new WispError(`There is already a ${name} hook, not written by Wisp. --force replaces it`, "HOOK_EXISTS");
    }

    const here = await maybeProject();
    if (!here) throw new WispError("Run this inside a project with a .wisp.json", "NO_PROJECT");
    const bolt = resolveBolt(here.workspace, boltRef);

    // The file by path, so the hook runs the same bolt however the repository is entered;
    // and a clear failure when wisp is missing, rather than a push that skips its checks.
    const script = `#!/bin/sh
${MARKER} — \`wisp hook ${name} --remove\` takes it out.
command -v wisp >/dev/null 2>&1 || { echo "wisp is not on PATH — install it, or remove this hook: .git/hooks/${name}" >&2; exit 1; }
WISP_TRIGGER=hook exec wisp use '${here.workspace.file.replace(/'/g, `'\\''`)}' '${bolt.label.replace(/'/g, `'\\''`)}'
`;
    await mkdir(dir, { recursive: true });
    await writeFile(path, script, "utf8");
    await chmod(path, 0o755);

    console.log(`${green("✓")} ${name} runs ${bold(bolt.label)} ${dim(`— ${tildify(path)}`)}`);
    if (!bolt.job) console.log(yellow(`! "${bolt.label}" is not a job, so a failure would not stop the ${name}. Add "job": true to it.`));
    if (!here.workspace.trusted && here.withheld.length > 0) console.log(yellow("! its commands wait for `wisp trust` — until then the hook runs nothing"));
  },
};

/** Where this repository's hooks live, `core.hooksPath` and worktrees included. */
function hooksDir(): string {
  let output: string;
  try {
    output = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { encoding: "utf8" }).trim();
  } catch {
    throw new WispError("This is not inside a git repository", "NO_REPOSITORY");
  }
  return isAbsolute(output) ? output : resolve(output);
}
