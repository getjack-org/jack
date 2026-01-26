# Jack CLI - Agent Context

## Release Etiquette

- **Don't release without asking.** Never bump versions, create tags, or push releases unless the user explicitly requests it.
- Commits and pushes are fine when asked, but releasing to npm is a separate decision.

## Dependency Management

**Runtime deps go in `apps/cli/package.json`, not the workspace root.**

- Root `package.json` is for shared dev tooling (biome, typescript, etc.)
- When the CLI is published to npm, only `apps/cli/package.json` dependencies are included
- If you add an import like `import { foo } from "some-package"`, add `some-package` to `apps/cli/package.json`

**Before committing new features:**

1. Check for untracked files that are imported: `git status`
2. Verify CLI can start: `./src/index.ts --help`
3. Run tests: `bun test`

This prevents "works locally, fails in CI/npm" issues where files exist locally but weren't committed.

## Project Overview

jack is a CLI tool for vibecoders to rapidly deploy to Cloudflare Workers. Read `docs/internal/SPIRIT.md` for the philosophy.

## Key Directories

```
src/
├── index.ts           # CLI entry point and command router
├── commands/          # Command implementations
└── lib/               # Shared utilities (config, telemetry, etc.)

docs/internal/
├── SPIRIT.md          # Philosophy and design principles
├── done/              # Completed PRDs
└── future/            # Future feature ideas

templates/             # Project templates (miniapp, api, etc.)
```

## Project Operations Architecture (CLI + MCP)

jack uses a shared core so CLI and MCP stay aligned:

- `src/lib/project-operations.ts` is the single source of truth for create/deploy/status/cleanup.
- The library is silent by default and returns data only; CLI/MCP supply a reporter or stay quiet.
- Errors use `JackError` (code + suggestion + meta). CLI renders human output and exits; MCP maps to structured error responses.
- Hooks run interactive in CLI, non-interactive for MCP/CI via `interactive` flags.
- Deploy extras (secrets prompt + auto-sync) live in the library behind options; CLI enables them, MCP disables them.
- CLI wrappers should only add UX glue (e.g., open preferred agent), not re-implement core logic.

Tradeoff: the library may do more IO to prevent drift; wrappers stay thin.

## Adding New Features: CLI + MCP Parity Checklist

**CRITICAL:** When adding new CLI commands, always consider MCP parity. AI agents using MCP should have the same capabilities as humans using CLI.

### The Pattern

```
CLI Command  ─┐
              ├──▶  Shared Service Layer  ──▶  Control Plane API
MCP Tool     ─┘     (lib/services/*.ts)
```

### Checklist for New Features

1. **Create shared service function** in `src/lib/services/`:
   ```typescript
   // src/lib/services/domain-operations.ts
   export async function connectDomain(hostname: string, options: { interactive?: boolean }): Promise<ConnectDomainResult>
   ```

2. **Wire CLI command** in `src/commands/`:
   - Call shared service with `interactive: true`
   - Add human-readable output (success/error messages)
   - Handle prompts and confirmations

3. **Wire MCP tool** in `src/mcp/tools/index.ts`:
   - Call same shared service with `interactive: false`
   - Return structured JSON response
   - Add Zod schema for validation

4. **Update MCP tools table** in this file (see "Available MCP Tools" section)

### Anti-Pattern (What NOT to Do)

```typescript
// ❌ BAD: Direct API calls in CLI command
// This creates CLI-only features with no MCP coverage
async function connectDomain(hostname: string) {
  const response = await authFetch(`${getControlApiUrl()}/v1/domains`, {
    method: "POST",
    body: JSON.stringify({ hostname }),
  });
  // ... render output
}
```

```typescript
// ✅ GOOD: Shared service layer
// src/lib/services/domain-operations.ts
export async function connectDomain(hostname: string): Promise<ConnectDomainResult> {
  const response = await authFetch(`${getControlApiUrl()}/v1/domains`, { ... });
  return { domain: data.domain }; // Return data, don't render
}

// CLI calls: await connectDomain(hostname); success(`Connected ${hostname}`);
// MCP calls: return formatSuccessResponse(await connectDomain(hostname));
```

### Current Coverage Gaps

Features with CLI but no MCP (technical debt):
- `jack domain connect/assign/unassign/disconnect` - needs `src/lib/services/domain-operations.ts`
- `jack domains` - needs shared list function

When fixing gaps, extract the API calls from the CLI command into a shared service first.

## Telemetry System

**IMPORTANT:** jack has a telemetry system using PostHog. When adding or modifying commands:

### Automatic Tracking (No Action Needed)
Commands wrapped with `withTelemetry()` in `src/index.ts` automatically track:
- `command_invoked` - when command starts
- `command_completed` - when command succeeds (with duration)
- `command_failed` - when command errors (with error type)

### Custom Events (When Needed)
For business-specific events (e.g., project created, deploy started):

```typescript
import { track, Events } from '../lib/telemetry.ts'

// Only track meaningful business events
track(Events.PROJECT_CREATED, { template: 'miniapp', cloud_mode: 'byoc' })
```

### Adding New Events
1. Add to `Events` registry in `src/lib/telemetry.ts`
2. Document in `docs/telemetry-events.md`
3. Use `track(Events.NEW_EVENT, { ... })` where needed

See `docs/PRD-TELEMETRY.md` for full implementation details.

