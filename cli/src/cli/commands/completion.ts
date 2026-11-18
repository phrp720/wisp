import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { WispError } from "../../core/errors.js";
import { configDir, tildify } from "../../core/paths.js";
import { dim, green } from "../format.js";
import { SHELLS } from "../lib/complete.js";
import type { CommandDef } from "../lib/define.js";

/**
 * Tab completion. Each script is a thin shim: on ⇥ it asks `wisp __complete` what fits,
 * so the suggestions are your workspaces, bolts and running commands as they are now.
 */
const SCRIPTS: Record<string, string> = {
  zsh: `# Wisp's tab completion for zsh. \`wisp completion --install\` sets it up.
if ! (( $+functions[compdef] )); then
  autoload -Uz compinit && compinit
fi
_wisp() {
  local -a items
  local line
  for line in "\${(@f)$(wisp __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}"; do
    [[ -z $line ]] && continue
    items+=("\${\${line%%$'\\t'*}//:/\\\\:}:\${line#*$'\\t'}")
  done
  if (( \${#items} )); then
    _describe -t wisp 'wisp' items
  else
    _files
  fi
}
compdef _wisp wisp
`,
  bash: `# Wisp's tab completion for bash. \`wisp completion --install\` sets it up.
_wisp() {
  local words=("\${COMP_WORDS[@]:1:COMP_CWORD}")
  local line
  COMPREPLY=()
  while IFS= read -r line; do
    [ -n "$line" ] && COMPREPLY+=("\${line%%$'\\t'*}")
  done < <(wisp __complete -- "\${words[@]}" 2>/dev/null)
}
complete -o default -o bashdefault -F _wisp wisp
`,
  fish: `# Wisp's tab completion for fish. \`wisp completion --install\` sets it up.
function __wisp_complete
    set -l words (commandline -opc)
    set -e words[1]
    wisp __complete -- $words (commandline -ct) 2>/dev/null
end
complete -c wisp -f -a '(__wisp_complete)'
`,
};

interface Options {
  install?: boolean;
}

export const completion: CommandDef<Options> = {
  name: "completion",
  summary: "Tab completion for your shell: commands, workspaces and bolts",
  args: [["[shell]", "zsh, bash or fish; omitted, the one you are using"]],
  options: [["--install", "set it up in your shell's config, once"]],
  examples: ["wisp completion --install     # then open a new terminal", "wisp completion zsh           # print the script, to set it up yourself"],

  async run([named], options) {
    const shell = named ?? basename(process.env["SHELL"] ?? "");
    if (!SHELLS.includes(shell)) {
      throw new WispError(
        named ? `No completion for "${named}": Wisp has it for zsh, bash and fish` : "Say which shell: `wisp completion zsh`, `bash` or `fish`",
        "INVALID_INPUT",
      );
    }
    const script = SCRIPTS[shell] as string;
    if (!options.install) {
      process.stdout.write(script);
      return;
    }

    // fish loads completions from a folder of its own; zsh and bash source a file from
    // their config, kept in Wisp's folder so a new terminal needn't start Wisp to get it.
    if (shell === "fish") {
      const file = join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "fish", "completions", "wisp.fish");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, script);
      console.log(`${green("✓")} wrote ${tildify(file)}`);
    } else {
      const file = join(configDir(), `completion.${shell}`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, script);
      const rc = shell === "zsh" ? join(process.env["ZDOTDIR"] ?? homedir(), ".zshrc") : join(homedir(), ".bashrc");
      const line = `[ -f "${file}" ] && source "${file}"  # wisp tab completion`;
      const existing = await readFile(rc, "utf8").catch(() => "");
      if (existing.includes(file)) {
        console.log(`${green("✓")} updated ${tildify(file)} ${dim(`(${tildify(rc)} already loads it)`)}`);
      } else {
        await appendFile(rc, `${existing && !existing.endsWith("\n") ? "\n" : ""}${line}\n`);
        console.log(`${green("✓")} wrote ${tildify(file)}, and one line to ${tildify(rc)} to load it`);
      }
    }
    console.log(dim("Open a new terminal, then try `wisp ⇥`."));
  },
};
