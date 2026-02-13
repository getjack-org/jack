# Remote MCP Server — Implementation Plan

## Status: Ready for Implementation | Feb 2026

## What We're Building

A stateless Cloudflare Worker at `mcp.getjack.org/mcp` that:

- Speaks MCP over **Streamable HTTP** (no Durable Objects)
- Authenticates via **existing API tokens** (`jkt_*`) — zero new auth code
- Deploys raw source code with **npm import support** (esbuild-wasm + esm.sh CDN resolution)
- Proxies reads (list projects, status, logs) to **existing control plane APIs**

No control plane changes. No new auth system. The MCP worker is a thin, stateless proxy that adds one new capability: in-worker bundling via esbuild-wasm.

-----

## Architecture

```
Client (Claude Code, Codex CLI, Cursor, etc.)
  │
  │  POST https://mcp.getjack.org/mcp
  │  Authorization: Bearer jkt_abc123...
  │  Content-Type: application/json
  │  Body: { "jsonrpc": "2.0", "method": "tools/call", ... }
  │
  ▼
┌─────────────────────────────────────────────┐
│  MCP Worker (apps/mcp-worker)               │
│  Stateless Hono + WebStandardStreamableHTTPServerTransport │
│                                             │
│  ┌─ Tools ────────────────────────────┐     │
│  │ deploy_from_code    (bundle+deploy)│     │
│  │ deploy_from_template (prebuilt)    │     │
│  │ list_projects       (read)        │     │
│  │ get_project_status  (read)        │     │
│  │ get_logs            (read)        │     │
│  └────────────────────────────────────┘     │
│                                             │
│  ┌─ Bundler (esbuild-wasm) ──────────┐     │
│  │ Virtual FS plugin (files from JSON)│     │
│  │ CDN plugin (esm.sh for npm pkgs)  │     │
│  │ Output: single bundled JS         │     │
│  └────────────────────────────────────┘     │
│                                             │
│  Forward Bearer token to control plane ──────┼──►
└─────────────────────────────────────────────┘
                                                │
                                                ▼
                                    ┌───────────────────┐
                                    │  Control Plane     │
                                    │  (unchanged)       │
                                    │                    │
                                    │  POST /v1/projects │
                                    │  POST ../upload    │
                                    │  GET  /v1/projects │
                                    │  GET  ../latest    │
                                    │  POST ../logs/...  │
                                    └───────────────────┘
```

-----

## Auth Strategy

**Zero new auth code.** The MCP worker extracts the `Authorization: Bearer <token>` header from the HTTP request and forwards it verbatim to control plane API calls. The control plane's existing `verifyAuth()` handles both token types:

- `jkt_*` prefix → API token lookup (SHA-256 hash in D1)
- Anything else → WorkOS JWT verification (JWKS)

**Client configuration examples:**

```bash
# Claude Code CLI
claude mcp add --transport http jack-cloud https://mcp.getjack.org/mcp \
  --header "Authorization: Bearer jkt_abc123..."

# Codex CLI (config.toml)
[mcp_servers.jack]
url = "https://mcp.getjack.org/mcp"
bearer_token_env_var = "JACK_API_TOKEN"

# Cursor/Windsurf (via mcp-remote)
npx mcp-remote https://mcp.getjack.org/mcp --header "Authorization: Bearer jkt_abc123..."
```

Users generate tokens with `jack tokens create "my-mcp-token"` (already exists).

-----

## File Structure

```
apps/mcp-worker/
├── src/
│   ├── index.ts              # Hono app + MCP transport setup
│   ├── types.ts              # CF Worker bindings type
│   ├── server.ts             # McpServer creation + tool registration
│   ├── control-plane.ts      # Thin API client (auth pass-through)
│   ├── bundler.ts            # esbuild-wasm wrapper + plugins
│   └── tools/
│       ├── deploy-code.ts    # deploy_from_code implementation
│       ├── deploy-template.ts # deploy_from_template implementation
│       ├── projects.ts       # list_projects, get_project_status
│       └── logs.ts           # get_logs implementation
├── wrangler.toml
├── package.json
└── tsconfig.json
```

**Changes to existing files:**
- `package.json` (root): Add `dev:mcp` and `deploy:mcp` scripts

**No control plane changes.** The MCP worker calls existing endpoints with existing artifact formats.

-----

## Tools

### 1. `deploy_from_code`

Deploy raw source files to Jack Cloud. Handles npm imports via server-side bundling.

