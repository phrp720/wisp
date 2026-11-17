import { SpecterError } from "./errors.js";
import { currentOS, expandHome } from "./paths.js";
import type { Invocation, OS, ShellKind } from "./types.js";
import { which } from "./which.js";

export interface ShellRequest {
  command: string;
  shell?: ShellKind;
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Where the shell writes its own PID before running the command — how Specter finds a
   * command again that it handed to a terminal window, so `specter down` can stop it.
   */
  pidFile?: string;
}

/** The shell a command is written for when it does not say: the one this OS speaks. */
export function defaultShell(os: OS = currentOS()): ShellKind {
  return os === "win32" ? "pwsh" : "sh";
}

/**
 * A command as a program and its arguments, with its directory and environment folded in.
 *
 * Folding them into the script rather than passing them to `spawn` is what lets the same
 * invocation go anywhere — a new terminal window, a tmux window, a background process —
 * since most of those cannot be handed a working directory or environment of their own.
 */
export function shellInvocation(request: ShellRequest, os: OS = currentOS(), env = process.env): Invocation {
  const kind = request.shell ?? defaultShell(os);
  const cwd = request.cwd?.trim() ? expandHome(request.cwd.trim()) : undefined;

  if (kind === "sh") {
    const script = [
      ...(request.pidFile ? [`echo $$ > ${posixQuote(request.pidFile)}`] : []),
      ...Object.entries(request.env ?? {}).map(([name, value]) => `export ${name}=${posixQuote(value)}`),
      ...(cwd ? [`cd ${posixQuote(cwd)}`] : []),
    ];
    const line = script.length > 0 ? `${script.join(" && ")} && ${request.command}` : request.command;

    if (os === "win32") {
      // Git for Windows, MSYS or Cygwin. A `sh` command has nowhere else to run here.
      const sh = which("bash", env) ?? which("sh", env);
      if (!sh) {
        throw new SpecterError(
          `"${request.command}" is written for sh, and there is no bash or sh on this PATH`,
          "NO_SHELL",
        );
      }
      return { file: sh, args: ["-lc", line] };
    }

    return { ...loginShell(env), args: [...loginShell(env).args, line] };
  }

  if (kind === "pwsh") {
    const script = [
      ...(request.pidFile ? [`$PID | Set-Content -LiteralPath ${pwshQuote(request.pidFile)}`] : []),
      ...Object.entries(request.env ?? {}).map(([name, value]) => `$env:${name} = ${pwshQuote(value)}`),
      ...(cwd ? [`Set-Location -LiteralPath ${pwshQuote(cwd)}`] : []),
      request.command,
    ].join("; ");

    const pwsh = which("pwsh", env) ?? (os === "win32" ? which("powershell", env) ?? "powershell.exe" : undefined);
    if (!pwsh) {
      throw new SpecterError(`"${request.command}" is written for PowerShell, and pwsh is not installed`, "NO_SHELL");
    }
    return { file: pwsh, args: ["-NoLogo", "-Command", script] };
  }

  if (os !== "win32") {
    throw new SpecterError(`"${request.command}" is written for cmd, which only exists on Windows`, "NO_SHELL");
  }

  const script = [
    ...Object.entries(request.env ?? {}).map(([name, value]) => `set "${name}=${value}"`),
    ...(cwd ? [`cd /d "${cwd}"`] : []),
    request.command,
  ].join(" && ");
  return { file: env["ComSpec"] ?? "cmd.exe", args: ["/d", "/s", "/c", script] };
}

/**
 * Your own shell, interactive and login, so it has your PATH.
 *
 * Not `/bin/sh`: a zsh user's `nvm`, `mise` or Homebrew setup lives in `.zshrc`, which a
 * plain `sh` never reads, and `pnpm` would simply not be found. Interactive as well as
 * login, because `.zshrc` is where people actually put their PATH.
 */
export function loginShell(env: NodeJS.ProcessEnv = process.env): Invocation {
  const shell = env["SHELL"]?.trim() || "/bin/sh";
  // bash is the exception: started interactive with no terminal it complains about job
  // control into every log, and its login startup already reads .bashrc via .profile on
  // the systems that ship it — so login alone gets it the same PATH, quietly.
  const name = shell.split("/").pop() ?? shell;
  return { file: shell, args: name === "bash" || name === "sh" ? ["-lc"] : ["-ilc"] };
}

/**
 * An invocation for a window of its own: it records its PID, and when the command fails
 * the window stays open on the error instead of vanishing with it.
 *
 * Wrapped in `/bin/sh` rather than written in your shell's syntax, so it works whatever
 * `$SHELL` is — fish included. The PID is the wrapper's: the window's own process, whose
 * group holds everything the command started, which is what stopping it must reach.
 */
export function windowInvocation(inner: Invocation, pidFile: string, label: string): Invocation {
  const script = [
    `echo $$ > ${posixQuote(pidFile)}`,
    posixCommandLine(inner),
    "status=$?",
    `if [ "$status" -ne 0 ]; then printf '\\n[specter] %s exited with %s — press enter to close\\n' ${posixQuote(label)} "$status"; read _; fi`,
    'exit "$status"',
  ].join("\n");
  return { file: "/bin/sh", args: ["-c", script] };
}

/**
 * An invocation run under a pseudo-terminal, by way of `script`, which every macOS and
 * Linux has.
 *
 * A command whose output goes to a file decides nobody is watching: colours go, progress
 * bars go, some tools buffer everything. Under a terminal it behaves as it does in yours —
 * and Specter, keeping its output, can show it that way. Sized wide, so a log is not
 * wrapped to some default eighty columns. Nothing to wrap it in on Windows, or without
 * `script`: then the command runs as it is.
 */
export function underTerminal(inner: Invocation, os: OS = currentOS(), env: NodeJS.ProcessEnv = process.env): Invocation {
  if (os === "win32") return inner;
  const script = which("script", env);
  if (!script) return inner;

  const sized: Invocation = { file: "/bin/sh", args: ["-c", 'stty cols 160 rows 50 2>/dev/null; exec "$@"', "sh", inner.file, ...inner.args] };
  // BSD's `script` takes the command as arguments; util-linux's as one string, with -e to
  // pass its exit code on and -f to write as it goes.
  if (os === "darwin") return { file: script, args: ["-q", "/dev/null", sized.file, ...sized.args] };
  return { file: script, args: ["-qfec", posixCommandLine(sized), "/dev/null"] };
}

/** One invocation as a line a POSIX shell will read back into the same arguments. */
export function posixCommandLine(invocation: Invocation): string {
  return [invocation.file, ...invocation.args].map(posixQuote).join(" ");
}

export function posixQuote(value: string): string {
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function pwshQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Quote one argument for a Windows command line, by the rules `CommandLineToArgvW` uses —
 * backslashes only matter before a quote.
 */
export function windowsQuote(value: string): string {
  if (value && !/[\s"]/.test(value)) return value;
  let out = '"';
  let slashes = 0;
  for (const char of value) {
    if (char === "\\") {
      slashes += 1;
      continue;
    }
    if (char === '"') {
      out += "\\".repeat(slashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(slashes) + char;
    }
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}
