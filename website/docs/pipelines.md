# Pipelines

A pipeline is a name and a list of [steps](./steps). A project keeps its pipelines in a
`.wisp.json` next to its code:

```json
{
  "$schema": "https://raw.githubusercontent.com/phrp720/wisp/main/schema/wisp.schema.json",
  "name": "Acme",
  "pipelines": [
    {
      "label": "Dev",
      "notes": "The database, the API and the web app",
      "steps": [
        { "compose": "compose.yaml", "services": ["postgres"], "label": "db" },
        { "run": "pnpm dev", "cwd": "apps/api", "label": "api", "after": "db" },
        { "run": "pnpm dev", "cwd": "apps/web", "label": "web" },
        { "wait": "http://localhost:3000", "label": "up", "after": "api" },
        { "url": "http://localhost:5173", "after": ["up", "web"] }
      ]
    },
    {
      "label": "Verify",
      "steps": [
        { "run": "pnpm lint", "label": "lint", "finishes": true },
        { "run": "pnpm test", "label": "test", "finishes": true },
        { "run": "pnpm build", "after": ["lint", "test"], "finishes": true }
      ]
    }
  ]
}
```

Commit it: paths in it are relative to the file, so it works on everyone's machine.

## Its name

The `label` is what you type, so keep it short: *Dev*, *Verify*, *Deploy*.

```bash
wisp acme dev    # from any folder: the workspace, then the pipeline
wisp dev         # inside the project
```

Any whole word of the label works, and so does its slug: `wisp api` runs *Work on api*, and
so does `wisp work-on-api`. Never part of a word, so `wisp doc` won't run *Documentation*
by surprise. [How Wisp reads a name](./running-pipelines#how-wisp-reads-a-name)

### A slug of its own

The slug is made from the label, so it changes when the label does. Give a pipeline a
`slug` when you want a short name of your own, or one that cron lines, git hooks and
scripts can count on through renames:

```json
{ "label": "Start the whole stack", "slug": "up", "steps": [] }
```

`wisp acme up` runs it, and the words of its label still work too. In the dashboard's
editor it's the **Slug** row, with the default shown until you type your own.

Two pipelines can't answer to the same slug: `wisp check` warns, and neither runs by that
name until one changes.

To rename one, press `e` on it in the dashboard, or:

```bash
wisp rename dev "Dev stack"
```

Steps that run it follow the new name. From the command line, the file then needs
[`wisp trust`](./trust) again: a name decides what `wisp dev` runs.

`notes` is a line on what it does. It shows in `wisp show`, `wisp pick`, tab completion and
the dashboard.

## Let Wisp write it

You rarely write the file by hand. `wisp init` reads the project, at its root and one folder
down (a `backend/`, a `frontend/`), and suggests pipelines:

| From | It finds |
|---|---|
| JavaScript | `package.json` scripts (monorepos too), Deno tasks |
| Python | Django, FastAPI, Flask; pytest, ruff, mypy, tox, nox; poe and pdm tasks, through `uv`, `poetry` or `pipenv` |
| Java and Kotlin | Gradle and Maven, Spring Boot, through `./gradlew` or `./mvnw` |
| Others | Go, Rust, Ruby on Rails, PHP and Laravel, .NET, Elixir and Phoenix |
| Anything | `docker compose` services, a `Makefile`, `justfile`, `mise`, `Taskfile`, a `Procfile` |

| | |
|---|---|
| `wisp init` | asks for the name, then whether to look through the project |
| `wisp init --empty` | a file with no pipelines, without looking |
| `wisp init --name Acme` | the workspace's name, without asking |
| `wisp init --only "Dev,Verify" --yes` | from a script: just these of the suggestions |

## Change it without JSON

In the [dashboard](./dashboard#no-json-needed), `a` adds a pipeline and `e` edits one, step
by step, through forms. `E` opens the file in your editor if you'd rather.

<Recording name="editor" alt="Making a pipeline in the dashboard: name it, then add a command, a wait and a website through short forms, then run it" />

## Check it

The `$schema` line makes your editor autocomplete and check the file as you type.
`wisp check` catches the rest: a step waiting for a label no step has, a folder that's gone,
a pipeline that runs one this file doesn't have.

## More on pipelines

- [Order](./order): which steps run together, and which wait
- [Pipelines as steps](./pipelines-as-steps): run one as a step of another
- [Inputs](./inputs): values it asks for each time it runs
- [Asking first](./asking-first): a question before a deploy goes out
- [Workspaces](./workspaces): where pipelines live, besides a project's file
