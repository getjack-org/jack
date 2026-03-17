# Analysis: Jack Deploy Limits Feedback

## Context

- **Client**: claude.ai (web interface)
- **MCP Server**: Remote MCP at `mcp.getjack.org` (`apps/mcp-worker/`)
- **NOT** the local CLI MCP (`apps/cli/src/mcp/`)

This is critical — the remote MCP worker has a completely different tool surface from the local CLI MCP. The `deploy` tool in the remote MCP **does** accept inline `changes` and `files` parameters.

## Architecture of the Remote MCP Deploy

The `deploy` tool (`apps/mcp-worker/src/tools/deploy-code.ts`) has three modes:

1. **`files`**: `Record<string, string>` — Full file set for new projects
2. **`template`**: `string` — Prebuilt template name
3. **`changes`**: `Record<string, string | null>` — Partial update to existing project (requires `project_id`)

### What happens in `changes` mode (lines 107-140):
1. Fetches existing source files from control plane via `getAllSourceFiles(project_id)`
2. Merges changes into existing files (null = delete)
3. Bundles merged files with esbuild-wasm
4. Zips and uploads via `client.uploadDeployment()`

### Existing size limits in the pipeline:
- **Source files**: 500KB total (`deploy-code.ts:154`) — `"Source files too large"`
- **Bundled output**: 10MB (`deploy-code.ts:175`) — Workers platform limit

---

## Root Cause: The Real Bottleneck

The user's 38KB `src/index.ts` is well within Jack's 500KB source limit. The problem is **upstream of Jack entirely**:

### Claude's output token limit truncates the MCP tool call

From the user's answer:
> "My (Claude's) response generation hit the output token limit mid-tool-call. The jack:deploy changes parameter was being written as I generated, and my response was cut off partway through the JSON value for src/index.ts."

The flow:
1. Claude generates a tool call with `changes: { "src/index.ts": "<38KB string>" }`
2. Claude's **output token limit** (~16K tokens per turn) is exhausted mid-JSON
3. The tool call is never fully formed — it's truncated in Claude's output
4. MCP server receives nothing (incomplete JSON-RPC is never transmitted)
5. No error from Jack because no valid request arrived

**This is a Claude platform constraint, not a Jack constraint.** Jack's deploy pipeline would handle 38KB without issue.

### Why this matters for Jack anyway

Even though it's not Jack's bug, it's Jack's user's problem. The remote MCP's value proposition is "build and iterate on apps from Claude." If Claude can't send >16K tokens of code in a single tool call, the `changes` mode breaks for any non-trivial app.

---

## Feedback Items: Root Cause Analysis

### 1. Deploy payload truncation — Claude output token limit
- **Root cause**: Claude's per-turn output limit (~16K tokens) can't fit a 38KB file inside a tool call parameter
- **Jack's pipeline limit**: 500KB source, 10MB bundle — plenty of headroom
- **Possible Jack-side mitigations**: See plan below

### 2. "tool_search required before first use" — NOT from Jack
- Not a Jack tool. Likely claude.ai's MCP tool discovery/approval UI
- No action needed

### 3. "No approval received" on create_database — Likely claude.ai approval flow
- The exact error `{"error": "No approval received."}` is NOT from Jack's MCP
- Jack's error format is `{ success: false, error: { code, message, suggestion } }` (`apps/mcp-worker/src/utils.ts`)
- This is claude.ai's human-in-the-loop approval prompt timing out or being dismissed
- The DB already existed (auto-created with project) — user's workaround of using `list_databases` was correct
- **Possible Jack improvement**: `create_database` could check for existing DBs and return a clear "already exists" message instead of creating a duplicate

### 4. "No way to verify deploy" — Partially valid
- `get_project_status` returns deployment status + URL
- But the agent can't `fetch()` the URL from within Claude to verify it works
- **Jack already has**: `ask_project` tool that does evidence-backed debugging including endpoint checks
- **Gap**: No simple "ping this URL and tell me the HTTP status" tool in the remote MCP
- The local CLI MCP has `test_endpoint` but the remote MCP doesn't

### 5. "Destructive SQL blocked" — By design, but painful in remote-only context
- `execute_sql` blocks DROP, TRUNCATE, ALTER TABLE
- In local CLI, users can fall back to `jack db execute --destructive`
- In remote MCP (claude.ai), there's no escape hatch — users are stuck
- User had to create `quizzes_new` instead of `ALTER TABLE quizzes ADD COLUMN`

### 6. Template literal escaping — Real friction
- Embedding JS in a TS template literal breaks on `${` and backticks
- User had to use `string[].join('\n')` workaround
- This is inherent to inline code as JSON strings — not fixable by Jack directly

---

## Proposed Plan (Ordered by Impact)

### P0: Add chunked/streaming file upload to `deploy` tool

The core problem is that Claude can't emit 38KB in a single tool call parameter. Jack can mitigate this:

