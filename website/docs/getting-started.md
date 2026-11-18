# Getting started

Wisp starts everything a task needs with one word. You describe it once, as a **bolt** in a
`.wisp.json` next to your code, and `wisp api` gets you from *"I'm starting on the API"* to
everything open and running: the database up, the server started, your editor in the right
folder, the page in your browser.

## Install

```bash
npm install -g @squaredasher/wisp
```

Or download a single binary for macOS, Linux or Windows from
[Releases](https://github.com/phrp720/wisp/releases). It needs no Node.

Check it works:

```bash
wisp --version
wisp doctor      # what works on this machine, and where Wisp keeps its files
```

## Your first bolt

Go to a project and let Wisp write the file:

```bash
cd ~/dev/acme
wisp init
```

`wisp init` doesn't start you from a blank file. It reads what the project already says
about running itself: `package.json` scripts (monorepos too), `docker compose` services and
their ports, a `Makefile`, `justfile`, `mise` or `Taskfile`, a `Procfile`. Then it writes the
bolts you would have written: start the services, wait for the database, start each app,
wait for it to answer, open it. Plus a **Check** job from your lint and test scripts.

Then allow it to run commands (Wisp asks once per file, see [Trust](./trust)):

```bash
wisp check    # see exactly what would run
wisp trust    # allow this file
```

## Run it

```bash
wisp api        # runs the "api" bolt; any distinctive word of its name works
wisp            # opens the TUI: every workspace and bolt, ⏎ to run
```

```console
$ wisp api
running 🏢 Acme · Work on api
  ✓ run    docker compose up db
  ✓ wait   port 5432
  ✓ folder apps/api
  ✓ run    pnpm dev
  ✓ wait   http://localhost:3000
  ✓ link   http://localhost:3000 · focused its open tab
```

The servers keep running in the background. `wisp ps` lists them, `wisp logs api -f`
follows one, and `wisp down api` stops what the bolt started.

## Where next

- [The TUI](./tui): run, watch and edit everything from one screen, without JSON.
- [The .wisp.json file](./file): every kind of step, dependencies, several OSes.
- [Jobs and history](./jobs): checks and builds that stop at the first failure, kept like CI runs.
