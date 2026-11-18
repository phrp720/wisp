# Commands

Every command takes `--help`; most take `--json`, for scripts and agents.

## Running bolts

| Command | |
|---|---|
| `wisp` | the dashboard; without a terminal, what this project can run |
| `wisp <bolt>` | run a bolt of this project, by any distinctive word of its name |
| `wisp <workspace> <bolt>` | run a bolt of another project, from any folder |
| `wisp use <file> <bolt>` | run a bolt of a file by its path, for cron and scripts |
| `wisp down <bolt>` | stop what it started, then run its `down` steps |
| `wisp restart <bolt>` | down, then up again |
| `wisp status` | what this project can run, as plain text |

| Option, when running | |
|---|---|
| `-n`, `--dry-run` | show what it would do, and where; change nothing |
| `-r`, `--retry` | run again from the step that failed last time |
| `-a`, `--all` | open everything the workspace holds, not one bolt |
| `-w`, `--window` | run its commands in terminal windows (tmux windows, inside tmux) |
| `-i`, `--inline` | run them here, with their output in this terminal |
| `-d`, `--detach` | run them in the background, even if your settings say windows |
| `--skip-untrusted` | run only what the file is allowed to, skipping what waits for trust |
| `--json` | the result as JSON |

### How Wisp reads `wisp <name>`

- **Inside a project,** a name is one of its bolts first: `wisp api` runs "Work on api".
- **Otherwise it's a workspace:** `wisp flower-testbed` lists that workspace's bolts, and
  `wisp flower-testbed services` runs one.
- **A name can be** the full name in quotes (`"Flower Testbed"`), its slug (`flower-testbed`,
  shown by `wisp list`), or any part of it that only one matches (`flower`). When several
  match, Wisp lists them and runs nothing.

`down` and `restart` take `--deps`, for the bolts it needed too; `down --dry-run` shows what
would stop.

## Setting up

| Command | |
|---|---|
| `wisp init` | write a `.wisp.json` from what the project has, keeping the bolts you choose |
| `wisp check` | what's wrong with the file, and what it would run |
| `wisp trust` | allow this file's commands, after showing them |
| `wisp scan ~/dev` | find the projects you already have, so they show up everywhere |
| `wisp hook pre-push check` | run a job from a git hook; the push stops if it fails |
| `wisp open-with` | your editor and terminal; the same as [Settings](./settings) |
| `wisp completion --install` | tab completion for your shell (zsh, bash, fish): commands, workspaces, bolts, running commands |

| Option | |
|---|---|
| `init --only "Check,Work on api"` | keep only these of the suggestions |
| `init --print` | print the draft, write nothing |
| `init --yes` · `--force` | write without asking · replace an existing file |
| `trust --list` · `--revoke` | the files you've trusted · withdraw trust from this one |
| `trust --yes` | skip the question (only for a file you've read) |
| `scan --remember` · `--depth 4` | scan these folders on every `wisp scan` · how deep to look |
| `hook --list` · `--remove` · `--force` | the hooks here · take one out · replace one Wisp didn't write |

## Watching

| Command | |
|---|---|
| `wisp ps` | what's running: status, uptime, restarts; `--all` adds finished ones, `--clear` forgets them |
| `wisp logs <name>` | what one printed; `-f` follows it, `-n 500` shows more lines |
| `wisp stop <name>` | stop one, and everything it started; `--all` stops every one |
| `wisp history` | past runs of this project; `--all` for every project |
| `wisp history <id>` | one run, step by step; `--log 3` prints what step 3 printed |

## Finding things

| Command | |
|---|---|
| `wisp list` | every workspace: yours, and the projects you've used |
| `wisp show [workspace]` | everything a workspace holds, and what each bolt does |
| `wisp doctor` | what works on this machine, and where Wisp keeps its files |
| `wisp help agents` | the full reference, for AI agents (also `wisp spec`) |

## Environment variables

| Variable | |
|---|---|
| `WISP_HOME` | where Wisp keeps settings and workspaces (and, under `state/`, runs and logs) |
| `WISP_STATE` | where it keeps runs and logs, on their own |
| `WISP_HEADLESS` | `1` when there's no screen to open things on; `0` when there is but Wisp can't tell |
| `WISP_NO_TUI` | `1` to never open the dashboard; `wisp` prints what it can run instead |
| `WISP_ASCII` | `1` for plain characters, no emoji or box drawing |

## Exit codes

`0` when everything ran. `1` when a step failed, `check` found errors, or a command was
refused. With `--json`, a failure is `{"ok": false, "error": {"code", "message", "hint"}}`.
