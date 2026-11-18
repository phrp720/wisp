# Questions

Short answers, each with where to read more.

### Can I run a bolt from any folder?

Yes, by naming the project too: `wisp acme api`. Inside the project, `wisp api` is enough.
`wisp list` shows every project Wisp knows; `wisp scan ~/dev` finds the ones you haven't
used yet. [Getting started](./getting-started#_4-run-it)

### Does it work without a `.wisp.json`?

Open `wisp` in the project, or run `wisp init`: it suggests bolts from what the project has.
For things that belong to no repository, like your morning links, press `N` in the
dashboard for a workspace of your own. [The file](./file#personal-workspaces)

### Do I have to write JSON?

No. `a` adds a bolt and `e` edits one, through forms. [The dashboard](./dashboard#no-json-needed)

### Why didn't my command run?

Probably trust: a project's commands wait until you've allowed that exact file, and any
change, a `git pull` included, asks again. `wisp check` shows what is waiting. [Trust](./trust)

### Where do my servers' logs go?

The Running tab (`2`) shows each one live. From the command line: `wisp ps`, then
`wisp logs <name> -f`. [What's running](./running)

### How do I stop everything?

`x` on a bolt in the dashboard, or `wisp down <bolt>`; add `--deps` for the database it
needed too. `wisp stop --all` stops every command Wisp started. [What's running](./running#up-and-down)

### Can it open WebStorm, or run commands in Ghostty or tmux?

Yes, in Settings (`s`). [Settings](./settings)

### Can the team share bolts?

Yes: commit the `.wisp.json`. Paths are relative to it, so it works on every machine. Your
own extra bolts go in a `.wisp.local.json` beside it, kept out of git. [The file](./file#your-own-additions)

### Does it work on Windows, over SSH, in tmux?

Yes. Over SSH, choose tmux in Settings so commands outlive the connection.
[Settings](./settings)

### How do I update or uninstall it?

Run the install command again to update. [Getting started](./getting-started#update-or-remove)

### Can an AI agent use it?

Yes: `wisp help agents` prints the whole reference, most commands take `--json`, and it
never asks a question without a terminal. An agent can't allow commands; you do.
[For AI agents](./agents)
