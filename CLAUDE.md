# Jack Monorepo

## Structure

```
jack/
├── apps/
│   ├── cli/              # @getjack/jack CLI (npm published)
│   ├── auth-worker/      # Authentication service (Cloudflare Worker)
│   └── api-worker/       # API service with D1 (Cloudflare Worker)
├── packages/
│   └── auth/             # Shared JWT verification middleware
├── docs/                 # Documentation site (vocs)
├── migrations/           # D1 database migrations
├── vocs.config.tsx       # Docs configuration
└── package.json          # Workspace root
```

## Workspaces

- **apps/cli**: The `jack` CLI tool (`@getjack/jack`) - see `apps/cli/CLAUDE.md` for detailed context
- **apps/auth-worker**: WorkOS device auth proxy at `auth.getjack.org`
- **apps/api-worker**: User API with D1 database at `api.getjack.org`
- **packages/auth**: Shared `@getjack/auth` package for JWT middleware

## Commands

```bash
# Development
bun run dev:cli           # Run CLI locally
bun run dev:auth          # Run auth worker locally
bun run dev:api           # Run API worker locally

# Or run directly
./apps/cli/src/index.ts --help

# Deployment
bun run deploy:auth       # Deploy auth worker
bun run deploy:api        # Deploy API worker

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

## API Worker D1 Setup

Before deploying api-worker:
```bash
# Create the D1 database
wrangler d1 create jack-api-db

# Update apps/api-worker/wrangler.toml with the database_id

# Apply migrations
bun run --cwd apps/api-worker db:migrate
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

## Code Style

- TypeScript with Bun runtime
- Use `biome` for formatting: `bun run lint` / `bun run format`
- Prefer explicit types over inference for public APIs
- Follow existing patterns in the codebase
