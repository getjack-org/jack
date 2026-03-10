# Analysis: Jack Deploy Limits Feedback

## Context

This feedback came from a **Claude app session** (claude.ai / Claude Desktop), NOT from a local terminal with Claude Code. This is the critical context — in a Claude app session, the AI agent has **zero filesystem access**. It can only interact with the project through Jack's MCP tools.

## Diagnosis: Where the Real Bottleneck Is

The feedback identifies a "deploy payload size limit" but **misdiagnoses the layer**. Here's what's actually happening:

### What the user thinks
> "The jack:deploy changes parameter passes file content inline as a JSON string in the MCP tool call"

### What actually exists
- **`deploy_project` has NO `changes` parameter** — it only accepts `project_path` and `message` (`apps/cli/src/mcp/tools/index.ts:56-67`)
- Deploy reads files from disk, builds with wrangler, packages into zip files, and uploads via multipart FormData (`apps/cli/src/lib/managed-deploy.ts:97-267`)
- **Multi-file upload already works** — bundle.zip, source.zip, assets.zip, schema.sql, secrets.json (`apps/cli/src/lib/deploy-upload.ts`)
- **Static assets are already supported** — via wrangler `assets` binding + `assets.zip` upload

### The actual bottleneck: No file-write capability in MCP

In a Claude app session, the agent flow is:

1. `create_project` → creates project from template on disk (works fine)
2. Agent wants to modify `src/index.ts` (add 38KB of custom code)
3. **Dead end** — Jack MCP has no `write_file` or `update_file` tool
4. Agent is forced to somehow pass file content through the MCP tool call itself
5. The **MCP transport/context window** truncates the content at ~32KB
6. Deploy never receives the full file

This is NOT a deploy pipeline limit. Jack's deploy upload handles arbitrary file sizes via HTTP multipart. The gap is that **Jack MCP provides no way for a filesystem-less agent to modify project files**.

### Why this matters more than it seems

The entire value proposition of Jack MCP in Claude app sessions is that an agent can build and deploy apps. But the current tool surface only supports:
- **Create** from template (`create_project`)
- **Deploy** what's on disk (`deploy_project`)
- **Query** databases, status, etc.

It's missing the critical middle step: **modify code**. Without it, agents can only deploy unmodified templates.

---

## Feedback Items: Root Cause Analysis

### 1. "Deploy payload size limit" — Symptom of missing file-write MCP tool
- **Root cause**: No MCP tool to write/modify project files
- **What the agent did**: Tried to pass 38KB of file content through MCP tool call parameters (likely by including it in some creative workaround), which hit MCP transport limits
- **Jack's deploy pipeline has no meaningful size limit** — it uploads zips via HTTP multipart
- **Fix**: Add `write_file` / `read_file` MCP tools so agents can modify files on disk, then call `deploy_project`

### 2. "tool_search required before first use" — NOT from Jack
- Jack MCP has no `tool_search` tool. This is Claude Desktop's MCP tool discovery/approval flow
- No action needed in Jack

### 3. "No approval received" errors on create_database — NOT a Jack issue
- This is Claude Desktop's human-in-the-loop approval flow for MCP tool calls
- The error is opaque because it comes from the host, not from Jack
- No action needed in Jack (but could improve error messages to distinguish Jack errors from host errors)

### 4. "No way to verify deploy worked from API" — Partially valid
- `get_project_status` exists and returns deployment IDs + status
- `test_endpoint` tool already does HTTP requests to the deployed URL and returns results
- **But**: The agent may not know these tools exist or that they solve this problem
- **Action**: Improve `deploy_project` response to include the URL and suggest `test_endpoint`

### 5. "Destructive SQL operations blocked" — By design, but too strict for agents
- `execute_sql` blocks DROP, TRUNCATE, ALTER TABLE intentionally (`apps/cli/src/lib/services/db-execute.ts`)
- In a Claude app session, the user can't fall back to CLI for schema migrations
- **Consider**: Adding an `allow_destructive: true` flag for ALTER TABLE specifically (keep DROP/TRUNCATE blocked)

### 6. Deploy limits (for reference, not from feedback)
- **Rate limit**: 1000 RPM default per project (`apps/dispatch-worker/src/index.ts:188`), configurable via control plane
- **CPU limits**: Free=10ms, Paid=50ms (`apps/dispatch-worker/src/index.ts:209`)
- **Subrequest limits**: Free=50, Paid=200 (`apps/dispatch-worker/src/index.ts:210`)

