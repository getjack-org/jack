# Overview
- URL routing and deployment URLs for `{username}-{projectName}.runjack.xyz` (dispatch parsing, KV keys, slug/username rules)
- Template forking and publish flow (source snapshot upload, `jack new -t`, public/private behavior)
- Existing project detection and auto-deploy (CLI link resolution, auto-detect behavior, managed vs BYO selection)
- Prebuilt template deployments (bundle retrieval, fallback behavior, source snapshot handling)
- KV cache consistency (config keys, publish updates, resource type mapping)

## Status Log (2026-01-14)
- Status: Needs fix — URL parsing for hyphenated usernames breaks `{username}-{slug}`; legacy slugs can shadow new format. See `apps/dispatch-worker/src/index.ts:27`.
- Status: Needs fix — prebuilt `jack new` skips source snapshot upload, so publish/forking fails until a manual `jack ship`. See `apps/cli/src/lib/project-operations.ts:1027` and `apps/cli/src/lib/managed-deploy.ts:152`.
- Status: Needs fix — `jack ship` without a link defaults to BYO; auto-detect creates a managed project without checking existing managed projects. See `apps/cli/src/lib/project-operations.ts:1206`.
- Status: Needs fix — publish rebuilds KV config using `resource_type = 'D1_DATABASE'`, which does not match provisioning (`d1`), so `d1_database_id` can be empty. See `apps/control-plane/src/index.ts:1765`.
- Status: Follow-up — username set after project creation does not backfill `owner_username` or KV keys; `{username}-{slug}` does not resolve unless republished. See `apps/control-plane/src/index.ts:323`.

## Open Decisions
- Decide whether to keep global slug uniqueness or move to username+slug uniqueness (impacts routing and existing data). See `apps/control-plane/migrations/0004_unique_project_slug.sql:1`.
- Decide whether to allow hyphenated usernames; if yes, change delimiter/parsing, if no, tighten validation and migrations. See `apps/control-plane/src/index.ts:31`.

## Suggested Verification
- Add tests for hostname parsing (hyphenated usernames, legacy slugs) and KV lookup order.
- Exercise prebuilt deploy plus publish plus fork in CI or a staging account.
- Validate `jack ship` behavior with existing managed projects and missing `.jack` links (ensure link/merge prompts).

---

# Database Binding State Management - Architecture Analysis (2026-01-19)

## The Core Problem

Jack maintains **two separate sources of truth** for database bindings:

1. **wrangler.jsonc** (local config file)
   ```json
   {
     "d1_databases": [{
       "binding": "DB",
       "database_name": "my-app-db",
       "database_id": "uuid-here"
     }]
   }
   ```

2. **Control Plane** (for managed projects)
   - `resources` table: `resource_name`, `provider_id`, `binding_name`
   - KV cache: `ProjectConfig.d1_database_id`

These don't sync, causing confusion and bugs.

---

## Specific Issues Identified

### Issue 1: `jack services db create <name>` ignores positional name argument

**Location:** `apps/cli/src/commands/services.ts:356`

**Problem:** The CLI parses `--name` flag but not positional arguments:
```typescript
const name = parseNameFlag(args); // Only parses --name or --name=foo
```

**Result:** `jack services db create mydb` creates auto-named DB; must use `jack services db create --name mydb`

---

### Issue 2: Database naming mismatch between CLI and control plane (FIXED 2026-01-19)

**Location:** `apps/cli/src/lib/services/db-create.ts:177`

**Problem:** CLI wrote wrong `database_name` to wrangler.jsonc for managed projects.

#### The Three Database "Names"

| Field | Example | Purpose | Set By |
|-------|---------|---------|--------|
| `binding` | `"DB"` | Code variable (`env.DB`) | CLI generates |
| `database_name` | `"jack-abc123-mydb"` | Actual D1 name in Cloudflare | Control plane generates |
| `database_id` | `"8f50d6d8-..."` | Cloudflare UUID | Cloudflare assigns |

