# Wisp reference

Wisp starts a project's working context with one word. A `.wisp.json` in a project
lists **bolts**; running a bolt opens or runs what it lists, in order: folders, files,
links, apps and shell commands, with optional waits and dependencies between them.

## Files

- `.wisp.json`: committed in a project. Wisp finds it by walking up from the
  current directory, like git finds `.git`. Paths in it are relative to the file.
- `.wisp.local.json`: optional, beside it, usually gitignored. Same format. Its bolts
  are added to the project's, its name/icon/color win, and a bolt with the same label
  replaces the project's bolt.
- Personal workspaces: the same format, in the `workspaces` directory that
  `wisp doctor` prints. Trusted automatically, since they are yours.

## The smallest file

```json
{
  "bolts": [
    { "label": "Work on api", "targets": [{ "folder": "apps/api" }, { "run": "pnpm dev", "cwd": "apps/api" }] }
  ]
}
```

A bolt's `label` is what people type, so keep it short (`Deploy`, `Work on api`).
Its slug (`work-on-api`) or any whole word of it (`api`) runs it, never part of a
word. An optional `"notes"` says what it does in a line, and Wisp shows it beside the
bolt in `wisp show`, `wisp pick`, tab completion and the TUI.

## Bolt steps

`targets` lists the bolt's steps. Each entry is one of:

| Step | Example | Does |
|---|---|---|
| folder | `{ "folder": "apps/api" }` | opens in the file manager, or the user's chosen editor |
| file | `{ "file": "README.md" }` | opens with its default app, or the user's chosen editor |
| link | `{ "url": "http://localhost:3000" }` | opens in the browser (a bare host means https) |
| app | `{ "app": "Slack" }` | launches or focuses an app |
| command | `{ "run": "pnpm dev", "cwd": "apps/api", "env": { "PORT": 3000 } }` | runs a shell command |
| wait | `{ "wait": 3 }`, `{ "wait": "localhost:5432" }`, `{ "wait": "http://localhost:3000" }` | pauses until seconds pass, a port accepts, or a url answers (60s timeout; object form `{ "wait": { "port": 5432, "timeout": 120 } }`) |
| docker | `{ "compose": "compose.yaml", "services": ["postgres"] }` | `docker compose up --wait`: done when the services are healthy; `wisp down` stops them; shown with state, health and logs |
| bolt | `{ "bolt": "Database" }` | runs another bolt of this file as one step; done when all its steps are |

Any step may also carry `"label"`, `"os"` and `"after"`.

## Order: after

**Steps start right away, at the same time, unless they say what they wait for.** Like
Tekton's `runAfter`: `"after"` names the labels of steps in the same bolt, and the step
starts once all of them have finished. Anything that must happen in order needs it:

```json
{ "label": "Work on api", "targets": [
  { "bolt": "Database", "label": "db" },
  { "run": "pnpm dev", "label": "api", "after": "db" },
  { "wait": "http://localhost:3000", "label": "up", "after": "api" },
  { "url": "http://localhost:3000", "after": "up" }
] }
```

- `"after": "lint"` or `["lint", "test"]`: waits for each. Left out, the step starts
  with the bolt. A step can wait for any number of steps, and many can wait for one.
- A bolt step is one step like any other: it starts when what it waits for is done, and a
  step that waits for it waits for all of its steps. A bolt runs once per run, however many
  steps run it, and what is already running is left alone.
- A bolt step names a bolt of the same file only, so renaming one renames the steps that
  run it. To start another project, use a command:
  `{ "run": "wisp use ~/dev/infra/.wisp.json Database", "finishes": true }`.
- A `after` naming no step of the bolt, a label two steps share, or steps that wait for
  each other make the bolt refuse to run, with the reason (`wisp check` shows it).
- Steps that run at the same time print their output line by line, each line prefixed with
  the step's label; each step's log stays its own. `--dry-run` numbers the steps by when
  they can start: the same number means the same time.

## Commands that finish, and failures

