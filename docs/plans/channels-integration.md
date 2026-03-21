# Jack + Claude Code Channels: One-Way Integration Plan

## Goal

Push deployment events, production errors, and log alerts into a running Claude Code session so Claude can react using Jack's existing MCP tools — without the user needing to be at the terminal.

## Background

Claude Code channels are MCP servers that declare `claude/channel` capability and emit `notifications/claude/channel` events. Claude receives these as `<channel source="jack" ...>` tags in its context. The channel runs as a subprocess spawned by Claude Code, communicating over stdio.

Jack already has a local MCP server (`jack mcp serve`) with 27 tools and 3 resources. The question is whether to extend it or build a separate channel server.

---

## Option A: Extend `jack mcp serve`

Add `claude/channel` capability to the existing MCP server. The same process that handles tool calls also subscribes to events and pushes notifications.

### How it works

1. Add `experimental: { 'claude/channel': {} }` to the server's capabilities in `apps/cli/src/mcp/server.ts`
2. Add an `instructions` string telling Claude what events to expect
3. After server connects, start background event loops:
   - **Deploy watcher**: Poll control plane for deployment status changes on linked project
   - **Log stream**: Connect to the project's SSE log stream, filter for errors/exceptions, push as channel events
4. User starts Claude Code with: `claude --channels server:jack`

### Event sources

| Event | Source | Mechanism |
|-------|--------|-----------|
| Deploy completed/failed | Control plane `/v1/projects/{id}/overview` | Poll every 5s after deploy starts |
| Production error | Log worker SSE stream | Subscribe on startup, filter `level: "error"` or exceptions |
| Cron execution result | Control plane | Poll or future webhook |

### What changes

```
apps/cli/src/mcp/
├── server.ts          # Add channel capability + instructions
├── channel/           # NEW directory
│   ├── events.ts      # Event emitter, notification dispatch
│   ├── deploy-watcher.ts   # Polls control plane for deploy status
│   └── log-watcher.ts      # SSE subscription for error alerts
└── tools/index.ts     # Unchanged
```

### Notification examples

```xml
<!-- Deploy completed -->
<channel source="jack" event="deploy_complete" project="my-api" deployment_id="abc123">
Deployment live at https://user-my-api.runjack.xyz
</channel>

<!-- Production error -->
<channel source="jack" event="error" project="my-api" level="error">
TypeError: Cannot read property 'id' of undefined
  at handler (src/index.ts:42:15)
Request: GET /api/users/123 → 500
</channel>

<!-- Deploy failed -->
<channel source="jack" event="deploy_failed" project="my-api" deployment_id="abc123">
Build failed: Module not found: ./missing-import
</channel>
```

### Tradeoffs

| | |
|---|---|
| **Pro** | Zero new infrastructure — reuses auth, project link, deploy mode detection |
| **Pro** | Single process — no extra server to manage |
| **Pro** | MCP tools available in same session — Claude can immediately `execute_sql`, `tail_logs`, `test_endpoint` to investigate |
| **Pro** | Already installed for Jack users via `jack mcp install` |
| **Con** | Channel lifecycle tied to MCP server — can't run channel without all 27 tools |
| **Con** | Polling from inside the MCP server adds background work to a stdio process |
| **Con** | `--channels server:jack` syntax requires the server name in `.mcp.json` to be "jack" (it already is) |
| **Con** | Harder to test channel behavior in isolation |

### Key decision: What triggers the deploy watcher?

The control plane has no push mechanism for deploy events. Options:

- **A1: Always poll** — On startup, start polling the linked project's overview endpoint every 10s. Simple but wasteful.
- **A2: Tool-triggered** — When Claude calls `deploy_project`, start polling for that deployment ID until it resolves. No wasted polls, but misses deploys from other terminals.
- **A3: Hybrid** — Poll on startup at low frequency (30s), increase to 5s after a deploy tool call. Best coverage, more complex.

**Recommendation: A2 (tool-triggered).** Most natural — Claude deploys, then gets notified of the result. Deploys from other terminals are edge cases that can be added later.

---

## Option B: Standalone `jack channel serve`

New CLI command that starts a dedicated channel server. It's a separate MCP server process that only does channel events — no tools.

### How it works

1. New command: `jack channel serve` starts an MCP server with only `claude/channel` capability
2. Optionally starts a local HTTP server for webhook ingestion (`--webhook-port 8788`)
3. Connects to control plane SSE for log streaming
4. User registers it in `.mcp.json` separately and starts with: `claude --channels server:jack-channel`

### Event sources

Same as Option A, plus:

