# Analyst Plan: SFM Debugging Example

## Global goal

Find the smallest reliable reproduction for the SFM bundle-adjustment divergence and identify whether the robust loss refactor changed residual weighting.

## Bounded worker stage

### Goal

Run the smallest known failing fixture before and after the robust loss refactor and save logs/metrics.

### Allowed files / commands

- Read `tests/sfm/fixtures/*` and the robust loss implementation.
- Run only the minimal fixture test, not the full dataset suite.

### Stop conditions

Stop if the fixture does not reproduce, if unrelated tests fail, or if code changes are required before measurement.

### Expected report

Report exact command lines, pass/fail status, residual summary metrics, and artifact paths.
