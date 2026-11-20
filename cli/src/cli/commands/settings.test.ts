import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { notify } from "./settings.js";

let dir: string;
let printed: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wisp-settings-"));
  process.env["WISP_HOME"] = join(dir, "home");
  process.env["WISP_HEADLESS"] = "1";
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void printed.push(args.join(" ")));
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  delete process.env["WISP_HOME"];
  delete process.env["WISP_HEADLESS"];
  await rm(dir, { recursive: true, force: true });
});

const shown = () => JSON.parse(printed.join("\n")) as { when: string; webhook: string | null; test?: { ok: boolean; problems: string[] } };

describe("wisp notify", () => {
  it("starts at failures, and changes when and where", async () => {
    await notify.run([], { json: true });
    expect(shown()).toMatchObject({ when: "failures", webhook: null });
    printed.length = 0;
    await notify.run(["all"], { webhook: "https://ntfy.sh/acme-ops", json: true });
    expect(shown()).toMatchObject({ when: "all", webhook: "https://ntfy.sh/acme-ops" });
    printed.length = 0;
    await notify.run([], { webhook: "", json: true });
    expect(shown()).toMatchObject({ when: "all", webhook: null });
  });

  it("refuses a when it doesn't know and an address that isn't one", async () => {
    await expect(notify.run(["sometimes"], {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(notify.run([], { webhook: "ntfy.sh/acme" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(notify.run([], { webhook: "http://hooks.slack.com/services/x" })).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("https:// only") });
  });

  it("sends a test to the webhook, and fails when the webhook does", async () => {
    let status = 200;
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        bodies.push(body);
        response.statusCode = status;
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      await notify.run([], { webhook: `http://127.0.0.1:${port}/hook`, test: true, json: true });
      expect(shown().test).toEqual({ ok: true, problems: [] });
      expect(JSON.parse(bodies[0] as string)).toMatchObject({ bolt: "A test", ok: false });
      expect(process.exitCode).toBeUndefined();
      status = 404;
      printed.length = 0;
      await notify.run([], { test: true });
      expect(printed.join("\n")).toContain("✗ webhook: 404 Not Found");
      expect(process.exitCode).toBe(1);
    } finally {
      server.close();
    }
  });
});
