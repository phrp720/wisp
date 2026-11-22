import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type { OS } from "../types.js";

/**
 * Editors people open a project with, and how to find each one: by its app on macOS, by its
 * command elsewhere. Only the ones installed here are offered, so a choice always works.
 */
const EDITORS: { label: string; app: string; command: string }[] = [
  { label: "Visual Studio Code", app: "Visual Studio Code", command: "code" },
  { label: "Cursor", app: "Cursor", command: "cursor" },
  { label: "Zed", app: "Zed", command: "zed" },
  { label: "Windsurf", app: "Windsurf", command: "windsurf" },
  { label: "WebStorm", app: "WebStorm", command: "webstorm" },
  { label: "IntelliJ IDEA", app: "IntelliJ IDEA", command: "idea" },
  { label: "PyCharm", app: "PyCharm", command: "pycharm" },
  { label: "GoLand", app: "GoLand", command: "goland" },
  { label: "Sublime Text", app: "Sublime Text", command: "subl" },
  { label: "Xcode", app: "Xcode", command: "xed" },
];

/** What to save to open with each installed editor: its app name on macOS, its command elsewhere. */
export interface EditorChoice {
  label: string;
  value: string;
}

export function installedEditors(os: OS, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): EditorChoice[] {
  if (os === "darwin") {
    const places = ["/Applications", join(homedir(), "Applications")];
    return EDITORS.filter((editor) => places.some((place) => exists(join(place, `${editor.app}.app`)))).map((editor) => ({ label: editor.label, value: editor.app }));
  }
  const folders = (env["PATH"] ?? "").split(delimiter).filter(Boolean);
  const names = (command: string) => (os === "win32" ? [`${command}.cmd`, `${command}.exe`, command] : [command]);
  return EDITORS.filter((editor) => folders.some((folder) => names(editor.command).some((name) => exists(join(folder, name))))).map((editor) => ({
    label: editor.label,
    value: editor.command,
  }));
}
