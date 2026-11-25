import { describe, expect, it } from "vitest";

import { logs } from "../../../src/cli/commands/processes.js";

describe("wisp logs --grep", () => {
  it("refuses a pattern it can't read, before looking for the run", async () => {
    await expect(logs.run([], { grep: "(" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