#### What Happened

When `jack services db create --name mydb` ran for managed mode:

```
1. CLI generated name:        "db-test-1768836262-db"     (project-based)
2. Control plane created:     "jack-a3d86ef4-0b1d-4d-mydb" (its format)
3. CLI wrote to wrangler.jsonc: database_name: "db-test-1768836262-db" ❌ WRONG
4. Should have written:         database_name: "jack-a3d86ef4-0b1d-4d-mydb" ✅
```

This caused:
- `wrangler d1 execute` worked (used local config)
- `jack services db delete` couldn't match binding to remove
- Stale bindings in wrangler.jsonc after delete

#### Fix Applied

**db-create.ts**: Use `resource.resource_name` from control plane response:
```typescript
// Before (bug)
database_name: databaseName,  // CLI-generated name

// After (fixed)
actualDatabaseName = resource.resource_name;  // Control plane's actual name
database_name: actualDatabaseName,
```

**provisioning.ts**: Set `binding_name` when creating initial D1 during `jack new`:
```typescript
// Before (bug): registerResource didn't set binding_name
const d1Resource = await this.registerResource(
    projectId, "d1", resourceNames.d1, d1Database.uuid
);
// Result: resources.binding_name = NULL

// After (fixed): Pass binding_name as 5th parameter
const d1Resource = await this.registerResource(
    projectId, "d1", resourceNames.d1, d1Database.uuid, "DB"
);
// Result: resources.binding_name = "DB"
```

**services.ts (dbDelete)**: Match binding by multiple criteria:
```typescript
// Match by (in order of reliability):
// 1. binding name (e.g., "DB") - most reliable
// 2. database_id (provider_id from control plane)
// 3. database_name (may differ between CLI and control plane)
```

---

### Issue 3: Database deletion doesn't clean up wrangler.jsonc (FIXED 2026-01-19)

**Location:** `apps/cli/src/commands/services.ts:278-332`

**Problem:** `dbDelete()` only calls:
```typescript
await deleteDatabase(dbInfo.name); // Just calls wrangler d1 delete
```

**Missing:**
- Remove binding from `wrangler.jsonc`
- Update control plane resources table (for managed)
- Invalidate KV cache (for managed)

**Result:** After `jack services db delete`:
- Cloudflare DB deleted ✓
- wrangler.jsonc still has stale binding ✗
- Control plane still thinks DB exists ✗
- Next deploy fails or references non-existent DB

---

### Issue 3: No sync between wrangler.jsonc and control plane

**Creation flow (managed):**
1. CLI calls control plane `POST /v1/projects/:id/resources/d1`
2. Control plane creates D1 via Cloudflare API
3. Control plane stores in `resources` table
4. CLI receives response and updates wrangler.jsonc

**Problem:** These can diverge:
- Manual wrangler.jsonc edits not reflected in control plane
- Control plane DB creates not reflected if CLI crashes mid-operation
- `jack link` to existing project doesn't sync databases

---

### Issue 4: Stale state after project unlink/link

**Scenario:**
1. Create managed project with DB
2. `jack unlink` (removes .jack/ but keeps wrangler.jsonc)
3. Delete DB via Cloudflare dashboard
4. `jack link` back to same project
5. wrangler.jsonc still references deleted DB
6. Control plane resources table still has deleted DB record

**Result:** Complete confusion about what databases actually exist.

---

### Issue 5: MCP vs CLI use different resolution strategies

**MCP tools:** Read wrangler.jsonc directly
**CLI managed mode:** Fetches from control plane first, falls back to wrangler.jsonc

This means MCP can operate on stale local state while CLI has fresher cloud state.

---

## Proposed Directions

### Direction A: wrangler.jsonc as Single Source of Truth

**Philosophy:** Treat wrangler.jsonc as the canonical state. Control plane only stores what's needed for routing/auth.

