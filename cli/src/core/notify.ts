import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";

import type { Platform } from "../platform/types.js";
import { getNotify } from "./config.js";
import type { Environment } from "./system/environment.js";
import { describeDuration } from "./text/duration.js";
import { WispError } from "./errors.js";
import type { Notified } from "./history.js";
import { readJson, stateDir, withLock, writeJson } from "./paths.js";
import type { NotifySettings, NotifyWhen, Webhook } from "./types.js";

export const LONG_RUN_MS = 30_000;

export interface RunEnd {
  ok: boolean;
  bolt: string;
  workspace: string;
  workspaceFile?: string;
  failedStep?: string;
  error?: string;
  cancelled?: boolean;
  historyId?: string;
  durationMs: number;
  watched: boolean;
  previousOk?: boolean;
}

export function shouldNotify(end: RunEnd, when: NotifyWhen): boolean {
  if (when === "off") return false;
  if (when === "changes" && (end.cancelled || end.ok === (end.previousOk ?? true))) return false;
  if (when === "failures" && end.ok) return false;
  return !end.watched || end.durationMs >= LONG_RUN_MS;
}

export function notifyWhen(settings: NotifySettings, env: NodeJS.ProcessEnv = process.env): NotifyWhen {
  const override = env["WISP_NOTIFY"]?.trim().toLowerCase();
  if (override === "off" || override === "failures" || override === "changes" || override === "all") return override;
  return settings.when ?? "failures";
}

export function failureReason(end: RunEnd): string | undefined {
  if (end.cancelled) return undefined;
  const error = end.error?.replace(/\s+/g, " ").trim();
  if (!error) return undefined;
  return error.length > 200 ? `${error.slice(0, 199)}…` : error;
}

export function describeEnd(end: RunEnd): { title: string; message: string } {
  const reason = end.cancelled ? undefined : failureReason(end);
  const at = end.failedStep ? `at ${end.failedStep}${reason ? `: ${reason}` : ""}` : "";
  return {
    title: end.ok ? (end.previousOk === false ? `✓ ${end.bolt} works again` : `✓ ${end.bolt} finished`) : end.cancelled ? `⊘ ${end.bolt} was cancelled` : `✗ ${end.bolt} failed`,
    message: [at, end.workspace, end.historyId ? `wisp history ${end.historyId}` : ""].filter(Boolean).join(" · "),
  };
}

export function webhookProblem(url: string): string | undefined {
  if (!URL.canParse(url)) return "a web address, starting with https://";
  const target = new URL(url);
  if (target.protocol === "https:") return undefined;
  if (target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) return undefined;
  return "https:// only, so the message and the secret in the address travel encrypted (http:// is fine to localhost)";
}

export function maskWebhook(url: string): string {
  if (!URL.canParse(url)) return url;
  const target = new URL(url);
  const segments = target.pathname.split("/").filter(Boolean);
  const lead = segments.length > 1 ? `${segments[0]}/` : "";
  const secret = `${segments.slice(lead ? 1 : 0).join("/")}${target.search}`;
  if (!secret) return `${target.protocol}//${target.host}`;
  return `${target.protocol}//${target.host}/${lead}…${secret.length > 8 ? secret.slice(-4) : ""}`;
}

export interface Delivery {
  at: string;
  ok: boolean;
  problem?: string;
}

function deliveriesPath(): string {
  return join(stateDir(), "deliveries.json");
}

function deliveryKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export async function readDeliveries(): Promise<Record<string, Delivery>> {
  const parsed = await readJson(deliveriesPath()).catch(() => undefined);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Delivery>) : {};
}

export function lastDelivery(deliveries: Record<string, Delivery>, url: string): Delivery | undefined {
  return deliveries[deliveryKey(url)];
}

async function recordDeliveries(results: Map<string, Delivery>, keep: string[]): Promise<void> {
  if (results.size === 0) return;
  const path = deliveriesPath();
  await withLock(path, async () => {
    const kept = new Set(keep.map(deliveryKey));
    const current = Object.entries(await readDeliveries()).filter(([key]) => kept.has(key));
    await writeJson(path, { ...Object.fromEntries(current), ...Object.fromEntries([...results].map(([url, delivery]) => [deliveryKey(url), delivery])) });
  });
}

export function webhooksFor(webhooks: Webhook[], workspaceFile: string | undefined): string[] {
  return webhooks.filter((hook) => !hook.workspaces || (workspaceFile !== undefined && hook.workspaces.includes(workspaceFile))).map((hook) => hook.url);
}

export function findWebhook(webhooks: Webhook[], ref: string): Webhook | undefined {
  const number = /^\d+$/.test(ref) ? Number(ref) : undefined;
  return number !== undefined ? webhooks[number - 1] : webhooks.find((hook) => hook.url === ref.trim());
}

