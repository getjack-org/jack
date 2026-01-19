# Agent Context

## Infrastructure

This project uses **jack** for deployment. When Jack MCP is connected, prefer `mcp__jack__*` tools over CLI commands - they're cloud-aware and faster.

**Do NOT use wrangler directly.** Jack manages config and may use cloud-hosted resources where wrangler won't work.

Common operations:
- **Deploy**: `jack ship` or Jack MCP
- **Database**: `jack services db create` or Jack MCP
- **Status**: `jack status` or Jack MCP

## SQL Execution

Jack supports secure SQL execution against D1 databases:

**Via MCP** (preferred for agents):
- `execute_sql({ sql: "SELECT * FROM users" })` - read queries work by default
- `execute_sql({ sql: "INSERT...", allow_write: true })` - writes require allow_write
- Destructive ops (DROP, TRUNCATE, ALTER) are blocked via MCP - use CLI

**Via CLI**:
- `jack services db execute "SELECT * FROM users"` - read queries
- `jack services db execute "INSERT..." --write` - write queries
- `jack services db execute "DROP TABLE..." --write` - prompts for typed confirmation
- `jack services db execute --file schema.sql --write` - run SQL from file

**Security notes**:
- Read-only by default to prevent accidental data modification
- Write operations require explicit `--write` flag or `allow_write: true`
- Destructive operations (DROP, TRUNCATE, ALTER, DELETE without WHERE) require CLI confirmation
- MCP results are wrapped with anti-injection headers to prevent prompt injection
