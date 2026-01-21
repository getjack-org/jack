# Jack Monorepo

## Structure

```
jack/
├── apps/
│   ├── cli/              # @getjack/jack CLI (npm published)
│   ├── auth-worker/      # Authentication service (Cloudflare Worker)
│   ├── control-plane/    # Control plane API (Cloudflare Worker)
│   └── dispatch-worker/  # Dispatch worker (Cloudflare Worker)
├── packages/
│   └── auth/             # Shared JWT verification middleware
├── docs/                 # Documentation site (vocs)
├── vocs.config.tsx       # Docs configuration
└── package.json          # Workspace root
```

## Workspaces

- **apps/cli**: The `jack` CLI tool (`@getjack/jack`) - see `apps/cli/CLAUDE.md` for detailed context
- **apps/auth-worker**: WorkOS device auth proxy at `auth.getjack.org`
- **apps/control-plane**: Control plane API at `control.getjack.org`
- **apps/dispatch-worker**: Dispatch worker for tenant Workers
- **packages/auth**: Shared `@getjack/auth` package for JWT middleware

## Commands

```bash
# Development
bun run dev:cli           # Run CLI locally
bun run dev:auth          # Run auth worker locally
bun run dev:control       # Run control plane locally
bun run dev:dispatch      # Run dispatch worker locally

# Or run directly
./apps/cli/src/index.ts --help

# Deployment
bun run deploy:auth       # Deploy auth worker
bun run deploy:control    # Deploy control plane
bun run deploy:dispatch   # Deploy dispatch worker

# Linting
bun run lint              # Check all packages
bun run format            # Format all packages
```

## Adding Dependencies

```bash
# Add to specific workspace
bun add -d typescript --cwd apps/auth-worker

# Add to root (shared dev deps)
bun add -d @biomejs/biome -w
```

## Package Links

Local packages use workspace protocol:
```json
"dependencies": {
  "@getjack/auth": "workspace:*"
}
```

## packages/auth

Shared JWT verification using WorkOS JWKS:

```typescript
import { authMiddleware } from "@getjack/auth";

// Use in Hono routes
app.use("/api/*", authMiddleware());

// Access user in handlers
app.get("/api/me", (c) => {
  const auth = c.get("auth"); // { userId, email, firstName, lastName }
  return c.json({ user: auth });
});
```

## Auth Worker Secrets

Set WorkOS API key for auth-worker:
```bash
wrangler secret put WORKOS_API_KEY --cwd apps/auth-worker
```

## CI/CD Notes

**npm Publishing (OIDC):** The publish workflow uses GitHub OIDC for npm authentication.
- `id-token: write` permission + `--provenance` flag = no NPM_TOKEN needed
- Do NOT add NODE_AUTH_TOKEN or NPM_TOKEN to the workflow
- This is more secure - publishes are cryptographically linked to the GitHub Actions run

**GitHub Secrets Required:**
- `CLOUDFLARE_API_TOKEN` - For deploying workers (Edit Workers + D1 permissions)

## Control Plane Deployment

When uploading Workers to Cloudflare's dispatch namespace, upload ALL files from the wrangler build output (JS + WASM + any modules) via FormData. When debugging API issues, check docs for fields implying unused capabilities - `main_module` existing in Cloudflare's metadata schema revealed multi-file upload support we weren't using.

## Jack MCP (for AI Agents)

**CRITICAL:** When Jack MCP is connected, always prefer `mcp__jack__*` tools over CLI commands or wrangler. MCP tools are cloud-aware and work with Jack Cloud mode where wrangler won't.

- Check your available tools for anything prefixed with `mcp__jack__`
- Use those instead of `jack` CLI commands or `wrangler` commands
- If a capability isn't available via MCP, ask the user to run it via CLI

## Deploy Mode: Managed vs BYO

Jack has two deploy modes that require different code paths:

- **managed** (Jack Cloud): Uses control plane APIs, user has Jack Cloud auth only
- **byo** (Bring Your Own): Uses wrangler CLI, user has Cloudflare auth

### Critical Pattern: Always Check Deploy Mode Before Calling Wrangler

**NEVER call wrangler commands unconditionally.** Managed mode users don't have Cloudflare credentials.

```typescript
// ❌ BAD - calls wrangler for all projects
const dbInfo = await getWranglerDatabaseInfo(dbName);

// ✅ GOOD - check deploy mode first
const link = await readProjectLink(projectDir);
if (link?.deploy_mode === "managed") {
  // Use control plane API
  const dbInfo = await getManagedDatabaseInfo(link.project_id);
} else {
  // BYO: use wrangler
  const dbInfo = await getWranglerDatabaseInfo(dbName);
}
```

### Where to Route by Deploy Mode

| Operation | Managed (Jack Cloud) | BYO (wrangler) |
|-----------|---------------------|----------------|
| DB info | `getManagedDatabaseInfo()` | `wrangler d1 info` |
| DB export | `exportManagedDatabase()` | `wrangler d1 export` |
| DB execute | Control plane proxy (TODO) | `wrangler d1 execute` |
| Worker status | Control plane API | `wrangler deployments list` |
| Project delete | `deleteManagedProject()` | `wrangler delete` |

### Testing Deploy Mode Isolation

Use `scripts/test-managed-mode-no-cf-auth.sh` to verify managed mode works without Cloudflare auth:
```bash
./scripts/test-managed-mode-no-cf-auth.sh /path/to/managed/project
```

This simulates a user who has Jack Cloud auth (`~/.config/jack/auth.json`) but no Cloudflare auth (`~/.wrangler/`).

## Code Style

- TypeScript with Bun runtime
- Use `biome` for formatting: `bun run lint` / `bun run format`
- Prefer explicit types over inference for public APIs
- Follow existing patterns in the codebase

## Docs

- Avoid inline comments in command/code blocks; keep snippets copy/pasteable and put explanations in surrounding text.