A command keeps running by default: a server, a watcher. Wisp starts it and moves on. A
command with `"finishes": true` is waited for, attached, with its output kept: a test, a
build, a backup, a deploy. One bolt can mix both:

```json
{ "label": "Check", "targets": [{ "bolt": "Database", "label": "db" }, { "run": "pnpm lint", "label": "lint", "after": "db", "finishes": true }, { "run": "pnpm test", "after": "lint", "finishes": true }] }
```

- A failed step stops the run: steps already running finish, and nothing new starts. `"keepGoing": true` on a bolt reports a failure and runs
  the rest anyway.
- `"timeout": "10m"` (or `"30s"`, `"1h"`, or seconds) on a command that finishes: if it takes
  longer, Wisp stops it and everything it started, and the step fails ("ran over its 10m
  timeout"). Without one, Wisp waits as long as it takes. A command that keeps running takes
  no timeout (`wisp check` warns).
- A command that keeps running is never started twice; one that finishes runs every time.
- Every run is in `wisp history`, with each step's duration and output, from the moment
  it starts. Until it ends it has `"running": true`, and `pending` lists the steps not
  done yet; the ones in progress have `"running": true` and a `log` that fills as it goes.
  `"interrupted": true` means Wisp stopped before the run did.
- `wisp hook pre-push Check` runs it before every push and blocks the push if it fails.
  Its commands should finish: one that keeps running cannot block a push.

## Asking first

`"confirm": "Deploy to production?"` on a bolt makes Wisp ask before it runs it, or any
bolt that runs it (`true` asks `Run "<label>"?`). At a terminal it asks; without one, or
with `--json`, it runs nothing and exits 1 with `CONFIRM_NEEDED`. `--yes` runs it
without asking. Dry runs and git hooks never ask.

**Agents: ask the user the question yourself, and pass `--yes` only once they agree.**

## Inputs

A bolt can ask for values each time it runs; its steps use one as `{{name}}`:

```json
{ "label": "Deploy", "inputs": { "env": { "ask": "Deploy where?", "choices": ["staging", "production"], "default": "staging" } }, "confirm": "Deploy to {{env}}?", "targets": [{ "run": "./deploy.sh {{env}}", "finishes": true }] }
```

- `ask` is the question (the name when left out), `choices` limits the value to a list,
  `default` is used when none is given. Each input is optional except its name.
- A value is plain words: letters, digits, spaces and `. _ - / : @ + = , ~`, with no word
  starting with `-`. Anything else (quotes, `$ ; | & < > * ? ! # %`, backticks, tabs, line
  breaks) is refused with `INVALID_INPUT` before anything runs, so a value can't inject
  commands or options, even through `ssh` or `sh -c`. It goes into the command as typed;
  write `"{{note}}"` to keep one with spaces as a single argument.
- `{{name}}` works in a command, its `cwd` and `env`, a link, a folder or file, a wait for a
  website, and `confirm`. A bolt uses only the inputs it declares; one it runs that declares
  the same name gets the same value.
- `--input env=production` gives a value (once per input). Without a terminal, or with
  `--json`, a value not given takes its default; one with no default exits 1 with
  `INPUT_NEEDED`, naming the flag. `--yes` takes the defaults at a terminal too.
- The values are kept with the run: `inputs` in `wisp history <id> --json` and in the
  run's JSON result. `--retry` reuses them. Never for secrets: a step fetches its own from
  where it is kept, like `TOKEN=$(op read op://ops/deploy/token) ./deploy.sh`, so it is never
  written in the file, shown, or kept in history.

**Agents: pass every value with `--input`. If you don't know one, ask the user; never guess
where to deploy.**

## Up and down

Wisp tracks every command it starts (in a terminal window, a tmux window or the
background), so it knows which bolts are **up**, never starts a second copy of a running
command, and can stop them: `wisp down <bolt>` stops the bolt's own commands (`--deps`
for the bolts it depends on too), then runs its `down` steps:

```json
{ "label": "Services", "targets": [{ "run": "docker compose up -d", "finishes": true }], "down": [{ "run": "docker compose stop" }] }
```

