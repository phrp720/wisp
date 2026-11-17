import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { WispError, describe, isNotFound } from "./errors.js";
import { expandHome, readJson, trustPath, withLock, writeJson } from "./paths.js";
import type { TrustFile, TrustState, TrustedProject } from "./types.js";

/**
 * Whether a project file may run the commands it declares.
 *
 * Trust is per file and per version of that file. Granting it is an explicit act — you
 * read the commands, then say yes to those commands — so it cannot be inherited by a
 * later `git pull`. That is the whole difference between this and a config flag.
 */

const TRUST_VERSION = 1;

/** The personal override that sits beside a project file: `.wisp.local.json`. */
export function localFileFor(file: string): string {
  const name = basename(file).replace(/\.json$/i, "");
  return join(dirname(file), `${name}.local.json`);
}

/**
 * The bytes a grant covers: the project file, and its local override when there is one.
 *
 * The override is usually gitignored and yours, but nothing guarantees it — a repository
 * can commit one — so it is trusted on exactly the same terms as the file it extends.
 */
export async function readTrustedBytes(file: string): Promise<{ main: Buffer; local?: Buffer }> {
  const path = absolutePath(file);
  let main: Buffer;
  try {
    main = await readFile(path);
  } catch (error) {
    throw new WispError(`Could not read ${path}: ${describe(error)}`, "PROJECT_READ_FAILED");
  }

  try {
    return { main, local: await readFile(localFileFor(path)) };
  } catch (error) {
    if (isNotFound(error)) return { main };
    throw new WispError(`Could not read ${localFileFor(path)}: ${describe(error)}`, "PROJECT_READ_FAILED");
  }
}

/** SHA-256 of the file as it stands, local override included: what a grant is recorded against. */
export async function hashProjectFile(file: string): Promise<string> {
  const { main, local } = await readTrustedBytes(file);
  return hashContents(main, local);
}

/**
 * The same hash over bytes already in hand, so the bytes that were checked are the bytes
 * that run — re-reading between the two would leave a window where they differ.
 */
export function hashContents(main: Buffer | string, local?: Buffer | string): string {
  const hash = createHash("sha256").update(main);
  // A separator no JSON file can contain, so moving bytes between the two files changes
  // the hash.
  if (local !== undefined) hash.update("\u0000wisp-local\u0000").update(local);
  return hash.digest("hex");
}

/**
 * `stale` rather than `untrusted` when the path is known but the bytes are not: one is
 * "you have never seen this", the other is "this changed under you".
 */
export async function trustStateOf(file: string, hash?: string): Promise<TrustState> {
  const path = absolutePath(file);
  const grant = (await listTrustedProjects()).find((entry) => entry.path === path);
  if (!grant) return "untrusted";

  const actual = hash ?? (await hashProjectFile(path).catch(() => undefined));
  if (!actual) return "untrusted";

  return grant.hash === actual ? "trusted" : "stale";
}

/**
 * Record that this exact version of a project file may run its commands.
 *
 * Pass the hash of the version you showed the user. If the file changed between showing
 * it and their yes, the yes was to something else, and the grant is refused.
 */
export async function trustProject(file: string, expectedHash?: string): Promise<TrustedProject> {
  const path = absolutePath(file);
  const hash = await hashProjectFile(path);
  if (expectedHash && expectedHash !== hash) {
    throw new WispError(
      `${path} changed while you were reading it — nothing was trusted. Look again and re-run \`wisp trust\``,
      "CHANGED",
    );
  }
  const grant: TrustedProject = { path, hash, at: new Date().toISOString() };

  await withLock(trustPath(), async () => {
    const store = await loadTrust();
    const kept = store.trusted.filter((entry) => entry.path !== path);
    await writeJson(trustPath(), { version: TRUST_VERSION, trusted: [...kept, grant] });
  });

  return grant;
}

/** Withdraw a grant. Returns false when there was nothing to withdraw. */
export async function revokeProject(file: string): Promise<boolean> {
  const path = absolutePath(file);
  return withLock(trustPath(), async () => {
    const store = await loadTrust();
    const kept = store.trusted.filter((entry) => entry.path !== path);
    if (kept.length === store.trusted.length) return false;

    await writeJson(trustPath(), { version: TRUST_VERSION, trusted: kept });
    return true;
  });
}

/** Every grant on record, newest first. */
export async function listTrustedProjects(): Promise<TrustedProject[]> {
  const store = await loadTrust().catch(() => ({ version: TRUST_VERSION, trusted: [] }));
  return [...store.trusted].sort((left, right) => right.at.localeCompare(left.at));
}

async function loadTrust(): Promise<TrustFile> {
  const parsed = await readJson(trustPath());
  if (typeof parsed !== "object" || parsed === null) return { version: TRUST_VERSION, trusted: [] };

  const list = (parsed as { trusted?: unknown }).trusted;
  if (!Array.isArray(list)) return { version: TRUST_VERSION, trusted: [] };

  const trusted = list.flatMap((entry): TrustedProject[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { path, hash, at } = entry as Record<string, unknown>;
    if (typeof path !== "string" || typeof hash !== "string") return [];
    return [{ path, hash, at: typeof at === "string" ? at : "" }];
  });

  return { version: TRUST_VERSION, trusted };
}

/** The real path, so a grant made through a symlink applies to the file, not the link. */
function absolutePath(file: string): string {
  const path = resolve(expandHome(file));
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
