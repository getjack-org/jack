# Tackle: Post-Entire Roadmap

What we're building, grounded in Jack's codebase and SPIRIT.

**Decisions locked in:**
- No auto health checks on deploy (speed is sacred)
- Rollback defaults to previous deploy, `--to` flag for specific
- Fork supports public + own private deploys
- SessionStart hook injects JACK.md content
- Ship 2 first (foundation)

---

## Ship 1: Rich deploy response (no health check) ✅ DONE

**Problem:** `DeployResult` today is minimal: `{ workerUrl, projectName, deployMode }`. The control plane already returns `deploymentId`, `status`, and `error_message` but they're thrown away.

**Solution:** Wire existing control plane response data into `DeployResult`. Zero latency added.

**Before:**
```json
{ "workerUrl": "https://...", "projectName": "my-app", "deployMode": "managed" }
```

**After:**
```json
{
  "workerUrl": "https://...",
  "projectName": "my-app",
  "deployMode": "managed",
  "deploymentId": "dep_abc123",
  "deployStatus": "live",
  "errorMessage": null
}
```

**What to build:**
- Add `deploymentId`, `deployStatus`, `errorMessage` to `DeployResult` interface
- Wire `DeployUploadResult` fields through `deployToManagedProject()` → `deployProject()`
- Agent sees deployment status immediately, can call `tail_logs` if it wants more

**Scope:** ~20 lines. Type change + plumbing.

**SPIRIT:** Speed is sacred. Don't add latency. Let the agent decide what to investigate.

---

## Ship 2: Real deploy tracking in `getProjectStatus` ✅ DONE

**Problem:** `getProjectStatus()` returns `lastDeployed: link?.linked_at` — the link creation time, not last deploy. Never updates on redeploy. Every agent session starts with stale data.

**Solution:** Expose the existing `deployments` table via API. Query it from `getProjectStatus()`.

**What exists today:**
- `deployments` table with `id, project_id, status, source, created_at`
- `deploymentService.getLatestDeployment(projectId)` already exists on control plane
- `deploymentService.listDeployments(projectId)` already exists
- No API endpoint exposes this to the CLI

**What to build:**
- Control plane endpoint: `GET /v1/projects/:projectId/deployments` (list recent, paginated)
- Control plane endpoint: `GET /v1/projects/:projectId/deployments/latest`
- CLI function: `listDeployments()` in `control-plane.ts`
- Enrich `getProjectStatus()` with real deploy data
- CLI command: `jack deploys [name]` to list deploy history

**New ProjectStatus fields:**
```typescript
interface ProjectStatus {
  // ... existing fields ...
  lastDeployAt: string | null;     // Real deploy timestamp (replaces linked_at lie)
  deployCount: number;             // Total deploys
  lastDeployStatus: string | null; // "live" | "failed"
  lastDeploySource: string | null; // "cli:v0.1.32" | "mcp:v0.1.32"
}
```

**Scope:** 2 API endpoints + CLI function + `getProjectStatus()` update + `jack deploys` command.

**SPIRIT:** Prepare the Session. Agent starts knowing the real state.

---

## Ship 3: Rollback

**Problem:** Deploy breaks something → only path is fix-and-redeploy. No undo.

**UX decision:** `jack rollback` = redeploy previous successful version. `jack rollback --to dep_abc123` = specific version.

**What exists today:**
- ALL deployment artifacts stored in R2 at `projects/{id}/deployments/{deploymentId}/`
- Each deploy stores: `bundle.zip`, `source.zip`, `manifest.json`, `schema.sql`, `secrets.json`, `assets.zip`
- `deploymentService.listDeployments(projectId)` returns all deploys
- Control plane knows how to deploy from stored artifacts

**What to build:**
- Control plane endpoint: `POST /v1/projects/:projectId/rollback` with optional `deployment_id`
- Shared service: `apps/cli/src/lib/services/deployment-rollback.ts`
- CLI command: `jack rollback` (default: previous) + `jack rollback --to dep_abc`
- MCP tool: `rollback_project` (optional `deployment_id` param)

**How it works:**
1. No `--to` flag: find previous `live` deployment
2. With `--to`: validate deployment exists
3. Re-deploy that deployment's stored artifacts
4. New deployment record created (source: "rollback:dep_abc123")
5. Return URL + status

**Scope:** 1 control plane endpoint + shared service + CLI command + MCP tool.

**SPIRIT:** Errors Are Conversations. "Deployed broken code" → `jack rollback` → back online. Demo: agent deploys → error → rolls back → fixes → redeploys.

---

## Ship 4: Enhance `jack init` with Claude Code hooks

**Problem:** `jack init` installs MCP config but not hooks. Agents start cold.

**What to build:**
- New module: `apps/cli/src/lib/claude-code-hooks.ts`
- `SessionStart` hook: output JACK.md content so agent starts informed
- Install hook during `jack init` when Claude Code detected
- Silent on failure

**Hook config (written to `~/.claude/settings.json`):**
```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "jack mcp context 2>/dev/null || true"
      }]
    }]
  }
}
```

**Scope:** ~100 lines new module + init.ts modification.

**SPIRIT:** Prepare the Session. Convention Over Configuration. Silent on failure.

---

## Ship 5: Fork from live deploy

**Problem:** Fork only works from latest source snapshot of published projects. Can't fork a specific deployment version. Can't fork your own private deploys.

**Scope:**
- Public projects: fork any published deploy
- Own private projects: fork your own deploys (useful for "start fresh from my last working version")

**What to build:**
- Extend `create_project` MCP tool with `source` parameter: `"username/slug"` or `"username/slug@dep_id"`
- Control plane endpoint: `GET /v1/projects/:projectId/deployments/:deploymentId/source`
- Auth: public projects = no auth, own projects = must be owner
- Extend template lineage: `{ type: "deployment", source_project_id, source_deployment_id }`
- CLI: `jack new --from username/slug[@dep_id]`

**Demo:** "Here's a live app. Fork it, modify, deploy your own." One agent conversation.

**Scope:** Extend existing fork infra + 1 API endpoint + MCP parameter.

**SPIRIT:** Don't punish exploration. Creation is free. Pre-Git Simplicity.

---

## Sequencing

```
Ship 2 (deploy tracking)         ← BUILD FIRST, foundation for everything
  ↓
Ship 1 (rich deploy response)    ← quick, plumbing only
  ↓
Ship 3 (rollback)                ← needs Ship 2's deploy list + artifacts
  ↓
Ship 4 (init hooks)              ← standalone but better with Ship 2 data
  ↓
Ship 5 (fork from deploy)        ← needs Ship 2's deployment API
```

Ship 2 is the foundation. Everything else builds on it.
Ships 1 and 4 are small and can be done in parallel after Ship 2.
Ship 3 before Ship 5 (rollback is more immediately useful than fork).
