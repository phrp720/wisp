# Why Wisp

Starting work on a project is rarely one command. It's the database, then the API once the
database answers, then the web app, then the page in your browser, and the right folder in
your editor. Every time. Wisp turns that into one word, and then keeps an eye on it.

## What it adds to the tools you have

| You have | It runs | What Wisp adds |
|---|---|---|
| `package.json` scripts, `make`, `just`, `mise` tasks | one command | the whole sequence, in order, with waits between steps |
| `docker compose` | containers | the commands outside Docker, your editor and browser, and one place to see both |
| tmuxinator, a shell script | windows or commands | knowing what is up, stopping what it started, never starting a second copy |
| CI | checks, on a server | the same, on your laptop: jobs that stop at the first failure, with history |

Wisp doesn't replace any of them. A bolt calls your scripts, starts your compose services
and runs your checks. It's the conductor, not the orchestra.

## What it's like to use

- **One word.** `wisp api`. Any distinctive word of a bolt's name runs it.
- **One screen.** `wisp` opens a TUI, like htop for your projects: every bolt, what's
  running, its live output, and a word when something crashes.
- **No JSON required.** `wisp init` writes the file from your project, and the TUI edits
  it through forms.
- **No surprises.** Nothing from a cloned repository runs until you've allowed it.
- **No zombies.** Wisp tracks every process it starts and stops all of it, children too.

## Free

Wisp is open source under the MIT license. No account, no telemetry, nothing to pay for.
It runs entirely on your machine.
