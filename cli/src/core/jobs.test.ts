import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Platform } from "../platform/types.js";
import type { Environment } from "./environment.js";
import { forgetHistory, getHistory, listHistory, recordHistory, withWorkspaceNames, type HistoryEntry } from "./history.js";
import { spawn, spawnSync } from "node:child_process";

import { listRuns, stopRun } from "./processes.js";
import { windowInvocation } from "./shell.js";
import { interpret } from "./project.js";
import { pipelineStatus, downPipeline, planPipeline, resolvePipeline, switchToWorkspace } from "./switch.js";
import type { Workspace } from "./types.js";

let dir: string;
let previousShell: string | undefined;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "wisp-jobs-")));
  process.env["WISP_HOME"] = join(dir, "home");
  // A plain shell: the user's own would read their whole profile on every command.
  previousShell = process.env["SHELL"];
  process.env["SHELL"] = "/bin/sh";
});

afterEach(async () => {
  for (const run of await listRuns()) if (run.alive) stopRun(run);
  delete process.env["WISP_HOME"];
  if (previousShell === undefined) delete process.env["SHELL"];
  else process.env["SHELL"] = previousShell;
  await rm(dir, { recursive: true, force: true });
});

function workspace(main: Record<string, unknown>, file = join(dir, ".wisp.json")): Workspace {
  return interpret({ main }, { file, personal: false, trust: "trusted", os: "darwin" }).workspace;
}

function recorder(): Platform & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    os: "darwin",
    openUrl: async (url) => void calls.push(`url ${url}`),
    openPath: async (path) => void calls.push(`path ${path}`),
    launchApp: async (app) => void calls.push(`app ${app}`),
    runInTerminal: async (_invocation, request) => void calls.push(`terminal ${request.title}`),
    knownTerminals: () => ["Terminal"],
    findTerminal: () => "Terminal",
    defaultTerminal: () => "Terminal",
  };
}

const desktop: Environment = { os: "darwin", gui: true, ssh: false };

