import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { describeWait, waitFor } from "./wait.js";

let server: Server | undefined;

async function answering(status: number): Promise<string> {
  server = createServer((_request, response) => {
    response.statusCode = status;
    response.end();
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("waiting for a url", () => {
  it("fills {{env.NAME}} when it waits, and names the variable, never its value, when it can't", async () => {
    const url = await answering(200);
    process.env["WISP_TEST_HEALTH"] = url.replace(/\/health$/, "");
    try {
      await expect(waitFor({ url: "{{env.WISP_TEST_HEALTH}}/health", timeout: 1 })).resolves.toBeUndefined();
      process.env["WISP_TEST_HEALTH"] = "staging-secret";
      await expect(waitFor({ url: "{{env.WISP_TEST_HEALTH}}", timeout: 30 })).rejects.toThrow("$WISP_TEST_HEALTH doesn't make a website address");
      await expect(waitFor({ url: "{{env.WISP_TEST_HEALTH}}", timeout: 30 })).rejects.not.toThrow("staging-secret");
    } finally {
      delete process.env["WISP_TEST_HEALTH"];
    }
    await expect(waitFor({ url: "{{env.WISP_TEST_HEALTH}}", timeout: 30 })).rejects.toThrow("$WISP_TEST_HEALTH isn't set here");
  });

  it("refuses an address that isn't one at once, instead of waiting out its timeout", async () => {
    const started = Date.now();
    await expect(waitFor({ url: "staging", timeout: 30 })).rejects.toThrow('"staging" is not a website address');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("counts a 404 as up: the server answers", async () => {
    await expect(waitFor({ url: await answering(404), timeout: 1 })).resolves.toBeUndefined();
  });

  it("does not count a 502 as up, and says what it answered", async () => {
    const url = await answering(502);
    await expect(waitFor({ url, timeout: 0.3 })).rejects.toThrow(`gave up after 0.3s waiting for ${url}: it answered 502`);
  });

  it("asks for an exact status when the step names one", async () => {
    const url = await answering(404);
    await expect(waitFor({ url, timeout: 0.3, status: 200 })).rejects.toThrow("it answered 404");
    await expect(waitFor({ url, timeout: 1, status: 404 })).resolves.toBeUndefined();
  });

  it("names the status it waits for", () => {
    expect(describeWait({ url: "https://example.com/health", timeout: 60, status: 200 })).toBe("https://example.com/health (200)");
    expect(describeWait({ url: "https://example.com", timeout: 60 })).toBe("https://example.com");
  });
});
