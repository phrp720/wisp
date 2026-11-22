import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getNotify, setNotify } from "../../src/core/config.js";
import { addWebhook, describeEnd, failingWebhooks, lastDelivery, maskWebhook, readDeliveries, webhookKind, notifyRunEnd, notifyWhen, removeWebhook, sendNotification, shouldNotify, webhookProblem, webhookRequest, webhooksFor, type RunEnd } from "../../src/core/notify.js";
import { configPath } from "../../src/core/paths.js";

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

  it("tells you once when a pipeline starts failing, and once when it works again", () => {
    expect(shouldNotify(failed, "changes")).toBe(true);
    expect(shouldNotify({ ...failed, previousOk: true }, "changes")).toBe(true);
    expect(shouldNotify({ ...failed, previousOk: false }, "changes")).toBe(false);
    expect(shouldNotify({ ...failed, ok: true, previousOk: false }, "changes")).toBe(true);
    expect(shouldNotify({ ...failed, ok: true, previousOk: true }, "changes")).toBe(false);
    expect(shouldNotify({ ...failed, ok: true }, "changes")).toBe(false);
    expect(shouldNotify({ ...failed, watched: true }, "changes")).toBe(false);
  });

  it("tells you a run you missed was cancelled, but never counts a cancel as a change", () => {
    const cancelled = { ...failed, cancelled: true };
    expect(shouldNotify(cancelled, "failures")).toBe(true);
    expect(shouldNotify(cancelled, "all")).toBe(true);
    expect(shouldNotify({ ...cancelled, watched: true }, "failures")).toBe(false);
    expect(shouldNotify(cancelled, "changes")).toBe(false);
    expect(shouldNotify({ ...cancelled, previousOk: true }, "changes")).toBe(false);
  });

  it("says a cancelled run was cancelled, where, and paints it grey, not red", () => {
    const cancelled: RunEnd = { ...failed, cancelled: true, error: "you stopped the run" };
    expect(describeEnd(cancelled)).toEqual({ title: "⊘ Backup was cancelled", message: "at dump · Ops · wisp history abc123" });
    const slack = JSON.parse(webhookRequest("https://hooks.slack.com/services/x", cancelled, "web-1").body);
    expect(slack.attachments[0].color).toBe("#9aa0a6");
    expect(slack.attachments[0].blocks[1].fields[1]).toEqual({ type: "mrkdwn", text: "*Stopped at*\ndump" });
    expect(slack.attachments[0].blocks).toHaveLength(3);
    expect(JSON.parse(webhookRequest("https://discord.com/api/webhooks/1/x", cancelled, "web-1").body).embeds[0].color).toBe(0x9aa0a6);
    expect(JSON.parse(webhookRequest("https://ntfy.sh/acme", cancelled, "web-1").body).tags).toEqual(["no_entry_sign"]);
    expect(JSON.parse(webhookRequest("https://example.com/hook", cancelled, "web-1").body)).toMatchObject({ ok: false, cancelled: true, failedStep: "dump" });
  });

  it("takes WISP_NOTIFY over the setting", () => {
    expect(notifyWhen({}, { WISP_NOTIFY: "changes" })).toBe("changes");
    expect(notifyWhen({ when: "all" }, { WISP_NOTIFY: "off" })).toBe("off");
    expect(notifyWhen({}, {})).toBe("failures");
  });
});

