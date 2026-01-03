# Project Tagging PRD

## Overview

### Problem Statement
Developers using jack for high-throughput project creation (2-3+ projects per day) lack a way to organize and filter their growing collection of deployed workers. The current `jack projects list` shows a flat list with no categorization, making it difficult to:
- Find projects by purpose or type
- Group related projects together
- Filter views to focus on specific project categories
- Understand project relationships at a glance

### Objective
Implement a lightweight, bottom-up tagging system that works locally first but can optionally sync to the cloud for cross-device consistency. This feature should:
- **Be lightweight**: Simple string tags, no complex hierarchies
- **Be local-first**: Work offline, sync when authenticated
- **Be extensible**: Start simple, enable future enhancements (structured tags, sharing)
- **Be template-aware**: Templates can define default tags applied at creation
- **Be non-intrusive**: Zero impact on `jack ship` performance

### Success Metrics
- Users can tag projects and filter by tag in < 5 seconds
- `jack ship` latency unchanged (metadata sync is fire-and-forget)
- Tags persist across devices when user is authenticated
- Template default tags reduce manual tagging effort

## Scope

### In Scope
1. Local tag storage in `~/.config/jack/projects.json`
2. Cloud tag sync via D1 (when authenticated)
3. CLI commands: `jack tag add/remove/list`
4. Project filtering: `jack projects --tag <tag>`
5. Template default tags via `.jack.json`
6. UUIDv7-based project identity for cloud sync
7. Metadata sync piggybacking on existing `syncToCloud()`

### Out of Scope
1. Structured/hierarchical tags (`type:api`, `client:acme`)
2. Tag sharing between users
3. Bulk tag operations (`jack tag add --all`)
4. Smart views / web dashboard (separate repo)
5. AI-suggested tags
6. Tag aliases or normalization
7. Path-dependent auto-tagging

### Dependencies
- Existing local registry (`~/.config/jack/projects.json`)
- Existing sync infrastructure (`syncToCloud()`)
- Existing auth system (WorkOS JWT)
- D1 database (api-worker)

## User Stories

### Story 1: Manual Tagging
**As a** developer with many projects
**I want** to add tags to my projects
**So that** I can organize them by purpose, client, or status

**Acceptance Criteria:**
- `jack tag add my-api backend production` adds two tags
- `jack tag remove my-api production` removes one tag
- Tags are immediately visible in `jack projects`
- Tags persist across terminal sessions

### Story 2: Filtering by Tag
**As a** developer looking for specific projects
**I want** to filter my project list by tag
**So that** I can quickly find what I'm looking for

**Acceptance Criteria:**
- `jack projects --tag backend` shows only backend projects
- `jack projects --tag production` shows only production projects
- Multiple tags can be specified (AND logic)
- Clear indication when no projects match

### Story 3: Template Default Tags
**As a** developer using templates
**I want** new projects to inherit tags from their template
**So that** I don't have to manually tag every project

**Acceptance Criteria:**
- Creating from `api` template auto-applies `["backend", "api"]` tags
- Creating from `miniapp` template auto-applies `["frontend", "farcaster"]` tags
- Default tags are visible in `jack projects` immediately
- User can modify default tags after creation

### Story 4: Cross-Device Sync
**As a** developer working across multiple machines
**I want** my tags to sync to the cloud
**So that** I see the same organization everywhere

**Acceptance Criteria:**
- Tags sync during `jack sync` when authenticated
- Tags sync during `jack ship` (fire-and-forget, non-blocking)
- `jack clone` restores project with its tags
- Offline tag changes sync on next authenticated operation

### Story 5: Tag Discovery
**As a** developer exploring my projects
**I want** to see all tags in use
**So that** I can understand my project organization

**Acceptance Criteria:**
- `jack tag list` shows all unique tags across all projects
- Each tag shows count of projects using it
- Output is sorted by frequency or alphabetically

## Technical Requirements

### Data Models

#### Local Registry Extension (`~/.config/jack/projects.json`)
```typescript
interface Project {
  // Existing fields
  localPath: string | null;
  workerUrl: string | null;
  createdAt: string;
  lastDeployed: string | null;
  cloudflare: {
    accountId: string;
    workerId: string;
  };
  resources: {
    services: {
      db: string | null;
    };
  };
  template?: TemplateOrigin;

  // New fields
  id?: string;           // UUIDv7, assigned on first cloud sync
  tags?: string[];       // Array of tag strings
}
```