**Option A: Add `write_file` + `deploy_from_disk` pattern**
- New tool `write_file(project_id, path, content, append?)` that stages file changes server-side
- New tool or mode `deploy(project_id, commit: true)` that deploys staged changes
- Agent writes files across multiple calls (each under token limit), then triggers deploy
- **Pros**: Works within Claude's token limits, clean separation
- **Cons**: More tool calls per deploy, needs server-side staging state

**Option B: Add `append_file` support to existing `changes` mode**
- New parameter: `changes_append: Record<string, string>` — content appended to previous `write_file` calls in the same session
- Agent sends file in chunks across multiple `deploy` calls, final call triggers actual deploy
- **Cons**: Overloads the `deploy` tool semantics

**Option C: Base64 + compression**
- Accept gzipped base64 content in `changes` to reduce token count ~50%
- **Pros**: Simple change
- **Cons**: Still hits the limit for files >32KB; Claude has to emit base64 which is also tokens

**Recommendation: Option A** — it's the cleanest and scales to any file size.

Implementation in `apps/mcp-worker/`:
- New tool `update_file` in `src/tools/source.ts` (alongside existing `read_project_file`)
- Stores pending changes in control plane (new endpoint) or in a Durable Object session
- `deploy(project_id, staged: true)` triggers deploy from staged changes
- Each `update_file` call is small (<16K tokens), agent can make as many as needed

### P1: Add `test_endpoint` tool to remote MCP

Port `test_endpoint` from local CLI MCP to remote MCP. Simple HTTP fetch + status check.

```
Tool: test_endpoint
Parameters:
  - project_id: string
  - path: string (e.g. "/api/health")
  - method: string (optional, default GET)
```

Returns HTTP status, headers, and truncated body. Lets agents verify deploys without user intervention.

**Location**: New file `apps/mcp-worker/src/tools/endpoint-test.ts`, register in `server.ts`

### P2: Allow ALTER TABLE in `execute_sql`

Split destructive operations into tiers:
- **Migration ops** (ALTER TABLE): Allow with `allow_write: true`
- **Destructive ops** (DROP, TRUNCATE): Keep blocked, or add new `allow_destructive: true` flag

**Location**: `apps/mcp-worker/src/tools/database.ts` — the SQL validation logic

Also check: `apps/cli/src/lib/services/db-execute.ts` for the shared validation (remote MCP may proxy to control plane which has its own check)

### P3: Idempotent `create_database`

Before creating, check if a DB with that binding already exists. Return the existing DB info instead of erroring or creating a duplicate.

**Location**: `apps/mcp-worker/src/tools/database.ts` `createDatabase()` handler

### P4: Improve deploy tool description for large files

Add guidance in the tool description that agents should split large HTML/CSS/JS into separate files when content exceeds ~10KB. This aligns with better Workers architecture and avoids the token limit.

**Location**: `apps/mcp-worker/src/server.ts` line 23-28 (deploy tool description)

---

## What the user's suggestions would actually require

| Suggestion | Assessment |
|------------|-----------|
| "Multi-file deploy via URL or upload" | Jack already deploys multi-file zips. The gap is getting content INTO the tool call, not out of it. `write_file` staging (P0 Option A) addresses this. |
| "Static asset support" | Already exists in local CLI (assets binding + assets.zip). NOT yet exposed in remote MCP deploy. Would need manifest bindings + asset file support in `deploy-code.ts`. Worth adding but secondary to the token limit fix. |
| "Chunked deploy" | Exactly right — P0 Option A implements this via `write_file` staging. |
| "Base64/compressed payload" | Marginal improvement (~50% reduction). Doesn't solve the fundamental token limit for large files. |

---

## File Changes Summary

| File | Change | Priority |
|------|--------|----------|
| `apps/mcp-worker/src/server.ts` | Add `update_file` + `test_endpoint` tool registrations | P0, P1 |
| `apps/mcp-worker/src/tools/source.ts` | Add `updateFile()` handler (stage changes server-side) | P0 |
| `apps/mcp-worker/src/tools/deploy-code.ts` | Add `staged: true` mode to deploy from staged changes | P0 |
| `apps/mcp-worker/src/control-plane.ts` | Add methods for staging files + fetching staged state | P0 |
| `apps/mcp-worker/src/tools/endpoint-test.ts` | New — HTTP fetch tool for deploy verification | P1 |
| `apps/mcp-worker/src/tools/database.ts` | Allow ALTER TABLE, make create_database idempotent | P2, P3 |
| `apps/mcp-worker/src/server.ts` | Update deploy description with large-file guidance | P4 |
| `apps/control-plane/src/index.ts` | New endpoint for file staging (if using control plane storage) | P0 |

## Key Takeaway

The user's diagnosis was **correct**: the `deploy` tool's `changes` parameter passes file content inline, and large files get truncated. The truncation happens at Claude's output token limit (not Jack's 500KB source limit), but the fix belongs in Jack: add a multi-call file staging mechanism (`update_file` + deploy from staged) so agents can send content in chunks that fit within their output token budget.