export function addWebhook(webhooks: Webhook[], url: string, workspaces: string[] = []): Webhook[] {
  const refused = webhookProblem(url);
  if (refused) throw new WispError(`"${url}": ${refused}`, "INVALID_INPUT");
  const found = webhooks.find((hook) => hook.url === url);
  if (!found) return [...webhooks, { url, ...(workspaces.length > 0 ? { workspaces } : {}) }];
  return webhooks.map((hook) => {
    if (hook !== found) return hook;
    if (workspaces.length === 0 || !hook.workspaces) return { url };
    return { url, workspaces: [...new Set([...hook.workspaces, ...workspaces])] };
  });
}

export function removeWebhook(webhooks: Webhook[], ref: string, workspaces: string[] = []): Webhook[] {
  const found = findWebhook(webhooks, ref);
  if (!found) throw new WispError(`No webhook ${/^\d+$/.test(ref) ? `number ${ref}` : `"${ref}"`}`, "NOT_FOUND", "`wisp notify` lists them, numbered.");
  if (workspaces.length === 0) return webhooks.filter((hook) => hook !== found);
  if (!found.workspaces) {
    const number = webhooks.indexOf(found) + 1;
    throw new WispError(`Webhook ${number} (${maskWebhook(found.url)}) is for every workspace`, "INVALID_INPUT", `Remove it with wisp notify remove ${number}, then add it for the workspaces you want: wisp notify add <url> <workspace...>`);
  }
  const left = found.workspaces.filter((file) => !workspaces.includes(file));
  return left.length > 0 ? webhooks.map((hook) => (hook === found ? { url: hook.url, workspaces: left } : hook)) : webhooks.filter((hook) => hook !== found);
}

type WebhookKind = "slack" | "discord" | "teams" | "ntfy" | "json";

export function webhookKind(url: string): WebhookKind {
  const { hostname: host, pathname } = new URL(url);
  if (/(^|\.)slack\.com$/.test(host)) return "slack";
  if (/(^|\.)discord(app)?\.com$/.test(host)) return "discord";
  if (/(^|\.)logic\.azure\.com$/.test(host) && pathname.startsWith("/workflows/")) return "teams";
  if (/(^|\.)powerplatform\.com$/.test(host) && pathname.includes("/workflows/")) return "teams";
  if (/(^|\.)webhook\.office\.com$/.test(host)) return "teams";
  if (/(^|\.)ntfy\./.test(host) || host === "ntfy.sh") return "ntfy";
  return "json";
}

const GREEN = 0x2eb67d;
const RED = 0xe01e5a;
const GREY = 0x9aa0a6;

function colourOf(end: RunEnd): number {
  return end.ok ? GREEN : end.cancelled ? GREY : RED;
}

function facts(end: RunEnd, host: string): { name: string; value: string }[] {
  return [
    { name: "Workspace", value: end.workspace },
    ...(end.failedStep ? [{ name: end.cancelled ? "Stopped at" : "Failed at", value: end.failedStep }] : []),
    { name: "Host", value: host },
    { name: "Took", value: describeDuration(end.durationMs / 1000) },
  ];
}

function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slackBody(end: RunEnd, host: string, text: string): unknown {
  const { title } = describeEnd(end);
  const reason = failureReason(end);
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: title.slice(0, 150), emoji: true } },
    { type: "section", fields: facts(end, host).map((fact) => ({ type: "mrkdwn", text: `*${fact.name}*\n${slackEscape(fact.value)}` })) },
    ...(reason ? [{ type: "section", text: { type: "mrkdwn", text: `\`\`\`${slackEscape(reason)}\`\`\`` } }] : []),
    ...(end.historyId ? [{ type: "context", elements: [{ type: "mrkdwn", text: `\`wisp history ${end.historyId}\`` }] }] : []),
  ];
  return { text, attachments: [{ color: `#${colourOf(end).toString(16)}`, blocks }] };
}

function discordBody(end: RunEnd, host: string, now: Date): unknown {
  const { title } = describeEnd(end);
  const reason = failureReason(end);
  return {
    embeds: [
      {
        title: title.slice(0, 256),
        color: colourOf(end),
        ...(reason ? { description: `\`\`\`\n${reason.replace(/`/g, "'")}\n\`\`\`` } : {}),
        fields: facts(end, host)
          .filter((fact) => fact.name !== "Host")
          .map((fact) => ({ name: fact.name, value: fact.value.slice(0, 1024), inline: true })),
        footer: { text: [host, end.historyId ? `wisp history ${end.historyId}` : ""].filter(Boolean).join(" · ") },
        timestamp: now.toISOString(),
      },
    ],
  };
}

