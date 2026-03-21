# Jack + Claude Code Channels: One-Way Deploy Notifications

## Decision

**Extend `jack mcp serve`** to push deploy status events into Claude Code sessions.

Scope: Local Claude Code users only. Session-scoped (events flow while Claude Code is running). Phase 1 is deploy notifications only.

## Context

### What are Claude Code channels?

An MCP server that declares `claude/channel` capability and emits `notifications/claude/channel` events. Claude receives these as `<channel source="jack" ...>` tags. The channel is a stdio subprocess — strictly local, no cloud/remote support.

### Constraints discovered

- **Channels are local-only**: stdio subprocess on user's machine. Won't work with claude.ai web, `claude --remote`, or GitHub Actions.
- **Control plane has no push mechanism**: Deploy status requires polling `GET /v1/projects/{id}/deployments/latest`. No webhooks, no pub/sub.
- **Local and remote MCP don't share code**: Local MCP (27 tools, stdio) and remote MCP at mcp.getjack.org (14 tools, HTTP) are independent. Channels can only attach to local.
- **Research preview**: Custom channels require `--dangerously-load-development-channels` until allowlisted by Anthropic.

### Why extend `jack mcp serve` (not standalone)

| Factor | Extend MCP server | Standalone `jack channel serve` |
|--------|-------------------|-------------------------------|
| User setup | None — already configured | New `.mcp.json` entry + `--channels` flag |
| Auth/config | Reuses in-process | Must reload from disk |
| Process count | Same single process | Second process to manage |
| Webhook ingestion | No | Yes (local HTTP server) |
| Testability | Harder (mixed with tools) | Easier (isolated) |

**Decision: Extend.** The standalone option's main advantage is webhook ingestion, which requires tunneling for remote CI — too much friction. If webhooks become needed later, the channel code extracts cleanly into a standalone server.

---

## Design: Deploy Status Channel

### How it works

1. Add `experimental: { 'claude/channel': {} }` to MCP server capabilities
2. Add `instructions` string to Claude's system prompt describing events
3. After `deploy_project` tool call completes, start polling control plane for final deployment status
4. Emit `notifications/claude/channel` when status resolves to `live` or `failed`
5. User enables with: `claude --channels server:jack`

### Trigger: Tool-triggered polling (not always-on)

The control plane has no push mechanism. Three polling strategies were considered:

| Strategy | Description | Pros | Cons |
|----------|-------------|------|------|
| Always poll | Poll overview endpoint every 10s on startup | Catches all deploys | Wasteful, noisy |
| **Tool-triggered** | Poll after `deploy_project` call until resolved | No wasted polls, natural UX | Misses deploys from other terminals |
| Hybrid | Low-freq poll + high-freq after deploy | Best coverage | Complex |

**Chosen: Tool-triggered.** Claude deploys → polls for result → gets notified. Deploys from other terminals are an edge case for later.

### Notification format

```xml
<channel source="jack" event="deploy_complete" project="my-api" deployment_id="abc123" deploy_mode="managed">
Deployment live at https://user-my-api.runjack.xyz
</channel>
```

```xml
<channel source="jack" event="deploy_failed" project="my-api" deployment_id="abc123" deploy_mode="managed">
Build failed: Module not found: ./missing-import
</channel>
```

### Channel instructions (added to Claude's system prompt)

```
Events from the jack channel are deployment status notifications. They arrive as
<channel source="jack" event="..." ...> tags.

- deploy_complete: The deployment is live. Note the URL and confirm to the user.
- deploy_failed: The deployment failed. Read the error message, check the relevant
  source code, and suggest a fix. Use tail_logs or test_endpoint to gather more context
  if needed.
```

### What changes

```
apps/cli/src/mcp/
├── server.ts              # Add channel capability, instructions, wire up deploy watcher
├── channel/               # NEW
│   └── deploy-watcher.ts  # Poll control plane after deploy, emit notifications
└── tools/index.ts         # After deploy_project succeeds, trigger watcher
```

### Implementation sketch

**`apps/cli/src/mcp/server.ts`** — Add channel capability:
```typescript
const server = new McpServer(
  { name: "jack", version },
  {
    capabilities: {
      tools: {},
      resources: {},
      experimental: { "claude/channel": {} },
    },
    instructions: CHANNEL_INSTRUCTIONS,
  }
);
```

**`apps/cli/src/mcp/channel/deploy-watcher.ts`** — Poll and notify:
```typescript
export async function watchDeployment(
  server: Server,
  projectId: string,
  deploymentId: string,
  projectName: string,
  deployMode: string
) {
  const maxAttempts = 60; // 5 min at 5s intervals
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(5000);
    const status = await fetchDeploymentStatus(projectId, deploymentId);

    if (status === "live" || status === "failed") {
      await server.notification({
        method: "notifications/claude/channel",
        params: {
          content: status === "live"
            ? `Deployment live at ${url}`
            : `Build failed: ${errorMessage}`,
          meta: {
            event: status === "live" ? "deploy_complete" : "deploy_failed",
            project: projectName,
            deployment_id: deploymentId,
            deploy_mode: deployMode,
          },
        },
      });
      return;
    }
  }
}
```

**`apps/cli/src/mcp/tools/index.ts`** — Trigger watcher after deploy:
```typescript
case "deploy_project": {
  const result = await deployProject(projectPath, options);

  // Fire-and-forget: watch for final status in background
  if (result.deploymentId && result.deployMode === "managed") {
    watchDeployment(server, projectId, result.deploymentId, result.projectName, result.deployMode)
      .catch(err => console.error("[channel] deploy watcher error:", err));
  }

  return formatSuccessResponse(result, startTime);
}
```

### Scope boundaries

**In scope (Phase 1):**
- Channel capability declaration in MCP server
- Deploy status notifications (complete/failed) after `deploy_project` tool calls
- Managed mode only (control plane polling)
- Single project (working directory's linked project)

**Out of scope (future phases):**
- Production error streaming (Phase 2 — requires SSE log subscription)
- BYO mode deploy watching (would need wrangler deployment polling)
- Multi-project watching
- Event filtering / configuration
- Webhook ingestion (would require extracting to standalone)
- Two-way channel (reply tools)
- claude.ai web / remote MCP support (channels are local-only)

---

## Discarded: Option B (Standalone `jack channel serve`)

A separate CLI command starting a channel-only MCP server with optional webhook HTTP endpoint.

**Why discarded:**
- Adds a second process for users to manage
- Requires separate `.mcp.json` entry and `--channels` config
- Main advantage (webhook ingestion) needs tunneling for remote CI — too much friction
- Duplicates auth/config loading already available in-process

**Extraction path:** If webhook demand emerges, `channel/deploy-watcher.ts` moves cleanly into a standalone server. The notification logic is transport-agnostic.
