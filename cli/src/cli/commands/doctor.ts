import { getOpenWithDefaults } from "../../core/config.js";
import { detectEnvironment } from "../../core/system/environment.js";
import { configDir, stateDir, tildify, workspacesDir } from "../../core/paths.js";
import { osName } from "../../core/project/index.js";
import { defaultShell } from "../../core/system/shell.js";
import { which } from "../../core/system/which.js";
import { getPlatform } from "../../platform/index.js";
import { bold, dim, green, yellow } from "../lib/format.js";
import { emitJson } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";
import { VERSION } from "../version.js";

export const doctor: CommandDef<{ json?: boolean }> = {
  name: "doctor",
  summary: "Show what Wisp can do here, and where it keeps its files",
  options: [["--json", "print it as JSON"]],

  async run(_args, options) {
    const environment = detectEnvironment();
    const platform = getPlatform(environment.os);
    const defaults = await getOpenWithDefaults();

    const commandsGo = defaults.terminal
      ? defaults.terminal
      : (environment.multiplexer ?? (environment.gui ? platform.defaultTerminal() : undefined) ?? "the background");

    const shells = {
      sh: environment.os === "win32" ? which("bash") ?? which("sh") : process.env["SHELL"] ?? which("sh"),
      pwsh: which("pwsh") ?? (environment.os === "win32" ? which("powershell") : undefined),
    };

    const report = {
      version: VERSION,
      os: environment.os,
      display: environment.gui,
      ssh: environment.ssh,
      multiplexer: environment.multiplexer ?? null,
      commandsRunIn: commandsGo,
      tabReuse: Boolean(platform.tabs) && environment.gui,
      defaultShell: defaultShell(environment.os),
      shells,
      paths: { config: configDir(), workspaces: workspacesDir(), state: stateDir() },
    };
    if (options.json) return emitJson(report);

    const yes = (value: unknown) => (value ? green("yes") : yellow("no"));

    console.log(`${bold("wisp")} ${VERSION} ${dim(`on ${osName(environment.os)}`)}`);
    console.log();
    console.log(`${dim("display        ")} ${yes(environment.gui)}${environment.ssh ? dim(" (over ssh)") : ""}`);
    console.log(`${dim("multiplexer    ")} ${environment.multiplexer ?? dim("none")}`);
    console.log(`${dim("commands run in")} ${commandsGo}${defaults.terminal ? dim(" (your choice)") : dim(" (automatic)")}`);
    console.log(`${dim("reuses tabs    ")} ${yes(report.tabReuse)}${platform.tabs ? "" : dim(" (macOS only)")}`);
    console.log(`${dim("sh             ")} ${shells.sh ?? yellow("not found")}`);
    console.log(`${dim("pwsh           ")} ${shells.pwsh ?? dim("not found")}`);
    if (environment.os === "linux") console.log(`${dim("xdg-open       ")} ${which("xdg-open") ?? yellow("not found — links and folders cannot open")}`);
    console.log();
    console.log(`${dim("config         ")} ${tildify(configDir())}`);
    console.log(`${dim("workspaces     ")} ${tildify(workspacesDir())}`);
    console.log(`${dim("logs and runs  ")} ${tildify(stateDir())}`);
  },
};
