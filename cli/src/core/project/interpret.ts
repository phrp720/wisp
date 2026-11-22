import { basename, dirname } from "node:path";

import type { AppRef, Diagnostic, FileRef, Folder, Link, OS, OpenWithDefaults, TrustState, Workspace, WorkspaceRead } from "../types.js";
import { APPS, FILES, FOLDERS, LINKS, assets, commands } from "./assets.js";
import { type Context, type Entry, type Sources, allow, inlineEntries, sectionEntries } from "./context.js";
import { bolts } from "./pipelines.js";
import { isRecord, optionalString, plural } from "./values.js";

/** Keys a workspace file may set. Anything else is a typo worth reporting. */
const KNOWN_KEYS = new Set([
  // Not read by Wisp — it is there so editors validate the file as you type.
  "$schema",
  "name",
  "icon",
  "color",
  "notes",
  "pipelines",
]);

/** The parsed JSON of a workspace file, as a workspace. Separate from reading, for tests. */
export function interpret(
  sources: Sources,
  input: { file: string; personal: boolean; trust: TrustState; os: OS; defaults?: OpenWithDefaults },
): WorkspaceRead & { hash?: string } {
  const trusted = input.personal || input.trust === "trusted";
  const ctx: Context = {
    root: dirname(input.file),
    os: input.os,
    personal: input.personal,
    trusted,
    defaults: input.defaults ?? {},
    found: [],
    elsewhere: new Set(),
    withheld: [],
    idsByAt: new Map(),
    valueById: new Map(),
  };

  for (const [prefix, source] of [["", sources.main], ["local ", sources.local]] as const) {
    if (!source) continue;
    for (const key of Object.keys(source)) {
      if (KNOWN_KEYS.has(key)) continue;
      ctx.found.push({
        level: "warning",
        at: `${prefix}${key}`,
        message: `"${key}" is not something a workspace file can set — it is ignored`,
        hint:
          Array.isArray(source[key]) && !("pipelines" in sources.main) && !("pipelines" in (sources.local ?? {}))
            ? `Did you mean "pipelines"? Known keys: ${[...KNOWN_KEYS].join(", ")}`
            : `Known keys: ${[...KNOWN_KEYS].join(", ")}`,
      });
    }
  }

  // Scalars from the override win; lists from it are added after the project's own.
  const scalar = (key: string) => optionalString(sources.local?.[key]) ?? optionalString(sources.main[key]);
  const section = (key: string) => sectionEntries(sources, key, ctx);

  const pipelineEntries = section("pipelines");
  const inline = inlineEntries(pipelineEntries);

  const links = assets<Link>(inline.links, LINKS, ctx);
  const folders = assets<Folder>(inline.folders, FOLDERS, ctx);
  const files = assets<FileRef>(inline.files, FILES, ctx);
  const apps = assets<AppRef>(inline.apps, APPS, ctx);
  const declaredCommands = commands(inline.commands, ctx);

  const workspace: Workspace = {
    id: input.file,
    name: scalar("name") ?? defaultName(input.file, input.personal),
    file: input.file,
    personal: input.personal,
    trusted,
    links: links.filter((link) => allow(ctx, "link", link, link.url)),
    folders: folders.filter((folder) => allow(ctx, "folder", folder, folder.path)),
    files: files.filter((file) => allow(ctx, "file", file, file.path)),
    apps: apps.filter((app) => allow(ctx, "app", app, app.app)),
    // The line between reading a command and running one. A project file's commands are
    // parsed and shown whatever happens; they only become part of the workspace once you
    // have looked at them and said yes to these bytes.
    commands: trusted ? declaredCommands : [],
    bolts: [],
  };

  if (!trusted) {
    for (const command of declaredCommands) {
      ctx.withheld.push({
        kind: "command",
        id: command.id,
        label: command.label,
        value: command.run,
        ...(command.cwd ? { cwd: command.cwd } : {}),
      });
    }
  }

  const icon = scalar("icon");
  if (icon) workspace.icon = icon;
  const color = scalar("color");
  if (color) workspace.color = color;
  const notes = scalar("notes");
  if (notes) workspace.notes = notes;

  workspace.bolts = bolts(pipelineEntries, ctx);

  if (!trusted && ctx.withheld.length > 0) {
    const commandCount = ctx.withheld.filter((item) => item.kind === "command").length;
    const linkCount = ctx.withheld.filter((item) => item.kind === "link" || item.kind === "wait").length;
    const other = ctx.withheld.length - commandCount - linkCount;
    const parts = [
      commandCount > 0 ? plural(commandCount, "command") : "",
      other > 0 ? `${plural(other, "item")} that would run code when opened` : "",
      linkCount > 0 ? `${plural(linkCount, "website")} that ${linkCount === 1 ? "reads" : "read"} your environment` : "",
    ].filter(Boolean);

    ctx.found.push({
      level: "warning",
      at: "trust",
      message:
        input.trust === "stale"
          ? `this file has changed since you trusted it — ${parts.join(" and ")} will not run`
          : `${parts.join(" and ")} declared but will not run`,
      hint:
        input.trust === "stale"
          ? "Read what changed with `wisp check`, then `wisp trust` again"
          : "Read them with `wisp check`, then allow them with `wisp trust`",
    });
  }

  return { workspace, diagnostics: tagPipelines(ctx.found, pipelineEntries), trust: input.trust, declaredCommands, withheld: ctx.withheld };
}

export function tagPipelines(found: Diagnostic[], pipelineEntries: Entry[]): Diagnostic[] {
  const places = pipelineEntries.flatMap(({ value, at }) => {
    const label = isRecord(value) ? optionalString(value["label"]) : undefined;
    return label ? [{ at, label }] : [];
  });
  return found.map((entry) => {
    if (entry.pipeline) return entry;
    const place = places.find(({ at }) => entry.at === at || entry.at.startsWith(`${at}.`));
    return place ? { ...entry, pipeline: place.label } : entry;
  });
}

/** `acme` for `~/dev/acme/.wisp.json`, `Morning` for `workspaces/Morning.wisp.json`. */
function defaultName(file: string, personal: boolean): string {
  if (personal) {
    const name = basename(file).replace(/(\.wisp)?\.json$/i, "");
    if (name) return name;
  }
  return basename(dirname(file)) || "Project";
}