**Changes:**
1. Remove `resources` table dependency for DB operations
2. Sync wrangler.jsonc → control plane on deploy (declarative)
3. MCP and CLI both read from wrangler.jsonc
4. Delete removes from wrangler.jsonc AND Cloudflare

**Pros:**
- Simple mental model: "wrangler.jsonc is truth"
- Works offline/locally
- Matches Cloudflare's own model
- BYO and managed have same behavior

**Cons:**
- Can't track resources created via control plane if user never deploys
- Harder to implement "what DBs does this project have?" from cloud side
- No cloud-side inventory

---

### Direction B: Control Plane as Single Source of Truth (Managed Only)

**Philosophy:** For managed projects, control plane is canonical. wrangler.jsonc is generated/synced.

**Changes:**
1. `jack services db create` → control plane creates, CLI pulls and writes wrangler.jsonc
2. `jack services db delete` → control plane deletes, CLI removes from wrangler.jsonc
3. `jack link` → sync resources from control plane to wrangler.jsonc
4. `jack ship` → validate wrangler.jsonc matches control plane, warn on drift

**Pros:**
- Cloud has complete inventory
- Can recover state from cloud ("what DBs exist for this project?")
- Better for teams (single source across machines)

**Cons:**
- Requires network for all DB operations
- More complex sync logic
- BYO mode still needs separate handling

---

### Direction C: Bidirectional Sync with Conflict Resolution

**Philosophy:** Both are valid sources; sync on every operation with explicit conflict handling.

**Changes:**
1. Every DB operation compares local and cloud state
2. Conflicts prompt user: "Local has DB 'foo', cloud has DB 'bar'. Which to keep?"
3. `jack sync` command to manually reconcile
4. Deploy validates sync before proceeding

**Pros:**
- Handles all edge cases explicitly
- User always knows state

**Cons:**
- Complex to implement correctly
- UX overhead (frequent sync prompts)
- Potential for data loss if user chooses wrong

---

### Direction D: Event Sourcing / Operation Log

**Philosophy:** Track operations, derive state from operation history.

**Changes:**
1. Every create/delete logged to control plane
2. State reconstructed from operations
3. wrangler.jsonc generated from operation log
4. Conflicts resolved by "last operation wins" with timestamp

**Pros:**
- Full audit trail
- Can replay/recover state
- Handles distributed operations well

**Cons:**
- Significant architecture change
- Overkill for current scale
- Complexity doesn't match simplicity goals

---

### Direction E: Hybrid - Cloud Authority with Local Cache (Recommended)

**Philosophy:** Control plane is authority for managed; wrangler.jsonc is optimistic cache that syncs.

**Implementation:**

1. **On `jack services db create` (managed):**
   ```
   → Call control plane to create
   → Control plane returns { resource_name, provider_id, binding_name }
   → Write to wrangler.jsonc (local cache)
   → Return success
   ```

2. **On `jack services db delete` (managed):**
   ```
   → Call control plane to delete (marks resource as deleted)
   → Control plane calls Cloudflare to delete actual DB
   → Remove from wrangler.jsonc
   → Return success
   ```

3. **On `jack link`:**
   ```
   → Fetch resources from control plane
   → Merge with wrangler.jsonc (prompt on conflicts)
   → Write updated wrangler.jsonc
   ```

4. **On `jack ship`:**
   ```
   → Read wrangler.jsonc bindings
   → Validate all referenced DBs exist in control plane
   → If missing: "DB 'foo' in wrangler.jsonc but not in cloud. Create? Remove binding?"
   → If extra in cloud: "DB 'bar' exists in cloud but not in wrangler.jsonc. Add binding? Delete DB?"
   → Proceed with deploy after resolution
   ```

5. **BYO mode:**
   ```
   → wrangler.jsonc is authority (no control plane)
   → All operations via wrangler directly
   → No sync needed
   ```

**Key Principle:** Fail-safe over fail-silent. If state is ambiguous, ask user.

---

## Immediate Fixes (Low-Hanging Fruit)

