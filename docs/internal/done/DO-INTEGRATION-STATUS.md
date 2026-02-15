# Durable Objects Integration Status

Status: **Shipped** (Feb 2025)

## What Works

### Deploy Pipeline (jack ship)
- CLI detects `durable_objects` bindings in `wrangler.jsonc` and sends them in manifest
- Control plane generates `__jack_do_meter.mjs` wrapper that instruments `fetch`, `alarm`, `webSocketMessage`, `webSocketClose`, `webSocketError`
- Wrapper is uploaded as main module; user code becomes an additional module
- Migration tags (`new_sqlite_classes`, `new_classes`, `renamed_classes`, `deleted_classes`) are computed incrementally from `do_migration_tag` stored in D1
- Metering data written to `jack_do_usage` Analytics Engine dataset via `__JACK_USAGE` binding
- E2E verified: Counter DO with SQLite storage, persists state across requests

### Metering & Enforcement
- Enforcement cron runs every 5 minutes (self-gated)
- Queries AE for per-project rolling 24hr wall time
- Threshold: 8 hours wall time per 24hr window
- Enforcement: removes `durable_object_namespace` bindings (worker stays online for non-DO routes)
- Stores removed bindings in `do_enforcement.removed_bindings` for future restoration
- `/v1/projects/:projectId/do-usage` endpoint returns usage + enforcement status

### Rollback (jack rollback)
- Skips DO migrations on rollback (forward-only, would 412 on tag mismatch)
- Clears `do_enforcement` state on successful rollback

### Project Deletion (jack down)
- Cleans up `do_enforcement` rows before soft-delete
- Managed-down flow prompts for confirmation and auto-exports database

### MCP Tools
- `deploy_project` sends DO bindings in manifest (same as CLI)
- `get_project_status` returns project info
- `rollback_project` works correctly

## Known Gaps (ordered by priority)

### P1: jack info / jack ls don't show DO info
- `getProjectStatus()` doesn't include DO fields (migration tag, enforcement status, DO class names)
- Users with DO projects see the same output as non-DO projects
- Fix: add DO fields to `ProjectStatus` type and fetch from control plane

### P1: No `jack services do` subcommand
- Users can't check DO usage/enforcement from CLI
- The data is available via `/v1/projects/:projectId/do-usage`
- Fix: add `jack services do usage` that calls the existing endpoint

### P2: No DO data loss warning in managed-down
- `managed-down.ts` warns about database deletion but not about Durable Object storage loss
- DO storage (SQLite state, alarms) is destroyed when the worker is deleted
- Fix: check if project has DO bindings and warn accordingly

### P2: ProjectStatus type missing DO fields
- `ProjectStatus` interface in `project-operations.ts` doesn't have `do_migration_tag`, `has_durable_objects`, or `do_enforcement_status`
- These could be fetched from control plane for managed projects

## Architecture Notes

### Module Upload Fix (commit 68e1cd1)
The initial DO deploy failed with CF error `[10021]` because the wrapper module was uploaded twice — once as the main script content and again in the `allModules` array. Also, `extractAllModules()` was including non-JS files (README.md, .map files) as modules. Both issues were fixed.

### Dispatch Worker Error Handling
When DO bindings are removed by enforcement, the tenant worker's code fails when accessing the missing binding (e.g., `env.MY_DO.get(id)`). The dispatch worker catches this and returns 503 with a hint about binding removal. Non-DO routes continue working.

### Enforcement Lifecycle
```
User deploys with DOs → metering starts via AE → cron checks rolling 24hr
→ threshold exceeded → bindings removed → DO routes fail, non-DO works
→ user re-deploys (jack ship) → enforcement cleared, bindings restored
```
