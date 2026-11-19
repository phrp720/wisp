import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Platform } from "../platform/types.js";
import type { Environment } from "./environment.js";
import { forgetHistory, getHistory, listHistory, recordHistory, type HistoryEntry } from "./history.js";
import { spawn } from "node:child_process";

import { listRuns, stopRun } from "./processes.js";
import { windowInvocation } from "./shell.js";
import { interpret } from "./project.js";
import { boltStatus, downBolt, planBolt, resolveBolt, switchToWorkspace } from "./switch.js";
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

describe("jobs", () => {
  it("run their commands attached and in order, stop at the first failure, and keep it all", async () => {
    const ws = workspace({
      bolts: [
        {
          label: "Check",
          job: true,
          targets: [
            { run: "echo linting", label: "lint" },
            { run: "echo 'tests broke' >&2; exit 3", label: "test" },
            { run: "echo deploying", label: "deploy" },
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
    expect(entry).toMatchObject({ bolt: "Check", job: true, ok: false });
    expect(await readFile(entry!.steps[1]!.log!, "utf8")).toBe("tests broke\n");
  });

  it("start the services they depend on, and stop when a job they depend on fails", async () => {
    const ws = workspace({
      bolts: [
        { label: "Database", targets: [{ run: "postgres", label: "db" }] },
        { label: "Build", job: true, targets: [{ run: "exit 1", label: "compile" }] },
        { label: "Test", job: true, targets: [{ bolt: "Database" }, { bolt: "Build" }, { run: "echo testing", label: "test" }] },
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

  it("keep going in an ordinary bolt when one thing fails", async () => {
    const ws = workspace({ bolts: [{ label: "go", targets: [{ folder: "missing" }, { url: "acme.com" }] }] });
    const platform = recorder();
    const result = await switchToWorkspace(ws, { bolt: "go" }, { platform, environment: desktop, defaults: {} });
    expect(result.targets.map((step) => step.ok)).toEqual([false, true]);
    expect(platform.calls).toEqual(["url https://acme.com/"]);
  });

  it("are listed in history newest first, and can be filtered by bolt", async () => {
    const ws = workspace({ bolts: [{ label: "Lint", job: true, targets: [{ run: "true" }] }, { label: "Build", job: true, targets: [{ run: "true" }] }] });
    const deps = { platform: recorder(), environment: desktop, defaults: {} };
    await switchToWorkspace(ws, { bolt: "lint" }, deps);
    await switchToWorkspace(ws, { bolt: "build" }, deps);

    expect((await listHistory()).map((entry) => entry.bolt)).toEqual(["Build", "Lint"]);
    expect((await listHistory({ bolt: "lin" })).map((entry) => entry.bolt)).toEqual(["Lint"]);
  });

  it("are not recorded on a dry run", async () => {
    const ws = workspace({ bolts: [{ label: "Lint", job: true, targets: [{ run: "true" }] }] });
    const result = await switchToWorkspace(ws, { bolt: "lint", dryRun: true }, { platform: recorder(), environment: desktop, defaults: {} });
    expect(result.historyId).toBeUndefined();
    expect(result.targets[0]!.note).toBe("attached — a failure stops the run");
    expect(await listHistory()).toEqual([]);
  });
});

describe("waits", () => {
  it("give up as soon as the command they wait for has died, and say so", async () => {
    const ws = workspace({
      bolts: [{ label: "api", targets: [{ run: "sleep 2; exit 1", label: "server", background: true }, { wait: { port: 1, timeout: 30 } }] }],
    });
    const began = Date.now();
    const result = await switchToWorkspace(ws, { bolt: "api" }, { platform: recorder(), environment: desktop, defaults: {} });
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(result.targets[1]!.error).toMatch(/^server stopped before it was ready — `wisp logs \w+`$/);
  }, 15_000);
});

describe("commands in windows", () => {
  it("are tracked, so running the bolt again does not start a second copy", async () => {
    const ws = workspace({ bolts: [{ label: "api", targets: [{ run: "pnpm dev", label: "server" }] }] });
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

describe("down", () => {
  it("stops a bolt's own commands and runs its teardown, leaving its dependencies up", async () => {
    const marker = join(dir, "torn-down");
    const ws = workspace({
      bolts: [
        { label: "Database", targets: [{ run: "sleep 30", label: "db", background: true }], down: [{ run: `touch '${marker}'`, label: "compose stop" }] },
        { label: "api", targets: [{ bolt: "Database" }, { run: "sleep 30", label: "server", background: true }], down: [{ run: "true", label: "cleanup" }] },
      ],
    });
    const deps = { platform: recorder(), environment: desktop, defaults: {} };
    await switchToWorkspace(ws, { bolt: "api" }, deps);
    expect((await listRuns()).filter((run) => run.alive).map((run) => run.label).sort()).toEqual(["db", "server"]);
    expect(boltStatus(ws, resolveBolt(ws, "api"), await listRuns())).toEqual({ commands: 1, running: 1, failing: 0 });

    const down = await downBolt(ws, resolveBolt(ws, "api"), {}, deps);
    expect(down.stopped.map((run) => run.label)).toEqual(["server"]);
    expect(down.teardown?.targets.map((step) => step.label)).toEqual(["cleanup"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await listRuns()).filter((run) => run.alive).map((run) => run.label)).toEqual(["db"]);
  });

  it("takes the dependencies down too when asked", async () => {
    const marker = join(dir, "torn-down");
    const ws = workspace({
      bolts: [
        { label: "Database", targets: [{ run: "sleep 30", label: "db", background: true }], down: [{ run: `touch '${marker}'`, label: "compose stop" }] },
        { label: "api", targets: [{ bolt: "Database" }, { run: "sleep 30", label: "server", background: true }] },
      ],
    });
    const deps = { platform: recorder(), environment: desktop, defaults: {} };
    await switchToWorkspace(ws, { bolt: "api" }, deps);
    const down = await downBolt(ws, resolveBolt(ws, "api"), { deps: true }, deps);
    expect(down.stopped.map((run) => run.label).sort()).toEqual(["db", "server"]);
    await expect(readFile(marker)).resolves.toBeDefined();
  });
});

describe("planBolt", () => {
  it("keeps a dependency's steps where the dependency is listed", async () => {
    const ws = workspace({
      bolts: [
        { label: "db", targets: [{ run: "postgres" }] },
        { label: "api", targets: [{ folder: "api" }, { bolt: "db" }, { run: "pnpm dev" }] },
      ],
    });
    await writeFile(join(dir, "placeholder"), "");
    const plan = await planBolt(ws, resolveBolt(ws, "api"));
    expect(plan.map((step) => step.target.label)).toEqual(["api", "postgres", "pnpm dev"]);
  });
});

describe("compose steps", () => {
  it("wait for trust, start with `up --wait`, and are stopped by down", async () => {
    const { parseComposePs, containerMood, shortStatus } = await import("./docker.js");
    const untrusted = interpret(
      { main: { bolts: [{ label: "Services", targets: [{ compose: "deploy/compose.yml", services: ["db"] }] }] } },
      { file: join(dir, ".wisp.json"), personal: false, trust: "untrusted", os: "darwin" },
    );
    expect(untrusted.withheld).toEqual([expect.objectContaining({ kind: "compose", reason: "starts containers" })]);
    expect(await planBolt(untrusted.workspace, resolveBolt(untrusted.workspace, "services"))).toEqual([]);

    const ws = workspace({ bolts: [{ label: "Services", targets: [{ compose: "deploy/compose.yml", services: ["db"] }] }] });
    const plan = await planBolt(ws, resolveBolt(ws, "services"));
    expect(plan[0]!.target).toMatchObject({ kind: "compose", label: "db", compose: { file: join(dir, "deploy/compose.yml"), services: ["db"], action: "up" } });

    const dry = await downBolt(ws, resolveBolt(ws, "services"), { dryRun: true }, { platform: recorder(), environment: desktop, defaults: {} });
    expect(dry.teardown?.targets[0]).toMatchObject({ kind: "compose", note: "would stop them" });

    // What Compose reports, read the way the TUI shows it.
    const [container] = parseComposePs(
      '{"Name":"shop-db-1","Service":"db","Project":"shop","Image":"postgres","State":"running","Health":"healthy","Status":"Up 3 minutes (healthy)","ExitCode":0,"Publishers":[{"URL":"0.0.0.0","TargetPort":5432,"PublishedPort":5432},{"URL":"::","TargetPort":5432,"PublishedPort":5432}]}\n',
      "/f",
    );
    expect(container).toMatchObject({ service: "db", state: "running", health: "healthy", ports: ["5432"] });
    expect(containerMood(container!)).toEqual({ word: "healthy", tone: "good" });
    expect(shortStatus(container!.status)).toBe("up 3m");
    expect(boltStatus(ws, resolveBolt(ws, "services"), [], [{ ...container!, file: join(dir, "deploy/compose.yml") }])).toEqual({ commands: 1, running: 1, failing: 0 });
  });
});

describe("stopping and retrying", () => {
  it("stops a run when asked: what is attached is killed, and nothing more starts", async () => {
    const ws = workspace({
      bolts: [{ label: "Build", job: true, targets: [{ run: "sleep 30", label: "compile" }, { run: "echo never", label: "package" }] }],
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const began = Date.now();
    const result = await switchToWorkspace(ws, { bolt: "build", signal: controller.signal }, { platform: recorder(), environment: desktop, defaults: {} });
    expect(Date.now() - began).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    expect(result.targets[1]).toMatchObject({ skipped: true, note: "not reached — the run was stopped" });
  });

  it("retries only what failed, and what the failure kept from running", async () => {
    const { retryPlan } = await import("./switch.js");
    const marker = join(dir, "lint-ran");
    const ws = workspace({
      bolts: [
        {
          label: "Check",
          job: true,
          targets: [
            { run: `echo x >> '${marker}'`, label: "lint" },
            { run: "exit 1", label: "test" },
            { run: "true", label: "build" },
          ],
        },
      ],
    });
    const deps = { platform: recorder(), environment: desktop, defaults: {} };
    const first = await switchToWorkspace(ws, { bolt: "check" }, deps);
    const again = retryPlan(first);
    expect(again.map((step) => step.target.label)).toEqual(["test", "build"]);

    const { runPlan } = await import("./switch.js");
    await runPlan(ws, again, { label: "Check (retry)", job: true }, deps);
    // lint passed the first time, so it did not run again.
    expect((await readFile(marker, "utf8")).trim().split("\n")).toHaveLength(1);
  });
});

describe("restart policies", () => {
  it("bring a crashed command back, and say so in its log", async () => {
    const counter = join(dir, "starts");
    const ws = workspace({
      bolts: [{ label: "api", targets: [{ run: `echo started >> '${counter}'; exit 1`, label: "server", background: true, restart: "on-failure" }] }],
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
      { main: { commands: [{ label: "a", run: "x", restart: "on-failure" }, { label: "b", run: "y", restart: "sometimes" }] } },
      { file: "/w/.wisp.json", personal: false, trust: "trusted", os: "darwin" },
    );
    expect(read.declaredCommands.map((command) => command.restart)).toEqual(["on-failure", undefined]);
    expect(read.diagnostics).toContainEqual(expect.objectContaining({ at: "commands[1].restart", level: "warning" }));
  });
});

describe("history like a CI", () => {
  it("numbers each bolt's runs, and records which bolt a dependency's steps came from", async () => {
    const ws = workspace({
      bolts: [
        { label: "Database", targets: [{ run: "true", label: "postgres", background: true }] },
        { label: "Check", job: true, targets: [{ bolt: "Database" }, { run: "true", label: "test" }] },
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
    expect(pipeline(latest!).map((node) => [node.label, node.detail?.split(" ").slice(0, 2).join(" ")])).toEqual([
      ["Database", "1 step"],
      ["Check", "1 step"],
    ]);
  });

  it("shows a run while it goes, step by step, under the number it ends with", async () => {
    const ws = workspace({ bolts: [{ label: "Check", job: true, targets: [{ run: "sleep 0.3", label: "lint" }, { run: "true", label: "test" }] }] });
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
    const [done] = await listHistory();
    expect(done?.running).toBeUndefined();
    expect(done?.ok).toBe(true);
    expect(done?.number).toBe(1);
    expect(done?.id).toBe(seen[0]?.id);
    expect(await listHistory()).toHaveLength(1);
  });

  it("calls a run whose Wisp went away interrupted", async () => {
    await recordHistory({ id: "aaaaaaaaaaaa", workspace: "/a/.wisp.json", workspaceName: "A", bolt: "Check", job: true, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.000Z", ok: false, steps: [], running: true, pid: 999_999_999, total: 3 });
    const [entry] = await listHistory();
    expect(entry?.running).toBeUndefined();
    expect(entry?.interrupted).toBe(true);
    expect(entry?.ok).toBe(false);
  });

  it("deletes runs by id, workspace or bolt, keeping the ones still going", async () => {
    const run = (id: string, bolt: string, workspace = "/a/.wisp.json", running = false): HistoryEntry => ({
      id, workspace, workspaceName: "A", bolt, job: true, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", ok: true, steps: [],
      ...(running ? { running: true, pid: process.pid, total: 1 } : {}),
    });
    for (const entry of [run("a1", "Check"), run("a2", "Check (retry)"), run("a3", "Build"), run("b1", "Check", "/b/.wisp.json"), run("a4", "Check", "/a/.wisp.json", true)]) await recordHistory(entry);

    const byBolt = await forgetHistory({ workspace: "/a/.wisp.json", bolt: "check" });
    expect(byBolt.removed.map((entry) => entry.id).sort()).toEqual(["a1", "a2"]);
    expect(byBolt.running.map((entry) => entry.id)).toEqual(["a4"]);
    expect((await listHistory()).map((entry) => entry.id).sort()).toEqual(["a3", "a4", "b1"]);

    await forgetHistory({ ids: ["b1"] });
    expect((await listHistory()).map((entry) => entry.id).sort()).toEqual(["a3", "a4"]);
  });
});
