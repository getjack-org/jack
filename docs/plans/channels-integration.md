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

## Demo: The Production Error Loop (API + Database)

A reproducible demo script that can be screen-recorded. Shows real value, not vibe-imagined.

### Scenario

User creates an API with a database. Adds a feature (filtering by priority). Deploys it. A user hits the new endpoint — it 500s because the DB column doesn't exist. Claude sees the error in real-time, investigates, and suggests the fix.

This is the #1 error pattern across all Jack templates: **code references a column/table that doesn't exist in D1**. It happens constantly when vibecoders add features without thinking about migrations.

### Prerequisites

- Claude Code with `jack mcp serve` configured
- Jack CLI authenticated (managed mode)
- Channel enabled: `claude --dangerously-load-development-channels server:jack --channels server:jack`

### Script

```bash
# ── Step 1: Create and deploy a working API ──────────────────────────
# (In Claude Code session)
# > "Create a task API with a database. Include CRUD endpoints for tasks
#    with title, status, and created_at fields."

# Claude uses create_project + deploy_project + execute_sql to:
# - Create project from API template
# - Add D1 database with tasks table (id, title, status, created_at)
# - Deploy and verify with test_endpoint

# Verify it works:
curl https://user-task-api.runjack.xyz/api/tasks
# → {"tasks": []}

curl -X POST https://user-task-api.runjack.xyz/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Ship channels feature"}'
# → {"task": {"id": 1, "title": "Ship channels feature", "status": "todo", ...}}


# ── Step 2: Add a feature that breaks production ─────────────────────
# > "Add a priority field to tasks. Support filtering by priority:
#    GET /api/tasks?priority=high"

# Claude adds the priority field to the code and redeploys.
# BUT: the D1 table still has the old schema — no "priority" column.
# Claude may or may not remember to run the migration.
# (This is the realistic vibecoding failure mode.)


# ── Step 3: A user hits the broken endpoint ──────────────────────────
# (From another terminal, simulating a real user)
curl "https://user-task-api.runjack.xyz/api/tasks?priority=high"
# → 500 Internal Server Error


# ── Step 4: Claude sees the error via channel ────────────────────────
# In Claude Code's terminal, the channel event arrives:
#
# <channel source="jack" event="error" project="task-api">
# D1_ERROR: no such column: priority
# Request: GET /api/tasks?priority=high → 500
# </channel>
#
# Claude reacts:
# "I see a production error — the `priority` column doesn't exist in the
#  tasks table. The code filters on it but the migration was never run.
#
#  Fix: Run this SQL to add the column:
#    ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'medium';
#
#  Want me to run this migration?"

# User approves → Claude runs execute_sql → endpoint works
```

### Why this demo is real

1. **The error is the #1 failure mode** — schema drift is the most common bug in Jack apps with D1
2. **No fake setup** — uses the actual API template, actual D1, actual log streaming
3. **The fix is actionable** — Claude suggests a specific SQL migration, not vague advice
4. **End-to-end value** — from error to fix in one interaction, no context switching

### What makes it compelling on video

- The user isn't even at the terminal when the error happens — someone else (or curl) triggers it
- Claude catches it in real-time and immediately knows what's wrong
- The fix is a one-liner SQL migration Claude can execute right there
- After the fix, Claude can call `test_endpoint` to verify it works

---

## Real Error Patterns Across Templates

These are the actual failure modes from Jack template source code, ranked by frequency:

### Tier 1: Happens constantly (demo-worthy)

| Error | Templates | Log signature | Claude can fix? |
|-------|-----------|---------------|-----------------|
| Missing D1 column/table | api, cron, ai-chat, saas | `D1_ERROR: no such table/column` | Yes — `ALTER TABLE` or create table |
| Missing/invalid secret | saas, telegram-bot | `TypeError: Cannot read property of undefined` (on `env.STRIPE_KEY`) | Yes — identify which secret, tell user to set it |
| Unhandled JSON parse | api | `SyntaxError: Unexpected token` | Yes — add try/catch around `req.json()` |

### Tier 2: Happens often (future channel value)

