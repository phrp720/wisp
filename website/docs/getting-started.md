# Getting started

Wisp starts any project from anywhere, with one word: the database, the server, your editor
in the right folder, the page in your browser. You describe it once; after that, `wisp api`
brings it all up from any terminal, and Wisp keeps watch while you work.

It runs your workflows too: checks, builds and releases, step by step, stopping at the first
failure, with every run kept like a CI.

Three words you'll see:

- **Bolt:** one thing you do, like *Work on api*: what to start, in order.
- **Job:** a bolt that runs to the end, like *Check* or *Build*, and passes or fails.
- **Workspace:** where bolts live: a project's `.wisp.json`, or a list of your own (your
  morning links, say).

## 1. Install

```bash
curl -fsSL https://willowisp.dev/install.sh | sh    # macOS and Linux
npm install -g @squaredasher/wisp                   # anywhere, Node 22.12+
```

Windows without Node: download `wisp-windows-x64.zip` from
[Releases](https://github.com/phrp720/wisp/releases) and put `wisp.exe` in a folder on your PATH.

Then, for tab completion of your workspaces and bolts (zsh, bash or fish):

```bash
wisp completion --install
```

## 2. Write the file

```bash
cd ~/dev/blog
wisp init
```

Wisp reads what the project already has (package.json, compose files, Django, Gradle, a
Makefile and [more](./file#wisp-init)) and suggests bolts. Keep them all with `⏎`, or type
the numbers of the ones you want. Opening `wisp` in a project with no file offers the same.

![wisp init: it suggests three bolts, keeps two, writes the file, then wisp trust allows it and wisp blog runs it](/demo/init.gif)

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

![wisp api: the database, the API server and the page, started in order, each step ticking off](/demo/cli.gif)

Servers keep running in the background: `wisp ps` lists them, `wisp down api` stops them.

**From any folder,** the same word works: `wisp api` finds the bolt in any project you've
used. If two projects have one, name the project: `wisp acme api`. `wisp scan ~/dev` finds
projects you haven't used yet.

## Update or remove

```bash
curl -fsSL https://willowisp.dev/install.sh | sh     # update: installs the latest over it
npm install -g @squaredasher/wisp@latest             # or, with npm

wisp stop --all                                       # remove: stop what it runs first,
rm ~/.local/bin/wisp                                  # then the binary (or npm uninstall -g @squaredasher/wisp)
```

Your settings, history and personal workspaces live where `wisp doctor` says; delete those
folders too for a clean slate.

Next: [the dashboard](./dashboard), [the file](./file), [jobs and history](./jobs).
