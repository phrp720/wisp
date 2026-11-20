# The .wisp.json file

A project's bolts live in a `.wisp.json` next to its code. A **bolt** is a named list of things
to start, in order; that is the whole idea. Every field is in the [File reference](./reference).

```json
{
  "$schema": "https://raw.githubusercontent.com/phrp720/wisp/main/schema/wisp.schema.json",
  "name": "Acme",
  "bolts": [
    {
      "label": "Work on api",
      "notes": "The API with its database, opened in the browser",
      "targets": [
        { "compose": "compose.yaml", "services": ["postgres"] },
        { "folder": "apps/api" },
        { "run": "pnpm dev", "cwd": "apps/api" },
        { "wait": "http://localhost:3000" },
        { "url": "http://localhost:3000" }
      ]
    }
  ]
}
```

A bolt's `label` is what you type, so keep it short: `wisp api`, or its slug `wisp work-on-api`,
runs this one. `notes` says what it does; Wisp shows it in `wisp show`, `wisp pick`, tab
completion and the dashboard.

Paths are relative to the file, so it works on everyone's machine. Commit it. The
`$schema` line (which `wisp init` adds) makes your editor autocomplete and check the file as
you type; `wisp check` catches the rest.

## wisp init

You rarely write it by hand. `wisp init` reads the project, at its root and one folder down
(a `backend/`, a `frontend/`), suggests bolts, and asks which to keep
(`--only "Check,Work on api"` from a script):

- **JavaScript:** `package.json` scripts (monorepos too), Deno tasks
- **Python:** Django, FastAPI, Flask; pytest, ruff, mypy, tox, nox; poe and pdm tasks; run
  through `uv`, `poetry` or `pipenv` when the project uses one
- **Java and Kotlin:** Gradle and Maven, Spring Boot, through `./gradlew` or `./mvnw`
- **Go, Rust, Ruby on Rails, PHP and Laravel, .NET, Elixir and Phoenix**
- **Anything:** `docker compose` services, a `Makefile`, `justfile`, `mise`, `Taskfile`, a
  `Procfile`

## Steps

