import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readProjectFile } from "../../../src/core/project/index.js";
import { trust } from "../../../src/cli/commands/trust.js";

let dir: string;
let file: string;
let stdout: string[];
let stderr: string[];
let wasTTY: boolean | undefined;

const setTTY = (value: boolean) => Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "wisp-trust-")));
  process.env["WISP_HOME"] = join(dir, "home");
  file = join(dir, ".wisp.json");
  await writeFile(file, JSON.stringify({ name: "Shop", pipelines: [{ label: "Check", steps: [{ run: "pnpm test", finishes: true }] }] }));
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void stdout.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void stderr.push(args.join(" ")));
  wasTTY = process.stdin.isTTY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  setTTY(wasTTY ?? false);
  delete process.env["WISP_HOME"];
  await rm(dir, { recursive: true, force: true });
});

describe("wisp trust without a terminal", () => {
  it("refuses even with --yes, and trusts nothing", async () => {
    setTTY(false);
    await expect(trust.run([file], { yes: true })).rejects.toMatchObject({ code: "NEEDS_CONFIRMATION" });
    expect((await readProjectFile(file)).trust).toBe("untrusted");
  });

  it("never suggests --yes as the way around it", async () => {
    setTTY(false);
    await expect(trust.run([file], {})).rejects.toSatisfy((error: Error) => !error.message.includes("--yes"));
  });
});

describe("wisp trust --json", () => {
  it("keeps stdout to the JSON, with the list it grants on stderr", async () => {
    setTTY(true);
    await trust.run([file], { yes: true, json: true });
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ path: file, trusted: true, changed: true });
    expect(stderr.join("\n")).toContain("pnpm test");
  });

  it("asks nothing without --yes", async () => {
    setTTY(true);
    await expect(trust.run([file], { json: true })).rejects.toMatchObject({ code: "NEEDS_CONFIRMATION" });
    expect(stdout).toEqual([]);
  });

  it("answers in JSON when the file is trusted already", async () => {
    setTTY(true);
    await trust.run([file], { yes: true });
    stdout.length = 0;
    await trust.run([file], { json: true });
    expect(JSON.parse(stdout.join("\n"))).toEqual({ path: file, trusted: true, changed: false });
  });

  it("answers in JSON when there is nothing to trust", async () => {
    await writeFile(file, JSON.stringify({ name: "Shop", pipelines: [{ label: "Docs", steps: [{ link: "https://example.com" }] }] }));
    await trust.run([file], { json: true });
    expect(JSON.parse(stdout.join("\n"))).toEqual({ path: file, trusted: false, changed: false, runsCode: false });
  });
});

describe("wisp trust after the file changed", () => {
  it("shows what changed since it was last trusted, before the list it grants", async () => {
    setTTY(true);
    await trust.run([file], { yes: true });
    await writeFile(file, JSON.stringify({ name: "Shop", pipelines: [{ label: "Check", steps: [{ run: "pnpm test --coverage", finishes: true }] }] }));
    stdout.length = 0;
    await trust.run([file], { yes: true });
    const text = stdout.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
    expect(text).toContain("Changed since you trusted it");
    expect(text).toContain('-           "run": "pnpm test",');
    expect(text).toContain('+           "run": "pnpm test --coverage",');
    expect(text.indexOf("Changed since")).toBeLessThan(text.indexOf("Would allow"));
  });

  it("shows no diff to a file trusted for the first time", async () => {
    setTTY(true);
    await trust.run([file], { yes: true });
    expect(stdout.join("\n")).not.toContain("Changed since");
  });
});