| Error | Templates | Log signature | Claude can fix? |
|-------|-----------|---------------|-----------------|
| External fetch timeout | cron, telegram-bot | `fetch failed` or `AbortError` | Suggest — add timeout, retry logic |
| AI quota exceeded | ai-chat, semantic-search | `429 Too Many Requests` from Workers AI | Suggest — add rate limiting or quota check |
| Schema mismatch after update | saas (Better Auth) | `D1_ERROR: table X has no column named Y` | Yes — generate migration SQL |

### Tier 3: Edge cases (nice to catch)

| Error | Templates | Log signature |
|-------|-----------|---------------|
| Cron URL unreachable | cron | `fetch to https://... failed` in scheduled handler |
| WebSocket upgrade failure | chat | `Expected 101 Switching Protocols` |
| Stripe webhook signature invalid | saas | `Webhook signature verification failed` |

### What the log stream actually contains

From `LogStreamDO.normalizeTailEvent()`:

```typescript
{
  type: "event",
  ts: 1711234567890,
  outcome: "exception",  // or "ok", "exceededCpu", "exceededMemory", etc.
  request: { method: "GET", url: "https://user-task-api.runjack.xyz/api/tasks?priority=high" },
  logs: [
    { ts: 1711234567891, level: "error", message: ["D1_ERROR: no such column: priority"] }
  ],
  exceptions: [
    { ts: 1711234567892, name: "Error", message: "D1_ERROR: no such column: priority" }
  ]
}
```

**Channel filter criteria:**
- `exceptions.length > 0` — always push (uncaught errors)
- `logs` with `level === "error"` — always push
- `outcome === "exception"` or `outcome === "exceededCpu"` — always push
- `outcome === "ok"` and no error logs — drop (normal traffic)

---

## Testing Strategy

### Unit: Channel notification delivery

Use `InMemoryTransport` from MCP SDK — no subprocess, no network:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

test("channel emits error notification", async () => {
  const server = new Server(
    { name: "jack", version: "0.1.0" },
    { capabilities: { experimental: { "claude/channel": {} } } }
  );

  const client = new Client({ name: "test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const received: any[] = [];
  client.setNotificationHandler(
    { method: "notifications/claude/channel" },
    (notification) => { received.push(notification); }
  );

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  // Simulate an error event
  await server.notification({
    method: "notifications/claude/channel",
    params: {
      content: "D1_ERROR: no such column: priority",
      meta: { event: "error", project: "task-api" },
    },
  });

  expect(received).toHaveLength(1);
  expect(received[0].params.meta.event).toBe("error");
});
```

### Unit: Log event filtering

Test that the filter correctly separates errors from normal traffic:

```typescript
test("filters error events from log stream", () => {
  const errorEvent = {
    type: "event", ts: Date.now(), outcome: "exception",
    request: { method: "GET", url: "/api/tasks" },
    logs: [{ ts: Date.now(), level: "error", message: ["D1_ERROR: no such column"] }],
    exceptions: [{ ts: Date.now(), name: "Error", message: "D1_ERROR: no such column" }],
  };

  const okEvent = {
    type: "event", ts: Date.now(), outcome: "ok",
    request: { method: "GET", url: "/health" },
    logs: [], exceptions: [],
  };

  expect(shouldEmitChannelNotification(errorEvent)).toBe(true);
  expect(shouldEmitChannelNotification(okEvent)).toBe(false);
});
```

### Integration: Full channel with live project

```bash
# 1. Deploy a test project
jack new channel-test --template api
jack ship

# 2. Start Claude Code with channel
claude --dangerously-load-development-channels server:jack --channels server:jack

# 3. Trigger an error (from another terminal)
curl -X POST https://user-channel-test.runjack.xyz/api/echo \
  -H "Content-Type: text/plain" -d "not json"
# → 500 (SyntaxError: Unexpected token)

# 4. Verify channel event appears in Claude Code session
# Look for: <channel source="jack" event="error" ...>
```

### E2E: The demo script above

Run the full demo script. Record the terminal. This IS the test — if the error flows through and Claude reacts correctly, the feature works.

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