```typescript
// Input schema
{
  files: Record<string, string>,       // { "src/index.ts": "import { Hono }...", ... }
  project_name?: string,               // Optional name (auto-generated if omitted)
  project_id?: string,                 // Existing project ID (for redeployment)
  compatibility_flags?: string[],      // e.g. ["nodejs_compat"]
}

// Example call from LLM
deploy_from_code({
  files: {
    "src/index.ts": "import { Hono } from 'hono';\nconst app = new Hono();\napp.get('/', c => c.json({ hello: 'world' }));\nexport default app;",
    "package.json": "{\"dependencies\":{\"hono\":\"^4.6.0\"}}"
  },
  project_name: "my-api"
})

// Returns
{
  success: true,
  data: {
    project_id: "prj_abc123",
    deployment_id: "dep_def456",
    url: "https://user-my-api.runjack.xyz",
    status: "live"
  }
}
```

**Internal flow:**

1. Parse `files` JSON → in-memory virtual filesystem
2. Detect entrypoint: look for `src/index.ts`, `src/index.js`, `index.ts`, `index.js`, or `main` field in package.json
3. Run esbuild-wasm:
   - Virtual FS plugin serves files from the JSON input
   - CDN plugin resolves bare imports (`"hono"` → `https://esm.sh/hono@4.6.0`) using esm.sh
   - If `package.json` exists, read version pins from `dependencies`
   - Output: single bundled ESM JavaScript string
4. Create `manifest.json`:
   ```json
   {
     "version": 1,
     "entrypoint": "worker.js",
     "compatibility_date": "2024-12-01",
     "compatibility_flags": ["nodejs_compat"],
     "module_format": "esm",
     "built_at": "2026-02-13T...",
     "bindings": {}
   }
   ```
5. Create `bundle.zip` in-memory using `fflate` (already used in the repo) containing `worker.js`
6. If `project_id` is provided, use it. Otherwise create project via `POST /v1/projects`
7. Upload via `POST /v1/projects/:id/deployments/upload` (multipart: manifest + bundle)
8. Return deployed URL

**Supported packages (verified with esm.sh):**

These are ESM-native, Workers-compatible packages — the bread and butter of the vibecoder target:

| Package | Used in template | Works with esm.sh |
|---------|:----------------:|:------------------:|
| `hono` | api | Yes |
| `hono/cors` | api | Yes |
| `zod` | — | Yes |
| `itty-router` | — | Yes |
| `drizzle-orm` | — | Yes |

Packages that WON'T work (Node.js native, CommonJS): Express, Next.js, Prisma. These don't run on Workers anyway.

### 2. `deploy_from_template`

Deploy a builtin Jack template with optional env var overrides.

```typescript
// Input schema
{
  template: string,          // e.g. "api", "hello", "miniapp"
  project_name?: string,     // Optional
  env_vars?: Record<string, string>,  // Optional env var overrides
}

// Example
deploy_from_template({ template: "api", project_name: "my-backend" })
```

**Internal flow:**

1. Create project via `POST /v1/projects` with `use_prebuilt: true, template: "api"`
2. Control plane handles everything (fetches prebuilt from R2, deploys)
3. Return URL

### 3. `list_projects`

```typescript
// Input: {} (no params)
// Calls: GET /v1/projects
// Returns: array of { id, name, slug, url, status, last_deployed_at }
```

### 4. `get_project_status`

```typescript
// Input: { project_id: string }
// Calls: GET /v1/projects/:id + GET /v1/projects/:id/deployments/latest
// Returns: { id, name, url, status, last_deployment, resources }
```

### 5. `get_logs`

```typescript
// Input: { project_id: string }
// Calls: POST /v1/projects/:id/logs/session → GET stream URL
// Returns: { log_entries: string[] }
```

-----

## Implementation Details

### Entry Point (`src/index.ts`)

Hono app with a single `/mcp` route that delegates to WebStandardStreamableHTTPServerTransport:

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "./server.ts";
import type { Bindings } from "./types.ts";

const app = new Hono<{ Bindings: Bindings }>();

app.use("/*", cors());

app.get("/", (c) => c.json({ service: "jack-mcp", status: "ok" }));

// MCP endpoint — stateless, one transport per request
app.post("/mcp", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }
  const token = authHeader.slice(7);

  const server = new McpServer({ name: "jack", version: "1.0.0" });
  registerTools(server, token, c.env);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,  // Stateless — no session tracking
  });

  await server.connect(transport);

  const body = await c.req.json();
  // Adapt Hono request/response to transport
  const response = await transport.handleRequest(body);
  return c.json(response);
});