describe("commands that finish, and failures", () => {
  it("run a step after what it waits for, stop at the first failure, and keep it all", async () => {
    const ws = workspace({
      pipelines: [
        {
          label: "Check",
          steps: [
            { run: "echo linting", label: "lint", finishes: true },
            { run: "echo 'tests broke' >&2; exit 3", label: "test", after: "lint", finishes: true },
            { run: "echo deploying", label: "deploy", after: "test", finishes: true },
          ],
        },
      ],
    });
    const platform = recorder();
    const seen: string[] = [];
    const result = await switchToWorkspace(
      ws,
      { bolt: "check", onOutput: (_target, chunk) => seen.push(chunk.trim()) },
      { platform, environment: desktop, defaults: {} },
    );

    expect(platform.calls).toEqual([]); // nothing went to a terminal window
    expect(result.ok).toBe(false);
    expect(result.targets.map((step) => [step.label, step.ok, step.skipped ?? false])).toEqual([
      ["lint", true, false],
      ["test", false, false],
      ["deploy", false, true],
    ]);
    expect(result.targets[2]!.note).toBe('not reached — "test" failed');
    expect(seen).toEqual(["linting", "tests broke"]);

    const entry = await getHistory(result.historyId!);
    expect(entry).toMatchObject({ bolt: "Check", ok: false });
    expect(entry!.steps[0]!.finishes).toBe(true);
    expect(await readFile(entry!.steps[1]!.log!, "utf8")).toBe("tests broke\n");
  });

  it("start what keeps running the way it always starts, and not run a pipeline whose need failed", async () => {
    const ws = workspace({
      pipelines: [
        { label: "Database", steps: [{ run: "postgres", label: "db" }] },
        { label: "Build", steps: [{ run: "exit 1", label: "compile", finishes: true }] },
        { label: "Test", steps: [{ pipeline: "Database", label: "db" }, { pipeline: "Build", label: "build" }, { run: "echo testing", label: "test", after: ["db", "build"], finishes: true }] },
      ],
    });
    const platform = recorder();
    const result = await switchToWorkspace(ws, { bolt: "test" }, { platform, environment: desktop, defaults: { terminal: "Terminal" } });

    expect(platform.calls).toEqual(["terminal db"]); // the service, the way services start
    expect(result.targets.map((step) => [step.label, step.ok, step.skipped ?? false])).toEqual([
      ["db", true, false],
      ["compile", false, false],
      ["test", false, true],
    ]);
  });

  it("stop at the first failure, whatever failed", async () => {
    const ws = workspace({ pipelines: [{ label: "go", steps: [{ folder: "missing", label: "src" }, { url: "acme.com", after: "src" }] }] });
    const platform = recorder();
    const result = await switchToWorkspace(ws, { bolt: "go" }, { platform, environment: desktop, defaults: {} });
    expect(result.targets.map((step) => [step.ok, step.skipped ?? false])).toEqual([[false, false], [false, true]]);
    expect(platform.calls).toEqual([]);
  });

  it("start every step that waits for nothing at once, let them finish, and start nothing new after a failure", async () => {
    const ws = workspace({
      pipelines: [
        {
          label: "go",
          steps: [
            { run: "sleep 0.2; exit 1", label: "broken", finishes: true },
            { run: "sleep 0.6; echo slow", label: "slow", finishes: true },
            { run: "echo after", label: "next", after: "slow", finishes: true },
          ],
        },
      ],
    });
    const began = Date.now();
    const result = await switchToWorkspace(ws, { bolt: "go" }, { platform: recorder(), environment: desktop, defaults: {} });
    expect(Date.now() - began).toBeLessThan(2000);
    expect(result.targets.map((step) => [step.label, step.ok, step.skipped ?? false])).toEqual([
      ["broken", false, false],
      ["slow", true, false],
      ["next", false, true],
    ]);
    expect(result.targets[2]!.note).toBe('not reached — "broken" failed');
  });

  it("keep going after a failure when the pipeline says so", async () => {
    const ws = workspace({ pipelines: [{ label: "go", keepGoing: true, steps: [{ folder: "missing", label: "src" }, { url: "acme.com", after: "src" }] }] });
    const platform = recorder();
    const result = await switchToWorkspace(ws, { bolt: "go" }, { platform, environment: desktop, defaults: {} });
    expect(result.ok).toBe(false);
    expect(result.targets.map((step) => step.ok)).toEqual([false, true]);
    expect(platform.calls).toEqual(["url https://acme.com/"]);
  });

  it("are listed in history newest first, and can be filtered by pipeline", async () => {
    const ws = workspace({ pipelines: [{ label: "Lint", steps: [{ run: "true", finishes: true }] }, { label: "Build", steps: [{ run: "true", finishes: true }] }] });
    const deps = { platform: recorder(), environment: desktop, defaults: {} };
    await switchToWorkspace(ws, { bolt: "lint" }, deps);
    await switchToWorkspace(ws, { bolt: "build" }, deps);

    expect((await listHistory()).map((entry) => entry.bolt)).toEqual(["Build", "Lint"]);
    expect((await listHistory({ bolt: "lin" })).map((entry) => entry.bolt)).toEqual(["Lint"]);
  });

  it("are not recorded on a dry run", async () => {
    const ws = workspace({ pipelines: [{ label: "Lint", steps: [{ run: "true", finishes: true }] }] });
    const result = await switchToWorkspace(ws, { bolt: "lint", dryRun: true }, { platform: recorder(), environment: desktop, defaults: {} });
    expect(result.historyId).toBeUndefined();
    expect(result.targets[0]!.note).toBe("here, and waited for");
    expect(await listHistory()).toEqual([]);
  });
});

describe("waits", () => {
  it("give up as soon as the command they wait for has died, and say so", async () => {
    const ws = workspace({
      pipelines: [{ label: "api", steps: [{ run: "sleep 2; exit 1", label: "server", background: true }, { wait: { port: 1, timeout: 30 } }] }],
    });
    const began = Date.now();
    const result = await switchToWorkspace(ws, { bolt: "api" }, { platform: recorder(), environment: desktop, defaults: {} });
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(result.targets[1]!.error).toMatch(/^server stopped before it was ready — `wisp logs \w+`$/);
  }, 15_000);
});

