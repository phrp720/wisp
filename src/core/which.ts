import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { currentOS } from "./paths.js";

/**
 * The full path of a program on PATH, or nothing.
 *
 * Synchronous on purpose: it is called a handful of times per run to pick a terminal or a
 * shell, and the answer decides what happens next.
 */
export function which(program: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const windows = currentOS() === "win32";
  const extensions = windows
    ? ["", ...(env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.toLowerCase())]
    : [""];

  const candidates = isAbsolute(program)
    ? [program]
    : (env["PATH"] ?? env["Path"] ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, program));

  for (const base of candidates) {
    for (const extension of extensions) {
      const path = base + extension;
      try {
        if (!statSync(path).isFile()) continue;
        if (!windows) accessSync(path, constants.X_OK);
        return path;
      } catch {
        // Not here.
      }
    }
  }
  return undefined;
}