A file holds bolts and nothing else: every step is written inside the bolt that takes it.
To reuse steps, put them in a bolt of their own and run it from others as a `{ "bolt": … }` step.

## Commands

`{ "run": "…", "finishes": true, "cwd": "…", "env": {…}, "shell": "sh" | "pwsh" | "cmd", "background": true, "restart": "on-failure" | "always" }`

- `run` goes to the user's own shell (`$SHELL -ilc`) on macOS/Linux and PowerShell on
  Windows, unless `shell` says otherwise. Pipes and `&&` work.
- Commands run in the background, under a pseudo-terminal so their output keeps its
  colours, with that output kept: `wisp logs <name>`, `wisp ps`, and a pane each in
  the TUI. They outlive Wisp. `--window`, or `wisp open-with terminal <app|tmux>`,
  puts them in terminal or tmux windows instead. A command that finishes always runs
  attached.
- `restart` brings a command back when it stops: `"on-failure"` after a crash, `"always"`
  whenever it exits. It waits 1s, 2s, 4s… up to 30s, and gives up after 10 in a row. It
  keeps working after Wisp is closed.
- A command that asks something can't be answered in the background. **Agents: give it a
  non-interactive flag (`--yes`, `CI=1`) in `run`.**
- A background command whose output goes quiet on a question is shown as **waiting**
  (`wisp ps`, `"waiting"` in `wisp ps --json`). It can't be answered there: fix the step.

## Per-OS values

`app` and `run` may be a map: `{ "macos": "Visual Studio Code", "linux": "code",
"windows": "code" }`. Any entry may have `"os": ["linux", "macos"]`. Elsewhere it is
skipped quietly. OS names: `macos`, `linux`, `windows`.

## Trust

Commands, and files or apps that would execute when opened, **do not run** until the
user approves that exact file with `wisp trust`. Any edit to the file or its local
override withdraws approval until it is approved again. Personal workspaces are trusted.

Running a bolt that needs something not yet approved starts nothing: at a terminal it
shows the list and asks to trust and run; without one, or with `--json`, it exits 1 with
the error code `NOT_TRUSTED`. `--skip-untrusted` runs only the approved part.

**Agents: never run `wisp trust` yourself. Show the user what `wisp check` lists
under "Runs code" and ask them to approve it.**

## CLI

