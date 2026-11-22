# Trust

A cloned repository could put anything in its `.wisp.json`. So its commands, and any file or
app that would run code when opened, **wait until you've seen them and said yes**.

```bash
wisp check    # see exactly what would run
wisp trust    # allow this exact file
```

In the dashboard, press `t` on a workspace. It lists every command the file would run, and
the **Trust this file** button starts unselected, so a stray `⏎` allows nothing.

## How it works

- Approval is tied to the file's **exact contents**. Any change, a `git pull` included, asks
  again, and `wisp check` shows what changed.
- Until then, links, folders and plain files still open; only what could run code waits.
- Changes you make yourself, through the dashboard's editor, keep the file trusted.
- Your [personal workspaces](./workspaces#personal-workspaces) are yours, so their commands
  run without asking.

## A pipeline never runs halfway

Press `⏎` on a pipeline that needs trust, and the same list opens first, with
**Trust and run**. `wisp dev` asks the same at a terminal. In a script or a git hook, it stops
with `NOT_TRUSTED` and runs nothing.

| | |
|---|---|
| `wisp trust --list` | the files you've trusted |
| `wisp trust --revoke` | withdraw trust from this one |

::: warning Agents
A coding agent can write pipelines and run them, but **it cannot approve its own commands**.
`wisp trust` needs you, at a terminal.
:::