describe("what it says", () => {
  it("names the pipeline, the step that failed, the workspace and the run", () => {
    expect(describeEnd(failed)).toEqual({ title: "✗ Backup failed", message: "at dump · Ops · wisp history abc123" });
  });

  it("says a pipeline works again when the run before it failed", () => {
    expect(describeEnd({ ...failed, ok: true, previousOk: false }).title).toBe("✓ Backup works again");
    expect(describeEnd({ ...failed, ok: true, previousOk: true }).title).toBe("✓ Backup finished");
  });

  it("says why the step failed, on one short line", () => {
    expect(describeEnd({ ...failed, error: "exited with code 1" }).message).toBe("at dump: exited with code 1 · Ops · wisp history abc123");
    expect(describeEnd({ ...failed, error: "line one\n  line two" }).message).toMatch(/^at dump: line one line two ·/);
    expect(describeEnd({ ...failed, error: "x".repeat(500) }).message).toMatch(/^at dump: x{199}… ·/);
  });

  it("knows Slack, Discord, Teams and ntfy by their addresses", () => {
    expect(webhookKind("https://hooks.slack.com/services/x")).toBe("slack");
    expect(webhookKind("https://discord.com/api/webhooks/1/x")).toBe("discord");
    expect(webhookKind("https://prod-12.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=x")).toBe("teams");
    expect(webhookKind("https://default1a2b.c3.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke")).toBe("teams");
    expect(webhookKind("https://acme.webhook.office.com/webhookb2/x")).toBe("teams");
    expect(webhookKind("https://prod-12.westus.logic.azure.com/other")).toBe("json");
    expect(webhookKind("https://ntfy.sh/acme")).toBe("ntfy");
    expect(webhookKind("https://example.com/hook")).toBe("json");
  });

  const broken: RunEnd = { ...failed, error: "exited with code 1 <&>" };

  it("gives Slack a coloured card, and keeps the plain text for the phone notification", () => {
    const body = JSON.parse(webhookRequest("https://hooks.slack.com/services/x", broken, "web-1").body);
    expect(body.text).toBe("✗ Backup failed on web-1\nat dump: exited with code 1 <&> · Ops · wisp history abc123");
    expect(body.attachments[0].color).toBe("#e01e5a");
    expect(body.attachments[0].blocks).toEqual([
      { type: "header", text: { type: "plain_text", text: "✗ Backup failed", emoji: true } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: "*Workspace*\nOps" },
          { type: "mrkdwn", text: "*Failed at*\ndump" },
          { type: "mrkdwn", text: "*Host*\nweb-1" },
          { type: "mrkdwn", text: "*Took*\n2s" },
        ],
      },
      { type: "section", text: { type: "mrkdwn", text: "```exited with code 1 &lt;&amp;&gt;```" } },
      { type: "context", elements: [{ type: "mrkdwn", text: "`wisp history abc123`" }] },
    ]);
    expect(JSON.parse(webhookRequest("https://hooks.slack.com/services/x", { ...failed, ok: true, failedStep: undefined }, "web-1").body).attachments[0].color).toBe("#2eb67d");
  });

  it("gives Discord an embed", () => {
    const now = new Date("2026-11-22T03:00:00.000Z");
    expect(JSON.parse(webhookRequest("https://discord.com/api/webhooks/1/x", broken, "web-1", now).body)).toEqual({
      embeds: [
        {
          title: "✗ Backup failed",
          color: 0xe01e5a,
          description: "```\nexited with code 1 <&>\n```",
          fields: [
            { name: "Workspace", value: "Ops", inline: true },
            { name: "Failed at", value: "dump", inline: true },
            { name: "Took", value: "2s", inline: true },
          ],
          footer: { text: "web-1 · wisp history abc123" },
          timestamp: "2026-11-22T03:00:00.000Z",
        },
      ],
    });
  });

  it("gives Teams an Adaptive Card", () => {
    const body = JSON.parse(webhookRequest("https://prod-12.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke", broken, "web-1").body);
    expect(body.type).toBe("message");
    expect(body.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(body.attachments[0].content).toMatchObject({ type: "AdaptiveCard", version: "1.4" });
    expect(body.attachments[0].content.body).toEqual([
      { type: "TextBlock", text: "✗ Backup failed", weight: "Bolder", size: "Medium", color: "Attention", wrap: true },
      {
        type: "FactSet",
        facts: [
          { title: "Workspace", value: "Ops" },
          { title: "Failed at", value: "dump" },
          { title: "Host", value: "web-1" },
          { title: "Took", value: "2s" },
        ],
      },
      { type: "TextBlock", text: "exited with code 1 <&>", fontType: "Monospace", wrap: true },
      { type: "TextBlock", text: "wisp history abc123", isSubtle: true, size: "Small", fontType: "Monospace", wrap: true },
    ]);
  });

  it("gives ntfy a title and a tag, and anything else plain JSON", () => {
    const ntfy = webhookRequest("https://ntfy.sh/acme-ops", broken, "web-1");
    expect(ntfy.url).toBe("https://ntfy.sh/");
    expect(JSON.parse(ntfy.body)).toMatchObject({ topic: "acme-ops", title: "✗ Backup failed on web-1", message: "at dump: exited with code 1 <&> · Ops · wisp history abc123", tags: ["x"] });
    expect(JSON.parse(webhookRequest("https://example.com/hook", broken, "web-1").body)).toMatchObject({ ok: false, pipeline: "Backup", failedStep: "dump", error: "exited with code 1 <&>", history: "abc123", host: "web-1", durationMs: 2000 });
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
    expect(await sendNotification(failed, { environment: { ...desktop, gui: false }, settings: { webhooks: [{ url: "http://example.com/hook" }] } })).toEqual([expect.stringMatching(/^http:\/\/example\.com\/…: https:\/\/ only/)]);
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
      expect(await sendNotification(failed, { platform, environment: desktop, settings: { webhooks: [{ url: webhook }] } })).toEqual([]);
      expect(JSON.parse(received[0] as string)).toMatchObject({ pipeline: "Backup", ok: false });
      expect(shown).toEqual(["✗ Backup failed | at dump · Ops · wisp history abc123"]);
      expect(await sendNotification(failed, { platform, environment: { ...desktop, gui: false }, settings: { webhooks: [{ url: webhook }] } })).toEqual([`http://127.0.0.1:${port}/…: 500 Internal Server Error`]);
      expect(await sendNotification({ ...failed, workspaceFile: "/dev/shop/.wisp.json" }, { environment: { ...desktop, gui: false }, settings: { webhooks: [{ url: webhook, workspaces: ["/dev/ops/.wisp.json"] }] } })).toEqual([]);
      expect(received).toHaveLength(2);
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
    expect(await getNotify()).toEqual({ when: "off", webhooks: [] });
    expect(await setNotify({ when: "changes", webhooks: [{ url: "https://ntfy.sh/x" }] })).toEqual({ when: "changes", webhooks: [{ url: "https://ntfy.sh/x" }] });
    expect(await getNotify()).toEqual({ when: "changes", webhooks: [{ url: "https://ntfy.sh/x" }] });
  });

  it("reads a single webhook from older settings as the first of the list", async () => {
    await mkdir(dirname(configPath()), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ version: 1, notify: { when: "all", webhook: "https://ntfy.sh/old", webhooks: [{ url: "https://discord.com/api/webhooks/1", workspaces: ["/dev/shop/.wisp.json"] }] } }));
    expect(await getNotify()).toEqual({ when: "all", webhooks: [{ url: "https://ntfy.sh/old" }, { url: "https://discord.com/api/webhooks/1", workspaces: ["/dev/shop/.wisp.json"] }] });
  });
});