#### D1 Schema (`migrations/0002_create_projects.sql`)
```sql
-- Projects table for cloud sync and web UI
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,                    -- UUIDv7
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  worker_url TEXT,
  tags TEXT,                              -- JSON array: ["backend", "api"]
  template_type TEXT,                     -- "builtin" | "github"
  template_name TEXT,                     -- "api", "miniapp", "user/repo"
  cloudflare_account_id TEXT,
  cloudflare_worker_id TEXT,
  db_name TEXT,
  local_path TEXT,                        -- For reference only
  last_deployed DATETIME,
  last_synced DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(user_id, name);

-- Trigger to update updated_at on row changes
CREATE TRIGGER IF NOT EXISTS projects_updated_at
  AFTER UPDATE ON projects
  FOR EACH ROW
BEGIN
  UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;
```

#### Template Default Tags (`.jack.json`)
```json
{
  "name": "api",
  "description": "Backend API with Hono",
  "defaultTags": ["backend", "api"],
  "capabilities": ["db"],
  ...
}
```

### API Endpoints

#### `GET /api/projects`
List all projects for authenticated user.

**Query Parameters:**
- `tag` (optional): Filter by tag (can repeat for AND logic)

**Response:**
```json
{
  "projects": [
    {
      "id": "01937a4c-5b2a-7def-8c3e-1a2b3c4d5e6f",
      "name": "my-api",
      "workerUrl": "https://my-api.workers.dev",
      "tags": ["backend", "production"],
      "templateType": "builtin",
      "templateName": "api",
      "lastDeployed": "2025-01-15T10:30:00Z",
      "lastSynced": "2025-01-15T10:30:00Z"
    }
  ]
}
```

#### `GET /api/projects/:name`
Get single project by name.

**Response:**
```json
{
  "project": {
    "id": "01937a4c-5b2a-7def-8c3e-1a2b3c4d5e6f",
    "name": "my-api",
    ...
  }
}
```

#### `PUT /api/projects/:name`
Upsert project metadata (called by CLI during sync).

**Request:**
```json
{
  "id": "01937a4c-5b2a-7def-8c3e-1a2b3c4d5e6f",
  "workerUrl": "https://my-api.workers.dev",
  "tags": ["backend", "production"],
  "templateType": "builtin",
  "templateName": "api",
  "cloudflareAccountId": "abc123",
  "cloudflareWorkerId": "def456",
  "dbName": "my-api-db",
  "localPath": "/Users/dev/projects/my-api",
  "lastDeployed": "2025-01-15T10:30:00Z"
}
```

**Response:**
```json
{
  "project": { ... },
  "created": false
}
```

### CLI Commands

#### `jack tag add <project> <tags...>`
Add one or more tags to a project.

```bash
$ jack tag add my-api backend production
✓ Added tags to my-api: backend, production
```

**Behavior:**
1. Read project from local registry
2. Merge new tags with existing (dedupe)
3. Write back to registry
4. No cloud sync (happens on next `jack sync` or `jack ship`)

#### `jack tag remove <project> <tags...>`
Remove one or more tags from a project.

```bash
$ jack tag remove my-api production
✓ Removed tags from my-api: production
```

#### `jack tag list [project]`
List all tags (or tags for specific project).

```bash
# All tags
$ jack tag list
→ Tags in use:
  backend (5 projects)
  frontend (3 projects)
  production (2 projects)
  api (2 projects)
  experiment (1 project)

# Specific project
$ jack tag list my-api
→ Tags for my-api:
  backend, api
```

#### `jack projects --tag <tag>`
Filter project list by tag.

```bash
$ jack projects --tag backend
→ Projects tagged "backend":
  my-api          https://my-api.workers.dev
  auth-service    https://auth-service.workers.dev
  data-pipeline   https://data-pipeline.workers.dev
```

### Sync Flow

#### Extended `syncToCloud()` in `apps/cli/src/lib/storage/index.ts`

