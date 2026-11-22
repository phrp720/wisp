import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { use } from "./use.js";

let dir: string;
let file: string;
let printed: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wisp-use-"));
  process.env["WISP_HOME"] = join(dir, "home");
  file = join(dir, ".wisp.json");
  await writeFile(file, JSON.stringify({ name: "Shop", pipelines: [{ label: "Check", steps: [{ run: "pnpm test", label: "test", finishes: true }, { run: "pnpm build", label: "build", finishes: true }] }] }));
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void printed.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void printed.push(args.join(" ")));
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  delete process.env["WISP_HOME"];
  await rm(dir, { recursive: true, force: true });
});

describe("a dry run of a pipeline whose every step waits for trust", () => {
  it("shows what would run once allowed, and does not fail", async () => {
    await use.run([file, "Check"], { dryRun: true });
    const text = printed.join("\n");
    expect(text).toContain("every step waits for `wisp trust`. Once allowed, it would run:");
    expect(text).toContain("pnpm test");
    expect(text).toContain("pnpm build");
    expect(process.exitCode).toBeUndefined();
  });

  it("lists those steps under waitingForTrust in JSON", async () => {
    await use.run([file, "Check"], { dryRun: true, json: true });
    const result = JSON.parse(printed.join("\n")) as { ok: boolean; steps: unknown[]; waitingForTrust: { label: string; value: string }[] };
    expect(result.ok).toBe(true);
    expect(result.steps).toEqual([]);
    expect(result.waitingForTrust.map((step) => `${step.label}: ${step.value}`)).toEqual(["test: pnpm test", "build: pnpm build"]);
  });

  it("still refuses to really run it", async () => {
    await expect(use.run([file, "Check"], { json: true })).rejects.toMatchObject({ code: "NOT_TRUSTED" });
  });
});

