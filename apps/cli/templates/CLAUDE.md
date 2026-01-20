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

### Hook Schema (Quick Reference)

| Action | Required Fields | Non-Interactive Behavior |
|--------|------------------|--------------------------|
| `message` | `text` | Prints message |
| `box` | `title`, `lines` | Prints box |
| `url` | `url` | Prints label + URL |
| `clipboard` | `text` | Prints text |
| `pause` | _(none)_ | Skipped |
| `require` | `source`, `key` | Validates, prints setup if provided. Supports `onMissing: "prompt" \| "generate"` |
| `shell` | `command` | Runs with stdin ignored |
| `prompt` | `message` | Skipped. Supports `secret: true` for masked input, `validate`, `writeJson`, `deployAfter` |
| `writeJson` | `path`, `set` | Runs (safe in CI) |
| `stripe-setup` | `plans` | Creates Stripe products/prices, saves price IDs to secrets |

### Hook Lifecycle

```json
{
  "hooks": {
    "preCreate": [...],   // During project creation (secret collection, auto-generation)
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
| `require` | Verify secret/env, optionally prompt or generate | `{"action": "require", "source": "secret", "key": "API_KEY", "onMissing": "prompt"}` |
| `prompt` | Prompt for input, optionally masked | `{"action": "prompt", "message": "Secret:", "secret": true, "writeJson": {...}}` |
| `writeJson` | Update JSON file with template vars | `{"action": "writeJson", "path": "public/data.json", "set": {"siteUrl": "{{url}}"}}` |
| `stripe-setup` | Create Stripe products/prices | `{"action": "stripe-setup", "plans": [{"name": "Pro", "priceKey": "STRIPE_PRO_PRICE_ID", "amount": 1900, "interval": "month"}]}` |

### Non-Interactive Mode

Hooks run in a non-interactive mode for MCP/silent execution. In this mode:

- `url` prints `Label: URL` (no prompt, no auto-open)
- `clipboard` prints the text (no clipboard access)
- `pause` is skipped
- `require` still validates; if `setupUrl` exists it prints `Setup: ...`
- `prompt` is skipped
- `shell` runs with stdin ignored to avoid hangs
- `writeJson` still runs (non-interactive safe)

### Hook Variables

These variables are substituted at runtime (different from template placeholders):

| Variable | Value | Available in |
|----------|-------|--------------|
| `{{url}}` | Full deployed URL | postDeploy |
| `{{domain}}` | Domain without protocol | postDeploy |
| `{{name}}` | Project name | preCreate, preDeploy, postDeploy |

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
      {"action": "url", "url": "https://farcaster.xyz/.../manifest?domain={{domain}}", "label": "Sign manifest"},
      {"action": "writeJson", "path": "public/.well-known/farcaster.json", "set": {"miniapp.homeUrl": "{{url}}"}},
      {"action": "prompt", "message": "Paste accountAssociation JSON", "validate": "accountAssociation", "successMessage": "Saved domain association", "writeJson": {"path": "public/.well-known/farcaster.json", "set": {"accountAssociation": {"from": "input"}}}},
      {"action": "url", "url": "https://farcaster.xyz/.../preview?url={{url}}", "label": "Preview"}
    ]
  }
}
```

### Advanced Hook Features

These features support complex setup wizards (like the SaaS template with Stripe):

#### 1. `require` + `onMissing: "prompt" | "generate"`

The `require` action supports automatic secret collection when a secret is missing:

```json
{
  "action": "require",
  "source": "secret",
  "key": "STRIPE_SECRET_KEY",
  "onMissing": "prompt",
  "promptMessage": "Enter your Stripe Secret Key (sk_test_...):",
  "setupUrl": "https://dashboard.stripe.com/apikeys"
}
```

**Behavior:**
- If secret exists → continue (shows "Using saved KEY")
- If secret missing + interactive → prompt user, save to `.secrets.json`
- If secret missing + non-interactive → fail with setup instructions

**Auto-generate secrets with `onMissing: "generate"`:**

```json
{
  "action": "require",
  "source": "secret",
  "key": "BETTER_AUTH_SECRET",
  "message": "Generating authentication secret...",
  "onMissing": "generate",
  "generateCommand": "openssl rand -base64 32"
}
```

This runs the command, captures stdout, and saves it as the secret automatically.

#### 2. `stripe-setup` Action

Automatically creates Stripe products and prices, saving the price IDs as secrets:

