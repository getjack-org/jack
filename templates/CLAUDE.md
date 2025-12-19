# Template Development Guide

## Core Principles

1. **Omakase** - templates should be batteries-included, ready to use
2. **Templates are for user code, not jack's tools** - wrangler is jack's responsibility (installed globally), not the template's
3. **Ship a lockfile** - `bun.lock` provides 70% faster installs on cold cache

## Dependency Rules

### DO include in templates:
- Runtime dependencies the user's code needs (react, wagmi, viem)
- Framework connectors (@farcaster/miniapp-wagmi-connector)
- Build tools that transform user code (vite, typescript, tailwind)
- Type definitions for the target platform (@cloudflare/workers-types)

### DO NOT include in templates:
- Deployment tools (wrangler) - installed globally by `jack init`
- Dev tools that jack manages globally

## Performance Benchmarks

Target metrics (without wrangler in template):

| Metric | With wrangler | Without wrangler |
|--------|---------------|------------------|
| node_modules size | 1.6GB | ~800MB |
| Install time (cold + lockfile) | 12s | ~5s |

The key optimization: wrangler (450MB+) is installed globally by `jack init`, not per-project.

## Lockfile Management

Always ship `bun.lock` with templates:

```bash
# Generate/update lockfile
cd templates/miniapp
rm -rf node_modules bun.lock
bun install
# bun.lock is now ready to commit
```

The lockfile:
- Skips dependency resolution (major speedup)
- Ensures deterministic versions across machines
- Is text-based (reviewable in PRs)

## Testing Template Performance

Use the test script to measure impact of changes:

```bash
./test-lockfile-timing.sh
```

Before making dependency changes:
1. Note current install time
2. Make changes
3. Regenerate lockfile
4. Compare new install time

## Common Dependency Costs

Measured on miniapp template (2024-12):

| Package | Size | Notes |
|---------|------|-------|
| wrangler | 122MB | Global install only, never in template |
| @cloudflare/* | 330MB | Only include what's needed for build |
| wagmi + viem | ~800MB | Only if template uses wallet features |
| @farcaster/miniapp-sdk | 14MB | Includes @solana as transitive dep |
| react + react-dom | ~5MB | Reasonable |
| tailwindcss + vite plugin | ~15MB | Reasonable |

## Template Checklist

Before shipping a new template:

- [ ] No deployment tools in dependencies (wrangler, etc.)
- [ ] No unused optional features (wallet libs if not used)
- [ ] `bun.lock` generated and committed
- [ ] node_modules < 400MB
- [ ] Install time < 5s (cold cache + lockfile)
- [ ] All scripts work without global tools except wrangler
- [ ] `.gitignore` includes `.env`, `.dev.vars`, `.secrets.json`

## Placeholder System

All templates use **`jack-template`** as the universal placeholder. When a user runs `jack new my-app`, every occurrence of `jack-template` is replaced with `my-app`.

```
# In template files:
name = "jack-template"           → name = "my-app"
"database_name": "jack-template-db"  → "database_name": "my-app-db"
```

**Rules:**
- Use `jack-template` for project name in all files (wrangler.toml, package.json, etc.)
- Use `jack-template-db` for database names (replaced with `my-app-db`)
- The `-db` variant is replaced first to avoid partial matches
- No other placeholder syntax needed—just these two strings

**Why universal placeholder?**
- Templates are self-contained (no jack core changes needed)
- GitHub templates work automatically
- Simple string replacement, no complex parsing

## Hook System

Templates can define hooks in `.jack.json` that run at specific lifecycle points.

### Hook Lifecycle

```json
{
  "hooks": {
    "preDeploy": [...],   // Before wrangler deploy (validation)
    "postDeploy": [...]   // After successful deploy (notifications, testing)
  }
}
```

### Available Actions

| Action | Purpose | Example |
|--------|---------|---------|
| `message` | Print info message | `{"action": "message", "text": "Setting up..."}` |
| `box` | Display boxed message | `{"action": "box", "title": "Done", "lines": ["URL: {{url}}"]}` |
| `url` | Show URL (optional prompt/open) | `{"action": "url", "url": "{{url}}", "label": "Open site", "prompt": true}` |
| `clipboard` | Copy text to clipboard | `{"action": "clipboard", "text": "{{url}}", "message": "Copied!"}` |
| `shell` | Execute shell command | `{"action": "shell", "command": "curl {{url}}/health"}` |
| `pause` | Wait for Enter key | `{"action": "pause", "message": "Press Enter..."}` |
| `require` | Verify secret or env | `{"action": "require", "source": "secret", "key": "API_KEY"}` |

### Non-Interactive Mode

Hooks run in a non-interactive mode for MCP/silent execution. In this mode:

- `url` prints `Label: URL` (no prompt, no auto-open)
- `clipboard` prints the text (no clipboard access)
- `pause` is skipped
- `require` still validates; if `setupUrl` exists it prints `Setup: ...`
- `shell` runs with stdin ignored to avoid hangs

### Hook Variables

These variables are substituted at runtime (different from template placeholders):

| Variable | Value | Available in |
|----------|-------|--------------|
| `{{url}}` | Full deployed URL | postDeploy |
| `{{domain}}` | Domain without protocol | postDeploy |
| `{{name}}` | Project name | preDeploy, postDeploy |

### Example: API Template Hooks

```json
{
  "hooks": {
    "postDeploy": [
      {"action": "clipboard", "text": "{{url}}", "message": "URL copied"},
      {"action": "shell", "command": "curl -s {{url}}/health"},
      {"action": "box", "title": "{{name}}", "lines": ["{{url}}", "", "API is live!"]}
    ]
  }
}
```

### Example: Miniapp Template Hooks

```json
{
  "hooks": {
    "preDeploy": [
      {"action": "require", "source": "secret", "key": "NEYNAR_API_KEY", "setupUrl": "https://neynar.com"}
    ],
    "postDeploy": [
      {"action": "clipboard", "text": "{{url}}"},
      {"action": "box", "title": "Deployed: {{name}}", "lines": ["URL: {{url}}"]},
      {"action": "url", "url": "https://farcaster.xyz/.../manifest?domain={{domain}}", "label": "Generate manifest"},
      {"action": "url", "url": "https://farcaster.xyz/.../preview?url={{url}}", "label": "Preview"}
    ]
  }
}
```

## Adding New Templates

1. Create directory: `templates/my-template/`
2. Add `.jack.json` with metadata and hooks
3. Use `jack-template` placeholder in all files
4. Add all template files
5. Generate lockfile: `cd templates/my-template && bun install`
6. Test: `jack new test-project -t my-template`
7. Verify install time with `./test-lockfile-timing.sh`
