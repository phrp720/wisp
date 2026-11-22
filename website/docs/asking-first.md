# Asking first

For a pipeline with consequences, like a deploy or a restore, `confirm` is a question Wisp
asks before it runs:

```json
{ "label": "Deploy", "confirm": "Deploy to production?", "steps": [{ "run": "./deploy.sh", "finishes": true }] }
```

`"confirm": true` asks a standard question: `Run "Deploy"?`. The question can use
[inputs](./inputs): `"Deploy to {{env}}?"`.

## Who it asks

| Where it runs | What happens |
|---|---|
| At a terminal | it asks, and runs only on yes |
| In the dashboard | it asks on the pipeline's row |
| From another pipeline | the question comes first, before anything starts |
| A script or cron job | there's no one to ask, so it stops, unless you pass `--yes` |
| A git hook | it runs without asking: you started the push |

```bash
wisp acme deploy --yes    # from a script, when you mean it
```
