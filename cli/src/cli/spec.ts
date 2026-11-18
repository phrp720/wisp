/**
 * The reference `wisp spec` prints, written for whoever is reading it cold: an AI
 * agent most of all. Built into the binary so it is there wherever Wisp is, and kept
 * identical to docs/SPEC.md by a test.
 */
export const SPEC = `# Wisp reference

Wisp starts a project's working context with one word. A \`.wisp.json\` in a project
lists **bolts**; running a bolt opens or runs what it lists, in order: folders, files,
links, apps and shell commands, with optional waits and dependencies between them.

## Files

- \`.wisp.json\`: committed in a project. Wisp finds it by walking up from the
  current directory, like git finds \`.git\`. Paths in it are relative to the file.
- \`.wisp.local.json\`: optional, beside it, usually gitignored. Same format. Its lists
  are added to the project's, its name/icon/color win, and a bolt with the same label
  replaces the project's bolt.
- Personal workspaces: the same format, in the \`workspaces\` directory that
  \`wisp doctor\` prints. Trusted automatically, since they are yours.

## The smallest file

\`\`\`json
{
  "bolts": [
    { "label": "Work on api", "targets": [{ "folder": "apps/api" }, { "run": "pnpm dev", "cwd": "apps/api" }] }
  ]
}
\`\`\`

## Bolt steps

\`targets\` is an ordered list. Each entry is one of:

| Step | Example | Does |
|---|---|---|
| folder | \`{ "folder": "apps/api" }\` | opens in the file manager, or the user's chosen editor |
| file | \`{ "file": "README.md" }\` | opens with its default app, or the user's chosen editor |
| link | \`{ "url": "http://localhost:3000" }\` | opens in the browser (a bare host means https) |
| app | \`{ "app": "Slack" }\` | launches or focuses an app |
| command | \`{ "run": "pnpm dev", "cwd": "apps/api", "env": { "PORT": 3000 } }\` | runs a shell command |
| wait | \`{ "wait": 3 }\`, \`{ "wait": "localhost:5432" }\`, \`{ "wait": "http://localhost:3000" }\` | pauses until seconds pass, a port accepts, or a url answers (60s timeout; object form \`{ "wait": { "port": 5432, "timeout": 120 } }\`) |
| dependency | \`{ "bolt": "Database" }\`, \`{ "bolt": "Database", "workspace": "infra" }\` | runs another bolt first, once per run; skips commands already running |
| docker | \`{ "compose": "compose.yaml", "services": ["postgres"] }\` | \`docker compose up --wait\`: done when the services are healthy; \`wisp down\` stops them; shown with state, health and logs |
| shared asset | \`"Repository"\` | names an asset from a top-level section by its label |

Any inline step may also carry \`"label"\` and \`"os"\`.

## Jobs

A bolt with \`"job": true\` runs to completion instead of starting things: Test, Build,
Release:

\`\`\`json
{ "label": "Check", "job": true, "targets": [{ "bolt": "Database" }, { "run": "pnpm lint" }, { "run": "pnpm test" }] }
\`\`\`

- Its commands run attached, one after another, and their output is kept.
- The first failure stops it: nothing after a failed step runs. A failed job it depends
  on stops it too.
- Bolts it depends on that are not jobs (a database) start the way they always do, and
  stay up.
- Every run is in \`wisp history\`, with each step's duration and output.
- \`wisp hook pre-push Check\` runs it before every push and blocks the push if it fails.

## Up and down

Wisp tracks every command it starts (in a terminal window, a tmux window or the
background), so it knows which bolts are **up**, never starts a second copy of a running
command, and can stop them: \`wisp down <bolt>\` stops the bolt's own commands (\`--deps\`
for the bolts it depends on too), then runs its \`down\` steps:

\`\`\`json
{ "label": "Services", "job": true, "targets": [{ "run": "docker compose up -d" }], "down": [{ "run": "docker compose stop" }] }
\`\`\`

## Shared assets (optional)

Top-level \`links\`, \`folders\`, \`files\`, \`apps\` and \`commands\` declare things once so
several bolts can name them by \`label\`:

\`\`\`json
{
  "links": [{ "label": "Repository", "url": "https://github.com/acme/acme" }],
  "commands": [{ "label": "db", "run": "docker compose up db" }],
  "bolts": [{ "label": "Database", "targets": ["db", { "wait": "localhost:5432" }] }]
}
\`\`\`

A label is unique within its kind. Where a folder and a file share one, \`"folder:spec"\`
names the folder.

## Commands

\`{ "run": "…", "cwd": "…", "env": {…}, "shell": "sh" | "pwsh" | "cmd", "background": true, "restart": "on-failure" | "always" }\`

- \`run\` goes to the user's own shell (\`$SHELL -ilc\`) on macOS/Linux and PowerShell on
  Windows, unless \`shell\` says otherwise. Pipes and \`&&\` work.
- Commands run in the background, under a pseudo-terminal so their output keeps its
  colours, with that output kept: \`wisp logs <name>\`, \`wisp ps\`, and a pane each in
  the TUI. They outlive Wisp. \`--window\`, or \`wisp open-with terminal <app|tmux>\`,
  puts them in terminal or tmux windows instead. A job's commands always run attached.
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

Running a bolt that needs something not yet approved starts nothing: at a terminal it
shows the list and asks to trust and run; without one, or with \`--json\`, it exits 1 with
the error code \`NOT_TRUSTED\`. \`--skip-untrusted\` runs only the approved part.

**Agents: never run \`wisp trust\` yourself. Show the user what \`wisp check\` lists
under "Runs code" and ask them to approve it.**

## CLI

| Command | Does |
|---|---|
| \`wisp\` | at a terminal, the TUI; without one (pipes, scripts, agents), what this project can run |
| \`wisp status\` | what this project can run, as text, even at a terminal |
| \`wisp <bolt>\` | run a bolt of this project by any distinctive word of its label |
| \`wisp use <file> <bolt>\` | run a bolt of a workspace file by path, for cron and scripts |
| \`wisp use <workspace> <bolt>\` | run a bolt of any known workspace |
| \`wisp init [--print] [--yes] [--only <bolts>]\` | write a \`.wisp.json\` from what the project has, at its root and one folder down: package.json and Deno; Python (Django, FastAPI, Flask, pytest, ruff, uv, poetry); Gradle and Maven (Spring Boot); Go; Rust; Rails; PHP and Laravel; .NET; Elixir and Phoenix; docker compose, Makefile, justfile, mise, Taskfile, Procfile. \`--only "Check,Work on api"\` keeps just those of the suggested bolts |
| \`wisp check [path] [--json]\` | validate a file, or the one in a folder: errors, warnings, what would run |
| \`wisp show [workspace] [--json]\` | everything a workspace holds |
| \`wisp list [--json]\` | every known workspace |
| \`wisp trust\` | approve a file's commands (for the user, not an agent) |
| \`wisp down <bolt> [--deps]\` · \`wisp restart <bolt>\` | stop what a bolt started · stop it and run it again |
| \`wisp history [bolt \\| id] [--log <n>] [--json]\` | past runs, each step's result, duration and output |
| \`wisp hook <git-hook> <bolt>\` · \`--list\` · \`--remove\` | run a bolt from a git hook |
| \`wisp ps [--all] [--json]\` · \`wisp logs <run> [-f]\` · \`wisp stop <run> \\| --all\` | what Wisp has running |
| \`wisp scan <dir>\` | find project files under a directory |
| \`wisp doctor [--json]\` | what works here, and where files live |
| \`wisp completion [zsh\\|bash\\|fish] [--install]\` | tab completion for workspaces, bolts and commands (for the user to set up) |
| \`wisp help agents\` · \`wisp spec\` | this reference |

Run flags: \`--dry-run\` (show what would happen and where, change nothing), \`--inline\`
(run commands attached, output here), \`--detach\` (run commands in the background),
\`--all\` (everything, not one bolt), \`--json\`.

## Working with Wisp as an agent

1. \`wisp spec\` (this), then \`wisp show --json\` to see what exists. In a project
   without a file, \`wisp init --yes\` writes one from its scripts.
2. Edit \`.wisp.json\`. Prefer inline steps; add shared assets only when several bolts
   need the same thing. Keep paths relative.
3. \`wisp check --json\`: exit code 1 means errors. Fix them until \`errors\` is 0.
4. \`wisp <bolt> --dry-run --json\`: confirm the plan and where each command would run.
5. If \`check\` shows commands waiting for trust, ask the user to run \`wisp trust\`.
6. \`wisp <bolt> --inline\` to run and read the output directly, or \`--detach\` for
   servers and then \`wisp logs <name>\` / \`wisp ps --json\` / \`wisp down <bolt>\`.
7. For checks, write a job (\`"job": true\`): \`wisp Check --json\` gives \`ok\` and a
   \`history\` id; \`wisp history <id> --log <n>\` prints the failing step's output.

## The TUI

\`wisp\` at a terminal opens it. Everything above can be done there without writing
JSON: a folder with no file is offered a setup; \`e\` edits the selected bolt through forms
(add, change, move, remove steps; rename; make it a job), \`a\` adds a bolt, \`N\` a personal
workspace; \`v\` shows a bolt whole and read-only, its dependencies opened up; \`p\` (or \`2\`)
shows what is running, grouped by the bolt that started it, with live output; \`h\` (or \`3\`)
the history of every run; \`/\` searches. \`x\` on a bolt that needed others asks whether to
stop those too (\`wisp down <bolt> --deps\` on the command line). Agents should use the
CLI instead.

## Output and exit codes

- \`--json\` prints one JSON document to stdout. A failure is JSON too, on stdout:
  \`{"ok": false, "error": {"code": "NO_BOLT", "message": "…", "hint": "…"}}\`, with exit 1.
  Without \`--json\`, errors go to stderr.
- Exit 0: everything ran. Exit 1: a step failed, \`check\` found errors, or the command
  was refused (the message says why, and usually what to run instead).
- Without a terminal Wisp never prompts: \`wisp\` with no bolt lists the bolts.
`;
