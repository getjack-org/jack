# Jack MCP Server

This directory contains the Model Context Protocol (MCP) server implementation for jack CLI.

## Architecture

```
src/mcp/
├── server.ts              # Main MCP server setup and initialization
├── types.ts               # TypeScript types for MCP responses
├── utils.ts               # Response formatting utilities
├── tools/
│   └── index.ts          # Tool registration and handlers
└── resources/
    └── index.ts          # Resource registration (agents_md)
```

## Key Components

### `server.ts`
- Creates and configures the MCP server instance
- Registers tools and resources
- Exports `startMcpServer()` for stdio transport

### `tools/index.ts`
- Centralized tool registration and dispatch
- Implements 4 core tools:
  - `create_project` - Create new Cloudflare Workers project
  - `deploy_project` - Deploy existing project
  - `get_project_status` - Get project status info
  - `list_projects` - List all projects with filters
- Each tool wraps corresponding function from `lib/project-operations.ts`
- All tools track telemetry with `platform: 'mcp'`

### `resources/index.ts`
- Registers `agents://context` resource
- Reads and combines AGENTS.md and CLAUDE.md from project directory
- Provides AI agents with project-specific context

### `types.ts`
- Defines `McpToolResponse<T>` interface
- Enum of error codes for structured error handling
- `McpServerOptions` configuration interface

### `utils.ts`
- `formatSuccessResponse()` - Creates success response with metadata
- `formatErrorResponse()` - Classifies errors and provides suggestions
- `classifyMcpError()` - Maps error messages to error codes
- `getSuggestionForError()` - Returns actionable suggestions

## Response Format

All tools return structured JSON responses:

```typescript
{
  success: boolean
  data?: T
  error?: {
    code: string          // Machine-readable
    message: string       // Human-readable
    suggestion?: string   // Actionable next steps
  }
  meta?: {
    duration_ms: number
    jack_version: string
  }
}
```

## Integration with Project Operations

The MCP tools are thin wrappers around functions in `lib/project-operations.ts`:

- `createProject()` - Handles project creation with templates
- `deployProject()` - Manages builds and deployments
- `getProjectStatus()` - Fetches project status
- `listAllProjects()` - Lists all registered projects

All operations run in "silent mode" (no console output) when called from MCP.

## Telemetry

All tool calls are tracked via the existing telemetry system:

- Automatic tracking: `command_invoked`, `command_completed`, `command_failed`
- Business events: `project_created`, `deploy_started`
- All events tagged with `platform: 'mcp'`

## Development

### Running the Server

```bash
# Start server via CLI (uses stdio transport)
jack mcp serve

# With explicit project path
jack mcp serve --project /path/to/project

# The server communicates via stdin/stdout
# Do NOT use console.log in MCP code
```

### Adding New Tools

1. Add tool definition to `tools/list` handler in `tools/index.ts`
2. Add case to `tools/call` handler switch statement
3. Create zod schema for tool parameters
4. Wrap function from `project-operations.ts` with telemetry
5. Return formatted response using utils

### Testing

The MCP server can be tested using:
- Claude Desktop (see `/docs/mcp-configuration.md`)
- MCP Inspector (https://github.com/modelcontextprotocol/inspector)
- Manual JSON-RPC over stdio

## Error Handling

Errors are classified into categories:

- `AUTH_FAILED` - Authentication issues
- `WRANGLER_AUTH_EXPIRED` - Wrangler needs re-auth
- `PROJECT_NOT_FOUND` - Project doesn't exist
- `TEMPLATE_NOT_FOUND` - Invalid template
- `BUILD_FAILED` - Build errors
- `DEPLOY_FAILED` - Deployment errors
- `VALIDATION_ERROR` - Invalid parameters
- `INTERNAL_ERROR` - Unexpected failures

Each error code includes a helpful suggestion for resolution.

## Protocol Compliance

This implementation follows the MCP specification:
- Uses stdio transport for client communication
- Implements required handlers: `tools/list`, `tools/call`
- Implements optional handlers: `resources/list`, `resources/read`
- Returns properly formatted JSON-RPC responses
- Never writes to stdout except for protocol messages
