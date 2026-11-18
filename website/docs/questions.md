# Questions

Short answers, grouped by topic. Click a question to open it.

## Getting going

::: details Do I have to write the `.wisp.json` myself?
No. Run `wisp init` in the project, or just open `wisp` there: it reads what the project
already has and suggests bolts. After that, `a` adds a bolt and `e` edits one, through forms.

→ [Getting started](./getting-started) · [The dashboard](./dashboard#no-json-needed)
:::

::: details Something without a repository, like my morning links?
Press `N` in the dashboard for a workspace of your own. It's the same format, kept in Wisp's
own folder, and its commands run without asking: they're yours.

→ [Personal workspaces](./file#personal-workspaces)
:::

::: details How do I delete a workspace?
Select it on the left in the dashboard and press `D`. One of your own is deleted. A
project is only removed from your list: its `.wisp.json` stays in the repository.
:::

::: details Is there tab completion?
Yes, for zsh, bash and fish. Run this once, then open a new terminal:

```bash
wisp completion --install
```

`wisp ⇥` then offers commands, this project's bolts and every workspace.

→ [Commands](./commands#setting-up)
:::

## Running things

::: details What's the difference between `wisp <bolt>` and `wisp <workspace>`?
Inside a project, a word is one of its bolts first: `wisp api` runs "Work on api".
Anywhere else, it's a workspace: `wisp payments-service` lists its bolts, and
`wisp payments-service services` runs one. `wisp list` shows each workspace's short name.

→ [How Wisp reads a name](./commands#how-wisp-reads-wisp-name)
:::

::: details Can I run a bolt from any folder?
Yes, by naming the project too: `wisp acme api`. Wisp knows every project you've run a bolt
in; `wisp scan ~/dev` finds the rest.
:::

::: details Wisp asked "which?" and I changed my mind.
Press `⏎` on its own, type `q`, or press Ctrl+C. Nothing runs.
:::

::: details Why didn't my command run?
Most likely trust: a project's commands wait until you've allowed that exact file, and any
change, a `git pull` included, asks again. `wisp check` shows what is waiting.

→ [Trust](./trust)
:::

::: details Where do my servers' logs go?
The Running tab (`2`) shows each one live. From the command line: `wisp ps` lists them and
`wisp logs <name> -f` follows one.

→ [What's running](./running)
:::

::: details How do I stop everything?
`x` on a bolt in the dashboard, or `wisp down <bolt>`; add `--deps` for the database it needed
too. `wisp stop --all` stops every command Wisp started.

→ [Up and down](./running#up-and-down)
:::

::: details What's the difference between a job and a normal bolt?
A normal bolt starts things and leaves them running: servers, databases. A job runs each
command to the end, in front of you, stops at the first failure, and ends with ✓ or ✗:
tests, builds, cleanups. If it finishes, make it a job.

→ [A job, or a normal bolt?](./jobs#a-job-or-a-normal-bolt)
:::

::: details A check failed. Do I have to run it all again?
No: `wisp Check --retry`, or `r` in the dashboard, runs from the step that failed.

→ [Jobs and history](./jobs)
:::

## Your setup

::: details Can folders open in WebStorm, and commands run in Ghostty or tmux?
Yes: press `s` in the dashboard, or use `wisp open-with`.

→ [Settings](./settings)
:::

::: details Does it work on Windows, over SSH, in tmux?
Yes. Over SSH, choose tmux in Settings, so commands keep running after you disconnect.

→ [Settings](./settings)
:::

::: details How do I update or uninstall it?
Run the install command again to update. To uninstall, `wisp stop --all`, then delete the
binary.

→ [Update or remove](./getting-started#update-or-remove)
:::

## Teams and agents

::: details Can my team share bolts?
Yes: commit the `.wisp.json`. Paths in it are relative, so it works on every machine. Your
own extra bolts go in a `.wisp.local.json` beside it, kept out of git.

→ [Your own additions](./file#your-own-additions)
:::

::: details Is it safe to clone a repository that has a `.wisp.json`?
Yes. Nothing in it that runs code starts until you've read it and allowed it with
`wisp trust`.

→ [Trust](./trust)
:::

::: details Can an AI agent use it?
Yes: `wisp help agents` prints the whole reference, most commands take `--json`, and Wisp
never waits on a question without a terminal. An agent can't allow commands; you do.

→ [For AI agents](./agents)
:::
