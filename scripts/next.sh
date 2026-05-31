#!/usr/bin/env bash
set -euo pipefail

STATE="./ai/state.yaml"

if [[ ! -f "$STATE" ]]; then
  echo "Missing ./ai/state.yaml"
  exit 1
fi

echo "Current state:"
grep -E "state:|current_actor:|next_actor:|needs_compaction:|global_goal_done:|needs_operator_input:" "$STATE" || true

echo
echo "Next action:"

if grep -q "needs_compaction: true" "$STATE"; then
  echo "Run compactor:"
  echo "  cat ./ai/prompts/compactor.md"
elif grep -q "next_actor: analyst" "$STATE"; then
  echo "Switch Pi Dev model to analyst model and run:"
  echo "  cat ./ai/prompts/analyst.md"
elif grep -q "next_actor: worker" "$STATE"; then
  echo "Switch Pi Dev model to worker model and run:"
  echo "  cat ./ai/prompts/worker.md"
else
  echo "No next_actor set."
fi
