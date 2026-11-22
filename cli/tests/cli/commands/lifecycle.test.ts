import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listHistory, recordHistory, type HistoryEntry } from "../../../src/core/history.js";
import { history, hook } from "../../../src/cli/commands/lifecycle.js";

let dir: string;
let file: string;
let printed: string[];

const run = (id: string, bolt: string, workspace: string, running = false): HistoryEntry => ({
  id,
  workspace,
  workspaceName: "Shop",
  bolt,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  ok: true,
  steps: [],
  ...(running ? { running: true, pid: process.pid, total: 2 } : {}),
});

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "wisp-lifecycle-")));
  process.env["WISP_HOME"] = join(dir, "home");
  file = join(dir, ".wisp.json");
  await writeFile(file, JSON.stringify({ name: "Shop", pipelines: [{ label: "Check", steps: [] }, { label: "Build", steps: [] }] }));
  for (const entry of [run("aaa111aaa111", "Check", file), run("aaa222aaa222", "Build", file), run("bbb111bbb111", "Check", "/elsewhere/.wisp.json"), run("aaa333aaa333", "Check", file, true)]) {
    await recordHistory(entry);
  }
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void printed.push(args.join(" ")));
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env["WISP_HOME"];
  await rm(dir, { recursive: true, force: true });
});

const ids = async () => (await listHistory()).map((entry) => entry.id).sort();

describe("wisp history", () => {
  it("shows a renamed workspace's runs under the name it has now", async () => {
    await recordHistory({ ...run("ccc111ccc111", "Check", file), workspaceName: "Old Shop" });
    await recordHistory({ ...run("ddd111ddd111", "Check", "/gone/.wisp.json"), workspaceName: "Gone" });
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    await history.run(["ccc111"], { json: true });
    expect(JSON.parse(printed.join("\n")).workspaceName).toBe("Shop");
    printed.length = 0;
    await history.run([], { all: true, json: true });
    const names = (JSON.parse(printed.join("\n")) as HistoryEntry[]).map((entry) => `${entry.id} ${entry.workspaceName}`);
    expect(names).toContain("ccc111ccc111 Shop");
    expect(names).toContain("ddd111ddd111 Gone");
  });
  it("shows the values a run was given", async () => {
    await recordHistory({ ...run("eee111eee111", "Check", file), inputs: { env: "staging", tag: "v2" } });
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    await history.run(["eee111"], {});
    expect(printed.join("\n")).toContain("with env=staging tag=v2");
  });
});

describe("wisp history <word>", () => {
  it("refuses a word that is neither a run nor a pipeline, and says what a run is", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    await expect(history.run(["1"], {})).rejects.toMatchObject({ code: "NOT_FOUND", message: 'No run or pipeline called "1"' });
  });

  it("says a pipeline has not run yet", async () => {
    await writeFile(file, JSON.stringify({ name: "Shop", pipelines: [{ label: "Check", steps: [] }, { label: "Deploy", steps: [] }] }));
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    await history.run(["deploy"], {});
    expect(printed.join("\n")).toContain('No runs of "deploy" yet.');
  });
});

describe("wisp history --clear", () => {
  it("clears one pipeline's finished runs in this project, and keeps the one still going", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    await history.run(["check"], { clear: true, json: true });
    expect(JSON.parse(printed.join("\n"))).toEqual({ cleared: ["aaa111aaa111"], running: ["aaa333aaa333"] });
    expect(await ids()).toEqual(["aaa222aaa222", "aaa333aaa333", "bbb111bbb111"]);
  });

  it("clears one run by its id, from anywhere", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(tmpdir());
    await history.run(["bbb111"], { clear: true });
    expect(await ids()).toEqual(["aaa111aaa111", "aaa222aaa222", "aaa333aaa333"]);
  });

  it("clears this project's runs, or every project's with --all", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    await history.run([], { clear: true });
    expect(await ids()).toEqual(["aaa333aaa333", "bbb111bbb111"]);
    await history.run([], { clear: true, all: true });
    expect(await ids()).toEqual(["aaa333aaa333"]);
  });

  it("outside a project, asks for a run or --all rather than guess", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(tmpdir());
    await expect(history.run([], { clear: true })).rejects.toMatchObject({ code: "NO_TARGET" });
  });
});

describe("wisp hook", () => {
  it("runs a pipeline that asks first without asking, and says so", async () => {
    const before = process.cwd();
    execFileSync("git", ["init", "-q", dir]);
    await writeFile(file, JSON.stringify({ name: "Shop", pipelines: [{ label: "Ship", confirm: "Ship it?", inputs: { env: {}, tag: { default: "latest" } }, steps: [{ run: "true {{env}} {{tag}}", finishes: true }] }] }));
    process.chdir(dir);
    try {
      await hook.run(["pre-push", "ship"], {});
    } finally {
      process.chdir(before);
    }
    expect(await readFile(join(dir, ".git", "hooks", "pre-push"), "utf8")).toMatch(/wisp use '.*' 'Ship' --yes\n/);
    expect(printed.join("\n")).toContain("it asks before it runs (Ship it?); from the hook it runs without asking");
    expect(printed.join("\n")).toContain("a hook can't answer env: give it a default, or the pre-push stops");
  });
});