| Event | Source | Mechanism |
|-------|--------|-----------|
| CI webhook | Local HTTP POST to `localhost:8788` | GitHub Actions `workflow_run` webhook via smee.io or similar |
| Custom hooks | Local HTTP POST | `jack ship --notify` POSTs to channel after deploy |

### What changes

```
apps/cli/src/
├── commands/
│   └── channel.ts          # NEW: `jack channel serve` command
├── channel/                # NEW directory
│   ├── server.ts           # Channel-only MCP server
│   ├── webhook-server.ts   # Local HTTP listener for webhooks
│   ├── deploy-watcher.ts   # Polls control plane
│   └── log-watcher.ts      # SSE subscription
└── mcp/
    └── server.ts           # Unchanged
```

### Tradeoffs

| | |
|---|---|
| **Pro** | Clean separation — channel concerns don't touch MCP tool server |
| **Pro** | Can run independently of `jack mcp serve` |
| **Pro** | Webhook endpoint enables CI/CD integration (GitHub Actions → channel → Claude) |
| **Pro** | Easier to test in isolation |
| **Pro** | Can evolve independently (add two-way later without touching tool server) |
| **Con** | Two processes to manage — user runs both `jack mcp serve` and `jack channel serve` |
| **Con** | Duplicates some setup: auth loading, project detection, deploy mode checks |
| **Con** | User must configure `.mcp.json` with a second entry and pass both to `--channels` |
| **Con** | Webhook port requires the external system to know `localhost:8788` — doesn't work for remote CI without tunneling |

### Key decision: Webhook server or polling only?

- **B1: Polling only** — Same as Option A, just in a separate process. Simpler but loses the webhook advantage that justifies the separation.
- **B2: Webhook + polling** — HTTP server for external events, polling for deploy status. More useful but more surface area.

**Recommendation: B2 (webhook + polling).** The webhook endpoint is the main reason to choose Option B over A. Without it, the separation adds complexity for no gain.

---

## Comparison Matrix

| Dimension | Option A (extend MCP) | Option B (standalone) |
|-----------|----------------------|----------------------|
| **Setup effort for user** | None — already have `jack mcp serve` | Must add second server to `.mcp.json` |
| **Implementation effort** | ~200 LOC added to existing server | ~400 LOC new command + server |
| **Event sources** | Deploy status, log errors | Deploy status, log errors, webhooks |
| **CI/CD integration** | Not possible | Yes, via local webhook endpoint |
| **Process management** | Single process | Two processes |
| **Auth/config reuse** | Full — same process | Partial — must reload from disk |
| **Testability** | Harder — mixed with tool server | Easier — isolated |
| **Future two-way support** | Adds reply tools to already-large server | Clean addition to focused server |
| **Deploy mode support** | Both (managed + BYO) | Both (managed + BYO) |

---

## Recommendation

**Start with Option A**, then extract to B if webhooks become important.

Rationale:
1. **Zero friction** — Jack users already have `jack mcp serve` configured. Adding channel capability is a server-side change they get for free.
2. **Tool-triggered deploy watching** (A2) is the highest-value event and needs no new infrastructure.
3. **Log error streaming** reuses existing SSE infrastructure from `log-worker`.
4. The webhook use case (Option B's main advantage) requires tunneling for remote CI, which adds setup complexity that undermines Jack's "zero friction" philosophy.
5. If webhook demand emerges, the channel event code (`deploy-watcher.ts`, `log-watcher.ts`) extracts cleanly into a standalone server.

### Implementation order

1. **Phase 1: Deploy notifications** — Add channel capability, emit deploy_complete/deploy_failed events after `deploy_project` tool calls. ~100 LOC.
2. **Phase 2: Log error alerts** — Subscribe to project's log SSE stream, filter errors/exceptions, push as channel events. ~100 LOC.
3. **Phase 3 (if needed): Extract to standalone** — Move channel code to `jack channel serve` command, add webhook HTTP server.

---

## Open Questions

1. **Managed-only or both modes?** Log streaming only works for managed (Jack Cloud) projects today. BYO projects would need wrangler tail, which has different output format. Should Phase 1-2 be managed-only?

2. **Event filtering** — Should the user be able to configure which events they receive? e.g., only errors above a severity, only for specific projects? Or start simple (all events for linked project)?

3. **Multi-project** — The MCP server currently operates on the working directory's project. Should the channel watch multiple projects, or just the current one?

4. **Channel instructions** — The `instructions` string goes into Claude's system prompt. What should Claude do when it receives events? Suggestions:
   - Deploy success: summarize and note the URL
   - Deploy failure: investigate build logs
   - Production error: check recent deploys, read relevant code, suggest fix
