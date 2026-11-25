/**
 * The reference `wisp spec` prints, written for whoever is reading it cold: an AI
 * agent most of all. Built into the binary so it is there wherever Wisp is, and kept
 * identical to docs/SPEC.md by a test.
 */
export const SPEC = `# Wisp reference

Wisp runs pipelines on the machine it is installed on, a laptop or a server. A
\`.wisp.json\` in a project lists **pipelines**: each is a list of steps (shell commands,
Docker services, waits, other pipelines, and links, folders, files and apps to open) that
start together unless they name what they wait for with \`after\`.
\`wisp <workspace> <pipeline>\` runs one from any folder. Wisp keeps track of what it
started and keeps every run.

## Files

- \`.wisp.json\`: committed in a project. Wisp finds it by walking up from the
  current directory, like git finds \`.git\`. Paths in it are relative to the file.
- \`.wisp.local.json\`: optional, beside it, usually gitignored. Same format. Its pipelines
  are added to the project's, its name/icon/color win, and a pipeline with the same label
  replaces the project's pipeline.
- Personal workspaces: the same format, in the \`workspaces\` directory that
  \`wisp doctor\` prints. Trusted automatically, since they are yours.

## The smallest file

\`\`\`json
{
  "pipelines": [
    { "label": "Work on api", "steps": [{ "folder": "apps/api" }, { "run": "pnpm dev", "cwd": "apps/api" }] }
  ]
}
\`\`\`

A pipeline's \`label\` is what people type, so keep it short (\`Deploy\`, \`Work on api\`).
Its slug (\`work-on-api\`) or any whole word of it (\`api\`) runs it, never part of a
word. An optional \`"slug"\` (lowercase letters, digits and hyphens, like \`"up"\`) replaces the
slug made from the label: use one when cron lines, git hooks or scripts call the pipeline,
so a renamed label doesn't break them. An optional \`"notes"\` says what it does in a line,
and Wisp shows it beside the pipeline in \`wisp show\`, \`wisp pick\`, tab completion and
the TUI.

## Pipeline steps

\`steps\` lists the pipeline's steps. Each entry is one of:

| Step | Example | Does |
|---|---|---|
| folder | \`{ "folder": "apps/api" }\` | opens in the file manager, or the user's chosen editor |
| file | \`{ "file": "README.md" }\` | opens with its default app, or the user's chosen editor |
| link | \`{ "url": "http://localhost:3000" }\` | opens in the browser (a bare host means https) |
| app | \`{ "app": "Slack" }\` | launches or focuses an app |
| command | \`{ "run": "pnpm dev", "cwd": "apps/api", "env": { "PORT": 3000 } }\` | runs a shell command |
| wait | \`{ "wait": 3 }\`, \`{ "wait": "localhost:5432" }\`, \`{ "wait": "http://localhost:3000" }\` | pauses until seconds pass, a port accepts, or a url answers below 500 (60s timeout; object form \`{ "wait": { "port": 5432, "timeout": 120 } }\`; \`"status": 200\` with a url asks for that exact answer) |
| docker | \`{ "compose": "compose.yaml", "services": ["postgres"] }\` | \`docker compose up --wait\`: done when the services are healthy; \`wisp down\` stops them; shown with state, health and logs. Before it, or a \`run\` that calls \`docker\`, Wisp checks Docker answers (5s, once a run) and fails the step at once if not |
| pipeline | \`{ "pipeline": "Database" }\` | runs another pipeline of this file as one step; done when all its steps are |

Any step may also carry \`"label"\`, \`"os"\` and \`"after"\`.

## Order: after

**Steps start right away, at the same time, unless they say what they wait for.** Like
Tekton's \`runAfter\`: \`"after"\` names the labels of steps in the same pipeline, and the step
starts once all of them have finished. Anything that must happen in order needs it:

\`\`\`json
{ "label": "Work on api", "steps": [
  { "pipeline": "Database", "label": "db" },
  { "run": "pnpm dev", "label": "api", "after": "db" },
  { "wait": "http://localhost:3000", "label": "up", "after": "api" },
  { "url": "http://localhost:3000", "after": "up" }
] }
\`\`\`

- \`"after": "lint"\` or \`["lint", "test"]\`: waits for each. Left out, the step starts
  with the pipeline. A step can wait for any number of steps, and many can wait for one.
- A pipeline step is one step like any other: it starts when what it waits for is done, and a
  step that waits for it waits for all of its steps. A pipeline runs once per run, however many
  steps run it, and what is already running is left alone.
- A pipeline step names a pipeline of the same file only, so renaming one renames the steps that
  run it. To start another project, use a command:
  \`{ "run": "wisp use ~/dev/infra/.wisp.json Database", "finishes": true }\`.
- A \`after\` naming no step of the pipeline, a label two steps share, or steps that wait for
  each other make the pipeline refuse to run, with the reason (\`wisp check\` shows it).
- Steps that run at the same time print their output line by line, each line prefixed with
  the step's label; each step's log stays its own. \`--dry-run\` numbers the steps by when
  they can start: the same number means the same time.

## Commands that finish, and failures

A command keeps running by default: a server, a watcher. Wisp starts it and moves on. A
command with \`"finishes": true\` is waited for, attached, with its output kept: a test, a
build, a backup, a deploy. One pipeline can mix both:

\`\`\`json
{ "label": "Check", "steps": [{ "pipeline": "Database", "label": "db" }, { "run": "pnpm lint", "label": "lint", "after": "db", "finishes": true }, { "run": "pnpm test", "after": "lint", "finishes": true }] }
\`\`\`

- A failed step stops the run: steps already running finish, and nothing new starts. \`"keepGoing": true\` on a pipeline reports a failure and runs
  the rest anyway.
- \`"timeout": "10m"\` (or \`"30s"\`, \`"1h"\`, or seconds) on a command that finishes: if it takes
  longer, Wisp stops it and everything it started, and the step fails ("ran over its 10m
  timeout"). Without one, Wisp waits as long as it takes. A command that keeps running takes
  no timeout (\`wisp check\` warns).
- A command that keeps running is never started twice; one that finishes runs every time.
- Every run is in \`wisp history\`, with each step's duration and output, from the moment
  it starts. Until it ends it has \`"running": true\`, and \`pending\` lists the steps not
  done yet; the ones in progress have \`"running": true\` and a \`log\` that fills as it goes.
  \`"interrupted": true\` means Wisp stopped before the run did. \`"cancelled": true\` (with
  \`"ok": false\`) means someone stopped it: \`x\` in the dashboard, or stopping a command or container it
  started while it ran (the Running tab, \`wisp stop\`, \`wisp down\`); the cut-off step has \`"cancelled": true\` too. It is not
  a failure: it doesn't count for \`wisp notify changes\`, and its notification says "cancelled".
- \`wisp hook pre-push Check\` runs it before every push and blocks the push if it fails.
  Its commands should finish: one that keeps running cannot block a push.

## Asking first

\`"confirm": "Deploy to production?"\` on a pipeline makes Wisp ask before it runs it, or any
pipeline that runs it (\`true\` asks \`Run "<label>"?\`). At a terminal it asks; without one, or
with \`--json\`, it runs nothing and exits 1 with \`CONFIRM_NEEDED\`. \`--yes\` runs it
without asking. Dry runs and git hooks never ask.

**Agents: ask the user the question yourself, and pass \`--yes\` only once they agree.**

## Inputs

A pipeline can ask for values each time it runs; its steps use one as \`{{name}}\`:

\`\`\`json
{ "label": "Deploy", "inputs": { "env": { "ask": "Deploy where?", "choices": ["staging", "production"], "default": "staging" } }, "confirm": "Deploy to {{env}}?", "steps": [{ "run": "./deploy.sh {{env}}", "finishes": true }] }
\`\`\`

- \`ask\` is the question (the name when left out), \`choices\` limits the value to a list,
  \`default\` is used when none is given. Each input is optional except its name.
- A value is plain words: letters, digits, spaces and \`. _ - / : @ + = , ~\`, with no word
  starting with \`-\`. Anything else (quotes, \`$ ; | & < > * ? ! # %\`, backticks, tabs, line
  breaks) is refused with \`INVALID_INPUT\` before anything runs, so a value can't inject
  commands or options, even through \`ssh\` or \`sh -c\`. It goes into the command as typed;
  write \`"{{note}}"\` to keep one with spaces as a single argument.
- \`{{name}}\` works in a command, its \`cwd\` and \`env\`, a link, a folder or file, a wait for a
  website, and \`confirm\`. A pipeline uses only the inputs it declares; one it runs that declares
  the same name gets the same value. In a link's address, a \`{{name}}\` that isn't declared is an
  error (\`wisp check\`), not a warning.
- \`{{env.NAME}}\` in a link (\`{ "url": "{{env.PRODUCTION_URL}}/admin" }\`) or a wait's url is read
  from the environment when the step runs; unset, the step fails. Such a step waits for
  \`wisp trust\` like a command. History keeps the step as written, not the address. A wait's url
  may be a whole input too (\`{ "wait": { "url": "{{website}}" } }\`); a value that isn't an
  http(s) address fails the wait at once.
- \`--input env=production\` gives a value (once per input). Without a terminal, or with
  \`--json\`, a value not given takes its default; one with no default exits 1 with
  \`INPUT_NEEDED\`, naming the flag. \`--yes\` takes the defaults at a terminal too.
- The values are kept with the run: \`inputs\` in \`wisp history <id> --json\` and in the
  run's JSON result. \`--retry\` reuses them. Never for secrets: a step fetches its own from
  where it is kept, like \`TOKEN=$(op read op://ops/deploy/token) ./deploy.sh\`, so it is never
  written in the file, shown, or kept in history.

**Agents: pass every value with \`--input\`. If you don't know one, ask the user; never guess
where to deploy.**

## Up and down

Wisp tracks every command it starts (in a terminal window, a tmux window or the
background), so it knows which pipelines are **up**, never starts a second copy of a running
command, and can stop them: \`wisp down <pipeline>\` stops the pipeline's own commands (\`--deps\`
for the pipelines it depends on too), then runs its \`down\` steps:

\`\`\`json
{ "label": "Services", "steps": [{ "run": "docker compose up -d", "finishes": true }], "down": [{ "run": "docker compose stop" }] }
\`\`\`

A file holds pipelines and nothing else: every step is written inside the pipeline that takes it.
To reuse steps, put them in a pipeline of their own and run it from others as a \`{ "pipeline": … }\` step.

## Commands

\`{ "run": "…", "finishes": true, "cwd": "…", "env": {…}, "shell": "sh" | "pwsh" | "cmd", "background": true, "restart": "on-failure" | "always" }\`

- \`run\` goes to the user's own shell, as a login shell so it has their PATH, on
  macOS/Linux and PowerShell on Windows, unless \`shell\` says otherwise. Pipes and \`&&\` work.
- Commands run in the background, under a pseudo-terminal so their output keeps its
  colours, with that output kept: \`wisp logs <name>\`, \`wisp ps\`, and a pane each in
  the TUI. They outlive Wisp. \`--window\`, or \`wisp open-with terminal <app|tmux>\`,
  puts them in terminal or tmux windows instead. A command that finishes always runs
  attached.
- \`restart\` brings a command back when it stops: \`"on-failure"\` after a crash, \`"always"\`
  whenever it exits. It waits 1s, 2s, 4s… up to 30s, and gives up after 10 in a row. It
  keeps working after Wisp is closed.
- A command that asks something can't be answered in the background. **Agents: give it a
  non-interactive flag (\`--yes\`, \`CI=1\`) in \`run\`.**
- A background command whose output goes quiet on a question is shown as **waiting**
  (\`wisp ps\`, \`"waiting"\` in \`wisp ps --json\`). It can't be answered there: fix the step.

## Per-OS values

\`app\` and \`run\` may be a map: \`{ "macos": "Visual Studio Code", "linux": "code",
"windows": "code" }\`. Any entry may have \`"os": ["linux", "macos"]\`. Elsewhere it is
skipped quietly. OS names: \`macos\`, \`linux\`, \`windows\`.

## Trust

Commands, and files or apps that would execute when opened, **do not run** until the
user approves that exact file with \`wisp trust\`. Any edit to the file or its local
override withdraws approval until it is approved again. Personal workspaces are trusted.

Running a pipeline that needs something not yet approved starts nothing: at a terminal it
shows the list and asks to trust and run; without one, or with \`--json\`, it exits 1 with
the error code \`NOT_TRUSTED\`. \`--skip-untrusted\` runs only the approved part.

A file that changed since it was trusted is \`stale\`: \`wisp check\` and \`wisp trust\` show
what changed since that approval, the whole file and its local override, before the list.

**Agents: never run \`wisp trust\` yourself. Show the user what \`wisp check\` lists
under "Runs code", and for a \`stale\` file the diff in \`changedSinceTrust\`, and ask them
to approve it.**

## CLI

| Command | Does |
|---|---|
| \`wisp\` | at a terminal, the TUI; without one (pipes, scripts, agents), what this project can run |
| \`wisp status [--json]\` · \`wisp --json\` | what this project can run, as text even at a terminal; \`--json\` prints \`{ project, workspaces }\`: \`project\` as \`wisp show --json\` prints it (\`null\` outside a project), \`workspaces\` as \`wisp list --json\` does |
| \`wisp <pipeline>\` | run a pipeline of this project, and only this project, by its label, slug or a whole word of it. Not a pipeline here: exit 1, \`NO_PIPELINE\`, and the message names what to type. Ambiguous: exit 1, \`AMBIGUOUS\` |
| \`wisp <workspace> <pipeline>\` | run a pipeline of any known workspace, from any folder |
| \`wisp use <file> <pipeline>\` | run a pipeline of a workspace file by path, for cron and scripts. \`use\` is implied above; say it for a pipeline named like a command (\`wisp use list\`) |
| \`wisp pick [workspace]\` | at a terminal, choose a pipeline from a list and run it; without one it asks nothing, prints what \`wisp show\` would and exits 1 because nothing ran; with \`--json\` it prints that list as JSON and exits 0 |
| \`wisp init [--print] [--yes] [--only <pipelines>] [--empty] [--name <name>]\` | write a \`.wisp.json\` from what the project has, at its root and one folder down: package.json and Deno; Python (Django, FastAPI, Flask, pytest, ruff, uv, poetry); Gradle and Maven (Spring Boot); Go; Rust; Rails; PHP and Laravel; .NET; Elixir and Phoenix; docker compose, Makefile, justfile, mise, Taskfile, Procfile. \`--only "Check,Work on api"\` keeps just those of the suggested pipelines |
| \`wisp init --personal --name <name> [--json]\` | create an empty personal workspace, for what belongs to no repository; prints its file |
| \`wisp check [path] [--json]\` | validate a file, or the one in a folder: errors, warnings, what would run |
| \`wisp show [workspace] [--json]\` | a workspace's pipelines: label, slug, notes, what is up, and each one's steps |
| \`wisp rename [workspace] <pipeline> <new name> [--json]\` | rename a pipeline and every step that runs it; the file then needs \`wisp trust\` again |
| \`wisp list [--json]\` | every known workspace |
| \`wisp trust\` | approve a file's commands (for the user, not an agent: without a terminal it refuses with \`NEEDS_CONFIRMATION\`, even with \`--yes\`) |
| \`wisp down <pipeline> [--deps]\` · \`wisp restart <pipeline>\` | stop what a pipeline started · stop it and run it again |
| \`wisp history [pipeline \\| id] [--log <n>] [--json]\` | past runs, each step's result, duration and output; \`notified: [{ url, ok, problem? }]\` says which webhooks the run's notification reached |
| \`wisp history [pipeline \\| id] --clear [--all]\` | delete a run, a pipeline's runs, or this project's (every project's with \`--all\`); runs still going are kept |
| \`wisp hook <git-hook> <pipeline>\` · \`--list\` · \`--remove\` | run a pipeline from a git hook |
| \`wisp ps [--all] [--json]\` · \`wisp logs <run> [-f] [-n <lines>] [--grep <pattern>] [--since-restart]\` · \`wisp stop <run> \\| --all\` | what Wisp has running; in \`ps --json\`, \`restarts\` counts how often a command was brought back, \`lastExit\` is the code it last exited with, and \`gaveUp\` means it stopped restarting; \`--grep\` keeps the lines that match (a regular expression, case ignored), \`--since-restart\` only its last restart and what it printed after |
| \`wisp scan <dir>\` | find project files under a directory |
| \`wisp notify [failures\\|changes\\|all\\|off] [--test] [--reveal] [--json]\` · \`wisp notify screen on\\|off\` · \`wisp notify add <url> [workspace...]\` · \`wisp notify remove <url \\| n> [workspace...]\` | when Wisp tells the user about a run they might have missed (nobody watched it, or it took over 30s): a desktop notification (unless \`screen off\`: webhooks only), and every webhook for all workspaces or for the run's own (https only, or http to localhost). With no workspace, \`add\` is for every workspace and \`remove\` removes the webhook; \`--json\` lists \`webhooks: [{ number, url, workspaces, lastDelivery }]\`, \`workspaces: null\` meaning every one, \`lastDelivery\` \`{ at, ok, problem? }\` or null. The url is shown without its secret part; remove a webhook by its number. \`--reveal\` shows whole addresses: don't use it unless the user asks. \`changes\` tells once when a pipeline starts failing and once when it works again, for checks run from cron. The user's own setting: don't change it for them. \`WISP_NOTIFY=off\` silences one command |
| \`wisp doctor [--json]\` | what works here, and where files live |
| \`wisp completion [zsh\\|bash\\|fish] [--install]\` | tab completion for workspaces, pipelines and commands (for the user to set up) |
| \`wisp help agents\` · \`wisp spec\` | this reference |
| \`wisp help all\` | the help with every command, the setup ones included |

Run flags: \`--dry-run\` (show what would happen and where, change nothing), \`--inline\`
(run commands attached, output here), \`--detach\` (run commands in the background),
\`--input name=value\` (a value the pipeline asks for), \`--yes\` (answer yes to its question and
take input defaults), \`--json\`.

## Working with Wisp as an agent

Pipelines to copy for common jobs (a dev stack, checks before a push, a deploy that asks
first, an app on a server, a nightly backup, a check that a site is up) are at
https://willowisp.dev/docs/use-cases.md; every docs page is Markdown at \`/docs/<page>.md\`.

1. \`wisp spec\` (this), then \`wisp show --json\` to see what exists. In a project
   without a file, \`wisp init --yes\` writes one from its scripts (\`--empty\` for one with no
   pipelines, \`--name\` to name it). For a task that belongs to no repository,
   \`wisp init --personal --name <name> --json\` creates a personal workspace and prints its file.
2. Edit \`.wisp.json\`. Give each pipeline a short label and a \`notes\` line. Keep paths
   relative.
3. \`wisp check --json\`: exit code 1 means errors. Fix them until \`errors\` is 0.
4. \`wisp <pipeline> --dry-run --json\`: confirm the plan and where each command would run.
   Steps the file is not allowed to run yet are listed under \`waitingForTrust\`.
5. If \`check\` shows commands waiting for trust, ask the user to run \`wisp trust\`.
6. \`wisp <pipeline> --inline\` to run and read the output directly, or \`--detach\` for
   servers and then \`wisp logs <name>\` / \`wisp ps --json\` / \`wisp down <pipeline>\`.
7. For checks, mark each command \`"finishes": true\`: \`wisp Check --json\` gives \`ok\` and
   a \`history\` id, and a failed step's last 40 lines are in its \`output\`. For more,
   \`wisp history <id> --log <n>\` prints the step's whole output.

## The TUI

\`wisp\` at a terminal opens it. Everything above can be done there without writing JSON:
a folder with no file is offered a setup; \`e\` edits the selected pipeline through forms
(add, change, move, remove steps, each with what it depends on; its name, notes, what a
failure does, its question and its inputs), or, on the workspace
list, the workspace's name, icon and notes; \`a\` adds a pipeline, \`N\` a personal workspace; the selected pipeline is shown whole below the list, the pipelines it runs opened up and its problems said in words, and \`⏎\` runs it in that same box, step by step (\`c\` checks it there, running nothing);
\`p\` (or \`2\`) shows what is running, grouped by the pipeline that started it, with live
output (\`[\` and \`]\` switch to a command's details and past runs); \`h\` (or \`3\`) the
history of every run, \`D\` there deleting runs; \`/\` filters, and in a log full screen (\`f\`) or an open run of
History, it filters the log's lines. It takes the mouse too (clicks select, the wheel
scrolls), unless turned off in Settings. \`x\` on a pipeline that needed others asks whether
to stop those too (\`wisp down <pipeline> --deps\` on the command line). Agents should use the
CLI instead.

## Output and exit codes

- \`--json\` prints one JSON document to stdout. A failure is JSON too, on stdout:
  \`{"ok": false, "error": {"code": "NO_PIPELINE", "message": "…", "hint": "…"}}\`, with exit 1.
  Without \`--json\`, errors go to stderr.
- Exit 0: everything ran. Exit 1: a step failed, \`check\` found errors, or the command
  was refused (the message says why, and usually what to run instead). Exit 130: the run was
  cancelled, by someone stopping a command it started while it ran. The same with
  \`--json\`: \`"ok": false\` and exit 1 go together.
- Without a terminal Wisp never prompts: \`wisp\` with no pipeline lists the pipelines, and a pipeline
  that asks first stops with \`CONFIRM_NEEDED\` unless given \`--yes\`.

### What --json prints

Shortened; paths are absolute, and fields with nothing to say are left out.

\`wisp show --json\`: the workspace and its pipelines. In a file not yet trusted, its
commands are not in \`steps\` but in \`withheld\`, so look at both.

\`\`\`json
{ "name": "Shop", "file": "/…/.wisp.json", "personal": false, "trust": "untrusted",
  "pipelines": [{ "label": "Check", "slug": "check", "notes": "lint, then test",
    "inputs": [{ "name": "env", "ask": "env", "choices": ["staging", "production"], "default": "staging" }],
    "confirm": "Deploy to {{env}}?",
    "steps": [{ "kind": "command", "name": "test", "value": "pnpm test", "finishes": true, "after": ["lint"] }] }],
  "diagnostics": [], "withheld": [{ "kind": "command", "label": "test", "value": "pnpm test", "cwd": "/…" }] }
\`\`\`

\`wisp check --json\`: \`errors\` and \`warnings\` count \`diagnostics\`; \`commands\` is every
command the file declares, with where it runs. A \`stale\` file adds \`changedSinceTrust\`:
when it was trusted, and a diff per file that changed, \`-\` and \`+\` lines with a little
context, \`…\` between the parts.

\`\`\`json
{ "file": "/…/.wisp.json", "trust": "untrusted", "errors": 0, "warnings": 1,
  "diagnostics": [{ "level": "warning", "at": "trust", "message": "2 commands declared but will not run", "hint": "…" }],
  "commands": [{ "label": "test", "run": "pnpm test", "cwd": "/…", "finishes": true }], "withheld": [] }
\`\`\`

\`\`\`json
"changedSinceTrust": { "trustedAt": "2026-11-20T09:12:00.000Z", "changes": [{ "file": "/…/.wisp.json",
  "diff": "          {\\n-           \\"run\\": \\"./deploy.sh\\",\\n+           \\"run\\": \\"./deploy.sh --force\\",\\n            \\"finishes\\": true" }] }
\`\`\`

\`wisp <pipeline> --json\` (and with \`--dry-run\`): how each step went. \`history\` is the run's
id (\`null\` for a dry run); \`log\` is a step's output file; a failed step has \`error\`
and, when it kept its output, \`output\`: its last 40 lines, without colours.
A command without \`"finishes": true\` keeps running in the background: its \`ok\` means it
started, not that it succeeded. \`running\` lists those, with the id for \`wisp logs <run>\`.

\`\`\`json
{ "workspace": "Shop", "pipeline": "Check", "ok": false, "dryRun": false, "history": "54b4b6af2c92",
  "steps": [
    { "kind": "command", "name": "lint", "value": "pnpm lint", "ok": true, "durationMs": 720, "log": "/…/1.log" },
    { "kind": "command", "name": "test", "value": "pnpm test", "ok": false, "error": "exited with code 3", "durationMs": 526, "log": "/…/2.log",
      "output": "FAIL src/cart.test.ts\\n  expected 3, got 2" }],
  "running": [], "waitingForTrust": [] }
\`\`\`

\`wisp history <id> --json\`: the same steps with \`stage\` (when each could start), plus
\`number\`, \`trigger\` (\`cli\`, \`hook\`, \`tui\` or \`retry\`), \`startedAt\` and \`finishedAt\`.
A run asked for by its id gives each failed step's \`output\` too.
\`wisp history <id> --log <n>\` prints step n's output as plain text.

### Error codes

| Code | Means | Next |
|---|---|---|
| \`NO_PROJECT\` | no \`.wisp.json\` above this folder, and no workspace named | \`wisp init\`, or name a workspace |
| \`NO_TARGET\` | not in a project, and the command needs one | name a workspace (the message lists them) |
| \`NO_PIPELINE\` | this project has no pipeline by that name | \`wisp show\` |
| \`NOT_FOUND\` | no workspace, or no pipeline in it, by that name | \`wisp list\`, \`wisp show <workspace>\` |
| \`AMBIGUOUS\` | the name matches several pipelines, or several workspaces share it (the message lists their files) | for a pipeline, use its slug or full label; for two workspaces, run one by its file: \`wisp use <file> <pipeline>\`, or ask the user to rename one (\`wisp list\` warns about shared names) |
| \`NOT_TRUSTED\` | the file's commands are not approved yet | ask the user to run \`wisp trust\` |
| \`CONFIRM_NEEDED\` | the pipeline asks first | ask the user, then pass \`--yes\` |
| \`NEEDS_CONFIRMATION\` | \`wisp trust\` was run without a person at a terminal | show the user what \`wisp check\` lists, and ask them to run \`wisp trust\` |
| \`INPUT_NEEDED\` | an input has no value and no default | \`--input name=value\` |
| \`INVALID_INPUT\` | a value, argument or option Wisp can't take (with \`--json\`, a mistyped option is reported this way too) | the message says which |
| \`PROJECT_INVALID\`, \`INVALID_JSON\` | the file is not valid JSON, or not an object | \`wisp check\` |
| \`BROKEN_PIPELINE\`, \`CYCLE\` | \`after\` names a missing step, or steps or pipelines wait for each other | \`wisp check\` |
| \`PROJECT_EXISTS\` | \`wisp init\` found a file already | edit it, or \`--force\` if the user wants it replaced |
| \`NOTHING_TO_RETRY\` | \`--retry\` with nothing that failed, or a pipeline changed since | run it whole |
| \`NO_SHELL\` | the shell a command asks for is not here | the message names it |
| \`NO_DISPLAY\` | nowhere to open a terminal window | \`--detach\` or \`--inline\` |
| \`HOOK_EXISTS\`, \`NOT_OURS\` | a git hook Wisp did not write is in the way | leave it to the user |
| \`NO_REPOSITORY\` | \`wisp hook\` outside a git repository | |
| \`LOCKED\` | another wisp holds a lock too long | the message names the lock file |
| \`DUPLICATE_NAME\` | a pipeline or workspace by that name exists | pick another name |
`;
