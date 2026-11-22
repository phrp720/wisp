# Questions

Short answers. Click a question to open it.

## Compared to…

::: details make, just, npm scripts, Taskfile?
They run a command. Wisp runs a pipeline: steps side by side or waiting for what they need,
including the moment something is ready (a port, a website, healthy containers). It keeps
track of what it started, so a server never starts twice and `wisp down` stops all of it,
keeps every run with its output, and works from any folder. Your `make` targets and scripts
make good steps: `wisp init` suggests them.
:::

::: details docker compose?
Compose runs containers. Most projects also have things outside them: the dev server on your
machine, a migration, a page to open. A pipeline starts your compose services, waits until
they're healthy, then does the rest.
:::

::: details CI (GitHub Actions and the like)?
CI runs on every push, on someone else's machine. Wisp runs the same checks on yours before
you push, side by side, with each run kept like CI keeps it, and `--retry` for what failed.
It's not a replacement for CI, it's what you run first. On a server, it's handy for what CI
doesn't do: a backup, a cleanup, a restart.
:::

::: details pm2, systemd, supervisord?
They keep services running on a server. Wisp can too (`"restart": "always"`, logs, `wisp ps`),
which suits a small app or a dev machine. For a service that must survive anything, keep
systemd, and let a Wisp pipeline restart it, update it and check it.
:::

::: details shell aliases and scripts?
A script runs one line after another and forgets. A pipeline runs steps in parallel or in order,
knows what it left running, waits for things to be ready, keeps each run's output, asks
before it does something dangerous, and lives in the repo for the whole team.
:::

## Getting going

::: details Do I have to write the `.wisp.json` myself?
No. Run `wisp init` in the project, or just open `wisp` there: it reads what the project
already has and suggests pipelines. After that, `a` adds a pipeline and `e` edits one, through forms.

→ [Getting started](./getting-started) · [The dashboard](./dashboard#no-json-needed)
:::

::: details Something without a repository, like my morning links?
Press `N` in the dashboard for a workspace of your own. Same format, kept in Wisp's own
folder, and its commands run without asking: they're yours.

→ [Personal workspaces](./file#personal-workspaces)
:::

::: details Is there tab completion?
Yes, for zsh, bash and fish: `wisp completion --install`, then open a new terminal.
:::

## Running things

::: details How does Wisp read `wisp <name>`?
One word is a pipeline of the project you're in: `wisp api` runs "Work on api". Two words are a
workspace and its pipeline, from any folder: `wisp acme api`. A word has to be a whole word of the
name or its slug, so `wisp doc` never runs "Documentation" by surprise.

→ [How Wisp reads a name](./commands#how-wisp-reads-wisp-name)
:::

::: details Why didn't my command run?
Most likely trust: a project's commands wait until you've allowed that exact file, and any
change, a `git pull` included, asks again. `wisp check` shows what is waiting.

→ [Trust](./trust)
:::

::: details Why does Wisp wait for some commands and not others?
A command keeps running by default, like a server: Wisp starts it and moves on. One marked
`"finishes": true`, like a test, a build or a backup, is waited for and ends with ✓ or ✗.

→ [Keeps running, or finishes?](./runs#keeps-running-or-finishes)
:::

::: details A command asks something (y/n, a password). What do I do?
Nothing can answer it in the background, so Wisp shows it as **waiting for an answer**. Give
it a flag that skips the question (`--yes`, `CI=1`), or run commands in a terminal window
(Settings), where you can answer.

→ [Commands that ask something](./running#commands-that-ask-something)
:::

::: details How do I stop everything?
`wisp down <pipeline>`, or `x` on a pipeline in the dashboard. `wisp stop --all` stops every command
Wisp started.
:::

::: details Do logs pile up on my disk?
No. Wisp keeps the last 200 runs, a log over 10 MB keeps its last 5 MB, and everything
together stays under 500 MB, the oldest going first. `wisp ps --clear` and
`wisp history --clear` delete them sooner.
:::

## Servers

::: details Can I use it on a server?
Yes: SSH in and `wisp shop deploy`, `wisp ps` or `wisp logs shop -f`, from wherever you land.
Install Wisp there, then run a pipeline once or `wisp scan /srv` so it knows where things are.

→ [Run a server](./use-cases#run-a-server)
:::

::: details Is it safe there?
Nothing listens on the network. Wisp's folders (logs, history, settings) are readable by your
account only. A changed `.wisp.json`, after a `git pull` say, runs nothing until it's trusted
again. A value a pipeline asks for can't carry shell commands. And `wisp notify` tells you when a
cron run fails.
:::

::: details Do commands keep running after I disconnect?
Yes. What Wisp starts in the background keeps running. If you'd rather attach to it later,
choose tmux in Settings: `tmux attach -t wisp`.
:::

## Teams and agents

::: details Can my team share pipelines?
Yes: commit the `.wisp.json`. Paths in it are relative, so it works on every machine,
Windows included. Your own extra pipelines go in a `.wisp.local.json`, kept out of git.

→ [Your own additions](./file#your-own-additions)
:::

::: details Is it safe to clone a repository that has a `.wisp.json`?
Yes. Nothing in it that runs code starts until you've read it and allowed it with
`wisp trust`.
:::

::: details Can an AI agent use it?
Yes: `wisp help agents` prints the whole reference, every command takes `--json`, and nothing
waits on a question without a terminal. An agent can't allow commands; you do.

→ [For AI agents](./agents)
:::
