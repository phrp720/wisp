# Settings

Your own choices, saved on this machine only: a project's file never changes them. Press `s`
in the dashboard, or use the command line.

<Recording name="settings" alt="Wisp's settings: categories on the left; folders set to open in WebStorm, then a look at where commands run and when Wisp tells you about a run" />

| Category | Setting | Choices |
|---|---|---|
| Opening | **Folders open in** | the system default, or an editor Wisp found: VS Code, Cursor, Zed, WebStorm, IntelliJ, PyCharm, Sublime Text… or any app by name |
| | **Files open in** | the same, for file steps |
| Running | **Commands run** | in the background (the default), in a terminal window each (Terminal, iTerm, Ghostty, WezTerm, kitty, Alacritty), or in a tmux or zellij session |
| Notifications | **Tell me** · **Webhook** | when Wisp tells you about a run, and where. [Notifications](./notifications) |
| Dashboard | **Mouse** | on (the default) or off, to select text without holding Shift |

In the dashboard, the categories are on the left and their settings on the right. `⏎` (or a
click) edits a category: `[ Save ]` keeps it, `[ Back ]` or `esc` leaves it as it was. A
change applies to the next run, without restarting Wisp.

## From the command line

```bash
wisp open-with                          # what is set
wisp open-with folder WebStorm
wisp open-with file "Visual Studio Code"
wisp open-with terminal ghostty         # a prefix is enough
wisp open-with terminal tmux
```

For one run in windows, without changing the setting: `wisp acme dev --window`.

::: tip On a server
`tmux` suits a server: commands run in a tmux session you can attach to later with
`tmux attach -t wisp`.
:::
