# Operator Interruptions

If the operator interrupts a worker or changes requirements mid-run, the workflow should stop and return control to the Analyst.

Recommended state:

```yaml
state: INTERRUPTED_BY_OPERATOR
next_actor: analyst
needs_operator_input: false
```

The worker should write a checkpoint before continuing:

```text
./ai/interrupted_checkpoint.md
```

The checkpoint should include:

- files modified;
- commands running or stopped;
- partial results;
- artifact paths;
- known risks;
- what the operator changed.

The Analyst must review the checkpoint and issue a new bounded worker stage. This prevents unsafe "continue from memory" behavior.
