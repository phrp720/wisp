# Commands

| Command | |
|---|---|
| `wisp` | the TUI (`wisp status` for plain text) |
| `wisp <bolt>` | run a bolt by any distinctive word of its name; `--dry-run` shows what would happen first |
| `wisp init` | write a `.wisp.json` for this project, from what it already has; you choose which suggested bolts to keep |
| `wisp check` | what's wrong with the file, and what would run |
| `wisp trust` | allow this project's commands |
| `wisp list` | every workspace you have, from anywhere |
| `wisp show` | everything a workspace holds |
| `wisp down <bolt>` · `restart <bolt>` | take a bolt down (`--deps` for what it needed too) · and up again |
| `wisp history` | past runs, and what each step printed |
| `wisp ps` · `logs` · `stop` | what's running · follow one · stop one |
| `wisp hook pre-push check` | run a job from a git hook |
| `wisp use <file> <bolt>` | run a bolt of a file by its path, for cron and scripts |
| `wisp scan ~/dev` | find the projects you already have |
| `wisp open-with` | pick your editor and terminal |
| `wisp doctor` | what works here, and where files live |
| `wisp spec` | the full reference, for AI agents |

Every command takes `--help`; most take `--json`.

## Running a bolt

| Option | |
|---|---|
| `-n`, `--dry-run` | show what it would do, change nothing |
| `--retry` | run again from the step that failed last time |
| `-w`, `--window` | run its commands in terminal windows |
| `-i`, `--inline` | run them here, with their output in this terminal |
| `--json` | the result as JSON |

## Exit codes

`0` when everything ran. `1` when a step failed, `check` found errors, or a command was
refused; the message says why, and usually what to run instead.
