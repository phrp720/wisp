# Workspaces

A workspace is where pipelines live. There are two kinds, both the same format:

| | Lives in | For |
|---|---|---|
| **A project** | its `.wisp.json`, committed with the code | the team: dev stack, checks, deploys |
| **A personal workspace** | Wisp's own `workspaces` folder | you: things that belong to no repository |

```bash
wisp list           # every workspace you have
wisp show acme      # a workspace's pipelines and their steps
```

## Projects

Wisp finds a project's file by walking up from the folder you're in, like git finds `.git`.
Once you've run something there, or `wisp scan ~/dev` has found it, it's known from any
folder: `wisp acme dev`.

The workspace's name is its `name`, or the folder's name when there's none. An `icon` (an
emoji), a `color` and `notes` make it easier to spot in the dashboard.

## Your own additions

A `.wisp.local.json` beside a project's file is merged into it. Its pipelines are added,
and one with the same label replaces the project's. Your own pipelines, without touching
the shared file. Add it to `.gitignore`.

## Personal workspaces

Tasks that belong to no repository go in a personal workspace: a tunnel to a database, the
backups of your photos, the day's tabs.

```json
{
  "name": "Homelab",
  "icon": "🏠",
  "pipelines": [
    {
      "label": "Tunnel to prod db",
      "steps": [
        { "run": "ssh -N -L 5433:db.internal:5432 bastion", "label": "tunnel", "restart": "on-failure" },
        { "wait": "localhost:5433", "after": "tunnel" }
      ]
    }
  ]
}
```

```bash
wisp homelab tunnel
```

Make one with `N` in the dashboard. It's kept in Wisp's `workspaces` folder (`wisp doctor`
shows where), and its commands run without asking for [trust](./trust): they're yours.

::: tip Your own editor
A folder or file step in a personal workspace can say `"openWith": "WebStorm"`. A project's
file can't: everyone chooses their own editor in [Settings](./settings).
:::
