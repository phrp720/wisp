# Getting started

Install Wisp, let it write a pipeline for your project, allow it, and run it.

## 1. Install

```bash
curl -fsSL https://willowisp.dev/install.sh | sh    # macOS and Linux
npm install -g @squaredasher/wisp                   # anywhere, with Node 22.12+
```

On Windows without Node, download `wisp-windows-x64.zip` from
[Releases](https://github.com/phrp720/wisp/releases) and put `wisp.exe` in a folder on your
PATH.

::: tip Tab completion
`wisp completion --install` completes commands, workspaces and pipelines in zsh, bash and
fish. Open a new terminal afterwards.
:::

## 2. Write the file

```bash
cd ~/dev/acme
wisp init
```

It asks for the workspace's name, offering the one it found, then whether to look through
the project. Say yes, and it reads what the project already has (package.json scripts,
compose files, Django, Gradle, a Makefile and [more](./pipelines#let-wisp-write-it)) and
suggests pipelines, each with what it would do. Untick the ones you don't want with space,
and `⏎` writes the file. Say no, and you get a file with no pipelines yet.
Opening `wisp` in a project with no file offers the same.

<Recording name="init" alt="wisp init: it suggests three pipelines, keeps two, writes the file, then wisp trust allows it and wisp blog runs it" />

## 3. Allow it

```bash
wisp trust
```

It shows every command the file would run, then asks. A project's commands only run once
you've allowed that exact file. [Why](./trust)

## 4. Run it

```bash
wisp acme dev    # from any folder: the workspace, then the pipeline
wisp dev         # inside the project, the pipeline is enough
wisp             # the dashboard
```

Servers keep running in the background. `wisp ps` lists them and `wisp down dev` stops
them.

## Next

- [Pipelines](./pipelines): what's in a pipeline, and how to change one
- [Steps](./steps): everything a step can do
- [Use cases](./use-cases): pipelines to copy

## Update or remove

```bash
curl -fsSL https://willowisp.dev/install.sh | sh    # update: installs the latest over it
npm install -g @squaredasher/wisp@latest            # or with npm
```

To remove it, stop what it runs with `wisp stop --all`, then delete the binary
(`rm ~/.local/bin/wisp`, or `npm uninstall -g @squaredasher/wisp`). Its settings, history
and personal workspaces live in the folders `wisp doctor` shows; delete those too for a
clean slate.
