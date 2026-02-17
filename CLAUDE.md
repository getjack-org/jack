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

**Single deploy path:** All deployments (code uploads AND prebuilt templates) go through `createCodeDeployment()` in the deployment service. The prebuilt path (`deployFromPrebuiltTemplate`) fetches artifacts from R2 and feeds them into `createCodeDeployment`. Do NOT add deploy steps (schema, secrets, cache refresh, etc.) outside of `createCodeDeployment` — that's how prebuilt deploys previously missed schema application.

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

## Templates & Prebuilt Bundles

### Single Source of Truth

The canonical template list is `BUILTIN_TEMPLATES` in `apps/cli/src/templates/index.ts`. Everything else derives from it:

- **Prebuild script** (`scripts/prebuild-templates.ts`) imports `BUILTIN_TEMPLATES` and filters to templates with a directory in `apps/cli/templates/`
- **Control plane** has no template list — it constructs the R2 key from the template name + CLI version the client sends (`bundles/jack/{template}-v{version}/`) and fails if not found
- **CLI** sends `use_prebuilt: true` when `templateOrigin.type === "builtin"`

### Adding a New Template

1. Create `apps/cli/templates/{name}/` with source files, `wrangler.jsonc`, `.jack.json`
2. Add `"{name}"` to `BUILTIN_TEMPLATES` in `apps/cli/src/templates/index.ts`
3. Run `bun run scripts/prebuild-templates.ts` to build + upload to R2
4. That's it — prebuild script picks it up automatically, control plane serves it by R2 key

### Rebuilding Templates

After changing any template source, rebuild to update the prebuilt bundles in R2:

```bash
bun run scripts/prebuild-templates.ts
```

This builds all templates locally (install deps, wrangler build, package) and uploads bundle.zip, source.zip, assets.zip, manifest.json to R2. The `source.zip` enables forking from prebuilt templates.

### Template Metadata (`.jack.json`)

Each template has a `.jack.json` with `agentContext.summary` and `agentContext.full_text` that get injected into generated AGENTS.md files. Keep these free of infrastructure branding (no "Cloudflare Workers") — use "jack" or generic terms instead, so AI agents don't reach for wrangler.

## Commit Messages

Use conventional commit prefixes. These are parsed automatically to generate release notes.

| Prefix | When to use | Example |
|--------|------------|---------|
| `feat:` | New feature or capability | `feat: add API token auth for headless environments` |
| `fix:` | Bug fix | `fix: whoami with token-only auth` |
| `docs:` | Documentation only | `docs: document template architecture in CLAUDE.md` |
| `refactor:` | Code change that neither fixes a bug nor adds a feature | `refactor: extract deploy upload into shared service` |
| `chore:` | Build, CI, deps, or other maintenance | `chore: update biome to v1.9` |

Rules:
- Prefix is **required** on every commit. The publish workflow groups them into release notes.
- Keep the subject line under 72 characters.
- Use imperative mood: "add", "fix", "update" — not "added", "fixes", "updates".
- Optional scope: `fix(mcp): stdout corruption` — use when the change is scoped to one area.
- Body is optional. Use it for the "why" when the subject isn't enough.

## Code Style

- TypeScript with Bun runtime
- Use `biome` for formatting: `bun run lint` / `bun run format`
- Prefer explicit types over inference for public APIs
- Follow existing patterns in the codebase

## Docs

- Avoid inline comments in command/code blocks; keep snippets copy/pasteable and put explanations in surrounding text.

## Planning Meta-Learning

**Before implementing complex integrations with external systems, validate assumptions about their semantics.**

We assumed Cloudflare's `active` status meant "domain is working" when it actually only means "SSL cert is ready". Always verify what external API statuses actually mean by checking official docs (use Exa MCP) before designing state machines around them. A design that trusts external signals without verification will break when those signals don't mean what you assumed.

**Before writing new utility logic, search for existing implementations first.**

The runjack.xyz URL construction (`https://{username}-{slug}.runjack.xyz`) was copy-pasted into 8+ files. When a field (`owner_username`) was added later, only new call sites got it — legacy projects hit the wrong URL. The fix was a single `buildManagedUrl()` function with fallback + backfill logic, but it required touching every call site.

Rules:
1. Before writing a helper, `grep` for similar patterns in the codebase — someone likely already solved it
2. If logic appears in 2+ places, extract it into a shared function immediately
3. Shared utilities belong in `apps/cli/src/lib/` (not inline in commands or MCP handlers)
4. Key shared utilities that already exist — use them instead of reimplementing:
   - `buildManagedUrl()` in `project-link.ts` — runjack.xyz URL construction
   - `findWranglerConfig()` in `wrangler-config.ts` — wrangler config path resolution (supports .jsonc, .json, .toml)
   - `parseJsonc()` in `jsonc.ts` — JSONC parsing (never use regex comment stripping)
   - `readProjectLink()` + `getDeployMode()` in `project-link.ts` — project link and deploy mode