// MCP spec: GET and DELETE return 405 for stateless servers
app.get("/mcp", (c) => c.json({ error: "Method not allowed" }, 405));
app.delete("/mcp", (c) => c.json({ error: "Method not allowed" }, 405));

export default app;
```

> Note: The exact transport.handleRequest() API may differ from this pseudocode — the implementation will follow the SDK's actual interface for Workers. The key point: one McpServer + WebStandardStreamableHTTPServerTransport per request, no shared state.

### Bundler (`src/bundler.ts`)

esbuild-wasm with two plugins:

```typescript
import * as esbuild from "esbuild-wasm";
import esbuildWasm from "esbuild-wasm/esbuild.wasm";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await esbuild.initialize({ wasmModule: esbuildWasm, worker: false });
    initialized = true;
  }
}

export async function bundleCode(
  files: Record<string, string>,
  packageJson?: { dependencies?: Record<string, string> }
): Promise<string> {
  await ensureInitialized();

  const result = await esbuild.build({
    entryPoints: [detectEntrypoint(files)],
    bundle: true,
    format: "esm",
    platform: "browser",    // Closest to Workers runtime
    target: "es2022",
    write: false,
    plugins: [
      virtualFsPlugin(files),
      esmShPlugin(packageJson?.dependencies ?? {}),
    ],
  });

  return result.outputFiles[0].text;
}
```

**Virtual FS plugin** — serves files from the in-memory map:

```typescript
function virtualFsPlugin(files: Record<string, string>): esbuild.Plugin {
  return {
    name: "virtual-fs",
    setup(build) {
      // Resolve relative imports to virtual paths
      build.onResolve({ filter: /^\./ }, (args) => {
        const resolved = resolvePath(args.resolveDir, args.path);
        if (files[resolved]) return { path: resolved, namespace: "virtual" };
        // Try with extensions
        for (const ext of [".ts", ".js", ".tsx", ".jsx"]) {
          if (files[resolved + ext]) return { path: resolved + ext, namespace: "virtual" };
        }
        return null;
      });

      build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => {
        return {
          contents: files[args.path],
          loader: args.path.endsWith(".ts") ? "ts"
                : args.path.endsWith(".tsx") ? "tsx"
                : args.path.endsWith(".json") ? "json"
                : "js",
        };
      });
    },
  };
}
```

**esm.sh CDN plugin** — resolves bare npm specifiers:

```typescript
function esmShPlugin(deps: Record<string, string>): esbuild.Plugin {
  return {
    name: "esm-sh",
    setup(build) {
      // Resolve bare specifiers (e.g., "hono", "zod")
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        // Skip node: builtins
        if (args.path.startsWith("node:")) {
          return { path: args.path, external: true };
        }

        // Get package name (handle scoped packages)
        const parts = args.path.split("/");
        const pkgName = args.path.startsWith("@")
          ? `${parts[0]}/${parts[1]}`
          : parts[0];
        const subpath = args.path.startsWith("@")
          ? parts.slice(2).join("/")
          : parts.slice(1).join("/");

        // Use pinned version from package.json if available
        const version = deps[pkgName] || "latest";
        const cleanVersion = version.replace(/^[\^~]/, "");

        let url = `https://esm.sh/${pkgName}@${cleanVersion}`;
        if (subpath) url += `/${subpath}`;

        return { path: url, namespace: "cdn" };
      });

      // Fetch from CDN
      build.onLoad({ filter: /.*/, namespace: "cdn" }, async (args) => {
        const response = await fetch(args.path);
        const contents = await response.text();
        return { contents, loader: "js" };
      });

      // Resolve imports within CDN-fetched code
      build.onResolve({ filter: /.*/, namespace: "cdn" }, (args) => {
        if (args.path.startsWith("https://")) {
          return { path: args.path, namespace: "cdn" };
        }
        // Relative import within CDN module
        const url = new URL(args.path, args.importer);
        return { path: url.href, namespace: "cdn" };
      });
    },
  };
}
```

### Control Plane Client (`src/control-plane.ts`)

Thin fetch wrapper that forwards the auth token:

```typescript
const CONTROL_URL = "https://control.getjack.org";

export class ControlPlaneClient {
  constructor(private token: string) {}

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${CONTROL_URL}/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  }

  async createProject(name: string, slug?: string) { /* POST /v1/projects */ }
  async createProjectWithPrebuilt(name: string, template: string, slug?: string) { /* POST /v1/projects with use_prebuilt */ }
  async listProjects() { /* GET /v1/projects */ }
  async getProject(projectId: string) { /* GET /v1/projects/:id */ }
  async getLatestDeployment(projectId: string) { /* GET /v1/projects/:id/deployments/latest */ }
  async uploadDeployment(projectId: string, manifest: object, bundleZip: Uint8Array) { /* POST multipart */ }
  async startLogSession(projectId: string) { /* POST /v1/projects/:id/logs/session */ }
}
```

### Wrangler Config (`wrangler.toml`)

```toml
name = "jack-mcp"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

