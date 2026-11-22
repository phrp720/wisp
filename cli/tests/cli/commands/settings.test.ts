import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordProject } from "../../../src/core/config.js";
import { notify } from "../../../src/cli/commands/settings.js";

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

const shown = () => JSON.parse(printed.join("\n")) as { when: string; webhooks: { number: number; url: string; workspaces: { name: string; file: string }[] | null; lastDelivery: unknown }[]; test?: { ok: boolean; problems: string[] } };

async function project(name: string): Promise<string> {
  const file = join(dir, name.toLowerCase(), ".wisp.json");
  await mkdir(join(dir, name.toLowerCase()), { recursive: true });
  await writeFile(file, JSON.stringify({ name, pipelines: [] }));
  return file;
}

describe("wisp notify", () => {
  it("starts at failures with no webhooks, and changes when", async () => {
    await notify.run([], { json: true });
    expect(shown()).toMatchObject({ when: "failures", webhooks: [] });
    printed.length = 0;
    await notify.run(["changes"], { json: true });
    expect(shown()).toMatchObject({ when: "changes" });
  });

  it("adds webhooks for every workspace or for some, and removes them by address, number or workspace", async () => {
    const shop = await project("Shop");
    const ops = await project("Ops");
    await notify.run(["add", "https://ntfy.sh/acme-ops"], {});
    await notify.run(["add", "https://hooks.slack.com/services/x", shop, ops], {});
    printed.length = 0;
    await notify.run([], { json: true });
    expect(shown().webhooks).toEqual([
      { number: 1, url: "https://ntfy.sh/…", workspaces: null, lastDelivery: null },
      { number: 2, url: "https://hooks.slack.com/services/…", workspaces: [expect.objectContaining({ file: expect.stringMatching(/shop/) }), expect.objectContaining({ file: expect.stringMatching(/ops/) })], lastDelivery: null },
    ]);
    printed.length = 0;
    await notify.run([], {});
    expect(printed.join("\n")).toMatch(/1 {2}https:\/\/ntfy\.sh\/… {2}every workspace\n\s+nothing sent yet/);
    expect(printed.join("\n")).not.toContain("acme-ops");
    expect(printed.join("\n")).toMatch(/2 {2}https:\/\/hooks\.slack\.com\/services\/… {2}Shop, Ops$/m);
    printed.length = 0;
    await notify.run([], { reveal: true, json: true });
    expect(shown().webhooks.map((hook) => hook.url)).toEqual(["https://ntfy.sh/acme-ops", "https://hooks.slack.com/services/x"]);

    await notify.run(["remove", "https://hooks.slack.com/services/x", shop], {});
    await notify.run(["remove", "1"], {});
    printed.length = 0;
    await notify.run([], { json: true });
    expect(shown().webhooks).toEqual([{ number: 1, url: "https://hooks.slack.com/services/…", workspaces: [expect.objectContaining({ file: expect.stringMatching(/ops/) })], lastDelivery: null }]);
  });

  it("says all workspaces when a webhook is for every one Wisp knows", async () => {
    const shop = await project("Shop");
    const ops = await project("Ops");
    await recordProject(shop);
    await recordProject(ops);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    await notify.run(["add", "https://ntfy.sh/acme-ops", shop, ops], {});
    printed.length = 0;
    await notify.run([], {});
    expect(printed.join("\n")).toMatch(/1 {2}https:\/\/ntfy\.sh\/… {2}all workspaces$/m);
  });

  it("refuses a when it doesn't know, an address that isn't one, and a webhook that isn't there", async () => {
    await expect(notify.run(["sometimes"], {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(notify.run(["add"], {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(notify.run(["add", "ntfy.sh/acme"], {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(notify.run(["add", "http://hooks.slack.com/services/x"], {})).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("https:// only") });
    await expect(notify.run(["remove", "4"], {})).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("sends a test to every webhook, even one for some workspaces, and fails when one does", async () => {
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
      await notify.run(["add", `http://127.0.0.1:${port}/hook`, await project("Shop")], {});
      printed.length = 0;
      await notify.run([], { test: true, json: true });
      expect(shown().test).toEqual({ ok: true, problems: [] });
      expect(JSON.parse(bodies[0] as string)).toMatchObject({ pipeline: "A test", ok: false });
      expect(process.exitCode).toBeUndefined();
      status = 404;
      printed.length = 0;
      await notify.run([], { test: true });
      expect(printed.join("\n")).toContain(`✗ http://127.0.0.1:${port}/…: 404 Not Found`);
      expect(printed.join("\n")).toMatch(/✗ failed \S+ ago: 404 Not Found/);
      expect(process.exitCode).toBe(1);
      printed.length = 0;
      await notify.run([], { json: true });
      expect(shown().webhooks[0]).toMatchObject({ lastDelivery: { ok: false, problem: "404 Not Found" } });
      status = 200;
      await notify.run([], { test: true });
      printed.length = 0;
      await notify.run([], {});
      expect(printed.join("\n")).toMatch(/sent \S+ ago/);
    } finally {
      server.close();
    }
  });
});