describe("the line a run ends with", () => {
  it("says it finished when it waited for its commands and left nothing running", async () => {
    const mine = join(dir, "home", "workspaces", "Checks.json");
    await mkdir(join(dir, "home", "workspaces"), { recursive: true });
    await writeFile(mine, JSON.stringify({ name: "Checks", pipelines: [{ label: "Lint", steps: [{ run: "true", label: "lint", finishes: true }] }] }));
    await use.run([mine, "Lint"], {});
    const text = printed.join("\n");
    expect(text).toContain("✓ lint");
    expect(text).toMatch(/✓ .*Lint.* finished/);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("a pipeline that asks before it runs", () => {
  let mine: string;

  beforeEach(async () => {
    mine = join(dir, "home", "workspaces", "Ops.json");
    await mkdir(join(dir, "home", "workspaces"), { recursive: true });
    await writeFile(
      mine,
      JSON.stringify({
        name: "Ops",
        pipelines: [
          { label: "Backup", confirm: "Overwrite last night's backup?", steps: [{ run: "true", label: "dump", finishes: true }] },
          { label: "Nightly", steps: [{ pipeline: "Backup" }] },
        ],
      }),
    );
  });

  it("refuses to run without a terminal, saying what it would ask, and runs nothing", async () => {
    await expect(use.run([mine, "Backup"], { json: true })).rejects.toMatchObject({ code: "CONFIRM_NEEDED", message: expect.stringContaining("Overwrite last night's backup?") });
    await expect(use.run([mine, "Nightly"], {})).rejects.toMatchObject({ code: "CONFIRM_NEEDED" });
    expect(printed.join("\n")).not.toContain("✓ dump");
  });

  it("runs with --yes", async () => {
    await use.run([mine, "Nightly"], { yes: true });
    expect(printed.join("\n")).toContain("✓ dump");
    expect(process.exitCode).toBeUndefined();
  });

  it("does not ask for a dry run", async () => {
    await use.run([mine, "Backup"], { dryRun: true });
    expect(printed.join("\n")).toContain("true");
  });
});

describe("a pipeline with inputs", () => {
  let mine: string;
  let out: string;

  beforeEach(async () => {
    mine = join(dir, "home", "workspaces", "Ops.json");
    out = join(dir, "deployed");
    await mkdir(join(dir, "home", "workspaces"), { recursive: true });
    await writeFile(
      mine,
      JSON.stringify({
        name: "Ops",
        pipelines: [
          {
            label: "Deploy",
            inputs: { env: { ask: "Where to?", choices: ["staging", "production"] }, tag: { default: "latest" } },
            steps: [
              { run: `echo {{env}} {{tag}} >> '${out}'`, label: "deploy {{env}}", finishes: true },
              { run: `test -f '${out}.ok'`, label: "smoke test", finishes: true },
            ],
          },
        ],
      }),
    );
  });

  it("takes values from --input and defaults from the file, and keeps them with the run", async () => {
    await use.run([mine, "Deploy"], { input: ["env=production"], json: true });
    const result = JSON.parse(printed.join("\n")) as { inputs: Record<string, string>; steps: { label: string }[] };
    expect(result.inputs).toEqual({ env: "production", tag: "latest" });
    expect(result.steps[0]?.label).toBe("deploy production");
    expect(await readFile(out, "utf8")).toBe("production latest\n");
  });

  it("without a terminal, refuses to guess a value that has no default, and names the flag", async () => {
    await expect(use.run([mine, "Deploy"], {})).rejects.toMatchObject({ code: "INPUT_NEEDED", message: expect.stringContaining("--input env=…") });
    await expect(use.run([mine, "Deploy"], { input: ["env=prod"] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("dry-runs without asking, leaving what it doesn't know as written", async () => {
    await use.run([mine, "Deploy"], { dryRun: true });
    expect(printed.join("\n")).toContain("deploy {{env}}");
  });

  it("retries with the values the run had", async () => {
    await use.run([mine, "Deploy"], { input: ["env=staging", "tag=v2"] });
    expect(process.exitCode).toBe(1);
    await writeFile(`${out}.ok`, "");
    await expect(use.run([mine, "Deploy"], { retry: true, input: ["env=production"] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    process.exitCode = undefined;
    await use.run([mine, "Deploy"], { retry: true });
    expect(process.exitCode).toBeUndefined();
    expect(printed.join("\n")).toContain("✓ smoke test");
    expect(await readFile(out, "utf8")).toBe("staging v2\n");
  });
});

describe("a dry run of steps that wait for others", () => {
  it("numbers them by when they can start, says what each waits for, and heads each pipeline", async () => {
    const mine = join(dir, "home", "workspaces", "Checks.json");
    await mkdir(join(dir, "home", "workspaces"), { recursive: true });
    await writeFile(
      mine,
      JSON.stringify({
        name: "Checks",
        pipelines: [
          { label: "Database", steps: [{ run: "true", label: "db" }] },
          { label: "Check", steps: [{ pipeline: "Database", label: "db" }, { run: "true", label: "lint", after: "db", finishes: true }, { run: "true", label: "test", after: "db", finishes: true }, { run: "true", label: "build", after: ["lint", "test"], finishes: true }] },
        ],
      }),
    );
    await use.run([mine, "Check"], { dryRun: true });
    const lines = printed.join("\n").split("\n").map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
    const at = (text: string) => lines.findIndex((line) => line.includes(text));
    expect(lines[at("⚡Database")]).toBe("  ⚡Database");
    expect(lines[at("db — true")]).toMatch(/^ {4}1 ✓ run +db/);
    expect(lines[at("⚡Check")]).toBe("  ⚡Check");
    expect(lines[at("lint — true")]).toMatch(/^ {4}2 ✓ run +lint/);
    expect(lines[at("test — true")]).toMatch(/^ {4}2 ✓ run +test/);
    expect(lines[at("build — true")]).toMatch(/^ {4}3 ✓ run +build.* · after lint, test$/);
  });
});
