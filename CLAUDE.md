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

## Code Style

- TypeScript with Bun runtime
- Use `biome` for formatting: `bun run lint` / `bun run format`
- Prefer explicit types over inference for public APIs
- Follow existing patterns in the codebase