| Command | Does |
|---|---|
| `wisp` | at a terminal, the TUI; without one (pipes, scripts, agents), what this project can run |
| `wisp status` | what this project can run, as text, even at a terminal |
| `wisp <bolt>` | run a bolt of this project, and only this project, by its label, slug or a whole word of it. Not a bolt here: exit 1, `NO_BOLT`, and the message names what to type. Ambiguous: exit 1, `AMBIGUOUS` |
| `wisp <workspace> <bolt>` | run a bolt of any known workspace, from any folder |
| `wisp use <file> <bolt>` | run a bolt of a workspace file by path, for cron and scripts. `use` is implied above; say it for a bolt named like a command (`wisp use list`) |
| `wisp pick [workspace]` | at a terminal, choose a bolt from a list and run it; without one (or with `--json`) it asks nothing and prints what `wisp show` would |
| `wisp init [--print] [--yes] [--only <bolts>]` | write a `.wisp.json` from what the project has, at its root and one folder down: package.json and Deno; Python (Django, FastAPI, Flask, pytest, ruff, uv, poetry); Gradle and Maven (Spring Boot); Go; Rust; Rails; PHP and Laravel; .NET; Elixir and Phoenix; docker compose, Makefile, justfile, mise, Taskfile, Procfile. `--only "Check,Work on api"` keeps just those of the suggested bolts |
| `wisp check [path] [--json]` | validate a file, or the one in a folder: errors, warnings, what would run |
| `wisp show [workspace] [--json]` | a workspace's bolts: label, slug, notes, what is up, and each one's steps |
| `wisp list [--json]` | every known workspace |
| `wisp trust` | approve a file's commands (for the user, not an agent) |
| `wisp down <bolt> [--deps]` · `wisp restart <bolt>` | stop what a bolt started · stop it and run it again |
| `wisp history [bolt \| id] [--log <n>] [--json]` | past runs, each step's result, duration and output |
| `wisp history [bolt \| id] --clear [--all]` | delete a run, a bolt's runs, or this project's (every project's with `--all`); runs still going are kept |
| `wisp hook <git-hook> <bolt>` · `--list` · `--remove` | run a bolt from a git hook |
| `wisp ps [--all] [--json]` · `wisp logs <run> [-f]` · `wisp stop <run> \| --all` | what Wisp has running |
| `wisp scan <dir>` | find project files under a directory |
| `wisp notify [failures\|all\|off] [--webhook <url>] [--test] [--json]` | when Wisp tells the user about a run they might have missed (nobody watched it, or it took over 30s): a desktop notification, and a webhook if set (https only, or http to localhost). The user's own setting: don't change it for them. `WISP_NOTIFY=off` silences one command |
| `wisp doctor [--json]` | what works here, and where files live |
| `wisp completion [zsh\|bash\|fish] [--install]` | tab completion for workspaces, bolts and commands (for the user to set up) |
| `wisp help agents` · `wisp spec` | this reference |

Run flags: `--dry-run` (show what would happen and where, change nothing), `--inline`
(run commands attached, output here), `--detach` (run commands in the background),
`--input name=value` (a value the bolt asks for), `--yes` (answer yes to its question and
take input defaults), `--json`.

## Working with Wisp as an agent

1. `wisp spec` (this), then `wisp show --json` to see what exists. In a project
   without a file, `wisp init --yes` writes one from its scripts.
2. Edit `.wisp.json`. Give each bolt a short label and a `notes` line. Keep paths
   relative.
3. `wisp check --json`: exit code 1 means errors. Fix them until `errors` is 0.
4. `wisp <bolt> --dry-run --json`: confirm the plan and where each command would run.
   Steps the file is not allowed to run yet are listed under `waitingForTrust`.
5. If `check` shows commands waiting for trust, ask the user to run `wisp trust`.
6. `wisp <bolt> --inline` to run and read the output directly, or `--detach` for
   servers and then `wisp logs <name>` / `wisp ps --json` / `wisp down <bolt>`.
7. For checks, mark each command `"finishes": true`: `wisp Check --json` gives `ok` and
   a `history` id; `wisp history <id> --log <n>` prints the failing step's output.

## The TUI

`wisp` at a terminal opens it. Everything above can be done there without writing JSON:
a folder with no file is offered a setup; `e` edits the selected bolt through forms
(add, change, move, remove steps, each with what it depends on; its name, notes, what a
failure does, its question, what it needs and its inputs), or, on the workspace
list, the workspace's name, icon and notes; `a` adds a bolt, `N` a personal workspace; the selected bolt is shown whole below the list, its dependencies opened up, and `⏎` runs it in that same box, step by step;
`p` (or `2`) shows what is running, grouped by the bolt that started it, with live
output (`[` and `]` switch to a command's details and past runs); `h` (or `3`) the
history of every run, `D` there deleting runs; `/` filters, and in a log full screen (`f`) or an open run of
History, it filters the log's lines. It takes the mouse too (clicks select, the wheel
scrolls), unless turned off in Settings. `x` on a bolt that needed others asks whether
to stop those too (`wisp down <bolt> --deps` on the command line). Agents should use the
CLI instead.

## Output and exit codes

- `--json` prints one JSON document to stdout. A failure is JSON too, on stdout:
  `{"ok": false, "error": {"code": "NO_BOLT", "message": "…", "hint": "…"}}`, with exit 1.
  Without `--json`, errors go to stderr.
- Exit 0: everything ran. Exit 1: a step failed, `check` found errors, or the command
  was refused (the message says why, and usually what to run instead).
- Without a terminal Wisp never prompts: `wisp` with no bolt lists the bolts, and a bolt
  that asks first stops with `CONFIRM_NEEDED` unless given `--yes`.
