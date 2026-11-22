# The .wisp.json file

A project's pipelines live in a `.wisp.json` next to its code. A **pipeline** is a name and
its steps, which run side by side or wait for what they need. Every field is in the
[File reference](./reference).

```json
{
  "$schema": "https://raw.githubusercontent.com/phrp720/wisp/main/schema/wisp.schema.json",
  "name": "Acme",
  "pipelines": [
    {
      "label": "Work on api",
      "notes": "The API with its database, opened in the browser",
      "steps": [
        { "compose": "compose.yaml", "services": ["postgres"], "label": "db" },
        { "folder": "apps/api" },
        { "run": "pnpm dev", "cwd": "apps/api", "label": "api", "after": "db" },
        { "wait": "http://localhost:3000", "label": "up", "after": "api" },
        { "url": "http://localhost:3000", "after": "up" }
      ]
    }
  ]
}
```

- The `label` is what you type, so keep it short. `wisp api` runs this one, and so does its
  slug, `wisp work-on-api`.
- `notes` says what it does, in `wisp show`, `wisp pick`, tab completion and the dashboard.
- Paths are relative to the file, so it works on everyone's machine. Commit it.
- The `$schema` line makes your editor autocomplete and check the file. `wisp check` catches
  the rest.

## wisp init

You rarely write it by hand. `wisp init` reads the project, at its root and one folder down
(a `backend/`, a `frontend/`), suggests pipelines, and asks which to keep
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
| Command | `{ "run": "pnpm dev", "cwd": "apps/api" }` | keeps running; with `"finishes": true`, [Wisp waits for it](./runs) |
| Docker services | `{ "compose": "compose.yaml", "services": ["postgres"] }` | done when they're healthy |
| Another pipeline | `{ "pipeline": "Database" }` | [runs it as one step](#pipelines-in-pipelines) |
| Wait | `{ "wait": "localhost:5432" }` · `{ "wait": "http://localhost:3000" }` · `{ "wait": 3 }` | a port, a website, or seconds |
| Link | `{ "url": "https://staging.acme.com" }` | on macOS, focuses the tab if it's already open |
| Folder | `{ "folder": "apps/api" }` | in your file manager, or your editor |
| File | `{ "file": "docs/runbook.md" }` | |
| App | `{ "app": "Slack" }` | |

Any step can have a `"label"`, the name Wisp shows for it. A command can also take `env`,
`restart` (`"on-failure"` or `"always"`) and a `timeout`: see the
[reference](./reference#command).

## Order

Steps start at once unless they say what they wait for. `"after"` names other steps of the
pipeline by their `label`, and the step starts once all of them have finished:

```json
{
  "label": "Check",
  "steps": [
    { "run": "pnpm install", "label": "install", "finishes": true },
    { "run": "pnpm lint", "label": "lint", "after": "install", "finishes": true },
    { "run": "pnpm test", "label": "test", "after": "install", "finishes": true },
    { "run": "pnpm build", "after": ["lint", "test"], "finishes": true }
  ]
}
```

Lint and test run side by side after the install, and the build waits for both. In the
dashboard's editor, each step has a **Depends on** list to tick.

## Pipelines in pipelines

A pipeline can run another as one of its steps, like the database before the API:

```json
{
  "pipelines": [
    { "label": "Database", "steps": [{ "compose": "compose.yaml", "services": ["postgres"] }] },
    { "label": "Work on api", "steps": [{ "pipeline": "Database", "label": "db" }, { "run": "pnpm dev", "cwd": "apps/api", "after": "db" }] },
    { "label": "Work on web", "steps": [{ "pipeline": "Database", "label": "db" }, { "run": "pnpm dev", "cwd": "apps/web", "after": "db" }] }
  ]
}
```

- A step that waits for it waits for all of its steps.
- It runs once per run, however many steps run it, and what's already running is left alone.
- It's a pipeline of the same file, so each file stands on its own, and renaming a pipeline renames
  the steps that run it. To start another project, use a command:
  `{ "run": "wisp use ~/dev/infra/.wisp.json Database", "finishes": true }`.

## Asking first

For a pipeline with consequences, like a deploy or a restore, `"confirm"` is a question Wisp
asks before it runs:

```json
{ "label": "Deploy", "confirm": "Deploy to production?", "steps": [{ "run": "./deploy.sh", "finishes": true }] }
```

`"confirm": true` asks "Run "Deploy"?". In a script or a cron job there's no one to ask, so
it stops, unless you pass `--yes`. A git hook runs it without asking.

## Inputs

A pipeline can ask for values each time it runs. Its steps use one as `{{name}}`:

```json
{
  "label": "Deploy",
  "inputs": {
    "env": { "ask": "Deploy where?", "choices": ["staging", "production"], "default": "staging" }
  },
  "confirm": "Deploy to {{env}}?",
  "steps": [{ "run": "./deploy.sh {{env}}", "finishes": true }]
}
```

- Wisp asks at a terminal and in the dashboard. A script passes `--input env=production`; a
  value left out takes its default, and one with no default stops the run.
- `choices` limits it to a list. Only `ask` is needed, and even that can go.
- `{{name}}` works in a command, its `cwd` and `env`, a link, a folder or file, a wait for a
  website, and `confirm`.
- A value is plain words, like `staging`, `v1.2.3` or `fix the login`: letters, digits,
  spaces and `. _ - / : @ + = , ~`, with no word starting with `-`. Nothing a shell treats
  specially, so a value can't run commands of its own, even through `ssh` or `sh -c`. To keep
  a value with spaces as one argument, quote it in your command: `git commit -m "{{note}}"`.
- Wisp can't tell what a value means: `rm -rf ~/backups/{{name}}` with `../..` still does
  harm. For a step like that, use `choices`.
- The values are kept with the run in [History](./runs#history), and `--retry` uses them
  again. Don't use inputs for passwords: let the step [fetch its secret](./use-cases#use-a-secret).

## Taking a pipeline down

`wisp down` stops what a pipeline started. `"down"` lists steps to run after that, for teardown
that isn't a process:

```json
{ "label": "Services", "steps": [{ "run": "./start.sh" }], "down": [{ "run": "./stop.sh" }] }
```

## Several operating systems

```json
{ "app": { "macos": "Visual Studio Code", "linux": "code", "windows": "code" } }
{ "run": { "macos": "open -a Docker", "linux": "systemctl --user start docker" } }
{ "folder": "build/win", "os": "windows" }
```

A step for another OS is skipped quietly.

## Your own additions

A `.wisp.local.json` beside the project's file (add it to `.gitignore`) is merged in: its
pipelines are added, and a pipeline with the same name replaces the project's. Your own pipelines,
without touching the shared file.

## Personal workspaces

Tasks that belong to no repository, like *Morning* or *Tunnel*, go in a workspace of your
own: the same format, kept in Wisp's `workspaces` folder (`wisp doctor` shows where). Make
one with `N` in the dashboard. Its commands run without asking: they're yours.
