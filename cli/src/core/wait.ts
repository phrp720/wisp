import { connect } from "node:net";

import type { WaitSpec } from "./types.js";

/** How a wait reads in a list: `port 5432`, `http://localhost:3000`, `3s`. */
export function describeWait(wait: WaitSpec): string {
  if ("seconds" in wait) return `${wait.seconds}s`;
  if ("url" in wait) return wait.url;
  return wait.host === "localhost" ? `port ${wait.port}` : `${wait.host}:${wait.port}`;
}

/**
 * Wait until something is ready, or give up.
 *
 * A port is ready when it accepts a connection; a url when it answers at all — even a 404
 * means the server is up, which is all a bolt needs to know before opening it.
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

  const deadline = Date.now() + wait.timeout * 1000;
  const check = "url" in wait ? () => answers(wait.url) : () => listening(wait.host, wait.port);

  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw new Error("cancelled");
    if (await check()) return;
    if (hopeless && attempt % 4 === 3) {
      const reason = await hopeless();
      if (reason) throw new Error(reason);
    }
    if (Date.now() >= deadline) {
      throw new Error(`gave up after ${wait.timeout}s waiting for ${describeWait(wait)}`);
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

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
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
