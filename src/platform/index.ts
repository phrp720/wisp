import { currentOS } from "../core/paths.js";
import type { OS } from "../core/types.js";
import { darwin } from "./darwin.js";
import { linux } from "./linux.js";
import type { Platform } from "./types.js";
import { win32 } from "./win32.js";

export type { Platform, Tab, OpenOptions, TerminalRequest } from "./types.js";

const PLATFORMS: Record<OS, Platform> = { darwin, linux, win32 };

/** The platform Specter is running on. */
export function getPlatform(os: OS = currentOS()): Platform {
  return PLATFORMS[os];
}
