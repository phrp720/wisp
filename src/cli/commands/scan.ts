import { resolve } from "node:path";

import { addKnownProjects, loadConfig, setRoots } from "../../core/config.js";
import { expandHome, tildify } from "../../core/paths.js";
import { scanForProjects } from "../../core/scan.js";
import { dim, green, plural } from "../format.js";
import type { CommandDef } from "../lib/define.js";

export const scan: CommandDef<{ remember?: boolean; depth?: string }> = {
  name: "scan",
  summary: "Find the .specter.json files under a directory, so they show up everywhere",
  args: [["[dirs...]", "where to look; omitted scans the directories you remembered"]],
  options: [
    ["-r, --remember", "scan these directories again whenever you run `specter scan`"],
    ["--depth <levels>", "how deep to look", "4"],
  ],
  examples: ["specter scan ~/dev", "specter scan ~/dev ~/work --remember", "specter scan"],

  async run(dirs, options) {
    const given = dirs.map((dir) => resolve(expandHome(dir)));
    const roots = given.length > 0 ? given : ((await loadConfig()).roots ?? []).map((dir) => expandHome(dir));

    if (roots.length === 0) {
      console.log(dim("Say where to look: `specter scan ~/dev`. Add --remember to make it the default."));
      return;
    }

    if (options.remember && given.length > 0) {
      await setRoots((current) => [...new Set([...current, ...given.map(tildify)])]);
    }

    const depth = Number.parseInt(options.depth ?? "4", 10) || 4;
    const found = (await Promise.all(roots.map((root) => scanForProjects(root, { depth })))).flat();
    const added = await addKnownProjects(found);

    for (const file of found) console.log(`  ${tildify(file)}`);
    console.log(
      `${green("✓")} ${plural(found.length, "project")} found${added > 0 ? `, ${added} new` : ""} ${dim(`in ${roots.map(tildify).join(", ")}`)}`,
    );
  },
};
