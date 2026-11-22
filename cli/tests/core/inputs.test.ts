import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { checkValue, envNames, fillEnv, fillTarget, parseGiven, placeholders } from "../../src/core/inputs.js";
import type { InputSpec } from "../../src/core/types.js";

const tag: InputSpec = { name: "tag", ask: "Which tag?" };

describe("placeholders", () => {
  it("finds {{name}}, with or without spaces, and leaves other braces alone", () => {
    expect(placeholders("deploy {{env}} --tag {{ tag }} {} {{.Names}} ${HOME}")).toEqual(["env", "tag"]);
  });
});

describe("{{env.NAME}}", () => {
  it("is not an input, and is filled from the environment, whole", () => {
    expect(placeholders("{{env.PRODUCTION_URL}}/admin")).toEqual([]);
    expect(envNames("{{ env.PRODUCTION_URL }}/{{env.TEAM}} {{env.TEAM}}")).toEqual(["PRODUCTION_URL", "TEAM"]);
    expect(fillEnv("{{env.PRODUCTION_URL}}/admin", { PRODUCTION_URL: "https://shop.example.com " })).toBe("https://shop.example.com/admin");
  });

  it("refuses to fill one that isn't set, naming every one missing", () => {
    expect(() => fillEnv("{{env.A}}/{{env.B}}", { A: "x" })).toThrow("$B isn't set here");
    expect(() => fillEnv("{{env.A}}/{{env.B}}", { A: " " })).toThrow("$A, $B aren't set here");
  });
});

describe("a value is plain words", () => {
  it("takes what inputs are for: environments, versions, branches, hosts, emails, paths, a short note", () => {
    for (const value of ["staging", "v1.2.3-rc.1", "feature/login-2", "web-1.acme.com:8080", "ops@acme.com", "~/backups/acme-2026-11-20.sql", "a=b,c+d", "München", "42", "Fix the login, see web-1"]) {
      expect(checkValue(tag, value)).toBeUndefined();
    }
  });

  it("refuses anything a shell treats specially, and a word starting with a dash", () => {
    for (const value of ["x; rm -rf ~", "$(id)", "`id`", "it's", '"quoted"', "a|b", "a&b", "a>b", "*", "?", "-rf", "a -rf", "a --force", "–rf", "“x”", "a\nb", "a\tb"]) {
      expect(checkValue(tag, value)).toMatch(/takes plain words/);
    }
  });

  it.skipIf(process.platform === "win32")("reaches a command nested in other shells as plain words, never as code or options", () => {
    const value = "release/v1.2+build=7, x@y:z~ ok";
    const nested = fillTarget({ kind: "command", id: "c", label: "c", value: "sh -c 'sh -c \"printf %s\\| {{tag}}\"'" }, { tag: value });
    expect(execFileSync("sh", ["-c", nested.value], { encoding: "utf8" })).toBe("release/v1.2+build=7,|x@y:z~|ok|");
    const quoted = fillTarget({ kind: "command", id: "c", label: "c", value: `printf '%s|' "{{tag}}"` }, { tag: value });
    expect(execFileSync("sh", ["-c", quoted.value], { encoding: "utf8" })).toBe(`${value}|`);
  });

  it("is checked again just before a step is filled, wherever the value came from", () => {
    expect(() => fillTarget({ kind: "command", id: "c", label: "c", value: "deploy {{tag}}" }, { tag: "x; touch /tmp/pwned" })).toThrow(/takes plain words/);
  });
});

describe("fillTarget", () => {
  it("fills a command, its folder and environment, a link (its path encoded or not) and a wait's address", () => {
    const values = { env: "staging" };
    expect(fillTarget({ kind: "command", id: "c", label: "deploy {{env}}", value: "./deploy.sh {{env}}", cwd: "infra/{{env}}", env: { TARGET: "{{env}}" } }, values)).toMatchObject({
      label: "deploy staging",
      value: "./deploy.sh staging",
      cwd: "infra/staging",
      env: { TARGET: "staging" },
    });
    expect(fillTarget({ kind: "link", id: "l", label: "site", value: "https://acme.com/%7B%7Benv%7D%7D/?q={{env}}" }, values).value).toBe("https://acme.com/staging/?q=staging");
    expect(fillTarget({ kind: "wait", id: "w", label: "up", value: "up", wait: { url: "https://{{env}}.acme.com", timeout: 30 } }, values).wait).toEqual({ url: "https://staging.acme.com", timeout: 30 });
    expect(fillTarget({ kind: "link", id: "l", label: "{{env}}", value: "https://acme.com/search?q={{env}}" }, { env: "eu west" })).toMatchObject({ label: "eu west", value: "https://acme.com/search?q=eu%20west" });
  });
});

describe("values given on the command line", () => {
  const specs: InputSpec[] = [{ name: "env", ask: "Where?", choices: ["staging", "production"] }, tag];

  it("reads name=value, keeping = in the value", () => {
    expect(parseGiven(["env=production", "tag=v1=rc"], specs, "Deploy")).toEqual({ env: "production", tag: "v1=rc" });
  });

  it("refuses a name the pipeline doesn't have, a value not among the choices, an empty one and one that isn't plain words", () => {
    expect(() => parseGiven(["region=eu"], specs, "Deploy")).toThrow('"Deploy" has no input called region; it has env, tag');
    expect(() => parseGiven(["env=prod"], specs, "Deploy")).toThrow('env is one of staging, production, not "prod"');
    expect(() => parseGiven(["tag=v1; reboot"], specs, "Deploy")).toThrow(/takes plain words/);
    expect(checkValue(tag, " ")).toBe("tag needs a value");
  });
});
