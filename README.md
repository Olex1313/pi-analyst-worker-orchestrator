<img width="239" alt="Analyst and worker orchestration" src="https://github.com/user-attachments/assets/30f359cc-7e57-47b5-b9a1-aa9605ca1e4e" />

# pi-analyst-worker-orchestrator

Plan with a strong model. Execute with a cheaper model. Track tokens per role.

`pi-analyst-worker-orchestrator` is a Pi Dev package for long coding-agent sessions. It provides an analyst/worker workflow, file-based handoff protocol, compaction gate, token/cost ledger, and per-step timing ledger.

Use a stronger frontier model such as ChatGPT/GPT-5.5 High as the **Analyst** for planning, diagnosis, and review. Use a faster/cheaper model such as DeepSeek V4 Flash High as the **Worker** for code edits, repository search, builds, benchmarks, and experiments.

The goal is to reduce token cost and context bloat while keeping long debugging sessions reproducible.

This project does not depend on specific model providers. ChatGPT/GPT-5.5 High and DeepSeek V4 Flash High are examples, not requirements. Use any models that fit your cost, latency, and quality requirements.

## Big example: expensive Analyst, fast Worker

Use a frontier reasoning model for planning, diagnosis, review, and final decisions. Use a cheaper/fast flash-style model for high-volume but simpler work: code edits, repository search, builds, benchmarks, log collection, and report writing.

```text
Global task:
  Optimize a CUDA/GPGPU sort benchmark on RTX 4090, search for known algorithms,
  implement the fastest practical path, profile with nsys/ncu, and run reliable benchmarks.

Analyst:
  openai-codex/gpt-5.5, thinking: high
  - reads state and worker reports
  - plans one bounded stage
  - rejects weak conclusions
  - decides when results are good enough

Worker:
  opencode-go/deepseek-v4-flash, thinking: high
  - edits code
  - runs builds and benchmarks
  - saves raw logs under ./tmp
  - writes concise reports and suggested next steps

Loop:
  Analyst plan → Worker execute → Analyst review → Worker execute → ... → DONE

Result example:
  Strong model spends tokens only on planning/review.
  Fast model spends cheap tokens on repetitive implementation and experiments.
  Ledger records usage, cost, wall time, tool time, and compactions per role.
```

Start it in Pi Dev with one command:

```text
/analyst-worker implement and benchmark the fastest practical GPU sort path on RTX 4090
```

The extension asks for the Analyst model/thinking and Worker model/thinking, saves them, then automatically runs the loop until done, blocked, or operator input is needed.

## Why

Long coding-agent sessions often fail because the agent:

- forgets old caveats;
- overclaims results from weak experiments;
- keeps running expensive full-dataset tests;
- changes direction without noticing;
- fills the context with logs;
- makes it hard to know how many tokens each role spent.

Pi Analyst/Worker Orchestrator provides a file-based workflow protocol plus a Pi Dev extension to make long multi-model coding-agent work more controlled, cheaper, and easier to resume.

## Selling points

- Use a strong/frontier model as **Analyst**.
- Use a cheap/fast model as **Worker**.
- Worker does code, searches, experiments, builds, profiles, logs.
- Analyst checks conclusions and keeps the run from drifting into false hypotheses.
- State is written to files so long runs are inspectable and resumable.
- Token ledger tracks usage and cost by role/model.
- Wall-time ledger tracks LLM time, tool/experiment time, and compaction time.
- Compaction gate prevents runaway context growth and continues automatically.
- Raw logs stay under `./tmp/`; chat stays compact.

## Installation

From npm, after publication:

```bash
pi install npm:pi-analyst-worker-orchestrator
```

From GitHub:

```bash
pi install git:github.com/UnicornGlade/pi-analyst-worker-orchestrator
```

Pinned to a release tag:

```bash
pi install git:github.com/UnicornGlade/pi-analyst-worker-orchestrator@v0.1.1
```

Try without installing:

```bash
pi -e git:github.com/UnicornGlade/pi-analyst-worker-orchestrator
```

For local development from this checkout:

```bash
pi -e .
```

Only one slash command is registered:

```text
/analyst-worker
```

## First run

On the first run it asks for:

1. Analyst model
2. Analyst thinking level
3. Worker model
4. Worker thinking level
5. Analyst context compaction threshold
6. Worker context compaction threshold

The setup asks for both roles first; only then it probes the selected analyst pair and then the worker pair. Thinking levels are ordered strongest to weakest and clamped to the selected model's supported levels.

Settings are saved both locally and globally:

```text
.pi/analyst-worker.json
~/.pi/agent/analyst-worker.json
```

The local project file wins when present; the global file lets new folders reuse the last Analyst/Worker model and thinking-level choices.

Change settings later with:

```text
/analyst-worker config
```

## Workflow