### Privacy Rules
- Never track: file paths, project names, URLs, secrets, user input
- Only track: command names, error types (not messages), durations, templates

## User Properties

Set via `identify()` at startup, sent with all events:
- `jack_version`, `os`, `arch`, `node_version`, `is_ci`
- `config_style`: 'byoc' (bring your own cloud) or 'jack-cloud'

## Testing Commands

```bash
# Run CLI directly
./src/index.ts new test-app
./src/index.ts ship

# With debug output
./src/index.ts --debug ship

# Disable telemetry for testing
JACK_TELEMETRY_DISABLED=1 ./src/index.ts ship
```

## Code Style

- TypeScript with Bun runtime
- Use `biome` for formatting: `bun run biome check --write .`
- Prefer explicit types over inference for public APIs
- Follow existing patterns in the codebase
- **User-facing output**: Use jargon-free terms (deployed/undeployed, database, cloud backup) unless user is configuring specific infra. Don't use Lambda, Workers, RDS, H100, D1, R2 etc.

## Prompts (IMPORTANT)

**Always use the custom prompts from `src/lib/hooks.ts`** - never use `@clack/prompts` select/confirm directly.

### Available Functions

```typescript
import { promptSelect, promptSelectValue, isCancel } from "../lib/hooks.ts";
```

| Function | Returns | Use Case |
|----------|---------|----------|
| `promptSelect(options, message?)` | index (0-based) or -1 | Simple choices, Yes/No |
| `promptSelectValue(message, options)` | value or cancel symbol | When you need the actual value |

### Style

Clean bullet-point style with number hints (no vertical bars):
```
Pick an option:
● 1. Open in browser
○ 2. Skip
```

### Interaction

Supports **both**:
- Number keys (1, 2, 3...) for immediate selection
- Arrow keys (↑/↓) + Enter for navigation
- Esc or Ctrl+C to cancel

### Patterns

**Yes/No (replaces confirm):**
```typescript
const choice = await promptSelect(["Yes", "No"], "Continue?");
if (choice !== 0) return; // cancelled or "No"
```

**Dangerous operations:**
```typescript
const choice = await promptSelect(
    ["Yes, delete", "No, cancel"],
    `Delete database '${name}'?`
);
if (choice !== 0) {
    info("Cancelled");
    return;
}
```

**Select with values:**
```typescript
const action = await promptSelectValue("What would you like to do?", [
    { value: "save", label: "Save to jack", hint: "recommended" },
    { value: "paste", label: "Paste additional secrets" },
    { value: "skip", label: "Skip for now" },
]);

if (isCancel(action) || action === "skip") return;
```

**String array shorthand:**
```typescript
const template = await promptSelectValue("Select a template:", [
    "miniapp",
    "api",
    "simple-api-starter",
]);
```

### DON'T Use

- `@clack/prompts` select() - has vertical bars, arrow-only
- `@clack/prompts` confirm() - different style, less flexible
- `@inquirer/prompts` - different library entirely

## MCP Server

jack includes a bundled MCP (Model Context Protocol) server for AI agent integration. This allows Claude Code and Claude Desktop to use jack programmatically.

### Automatic Setup

MCP configs are installed automatically during `jack init` to all detected IDEs (currently Claude Code and Claude Desktop).

### Manual Server Start

```bash
jack mcp serve              # Uses current directory
jack mcp serve --project /path/to/app  # Explicit project path
```

### Available MCP Tools

| Tool | CLI Equivalent | Description |
|------|----------------|-------------|
| `create_project` | `jack new` | Create and deploy a new project |
| `deploy_project` | `jack ship` | Deploy current project |
| `get_project_status` | `jack info` | Get deployment state, URL, last deploy time |
| `list_projects` | `jack ls` | List all projects from registry |
| `create_database` | `jack services db create` | Create D1 database |
| `list_databases` | `jack services db list` | List project databases |
| `execute_sql` | `jack services db execute` | Execute SQL queries |
| `create_vectorize_index` | `jack services vectorize create` | Create vector index |
| `list_vectorize_indexes` | `jack services vectorize list` | List project indexes |
| `delete_vectorize_index` | `jack services vectorize delete` | Delete index |
| `get_vectorize_info` | `jack services vectorize info` | Get index metadata |
| `create_storage_bucket` | `jack services storage create` | Create R2 bucket |
| `list_storage_buckets` | `jack services storage list` | List project buckets |
| `delete_storage_bucket` | `jack services storage delete` | Delete bucket |
| `get_storage_info` | `jack services storage info` | Get bucket info |
| `start_log_session` | `jack logs` | Start real-time log session |
| `tail_logs` | `jack logs` | Collect log samples |

**Missing MCP tools (CLI-only):**
- `jack domain connect/assign/unassign/disconnect` - custom domain management
- `jack domains` - list all domains
- `jack secrets` - manage project secrets

### Available MCP Resources

| Resource | Description |
|----------|-------------|
| `agents://context` | Returns AGENTS.md and CLAUDE.md content |

### Response Format

All MCP tools return structured JSON:
```json
{
  "success": true,
  "data": { ... },
  "meta": { "duration_ms": 1234, "jack_version": "0.1.0" }
}
```

### Telemetry

MCP tool invocations are tracked with `platform: 'mcp'` to distinguish from CLI usage.