```json
{
  "action": "stripe-setup",
  "message": "Setting up Stripe subscription plans...",
  "plans": [
    {
      "name": "Pro",
      "priceKey": "STRIPE_PRO_PRICE_ID",
      "amount": 1900,
      "interval": "month",
      "description": "Pro monthly subscription"
    },
    {
      "name": "Enterprise",
      "priceKey": "STRIPE_ENTERPRISE_PRICE_ID",
      "amount": 9900,
      "interval": "month"
    }
  ]
}
```

**Behavior:**
- Requires `STRIPE_SECRET_KEY` to be set first
- Checks for existing prices by lookup key (`jack_pro_month`)
- Creates product + price if not found
- Saves price IDs to secrets

#### 3. `prompt` with `secret` Flag

Mask sensitive input (like API keys):

```json
{
  "action": "prompt",
  "message": "Paste your webhook signing secret (whsec_...):",
  "secret": true,
  "writeJson": {
    "path": ".secrets.json",
    "set": { "STRIPE_WEBHOOK_SECRET": { "from": "input" } }
  }
}
```

#### 4. `prompt` with `deployAfter`

Automatically redeploy after user provides input:

```json
{
  "action": "prompt",
  "message": "Paste webhook signing secret:",
  "secret": true,
  "deployAfter": true,
  "deployMessage": "Deploying with webhook support...",
  "writeJson": {
    "path": ".secrets.json",
    "set": { "STRIPE_WEBHOOK_SECRET": { "from": "input" } }
  }
}
```

### Design Principles

When extending the hook system:

1. **Extend existing actions** - prefer `require+onMissing` over a new `requireOrPrompt` action
2. **Non-interactive fallback** - every interactive feature must degrade gracefully in CI/MCP
3. **Secrets via `.secrets.json`** - use `writeJson` with `.secrets.json` for secret storage

### Example: SaaS Template Setup Wizard

The `saas` template uses `preCreate` hooks for a complete setup wizard:

```json
{
  "hooks": {
    "preCreate": [
      {
        "action": "require",
        "source": "secret",
        "key": "STRIPE_SECRET_KEY",
        "message": "Stripe API key required for payments",
        "setupUrl": "https://dashboard.stripe.com/apikeys",
        "onMissing": "prompt",
        "promptMessage": "Enter your Stripe Secret Key (sk_test_... or sk_live_...):"
      },
      {
        "action": "require",
        "source": "secret",
        "key": "BETTER_AUTH_SECRET",
        "message": "Generating authentication secret...",
        "onMissing": "generate",
        "generateCommand": "openssl rand -base64 32"
      },
      {
        "action": "stripe-setup",
        "message": "Setting up Stripe subscription plans...",
        "plans": [
          {"name": "Pro", "priceKey": "STRIPE_PRO_PRICE_ID", "amount": 1900, "interval": "month"},
          {"name": "Enterprise", "priceKey": "STRIPE_ENTERPRISE_PRICE_ID", "amount": 9900, "interval": "month"}
        ]
      }
    ],
    "postDeploy": [
      {"action": "box", "title": "Your SaaS is live!", "lines": ["{{url}}"]},
      {"action": "clipboard", "text": "{{url}}/api/auth/stripe/webhook", "message": "Webhook URL copied"},
      {"action": "prompt", "message": "Paste your webhook signing secret (whsec_...):", "secret": true, "deployAfter": true, "writeJson": {"path": ".secrets.json", "set": {"STRIPE_WEBHOOK_SECRET": {"from": "input"}}}}
    ]
  }
}
```

This creates a guided wizard that:
1. Prompts for Stripe key (with setup URL)
2. Auto-generates auth secret
3. Creates Stripe products/prices automatically
4. Deploys the app
5. Guides through webhook setup
6. Re-deploys with webhook secret

## Farcaster Miniapp Embeds

When a cast includes a URL, Farcaster scrapes it for `fc:miniapp` meta tags to render a rich embed.

### fc:miniapp Meta Format

```html
<meta name="fc:miniapp" content='{"version":"1","imageUrl":"...","button":{...}}' />
```

```typescript
{
  version: "1",
  imageUrl: "https://absolute-url/image.png",  // MUST be absolute https
  button: {
    title: "Open App",  // Max 32 chars
    action: {
      type: "launch_miniapp",
      name: "app-name",           // REQUIRED - app name shown in UI
      url: "https://absolute-url" // MUST be absolute https
    }
  }
}
```

