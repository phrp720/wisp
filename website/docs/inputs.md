# Inputs

A pipeline can ask for values each time it runs, like where to deploy or which version to
tag. Its steps use them as `{{name}}`:

```json
{
  "label": "Deploy",
  "inputs": {
    "env": { "ask": "Deploy where?", "choices": ["staging", "production"], "default": "staging" }
  },
  "steps": [{ "run": "./deploy.sh {{env}}", "finishes": true }]
}
```

`wisp deploy` asks at the terminal, and the dashboard asks with a short form. A script
passes the value instead:

```bash
wisp acme deploy --input env=production
```

## Writing one

| Field | |
|---|---|
| `ask` | the question; left out, the input's name is asked |
| `choices` | the only values allowed |
| `default` | offered first; also what a script gets when it passes nothing |

An input with no default stops a script's run when it isn't passed.

## Where `{{name}}` works

In a command, its `cwd` and `env`, a website, a folder or file, a wait for a website, and an
[Asking first](./asking-first) question.

## What a value can be

Plain words, like `staging`, `v1.2.3` or `fix the login`: letters, digits, spaces and
`. _ - / : @ + = , ~`, with no word starting with `-`. Wisp refuses anything else before
anything runs, so a value can't run commands of its own, even through `ssh` or `sh -c`.

To keep a value with spaces as one argument, quote it in your command:
`git commit -m "{{note}}"`.

::: warning A value is still a value
Wisp can't tell what it means: `rm -rf ~/backups/{{name}}` with `../..` still does harm. For a
step like that, use `choices`.
:::

## Kept with the run

The values are kept with each run in [History](./history), and `--retry` uses them again.

::: tip Not for passwords
A value shows on screen and in history. Let the step [fetch its secret](./secrets) instead.
:::