```text
Operator task
  ↓
Analyst plans one bounded Worker stage
  ↓
Worker executes with tools
  ↓
Worker reports findings, artifacts, validation, and suggested next steps
  ↓
Analyst reviews, corrects, and decides
  ↓
Worker continues or Analyst declares DONE / NEEDS_OPERATOR / ABORT
```

If context approaches the configured threshold, the extension triggers Pi compaction, records it in the ledger, and continues automatically.

## Roles

### Analyst

The Analyst normally does not edit code. It:

- clarifies the goal;
- creates a high-level plan;
- chooses cheap isolating experiments;
- defines stop conditions;
- reviews worker reports;
- catches overclaims and wrong conclusions;
- decides whether the global task is done or another worker step is needed.

### Worker

The Worker executes one bounded stage at a time. It:

- edits code;
- searches the repository;
- runs experiments;
- saves logs under the artifact directory;
- reports results;
- suggests next steps for Analyst review;
- stops on contradictions or unexpected expensive branches.

## Runtime artifacts

Each run writes:

```text
./tmp/aw_<timestamp>_<slug>/state.md
./tmp/aw_<timestamp>_<slug>/ledger.json
./tmp/aw_<timestamp>_<slug>/steps/0001_analyst_plan.md
./tmp/aw_<timestamp>_<slug>/steps/0002_worker_result.md
./tmp/aw_<timestamp>_<slug>/steps/0003_analyst_review.md
```

`ledger.json` records per-step:

- role and phase;
- model and thinking level;
- token usage and cost;
- wall time;
- approximate LLM/orchestration time;
- tool/experiment time;
- external analyst subprocess time when used;
- tool-call counts and errors;
- compaction timing.

## Optional workflow templates

This repository also includes file-based workflow templates under `templates/ai/` and prompt templates under `templates/prompts/`. Install them into a project with:

```bash
./scripts/install.sh /path/to/project
```

This creates:

```text
/path/to/project/ai/state.yaml
/path/to/project/ai/plan.md
/path/to/project/ai/worker_report.md
/path/to/project/ai/analyst_review.md
/path/to/project/ai/compact.md
/path/to/project/ai/operator_interrupt.md
/path/to/project/ai/prompts/analyst.md
/path/to/project/ai/prompts/worker.md
/path/to/project/ai/prompts/compactor.md
```

The chat is an interface. The source of truth should be repository state, git history, prompt records, and these workflow files/artifacts.

## Token ledger example

```json
{
  "analyst": {
    "input": 1000000,
    "output": 200000,
    "cacheRead": 800000,
    "cacheWrite": 50000,
    "total": 2050000,
    "cost": 12.34
  },
  "worker": {
    "input": 7000000,
    "output": 900000,
    "cacheRead": 6000000,
    "cacheWrite": 300000,
    "total": 14200000,
    "cost": 45.67
  }
}
```

Token/cost files can contain provider names, internal task IDs, and cost data; they are ignored by default in `.gitignore`.

## What this helps with

- Pi Dev multi-agent workflows
- analyst / worker coding-agent loops
- token cost optimization
- per-role token tracking
- context compaction
- long-running debugging sessions
- cheaper code execution model with stronger planning model
- reproducible AI coding workflows
- GPU/kernel optimization experiments
- large refactors with repeated validation

## Commands

```text
/analyst-worker                         start or continue via smart menu
/analyst-worker <global task>           start a new task using saved settings
/analyst-worker start --configure       start and reconfigure models/settings
/analyst-worker status                  show state files and token/time ledger
/analyst-worker config                  change saved models/thinking/limits
/analyst-worker pause | resume
/analyst-worker finish
/analyst-worker archive --keep-tmp
/analyst-worker abort
```

## Security

Pi packages can execute code and influence agent behavior. Review the source before installing third-party packages.

This package writes local workflow and token accounting files under `./tmp/`, `.pi/analyst-worker.json`, and optional template files under `./ai/`. It does not upload token logs anywhere.

## Notes on OpenAI Codex / ChatGPT models

For `openai-codex/*` Analyst models, Analyst turns run through a short child `pi` process with proxy environment enabled. Worker turns remain in the main Pi session with tools. The extension restores the prior/safe interactive model and thinking level on operator handoff so normal follow-up prompts keep using the regular Pi transport.

## Repository layout

```text
pi-analyst-worker-orchestrator/
  README.md
  LICENSE
  package.json
  extensions/
    index.ts
  src/
    index.ts
  prompts/
    analyst.md
    worker.md
  templates/
    ai/
    prompts/
    session-state.md
    step-report.md
  docs/
    workflow.md
    token-ledger.md
    installation.md
    pi-dev-integration.md
  examples/
    sfm-debugging/
  scripts/
    install.sh
    next.sh
```

## Status

This is a workflow kit for advanced Pi Dev users running long debugging, optimization, and porting sessions where reproducibility, token cost, and model-role separation matter.

## License

MIT
