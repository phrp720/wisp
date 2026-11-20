# Getting started

Wisp runs the tasks you do every day with one word each: start a project's database, server
and page, run the checks, back up, redeploy. You write the steps once; after that, `wisp api`
runs them, `wisp acme api` does from any terminal, and Wisp keeps watch while you work.

Three words you'll see:

- **Bolt:** one task, like *Work on api* or *Deploy*: its steps, in order.
- **Step:** one thing a bolt does: start a server, wait for a port, run the tests, open a
  page.
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
Makefile and [more](./file#wisp-init)) and offers to suggest bolts, each with what it would
do. Keep the ones you want (space unticks, `⏎` writes), or say no and start from an empty
file. Opening `wisp` in a project with no file offers the same.

![wisp init: it suggests three bolts, keeps two, writes the file, then wisp trust allows it and wisp blog runs it](/demo/init.gif)

## 3. Allow it

```bash
wisp check    # what it would run
wisp trust    # allow this file
```

A file's commands run only once you've allowed them. [Why](./trust).

## 4. Run it

```bash
wisp api      # the "api" bolt: its slug, or any whole word of its name
wisp pick     # choose one from a list
wisp          # the dashboard: every bolt, what's running, history
```

![wisp api: the database, the API server and the page, started in order, each step ticking off](/demo/cli.gif)

Servers keep running in the background: `wisp ps` lists them, `wisp down api` stops them.

**From any folder,** name the project too: `wisp acme api`. `wisp list` shows your projects,
`wisp show acme` lists a project's bolts, and `wisp pick` lets you choose both from a list.
`wisp scan ~/dev` finds projects you haven't used yet.

## Update or remove

```bash
curl -fsSL https://willowisp.dev/install.sh | sh     # update: installs the latest over it
npm install -g @squaredasher/wisp@latest             # or, with npm

wisp stop --all                                       # remove: stop what it runs first,
rm ~/.local/bin/wisp                                  # then the binary (or npm uninstall -g @squaredasher/wisp)
```

Your settings, history and personal workspaces live where `wisp doctor` says; delete those
folders too for a clean slate.

Next: [recipes](./recipes), [the dashboard](./dashboard), [the file](./file), [runs and history](./runs).
