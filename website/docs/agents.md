---
outline: [2, 2]
---

# For AI agents

Wisp is built to be driven by coding agents. Point yours at it:

```bash
wisp help agents     # or: wisp spec
```

It prints the complete reference below: the file format, every command, JSON output and
exit codes, and a check, dry run, run, read logs loop, written for an agent reading it cold.
Commands never prompt without a terminal, `--json` makes every result machine-readable, and
`--inline` puts command output where the agent can read it.

An agent can write and run pipelines, but **it cannot approve its own commands**: `wisp trust`
stays yours.

## The Wisp skill

Wisp's skill is in [`skills/wisp`](https://github.com/phrp720/wisp/tree/main/skills/wisp).
Agents that support skills load it whenever a task involves Wisp.

The complete reference is also on the web as [llms-full.txt](/llms-full.txt), with an index at
[llms.txt](/llms.txt).

---

<!--@include: ../../docs/SPEC.md-->
