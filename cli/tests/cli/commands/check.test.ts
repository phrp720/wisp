import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { check } from "../../../src/cli/commands/check.js";
import { trustProject } from "../../../src/core/trust.js";

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

describe("wisp check --json on a file changed since it was trusted", () => {
  it("gives the diff, so an agent can show it to the person who approves it", async () => {
    const file = join(dir, ".wisp.json");
    await writeFile(file, JSON.stringify({ name: "Shop", pipelines: [{ label: "Deploy", steps: [{ run: "./deploy.sh", finishes: true }] }] }));
    await trustProject(file);
    await writeFile(file, JSON.stringify({ name: "Shop", pipelines: [{ label: "Deploy", steps: [{ run: "./deploy.sh --force", finishes: true }] }] }));
    await check.run([file], { json: true });
    const result = JSON.parse(printed.join("\n")) as { trust: string; changedSinceTrust?: { trustedAt: string; changes: { file: string; diff: string }[] } };
    expect(result.trust).toBe("stale");
    expect(result.changedSinceTrust?.changes[0]?.diff).toContain('-           "run": "./deploy.sh",');
    expect(result.changedSinceTrust?.changes[0]?.diff).toContain('+           "run": "./deploy.sh --force",');
  });

  it("prints the same diff without --json, above what runs", async () => {
    const file = join(dir, ".wisp.json");
    await writeFile(file, JSON.stringify({ name: "Shop", pipelines: [{ label: "Deploy", steps: [{ run: "./deploy.sh", finishes: true }] }] }));
    await trustProject(file);
    await writeFile(file, JSON.stringify({ name: "Shop", pipelines: [{ label: "Deploy", steps: [{ run: "./deploy.sh --force", finishes: true }] }] }));
    await check.run([file], {});
    const text = printed.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
    expect(text).toContain('+           "run": "./deploy.sh --force",');
    expect(text.indexOf("Changed since")).toBeLessThan(text.indexOf("Runs code"));
  });

  it("leaves it out when the file is as it was trusted", async () => {
    const file = join(dir, ".wisp.json");
    await writeFile(file, JSON.stringify({ name: "Shop", pipelines: [{ label: "Deploy", steps: [{ run: "./deploy.sh", finishes: true }] }] }));
    await trustProject(file);
    await check.run([file], { json: true });
    expect(JSON.parse(printed.join("\n"))).not.toHaveProperty("changedSinceTrust");
  });
});
