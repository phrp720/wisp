# Commands

Every command takes `--help`; most take `--json`, for scripts and agents.

## Running bolts

| Command | |
|---|---|
| `wisp` | the dashboard; without a terminal, what this project can run |
| `wisp <bolt>` | run a bolt of this project, by its slug or any whole word of its name |
| `wisp <workspace> <bolt>` | run a bolt of another project, from any folder |
| `wisp pick [workspace]` | choose a bolt from a list and run it |
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

- **One word is a bolt of the project you're in,** and only of that project: `wisp api` runs
  "Work on api". When it isn't a bolt here, nothing runs, and Wisp says what to type instead:
  `Elsewhere: wisp mira deploy`.
- **Two words are a workspace and one of its bolts,** from any folder:
  `wisp payments-service services`.
- **To see a workspace's bolts,** `wisp show payments-service`. To choose one from a list,
  `wisp pick payments-service`, or `wisp pick` to choose the workspace too.
- **A name can be** the full name in quotes (`"Work on api"`), its slug (`work-on-api`, shown
  by `wisp show` and `wisp list`), or whole words of it that only one name has (`api`,
  `on-api`). Never part of a word: `doc` doesn't run "Documentation". When several match,
  Wisp lists them and runs nothing.
- **A bolt named like a command** (`list`, `check`) still runs with `wisp use list`.

`down` and `restart` take `--deps`, for the bolts it needed too; `down --dry-run` shows what
would stop. `wisp <workspace> --all` opens everything a workspace holds.

`wisp pick` lists the bolts with what's running, their slugs and notes: type to filter, `⏎`
runs the one selected, `esc` cancels. It takes the same options as running a bolt. Without
a terminal, or with `--json`, it asks nothing and prints the list instead.

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
| `wisp show [workspace]` | a workspace's bolts, with their slugs, notes and what's running, then everything it holds |
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
