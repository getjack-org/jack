#!/bin/bash
# Ralph Wiggum loop for Registry Migration
#
# TWO WAYS TO RUN:
#
# 1. RECOMMENDED: Use the official plugin (preserves context between iterations)
#    - Start Claude Code interactively: claude
#    - Install plugin: /plugin install ralph-loop@claude-plugins-official
#    - Run: /ralph-loop "$(cat docs/internal/RALPH-PROMPT.md)" --max-iterations 50 --completion-promise "STATUS: COMPLETE"
#
# 2. HEADLESS: Use this script with -p flag (each iteration is new session)
#    ./scripts/ralph-registry.sh
#
# The plugin approach is better for multi-chunk work because context persists.

set -e

PROGRESS_FILE="docs/internal/RALPH-PROGRESS.md"
PROMPT_FILE="docs/internal/RALPH-PROMPT.md"
MAX_ITERATIONS=50
ITERATION=0

echo "Starting Ralph loop for Registry Migration (headless mode)..."
echo "Progress file: $PROGRESS_FILE"
echo "Max iterations: $MAX_ITERATIONS"
echo ""
echo "NOTE: For better results, use the plugin approach instead:"
echo "  1. Run: claude"
echo "  2. Run: /plugin install ralph-loop@claude-plugins-official"
echo "  3. Run: /ralph-loop \"\$(cat $PROMPT_FILE)\" --max-iterations 50 --completion-promise \"STATUS: COMPLETE\""
echo ""
echo "Press Ctrl+C to cancel, or wait 5 seconds to continue with headless mode..."
sleep 5

while [ $ITERATION -lt $MAX_ITERATIONS ]; do
  ITERATION=$((ITERATION + 1))
  echo "=== Iteration $ITERATION ==="

  # Check if done
  if grep -q "STATUS: COMPLETE" "$PROGRESS_FILE"; then
    echo "All chunks complete! Exiting."
    break
  fi

  # Get current chunk
  CURRENT_CHUNK=$(grep "^## Current Chunk:" "$PROGRESS_FILE" | sed 's/## Current Chunk: //')
  echo "Working on Chunk $CURRENT_CHUNK"

  # Run Claude in headless mode with -p flag
  claude -p --dangerously-skip-permissions "$(cat $PROMPT_FILE)"

  echo ""
  echo "Iteration $ITERATION complete. Checking progress..."
  sleep 2
done

if [ $ITERATION -ge $MAX_ITERATIONS ]; then
  echo "Max iterations reached. Check progress file for status."
fi
