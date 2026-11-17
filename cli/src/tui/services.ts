import { spawnSync } from "node:child_process";
import { watch as watchPath, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { recordProject } from "../core/config.js";
import { detectEnvironment } from "../core/environment.js";
import { listRuns, restartRun, stopRun, tail } from "../core/processes.js";
import { containerAction, containerLogs, containerStats, composeContainers, DockerUnavailable } from "../core/docker.js";
import { describe as describeError } from "../core/errors.js";
import { PROJECT_FILE, checkProject, findProjectFile } from "../core/project.js";
import { bolts as draftBolts, draftProject, writeProjectDraft } from "../core/scaffold.js";
import { downBolt, planRetry, runPlan, switchToWorkspace } from "../core/switch.js";
import { listHistory } from "../core/history.js";
import { trustProject } from "../core/trust.js";
import { which } from "../core/which.js";
import { discoverWorkspaces, resolveWorkspace } from "../core/workspaces.js";
import { everything } from "../cli/lib/context.js";
import { describeStep, type Services } from "./model.js";
import { composeTarget } from "../core/switch.js";
import * as edit from "../core/edit.js";

/** Leave and re-enter the alternate screen, as htop does around a shell-out. */
export const ENTER_SCREEN = "\u001B[?1049h\u001B[H";
export const LEAVE_SCREEN = "\u001B[?1049l";

/** The editor to hand a file to: the one you set, or one that is sure to exist. */
export function editorCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const chosen = env["VISUAL"]?.trim() || env["EDITOR"]?.trim();
  // `code --wait` and friends: the variable may carry arguments.
  if (chosen) return chosen.split(/\s+/);
  if (process.platform === "win32") return ["notepad"];
  for (const candidate of ["nano", "vim", "vi"]) if (which(candidate)) return [candidate];
  return ["vi"];
}

