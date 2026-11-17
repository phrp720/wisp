import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expandHome } from "./paths.js";
import { PROJECT_FILE } from "./project.js";

/**
 * Directories never worth descending into: dependencies, build output, caches. Scanning
 * `~/dev` must take a second, not a minute spent walking every `node_modules` in it.
 */
const SKIP = new Set([
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  "out",
  "venv",
  "__pycache__",
  "Pods",
  "DerivedData",
  "Library",
  "Applications",
]);

export interface ScanOptions {
  /** How many directories down from the root to look. */
  depth?: number;
}

/**
 * Every `.specter.json` under a directory.
 *
 * Shallow by default — projects live a level or three below where you keep them — and it
 * stops descending once it finds one, since a project's own subdirectories belong to it.
 * Hidden directories are skipped; `.git` alone would make this crawl.
 */
export async function scanForProjects(root: string, options: ScanOptions = {}): Promise<string[]> {
  const found: string[] = [];
  const maxDepth = options.depth ?? 4;

  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.isFile() && entry.name === PROJECT_FILE)) {
      found.push(join(dir, PROJECT_FILE));
      // Nested files are allowed — `apps/api` may have its own — so keep going, but only
      // a little: a nested one is rare, and this is the expensive part of a scan.
      if (depth >= maxDepth - 1) return;
    }
    if (depth >= maxDepth) return;

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name))
        .map((entry) => walk(join(dir, entry.name), depth + 1)),
    );
  };

  await walk(resolve(expandHome(root)), 0);
  return found.sort();
}