These can be done now regardless of direction chosen:

### Fix 1: Accept positional name in db create
```typescript
// In dbCreate, after parseNameFlag
const name = parseNameFlag(args) || args.find(a => !a.startsWith('-'));
```

### Fix 2: Remove binding from wrangler.jsonc on delete
```typescript
// In dbDelete after successful deletion
await removeD1Binding(wranglerPath, dbInfo.name);
```

New utility needed in `wrangler-config.ts`:
```typescript
export async function removeD1Binding(configPath: string, databaseName: string): Promise<void>
```

### Fix 3: Validate DB existence before operations
```typescript
// Before executing SQL
const dbExists = await checkDatabaseExists(db.database_name);
if (!dbExists) {
  throw new Error(`Database "${db.database_name}" no longer exists. Run: jack services db cleanup`);
}
```

### Fix 4: Add `jack services db cleanup` command
Scans wrangler.jsonc, checks each DB exists via wrangler, offers to remove stale bindings.

### Fix 5: Sync on `jack link`
When linking to existing managed project, fetch resources and update wrangler.jsonc.

---

## Decisions Made (2026-01-19)

| Question | Decision |
|----------|----------|
| Primary user | Managed mode is priority; BYO can be more cumbersome |
| Offline operation | Not required for managed mode |
| MCP behavior | MCP uses control plane (requires auth context) |
| Deploy drift handling | Auto-sync from cloud after successful deploy |
| Delete flow | Via control plane API (not wrangler direct) |
| Manual DB add to wrangler.jsonc | Auto-provision on deploy (like R2/KV) |
| External wrangler DBs | Not supported in managed mode |
| DB removal from wrangler.jsonc | Prompt to delete after deploy |
| Binding matching | Match by binding name (reuse if same name) |
| Multiple DBs | Supported (send all d1_databases in manifest) |
| Local drift fix | Auto-fix on deploy only |

---

## Finalized Architecture Spec

### Core Model

```
┌─────────────────────────────────────────────────────────────┐
│                     CONTROL PLANE                            │
│                (Single Source of Truth)                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  resources table                                     │   │
│  │  - binding_name: "DB", "ANALYTICS_DB"               │   │
│  │  - resource_name: "jack-abc123-db"                  │   │
│  │  - provider_id: cloudflare UUID                     │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                           ▲
                           │ sync after deploy
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    wrangler.jsonc                            │
│                    (Local Cache)                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  d1_databases:                                       │   │
│  │  - binding: "DB"                                    │   │
│  │  - database_name: "jack-abc123-db"                  │   │
│  │  - database_id: cloudflare UUID                     │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Flow: `jack services db create`

```
User runs: jack services db create --name analytics

1. CLI calls control plane POST /v1/projects/:id/resources/d1
   - Control plane creates D1 via Cloudflare API
   - Control plane stores in resources table with binding_name

2. Control plane returns { resource_name, provider_id, binding_name }

3. CLI writes to wrangler.jsonc:
   d1_databases: [
     { binding: "ANALYTICS", database_name: "jack-...-analytics", database_id: "..." }
   ]

4. CLI prompts: "Deploy now?" (DB binding only active after deploy)
```

### Flow: `jack services db delete`

```
User runs: jack services db delete

1. CLI calls control plane DELETE /v1/projects/:id/resources/:id
   - Control plane marks resource as deleted in resources table
   - Control plane calls Cloudflare API to delete D1

2. Control plane returns success

3. CLI removes binding from wrangler.jsonc

4. Done (no deploy needed - binding removed on next deploy)
```

### Flow: `jack ship` (Deploy)

```
User runs: jack ship

1. CLI reads wrangler.jsonc, extracts binding intent:
   manifest.bindings.d1 = [
     { binding: "DB" },
     { binding: "ANALYTICS" }
   ]

2. CLI uploads manifest + code to control plane

3. Control plane resolves bindings:
   For each binding in manifest:
     - Look up by binding_name in resources table
     - If exists: use existing provider_id
     - If missing: AUTO-PROVISION new D1, register in resources table