describe("commands in windows", () => {
  it("are tracked, so running the pipeline again does not start a second copy", async () => {
    const ws = workspace({ pipelines: [{ label: "api", steps: [{ run: "pnpm dev", label: "server" }] }] });
    const platform = recorder();
    const deps = { platform, environment: desktop, defaults: { terminal: "Terminal" } };

    const first = await switchToWorkspace(ws, { bolt: "api" }, deps);
    expect(first.targets[0]!.run).toBeDefined();
    const [run] = await listRuns();
    expect(run).toMatchObject({ kind: "window", where: "Terminal", label: "server", alive: true });

    const second = await switchToWorkspace(ws, { bolt: "api" }, deps);
    expect(second.targets[0]!.note).toMatch(/^already running/);
    expect(platform.calls).toEqual(["terminal server"]);
  });

  it("are found again through the PID their window writes", async () => {
    const pidFile = join(dir, "x.pid");
    // What a terminal window runs: the wrapper records its own PID, then the command.
    const invocation = windowInvocation({ file: "/bin/sh", args: ["-c", "sleep 30"] }, pidFile, "real");
    const child = spawn(invocation.file, invocation.args, { detached: true, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      expect(Number((await readFile(pidFile, "utf8")).trim())).toBe(child.pid);
    } finally {
      process.kill(-child.pid!, "SIGTERM");
    }
  });
});

describe("what is up", () => {
  it("counts only the commands that keep running, never one that finishes", () => {
    const ws = workspace({ pipelines: [{ label: "api", steps: [{ run: "pnpm dev", label: "dev" }, { run: "pnpm build", label: "build", finishes: true }] }] });
    const dev = ws.commands.find((command) => command.label === "dev")!;
    const runs = [{ id: "r1", kind: "background", label: "dev", command: "pnpm dev", workspace: ws.file, workspaceName: "Acme", asset: dev.id, pid: 1, startedAt: new Date().toISOString(), alive: true }];
    expect(pipelineStatus(ws, resolvePipeline(ws, "api"), runs as never)).toEqual({ commands: 1, running: 1, failing: 0 });
  });
});

describe("down", () => {
  it("stops a pipeline's own commands and runs its teardown, leaving its dependencies up", async () => {
    const marker = join(dir, "torn-down");
    const ws = workspace({
      pipelines: [
        { label: "Database", steps: [{ run: "sleep 30", label: "db", background: true }], down: [{ run: `touch '${marker}'`, label: "compose stop" }] },
        { label: "api", steps: [{ pipeline: "Database", label: "db" }, { run: "sleep 30", label: "server", background: true, after: "db" }], down: [{ run: "true", label: "cleanup" }] },
      ],
    });
    const deps = { platform: recorder(), environment: desktop, defaults: {} };
    await switchToWorkspace(ws, { bolt: "api" }, deps);
    expect((await listRuns()).filter((run) => run.alive).map((run) => run.label).sort()).toEqual(["db", "server"]);
    expect(pipelineStatus(ws, resolvePipeline(ws, "api"), await listRuns())).toEqual({ commands: 1, running: 1, failing: 0 });

    const down = await downPipeline(ws, resolvePipeline(ws, "api"), {}, deps);
    expect(down.stopped.map((run) => run.label)).toEqual(["server"]);
    expect(down.teardown?.targets.map((step) => step.label)).toEqual(["cleanup"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await listRuns()).filter((run) => run.alive).map((run) => run.label)).toEqual(["db"]);
  });

  it("takes the dependencies down too when asked", async () => {
    const marker = join(dir, "torn-down");
    const ws = workspace({
      pipelines: [
        { label: "Database", steps: [{ run: "sleep 30", label: "db", background: true }], down: [{ run: `touch '${marker}'`, label: "compose stop" }] },
        { label: "api", steps: [{ pipeline: "Database", label: "db" }, { run: "sleep 30", label: "server", background: true, after: "db" }] },
      ],
    });
    const deps = { platform: recorder(), environment: desktop, defaults: {} };
    await switchToWorkspace(ws, { bolt: "api" }, deps);
    const down = await downPipeline(ws, resolvePipeline(ws, "api"), { deps: true }, deps);
    expect(down.stopped.map((run) => run.label).sort()).toEqual(["db", "server"]);
    await expect(readFile(marker)).resolves.toBeDefined();
  });
});

describe("planPipeline", () => {
  it("keeps a pipeline step's steps where the pipeline step is listed", async () => {
    const ws = workspace({
      pipelines: [
        { label: "db", steps: [{ run: "postgres" }] },
        { label: "api", steps: [{ folder: "api" }, { pipeline: "db" }, { run: "pnpm dev" }] },
      ],
    });
    await writeFile(join(dir, "placeholder"), "");
    const plan = await planPipeline(ws, resolvePipeline(ws, "api"));
    expect(plan.map((step) => step.target.label)).toEqual(["api", "postgres", "pnpm dev"]);
  });
});

describe("compose steps", () => {
  it("wait for trust, start with `up --wait`, and are stopped by down", async () => {
    const { parseComposePs, containerMood, shortStatus } = await import("./docker.js");
    const untrusted = interpret(
      { main: { pipelines: [{ label: "Services", steps: [{ compose: "deploy/compose.yml", services: ["db"] }] }] } },
      { file: join(dir, ".wisp.json"), personal: false, trust: "untrusted", os: "darwin" },
    );
    expect(untrusted.withheld).toEqual([expect.objectContaining({ kind: "compose", reason: "starts containers" })]);
    expect(await planPipeline(untrusted.workspace, resolvePipeline(untrusted.workspace, "services"))).toEqual([]);

    const ws = workspace({ pipelines: [{ label: "Services", steps: [{ compose: "deploy/compose.yml", services: ["db"] }] }] });
    const plan = await planPipeline(ws, resolvePipeline(ws, "services"));
    expect(plan[0]!.target).toMatchObject({ kind: "compose", label: "db", compose: { file: join(dir, "deploy/compose.yml"), services: ["db"], action: "up" } });

    const dry = await downPipeline(ws, resolvePipeline(ws, "services"), { dryRun: true }, { platform: recorder(), environment: desktop, defaults: {} });
    expect(dry.teardown?.targets[0]).toMatchObject({ kind: "compose", note: "would stop them" });

    // What Compose reports, read the way the TUI shows it.
    const [container] = parseComposePs(
      '{"Name":"shop-db-1","Service":"db","Project":"shop","Image":"postgres","State":"running","Health":"healthy","Status":"Up 3 minutes (healthy)","ExitCode":0,"Publishers":[{"URL":"0.0.0.0","TargetPort":5432,"PublishedPort":5432},{"URL":"::","TargetPort":5432,"PublishedPort":5432}]}\n',
      "/f",
    );
    expect(container).toMatchObject({ service: "db", state: "running", health: "healthy", ports: ["5432"] });
    expect(containerMood(container!)).toEqual({ word: "healthy", tone: "good" });
    expect(shortStatus(container!.status)).toBe("up 3m");
    expect(pipelineStatus(ws, resolvePipeline(ws, "services"), [], [{ ...container!, file: join(dir, "deploy/compose.yml") }])).toEqual({ commands: 1, running: 1, failing: 0 });
  });
});

describe("steps that wait for others", () => {
  it("fan out after one step and back in before the next, side by side in between, and stop if one failed", async () => {
    const marker = join(dir, "lint-finished");
    const ws = workspace({
      pipelines: [
        {
          label: "Check",
          steps: [
            { run: "echo installed", label: "install", finishes: true },
            { run: `sleep 0.6; echo lint done; touch '${marker}'`, label: "lint", after: "install", finishes: true },
            { run: "sleep 0.2; echo broke; exit 4", label: "test", after: "install", finishes: true },
            { run: "echo never", label: "build", after: ["lint", "test"], finishes: true },
          ],
        },
      ],
    });
    const output: string[] = [];
    const began = Date.now();
    const result = await switchToWorkspace(ws, { bolt: "check", onOutput: (_target, chunk) => void output.push(chunk) }, { platform: recorder(), environment: desktop, defaults: {} });
    expect(Date.now() - began).toBeLessThan(2500);
    expect(result.targets.map((target) => [target.label, target.ok, target.skipped ?? false])).toEqual([
      ["install", true, false],
      ["lint", true, false],
      ["test", false, false],
      ["build", false, true],
    ]);
    expect(result.targets[3]?.note).toBe('not reached — "test" failed');
    expect(await readFile(marker, "utf8")).toBe("");
    expect(output).toContain("installed\n");
    expect(output).toContain("lint │ lint done\n");
    expect(output).toContain("test │ broke\n");
    const entry = await getHistory(result.historyId as string);
    expect(entry?.steps.map((step) => [step.label, step.after])).toEqual([
      ["install", undefined],
      ["lint", ["install"]],
      ["test", ["install"]],
      ["build", ["lint", "test"]],
    ]);
  });

  it("plans a pipeline step's steps to start when it would, and what waits for it to wait for all of them", async () => {
    const ws = workspace({
      pipelines: [
        { label: "Services", steps: [{ wait: "localhost:5432" }, { wait: "localhost:6379" }] },
        { label: "Dev", steps: [{ pipeline: "Services", label: "services" }, { run: "a", label: "a", after: "services" }, { run: "b", label: "b", after: "services" }, { run: "c", after: ["a", "b"] }] },
      ],
    });
    const plan = await planPipeline(ws, resolvePipeline(ws, "Dev"));
    const key = (label: string) => plan.find((step) => step.target.label === label)?.key as string;
    const services = [key("port 5432"), key("port 6379")];
    expect(plan.map((step) => [step.target.label, step.deps])).toEqual([
      ["port 5432", []],
      ["port 6379", []],
      ["a", services],
      ["b", services],
      ["c", [key("a"), key("b")]],
    ]);
  });
});

describe("a run's pipeline", () => {
  it("puts each step in a column by when it could start, stacking what ran at the same time", async () => {
    const ws = workspace({
      pipelines: [
        {
          label: "Check",
          steps: [
            { run: "true", label: "install", finishes: true },
            { run: "true", label: "lint", after: "install", finishes: true },
            { run: "true", label: "test", after: "install", finishes: true },
            { run: "true", label: "build", after: ["lint", "test"], finishes: true },
          ],
        },
      ],
    });
    const result = await switchToWorkspace(ws, { bolt: "check" }, { platform: recorder(), environment: desktop, defaults: {} });
    const { pipeline } = await import("../tui/history.js");
    const entry = await getHistory(result.historyId as string);
    expect(pipeline(entry!).map((column) => column.map((node) => node.label))).toEqual([["install"], ["lint", "test"], ["build"]]);
  });
});

describe("telling you a run failed", () => {
  it("notifies when nobody was watching, and not when someone was", async () => {
    const shown: string[] = [];
    const platform = { ...recorder(), notify: async (title: string, message: string) => void shown.push(`${title} | ${message}`) };
    const ws = workspace({ pipelines: [{ label: "Backup", steps: [{ run: "exit 3", label: "dump", finishes: true }] }] });
    process.env["WISP_NOTIFY"] = "failures";
    try {
      await switchToWorkspace(ws, { bolt: "backup", watched: true }, { platform, environment: desktop, defaults: {} });
      expect(shown).toEqual([]);
      const result = await switchToWorkspace(ws, { bolt: "backup", watched: false }, { platform, environment: desktop, defaults: {} });
      expect(shown).toEqual([`✗ Backup failed | at dump · ${ws.name} · wisp history ${result.historyId}`]);
    } finally {
      process.env["WISP_NOTIFY"] = "off";
    }
  });
});

describe("inputs", () => {
  it("fills the steps with the values given, keeps them in history, and a retry reuses them", async () => {
    const { planRetry } = await import("./switch.js");
    const out = join(dir, "deployed");
    const ws = workspace({
      pipelines: [
        {
          label: "Deploy",
          inputs: { env: { ask: "Where?", choices: ["staging", "production"] } },
          steps: [
            { run: `echo {{env}} >> '${out}'`, label: "deploy {{env}}", finishes: true },
            { run: "exit 1", label: "smoke test", finishes: true },
          ],
        },
      ],
    });
    const deps = { platform: recorder(), environment: desktop, defaults: {} };
    const first = await switchToWorkspace(ws, { bolt: "deploy", inputs: { env: "staging" } }, deps);
    expect(first.targets[0]).toMatchObject({ label: "deploy staging", ok: true });
    const entry = await getHistory(first.historyId as string);
    expect(entry?.inputs).toEqual({ env: "staging" });
    expect(entry?.steps[0]?.label).toBe("deploy staging");

    const again = await planRetry(ws, entry as HistoryEntry);
    expect(again.map((step) => step.target.label)).toEqual(["smoke test"]);
    expect(await readFile(out, "utf8")).toBe("staging\n");
  });

  it("runs nothing when a value isn't one word, however it got there", async () => {
    const marker = join(dir, "pwned");
    const ws = workspace({ pipelines: [{ label: "Deploy", inputs: { env: {} }, steps: [{ run: "echo {{env}}", finishes: true }] }] });
    await expect(switchToWorkspace(ws, { bolt: "deploy", inputs: { env: `x; touch '${marker}'` } }, { platform: recorder(), environment: desktop, defaults: {} })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });
});

describe("stopping and retrying", () => {
  it("stops a run when asked: what is attached is killed, and nothing more starts", async () => {
    const ws = workspace({
      pipelines: [{ label: "Build", steps: [{ run: "sleep 30", label: "compile", finishes: true }, { run: "echo never", label: "package", after: "compile", finishes: true }] }],
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const began = Date.now();
    const result = await switchToWorkspace(ws, { bolt: "build", signal: controller.signal }, { platform: recorder(), environment: desktop, defaults: {} });
    expect(Date.now() - began).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    expect(result.targets[1]).toMatchObject({ skipped: true, note: "not reached — the run was stopped" });
  });

  it.skipIf(process.platform === "win32")("stops a command that runs over its timeout, with all it started, and fails the step", async () => {
    const ws = workspace({
      pipelines: [{ label: "Backup", steps: [{ run: `sleep 37.25; touch "${join(dir, "went-on")}"`, label: "dump", finishes: true, timeout: 0.5 }, { run: "echo never", label: "clean", after: "dump", finishes: true }] }],
    });
    const began = Date.now();
    const result = await switchToWorkspace(ws, { bolt: "backup" }, { platform: recorder(), environment: desktop, defaults: {} });
    expect(Date.now() - began).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    expect(result.targets[0]).toMatchObject({ ok: false, error: "ran over its 0.5s timeout, so Wisp stopped it" });
    expect(result.targets[1]).toMatchObject({ skipped: true });
    expect(spawnSync("pgrep", ["-f", "sleep 37.25"]).status).toBe(1);
    await new Promise((settle) => setTimeout(settle, 300));
    await expect(readFile(join(dir, "went-on"), "utf8")).rejects.toThrow();
  });

  it("leaves a command that finishes within its timeout alone", async () => {
    const ws = workspace({ pipelines: [{ label: "Check", steps: [{ run: "echo ok", label: "test", finishes: true, timeout: "1m" }] }] });
    const result = await switchToWorkspace(ws, { bolt: "check" }, { platform: recorder(), environment: desktop, defaults: {} });
    expect(result.targets[0]).toMatchObject({ ok: true });
  });

  it("retries only what failed, and what the failure kept from running", async () => {
    const { retryPlan } = await import("./switch.js");
    const marker = join(dir, "lint-ran");
    const ws = workspace({
      pipelines: [
        {
          label: "Check",
          steps: [
            { run: `echo x >> '${marker}'`, label: "lint", finishes: true },
            { run: "exit 1", label: "test", after: "lint", finishes: true },
            { run: "true", label: "build", after: "test", finishes: true },
          ],
        },
      ],
    });
    const deps = { platform: recorder(), environment: desktop, defaults: {} };
    const first = await switchToWorkspace(ws, { bolt: "check" }, deps);
    const again = retryPlan(first);
    expect(again.map((step) => step.target.label)).toEqual(["test", "build"]);

    const { runPlan } = await import("./switch.js");
    await runPlan(ws, again, { label: "Check (retry)" }, deps);
    // lint passed the first time, so it did not run again.
    expect((await readFile(marker, "utf8")).trim().split("\n")).toHaveLength(1);
  });
});

describe("restart policies", () => {
  it("bring a crashed command back, and say so in its log", async () => {
    const counter = join(dir, "starts");
    const ws = workspace({
      pipelines: [{ label: "api", steps: [{ run: `echo started >> '${counter}'; exit 1`, label: "server", background: true, restart: "on-failure" }] }],
    });
    await switchToWorkspace(ws, { bolt: "api" }, { platform: recorder(), environment: desktop, defaults: {} });
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const starts = (await readFile(counter, "utf8")).trim().split("\n").length;
    expect(starts).toBeGreaterThanOrEqual(2);
    const [run] = await listRuns();
    const { tail } = await import("./processes.js");
    expect(await tail(run!.log, 50)).toContain("[wisp] restarting server (exited with 1) — try 1 of 10");
    stopRun(run!);
  }, 10_000);

  it("leave a command that finished cleanly alone, on-failure", async () => {
    const { restartLoop } = await import("./shell.js");
    const { spawnSync } = await import("node:child_process");
    const loop = restartLoop({ file: "/bin/sh", args: ["-c", "echo done"] }, "on-failure", "once");
    const result = spawnSync(loop.file, loop.args, { encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("done");
  });

  it("are read from the file, and a wrong one is said", () => {
    const read = interpret(
      { main: { pipelines: [{ label: "x", steps: [{ label: "a", run: "x", restart: "on-failure" }, { label: "b", run: "y", restart: "sometimes" }] }] } },
      { file: "/w/.wisp.json", personal: false, trust: "trusted", os: "darwin" },
    );
    expect(read.declaredCommands.map((command) => command.restart)).toEqual(["on-failure", undefined]);
    expect(read.diagnostics).toContainEqual(expect.objectContaining({ at: "pipelines[0].steps[1].restart", level: "warning" }));
  });
});

describe("history like a CI", () => {
  it("numbers each pipeline's runs, and records which pipeline a dependency's steps came from", async () => {
    const ws = workspace({
      pipelines: [
        { label: "Database", steps: [{ run: "true", label: "postgres", background: true }] },
        { label: "Check", steps: [{ pipeline: "Database", label: "db" }, { run: "true", label: "test", after: "db", finishes: true }] },
      ],
    });
    const deps = { platform: recorder(), environment: desktop, defaults: {} };
    await switchToWorkspace(ws, { bolt: "check" }, deps);
    await switchToWorkspace(ws, { bolt: "check" }, deps);
    const [latest, earlier] = await listHistory({ bolt: "Check" });
    expect([latest?.number, earlier?.number]).toEqual([2, 1]);
    expect(latest?.steps.map((step) => [step.label, step.bolt])).toEqual([
      ["postgres", "Database"],
      ["test", undefined],
    ]);

    const { pipeline } = await import("../tui/history.js");
    expect(pipeline(latest!).map((column) => column.map((node) => [node.label, node.detail?.split(" ").slice(0, 2).join(" ")]))).toEqual([
      [["Database", "1 step"]],
      [["Check", "1 step"]],
    ]);
  });

  it("shows a run while it goes, step by step, under the number it ends with", async () => {
    const ws = workspace({ pipelines: [{ label: "Check", steps: [{ run: "sleep 0.3", label: "lint", finishes: true }, { run: "true", label: "test", finishes: true }] }] });
    const seen: HistoryEntry[] = [];
    let first = true;
    const deps = { platform: recorder(), environment: desktop, defaults: {} };
    const onStep = () => {
      if (!first) return;
      first = false;
      void listHistory().then(([entry]) => entry && seen.push(entry));
    };
    await switchToWorkspace(ws, { bolt: "check", onStep }, deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ running: true, total: 2, pid: process.pid, steps: [] });
    expect(seen[0]?.pending?.map((step) => step.label)).toEqual(["lint", "test"]);
    expect(seen[0]?.pending?.[0]?.log).toMatch(/1\.log$/);
    expect(seen[0]?.pending?.[1]?.log).toBeUndefined();
    const [done] = await listHistory();
    expect(done?.running).toBeUndefined();
    expect(done?.pending).toBeUndefined();
    expect(done?.ok).toBe(true);
    expect(done?.number).toBe(1);
    expect(done?.id).toBe(seen[0]?.id);
    expect(await listHistory()).toHaveLength(1);
  });

  it("calls a run whose Wisp went away interrupted", async () => {
    const step = (label: string, log?: string) => ({ kind: "command" as const, label, value: `pnpm ${label}`, ok: false, durationMs: 0, ...(log ? { log } : {}) });
    await recordHistory({ id: "aaaaaaaaaaaa", workspace: "/a/.wisp.json", workspaceName: "A", bolt: "Check", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.000Z", ok: false, steps: [{ ...step("lint"), ok: true }], running: true, pid: 999_999_999, total: 3, pending: [step("test", "/logs/2.log"), step("build")] });
    const [entry] = await listHistory();
    expect(entry?.running).toBeUndefined();
    expect(entry?.pending).toBeUndefined();
    expect(entry?.interrupted).toBe(true);
    expect(entry?.ok).toBe(false);
    expect(entry?.steps.map((done) => [done.label, done.ok, done.skipped ?? false, done.error ?? done.note ?? "", done.log ?? ""])).toEqual([
      ["lint", true, false, "", ""],
      ["test", false, false, "interrupted", "/logs/2.log"],
      ["build", false, true, "not reached — Wisp stopped", ""],
    ]);
  });

  it("shows a renamed workspace's runs under its name now, and a gone one's under the name it had", () => {
    const run = (id: string, workspace: string, workspaceName: string): HistoryEntry => ({ id, workspace, workspaceName, bolt: "Check", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", ok: true, steps: [] });
    const named = withWorkspaceNames([run("a1", "/a/.wisp.json", "Mira"), run("a2", "/a/.wisp.json", "Mira Web"), run("b1", "/b/.wisp.json", "Gone")], new Map([["/a/.wisp.json", "Mira Web"]]));
    expect(named.map((entry) => entry.workspaceName)).toEqual(["Mira Web", "Mira Web", "Gone"]);
  });

  it("deletes runs by id, workspace or pipeline, keeping the ones still going", async () => {
    const run = (id: string, bolt: string, workspace = "/a/.wisp.json", running = false): HistoryEntry => ({
      id, workspace, workspaceName: "A", bolt, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", ok: true, steps: [],
      ...(running ? { running: true, pid: process.pid, total: 1 } : {}),
    });
    for (const entry of [run("a1", "Check"), run("a2", "Check (retry)"), run("a3", "Build"), run("b1", "Check", "/b/.wisp.json"), run("a4", "Check", "/a/.wisp.json", true)]) await recordHistory(entry);

    const byPipeline = await forgetHistory({ workspace: "/a/.wisp.json", bolt: "check" });
    expect(byPipeline.removed.map((entry) => entry.id).sort()).toEqual(["a1", "a2"]);
    expect(byPipeline.running.map((entry) => entry.id)).toEqual(["a4"]);
    expect((await listHistory()).map((entry) => entry.id).sort()).toEqual(["a3", "a4", "b1"]);

    await forgetHistory({ ids: ["b1"] });
    expect((await listHistory()).map((entry) => entry.id).sort()).toEqual(["a3", "a4"]);
  });
});
