# Settings

Press `s` in the dashboard. Your own choices, saved on your machine only: a project's file
never changes them.

The categories are on the left, and the selected one's settings with their values on the
right. `⏎` (or a click) edits them there: `[ Save ]` keeps the whole category, `[ Back ]`
or `esc` leaves it as it was.

<Recording name="settings" alt="Wisp's settings: categories on the left; folders set to open in WebStorm, then a look at where commands run and when Wisp tells you about a run" />

| Category | Setting | Choices |
|---|---|---|
| Opening | **Folders open in** | the system default (Finder, your file manager), or an editor Wisp found installed: VS Code, Cursor, Zed, WebStorm, IntelliJ, PyCharm, Sublime Text… or any app by name |
| | **Files open in** | the same, for a pipeline's file steps |
| Running | **Commands run** | in the background (the default: watch them in the Running tab), in a terminal window each (Terminal, iTerm, Ghostty, WezTerm, kitty, Alacritty), or in a tmux or zellij session |
| Notifications | **Tell me** | when a run fails (the default), when any run ends, or never. See [notifications](#notifications) |
| | **Webhook** | an address to post it to as well, for a server: Slack, Discord, ntfy or your own |
| Dashboard | **Mouse** | on (the default: click rows and tabs, scroll with the wheel) or off, to select text without holding Shift |

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

## Notifications

Wisp tells you when a run fails that you might have missed: one nobody watched (cron, a
script) or one that took over 30 seconds. It shows a notification on this screen, and posts
to your webhook if you set one. Slack, Discord and ntfy get a message they show as it is;
any other address gets JSON with the pipeline, the step that failed, the run and the machine.

```bash
wisp notify                                   # what is set
wisp notify all                               # failures, all, or off
wisp notify --webhook https://ntfy.sh/my-server
wisp notify --test                            # send one now, to check
```

The webhook must be `https://`, so the message and any secret in the address travel
encrypted; plain `http://` works only to this machine (`localhost`). A run you started with
`--json` never notifies: whatever started it reads the result.
`WISP_NOTIFY=off` turns it off for one command.
