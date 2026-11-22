# Getting started

Wisp runs pipelines on your own machines. You write a pipeline's steps once: start the
database, wait until it's healthy, start the API and the web app, open the page. Steps run
side by side or wait for what they need. After that, `wisp acme dev` runs it from whatever
folder you're in, and Wisp keeps track of everything it started. It works the same on your
laptop and on a server.

Three words you'll see:

- **Pipeline:** a name and its steps, like *Dev*, *Verify* or *Deploy*.
- **Step:** one thing a pipeline does: start a server, wait for a port, run the tests, open a page.
- **Workspace:** where pipelines live: a project's `.wisp.json`, or a personal workspace.

## 1. Install

```bash
curl -fsSL https://willowisp.dev/install.sh | sh    # macOS and Linux
npm install -g @squaredasher/wisp                   # anywhere, Node 22.12+
wisp completion --install                           # optional: tab completion
```

Windows without Node: download `wisp-windows-x64.zip` from
[Releases](https://github.com/phrp720/wisp/releases) and put `wisp.exe` in a folder on your PATH.

## 2. Write the file

```bash
cd ~/dev/blog
wisp init
```

Wisp reads what the project already has (package.json, compose files, Django, Gradle, a
Makefile and [more](./file#wisp-init)) and suggests pipelines, each with what it would do. Keep
the ones you want: space unticks, `⏎` writes. Opening `wisp` in a project with no file
offers the same.

<Recording name="init" alt="wisp init: it suggests three pipelines, keeps two, writes the file, then wisp trust allows it and wisp blog runs it" />

## 3. Allow it

```bash
wisp trust    # shows every command the file would run, then asks
```

A project's commands run only once you've allowed that exact file. [Why](./trust).

## 4. Run it

```bash
wisp acme api   # from any folder: the workspace, then the pipeline
wisp api        # inside the project, the pipeline alone is enough
wisp            # the dashboard: every pipeline, what's running, history
```

A name is any whole word of the pipeline's label, or its slug: `api` runs *Work on api*.

<Recording name="cli" alt="wisp api: the database, the API server and the page, started in order, each step ticking off" />

Servers keep running in the background: `wisp ps` lists them, `wisp down api` stops them.
`wisp list` shows your workspaces, and `wisp scan ~/dev` finds projects you haven't used yet.

## Next

- [Use cases](./use-cases): dev stacks, checks before a push, deploys, servers, scheduled
  jobs and your own machine, each with a pipeline to copy.
- [The .wisp.json file](./file): every kind of step, order, inputs, asking first.
- [The dashboard](./dashboard): run, watch and edit pipelines in your terminal.

## Update or remove

```bash
curl -fsSL https://willowisp.dev/install.sh | sh     # update: installs the latest over it
npm install -g @squaredasher/wisp@latest             # or, with npm

wisp stop --all                                      # remove: stop what it runs first,
rm ~/.local/bin/wisp                                 # then the binary (or npm uninstall -g @squaredasher/wisp)
```

Settings, history and your own workspaces live where `wisp doctor` says. Delete those
folders too for a clean slate.
