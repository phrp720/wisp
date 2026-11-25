import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { ChangesSinceTrust } from "../../../src/core/trust.js";
import { diffLines } from "../../../src/core/text/diff.js";
import { TrustPanel } from "../../../src/tui/components/dialogs.js";
import { ARROW_DOWN, eventually, read, tick, unicode } from "../../support/tui-app.js";

const shop = (trust: "stale" | "untrusted", steps = [{ run: "./deploy.sh --force" }]) => read("/dev/shop/.wisp.json", { name: "Shop", pipelines: [{ label: "Deploy", steps }] }, trust);

const changed = (before: string, after: string): ChangesSinceTrust => ({
  trustedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  changes: [{ file: "/dev/shop/.wisp.json", lines: diffLines(before, after) }],
});

const panel = (props: Partial<Parameters<typeof TrustPanel>[0]> & Pick<Parameters<typeof TrustPanel>[0], "read">) =>
  render(<TrustPanel glyphs={unicode} height={30} onAnswer={() => undefined} {...props} />);

describe("the trust panel for a file that changed since it was trusted", () => {
  it("shows the lines that changed, above what it would run", async () => {
    const loadChanges = vi.fn(async () => changed('{\n  "run": "./deploy.sh"\n}', '{\n  "run": "./deploy.sh --force"\n}'));
    const app = panel({ read: shop("stale"), loadChanges });
    await eventually(() => expect(app.lastFrame()).toContain("Changed since you trusted it 3d ago"));
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain('-   "run": "./deploy.sh"');
    expect(frame).toContain('+   "run": "./deploy.sh --force"');
    expect(frame.indexOf("Changed since")).toBeLessThan(frame.indexOf("It would be allowed to run"));
    expect(frame).not.toContain("this file has changed since you last trusted it");
    expect(loadChanges).toHaveBeenCalledWith("/dev/shop/.wisp.json");
  });

  it("scrolls a diff too long to fit with ↑↓", async () => {
    const before = Array.from({ length: 40 }, (_, at) => `line ${at}`).join("\n");
    const after = Array.from({ length: 40 }, (_, at) => `changed ${at}`).join("\n");
    const app = panel({ read: shop("stale"), loadChanges: async () => changed(before, after) });
    await eventually(() => expect(app.lastFrame()).toMatch(/lines 1–\d+ of 81 · ↑↓ scroll/));
    expect(app.lastFrame()).toContain("- line 0");
    app.stdin.write(ARROW_DOWN);
    await tick();
    app.stdin.write(ARROW_DOWN);
    await tick();
    await eventually(() => expect(app.lastFrame()).toMatch(/lines 3–\d+ of 81/));
    expect(app.lastFrame()).not.toContain("- line 0");
  });

  it("says so when only the formatting changed", async () => {
    const app = panel({ read: shop("stale"), loadChanges: async () => ({ trustedAt: new Date().toISOString(), changes: [] }) });
    await eventually(() => expect(app.lastFrame()).toContain("only its formatting"));
  });

  it("falls back to the warning when there is no copy to compare with", async () => {
    const app = panel({ read: shop("stale"), loadChanges: async () => undefined });
    await tick();
    expect(app.lastFrame()).toContain("this file has changed since you last trusted it");
    expect(app.lastFrame()).not.toContain("Changed since");
  });
});

describe("the trust panel for a file trusted for the first time", () => {
  it("shows the whole list and looks for no diff", async () => {
    const loadChanges = vi.fn(async () => undefined);
    const app = panel({ read: shop("untrusted"), loadChanges });
    await tick();
    expect(app.lastFrame()).toContain("./deploy.sh --force");
    expect(loadChanges).not.toHaveBeenCalled();
  });

  it("says how many more there are when the list doesn't fit, rather than cutting it off", async () => {
    const steps = Array.from({ length: 30 }, (_, at) => ({ run: `./step-${at}.sh`, label: `step ${at}` }));
    const app = panel({ read: shop("untrusted", steps), height: 20 });
    await tick();
    expect(app.lastFrame()).toMatch(/… and \d+ more \(`wisp check` lists every one\)/);
  });
});
