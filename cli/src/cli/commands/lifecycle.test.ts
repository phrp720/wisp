import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listHistory, recordHistory, type HistoryEntry } from "../../core/history.js";
import { history } from "./lifecycle.js";

let dir: string;
let file: string;
let printed: string[];

const run = (id: string, bolt: string, workspace: string, running = false): HistoryEntry => ({
  id,
  workspace,
  workspaceName: "Shop",
  bolt,
  job: true,
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
  await writeFile(file, JSON.stringify({ name: "Shop", bolts: [{ label: "Check", job: true, targets: [] }, { label: "Build", job: true, targets: [] }] }));
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

describe("wisp history --clear", () => {
  it("clears one bolt's finished runs in this project, and keeps the one still going", async () => {
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
