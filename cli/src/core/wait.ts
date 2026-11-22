import { connect } from "node:net";

import { envNames, fillEnv } from "./inputs.js";
import type { WaitSpec } from "./types.js";

/** How a wait reads in a list: `port 5432`, `http://localhost:3000`, `3s`. */
export function describeWait(wait: WaitSpec): string {
  if ("seconds" in wait) return `${wait.seconds}s`;
  if ("url" in wait) return wait.status ? `${wait.url} (${wait.status})` : wait.url;
  return wait.host === "localhost" ? `port ${wait.port}` : `${wait.host}:${wait.port}`;
}

/**
 * Wait until something is ready, or give up.
 *
 * A port is ready when it accepts a connection. A url is ready when it answers with the
 * status it names, or with anything below 500 when it names none: a 404 still means the
 * server is up, a 502 means what is behind it is not.
 */
export async function waitFor(
  wait: WaitSpec,
  signal?: AbortSignal,
  /** Asked now and then: a reason to stop waiting, like the server having died. */
  hopeless?: () => Promise<string | undefined>,
): Promise<void> {
  if ("seconds" in wait) {
    await sleep(wait.seconds * 1000, signal);
    return;
  }

  const address = "url" in wait ? fillEnv(wait.url) : "";
  if ("url" in wait && !/^https?:\/\/[^/\s]/i.test(address)) {
    const names = envNames(wait.url);
    throw new Error(names.length > 0 ? `${names.map((name) => `$${name}`).join(", ")} ${names.length === 1 ? "doesn't" : "don't"} make a website address: it needs to start with https:// or http://` : `"${address}" is not a website address: it needs to start with https:// or http://`);
  }
  const deadline = Date.now() + wait.timeout * 1000;
  let last: number | undefined;
  const check = "url" in wait
    ? async () => {
        last = await answers(address);
        return last !== undefined && (wait.status ? last === wait.status : last < 500);
      }
    : () => listening(wait.host, wait.port);

  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw new Error("cancelled");
    if (await check()) return;
    if (hopeless && attempt % 4 === 3) {
      const reason = await hopeless();
      if (reason) throw new Error(reason);
    }
    if (Date.now() >= deadline) {
      throw new Error(`gave up after ${wait.timeout}s waiting for ${describeWait(wait)}${last !== undefined ? `: it answered ${last}` : ""}`);
    }
    await sleep(250, signal);
  }
}

function listening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function answers(url: string): Promise<number | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    await response.body?.cancel();
    return response.status;
  } catch {
    return undefined;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });
}
