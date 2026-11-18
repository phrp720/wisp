import { describe, expect, it } from "vitest";

import { interpret } from "../../core/project.js";
import { type CompletionSources, complete } from "./complete.js";

const read = (file: string, main: Record<string, unknown>) => interpret({ main }, { file, personal: false, trust: "trusted", os: "darwin" });
const acme = read("/dev/acme/.wisp.json", { name: "Acme", bolts: [{ label: "Work on api", targets: [] }, { label: "Check", job: true, targets: [] }] });
const flower = read("/dev/flower/.wisp.json", { name: "Flower Testbed", bolts: [{ label: "Services", targets: [] }, { label: "Test", targets: [] }] });

const sources = (here = acme): CompletionSources => ({
  here: async () => here,
  workspaces: async () => [acme, flower],
  running: async () => [{ label: "api", id: "abc123def456", workspaceName: "Acme" }],
  terminals: () => ["Ghostty", "iTerm", "tmux"],
  editors: () => ["WebStorm"],
});
const values = async (words: string[], from = sources()) => (await complete(words, from)).map((candidate) => candidate.value);

describe("tab completion", () => {
  it("offers commands, this project's bolts and every workspace first", async () => {
    const first = await values([""]);
    expect(first).toEqual(expect.arrayContaining(["init", "list", "completion", "work-on-api", "check", "acme", "flower-testbed"]));
  });

  it("narrows to what was typed, as slugs that need no quotes", async () => {
    expect(await values(["flo"])).toEqual(["flower-testbed"]);
    expect(await values(["work"])).toEqual(["work-on-api"]);
  });

  it("offers a workspace's bolts after its name, and nothing after a bolt of this project", async () => {
    expect(await values(["flower-testbed", ""])).toEqual(["services", "test"]);
    expect(await values(["flower", "se"])).toEqual(["services"]);
    expect(await values(["work-on-api", ""])).toEqual([]);
  });

  it("knows what each command takes", async () => {
    expect(await values(["use", "flower-testbed", ""])).toEqual(["services", "test"]);
    expect(await values(["logs", ""])).toEqual(["api"]);
    expect(await values(["open-with", ""])).toEqual(["folder", "file", "terminal"]);
    expect(await values(["open-with", "terminal", "gh"])).toEqual(["Ghostty"]);
    expect(await values(["open-with", "folder", ""])).toEqual(["WebStorm"]);
    expect(await values(["completion", ""])).toEqual(["zsh", "bash", "fish"]);
    expect(await values(["help", "a"])).toEqual(["agents"]);
  });

  it("offers a command's options, and running a bolt's when the command is implied", async () => {
    expect(await values(["init", "--o"])).toEqual(["--only"]);
    expect(await values(["work-on-api", "--re"])).toEqual(["--retry"]);
  });

  it("works outside any project", async () => {
    const outside = { ...sources(), here: async () => undefined };
    expect(await values([""], outside)).not.toContain("work-on-api");
    expect(await values(["acme", ""], outside)).toEqual(["work-on-api", "check"]);
  });
});
