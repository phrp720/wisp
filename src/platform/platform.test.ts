import { describe, expect, it } from "vitest";

import { appArgs, darwin, terminalArgs } from "./darwin.js";
import { linux, linuxTerminalCommand } from "./linux.js";
import { tmuxPlan, zellijPlan } from "./multiplexer.js";
import { win32, windowsTerminalCommand } from "./win32.js";

const invocation = { file: "/bin/zsh", args: ["-ilc", "cd '/a b' && pnpm dev"] };

describe("macOS", () => {
  it("takes an app by name or bundle id", () => {
    expect(appArgs("Slack")).toEqual(["-a", "Slack"]);
    expect(appArgs("com.tinyspeck.slackmacgap")).toEqual(["-b", "com.tinyspeck.slackmacgap"]);
  });

  it("drives Terminal through AppleScript with the whole command quoted", () => {
    const { file, args } = terminalArgs("Terminal", invocation, "dev");
    expect(file).toBe("osascript");
    expect(args[1]).toContain(`do script "/bin/zsh -ilc 'cd '\\\\''/a b'\\\\'' && pnpm dev'"`);
  });

  it("gives each terminal the arguments it actually takes", () => {
    expect(terminalArgs("WezTerm", invocation, "dev").args).toEqual(["-na", "WezTerm", "--args", "start", "--", ...[invocation.file, ...invocation.args]]);
    expect(terminalArgs("kitty", invocation, "dev").args).toEqual(["-na", "kitty", "--args", "--title", "dev", invocation.file, ...invocation.args]);
    expect(terminalArgs("Ghostty", invocation, "dev").args.slice(3)).toEqual(["--title=dev", "-e", invocation.file, ...invocation.args]);
  });

  it("finds terminals by name, alias or prefix", () => {
    expect(darwin.findTerminal("ghost")).toBe("Ghostty");
    expect(darwin.findTerminal("com.googlecode.iterm2")).toBe("iTerm");
    expect(darwin.findTerminal("iTerm2")).toBe("iTerm");
    expect(darwin.findTerminal("hyper")).toBeUndefined();
  });
});

describe("Linux", () => {
  it("builds each terminal's command line", () => {
    expect(linuxTerminalCommand("GNOME Terminal", invocation, "dev")).toEqual(["gnome-terminal", "--title", "dev", "--", invocation.file, ...invocation.args]);
    expect(linuxTerminalCommand("Konsole", invocation, "dev")).toEqual(["konsole", "-e", invocation.file, ...invocation.args]);
    expect(linuxTerminalCommand("Tilix", invocation, "dev")[4]).toBe(`/bin/zsh -ilc 'cd '\\''/a b'\\'' && pnpm dev'`);
  });

  it("finds terminals by binary name", () => {
    expect(linux.findTerminal("gnome-terminal")).toBe("GNOME Terminal");
    expect(linux.findTerminal("xfce4-terminal")).toBe("Xfce Terminal");
  });
});

describe("Windows", () => {
  const pwsh = { file: "pwsh", args: ["-NoLogo", "-Command", "Set-Location -LiteralPath 'C:\\a'; pnpm dev"] };

  it("escapes the semicolons Windows Terminal would split on", () => {
    expect(windowsTerminalCommand("Windows Terminal", pwsh, "dev")).toEqual([
      "wt", "-w", "new", "--title", "dev", "pwsh", "-NoLogo", "-Command", "Set-Location -LiteralPath 'C:\\a'\\; pnpm dev",
    ]);
  });

  it("falls back to a plain console window", () => {
    expect(windowsTerminalCommand("Console", pwsh, "dev")).toEqual(["pwsh", ...pwsh.args]);
    expect(win32.findTerminal("wt")).toBe("Windows Terminal");
  });

  it("refuses an app name cmd would read as two commands", async () => {
    await expect(win32.launchApp("notepad&calc")).rejects.toThrow(/not a name Windows can start/);
  });
});

describe("multiplexers", () => {
  it("opens a tmux window beside you, or in a detached wisp session", () => {
    expect(tmuxPlan(invocation, "dev", true, true)).toEqual([["new-window", "-d", "-n", "dev", expect.stringContaining("pnpm dev")]]);
    expect(tmuxPlan(invocation, "dev", false, false)[0]!.slice(0, 5)).toEqual(["new-session", "-d", "-s", "wisp", "-n"]);
    expect(tmuxPlan(invocation, "dev", false, true)[0]!.slice(0, 4)).toEqual(["new-window", "-d", "-t", "wisp:"]);
  });

  it("opens a zellij pane with the program as separate arguments", () => {
    expect(zellijPlan(invocation, "dev")).toEqual(["run", "--name", "dev", "--", invocation.file, ...invocation.args]);
  });
});
