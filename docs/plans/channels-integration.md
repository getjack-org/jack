# Jack + Claude Code Channels Integration

## Summary

Two independent improvements to Jack's Claude Code experience:

1. **Fix `deploy_project` to return final status** — Make the MCP tool poll until the deployment resolves instead of returning "building". No channels needed. ~15 LOC.
2. **Production error streaming via channel** — Push real-time production errors into Claude's session so it can auto-investigate. This is the genuine channels use case. ~150 LOC.

## Context

### What are Claude Code channels?

An MCP server that declares `claude/channel` capability and emits `notifications/claude/channel` events. Claude receives these as `<channel source="jack" ...>` tags. Strictly local (stdio subprocess), session-scoped (events flow only while Claude Code is running).

### Why NOT use channels for deploy notifications

We initially planned channels for deploy status notifications. After analysis:

- **`deploy_project` MCP tool**: Claude awaits the result. If the tool polls until resolved, Claude gets the final status inline. No channel needed.
- **`jack ship` via Bash**: Claude sees CLI output directly. Already knows the outcome.
- **Channels add complexity for no gain here**: Background polling, MCP server lifecycle concerns, `--channels` flag — all to deliver a notification that the tool should just return synchronously.

Deploy notifications via channels solve a problem that doesn't exist. The tool should just wait for the result.

### Where channels ARE the right primitive

Events that happen **outside of any tool call**: production errors hitting your live app, cron failures, unexpected 500s. Things Claude can't know about unless something pushes them in. No other platform does this.

### Constraints

- **Channels are local-only**: stdio subprocess. Won't work with claude.ai web, `claude --remote`, or GitHub Actions.
- **Control plane has no push for deploys**: Status requires polling `GET /v1/projects/{id}/deployments/latest`.
- **Control plane HAS push for logs**: SSE stream at `GET /v1/projects/{id}/logs/stream` (1-hour sessions).
- **Research preview**: Custom channels require `--dangerously-load-development-channels` until allowlisted.
- **One MCP server per Claude Code session**, operating on the working directory's project.

---

## Priority 1: Synchronous Deploy Status (~15 LOC)

### Problem

`deploy_project` MCP tool calls `deployProject()` which uploads code and returns immediately with `status: "building"` or `"queued"`. Claude doesn't know the final outcome.

### Fix

Add a polling loop in the MCP tool handler (not in the shared library — CLI has its own UX for this). Poll `GET /v1/projects/{id}/deployments/latest` every 3s until status resolves to `live` or `failed`, with a 5-minute timeout.

### What changes

```
apps/cli/src/mcp/tools/index.ts  # Add polling after deployProject() call
```

### Implementation sketch

```typescript
case "deploy_project": {
  const result = await deployProject(projectPath, options);

  // For managed deploys, poll until final status
  if (result.deploymentId && result.deployMode === "managed"
      && result.deployStatus !== "live" && result.deployStatus !== "failed") {
    const final = await pollDeploymentStatus(projectId, result.deploymentId, 100, 3000);
    if (final) {
      result.deployStatus = final.status;
      result.errorMessage = final.error_message;
      result.workerUrl = final.url ?? result.workerUrl;
    }
  }

  return formatSuccessResponse(result, startTime);
}
```

### Post-deploy auto-verify

Update the MCP server `instructions` (or AGENTS.md) to tell Claude:

> After a successful deployment, call `test_endpoint` on the project URL to verify it's responding correctly. If the endpoint returns an error, use `tail_logs` to investigate.

This creates the **code → ship → verify → fix loop** that makes Jack unique. No other platform auto-verifies deploys through the AI session.

---

## Priority 2: Production Error Streaming via Channel (~150 LOC)

### Problem

When a production error happens (500, uncaught exception), nobody knows until a user reports it or the developer checks logs manually. Claude is sitting right there with all the tools to investigate, but has no way to learn about it.

### Solution

