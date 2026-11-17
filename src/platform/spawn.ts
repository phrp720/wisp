import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Run a program to completion and fail with what it said on stderr.
 *
 * For the short-lived helpers — `open`, `osascript`, `tmux new-window` — whose exit code
 * is the answer.
 */
export async function run(file: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(file, args, { windowsHide: true });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) throw new Error(stderr.trim());
    if ((error as { code?: unknown }).code === "ENOENT") throw new Error(`${file} is not installed`);
    throw error;
  }
}

/**
 * Start a program that should outlive Specter — an editor, a terminal window — and return
 * once it has started. Resolves when the process exists, rejects if it could not start.
 */
export function launch(file: string, args: string[], options: { windowsHide?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: options.windowsHide ?? true,
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? new Error(`${file} is not installed`) : error);
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
