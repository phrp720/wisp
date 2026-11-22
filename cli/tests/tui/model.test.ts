import { describe, expect, it } from "vitest";

import { score, search, windowed } from "../../src/tui/model.js";
import { read, acme, infra, services, open } from "../support/tui-app.js";

describe("search", () => {
  it("prefers pipelines whose own words match", () => {
    const hits = search([acme, infra], "api");
    expect(hits[0]?.label).toBe("Acme › Work on api");
  });

  it("matches letters in order, and nothing out of order", () => {
    expect(score("Work on api", "woa")).toBeDefined();
    expect(score("Work on api", "aow")).toBeUndefined();
  });
});

describe("windowed", () => {
  it("keeps the selection in view", () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    expect(windowed(items, 0, 5).items).toEqual([0, 1, 2, 3, 4]);
    expect(windowed(items, 19, 5).items).toEqual([15, 16, 17, 18, 19]);
    expect(windowed(items, 10, 5).items).toContain(10);
  });
});

describe("long links", () => {
  it("are shown by their name and site, or cut to host and path", async () => {
    const { describeStep, shortUrl } = await import("../../src/tui/model.js");
    const notion = "https://app.notion.com/p/20d57edf20d480048206d7083c40e58b?v=20d57edf20d480cdb210000cfbf13953&assetsVersion=23.13";
    expect(describeStep({ kind: "link", id: "l", label: "Notion", value: notion })).toBe("open Notion (app.notion.com)");
    expect(describeStep({ kind: "link", id: "l", label: notion, value: notion })).toBe("open app.notion.com/p/20d57edf20d480048206d7083c40e58b?…");
    expect(shortUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("never push the workspace list out of shape", async () => {
    const long = read("/dev/notes/.wisp.json", { name: "Notes", pipelines: [{ label: "Notion", steps: [{ url: `https://app.notion.com/p/${"x".repeat(300)}` }] }] });
    const app = await open(services({}, { reads: [long], here: long.workspace.file, unreadable: [] }));
    const lines = (app.lastFrame() ?? "").split("\n").slice(1, -1);
    // Every row is exactly as wide as the screen: nothing spills, nothing wraps.
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
    expect(lines.filter((line) => line.startsWith("╰")).length).toBe(1);
  });
});
