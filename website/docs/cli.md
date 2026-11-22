# CLI

Every command and option. Each command also takes `--help`, and most take `--json` for
scripts and agents.

## Running pipelines

| Command | |
|---|---|
| `wisp` | the dashboard; without a terminal, what this project can run |
| `wisp <pipeline>` | run a pipeline of the project you're in |
| `wisp <workspace> <pipeline>` | run a pipeline of any workspace, from any folder |
| `wisp pick [workspace]` | choose a pipeline from a list and run it |
| `wisp use <file> <pipeline>` | run a pipeline of a file by its path, for cron and scripts |
| `wisp down <pipeline>` | stop what it started, then run its `down` steps; `--deps` for the pipelines it ran too |
| `wisp restart <pipeline>` | down, then up again |
| `wisp status` | what this project can run, as plain text |

Options when running a pipeline:

| Option | |
|---|---|
| `--dry-run` | show what it would do, and where; change nothing |
| `-r`, `--retry` | run again from the step that failed last time |
| `-w`, `--window` | run its commands in terminal windows (tmux windows, inside tmux) |
| `-i`, `--inline` | run them here, with their output in this terminal |
| `-d`, `--detach` | run them in the background, even if your settings say windows |
| `--skip-untrusted` | run only what the file is allowed to, skipping what waits for trust |
| `--input name=value` | a value the pipeline [asks for](./inputs); once for each |
| `-y`, `--yes` | don't ask: answer yes to [Asking first](./asking-first), take each input's default |
| `--json` | the result as JSON |

How names are matched: [Running pipelines](./running-pipelines#how-wisp-reads-a-name).

## Watching

| Command | |
|---|---|
| `wisp ps` | what's running: status, uptime, restarts; `--all` adds finished ones, `--clear` forgets them |
| `wisp logs <name>` | what one printed; `-f` follows it, `-n 500` shows more lines |
| `wisp stop <name>` | stop one, and everything it started; `--all` stops every one |
| `wisp history` | past runs of this project; `--all` for every project |
| `wisp history <id>` | one run, step by step; `--log 3` prints what step 3 printed |
| `wisp history [id \| pipeline] --clear` | delete a run, a pipeline's runs, or this project's (`--all`: every project's) |

## Setting up

| Command | |
|---|---|
| `wisp init` | write a `.wisp.json` from what the project has; `--empty`, `--name Acme`, `--only "Dev,Verify"`, `--print`, `--yes`, `--force` |
| `wisp init -p --name Homelab` | create a [personal workspace](./workspaces#personal-workspaces) |
| `wisp check` | what's wrong with the file, and what it would run |
| `wisp trust` | allow this file's commands, after showing them; `--list`, `--revoke` |
| `wisp scan ~/dev` | find the projects you already have; `--remember`, `--depth 4` |
| `wisp hook pre-push verify` | run a pipeline from a git hook; `--list`, `--remove`, `--force` |
| `wisp open-with` | what opens folders and files, and where commands run: [Settings](./settings) |
| `wisp notify` | when Wisp tells you about a run, and its webhooks (`add`, `remove`, `--test`, `--reveal`): [Notifications](./notifications) |
| `wisp completion --install` | tab completion for zsh, bash and fish |

## Finding things

| Command | |
|---|---|
| `wisp list` | every workspace: yours, and the projects you've used |
| `wisp show [workspace]` | a workspace's pipelines: slugs, notes, what's running, each one's steps |
| `wisp rename [workspace] <pipeline> <new name>` | rename a pipeline and every step that runs it; asks for [trust](./trust) again |
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
| `WISP_NOTIFY` | `off`, `failures`, `changes` or `all`, for one command |

## Exit codes

`0` when everything ran. `1` when a step failed, `check` found errors, or a command was
refused. With `--json`, a failure is `{"ok": false, "error": {"code", "message", "hint"}}`.