describe("keeping the secret out of sight", () => {
  it("shows a webhook without the part of its address that is the secret", () => {
    expect(maskWebhook("https://hooks.slack.com/services/T000/B000/abcdefghWXYZ")).toBe("https://hooks.slack.com/services/…WXYZ");
    expect(maskWebhook("https://discord.com/api/webhooks/123/tokentokenABCD")).toBe("https://discord.com/api/…ABCD");
    expect(maskWebhook("https://prod-1.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=secretSIGN")).toBe("https://prod-1.westus.logic.azure.com/workflows/…SIGN");
    expect(maskWebhook("https://ntfy.sh/acme-ops")).toBe("https://ntfy.sh/…");
    expect(maskWebhook("https://ntfy.sh/a-much-longer-topic")).toBe("https://ntfy.sh/…opic");
    expect(maskWebhook("https://example.com")).toBe("https://example.com");
  });

  it("says a webhook is for every workspace by its number, not its address", () => {
    expect(() => removeWebhook([{ url: "https://ntfy.sh/secret-topic" }], "1", ["/dev/shop/.wisp.json"])).toThrow(/^Webhook 1 \(https:\/\/ntfy\.sh\/…opic\) is for every workspace$/);
  });
});

describe("remembering what was delivered", () => {
  it("keeps each webhook's last delivery, without its address, and forgets removed webhooks", async () => {
    const elsewhere = "https://ntfy.sh/other-workspace";
    const server = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const gone = `http://127.0.0.1:${port}/hook`;
    const quiet = { environment: { ...desktop, gui: false } };
    try {
      await sendNotification(failed, { ...quiet, settings: { webhooks: [{ url: gone }, { url: "http://example.com/x" }] } });
      const first = await readDeliveries();
      expect(lastDelivery(first, gone)).toMatchObject({ ok: false, problem: "404 Not Found" });
      expect(lastDelivery(first, "http://example.com/x")).toMatchObject({ ok: false, problem: expect.stringMatching(/https:\/\/ only/) });
      expect(JSON.stringify(first)).not.toContain("127.0.0.1");
      await sendNotification(failed, { ...quiet, settings: { webhooks: [{ url: gone }, { url: elsewhere, workspaces: ["/elsewhere/.wisp.json"] }] } });
      const second = await readDeliveries();
      expect(lastDelivery(second, "http://example.com/x")).toBeUndefined();
      expect(lastDelivery(second, gone)).toMatchObject({ ok: false });
      const closed = createServer();
      await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
      const nobody = `http://127.0.0.1:${(closed.address() as { port: number }).port}/closed`;
      await new Promise<void>((resolve) => closed.close(() => resolve()));
      await sendNotification(failed, { ...quiet, settings: { webhooks: [{ url: nobody }] } });
      expect(lastDelivery(await readDeliveries(), nobody)).toMatchObject({ ok: false, problem: "nothing is listening there" });
      expect(failingWebhooks([{ url: gone }, { url: nobody }, { url: "https://ntfy.sh/never-sent" }], await readDeliveries())).toEqual([{ url: nobody }]);
    } finally {
      server.close();
    }
  });
});

