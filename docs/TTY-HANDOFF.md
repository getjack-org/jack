# TTY Handoff Notes

## Problem
Interactive prompts in Node/Bun often enable raw mode and attach stdin listeners. If the terminal is not restored, the next interactive CLI (like Claude Code) may receive hidden input or feel unresponsive.

## Standard Fix
- Call `restoreTty()` before handing off to an interactive subprocess.
- Ensure any raw-mode prompt cleans up by calling `restoreTty()` in its exit path.

## Implementation
- Shared helper: `src/lib/tty.ts`
- Handoff point: `launchAgent` calls `restoreTty()` before spawning the agent.

## Guidelines
- Any new prompt that uses `process.stdin.setRawMode(true)` must call `restoreTty()` in cleanup.
- Stop spinners before handoff to avoid hidden cursor state.
