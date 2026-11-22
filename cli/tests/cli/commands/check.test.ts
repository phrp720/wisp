import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { check } from "../../../src/cli/commands/check.js";

let dir: string;
let printed: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wisp-check-"));
  process.env["WISP_HOME"] = join(dir, "home");
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

describe("wisp check --json", () => {
  it("exits 1 when the file has errors, as the agent reference says", async () => {
    const file = join(dir, ".wisp.json");
    await writeFile(file, JSON.stringify({ pipelines: [{ label: "Dev", steps: [{ run: "true", label: "api", after: "db" }] }] }));
    await check.run([file], { json: true });
    const result = JSON.parse(printed.join("\n")) as { errors: number };
    expect(result.errors).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);
  });

  it("exits 0 when it has none", async () => {
    const file = join(dir, ".wisp.json");
    await writeFile(file, JSON.stringify({ pipelines: [{ label: "Docs", steps: [{ url: "https://example.com" }] }] }));
    await check.run([file], { json: true });
    const result = JSON.parse(printed.join("\n")) as { errors: number };
    expect(result.errors).toBe(0);
    expect(process.exitCode).toBeUndefined();
  });
});