describe("which webhooks", () => {
  const shop = "/dev/shop/.wisp.json";
  const ops = "/dev/ops/.wisp.json";

  it("sends a run to the webhooks for every workspace, and to those for its own", () => {
    const hooks = [{ url: "https://ntfy.sh/all" }, { url: "https://hooks.slack.com/shop", workspaces: [shop] }, { url: "https://discord.com/ops", workspaces: [ops, shop] }];
    expect(webhooksFor(hooks, shop)).toEqual(["https://ntfy.sh/all", "https://hooks.slack.com/shop", "https://discord.com/ops"]);
    expect(webhooksFor(hooks, ops)).toEqual(["https://ntfy.sh/all", "https://discord.com/ops"]);
    expect(webhooksFor(hooks, undefined)).toEqual(["https://ntfy.sh/all"]);
  });

  it("adds a webhook, widens it with more workspaces, and refuses one that isn't https", () => {
    let hooks = addWebhook([], "https://hooks.slack.com/x", [shop]);
    expect(hooks).toEqual([{ url: "https://hooks.slack.com/x", workspaces: [shop] }]);
    hooks = addWebhook(hooks, "https://hooks.slack.com/x", [ops, shop]);
    expect(hooks).toEqual([{ url: "https://hooks.slack.com/x", workspaces: [shop, ops] }]);
    expect(addWebhook(hooks, "https://hooks.slack.com/x")).toEqual([{ url: "https://hooks.slack.com/x" }]);
    expect(addWebhook([{ url: "https://ntfy.sh/all" }], "https://ntfy.sh/all", [shop])).toEqual([{ url: "https://ntfy.sh/all" }]);
    expect(() => addWebhook([], "http://hooks.slack.com/x")).toThrow(/https:\/\/ only/);
  });

  it("removes a webhook by address or number, or only some of its workspaces", () => {
    const hooks = [{ url: "https://ntfy.sh/all" }, { url: "https://hooks.slack.com/x", workspaces: [shop, ops] }];
    expect(removeWebhook(hooks, "1")).toEqual([hooks[1]]);
    expect(removeWebhook(hooks, "https://hooks.slack.com/x", [shop])).toEqual([hooks[0], { url: "https://hooks.slack.com/x", workspaces: [ops] }]);
    expect(removeWebhook(hooks, "2", [shop, ops])).toEqual([hooks[0]]);
    expect(() => removeWebhook(hooks, "3")).toThrow("No webhook number 3");
    expect(() => removeWebhook(hooks, "https://ntfy.sh/all", [shop])).toThrow("is for every workspace");
  });
});
