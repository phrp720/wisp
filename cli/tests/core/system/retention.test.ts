import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stateDir } from "../../../src/core/paths.js";
import { tidyState, trimLog } from "../../../src/core/system/processes.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wisp-retention-"));
  process.env["WISP_HOME"] = join(dir, "home");
  await mkdir(join(stateDir(), "logs"), { recursive: true });
  await mkdir(join(stateDir(), "history"), { recursive: true });
});

afterEach(async () => {
  delete process.env["WISP_HOME"];
  await rm(dir, { recursive: true, force: true });
});

const logs = () => join(stateDir(), "logs");
/** A file, made `hoursAgo` old. */
async function file(path: string, text: string, hoursAgo = 0) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
  const at = new Date(Date.now() - hoursAgo * 3_600_000);
  await utimes(path, at, at);
}
const run = (id: string, alive: boolean) => ({ id, kind: "background", label: id, command: "x", workspace: "/w/.wisp.json", workspaceName: "W", asset: `command:${id}`, pid: alive ? process.pid : 999_999, startedAt: new Date().toISOString(), log: join(logs(), `${id}.log`) });
const historyRun = (id: string, stepLogs: string[]) => ({ id, workspace: "/w/.wisp.json", workspaceName: "W", bolt: "B", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: true, steps: stepLogs.map((log) => ({ kind: "command", label: "c", value: "c", ok: true, durationMs: 1, log })) });

describe("a log kept to its cap", () => {
  it("keeps its last part from a whole line on, under a line saying so", async () => {
    const path = join(dir, "big.log");
    const lines = Array.from({ length: 1000 }, (_, at) => `line ${at + 1}`).join("\n") + "\n";
    await writeFile(path, lines);
    expect(await trimLog(path, 4000, 1000)).toBe(true);
    const text = await readFile(path, "utf8");
    expect(text.startsWith("[wisp] earlier output trimmed")).toBe(true);
    const kept = text.split("\n").slice(1, -1);
    expect(kept.every((line) => /^line \d+$/.test(line))).toBe(true);
    expect(kept[kept.length - 1]).toBe("line 1000");
    expect(text.length).toBeLessThan(1100);
  });

  it("leaves a log under its cap as it is", async () => {
    const path = join(dir, "small.log");
    await writeFile(path, "ready\n");
    expect(await trimLog(path, 4000, 1000)).toBe(false);
    expect(await readFile(path, "utf8")).toBe("ready\n");
  });
});

describe("tidying what Wisp keeps", () => {
  it("keeps a log while Running lists it or History points to it, and deletes it after", async () => {
    await file(join(logs(), "live.log"), "serving", 48);
    await file(join(logs(), "listed.log"), "done", 48);
    await file(join(logs(), "listed.exit"), "0", 48);
    await file(join(logs(), "inhistory.log"), "built", 48);
    await file(join(logs(), "gone.log"), "old", 48);
    await file(join(logs(), "gone.exit"), "1", 48);
    await writeFile(join(stateDir(), "runs.json"), JSON.stringify({ version: 2, runs: [run("live", true), run("listed", false)] }));
    await writeFile(join(stateDir(), "history.json"), JSON.stringify({ version: 1, runs: [historyRun("h1", [join(logs(), "inhistory.log")])] }));

    await tidyState();
    expect(existsSync(join(logs(), "live.log"))).toBe(true);
    expect(existsSync(join(logs(), "listed.log"))).toBe(true);
    expect(existsSync(join(logs(), "listed.exit"))).toBe(true);
    expect(existsSync(join(logs(), "inhistory.log"))).toBe(true);
    expect(existsSync(join(logs(), "gone.log"))).toBe(false);
    expect(existsSync(join(logs(), "gone.exit"))).toBe(false);
  });

  it("leaves a new log alone, which another Wisp may be starting a command with", async () => {
    await file(join(logs(), "starting.log"), "", 0);
    await tidyState();
    expect(existsSync(join(logs(), "starting.log"))).toBe(true);
  });

  it("deletes a run's output in History once History no longer lists it", async () => {
    await file(join(stateDir(), "history", "kept", "1.log"), "ok", 48);
    await file(join(stateDir(), "history", "dropped", "1.log"), "ok", 48);
    await writeFile(join(stateDir(), "history.json"), JSON.stringify({ version: 1, runs: [historyRun("kept", [join(stateDir(), "history", "kept", "1.log")])] }));
    await tidyState();
    expect(existsSync(join(stateDir(), "history", "kept", "1.log"))).toBe(true);
    expect(existsSync(join(stateDir(), "history", "dropped"))).toBe(false);
  });

  it("past the ceiling, deletes the oldest output first, and never a running command's log", async () => {
    const kb = "x".repeat(1024);
    await file(join(logs(), "live.log"), kb.repeat(4), 72);
    await file(join(logs(), "oldest.log"), kb.repeat(4), 60);
    await file(join(stateDir(), "history", "h1", "1.log"), kb.repeat(4), 50);
    await file(join(logs(), "newest.log"), kb.repeat(4), 30);
    await writeFile(join(stateDir(), "runs.json"), JSON.stringify({ version: 2, runs: [run("live", true), run("oldest", false), run("newest", false)] }));
    await writeFile(join(stateDir(), "history.json"), JSON.stringify({ version: 1, runs: [historyRun("h1", [join(stateDir(), "history", "h1", "1.log")])] }));

    // 16 KB in all: the oldest 4 KB going brings it to the ceiling, and nothing more goes.
    await tidyState({ ceiling: 12 * 1024 });
    expect(existsSync(join(logs(), "live.log"))).toBe(true);
    expect(existsSync(join(logs(), "oldest.log"))).toBe(false);
    expect(existsSync(join(stateDir(), "history", "h1", "1.log"))).toBe(true);
    expect(existsSync(join(logs(), "newest.log"))).toBe(true);
  });
});
