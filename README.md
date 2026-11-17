<h1 align="center">🔮 Specter</h1>

<p align="center">
  <b>Start your working context with one word.</b><br />
  The folders, links, apps and commands a task needs — opened and running, in order.
</p>

<p align="center">
  macOS · Linux · Windows · over SSH · inside tmux
</p>

---

```console
$ specter api
running 🏢 Acme · Work on api
  ✓ run    docker compose up db · in Ghostty
  ✓ wait   port 5432
  ✓ folder apps/api — ~/dev/acme/apps/api
  ✓ run    pnpm dev · in Ghostty
  ✓ wait   http://localhost:3000
  ✓ link   http://localhost:3000 · focused its open tab
```

You describe the job once, in a `.specter.json` next to your code. After that, `specter api`
gets you from *"I'm starting on the API"* to everything open and running — database up,
server started, editor in the right folder, the page in your browser.

## Install

```bash
npm install -g @squaredasher/specter
```

Or download a single binary — no Node needed — from
[Releases](https://github.com/phrp720/specter/releases) for macOS, Linux or Windows.

## Quick start

```bash
cd ~/dev/acme
specter init        # reads the project and writes a .specter.json
specter             # opens the TUI: every workspace and its bolts, ⏎ to run
specter api         # or skip it: runs the "api" bolt — any distinctive word works
```

`specter init` doesn't make you start from a blank file. It reads what the project already
says about running itself — `package.json` scripts (monorepos too), `docker compose`
services and their ports, a `Makefile`, `justfile`, `mise` or `Taskfile`, a `Procfile` —
and writes the bolts you'd have written: start the services, wait for the database, start
each app, wait for it to answer, open it. Plus a **Check** job from your lint and test
scripts.

## The TUI

`specter` on its own opens a full-screen view of everything you have — like htop, but for
your projects. It works the same at your desk, over SSH and inside tmux.

```
 🔮 specter                                                              ~/dev/acme
╭──────────────────────────╮╭─────────────────────────────────────────────────────╮
│ Workspaces               ││ 🏢 Acme  2 bolts                                    │
│ ❯ ● 🏢 Acme              ││ ~/dev/acme/.specter.json                            │
│     🧱 infra             ││ ✓ trusted                                           │
│     ☀️ Morning personal  ││                                                     │
│                          ││ Bolts                                               │
│                          ││ ❯ Work on api  5 steps                              │
│                          ││   Work on web  2 steps                              │
│                          ││                                                     │
│                          ││   needs  infra › Database                           │
│                          ││   folder apps/api                                   │
│                          ││   run    api server                                 │
│                          ││   wait   http://localhost:3000                      │
│                          ││   link   http://localhost:3000                      │
╰──────────────────────────╯╰─────────────────────────────────────────────────────╯
 ⏎ run  n dry run  / search  e edit  c check  t trust  p processes  r reload  q quit
```

**You never have to write JSON.** Open Specter in a project that has no file and it offers
to set one up from what it finds. `e` edits a bolt through simple forms — pick what a step
should do ("Run a command", "Start Docker services", "Wait until a website answers"…), fill
in a field or two, done. `a` adds a bolt, `N` a workspace of your own. (`E` still opens the
file itself, for those who'd rather.)

Containers your bolts start are right there with your commands: state, health, ports,
CPU and memory, live logs — `r` restarts one, `x` stops it. And it's all live: when a
server crashes or a database turns unhealthy, Specter tells you at the bottom of the screen.

`⏎` runs the selected bolt and shows each step as it happens — a job's output streams in
live. `x` takes a bolt down, `R` restarts it. `/` searches every workspace and bolt at
once. `p` shows what's running, with live logs, and `h` the history of every
run, opened on the output of whatever failed. `e` opens the file in your `$EDITOR` and
picks up your changes when you close it. `?` lists the rest.

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
| Folder | `{ "folder": "apps/api" }` — opens in your file manager, or your editor |
| File | `{ "file": "docs/runbook.md" }` |
| Link | `{ "url": "https://staging.acme.com" }` — on macOS, focuses the tab if it's already open |
| App | `{ "app": "Slack" }` |
| Command | `{ "run": "pnpm dev", "cwd": "apps/api", "env": { "PORT": 3000 } }` |
| Wait | `{ "wait": 3 }` · `{ "wait": "localhost:5432" }` · `{ "wait": "http://localhost:3000" }` |
| Another bolt | `{ "bolt": "Database" }` · `{ "bolt": "Database", "workspace": "infra" }` |
| Docker services | `{ "compose": "compose.yaml", "services": ["postgres"] }` — waits until they're healthy |

Paths are relative to the file, so it works on everyone's machine. Commit it.

Your editor autocompletes and checks the file as you type — `specter init` adds the
[`$schema`](schema/specter.schema.json) line for you. `specter check` catches the rest.

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
need it, a command Specter already has running is left alone rather than started twice,
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

A `.specter.local.json` beside the project's file — add it to `.gitignore` — is merged in:
its lists are added, and a bolt with the same name replaces the project's. Your own
board, your own scripts, without touching the shared file.

### Personal workspaces

Things that belong to no repository — *Morning*, *On call* — are the same format, kept in
Specter's `workspaces` directory (`specter doctor` shows where).

</details>

## Jobs: checks, builds, releases

Some bolts start things and leave them running. Others should *run to completion* — and
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
- Dependencies that aren't jobs — the database — start as usual and stay up.
- Every run is kept, with each step's time and output:

```console
$ specter history
✗ 3f2a1b  Release job · 2m ago · 41.2s
✓ 9c01de  Check job · 1h ago · 12.8s

$ specter history 3f2a1b
failed Release · Acme · 17/11/2026, 16:07:01 · 41.2s
   1 ✓ wait   port 5432
   2 ✓ run    lint — pnpm lint 3.1s  [--log 2]
   3 ✗ run    test — pnpm test 9.8s exited with code 1  [--log 3]
   4 – run    pnpm build not reached — "test" failed

$ specter history 3f2a1b --log 3      # what the tests printed
```

Run a job before every push — the push is blocked if it fails:

```bash
specter hook pre-push check
```

Or on a schedule, with the cron you already have:
`0 3 * * * specter use ~/dev/acme/.specter.json Release`.

## Up and down

Specter keeps track of every command it starts, wherever it runs. So it knows which bolts
are **up** (● in the TUI), never starts a second copy of a server that's already running,
and can take a bolt down again:

```bash
specter down api          # stop what "api" started
specter down api --deps   # …and the database it needed
specter restart api
```

A bolt's `down` steps run afterwards, for teardown that isn't a process:
`"down": [{ "run": "docker compose stop" }]`.

## Where commands run

Specter keeps them. A dev server, a database, a worker — each runs in the background, on
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

From the command line it's the same: `specter logs web -f` follows one, `specter ps`
lists them, `specter down api` stops a bolt's.

Prefer a window per command? Ask for one with `--window`, or make it the default:
`specter open-with terminal ghostty` — or `tmux`, which on a server you SSH into keeps
everything in a `specter` session you can attach to.

## Trust

A cloned repository could put anything in its `.specter.json`. So its commands — and any
file or app that would execute when opened — **do not run until you've read them and said
yes**:

```bash
specter check    # see exactly what would run
specter trust    # allow this exact file
```

Approval is tied to the file's contents. Any change — a `git pull` included — asks again.

## Commands

| | |
|---|---|
| `specter` | the TUI (`specter status` for plain text) |
| `specter <bolt>` | run a bolt — `--dry-run` to see what would happen first |
| `specter init` | write a `.specter.json` for this project |
| `specter trust` | allow this project's commands |
| `specter list` | every workspace you have, from anywhere |
| `specter show` · `check` | what a workspace holds · what's wrong with it |
| `specter down` · `restart` | take a bolt down · and up again |
| `specter history` | past runs, and what each step printed |
| `specter hook pre-push check` | run a job from a git hook |
| `specter ps` · `logs` · `stop` | what's running |
| `specter scan ~/dev` | find the projects you already have |
| `specter open-with` | pick your editor and terminal |
| `specter doctor` | what works here, and where files live |

Every command takes `--help`; most take `--json`.

## For AI agents

Specter is built to be driven by coding agents. Point yours at it:

```bash
specter spec
```

prints the complete reference — the file format, every command, JSON output and exit
codes, and a check → dry-run → run → read-logs loop — written for an agent reading it cold
([docs/SPEC.md](docs/SPEC.md) is the same text). Commands never prompt without a terminal,
`--json` makes every result machine-readable, and `--inline` puts command output where the
agent can read it.

An agent can write and run bolts, but **it cannot approve its own commands** — `specter
trust` stays yours.

## Development

```bash
pnpm install
pnpm dev -- --help     # run from source
pnpm test              # tests
pnpm typecheck
pnpm build             # dist/, for npm
pnpm compile           # bin/specter, a standalone binary
```

- `src/core` — the format, trust, discovery, running bolts. No CLI code, so other front
  ends can use it.
- `src/platform` — everything specific to macOS, Linux and Windows.
- `src/cli` — the `specter` command.

## License

[MIT](LICENSE)