4. Control plane deploys worker with resolved bindings

5. Control plane returns list of all resources for project

6. CLI syncs wrangler.jsonc from response:
   - Update database_name and database_id for each binding
   - Add any auto-provisioned DBs
   - This fixes any local drift

7. Control plane checks for orphaned resources:
   Resources in DB but not in manifest bindings

8. CLI prompts: "DB 'old-db' no longer used. Delete? [y/N]"
   - Yes: CLI calls DELETE endpoint
   - No: resource kept but not bound
```

### Flow: `jack link`

```
User runs: jack link my-project

1. CLI calls control plane to get project info + resources

2. CLI syncs wrangler.jsonc from cloud state:
   - Add/update d1_databases bindings from resources table
   - Prompt on conflicts (local has binding cloud doesn't know)

3. Done (local now matches cloud)
```

### Flow: MCP Tools

```
MCP tool invoked (e.g., mcp__jack__execute_sql)

1. MCP authenticates with control plane (using stored token)

2. MCP fetches project resources from control plane
   - Gets authoritative database_name and provider_id

3. MCP executes operation using cloud state
   - Not dependent on potentially-stale wrangler.jsonc

4. Returns result
```

### Edge Case Handling

| Scenario | Behavior |
|----------|----------|
| User adds binding to wrangler.jsonc | Auto-provisions on deploy |
| User removes binding from wrangler.jsonc | Prompts to delete after deploy |
| User edits database_name locally | Fixed on next deploy (synced from cloud) |
| User creates DB via wrangler CLI | Deploy fails: "Not supported in managed mode. Use jack services db create" |
| CLI crashes mid-create | Cloud has DB but local doesn't; fixed on next deploy sync |
| Multiple DBs with same binding name | First one wins (matched by binding name) |
| DB deleted via Cloudflare dashboard | Local stale until deploy; sync removes orphan binding |

### BYO Mode (Secondary)

For BYO projects, wrangler.jsonc remains the sole source of truth:
- `jack services db create` → calls `wrangler d1 create` directly
- `jack services db delete` → calls `wrangler d1 delete` directly
- No control plane involvement
- No sync needed (single source)

---

## Implementation Tasks

### Phase 1: Fix Delete Flow (Critical)

**Task 1.1:** Add control plane endpoint `DELETE /v1/projects/:id/resources/:id`
- Mark resource as deleted in DB
- Call Cloudflare API to delete D1
- Return success

**Task 1.2:** Update `jack services db delete` for managed mode
- Call control plane delete endpoint
- Remove binding from wrangler.jsonc
- Location: `apps/cli/src/commands/services.ts:278-332`

**Task 1.3:** Add `removeD1Binding()` utility
- Remove binding from wrangler.jsonc by database_name
- Location: `apps/cli/src/lib/wrangler-config.ts`

### Phase 2: Auto-Provision D1 on Deploy

**Task 2.1:** Update manifest to include ALL d1_databases
- Currently only sends first one
- Location: `apps/cli/src/lib/zip-packager.ts:132-182`

**Task 2.2:** Update `resolveBindingsFromManifest()` to auto-provision D1
- Currently fails if D1 missing; change to auto-create like R2/KV
- Location: `apps/control-plane/src/deployment-service.ts:449-578`

### Phase 3: Sync After Deploy

**Task 3.1:** Return full resource list from deploy endpoint
- Include all provisioned resources in deploy response

**Task 3.2:** Update CLI to sync wrangler.jsonc after deploy
- Update/add d1_databases bindings from response
- Location: `apps/cli/src/lib/managed-deploy.ts`

**Task 3.3:** Detect orphaned resources and prompt for deletion
- Compare resources in DB vs bindings in manifest
- Prompt user for each orphaned resource

### Phase 4: MCP Cloud Integration

**Task 4.1:** Add auth context to MCP server
- Store/retrieve auth token for control plane calls

**Task 4.2:** Update MCP tools to fetch from control plane
- Replace wrangler.jsonc reads with control plane API calls
- Location: `apps/cli/src/mcp/tools/index.ts`

### Phase 5: Link Sync

**Task 5.1:** Update `jack link` to sync resources
- Fetch resources from control plane
- Merge into wrangler.jsonc
- Location: `apps/cli/src/commands/link.ts`

---

## Success Criteria & Validation

### Phase 1 Success Criteria

| Test | Command | Expected Result |
|------|---------|-----------------|
| Delete removes from cloud | `jack services db delete` | Control plane resources table shows status='deleted' |
| Delete removes from local | `jack services db delete` | wrangler.jsonc no longer has the binding |
| Delete actually deletes DB | `wrangler d1 list --json` | DB not in list |
| Delete works for managed | Test on managed project | All above pass |

### Phase 2 Success Criteria

| Test | Command | Expected Result |
|------|---------|-----------------|
| Auto-provision single DB | Add binding to wrangler.jsonc, `jack ship` | DB created, deploy succeeds |
| Auto-provision multiple DBs | Add 2 bindings, `jack ship` | Both DBs created |
| Reuse existing by name | Binding "DB" exists, redeploy | Same DB reused (check UUID) |
| Manifest has all DBs | Check manifest in deploy | All d1_databases included |

### Phase 3 Success Criteria

| Test | Command | Expected Result |
|------|---------|-----------------|
| Sync updates local | Deploy auto-provisions DB | wrangler.jsonc has correct database_name/id |
| Sync fixes drift | Edit database_id locally, deploy | wrangler.jsonc corrected |
| Orphan detection | Remove binding, deploy | Prompt appears for unused DB |
| Orphan deletion | Say yes to prompt | DB deleted from cloud + resources table |

### Manual Validation Script

Run: `bun run scripts/validate-db-flows.ts`

```bash
# Quick validation commands (run manually)

# === SETUP ===
cd /tmp && rm -rf jack-db-test && mkdir jack-db-test && cd jack-db-test
jack new db-test-$(date +%s) --template api
cd db-test-*

# === TEST 1: Create DB ===
jack services db create --name testdb
# EXPECT: Success message, wrangler.jsonc has d1_databases entry
cat wrangler.jsonc | grep -A3 d1_databases
# EXPECT: Control plane has resource
# (check via: curl control.getjack.org/v1/projects/PROJECT_ID/resources)

# === TEST 2: Deploy with DB ===
jack ship
# EXPECT: Deploy succeeds, DB bound to worker

# === TEST 3: Execute SQL ===
jack services db execute "CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)"  --write
jack services db execute "INSERT INTO test (name) VALUES ('hello')" --write
jack services db execute "SELECT * FROM test"
# EXPECT: Returns [{ id: 1, name: "hello" }]

# === TEST 4: Delete DB (CURRENT BUG) ===
jack services db delete
# CURRENT: Deletes from Cloudflare but NOT from wrangler.jsonc or control plane
# AFTER FIX: Should remove from all 3 places

# Verify deletion
cat wrangler.jsonc | grep d1_databases
# AFTER FIX: Should be empty or missing
wrangler d1 list --json | grep testdb
# EXPECT: Not found

# === TEST 5: Auto-provision (Phase 2) ===
# Manually add to wrangler.jsonc:
#   "d1_databases": [{ "binding": "ANALYTICS", "database_name": "analytics-db", "database_id": "placeholder" }]
jack ship
# AFTER FIX: Should auto-create "ANALYTICS" DB and update wrangler.jsonc with real ID

# === TEST 6: Orphan detection (Phase 3) ===
# Remove the d1_databases entry from wrangler.jsonc
jack ship
# AFTER FIX: Should prompt "DB 'analytics-db' no longer used. Delete?"

# === CLEANUP ===
jack down
cd /tmp && rm -rf jack-db-test
```