```typescript
export async function syncToCloud(
  projectPath: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  // Existing file sync to R2
  const fileResult = await syncFilesToR2(projectPath, options);

  // New: metadata sync to D1 (if authenticated)
  const auth = await getAuth();
  if (auth?.access_token) {
    await syncMetadataToD1(projectPath, auth).catch(err => {
      // Fire-and-forget: log but don't fail
      console.error("Metadata sync failed:", err.message);
    });
  }

  return fileResult;
}

async function syncMetadataToD1(
  projectPath: string,
  auth: AuthState
): Promise<void> {
  const projectName = await getProjectName(projectPath);
  const project = await getProject(projectName);
  if (!project) return;

  // Ensure project has UUIDv7
  if (!project.id) {
    project.id = generateUUIDv7();
    await updateProject(projectName, { id: project.id });
  }

  // PUT to API
  await fetch(`https://api.getjack.org/api/projects/${projectName}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${auth.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: project.id,
      workerUrl: project.workerUrl,
      tags: project.tags || [],
      templateType: project.template?.type,
      templateName: project.template?.name,
      cloudflareAccountId: project.cloudflare.accountId,
      cloudflareWorkerId: project.cloudflare.workerId,
      dbName: project.resources.services.db,
      localPath: project.localPath,
      lastDeployed: project.lastDeployed,
    }),
  });
}
```

### Architecture

#### New Files
- `apps/cli/src/commands/tag.ts` - Tag CLI commands
- `apps/cli/src/lib/tags.ts` - Tag management utilities
- `apps/cli/src/lib/uuid.ts` - UUIDv7 generation
- `migrations/0002_create_projects.sql` - D1 schema

#### Modified Files
- `apps/cli/src/lib/registry.ts` - Add `id` and `tags` to Project interface
- `apps/cli/src/lib/storage/index.ts` - Add metadata sync to `syncToCloud()`
- `apps/cli/src/commands/projects.ts` - Add `--tag` filter flag
- `apps/cli/src/commands/new.ts` - Apply template default tags
- `apps/cli/src/templates/types.ts` - Add `defaultTags` to Template interface
- `apps/cli/src/index.ts` - Register `tag` command
- `apps/api-worker/src/index.ts` - Add project endpoints

### Performance Considerations

#### `jack ship` Must Stay Fast
- File sync (R2) already happens: ~500ms-2s depending on changes
- Metadata sync (D1) adds: ~50-100ms single HTTP call
- **Mitigation**: Metadata sync is fire-and-forget (non-blocking)
- If D1 call fails, deployment still succeeds
- Retry on next sync/ship

#### Local Operations Are Instant
- `jack tag add/remove` only touches local JSON file
- No network calls for tag modifications
- Sub-10ms operation

### Security Considerations

1. **Authentication**: All `/api/projects/*` endpoints require valid JWT
2. **Authorization**: Users can only access their own projects (user_id from JWT)
3. **Input validation**: Tag names sanitized (alphanumeric, hyphen, underscore only)
4. **Rate limiting**: Standard API rate limits apply

### Error Handling

#### Tag command errors
```bash
$ jack tag add nonexistent-project foo
✗ Project "nonexistent-project" not found
→ Run: jack projects

$ jack tag add my-api
✗ No tags specified
→ Usage: jack tag add <project> <tags...>
```

#### Sync errors (non-fatal)
```bash
$ jack ship
✓ Deployed: https://my-api.workers.dev
! Metadata sync failed (will retry on next sync)
```

## Implementation Approach

### Phase 1: Local Tags (Foundation)

#### Step 1.1: Extend Registry Interface
**File:** `apps/cli/src/lib/registry.ts`

Add `id` and `tags` fields to Project interface:
```typescript
export interface Project {
  // ... existing fields ...
  id?: string;           // UUIDv7
  tags?: string[];       // Tag array
}
```

#### Step 1.2: Create UUIDv7 Utility
**File:** `apps/cli/src/lib/uuid.ts`

```typescript
/**
 * Generate a UUIDv7 (time-sortable UUID)
 * Format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
 */
export function generateUUIDv7(): string {
  const timestamp = Date.now();
  const timestampHex = timestamp.toString(16).padStart(12, "0");

  // Random bytes for the rest
  const randomBytes = crypto.getRandomValues(new Uint8Array(10));
  const randomHex = Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // Construct UUIDv7
  // timestamp (48 bits) + version (4 bits) + random (12 bits) + variant (2 bits) + random (62 bits)
  const uuid = [
    timestampHex.slice(0, 8),
    timestampHex.slice(8, 12),
    "7" + randomHex.slice(0, 3),
    ((parseInt(randomHex.slice(3, 4), 16) & 0x3) | 0x8).toString(16) + randomHex.slice(4, 7),
    randomHex.slice(7, 19),
  ].join("-");

  return uuid;
}
```

#### Step 1.3: Create Tag Management Module
**File:** `apps/cli/src/lib/tags.ts`

```typescript
import { getProject, updateProject, getAllProjects } from "./registry.ts";

