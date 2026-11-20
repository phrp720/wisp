import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getNotify, setNotify } from "./config.js";
import { describeEnd, notifyRunEnd, notifyWhen, sendNotification, shouldNotify, webhookProblem, webhookRequest, type RunEnd } from "./notify.js";

const failed: RunEnd = { ok: false, bolt: "Backup", workspace: "Ops", failedStep: "dump", historyId: "abc123", durationMs: 2000, watched: false };
const desktop = { os: "darwin" as const, gui: true, ssh: false };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wisp-notify-"));
  process.env["WISP_HOME"] = join(dir, "home");
});

afterEach(async () => {
  delete process.env["WISP_HOME"];
  process.env["WISP_NOTIFY"] = "off";
  await rm(dir, { recursive: true, force: true });
});

describe("when to tell you", () => {
  it("tells you about a failure nobody watched, or one that took a while", () => {
    expect(shouldNotify(failed, "failures")).toBe(true);
    expect(shouldNotify({ ...failed, watched: true }, "failures")).toBe(false);
    expect(shouldNotify({ ...failed, watched: true, durationMs: 45_000 }, "failures")).toBe(true);
  });

  it("tells you about runs that passed only when asked to, and nothing when off", () => {
    expect(shouldNotify({ ...failed, ok: true }, "failures")).toBe(false);
    expect(shouldNotify({ ...failed, ok: true }, "all")).toBe(true);
    expect(shouldNotify(failed, "off")).toBe(false);
  });

  it("takes WISP_NOTIFY over the setting", () => {
    expect(notifyWhen({ when: "all" }, { WISP_NOTIFY: "off" })).toBe("off");
    expect(notifyWhen({}, {})).toBe("failures");
  });
});

describe("what it says", () => {
  it("names the bolt, the step that failed, the workspace and the run", () => {
    expect(describeEnd(failed)).toEqual({ title: "✗ Backup failed", message: "at dump · Ops · wisp history abc123" });
  });

  it("speaks each webhook's language: Slack, Discord, ntfy, and plain JSON for the rest", () => {
    expect(JSON.parse(webhookRequest("https://hooks.slack.com/services/x", failed, "web-1").body)).toEqual({ text: "✗ Backup failed on web-1\nat dump · Ops · wisp history abc123" });
    expect(JSON.parse(webhookRequest("https://discord.com/api/webhooks/1/x", failed, "web-1").body)).toHaveProperty("content");
    const ntfy = webhookRequest("https://ntfy.sh/acme-ops", failed, "web-1");
    expect(ntfy.url).toBe("https://ntfy.sh/");
    expect(JSON.parse(ntfy.body)).toMatchObject({ topic: "acme-ops", title: "✗ Backup failed on web-1", tags: ["x"] });
    expect(JSON.parse(webhookRequest("https://example.com/hook", failed, "web-1").body)).toMatchObject({ ok: false, bolt: "Backup", failedStep: "dump", history: "abc123", host: "web-1" });
  });
});

describe("where it may send", () => {
  it("sends only over https, or plain http to this machine", () => {
    expect(webhookProblem("https://ntfy.sh/acme")).toBeUndefined();
    expect(webhookProblem("http://localhost:8080/hook")).toBeUndefined();
    expect(webhookProblem("http://127.0.0.1/hook")).toBeUndefined();
    expect(webhookProblem("http://hooks.slack.com/services/x")).toMatch(/https:\/\/ only/);
    expect(webhookProblem("ntfy.sh/acme")).toBe("a web address, starting with https://");
  });

  it("refuses to send to a plain http address written into the settings by hand", async () => {
    expect(await sendNotification(failed, { environment: { ...desktop, gui: false }, settings: { webhook: "http://example.com/hook" } })).toEqual([expect.stringMatching(/^webhook: https:\/\/ only/)]);
  });
});

describe("sending", () => {
  it("posts to the webhook and shows a desktop notification, and reports what went wrong without throwing", async () => {
    const received: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push(body);
        response.statusCode = received.length === 1 ? 200 : 500;
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const shown: string[] = [];
    const platform = { os: "darwin" as const, notify: async (title: string, message: string) => void shown.push(`${title} | ${message}`) } as never;
    try {
      const webhook = `http://127.0.0.1:${port}/hook`;
      expect(await sendNotification(failed, { platform, environment: desktop, settings: { webhook } })).toEqual([]);
      expect(JSON.parse(received[0] as string)).toMatchObject({ bolt: "Backup", ok: false });
      expect(shown).toEqual(["✗ Backup failed | at dump · Ops · wisp history abc123"]);
      expect(await sendNotification(failed, { platform, environment: { ...desktop, gui: false }, settings: { webhook } })).toEqual(["webhook: 500 Internal Server Error"]);
      expect(shown).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it("reads the setting from this machine, and sends nothing when it is off", async () => {
    const shown: string[] = [];
    const platform = { os: "darwin" as const, notify: async (title: string) => void shown.push(title) } as never;
    delete process.env["WISP_NOTIFY"];
    await notifyRunEnd(failed, { platform, environment: desktop });
    expect(shown).toEqual(["✗ Backup failed"]);
    await setNotify({ when: "off" });
    await notifyRunEnd(failed, { platform, environment: desktop });
    expect(shown).toHaveLength(1);
    expect(await getNotify()).toEqual({ when: "off" });
    expect(await setNotify({ when: "failures", webhook: " https://ntfy.sh/x " })).toEqual({ when: "failures", webhook: "https://ntfy.sh/x" });
  });
});
