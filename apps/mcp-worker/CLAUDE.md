# MCP Worker (`mcp.getjack.org`)

Remote MCP server for AI agents (Claude Desktop, ChatGPT, Cursor, Claude Code). Deployed as a Cloudflare Worker.

## Architecture

```
MCP Client (Claude Desktop, etc.)
    └─ Tool calls ──→ POST /mcp (Bearer token) → MCP handler → Control Plane API
```

### Auth

Bearer token passed through to the control plane. The MCP worker itself does no token validation beyond checking the header exists -- the control plane handles auth.

### Files

```
src/
├── index.ts          # Hono app, Bearer auth check, MCP transport setup
├── server.ts         # MCP tool definitions (the "API surface" for LLMs)
├── types.ts          # Bindings
├── control-plane.ts  # ControlPlaneClient (HTTP client for control.getjack.org)
├── bundler.ts        # esbuild-wasm bundler for deploy_from_code
├── utils.ts          # Shared response helpers (ok/err)
└── tools/
    ├── deploy-code.ts    # Bundle + upload source files as a Worker
    ├── deploy-template.ts # Deploy prebuilt template via control plane
    ├── projects.ts       # list_projects, get_project_status
    ├── source.ts         # list_project_files, read_project_file
    ├── logs.ts           # get_logs
    ├── database.ts       # create_database, list_databases, execute_sql
    └── rollback.ts       # rollback_project
```

## Tools (10 total)

| Tool | Type | Description |
|------|------|-------------|
| `deploy` | write | Unified deploy: `files` for custom code, `template` for prebuilt apps |
| `list_projects` | read | List all user's projects with URLs |
| `get_project_status` | read | Deployment status, URL, resources for a project |
| `list_project_files` | read | File tree of deployed project's source |
| `read_project_file` | read | Read single source file from deployed project |
| `get_logs` | read | Start log session and collect entries |
| `create_database` | write | Create D1 database for a project |
| `list_databases` | read | List D1 databases for a project |
| `execute_sql` | write | Execute SQL against project's D1 database |
| `rollback_project` | write | Roll back to a previous deployment |

### The Deploy + Iterate Loop

This is the core workflow the tools enable:

```
1. User: "build me a weather API"
   → LLM calls deploy(files: {...})
   → Returns project_id + live URL

2. User: "add a /forecast endpoint"
   → LLM calls list_project_files(project_id) → sees current files
   → LLM calls read_project_file(project_id, "src/index.ts") → gets source
   → LLM modifies the code
   → LLM calls deploy(files: {...}, project_id) → redeploys

3. User: "something's broken"
   → LLM calls get_logs(project_id) → sees errors
   → LLM reads source, fixes, redeploys
```

Source is preserved across deploys (stored as source.zip in R2). Template-deployed projects can also be iterated on via code upload — the control plane doesn't restrict this.

### Tool Description Design Principles

Tool descriptions are critical — they're how the LLM decides which tool to use. Key rules (from Anthropic's "Writing effective tools for AI agents"):

1. **Include "when to use" guidance**, not just "what it does"
2. **Include "when NOT to use"** to prevent misuse (e.g., deploy description says "do NOT use a template" for simple websites)
3. **Use enum types** for constrained params (template names) to prevent hallucination
4. **Return actionable errors** with hints about what to do next
5. **Include URLs** in responses so the LLM can share them with the user

### Adding New Tools

1. Create handler in `src/tools/` using `ok()` and `err()` from `src/utils.ts`
2. Add corresponding method to `ControlPlaneClient` if needed
3. Register in `src/server.ts` with a clear description
4. Keep total tool count low (aim for <15) — each tool's schema consumes context window tokens

## Remote vs Local MCP Tool Parity

The remote MCP (this worker) has 10 tools. The local MCP (`apps/cli/src/mcp/`) has 27 tools. Gap:

| Category | Local MCP | Remote MCP | Notes |
|----------|-----------|------------|-------|
| Deploy/Projects | create_project, deploy_project, get_project_status, list_projects, rollback_project | deploy, list_projects, get_project_status, rollback_project | Remote merged create+deploy into `deploy` |
| Source | — | list_project_files, read_project_file | Remote-only (new) |
| Logs | start_log_session, tail_logs | get_logs | Remote merged into one |
| Database | create_database, list_databases, execute_sql | create_database, list_databases, execute_sql | Aligned |
| Vectorize | create/list/delete/get_vectorize_index | — | Not yet in remote |
| Storage | create/list/get/delete_storage_bucket | — | Not yet in remote |
| Domains | list/connect/assign/unassign/disconnect_domain | — | Not yet in remote |
| Crons | create/list/delete/test_cron | — | Not yet in remote |

Remaining gaps proxy to existing control plane endpoints, so adding them is straightforward. But per research: fewer tools = better LLM performance. Add on demand, not preemptively.

### Response Format

All tools use shared helpers from `src/utils.ts`:
- **Success**: `ok(data)` → `{ success: true, data }` (compact JSON, no pretty-printing)
- **Error**: `err(code, message, suggestion?)` → `{ success: false, error: { code, message, suggestion } }` with `isError: true`

Error codes: `VALIDATION_ERROR`, `BUNDLE_FAILED`, `SIZE_LIMIT`, `DEPLOY_FAILED`, `NOT_FOUND`, `NO_DATABASE`, `INTERNAL_ERROR`

This matches the local MCP's structured error format (`apps/cli/src/mcp/utils.ts`).

## Bindings

```bash
# Vars (in wrangler.toml)
CONTROL_PLANE_URL = "https://control.getjack.org"
```

## Deployment

```bash
cd /path/to/jack
wrangler deploy --cwd apps/mcp-worker
```

## Known Issues & Future Work

### Template Iteration UX
Template deploys (Next.js, SaaS) create projects with source.zip stored in R2. The MCP can read these files and redeploy with modifications via `deploy(files, project_id)`. However, the redeployed version becomes a raw Worker — it loses the template's build pipeline (OpenNext for Next.js). This is fine for simple edits but breaks for Next.js-specific features.

### URL Format
Project URLs follow `https://{owner_username}-{slug}.runjack.xyz`. The control plane returns this via the `url` field on project responses. Do NOT construct URLs manually — always use what the control plane returns.
