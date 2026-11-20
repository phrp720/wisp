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
| Command | `{ "run": "pnpm dev", "cwd": "apps/api" }` | starts it and keeps it running ([in a job](./jobs), runs it to the end) |
| Docker services | `{ "compose": "compose.yaml", "services": ["postgres"] }` | done when they're healthy |
| Another bolt | `{ "bolt": "Database" }` | runs it first |
| Wait | `{ "wait": "localhost:5432" }` · `{ "wait": "http://localhost:3000" }` · `{ "wait": 3 }` | a port, a website, or seconds |
| Link | `{ "url": "https://staging.acme.com" }` | on macOS, focuses the tab if it's already open |
| Folder | `{ "folder": "apps/api" }` | in your file manager, or your editor |
| File | `{ "file": "docs/runbook.md" }` | |
| App | `{ "app": "Slack" }` | |

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

## Jobs

`"job": true` makes a bolt run each command to the end, in order, and stop at the first
failure, like a CI job. Use it for what finishes (tests, builds, cleanups); leave it off for
what keeps running (servers). See [a job, or a starter?](./jobs#a-job-or-a-starter)

## Taking a bolt down

`"down"` lists steps to run after Wisp has stopped what the bolt started, for teardown that
isn't a process:

```json
{ "label": "Services", "targets": [{ "run": "./start.sh" }], "down": [{ "run": "./stop.sh" }] }
```

## Shared assets

When several bolts need the same thing, declare it once and name it by label:

```json
{
  "links": [{ "label": "Repository", "url": "https://github.com/acme/acme" }],
  "bolts": [
    { "label": "Work on api", "targets": [{ "folder": "apps/api" }, "Repository"] },
    { "label": "Work on web", "targets": [{ "folder": "apps/web" }, "Repository"] }
  ]
}
```

Sections: `links`, `folders`, `files`, `apps`, `commands`.

## Several operating systems

```json
{ "app": { "macos": "Visual Studio Code", "linux": "code", "windows": "code" } }
{ "run": { "macos": "open -a Docker", "linux": "systemctl --user start docker" } }
{ "folder": "build/win", "os": "windows" }
```

A step for another OS is skipped quietly.

## Your own additions

A `.wisp.local.json` beside the project's file (add it to `.gitignore`) is merged in: its
lists are added, and a bolt with the same name replaces the project's. Your own bolts and
scripts, without touching the shared file.

## Personal workspaces

Things that belong to no repository, like *Morning* or *On call*, are the same format, kept
in Wisp's own `workspaces` folder (`wisp doctor` shows where). Make one with `N` in the dashboard.
Their commands run without asking: they're yours.