| Step | Example | |
|---|---|---|
| Command | `{ "run": "pnpm dev", "cwd": "apps/api" }` | starts it and keeps it running; with `"finishes": true`, [waits for it to finish](./runs) |
| Docker services | `{ "compose": "compose.yaml", "services": ["postgres"] }` | done when they're healthy |
| Another bolt | `{ "bolt": "Database" }` | runs it first |
| Wait | `{ "wait": "localhost:5432" }` · `{ "wait": "http://localhost:3000" }` · `{ "wait": 3 }` | a port, a website, or seconds |
| Link | `{ "url": "https://staging.acme.com" }` | on macOS, focuses the tab if it's already open |
| Folder | `{ "folder": "apps/api" }` | in your file manager, or your editor |
| File | `{ "file": "docs/runbook.md" }` | |
| App | `{ "app": "Slack" }` | |
| Together | `{ "together": [ … ] }` | [starts several steps at once](#steps-at-the-same-time) |

Any step can have a `"label"`, the name Wisp shows for it.

### Commands

```json
{
  "run": "pnpm dev",
  "label": "api",
  "cwd": "apps/api",
  "env": { "PORT": 3000 },
  "restart": "on-failure"
}
```

- `cwd` is relative to the file; left out, the command runs in the project's folder.
- `restart`: `"on-failure"` brings it back after a crash, `"always"` whenever it exits. Wisp
  waits 1s, 2s, 4s and so on up to 30s between tries, and gives up after 10 in a row.
- `shell`: commands run in your own shell on macOS and Linux and PowerShell on Windows;
  `"sh"`, `"pwsh"` or `"cmd"` says otherwise.

## Bolts that need bolts

`{ "bolt": "Database" }` runs another bolt first, like the database before the API.

- It runs once per run, however many bolts need it.
- What's already running is left alone, not started twice.
- Another project's bolt: `{ "bolt": "Database", "workspace": "infra" }`.

## Commands that finish

A command keeps running by default, like a server. Give one that finishes `"finishes": true`
(a test, a build, a backup) and Wisp waits for it before the next step. A failed step stops
the run, unless the bolt says `"keepGoing": true`. See
[keeps running, or finishes?](./runs#keeps-running-or-finishes)

## Steps at the same time

`together` starts its steps at once, and the next step waits for all of them. Checks that
don't depend on each other finish sooner:

```json
{
  "label": "Check",
  "targets": [
    { "together": [
      { "run": "pnpm lint", "finishes": true },
      { "run": "pnpm typecheck", "finishes": true },
      { "run": "pnpm test", "finishes": true }
    ] },
    { "run": "pnpm build", "finishes": true }
  ]
}
```

If one fails, the others still finish, so you see every failure, and then the run stops.
Their output comes line by line, each line starting with its step's label, and each step's
log in History stays its own. It works for any step but a bolt: start two servers, or wait
for the database and the cache at once. In the dashboard's editor, `t` runs a step together
with the one before it, or on its own again.

## Asking first

For a bolt with consequences, like a deploy or a restore, `"confirm"` is a question Wisp
asks before it runs:

```json
{ "label": "Deploy", "confirm": "Deploy to production?", "targets": [{ "run": "./deploy.sh", "finishes": true }] }
```

A bolt that runs it asks too. In a script or a cron job there's no one to ask, so it stops,
unless you pass `--yes`. A git hook runs it without asking. `"confirm": true` asks
"Run "Deploy"?".

## Inputs

A bolt can ask for values each time it runs, like where to deploy or which backup to
restore. Its steps use one as `{{name}}`:

```json
{
  "label": "Deploy",
  "inputs": {
    "env": { "ask": "Deploy where?", "choices": ["staging", "production"], "default": "staging" }
  },
  "confirm": "Deploy to {{env}}?",
  "targets": [{ "run": "./deploy.sh {{env}}", "finishes": true }]
}
```

- Wisp asks at a terminal and in the dashboard. A script passes `--input env=production`;
  a value it leaves out takes its default, and one with no default stops the run.
- A value is plain words, like `staging`, `v1.2.3` or `fix the login`: letters, digits,
  spaces and `. _ - / : @ + = , ~`, with no word starting with `-`. No quotes or anything else
  a shell treats specially, so a value can't run commands or pass options of its own, even
  when yours hands it on through `ssh` or `sh -c`. Wisp refuses any other value before
  anything runs. To keep a value with spaces as one argument, put quotes around it in your
  command: `git commit -m "{{note}}"`.
- Wisp can't tell what a value means: `rm -rf ~/backups/{{name}}` with `../..` still does
  harm. For a step like that, use `choices`.
- `{{name}}` works in a command, its `cwd` and `env`, a link, a folder or file, a wait for a
  website, and `confirm`.
- `choices` limits it to a list, and `default` is offered first. Only `ask` is needed, and
  even that can go: the name is asked instead.
- The values are kept with the run in [History](./runs#history), and `--retry` uses them
  again. Don't use inputs for passwords: let the step [fetch its secret](./recipes#use-a-secret).

## Taking a bolt down

`"down"` lists steps to run after Wisp has stopped what the bolt started, for teardown that
isn't a process:

```json
{ "label": "Services", "targets": [{ "run": "./start.sh" }], "down": [{ "run": "./stop.sh" }] }
```

## Reusing steps

A file holds bolts and nothing else: each step is written inside the bolt that takes it.
When several bolts need the same steps (start the database, say), put them in a bolt of
their own and run it first from the others:

```json
{
  "bolts": [
    { "label": "Database", "targets": [{ "compose": "compose.yaml", "services": ["postgres"] }] },
    { "label": "Work on api", "targets": [{ "bolt": "Database" }, { "folder": "apps/api" }] },
    { "label": "Work on web", "targets": [{ "bolt": "Database" }, { "folder": "apps/web" }] }
  ]
}
```

It runs once per run, however many steps need it.

## Several operating systems

```json
{ "app": { "macos": "Visual Studio Code", "linux": "code", "windows": "code" } }
{ "run": { "macos": "open -a Docker", "linux": "systemctl --user start docker" } }
{ "folder": "build/win", "os": "windows" }
```

A step for another OS is skipped quietly.

## Your own additions

A `.wisp.local.json` beside the project's file (add it to `.gitignore`) is merged in: its
bolts are added, and a bolt with the same name replaces the project's. Your own bolts and
scripts, without touching the shared file.

## Personal workspaces

Things that belong to no repository, like *Morning* or *On call*, are the same format, kept
in Wisp's own `workspaces` folder (`wisp doctor` shows where). Make one with `N` in the dashboard.
Their commands run without asking: they're yours.
