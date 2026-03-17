# Plan: Deconflict Local vs Remote MCP Servers

## Problem

Two Jack MCP servers exist — local (stdio, `jack mcp serve`) and remote (HTTP, `mcp.getjack.org`). When both are connected in Claude Code, agents use remote file tools (`update_file`, `read_project_file`) instead of built-in filesystem tools, causing partial deploys and failures.

Real failure: agent staged 2/3 files via remote MCP, deployed a broken worker, remote MCP disconnected, agent was stuck. Final advice: "just run `jack ship`" — what it should have done from the start.

## Why the remote file tools exist

The remote MCP was built for **terminal-less environments** (claude.ai web, Claude Desktop without shell). In these environments:
- There's no local filesystem — agent can't use `Read`/`Edit`/`Write`
- `update_file` works around LLM output token limits (>15KB files can't be passed inline in a single `deploy(changes: {...})` call)
- `list_project_files` / `read_project_file` let the agent read deployed source since there's no local copy
- `list_staged_changes` lets the agent review what's queued before deploying

These tools are **essential for remote-only** and **harmful for local** environments.

## Root causes (3 contributing factors)

1. **Same server name**: Both register as `"jack"` → `mcp__jack__*` vs `mcp__claude_ai_jack__*`. Looks like variants of the same thing to the LLM.
2. **Semantic overlap**: `update_file(path, content)` looks identical to `Edit(file_path, ...)` to an LLM — both "write content to a file path" but target completely different filesystems.
3. **Overbroad guidance**: CLAUDE.md says "always prefer `mcp__jack__*` tools" — written when only local MCP existed. Agents now match remote tools to this rule.

## Decision: Mutually exclusive servers

Local + remote should **never be connected simultaneously**. The user has confirmed this.

- **Claude Code** (has terminal + local FS): Use local MCP only
- **claude.ai web** (no terminal, no FS): Use remote MCP only
- **Claude Desktop**: One or the other based on whether user has shell access

## Solution: 3-layer fix

### Layer 1: Rename remote server (`jack` → `jack-cloud`)

**What:** Change the remote MCP server name from `"jack"` to `"jack-cloud"`.

**Why:** Eliminates namespace collision. Tools become `mcp__jack_cloud__*` — visually distinct from local `mcp__jack__*`. Few remote users, breaking change is acceptable.

**Files:**
- `apps/mcp-worker/src/server.ts` line 16: `name: "jack"` → `name: "jack-cloud"`
- Any documentation/setup instructions referencing the remote server name

### Layer 2: Rename remote file tools to signal intent

Current names are generic and overlap with local filesystem concepts. Rename to make purpose obvious:

| Current | Proposed | Why |
|---------|----------|-----|
| `update_file` | `stage_file` | "Stage" signals this is for a deploy pipeline, not direct file editing |
| `list_staged_changes` | `list_staged_files` | Consistent with `stage_file` naming |
| `list_project_files` | `browse_deployed_source` | "Deployed" makes clear this reads from the cloud, not local FS |
| `read_project_file` | `read_deployed_file` | Same — clearly reads the deployed version, not local |

**Update descriptions** to include negative guidance:
- `stage_file`: "Stage a file for cloud deployment via deploy(staged=true). Only use this in environments WITHOUT local filesystem access (claude.ai web). If you have Read/Edit/Write tools, edit files locally and use deploy_project or `jack ship` instead."
- `browse_deployed_source`: "List source files in the DEPLOYED version on Jack Cloud. If you have local filesystem access, use Glob/LS on the project directory instead."
- `read_deployed_file`: "Read a file from the DEPLOYED version on Jack Cloud. If you have local filesystem access, use the Read tool on the local file instead."

**Files:**
- `apps/mcp-worker/src/server.ts` — tool registrations (names + descriptions)
- `apps/mcp-worker/src/tools/source.ts` — function names (optional, internal)
- `apps/mcp-worker/CLAUDE.md` — tool table

### Layer 3: Dual-connection detection + prevention

**3a. `jack mcp install` detects remote MCP:**
When installing the local MCP config to `~/.claude.json`, check if a `"jack-cloud"` or `"jack"` HTTP entry already exists. If so:
- Warn: "Both local and remote Jack MCP servers are configured. This causes tool conflicts. The local server covers all remote capabilities when you have filesystem access."
- Offer to remove the remote entry

**3b. Narrow CLAUDE.md guidance:**
Change the "prefer MCP" instruction from:
> "CRITICAL: When Jack MCP is connected, always prefer `mcp__jack__*` tools over CLI commands or wrangler"

To:
> "When Jack MCP is connected, prefer `mcp__jack__*` tools for cloud operations (deploy, databases, logs, crons, domains, storage, vectorize). For file operations, always use built-in Read/Edit/Write tools — never `stage_file`, `read_deployed_file`, or similar remote MCP tools."

**3c. Update `agents://context` resource and `mcp context` hook:**
Same narrowing of guidance in the dynamic context that gets injected into agent sessions.

**Files:**
- `apps/cli/src/lib/mcp-config.ts` — add detection logic in `installMcpConfigsToAllApps()`
- `CLAUDE.md` — narrow guidance
- `apps/cli/src/mcp/resources/index.ts` — update `agents://context`
- `apps/cli/src/commands/mcp.ts` — update `mcp context` output

## What we're NOT doing

- **Not merging servers**: The local and remote MCP serve different environments. Keeping them separate is correct.
- **Not removing remote file tools**: They're essential for claude.ai web users who have no local FS.
- **Not adding capability negotiation**: MCP protocol doesn't support this standardly. The rename + description + detection approach is simpler and sufficient.
- **Not adding a third MCP variant**: Two is already causing confusion. Three would be worse.

## Migration

1. Deploy renamed remote MCP worker (`jack-cloud`)
2. Users who manually added the remote MCP via `claude mcp add jack ...` will need to re-add as `jack-cloud`
3. `jack mcp install` for local users remains unchanged (still registers as `"jack"`)
4. Publish updated CLAUDE.md with narrowed guidance

## Codex review notes

- **Layer 2 is the load-bearing fix.** Tool descriptions are what LLMs key on for selection. If shipping incrementally, do Layer 2 first.
- **"stage_file" is a meaningful semantic improvement** over "update_file" — introduces "staging" as distinct from "editing". But the negative guidance in descriptions is the real fix.
- **No simpler single-layer fix is as robust** — each layer covers a different failure path.
- **Staging pattern is fine** for large files. Reference-based editing (diffs/patches) is a future optimization.
- **Migration risk is low** — renaming helps because `jack mcp install` overwrites any stale remote `"jack"` entry with the local one.
- **Also update `apps/mcp-worker/CLAUDE.md`** to reflect new tool names and mutual exclusivity decision.

## Implementation order

1. **Layer 2 first** (tool renames + description hardening) — immediate impact, minimal risk
2. **Layer 1** (server rename) — ship alongside Layer 2 in same deploy
3. **Layer 3** (dual-connection detection + CLAUDE.md narrowing) — separate PR, can be done async

## Success criteria

- An agent in Claude Code with only local MCP connected never attempts to use `stage_file` or `read_deployed_file`
- An agent in claude.ai web with only remote MCP uses `stage_file` + `deploy(staged=true)` for large files correctly
- `jack mcp install` warns if both are configured and offers to remove the remote entry
- The real-world failure case (partial file staging → broken deploy) cannot recur in Claude Code
