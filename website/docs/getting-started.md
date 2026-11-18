# Getting started

Wisp starts everything a task needs with one word: the database, the server, your editor in
the right folder, the page in your browser. You describe it once, as a **bolt** in a
`.wisp.json` next to your code.

## 1. Install

```bash
curl -fsSL https://willowisp.dev/install.sh | sh     # macOS and Linux
npm install -g @squaredasher/wisp                     # anywhere, with Node
```

Windows without Node: download it from [Releases](https://github.com/phrp720/wisp/releases).

## 2. Write the file

```bash
cd ~/dev/acme
wisp init
```

Wisp reads what the project already has (package.json, compose files, Django, Gradle, a
Makefile and [more](./file#wisp-init)), suggests the bolts, and you keep the ones you want.

## 3. Allow it

```bash
wisp check    # what it would run
wisp trust    # allow this file
```

A file's commands run only once you've allowed them. [Why](./trust).

## 4. Run it

```bash
wisp api      # the "api" bolt: any distinctive word of its name
wisp          # the dashboard: every bolt, what's running, history
```

```console
$ wisp api
running 🏢 Acme · Work on api
  ✓ run    docker compose up db
  ✓ wait   port 5432
  ✓ run    pnpm dev
  ✓ wait   http://localhost:3000
  ✓ link   http://localhost:3000 · focused its open tab
```

Servers keep running in the background: `wisp ps` lists them, `wisp down api` stops them.
It works from any folder too: `wisp website` finds the bolt in any project you've used.

Next: [the dashboard](./dashboard), [the file](./file), [jobs and history](./jobs).
