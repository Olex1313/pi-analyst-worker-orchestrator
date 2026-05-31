---
name: analyst-worker
description: Use this skill when operating the Pi Analyst/Worker workflow, including /analyst-worker, state files, bounded worker execution, analyst reviews, operator handoffs, saved settings, and archiving prompt records.
---

# Analyst/Worker Workflow

This skill documents the role protocol used by the `pi-analyst-worker-orchestrator` package.

## User command

Normal usage is one smart command:

```text
/analyst-worker
```

It starts a task when no task is active and shows a control panel when a task is active. If the command is run without an inline description, it asks for the global task in an empty editor. The artifact title/slug is generated as a short summary from the task description. Once started, the normal loop is automatic: analyst plans/reviews, worker executes one bounded stage, analyst reviews and plans the next stage, and so on until done, blocked, or operator input is required.

Explicit subcommands:

```text
/analyst-worker <global task description>
/analyst-worker start <global task description>
/analyst-worker start --configure
/analyst-worker status
/analyst-worker config
/analyst-worker next
/analyst-worker pause
/analyst-worker resume
/analyst-worker finish
/analyst-worker archive --keep-tmp
/analyst-worker archive --delete-tmp
/analyst-worker abort
```

Saved settings live in both `.pi/analyst-worker.json` and the global `~/.pi/agent/analyst-worker.json`; local project settings win, while the global file lets other folders reuse the last chosen Analyst/Worker models and thinking levels. If models/settings are already configured, the workflow runs a quick availability probe for each model/thinking pair, then reuses them and tells the operator how to change them with `/analyst-worker config` or `/analyst-worker start --configure`. For `openai-codex/*` Analyst models, Analyst turns may run through a proxy-safe child `pi` process; Worker turns remain in the main Pi session with tools. External Codex analyst turns must not leave the main interactive session selected to Codex; restore the prior/safe model on operator handoff so normal follow-up prompts use the regular Pi transport.

## Role headers

Every visible role output must start with one of:

```text
[ANALYST: <model>]
Step: <nnn>
State: <state>
Task: <slug>
```

```text
[WORKER: <model>]
Step: <nnn>
Action: <bounded action>
Task: <slug>
```

```text
[OPERATOR HANDOFF]
State: <state>
Reason: <reason>
Expected operator input:
  <question or next command>
```

## Analyst rules

The analyst reads `state.md`, `ledger.json`, latest step reports, relevant repo files/logs, and operator constraints. The analyst must:

1. State diagnosis/review.
2. Maintain hypothesis and open questions.
3. Maintain a high-level plan for the global task.
4. Give exactly one bounded worker stage when work is needed.
5. Define stop conditions and expected report.
6. Return to operator on ambiguity, invalid results, risk, credentials/network needs, context/cost pressure, or trade-offs.

## Worker rules

The worker executes exactly one bounded task. The worker must:

1. Restate the task.
2. Make minimal scoped changes or run one experiment.
3. Put scratch logs under the configured artifact dir; summarize instead of pasting large logs/pages/source dumps into chat.
4. Stop on unexpected results or out-of-scope diffs.
5. Report files changed, commands run, validation, artifacts, and blocker status.
6. Add a concise worker recommendation for the next stage; the analyst makes the final decision.

## Stop conditions

Return control to the operator if:

- result contradicts the hypothesis;
- worker did the wrong experiment;
- production behavior changed outside the goal;
- git diff contains unrelated files/logs/tmp;
- regression/test result is worse than threshold;
- task requires a trade-off;
- credentials/API keys/network are needed;
- context is close to the configured limit;
- model/tool capability is insufficient.

## State files

The extension writes:

```text
state.md
ledger.json
steps/0001_analyst_plan.md
steps/0002_worker_result.md
steps/0003_analyst_review.md
```

Read these files before making or reviewing workflow decisions.
