# Steps

A step is one thing a pipeline does. They come in three groups, the same as in the
dashboard's editor when you add one:

| | Step | For example |
|---|---|---|
| **Start** | 💻 [Run a command](#run-a-command) | `pnpm dev`, `make test`, `./deploy.sh` |
| | 🐳 [Start Docker services](#start-docker-services) | a database, a cache, from a compose file |
| | ⚡ [Run a pipeline](#run-a-pipeline) | the database, before the API |
| **Wait** | ⏳ [Wait until something is ready](#wait-until-something-is-ready) | a website answers, a port opens, a few seconds |
| **Open** | 🌐 [Open a website](#open-a-website) | `http://localhost:3000`, the staging dashboard |
| | 📁 [Open a folder](#open-a-folder) | in your file manager, or your editor |
| | 📄 [Open a file](#open-a-file) | `README.md`, `docs/runbook.md` |
| | 🧩 [Open an app](#open-an-app) | Slack, Figma, Postman |

Every step can also have:

- `label`: its name, shown by Wisp, and how other steps [wait for it](./order).
- `after`: the steps it waits for. Left out, it starts right away.
- `os`: the systems it runs on. [Several operating systems](#several-operating-systems)

## Start

### Run a command

```json
{ "run": "pnpm dev", "cwd": "apps/api", "label": "api" }
```

A command keeps running, like a server, unless it says `"finishes": true`, like a test or a
build. That decides whether Wisp waits for it. [Commands](./commands) has the rest:
`restart`, `timeout`, `env`, which shell.

### Start Docker services

```json
{ "compose": "compose.yaml", "services": ["postgres", "redis"] }
```

Starts them and waits until they're healthy. [Docker](./docker)

### Run a pipeline

```json
{ "pipeline": "Database", "label": "db" }
```

Runs another pipeline of the same file as one step. [Pipelines as steps](./pipelines-as-steps)

## Wait

### Wait until something is ready

```jsonc
{ "wait": "http://localhost:3000" }    // a website that answers
{ "wait": "5432" }                     // a port on this machine
{ "wait": "db:5432" }                  // a port on another host
{ "wait": 3 }                          // a few seconds
```

Ports and websites give up after 60 seconds. For longer, use the object form:
`{ "wait": { "url": "http://localhost:3000", "timeout": 120 } }`.

## Open

### Open a website

```json
{ "url": "http://localhost:5173" }
```

A bare host, like `staging.acme.com`, is taken as `https://`. On macOS, a tab that's
already open is focused instead of opening a second one.

### Open a folder

```json
{ "folder": "apps/api" }
```

In your file manager, or the editor you chose in [Settings](./settings).

### Open a file

```json
{ "file": "docs/runbook.md" }
```

Paths are relative to the `.wisp.json`. A file that would run when opened (`.sh`,
`.command`, `.exe`) waits for [trust](./trust), like a command.

### Open an app

```json
{ "app": "Slack" }
```

A name, a macOS bundle id (`com.tinyspeck.slackmacgap`), or a command on PATH.

## Several operating systems

When a step differs between systems, give one value per OS, or keep it to some of them:

```json
{ "app": { "macos": "Visual Studio Code", "linux": "code", "windows": "code" } }
{ "run": { "macos": "open -a Docker", "linux": "systemctl --user start docker" } }
{ "folder": "build/win", "os": "windows" }
```

A step for another OS is skipped quietly.