/** The real thing: what `wisp` with no arguments runs against. */
export function realServices(hooks: { suspend: () => void; resume: () => void }): Services {
  return {
    environment: detectEnvironment(),

    async load() {
      const [reads, { unreadable }, here] = await Promise.all([everything(), discoverWorkspaces(), findProjectFile()]);
      return { reads, unreadable, ...(here ? { here } : {}) };
    },

    async run(read, bolt, callbacks) {
      if (!read.workspace.personal && !callbacks.dryRun) await recordProject(read.workspace.file).catch(() => undefined);
      return switchToWorkspace(
        read.workspace,
        {
          bolt,
          trigger: "tui",
          dryRun: callbacks.dryRun,
          mode: "auto",
          onPlan: callbacks.onPlan,
          onStep: callbacks.onStep,
          onResult: callbacks.onResult,
          ...(callbacks.onOutput ? { onOutput: callbacks.onOutput } : {}),
          ...(callbacks.signal ? { signal: callbacks.signal } : {}),
        },
        { findWorkspace: async (ref) => resolveWorkspace(ref, await everything()).workspace },
      );
    },

    retry: (read, steps, label, job, callbacks) =>
      runPlan(
        read.workspace,
        steps,
        {
          label: `${label} (retry)`,
          job,
          trigger: "retry",
          onPlan: callbacks.onPlan,
          onStep: callbacks.onStep,
          onResult: callbacks.onResult,
          ...(callbacks.onOutput ? { onOutput: callbacks.onOutput } : {}),
          ...(callbacks.signal ? { signal: callbacks.signal } : {}),
        },
        { findWorkspace: async (ref) => resolveWorkspace(ref, await everything()).workspace },
      ),

    planRetry: (read, entry) => planRetry(read.workspace, entry, { findWorkspace: async (ref) => resolveWorkspace(ref, await everything()).workspace }),

    down: (read, bolt, options = {}) =>
      downBolt(read.workspace, bolt, options.deps ? { deps: true } : {}, { findWorkspace: async (ref) => resolveWorkspace(ref, await everything()).workspace }),

    history: () => listHistory(),
    // A log that is gone rejects, so it is not shown as "printed nothing".
    readLog: (path) => readFile(path, "utf8"),

    check: (file) => checkProject(file),

    async trust(file, hash) {
      await trustProject(file, hash);
    },

    async containers(files) {
      if (files.length === 0) return { containers: [] };
      try {
        return { containers: (await Promise.all(files.map(composeContainers))).flat() };
      } catch (error) {
        return { containers: [], error: error instanceof DockerUnavailable ? error.message : describeError(error) };
      }
    },
    containerStats: (names) => containerStats(names).catch(() => new Map()),
    containerLogs: (name) => containerLogs(name).catch((error: unknown) => describeError(error)),
    containerAction,

    async suggestSetup() {
      if (await findProjectFile()) return undefined;
      const draft = await draftProject(process.cwd());
      const detected = draft.detected;
      // Only where there is something real to set up: a folder with nothing to run gets no
      // offer, rather than a file of folders nobody asked for.
      if (detected.apps.length === 0 && !detected.compose && detected.checks.length === 0 && !detected.everything) return undefined;
      return {
        dir: process.cwd(),
        name: detected.name,
        found: detected.sources,
        bolts: draftBolts(detected).map((bolt) => ({
          label: bolt.label,
          job: bolt.job ?? false,
          steps: bolt.targets.map((step) =>
            typeof step === "string"
              ? `open ${step}`
              : typeof step["compose"] === "string" && detected.compose
                ? `start Docker services: ${detected.compose.services.map((service) => service.name).join(", ")} — and wait until they're healthy`
                : describeDraftStep(step),
          ),
        })),
        contents: draft.contents,
      };
    },
    async setUp(suggestion) {
      const draft = await draftProject(suggestion.dir);
      return writeProjectDraft(draft);
    },

    watch(files, onChange) {
      // Directories, not files: an editor saves by replacing the file, and a watch on the
      // old one would go quiet after the first save.
      const watchers: FSWatcher[] = [];
      const timers = new Map<string, NodeJS.Timeout>();
      for (const dir of new Set(files.map((file) => dirname(file)))) {
        try {
          watchers.push(
            watchPath(dir, (_event, name) => {
              if (!name) return;
              const file = files.find((entry) => dirname(entry) === dir && (basename(entry) === name || name === ".wisp.local.json"));
              if (!file) return;
              clearTimeout(timers.get(file));
              timers.set(file, setTimeout(() => onChange(file), 250));
            }),
          );
        } catch {
          // A directory that cannot be watched is simply not watched.
        }
      }
      return () => {
        for (const watcher of watchers) watcher.close();
        for (const timer of timers.values()) clearTimeout(timer);
      };
    },

    editing: {
      bolt: edit.readBolt,
      addBolt: edit.addBolt,
      renameBolt: edit.renameBolt,
      removeBolt: edit.removeBolt,
      moveBolt: edit.moveBolt,
      setJob: edit.setJob,
      addStep: edit.addStep,
      replaceStep: edit.replaceStep,
      removeStep: edit.removeStep,
      moveStep: edit.moveStep,
      createPersonalWorkspace: edit.createPersonalWorkspace,
    },

    runs: listRuns,
    stop: stopRun,
    restart: restartRun,
    tail,

    async edit(file) {
      const [program, ...args] = editorCommand();
      hooks.suspend();
      try {
        spawnSync(program as string, [...args, file], { stdio: "inherit" });
      } finally {
        hooks.resume();
      }
    },
  };
}

/** A drafted step, described the way the running TUI describes it. */
function describeDraftStep(step: Record<string, unknown>): string {
  if (typeof step["compose"] === "string") return describeStep(composeTarget({ file: step["compose"] }, "up"));
  if (typeof step["run"] === "string") return `start ${typeof step["label"] === "string" ? step["label"] : step["run"]}`;
  if (typeof step["bolt"] === "string") return `${step["bolt"]} first`;
  if (typeof step["folder"] === "string") return `open the ${step["folder"]} folder`;
  if (typeof step["url"] === "string") return `open ${step["url"]}`;
  if (step["wait"] !== undefined) return `wait until ${String(step["wait"])} answers`;
  return "…";
}

export { PROJECT_FILE };
