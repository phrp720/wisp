<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="website/public/wordmark-dark.svg" />
    <img src="website/public/wordmark-light.svg" alt="Wisp" height="96" />
  </picture><br />
  <sub><sub><i>as in will-o'-the-wisp, the little light that leads the way</i></sub></sub>
</h1>

<p align="center">
  <b>Start your working context with one word.</b><br />
  The folders, links, apps and commands a task needs, opened and running in order.
</p>

<p align="center">
  macOS · Linux · Windows · over SSH · inside tmux
</p>

---

```console
$ wisp api
running 🏢 Acme · Work on api
  ✓ run    docker compose up db · in Ghostty
  ✓ wait   port 5432
  ✓ folder apps/api — ~/dev/acme/apps/api
  ✓ run    pnpm dev · in Ghostty
  ✓ wait   http://localhost:3000
  ✓ link   http://localhost:3000 · focused its open tab
```

You describe the job once, in a `.wisp.json` next to your code. After that, `wisp api`
gets you from *"I'm starting on the API"* to everything open and running: database up,
server started, editor in the right folder, the page in your browser.

## Install

On macOS and Linux, one line, no Node needed:

```bash
curl -fsSL https://willowisp.dev/install.sh | sh
```

It downloads the build for your machine, checks it against the release's checksums, and
puts `wisp` in `~/.local/bin`. [Read it first](https://willowisp.dev/install.sh) if you like.

With Node, on any system:

```bash
npm install -g @squaredasher/wisp
```

Or download it from [Releases](https://github.com/phrp720/wisp/releases): macOS, Linux and
Windows.

## Quick start

```bash
cd ~/dev/acme
wisp init        # reads the project and writes a .wisp.json
wisp             # opens the TUI: every workspace and its bolts, ⏎ to run
wisp api         # or skip it: runs the "api" bolt; any distinctive word works
```

`wisp init` doesn't make you start from a blank file. It reads what the project already
says about running itself, at its root and one folder down (a `backend/`, a `frontend/`):

- **JavaScript:** `package.json` scripts (monorepos too), Deno tasks
- **Python:** Django, FastAPI and Flask servers; pytest, ruff, mypy, tox, nox; poe and pdm
  tasks, run through `uv`, `poetry` or `pipenv` when the project uses one
- **Java and Kotlin:** Gradle and Maven, Spring Boot, through `./gradlew` or `./mvnw`
- **Go, Rust, Ruby on Rails, PHP and Laravel, .NET, Elixir and Phoenix**
- **Anything:** `docker compose` services and their ports, a `Makefile`, `justfile`,
  `mise` or `Taskfile`, a `Procfile`

Then it suggests the bolts you'd have written: start the services, wait for the database,
start each app, wait for it to answer, open it, plus a **Check** job from your lint and test
commands. You keep the ones you want: it asks, or pass `--only "Check,Work on api"`.

## The TUI

`wisp` on its own opens a full-screen view of everything you have, like htop but for
your projects. It works the same at your desk, over SSH and inside tmux.

```
 🔮 wisp   1 Bolts   2 Running ● 2   3 History                     ~/dev/acme
╭──────────────────────────╮╭─────────────────────────────────────────────────────╮
│ Workspaces               ││ 🏢 Acme  3 bolts                                    │
│ THIS FOLDER              ││ ~/dev/acme/.wisp.json                            │
│ ❯ 🏢 Acme                ││ ✓ Allowed to run its commands                       │
│ PROJECTS                 ││                                                     │
│   🧱 infra               ││ ⚡ Bolts                                            │
│ YOURS                    ││ ❯ Work on api ● running  5 steps                    │
│   ☀️ Morning             ││   Work on web  ✓ 3m ago  2 steps                    │
│                          ││   Check job  ✗ failed 1h ago  3 steps               │
│                          ││                                                     │
│                          ││   When you run it, it will:                         │
│                          ││    1. ⚡ infra › Database first                     │
│                          ││    2. start api server                              │
│                          ││    3. wait until http://localhost:3000 answers      │
╰──────────────────────────╯╰─────────────────────────────────────────────────────╯
 ⏎ run · v view · e edit · a add · x stop · / search · 1 2 3 tabs · ? keys
```

**You never have to write JSON.** Open Wisp in a project that has no file and it offers
to set one up from what it finds. `e` edits a bolt through simple forms: pick what a step
should do ("Run a command", "Start Docker services", "Wait until a website answers"…), fill
in a field or two, done. `a` adds a bolt, `D` deletes one, `N` makes a workspace of your
own. (`E` still opens the file itself in your `$EDITOR`, for those who'd rather.)

**Three tabs along the top, one key each**: `1` Bolts (workspaces and their bolts), `2`
(or `p`) Running, `3` (or `h`) History:

- **Bolts.** `⏎` runs the selected one and shows each step as it happens; a job's output
  streams in live. `v` shows it whole and read-only: every step in order, the bolts it needs
  opened up beneath their own number, what each one runs and where, and what is up right
  now. `x` takes it down, and when it needed other bolts (a database, say), asks whether
  to stop those too, warning you if something else still uses them. `R` restarts it.
- **Running.** What your bolts started, grouped under the bolt that started them, each
  with the run that started it (`#4`): commands and Docker containers side by side, with
  state, health, ports, CPU, memory and live logs. `x` stops, `r` restarts, one task or
  a whole bolt. `o` shows the ones that stopped too. An activity log underneath keeps what happened:
  what you ran and stopped, what crashed, what came back.
- **History.** Every run, like a CI: numbered per bolt, with the branch and commit it ran
  on. Open one for its summary, a graph of the bolts it went through, and each step's time
  and output; a failed step opens on its log. `r` retries only what failed.

`/` searches wherever you are: every workspace and bolt from the main screen, what's running
on Running, past runs on History (`acme failed` finds Acme's failed runs). Questions
(trust a file, delete a bolt) are two buttons: `←→` picks, `⏎` confirms, `esc` backs out,
and anything that deletes or allows starts on "no". It's all live: when a server crashes or
a database turns unhealthy, Wisp says so at the bottom of the screen. `?` lists every key.

## The file

A **bolt** is a named list of things to start, in order. That is the whole idea:

```json
{
  "bolts": [
    {
      "label": "Work on api",
      "targets": [
        { "run": "docker compose up db" },
        { "wait": "localhost:5432" },
        { "folder": "apps/api" },
        { "run": "pnpm dev", "cwd": "apps/api" },
        { "wait": "http://localhost:3000" },
        { "url": "http://localhost:3000" }
      ]
    }
  ]
}
```

| Step | Example |
|---|---|
| Folder | `{ "folder": "apps/api" }` · opens in your file manager, or your editor |
| File | `{ "file": "docs/runbook.md" }` |
| Link | `{ "url": "https://staging.acme.com" }` · on macOS, focuses the tab if it's already open |
| App | `{ "app": "Slack" }` |
| Command | `{ "run": "pnpm dev", "cwd": "apps/api", "env": { "PORT": 3000 } }` · add `"restart": "on-failure"` to bring it back if it crashes |
| Wait | `{ "wait": 3 }` · `{ "wait": "localhost:5432" }` · `{ "wait": "http://localhost:3000" }` |
| Another bolt | `{ "bolt": "Database" }` · `{ "bolt": "Database", "workspace": "infra" }` |
| Docker services | `{ "compose": "compose.yaml", "services": ["postgres"] }` · waits until they're healthy |

Paths are relative to the file, so it works on everyone's machine. Commit it.

Your editor autocompletes and checks the file as you type: `wisp init` adds the
[`$schema`](schema/wisp.schema.json) line for you. `wisp check` catches the rest.

<details>
<summary><b>More: shared assets, dependencies, several operating systems, your own additions</b></summary>

### Shared assets

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

### Dependencies

`{ "bolt": "Database" }` runs another bolt first. It runs once per run however many bolts
need it, a command Wisp already has running is left alone rather than started twice,
and bolts that need each other are refused before anything starts. Point at another
project's bolt with `"workspace": "infra"`.

### Several operating systems

```json
{ "app": { "macos": "Visual Studio Code", "linux": "code", "windows": "code" } }
{ "run": { "macos": "open -a Docker", "linux": "systemctl --user start docker" } }
{ "folder": "build/win", "os": "windows" }
```

Commands run in your own shell on macOS and Linux, and PowerShell on Windows; set
`"shell": "sh" | "pwsh" | "cmd"` to say otherwise.

### Your own additions

A `.wisp.local.json` beside the project's file (add it to `.gitignore`) is merged in:
its lists are added, and a bolt with the same name replaces the project's. Your own
board, your own scripts, without touching the shared file.

### Personal workspaces

Things that belong to no repository, like *Morning* or *On call*, are the same format, kept in
Wisp's `workspaces` directory (`wisp doctor` shows where).

</details>

## Jobs: checks, builds, releases

Some bolts start things and leave them running. Others should *run to completion* and
stop the moment something fails. Mark those as a **job**:

```json
{
  "label": "Release",
  "job": true,
  "targets": [{ "bolt": "Database" }, { "bolt": "Check" }, { "run": "pnpm build" }, { "run": "./deploy.sh" }]
}
```

- Commands run here, one after another, with their output on screen.
- **The first failure stops it.** Tests fail, nothing deploys. A failed job it depends on
  stops it too.
- Dependencies that aren't jobs, like the database, start as usual and stay up.
- Every run is kept, with each step's time and output:

```console
$ wisp history
✗ 3f2a1b  Release job · 2m ago · 41.2s
✓ 9c01de  Check job · 1h ago · 12.8s

$ wisp history 3f2a1b
failed Release · Acme · 17/11/2026, 16:07:01 · 41.2s
   1 ✓ wait   port 5432
   2 ✓ run    lint — pnpm lint 3.1s  [--log 2]
   3 ✗ run    test — pnpm test 9.8s exited with code 1  [--log 3]
   4 – run    pnpm build not reached — "test" failed

$ wisp history 3f2a1b --log 3      # what the tests printed
```

Run a job before every push. The push is blocked if it fails:

```bash
wisp hook pre-push check
```

Or on a schedule, with the cron you already have:
`0 3 * * * wisp use ~/dev/acme/.wisp.json Release`.

## Up and down

Wisp keeps track of every command it starts, wherever it runs. So it knows which bolts
are **up** (● in the TUI), never starts a second copy of a server that's already running,
and can take a bolt down again:

```bash
wisp down api          # stop what "api" started
wisp down api --deps   # …and the database it needed
wisp restart api
```

A bolt's `down` steps run afterwards, for teardown that isn't a process:
`"down": [{ "run": "docker compose stop" }]`.

## Where commands run

Wisp keeps them. A dev server, a database, a worker: each runs in the background, on
your machine as if you'd typed it, and shows up in the TUI in a **pane of its own** with
its live, coloured output. No extra windows. They keep running when you close everything,
and they're there again when you reopen it.

```
╭ Running ───────────────╮╭ web dev  pnpm dev  ● running ──────────────────────────╮
│ ● web dev  Shop        ││ ▲ Next.js 16.1.7 (Turbopack)                          │
│   ✓ Ready in 1.2s      ││ - Local:   http://localhost:3000                      │
│ ● postgres  infra      ││ ✓ Ready in 1.2s                                       │
│   ready to accept …    ││ GET / 200 in 84ms                                     │
╰────────────────────────╯╰───────────────────────────────────────────────────────╯
 ↑↓ choose · r restart · x stop · s start · f full screen · pgup/pgdn scroll · h history
```

From the command line it's the same: `wisp logs web -f` follows one, `wisp ps`
lists them, `wisp down api` stops a bolt's.

Prefer a window per command? Ask for one with `--window`, or make it the default:
`wisp open-with terminal ghostty`, or `tmux`, which on a server you SSH into keeps
everything in a `wisp` session you can attach to.

## Trust

A cloned repository could put anything in its `.wisp.json`. So its commands, and any
file or app that would execute when opened, **do not run until you've read them and said
yes**:

```bash
wisp check    # see exactly what would run
wisp trust    # allow this exact file
```

Approval is tied to the file's contents. Any change, a `git pull` included, asks again.

## Commands

| | |
|---|---|
| `wisp` | the TUI (`wisp status` for plain text) |
| `wisp <bolt>` | run a bolt; `--dry-run` shows what would happen first |
| `wisp init` | write a `.wisp.json` for this project |
| `wisp trust` | allow this project's commands |
| `wisp list` | every workspace you have, from anywhere |
| `wisp show` · `check` | what a workspace holds · what's wrong with it |
| `wisp down` · `restart` | take a bolt down · and up again |
| `wisp history` | past runs, and what each step printed |
| `wisp hook pre-push check` | run a job from a git hook |
| `wisp ps` · `logs` · `stop` | what's running |
| `wisp scan ~/dev` | find the projects you already have |
| `wisp open-with` | pick your editor and terminal |
| `wisp doctor` | what works here, and where files live |

Every command takes `--help`; most take `--json`.

## For AI agents

Wisp is built to be driven by coding agents. Point yours at it:

```bash
wisp spec
```

prints the complete reference: the file format, every command, JSON output and exit
codes, and a check → dry-run → run → read-logs loop, written for an agent reading it cold
([docs/SPEC.md](docs/SPEC.md) is the same text). Commands never prompt without a terminal,
`--json` makes every result machine-readable, and `--inline` puts command output where the
agent can read it.

An agent can write and run bolts, but **it cannot approve its own commands**: `wisp
trust` stays yours.

## Development

```bash
pnpm install
pnpm test              # the CLI's tests
pnpm typecheck
pnpm build             # cli/dist, for npm
pnpm compile           # cli/bin/wisp, a standalone binary
pnpm website:dev       # the website, at http://localhost:5173
```

The repository holds two things:

- `cli/`: Wisp itself, published as `@squaredasher/wisp`.
  - `src/core`: the format, trust, discovery, running bolts. No CLI code, so other front
    ends can use it.
  - `src/platform`: everything specific to macOS, Linux and Windows.
  - `src/cli` and `src/tui`: the `wisp` command and its TUI.
- `website/`: the landing page and docs, built with VitePress and served by a Cloudflare
  Worker. `pnpm website:deploy` builds and deploys it.

## License

[MIT](LICENSE)