Extend `jack mcp serve` with `claude/channel` capability. On startup (when channel is enabled), subscribe to the project's log SSE stream. Filter for errors/exceptions. Push them into Claude's session as channel events.

### How it works

1. Add `experimental: { 'claude/channel': {} }` to MCP server capabilities
2. Add `instructions` telling Claude how to handle error events
3. On server startup, detect the linked project and start a log session
4. Connect to the SSE stream, filter for `level: "error"` or exceptions
5. Emit `notifications/claude/channel` for each error
6. User enables with: `claude --channels server:jack`

### Event flow

```
User hits deployed app → 500 error
        ↓
Tenant Worker logs error
        ↓
log-worker (tail consumer) → LogStreamDO
        ↓
SSE stream → jack MCP server (channel subscriber)
        ↓
notifications/claude/channel → Claude Code session
        ↓
Claude reads error, checks code, uses tail_logs/test_endpoint to investigate
```

### Notification format

```xml
<channel source="jack" event="error" project="my-api" level="error">
TypeError: Cannot read property 'id' of undefined
  at handler (src/index.ts:42:15)
Request: GET /api/users/123 → 500
</channel>

<channel source="jack" event="exception" project="my-api">
Uncaught ReferenceError: config is not defined
  at scheduled (src/cron.ts:8:3)
</channel>
```

### Channel instructions

```
Events from the jack channel are production alerts from your deployed project.
They arrive as <channel source="jack" event="..." ...> tags.

- event="error": A request to your deployed app returned an error. Read the
  stack trace, find the relevant source code, and suggest a fix. Use tail_logs
  to see if it's recurring. Use test_endpoint to reproduce if possible.
- event="exception": An uncaught exception in your deployed code. This is
  urgent — check the source, understand the cause, and suggest a fix.

Do NOT redeploy automatically. Present the fix and let the user decide.
```

### What changes

```
apps/cli/src/mcp/
├── server.ts              # Add channel capability + instructions, start log subscriber
├── channel/               # NEW
│   └── log-subscriber.ts  # SSE log stream → filtered channel notifications
└── tools/index.ts         # Unchanged
```

### Scope boundaries

**In scope:**
- Channel capability declaration in MCP server
- Log SSE subscription for the linked project (managed mode only)
- Error/exception filtering and notification
- Graceful handling of SSE disconnects (reconnect with backoff)

**Out of scope:**
- BYO mode (would need `wrangler tail` — different format and auth)
- Multi-project watching
- Event filtering configuration
- Two-way channel (reply tools)
- Auto-fix and redeploy (too risky — present fix, let user decide)

---

## Why This Makes Jack Unique

### The self-verifying deploy loop (Priority 1)

```
Claude writes code
  → deploy_project (waits for "live")
  → test_endpoint (auto-verify)
  → if error: tail_logs → read source → fix → redeploy
  → repeat until healthy
```

No other platform does this. Vercel gives you a preview URL. GitHub gives you a check. Jack gives you an AI that ships, tests, and iterates until it works.

### The production-aware coding session (Priority 2)

```
User's app running in production
  → 500 error hits
  → Claude sees it in real-time via channel
  → Claude reads stack trace, finds bug in source
  → Claude suggests fix (user deploys when ready)
```

No other platform streams production errors directly into your AI coding session. This turns Claude from a code-writing tool into a production partner.

---

## Discarded Options

### Standalone `jack channel serve`

Separate process with optional webhook HTTP endpoint. Discarded because:
- Adds process management complexity
- Webhook ingestion needs tunneling for remote CI
- Duplicates auth/config loading

Extraction path exists if webhooks become needed.

### Deploy notifications via channel

Initially planned, then discarded. The `deploy_project` tool should return final status synchronously. Channels are for async events Claude can't predict, not for results of tool calls Claude already made.

### Background deployment polling

Polling control plane every 15s to catch deploys from any source (CLI, MCP, other terminals). Discarded as overcomplicated and fickle for the value delivered.
