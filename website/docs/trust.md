# Trust

A cloned repository could put anything in its `.wisp.json`. So its commands, and any file or
app that would execute when opened, **do not run until you've read them and said yes**.

```bash
wisp check    # see exactly what would run
wisp trust    # allow this exact file
```

In the TUI, press `t` on a workspace. It lists every command the file would run, and the
**Trust this file** button starts unselected, so a stray `⏎` allows nothing.

## How it works

- Approval is tied to the file's exact contents. Any change, a `git pull` included, asks
  again. `wisp check` shows what changed.
- Until then, links, folders and plain files still open; only what could run code waits.
- Changes you make yourself, through the TUI's editor, keep the file trusted.
- Your personal workspaces are yours, so their commands run without asking.

## Agents

A coding agent can write bolts and run them, but **it cannot approve its own commands**.
`wisp trust` needs you, at a terminal.