const TAG_REGEX = /^[a-zA-Z0-9_-]+$/;

export function validateTag(tag: string): boolean {
  return TAG_REGEX.test(tag) && tag.length <= 50;
}

export async function addTags(projectName: string, tags: string[]): Promise<string[]> {
  const project = await getProject(projectName);
  if (!project) {
    throw new Error(`Project "${projectName}" not found`);
  }

  // Validate tags
  for (const tag of tags) {
    if (!validateTag(tag)) {
      throw new Error(`Invalid tag "${tag}" - use only letters, numbers, hyphens, underscores`);
    }
  }

  // Merge and dedupe
  const existingTags = project.tags || [];
  const newTags = [...new Set([...existingTags, ...tags])];

  await updateProject(projectName, { tags: newTags });
  return newTags;
}

export async function removeTags(projectName: string, tags: string[]): Promise<string[]> {
  const project = await getProject(projectName);
  if (!project) {
    throw new Error(`Project "${projectName}" not found`);
  }

  const existingTags = project.tags || [];
  const newTags = existingTags.filter(t => !tags.includes(t));

  await updateProject(projectName, { tags: newTags });
  return newTags;
}

export async function getProjectTags(projectName: string): Promise<string[]> {
  const project = await getProject(projectName);
  if (!project) {
    throw new Error(`Project "${projectName}" not found`);
  }
  return project.tags || [];
}

export async function getAllTags(): Promise<Map<string, number>> {
  const projects = await getAllProjects();
  const tagCounts = new Map<string, number>();

  for (const project of Object.values(projects)) {
    for (const tag of project.tags || []) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }

  return tagCounts;
}

export async function getProjectsByTag(tag: string): Promise<string[]> {
  const projects = await getAllProjects();
  return Object.entries(projects)
    .filter(([_, project]) => project.tags?.includes(tag))
    .map(([name, _]) => name);
}
```

#### Step 1.4: Create Tag CLI Command
**File:** `apps/cli/src/commands/tag.ts`

```typescript
import { addTags, removeTags, getProjectTags, getAllTags } from "../lib/tags.ts";
import { error, info, success, item } from "../lib/output.ts";

export default async function tag(
  subcommand?: string,
  args: string[] = []
): Promise<void> {
  if (!subcommand) {
    return await listTags();
  }

  switch (subcommand) {
    case "add":
      return await handleAdd(args);
    case "remove":
      return await handleRemove(args);
    case "list":
      return await listTags(args[0]);
    default:
      error(`Unknown subcommand: ${subcommand}`);
      info("Usage: jack tag <add|remove|list> [project] [tags...]");
      process.exit(1);
  }
}

