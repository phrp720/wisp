import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  await writeFile(file, JSON.stringify({ name: "Shop", bolts: [{ label: "Check", job: true, targets: [{ run: "pnpm test", label: "test" }, { run: "pnpm build", label: "build" }] }] }));
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

describe("a dry run of a bolt whose every step waits for trust", () => {
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
    const result = JSON.parse(printed.join("\n")) as { ok: boolean; targets: unknown[]; waitingForTrust: { label: string; value: string }[] };
    expect(result.ok).toBe(true);
    expect(result.targets).toEqual([]);
    expect(result.waitingForTrust.map((step) => `${step.label}: ${step.value}`)).toEqual(["test: pnpm test", "build: pnpm build"]);
  });

  it("still refuses to really run it", async () => {
    await expect(use.run([file, "Check"], { json: true })).rejects.toMatchObject({ code: "NOT_TRUSTED" });
  });
});