function teamsBody(end: RunEnd, host: string): unknown {
  const { title } = describeEnd(end);
  const reason = failureReason(end);
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          msteams: { width: "Full" },
          body: [
            { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", color: end.ok ? "Good" : end.cancelled ? "Default" : "Attention", wrap: true },
            { type: "FactSet", facts: facts(end, host).map((fact) => ({ title: fact.name, value: fact.value })) },
            ...(reason ? [{ type: "TextBlock", text: reason, fontType: "Monospace", wrap: true }] : []),
            ...(end.historyId ? [{ type: "TextBlock", text: `wisp history ${end.historyId}`, isSubtle: true, size: "Small", fontType: "Monospace", wrap: true }] : []),
          ],
        },
      },
    ],
  };
}

export function webhookRequest(url: string, end: RunEnd, host = hostname(), now = new Date()): { url: string; body: string; headers: Record<string, string> } {
  const { title, message } = describeEnd(end);
  const text = `${title} on ${host}\n${message}`;
  const headers = { "content-type": "application/json" };
  const kind = webhookKind(url);
  if (kind === "slack") return { url, headers, body: JSON.stringify(slackBody(end, host, text)) };
  if (kind === "discord") return { url, headers, body: JSON.stringify(discordBody(end, host, now)) };
  if (kind === "teams") return { url, headers, body: JSON.stringify(teamsBody(end, host)) };
  if (kind === "ntfy") {
    const target = new URL(url);
    const segments = target.pathname.split("/").filter(Boolean);
    const topic = segments.pop() ?? "";
    const base = new URL(`/${segments.join("/")}`, target.origin).toString();
    return { url: base, headers, body: JSON.stringify({ topic, title: `${title} on ${host}`, message, tags: [end.ok ? "white_check_mark" : end.cancelled ? "no_entry_sign" : "x"] }) };
  }
  const reason = failureReason(end);
  return {
    url,
    headers,
    body: JSON.stringify({
      text,
      ok: end.ok,
      ...(end.cancelled ? { cancelled: true } : {}),
      pipeline: end.bolt,
      workspace: end.workspace,
      ...(end.failedStep ? { failedStep: end.failedStep } : {}),
      ...(reason ? { error: reason } : {}),
      ...(end.historyId ? { history: end.historyId } : {}),
      host,
      durationMs: end.durationMs,
    }),
  };
}

function fetchProblem(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError") return "no answer in 5s";
  const cause = error.cause as { code?: string; message?: string } | undefined;
  if (cause?.code === "ECONNREFUSED") return "nothing is listening there";
  if (cause?.code === "ENOTFOUND") return "no such host";
  return cause?.message ?? error.message;
}

export async function sendNotification(end: RunEnd, deps: { platform?: Platform; environment: Environment; settings: NotifySettings }): Promise<string[]> {
  return (await deliver(end, deps)).problems;
}

async function deliver(end: RunEnd, deps: { platform?: Platform; environment: Environment; settings: NotifySettings }): Promise<{ problems: string[]; sent: Notified[] }> {
  const problems: string[] = [];
  const { title, message } = describeEnd(end);
  const sends: Promise<void>[] = [];
  if (deps.platform?.notify && deps.environment.gui && !deps.environment.ssh) {
    sends.push(deps.platform.notify(title, message).catch((error: unknown) => void problems.push(`desktop: ${error instanceof Error ? error.message : String(error)}`)));
  }
  const results = new Map<string, Delivery>();
  const settle = (url: string, problem?: string) => {
    results.set(url, { at: new Date().toISOString(), ok: problem === undefined, ...(problem !== undefined ? { problem } : {}) });
    if (problem !== undefined) problems.push(`${maskWebhook(url)}: ${problem}`);
  };
  for (const url of webhooksFor(deps.settings.webhooks ?? [], end.workspaceFile)) {
    const refused = webhookProblem(url);
    if (refused) {
      settle(url, refused);
      continue;
    }
    const request = webhookRequest(url, end);
    sends.push(
      fetch(request.url, { method: "POST", headers: request.headers, body: request.body, signal: AbortSignal.timeout(5000) })
        .then((response) => settle(url, response.ok ? undefined : `${response.status} ${response.statusText}`.trim()))
        .catch((error: unknown) => settle(url, fetchProblem(error))),
    );
  }
  await Promise.all(sends);
  await recordDeliveries(
    results,
    (deps.settings.webhooks ?? []).map((hook) => hook.url),
  ).catch(() => undefined);
  const sent = [...results].map(([url, delivery]): Notified => ({ url: maskWebhook(url), ok: delivery.ok, ...(delivery.problem !== undefined ? { problem: delivery.problem } : {}) }));
  return { problems, sent };
}

export async function notifyRunEnd(end: RunEnd, deps: { platform?: Platform; environment: Environment }): Promise<Notified[]> {
  const settings = await getNotify().catch((): NotifySettings => ({}));
  if (!shouldNotify(end, notifyWhen(settings))) return [];
  return (await deliver(end, { ...deps, settings })).sent;
}

export function failingWebhooks(webhooks: Webhook[], deliveries: Record<string, Delivery>): Webhook[] {
  return webhooks.filter((hook) => lastDelivery(deliveries, hook.url)?.ok === false);
}
