# Token and Time Ledger

The Pi extension records token, cost, and timing data in each run's `ledger.json`.

Per step, it tracks:

- role: Analyst or Worker;
- phase: plan, worker run, or review;
- model and thinking level;
- input/output/cache token usage;
- estimated cost;
- wall time;
- approximate LLM/orchestration time;
- tool/experiment time;
- external analyst subprocess time;
- tool call counts and errors;
- context usage;
- report artifact path.

This lets you answer:

- How expensive was the Analyst vs the Worker?
- Which model spent the most tokens?
- How much time was LLM thinking vs actual tool/experiment time?
- Did compaction happen, and how long did it take?

Token usage files can include provider names, model names, costs, and internal task identifiers. Do not publish them blindly.