routes = [
  { pattern = "mcp.getjack.org", custom_domain = true }
]

# WASM modules need special handling
[rules]
{ type = "CompiledWasm", globs = ["**/*.wasm"] }
```

No bindings to D1, R2, KV, or Dispatch needed. All state lives in the control plane.

### Package Dependencies (`package.json`)

```json
{
  "name": "@getjack/mcp-worker",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.25.1",
    "esbuild-wasm": "^0.25.0",
    "fflate": "^0.8.2",
    "hono": "^4.6.0",
    "zod": "^4.2.1"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241205.0",
    "typescript": "^5.0.0"
  }
}
```

-----

## Testing Plan

### Prerequisites

```bash
# Generate an API token for testing
jack tokens create "mcp-test"
# → jkt_abc123... (save this)

export JACK_TOKEN="jkt_abc123..."
export MCP_URL="http://localhost:8787/mcp"  # local dev
# export MCP_URL="https://mcp.getjack.org/mcp"  # production
```

### Test 1: Health Check (no auth)

```bash
curl -s http://localhost:8787/ | jq .
# Expected: { "service": "jack-mcp", "status": "ok" }
```

### Test 2: MCP Initialize

```bash
curl -s -X POST $MCP_URL \
  -H "Authorization: Bearer $JACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "test", "version": "1.0.0" }
    }
  }' | jq .
# Expected: { "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": "...", "serverInfo": { "name": "jack" }, "capabilities": { "tools": {} } } }
```

### Test 3: List Tools

```bash
curl -s -X POST $MCP_URL \
  -H "Authorization: Bearer $JACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }' | jq '.result.tools[].name'
# Expected: "deploy_from_code", "deploy_from_template", "list_projects", "get_project_status", "get_logs"
```

### Test 4: List Projects

```bash
curl -s -X POST $MCP_URL \
  -H "Authorization: Bearer $JACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "list_projects",
      "arguments": {}
    }
  }' | jq .
# Expected: { "jsonrpc": "2.0", "id": 3, "result": { "content": [{ "type": "text", "text": "..." }] } }
```

### Test 5: Deploy from Template

```bash
curl -s -X POST $MCP_URL \
  -H "Authorization: Bearer $JACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "deploy_from_template",
      "arguments": {
        "template": "hello",
        "project_name": "mcp-test-hello"
      }
    }
  }' | jq .
# Expected: deployed URL in response
```

### Test 6: Deploy Hello World (no npm imports)

```bash
curl -s -X POST $MCP_URL \
  -H "Authorization: Bearer $JACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "deploy_from_code",
      "arguments": {
        "files": {
          "src/index.ts": "export default { async fetch() { return new Response(JSON.stringify({ message: \"Hello from remote MCP!\" }), { headers: { \"Content-Type\": \"application/json\" } }); } };"
        },
        "project_name": "mcp-test-raw"
      }
    }
  }' | jq .
# Expected: deployed URL
# Verify: curl <deployed-url>
```

### Test 7: Deploy API Template Code (with Hono import)

This is the key test — validates esbuild-wasm + esm.sh CDN resolution:

```bash
curl -s -X POST $MCP_URL \
  -H "Authorization: Bearer $JACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 6,
    "method": "tools/call",
    "params": {
      "name": "deploy_from_code",
      "arguments": {
        "files": {
          "src/index.ts": "import { Hono } from \"hono\";\nimport { cors } from \"hono/cors\";\n\nconst app = new Hono();\napp.use(\"/*\", cors());\napp.get(\"/\", (c) => c.json({ message: \"Hello from Hono via remote MCP!\" }));\napp.get(\"/health\", (c) => c.json({ status: \"ok\" }));\nexport default app;",
          "package.json": "{\"dependencies\":{\"hono\":\"^4.6.0\"}}"
        },
        "project_name": "mcp-test-hono"
      }
    }
  }' | jq .
# Expected: deployed URL
# Verify: curl <deployed-url>
# Verify: curl <deployed-url>/health
```

### Test 8: Get Project Status

```bash
# Use project_id from Test 7 response
curl -s -X POST $MCP_URL \
  -H "Authorization: Bearer $JACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 7,
    "method": "tools/call",
    "params": {
      "name": "get_project_status",
      "arguments": {
        "project_id": "<PROJECT_ID_FROM_TEST_7>"
      }
    }
  }' | jq .
