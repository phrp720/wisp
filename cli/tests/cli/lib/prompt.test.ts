import { describe, expect, it } from "vitest";

import { filterChoices } from "../../../src/cli/lib/prompt.js";

describe("filterChoices", () => {
  const items = [
    { label: "Work on the CLI", slug: "work-on-the-cli", hint: "The CLI in watch mode" },
    { label: "Deploy", slug: "deploy", tag: "job", hint: "Builds the website and ships it" },
    { label: "Documentation", slug: "documentation" },
  ];

  it("keeps everything until something is typed", () => {
    expect(filterChoices(items, "")).toEqual([0, 1, 2]);
  });

  it("keeps the rows whose name, slug, tag or notes hold every word typed", () => {
    expect(filterChoices(items, "doc")).toEqual([2]);
    expect(filterChoices(items, "website")).toEqual([1]);
    expect(filterChoices(items, "job")).toEqual([1]);
    expect(filterChoices(items, "cli watch")).toEqual([0]);
    expect(filterChoices(items, "nothing")).toEqual([]);
  });
});
