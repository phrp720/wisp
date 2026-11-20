import { hostname } from "node:os";

import type { Platform } from "../platform/types.js";
import { getNotify } from "./config.js";
import type { Environment } from "./environment.js";
import type { NotifySettings, NotifyWhen } from "./types.js";

export const LONG_RUN_MS = 30_000;

export interface RunEnd {
  ok: boolean;
  bolt: string;
  workspace: string;
  failedStep?: string;
  historyId?: string;
  durationMs: number;
  watched: boolean;
}

export function shouldNotify(end: RunEnd, when: NotifyWhen): boolean {
  if (when === "off" || (end.ok && when !== "all")) return false;
  return !end.watched || end.durationMs >= LONG_RUN_MS;
}

export function notifyWhen(settings: NotifySettings, env: NodeJS.ProcessEnv = process.env): NotifyWhen {
  const override = env["WISP_NOTIFY"]?.trim().toLowerCase();
  if (override === "off" || override === "failures" || override === "all") return override;
  return settings.when ?? "failures";
}

export function describeEnd(end: RunEnd): { title: string; message: string } {
  return {
    title: end.ok ? `✓ ${end.bolt} finished` : `✗ ${end.bolt} failed`,
    message: [end.failedStep ? `at ${end.failedStep}` : "", end.workspace, end.historyId ? `wisp history ${end.historyId}` : ""].filter(Boolean).join(" · "),
  };
}

export function webhookProblem(url: string): string | undefined {
  if (!URL.canParse(url)) return "a web address, starting with https://";
  const target = new URL(url);
  if (target.protocol === "https:") return undefined;
  if (target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) return undefined;
  return "https:// only, so the message and the secret in the address travel encrypted (http:// is fine to localhost)";
}

export function webhookRequest(url: string, end: RunEnd, host = hostname()): { url: string; body: string; headers: Record<string, string> } {
  const { title, message } = describeEnd(end);
  const text = `${title} on ${host}\n${message}`;
  const target = new URL(url);
  const json = { "content-type": "application/json" };
  if (/(^|\.)slack\.com$/.test(target.hostname)) return { url, headers: json, body: JSON.stringify({ text }) };
  if (/(^|\.)discord(app)?\.com$/.test(target.hostname)) return { url, headers: json, body: JSON.stringify({ content: text }) };
  if (/(^|\.)ntfy\./.test(target.hostname) || target.hostname === "ntfy.sh") {
    const segments = target.pathname.split("/").filter(Boolean);
    const topic = segments.pop() ?? "";
    const base = new URL(`/${segments.join("/")}`, target.origin).toString();
    return { url: base, headers: json, body: JSON.stringify({ topic, title: `${title} on ${host}`, message, tags: [end.ok ? "white_check_mark" : "x"] }) };
  }
  return {
    url,
    headers: json,
    body: JSON.stringify({
      text,
      ok: end.ok,
      bolt: end.bolt,
      workspace: end.workspace,
      ...(end.failedStep ? { failedStep: end.failedStep } : {}),
      ...(end.historyId ? { history: end.historyId } : {}),
      host,
    }),
  };
}

export async function sendNotification(end: RunEnd, deps: { platform?: Platform; environment: Environment; settings: NotifySettings }): Promise<string[]> {
  const problems: string[] = [];
  const { title, message } = describeEnd(end);
  const sends: Promise<void>[] = [];
  if (deps.platform?.notify && deps.environment.gui && !deps.environment.ssh) {
    sends.push(deps.platform.notify(title, message).catch((error: unknown) => void problems.push(`desktop: ${error instanceof Error ? error.message : String(error)}`)));
  }
  const refused = deps.settings.webhook ? webhookProblem(deps.settings.webhook) : undefined;
  if (refused) problems.push(`webhook: ${refused}`);
  else if (deps.settings.webhook) {
    const request = webhookRequest(deps.settings.webhook, end);
    sends.push(
      fetch(request.url, { method: "POST", headers: request.headers, body: request.body, signal: AbortSignal.timeout(5000) })
        .then((response) => {
          if (!response.ok) problems.push(`webhook: ${response.status} ${response.statusText}`);
        })
        .catch((error: unknown) => void problems.push(`webhook: ${error instanceof Error ? error.message : String(error)}`)),
    );
  }
  await Promise.all(sends);
  return problems;
}

export async function notifyRunEnd(end: RunEnd, deps: { platform?: Platform; environment: Environment }): Promise<void> {
  const settings = await getNotify().catch((): NotifySettings => ({}));
  if (!shouldNotify(end, notifyWhen(settings))) return;
  await sendNotification(end, { ...deps, settings });
}