**Critical requirements:**
- All URLs must be absolute `https://` - no relative paths, no localhost
- `button.action.name` is **required** - omitting it breaks the embed
- Image must be 600×400 to 3000×2000 (3:2 ratio), <10MB, PNG/JPG/GIF/WebP

### Wrangler Assets + Dynamic Routes

To serve both static assets AND dynamic routes (like `/share` with meta tags):

```jsonc
// wrangler.jsonc (miniapp template)
"assets": {
  "directory": "dist/client",  // Cloudflare Vite plugin outputs client assets here
  "binding": "ASSETS",
  "not_found_handling": "single-page-application",
  "run_worker_first": true  // CRITICAL - without this, assets bypass the worker!
}
```

**Why `run_worker_first: true`?**
Without it, Cloudflare serves static files directly from the assets directory, completely bypassing your worker. This means:
- `/api/*` routes won't work if there's a matching file
- Dynamic routes like `/share` that need to inject meta tags won't work
- The worker only runs for truly non-existent paths

### External Fetch Timeout Pattern

When fetching external resources (like profile pictures for OG images), always use a timeout:

```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 3000);

try {
  const response = await fetch(url, { signal: controller.signal });
  clearTimeout(timeoutId);

  if (response.ok) {
    const buffer = await response.arrayBuffer();
    // Also limit size to prevent memory issues
    if (buffer.byteLength < 500_000) {
      // process...
    }
  }
} catch {
  // Handle timeout/network errors gracefully
}
```

Without timeout, a slow or hanging external URL can cause your OG image generation to fail silently.

## URL Detection in Cloudflare Workers

When generating URLs for external services (like Farcaster embed URLs), you need reliable production URL detection. This is non-trivial because:

1. `new URL(request.url).origin` may not work correctly in all cases
2. Local development returns `localhost` which is invalid for embeds
3. Custom domains require explicit configuration

### The Pattern

```typescript
function getBaseUrl(
  env: Env,
  c: { req: { header: (name: string) => string | undefined; url: string } },
): string | null {
  // 1. Prefer explicit APP_URL (most reliable for custom domains)
  if (env.APP_URL?.trim()) {
    const url = env.APP_URL.replace(/\/$/, "");
    if (url.startsWith("https://")) return url;
  }

  // 2. Use Host header (always set by Cloudflare in production)
  const host = c.req.header("host");
  if (host) {
    // Reject localhost - return null to signal "can't generate valid URLs"
    if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) {
      return null;
    }

    // Get protocol from cf-visitor (Cloudflare-specific) or x-forwarded-proto
    let proto = "https";
    const cfVisitor = c.req.header("cf-visitor");
    if (cfVisitor) {
      try {
        const parsed = JSON.parse(cfVisitor);
        if (parsed.scheme) proto = parsed.scheme;
      } catch {}
    } else {
      proto = c.req.header("x-forwarded-proto") || "https";
    }

    // Workers.dev is always https
    if (host.endsWith(".workers.dev")) proto = "https";

    return `${proto}://${host}`;
  }

  // 3. Fallback to URL origin (rarely needed)
  try {
    const url = new URL(c.req.url);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
```

### Key Headers in Cloudflare Workers

| Header | Value | Notes |
|--------|-------|-------|
| `host` | `my-app.workers.dev` | Always set in production |
| `cf-visitor` | `{"scheme":"https"}` | Cloudflare-specific, most reliable for protocol |
| `x-forwarded-proto` | `https` | Standard header, less reliable |

### Handling Local Development

When `getBaseUrl()` returns `null`, show a helpful error instead of generating broken URLs:

```typescript
const baseUrl = getBaseUrl(env, c);
if (!baseUrl) {
  return c.html(`
    <h2>Share embeds require production deployment</h2>
    <p>Deploy with <code>jack ship</code> to enable sharing.</p>
  `);
}
```

### Why Not Just Use `new URL(request.url)`?

- In some edge cases, `request.url` may not have the expected origin
- Local development always returns localhost
- Doesn't help distinguish production from development

The Host header approach is reliable because Cloudflare always sets it to the actual domain being accessed.

## Adding New Templates

1. Create directory: `templates/my-template/`
2. Add `.jack.json` with metadata and hooks
3. Use `jack-template` placeholder in all files
4. Add all template files
5. Generate lockfile: `cd templates/my-template && bun install`
6. Test: `jack new test-project -t my-template`
7. Verify install time with `./test-lockfile-timing.sh`
