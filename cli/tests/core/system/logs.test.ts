import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { failureOutput, filterLog, readLog, restartsIn } from "../../../src/core/system/processes.js";
import { RESTART_MARK } from "../../../src/core/system/shell.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wisp-logs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("filterLog", () => {
  const text = ["starting", "\u001b[31mError\u001b[0m: no db", "ok", `${RESTART_MARK} api (exited with 1) — try 1 of 10, in 1s`, "starting", "error again", "ready"].join("\n");

  it("keeps the last lines asked for", () => {
    expect(filterLog(text, { lines: 2 })).toEqual(["error again", "ready"]);
  });

  it("matches a pattern without caring about case or colours", () => {
    expect(filterLog(text, { lines: 100, grep: /error:/i })).toEqual(["\u001b[31mError\u001b[0m: no db"]);
  });

  it("keeps only the last restart and what came after it", () => {
    expect(filterLog(text, { lines: 100, sinceRestart: true })).toEqual([`${RESTART_MARK} api (exited with 1) — try 1 of 10, in 1s`, "starting", "error again", "ready"]);
  });

  it("combines both, then counts lines", () => {
    expect(filterLog(text, { lines: 100, grep: /error/i, sinceRestart: true })).toEqual(["error again"]);
  });

  it("keeps everything when the command never restarted", () => {
    expect(filterLog("a\nb", { lines: 100, sinceRestart: true })).toEqual(["a", "b"]);
  });
});

describe("readLog", () => {
  it("searches the whole log, not only its last lines", async () => {
    const file = join(dir, "1.log");
    await writeFile(file, ["needle", ...Array.from({ length: 500 }, (_, at) => `line ${at}`)].join("\n"));
    expect(await readLog(file, { lines: 10, grep: /needle/ })).toEqual(["needle"]);
  });
});

describe("failureOutput", () => {
  it("is the last 40 lines, without colours or trailing blank lines", async () => {
    const file = join(dir, "2.log");
    await writeFile(file, [...Array.from({ length: 60 }, (_, at) => `line ${at}`), "\u001b[31mFAIL\u001b[0m src/a.test.ts", "", ""].join("\n"));
    const output = (await failureOutput(file)).split("\n");
    expect(output).toHaveLength(40);
    expect(output[39]).toBe("FAIL src/a.test.ts");
    expect(output[0]).toBe("line 21");
  });

  it("is empty for a log that is missing", async () => {
    expect(await failureOutput(join(dir, "missing.log"))).toBe("");
  });
});

describe("restartsIn", () => {
  it("counts restarts and keeps the exit code of the last one", () => {
    const text = ["boot", `${RESTART_MARK} api (exited with 1) — try 1 of 10, in 1s`, "boot", `\u001b[2m${RESTART_MARK} api (exited with 137) — try 2 of 10, in 2s\u001b[0m`, "boot"].join("\n");
    expect(restartsIn(text)).toEqual({ restarts: 2, lastExit: 137 });
  });

  it("says when it gave up, and with what code", () => {
    const text = [`${RESTART_MARK} api (exited with 1) — try 10 of 10, in 30s`, "[wisp] api exited with 2 — gave up after 10 restarts"].join("\n");
    expect(restartsIn(text)).toEqual({ restarts: 1, lastExit: 2, gaveUp: true });
  });

  it("is zero for a command that never restarted", () => {
    expect(restartsIn("boot\nready")).toEqual({ restarts: 0 });
  });
});
