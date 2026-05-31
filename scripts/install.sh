#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

mkdir -p "$TARGET/ai"
mkdir -p "$TARGET/ai/prompts"
mkdir -p "$TARGET/tmp"

cp -n "$ROOT_DIR/templates/ai/state.yaml" "$TARGET/ai/state.yaml"
cp -n "$ROOT_DIR/templates/ai/plan.md" "$TARGET/ai/plan.md"
cp -n "$ROOT_DIR/templates/ai/worker_report.md" "$TARGET/ai/worker_report.md"
cp -n "$ROOT_DIR/templates/ai/analyst_review.md" "$TARGET/ai/analyst_review.md"
cp -n "$ROOT_DIR/templates/ai/compact.md" "$TARGET/ai/compact.md"
cp -n "$ROOT_DIR/templates/ai/operator_interrupt.md" "$TARGET/ai/operator_interrupt.md"

cp -n "$ROOT_DIR/templates/prompts/analyst.md" "$TARGET/ai/prompts/analyst.md"
cp -n "$ROOT_DIR/templates/prompts/worker.md" "$TARGET/ai/prompts/worker.md"
cp -n "$ROOT_DIR/templates/prompts/compactor.md" "$TARGET/ai/prompts/compactor.md"

echo "Installed Pi Analyst/Worker Orchestrator templates into $TARGET/ai"
