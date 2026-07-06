---
"@infracraft/pulumi": minor
---

Remove the `@infracraft/pulumi/agents` module (`hint()` and `AgentHintChannel`).

The agent-operating-hint block printed on every `pulumi` run to guide AI
agents lacking repo context — but the operating rules belong in the
consuming repo's `AGENTS.md`/`CLAUDE.md`, which every agent already loads,
and the hint block otherwise diluted the raw Pulumi output it sat in
(Pulumi even counted it as diagnostics). No replacement; move any stack
reminders into your repo's agent instructions.
