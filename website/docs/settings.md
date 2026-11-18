# Settings

Press `s` in the dashboard. Four choices, saved on your machine only: a project's file never
changes them.

![Wisp's settings: choosing WebStorm for folders, then the choices for where commands run](/demo/settings.gif)

| Setting | Choices |
|---|---|
| **Folders open in** | the system default (Finder, your file manager), or an editor Wisp found installed: VS Code, Cursor, Zed, WebStorm, IntelliJ, PyCharm, Sublime Text… or any app by name |
| **Files open in** | the same, for a bolt's file steps |
| **Commands run** | in the background (the default: watch them in the Running tab), in a terminal window each (Terminal, iTerm, Ghostty, WezTerm, kitty, Alacritty), or in a tmux or zellij session |
| **Mouse** | on (the default: click rows and tabs, scroll with the wheel) or off, to select text without holding Shift |

A change applies to the next run, without restarting Wisp. The mouse changes straight away.

## From the command line

```bash
wisp open-with                          # what is set
wisp open-with folder WebStorm
wisp open-with file "Visual Studio Code"
wisp open-with terminal ghostty         # a prefix is enough
wisp open-with terminal tmux            # on a server over SSH: attach later with tmux attach -t wisp
```

One run in windows, without changing the setting: `wisp api --window`.