---

## Proposed Plan (Ordered by Impact)

### P0: Add `write_file` MCP tool — the critical missing piece

**Why**: This is the single change that unblocks the entire "build apps via Claude app session" use case. Without it, agents can only deploy unmodified templates.

**Location**: `apps/cli/src/mcp/tools/index.ts`

```
Tool: write_file
Parameters:
  - project_path: string (optional, defaults to cwd)
  - file_path: string (relative path within project, e.g. "src/index.ts")
  - content: string (file content)
  - create_dirs: boolean (optional, auto-create parent directories)
```

**Safety considerations**:
- Path traversal protection: reject `..` segments and absolute paths
- Only write within the resolved project directory
- Size limit on content (e.g., 1MB per call) to prevent abuse
- Reject writes to sensitive files (`.env`, `node_modules/`, `.git/`)

**MCP transport limit workaround**: Even with `write_file`, agents may hit the MCP message size limit for large files. To handle this:
- Document that agents should split large HTML/CSS/JS into separate files
- Consider adding an `append` mode (`mode: "write" | "append"`) so content can be sent across multiple calls
- This aligns with better Cloudflare Workers practice anyway (separate files vs monolithic inline HTML)

### P1: Add `read_file` MCP tool

**Why**: Agents need to read existing code to modify it intelligently. Without `read_file`, even with `write_file`, agents would be writing blind.

```
Tool: read_file
Parameters:
  - project_path: string (optional)
  - file_path: string (relative path within project)
  - offset: number (optional, line offset for large files)
  - limit: number (optional, max lines to return)
```

Also consider: `list_files` tool to let agents discover project structure.

### P2: Add `list_files` MCP tool

```
Tool: list_files
Parameters:
  - project_path: string (optional)
  - pattern: string (optional glob pattern, e.g. "src/**/*.ts")
```

Returns file paths + sizes. Enables agents to understand project structure before modifying.

### P3: Improve deploy_project response

Currently the MCP deploy response doesn't prominently surface the URL or suggest verification steps. Enhance:
- Include `worker_url` in the response
- Suggest `test_endpoint` for verification
- Include deployed file count and total size

### P4: Allow ALTER TABLE in execute_sql

Add an opt-in flag for ALTER TABLE operations. Keep DROP/TRUNCATE blocked by default.

**Location**: `apps/cli/src/lib/services/db-execute.ts` — split destructive operations into "migration" (ALTER) vs "destructive" (DROP/TRUNCATE), allow the former with `allow_write: true`.

---

## What the user's suggestions would actually require (and whether they help)

| Suggestion from feedback | Assessment |
|--------------------------|-----------|
| "Multi-file deploy via URL or upload" | **Already exists** — Jack deploys zips via FormData. The gap is file authoring, not deploying. |
| "Static asset support" | **Already exists** — `assets` binding in wrangler config + `assets.zip` upload. Agent just can't create the files. |
| "Chunked deploy" | **Wrong layer** — the limit is in MCP transport, not deploy upload. `write_file` with `append` mode solves this better. |
| "Base64/compressed payload" | **Wrong layer** — would need MCP protocol changes, not Jack changes. |
| "Let me write a file to disk and point Jack at it" | **This is exactly right** — the user correctly identified the fix even if they attributed the cause incorrectly. `write_file` MCP tool is this. |

---

## File Changes Summary

| File | Change | Priority |
|------|--------|----------|
| `apps/cli/src/mcp/tools/index.ts` | Add `write_file`, `read_file`, `list_files` tool schemas + handlers | P0-P2 |
| `apps/cli/src/mcp/tools/index.ts` | Enhance `deploy_project` response with URL + verification hint | P3 |
| `apps/cli/src/lib/services/db-execute.ts` | Split destructive check: allow ALTER TABLE with `allow_write` | P4 |

## Key Takeaway

The user's core insight is correct: **Jack needs a way for agents to write files to projects**. Their diagnosis ("deploy payload size limit") is wrong — there's no size limit in the deploy pipeline. The real gap is that Jack MCP has no file authoring tools, making it impossible for filesystem-less agents (Claude app sessions) to modify code between `create_project` and `deploy_project`.
