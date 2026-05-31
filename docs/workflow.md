# Workflow

Pi Analyst/Worker Orchestrator runs a two-role loop for long Pi Dev coding-agent sessions.

```text
Operator task → Analyst plan → Worker execute → Analyst review → next Worker stage or DONE
```

## Analyst

The Analyst is a stronger reasoning model. It plans, reviews, updates hypotheses, checks worker claims, and decides the next state.

It should produce exactly one bounded worker stage at a time.

## Worker

The Worker is a faster/cheaper coding model. It edits files, searches the repository, runs experiments, saves logs, and reports concise findings.

It should not silently broaden scope or decide the global direction.

## State

The Pi extension writes runtime state under `./tmp/aw_<timestamp>_<slug>/`. The optional template workflow writes state under `./ai/`.

The chat is an interface; durable state, reports, git history, and artifacts are the source of truth.

## Stop states

- `NEEDS_WORKER`: Analyst has one bounded worker stage.
- `NEEDS_OPERATOR`: human decision needed.
- `DONE`: task is complete and ready for archive.
- `ABORT`: workflow should stop because continuing is unsafe or invalid.
