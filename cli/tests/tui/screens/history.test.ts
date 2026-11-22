import { describe, expect, it } from "vitest";

describe("history steps", () => {
  it("say what each step did, in the words used everywhere else", async () => {
    const { describeHistoryStep } = await import("../../../src/tui/screens/history.js");
    const step = (kind: string, label: string, value = label) => ({ kind, label, value, ok: true, durationMs: 1 }) as never;
    expect(describeHistoryStep(step("wait", "port 5432"))).toBe("wait until port 5432 is open");
    expect(describeHistoryStep(step("wait", "http://localhost:3000"))).toBe("wait until http://localhost:3000 answers");
    expect(describeHistoryStep(step("link", "http://localhost:3000"))).toBe("open http://localhost:3000");
    expect(describeHistoryStep(step("command", "Payments Service dev", "pnpm dev"))).toBe("start Payments Service dev");
    expect(describeHistoryStep({ ...(step("command", "test", "pnpm test") as object), finishes: true } as never)).toBe("run test");
  });
});
