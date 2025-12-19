# Jack CLI - Agent Context

## Project Overview

jack is a CLI tool for vibecoders to rapidly deploy to Cloudflare Workers. Read `docs/SPIRIT.md` for the philosophy.

## Key Directories

```
src/
├── index.ts           # CLI entry point and command router
├── commands/          # Command implementations
└── lib/               # Shared utilities (config, telemetry, etc.)

docs/
├── SPIRIT.md          # Philosophy and design principles
├── PRD-*.md           # Product requirement documents
└── telemetry-events.md # Event registry (when created)

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
- **Prompts**: Use `select()` with "1. Yes" / "2. No" choices, show "Esc to skip" hint. Not Y/n confirms.

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

| Tool | Description |
|------|-------------|
| `create_project` | Create and deploy a new project (wraps `jack new`) |
| `deploy_project` | Deploy current project (wraps `jack ship`) |
| `get_project_status` | Get deployment state, URL, last deploy time |
| `list_projects` | List all projects from registry |

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