```

### Test 9: Auth Failure (no token)

```bash
curl -s -X POST $MCP_URL \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq .
# Expected: 401 { "error": "Missing Authorization header" }
```

### Test 10: Auth Failure (bad token)

```bash
curl -s -X POST $MCP_URL \
  -H "Authorization: Bearer jkt_invalid_token" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq .
# Expected: Error response (control plane returns 401, tool returns error)
```

### Test 11: End-to-end with Claude Code

```bash
# Add remote MCP server
claude mcp add --transport http jack-cloud https://mcp.getjack.org/mcp \
  --header "Authorization: Bearer $JACK_TOKEN"

# Then in a Claude Code session, ask:
# "Use jack-cloud to deploy a simple hello world API with Hono"
```

-----

## Implementation Phases

### Phase 1: Scaffold + Read-Only Tools

1. Create `apps/mcp-worker/` directory structure
2. Set up `package.json`, `wrangler.toml`, `tsconfig.json`
3. Implement `src/index.ts` — Hono app with MCP transport
4. Implement `src/control-plane.ts` — API client with auth pass-through
5. Implement `list_projects` and `get_project_status` tools
6. Add root workspace scripts (`dev:mcp`, `deploy:mcp`)

**Validates:** MCP protocol works, auth pass-through works, stateless transport works.
**Test:** curl tests 1-4, 9-10.

### Phase 2: Bundler + deploy_from_code

1. Implement `src/bundler.ts` — esbuild-wasm with virtual FS + esm.sh plugins
2. Implement `deploy_from_code` tool — bundle → zip → upload
3. Handle project creation (new project) and redeployment (existing project_id)

**Validates:** esbuild-wasm works in CF Worker, esm.sh CDN resolution works, bundled code deploys and runs.
**Test:** curl tests 5-8.

### Phase 3: Template Deploy + Logs

1. Implement `deploy_from_template` tool — delegates to control plane prebuilt path
2. Implement `get_logs` tool — start session + fetch entries

**Validates:** Prebuilt templates deploy via remote MCP, log streaming works.
**Test:** curl test 5, plus manual log checks.

-----

## Tradeoffs

| Decision | Chose | Over | Why |
|---|---|---|---|
| Build location | In MCP worker (esbuild-wasm) | In control plane | No control plane changes. MCP worker is new, small, purpose-built. Control plane is 176KB — risky to touch. |
| Transport | Stateless StreamableHTTP | MCPAgent (DO-based) | No DOs, no session state, simpler. Matches existing worker patterns in the repo. |
| Auth | Pass-through Bearer token | Own auth layer | Zero new code. Existing `jkt_*` tokens work. Control plane already verifies. |
| npm resolution | esm.sh CDN | npm install (Sandbox) | No Sandbox/DO needed. Works for Workers-ecosystem packages. Covers 90% of vibecoder use case. |
| Zip creation | fflate (in-memory) | archiver (filesystem) | fflate already in the repo, works in Workers (no FS needed). |
| Worker size | ~3MB (esbuild-wasm) | Smaller without bundler | Acceptable for a non-edge-latency-critical worker. Builds happen infrequently. |

-----

## Known Limitations (MVP)

1. **No npm install** — CDN resolution only. Packages with complex transitive dependency trees or CommonJS-only builds may fail. Mitigation: error message suggests using `deploy_from_template` or local MCP instead.

2. **No asset handling** — `deploy_from_code` doesn't support static assets (HTML/CSS/images). It produces a single Worker JS file. Vite/NextJS apps need the local MCP or a future Sandbox-based build.

3. **No D1/R2/KV bindings** — Code deployed via `deploy_from_code` gets no bindings. To add database support, the user would need to create resources via `jack services` locally. Future: add `bindings` param to `deploy_from_code`.

4. **No git deploy** — `deploy_from_repo` requires cloning and building, which needs the Sandbox SDK (Phase 2+).

5. **Single-file output** — esbuild produces one bundled JS file. WASM modules or multi-file workers aren't supported via this path.

-----

## Future Phases (Not in This PR)

- **Sandbox SDK build service** — For full `npm install` + native esbuild. Covers complex projects.
- **OAuth for ChatGPT** — `workers-oauth-provider` with WorkOS upstream IdP.
- **`deploy_from_repo`** — Git clone + build via Sandbox.
- **Binding management** — Create D1/R2/KV via remote MCP tools.
- **Streaming deploy logs** — SSE notifications during build/deploy.