async function handleAdd(args: string[]): Promise<void> {
  const [projectName, ...tags] = args;

  if (!projectName) {
    error("Project name required");
    info("Usage: jack tag add <project> <tags...>");
    process.exit(1);
  }

  if (tags.length === 0) {
    error("No tags specified");
    info("Usage: jack tag add <project> <tags...>");
    process.exit(1);
  }

  try {
    await addTags(projectName, tags);
    success(`Added tags to ${projectName}: ${tags.join(", ")}`);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function handleRemove(args: string[]): Promise<void> {
  const [projectName, ...tags] = args;

  if (!projectName) {
    error("Project name required");
    info("Usage: jack tag remove <project> <tags...>");
    process.exit(1);
  }

  if (tags.length === 0) {
    error("No tags specified");
    info("Usage: jack tag remove <project> <tags...>");
    process.exit(1);
  }

  try {
    await removeTags(projectName, tags);
    success(`Removed tags from ${projectName}: ${tags.join(", ")}`);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function listTags(projectName?: string): Promise<void> {
  try {
    if (projectName) {
      const tags = await getProjectTags(projectName);
      if (tags.length === 0) {
        info(`No tags for ${projectName}`);
      } else {
        info(`Tags for ${projectName}:`);
        item(tags.join(", "));
      }
    } else {
      const tagCounts = await getAllTags();
      if (tagCounts.size === 0) {
        info("No tags in use");
        info("Add tags: jack tag add <project> <tags...>");
      } else {
        info("Tags in use:");
        const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
        for (const [tag, count] of sorted) {
          item(`${tag} (${count} project${count === 1 ? "" : "s"})`);
        }
      }
    }
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
```

#### Step 1.5: Add --tag Filter to Projects Command
**File:** `apps/cli/src/commands/projects.ts`

Add flag parsing and filtering:
```typescript
// In the command handler
if (flags.tag) {
  const filteredProjects = Object.entries(projects)
    .filter(([_, project]) => project.tags?.includes(flags.tag));
  // Display filtered list
}
```

#### Step 1.6: Register Tag Command
**File:** `apps/cli/src/index.ts`

```typescript
import tag from "./commands/tag.ts";

// In command routing
if (cli.input[0] === "tag") {
  await tag(cli.input[1], cli.input.slice(2));
  process.exit(0);
}
```

**Testing Phase 1:**
1. `jack tag add my-project backend api` → adds tags
2. `jack tag list my-project` → shows project tags
3. `jack tag list` → shows all tags with counts
4. `jack tag remove my-project api` → removes tag
5. `jack projects --tag backend` → filters by tag

### Phase 2: Template Default Tags

#### Step 2.1: Extend Template Interface
**File:** `apps/cli/src/templates/types.ts`

```typescript
export interface Template {
  // ... existing fields ...
  defaultTags?: string[];
}
```

#### Step 2.2: Update Templates
**File:** `apps/cli/templates/api/.jack.json`
```json
{
  "defaultTags": ["backend", "api"],
  ...
}
```

**File:** `apps/cli/templates/miniapp/.jack.json`
```json
{
  "defaultTags": ["frontend", "farcaster"],
  ...
}
```

#### Step 2.3: Apply Tags During Project Creation
**File:** `apps/cli/src/commands/new.ts` (or `project-operations.ts`)

```typescript
// After registering project
if (template.defaultTags && template.defaultTags.length > 0) {
  await updateProject(projectName, { tags: template.defaultTags });
}
```

**Testing Phase 2:**
1. `jack new my-api --template api` → project has tags `["backend", "api"]`
2. `jack projects --tag backend` → shows new project

### Phase 3: D1 Schema & API

#### Step 3.1: Create Migration
**File:** `migrations/0002_create_projects.sql`

(See schema in Technical Requirements above)

#### Step 3.2: Add API Endpoints
**File:** `apps/api-worker/src/index.ts`

```typescript
// GET /api/projects
api.get("/projects", async (c) => {
  const auth = c.get("auth");
  const tag = c.req.query("tag");

  let query = "SELECT * FROM projects WHERE user_id = ?";
  const params: string[] = [auth.userId];

  if (tag) {
    // SQLite JSON contains check
    query += " AND json_extract(tags, '$') LIKE ?";
    params.push(`%"${tag}"%`);
  }

  const projects = await c.env.DB.prepare(query).bind(...params).all();
  return c.json({ projects: projects.results });
});

// GET /api/projects/:name
api.get("/projects/:name", async (c) => {
  const auth = c.get("auth");
  const name = c.req.param("name");

  const project = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE user_id = ? AND name = ?"
  ).bind(auth.userId, name).first();

  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json({ project });
});

// PUT /api/projects/:name
api.put("/projects/:name", async (c) => {
  const auth = c.get("auth");
  const name = c.req.param("name");
  const body = await c.req.json();

  const result = await c.env.DB.prepare(`
    INSERT INTO projects (id, user_id, name, worker_url, tags, template_type, template_name,
      cloudflare_account_id, cloudflare_worker_id, db_name, local_path, last_deployed, last_synced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, name) DO UPDATE SET
      worker_url = excluded.worker_url,
      tags = excluded.tags,
      template_type = excluded.template_type,
      template_name = excluded.template_name,
      cloudflare_account_id = excluded.cloudflare_account_id,
      cloudflare_worker_id = excluded.cloudflare_worker_id,
      db_name = excluded.db_name,
      local_path = excluded.local_path,
      last_deployed = excluded.last_deployed,
      last_synced = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    body.id,
    auth.userId,
    name,
    body.workerUrl,
    JSON.stringify(body.tags || []),
    body.templateType,
    body.templateName,
    body.cloudflareAccountId,
    body.cloudflareWorkerId,
    body.dbName,
    body.localPath,
    body.lastDeployed
  ).run();

  const project = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE user_id = ? AND name = ?"
  ).bind(auth.userId, name).first();

  return c.json({ project, created: result.meta.changes === 1 });
});
```

**Testing Phase 3:**
1. Apply migration to D1
2. Test endpoints via curl with valid JWT
3. Verify UNIQUE constraint on (user_id, name)

### Phase 4: Metadata Sync

#### Step 4.1: Add Sync Function
**File:** `apps/cli/src/lib/storage/index.ts`

Extend `syncToCloud()` to include metadata sync (see Technical Requirements).

#### Step 4.2: Handle UUIDv7 Assignment
First sync assigns project ID if missing.

**Testing Phase 4:**
1. `jack sync` in authenticated state → metadata appears in D1
2. `jack ship` → metadata syncs (check logs)
3. Create project on machine A, sync, check D1
4. Verify tags round-trip correctly

## Validation Criteria

### Functional Acceptance Criteria
- [ ] `jack tag add <project> <tags...>` adds tags to local registry
- [ ] `jack tag remove <project> <tags...>` removes tags from local registry
- [ ] `jack tag list` shows all tags with project counts
- [ ] `jack tag list <project>` shows tags for specific project
- [ ] `jack projects --tag <tag>` filters projects by tag
- [ ] Template default tags applied during `jack new`
- [ ] Metadata syncs to D1 during `jack sync` (when authenticated)
- [ ] Metadata syncs to D1 during `jack ship` (fire-and-forget)
- [ ] UUIDv7 assigned on first sync
- [ ] API endpoints work with valid JWT
- [ ] Tag filtering works in API

### Technical Validation Criteria
- [ ] `jack tag add/remove` completes in < 50ms (local only)
- [ ] `jack ship` latency unchanged (metadata sync non-blocking)
- [ ] Metadata sync adds < 100ms to `jack sync`
- [ ] Local registry backward compatible (old format still works)
- [ ] Tag validation rejects invalid characters
- [ ] D1 schema supports efficient tag queries

### User Experience Validation
- [ ] Clear error messages for invalid tags
- [ ] Clear error messages for unknown projects
- [ ] Sync failures don't break deploy
- [ ] Offline tagging works seamlessly

## Risks and Mitigations

### Risk 1: Sync Conflicts
**Risk:** Tags edited on two machines before sync could conflict.
**Mitigation:** Last-write-wins. For personal use, conflicts are rare and acceptable.

### Risk 2: Performance Impact on Ship
**Risk:** Adding D1 call could slow down `jack ship`.
**Mitigation:** Fire-and-forget pattern - sync happens async, failures logged not thrown.

### Risk 3: Schema Migration Complexity
**Risk:** D1 migrations could fail or cause issues.
**Mitigation:** Simple schema, idempotent migration, test thoroughly before deploy.

### Risk 4: Tag Sprawl
**Risk:** Users create many inconsistent tags over time.
**Mitigation:** Future enhancement: tag suggestions, normalization. Keep scope simple for now.

## Future Enhancements (Out of Scope)

1. **Structured tags**: `type:api`, `client:acme` with namespaces
2. **Tag aliases**: `prod` → `production` normalization
3. **Smart suggestions**: AI-suggested tags based on project content
4. **Bulk operations**: `jack tag add --all-matching "api-*" backend`
5. **Web dashboard**: Tag filtering UI (separate repo)
6. **Sharing**: Share tag collections with team members

---

## Appendix: Example Flows

### Flow 1: Basic Tagging
```bash
$ jack new my-api --template api
✓ Created my-api/
✓ Live: https://my-api.workers.dev

$ jack tag list my-api
→ Tags for my-api:
  backend, api

$ jack tag add my-api production client-acme
✓ Added tags to my-api: production, client-acme

$ jack tag list my-api
→ Tags for my-api:
  backend, api, production, client-acme

$ jack projects --tag production
→ Projects tagged "production":
  my-api    https://my-api.workers.dev
```

### Flow 2: Cross-Device Sync
```bash
# Machine A
$ jack new data-api --template api
$ jack tag add data-api critical
$ jack sync
✓ Synced files to jack-storage/data-api/
✓ Synced metadata to cloud

# Machine B (later)
$ jack clone data-api
✓ Cloned data-api from cloud

$ jack tag list data-api
→ Tags for data-api:
  backend, api, critical
```

### Flow 3: Filtering
```bash
$ jack tag list
→ Tags in use:
  backend (5 projects)
  frontend (3 projects)
  production (2 projects)
  experiment (4 projects)

$ jack projects --tag backend --tag production
→ Projects tagged "backend" AND "production":
  auth-api    https://auth-api.workers.dev
  data-api    https://data-api.workers.dev
```
