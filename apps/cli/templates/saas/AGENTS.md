# Agent Context

## Infrastructure

This project uses **jack** for deployment. When Jack MCP is connected, prefer `mcp__jack__*` tools over CLI commands - they're cloud-aware and faster.

**Do NOT use wrangler directly.** Jack manages config and may use cloud-hosted resources where wrangler won't work.

Common operations:
- **Deploy**: `jack ship` or Jack MCP
- **Database**: `jack services db create` or Jack MCP
- **Status**: `jack status` or Jack MCP

## Project Structure

```
src/
├── index.ts              # Hono API entry point
├── auth.ts               # Better Auth configuration
├── client/               # React frontend
│   ├── App.tsx           # Application entry
│   ├── main.tsx          # React entry point
│   ├── index.css         # Tailwind + theme CSS
│   ├── lib/
│   │   ├── auth-client.ts  # Better Auth client
│   │   └── utils.ts        # Utility functions (cn)
│   ├── hooks/
│   │   ├── useAuth.ts      # Auth hook
│   │   └── useSubscription.ts  # Subscription hook
│   ├── pages/            # Page components
│   │   ├── HomePage.tsx    # Public landing page
│   │   ├── LoginPage.tsx   # Login form
│   │   ├── SignupPage.tsx  # Signup form
│   │   ├── DashboardPage.tsx # Protected dashboard
│   │   └── PricingPage.tsx   # Pricing page
│   └── components/       # Reusable components
│       └── ui/           # shadcn/ui components
└── db/
    └── schema.sql        # D1 database schema
```

## Authentication (Better Auth)

This template uses Better Auth with email/password authentication.

### Server-side Setup (src/auth.ts)

```typescript
import { betterAuth } from "better-auth";
import { stripe } from "@better-auth/stripe";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";

export function createAuth(env: Env) {
  // Use Kysely with D1 dialect - Better Auth uses Kysely internally for D1
  const db = new Kysely<any>({
    dialect: new D1Dialect({ database: env.DB }),
  });

  return betterAuth({
    database: { db, type: "sqlite" },
    emailAndPassword: { enabled: true },
    secret: env.BETTER_AUTH_SECRET,
    plugins: [stripe({ /* config */ })],
  });
}
```

### Client-side Usage

```tsx
import { authClient } from './lib/auth-client';

// Sign up new user
await authClient.signUp.email({
  email: 'user@example.com',
  password: 'password123',
  name: 'John Doe'
});

// Sign in existing user
await authClient.signIn.email({
  email: 'user@example.com',
  password: 'password123'
});

// Get current session
const { data: session } = await authClient.getSession();
if (session) {
  console.log('Logged in as:', session.user.email);
}

// Sign out
await authClient.signOut();
```

## Payments (Stripe)

Uses Better Auth's Stripe plugin for subscription management. Webhooks are handled automatically at `/api/auth/stripe/webhook`.

### Subscription Tiers

- **Free**: No payment required, basic features
- **Pro**: Monthly subscription, full features
- **Enterprise**: Monthly subscription, premium support

### Upgrading a User

```tsx
import { authClient } from './lib/auth-client';

async function handleUpgrade(plan: 'pro' | 'enterprise') {
  const { data, error } = await authClient.subscription.upgrade({
    plan,
    successUrl: '/dashboard?upgraded=true',
    cancelUrl: '/pricing',
  });

  if (data?.url) {
    // Redirect to Stripe Checkout
    window.location.href = data.url;
  }
}
```

### Checking Subscription Status

```tsx
import { authClient } from './lib/auth-client';

async function getCurrentPlan() {
  const { data: subscriptions } = await authClient.subscription.list();

  const activeSubscription = subscriptions?.find(
    s => s.status === 'active' || s.status === 'trialing'
  );

  return activeSubscription?.plan || 'free';
}
```

## Adding New Pages

1. Create component in `src/client/pages/NewPage.tsx`
2. Add route in `src/client/App.tsx`
3. For protected pages, check session before rendering

### Protected Page Pattern

```tsx
import { authClient } from '../lib/auth-client';
import { useEffect, useState } from 'react';

export function ProtectedPage() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authClient.getSession().then(({ data }) => {
      setSession(data);
      setLoading(false);
    });
  }, []);

  if (loading) return <div>Loading...</div>;
  if (!session) {
    window.location.href = '/login';
    return null;
  }

  return <div>Protected content for {session.user.email}</div>;
}
```

## Adding API Routes

API routes are defined in `src/index.ts` using Hono.

```typescript
import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

// Public route
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Protected route (check auth)
app.get("/api/me", async (c) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json({ user: session.user });
});
```

## Database Schema

The D1 database uses Better Auth's default schema (singular table names, camelCase columns):

- `user` - User accounts with email, name, stripeCustomerId
- `session` - Active user sessions
- `account` - OAuth provider accounts (includes password for email/password auth)
- `verification` - Email verification tokens
- `subscription` - Stripe subscription records

To modify the schema, edit `schema.sql` and run migrations with jack.

## Stripe Setup (Required Order)

### 1. Initial Deploy & Webhook Setup

The webhook secret requires the deployment URL, so follow this order:

```bash
# 1. Deploy first (without webhook secret - subscriptions won't work yet)
jack ship

# 2. Get your deployment URL
jack status  # e.g., https://your-app.runjack.xyz

# 3. Create webhook in Stripe Dashboard:
#    - Go to: Developers → Webhooks → Add endpoint
#    - URL: https://your-app.runjack.xyz/api/auth/stripe/webhook
#    - Events: customer.subscription.created, customer.subscription.updated,
#              customer.subscription.deleted, checkout.session.completed
#    - Copy the signing secret (whsec_...)

# 4. Set the webhook secret
jack secrets set STRIPE_WEBHOOK_SECRET whsec_your_secret_here

# 5. Redeploy to enable Stripe plugin
jack ship
```

**Important:** The Stripe plugin is DISABLED if `STRIPE_WEBHOOK_SECRET` is missing. This prevents silent sync failures.

### 2. Customer Portal Setup

For subscription upgrades/downgrades to work:

1. Go to [Stripe Dashboard → Settings → Billing → Customer Portal](https://dashboard.stripe.com/settings/billing/portal)
2. Enable **"Customers can switch plans"**
3. Add your products/prices to the allowed list
4. Enable **"Customers can cancel subscriptions"** if you want in-portal cancellation

Without this, users will see: *"This subscription cannot be updated because the subscription update feature in the portal configuration is disabled."*

## Environment Variables

Required secrets (set via `jack secrets set KEY value`):

| Secret | Description | Where to get it |
|--------|-------------|-----------------|
| `BETTER_AUTH_SECRET` | Random secret for auth tokens | `openssl rand -base64 32` |
| `STRIPE_SECRET_KEY` | Stripe API secret key | [Stripe Dashboard](https://dashboard.stripe.com/apikeys) |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret (whsec_...) | Created after adding webhook |
| `STRIPE_PRO_PRICE_ID` | Price ID for Pro plan | [Stripe Products](https://dashboard.stripe.com/products) |
| `STRIPE_ENTERPRISE_PRICE_ID` | Price ID for Enterprise plan | [Stripe Products](https://dashboard.stripe.com/products) |

## SQL Execution

Jack supports secure SQL execution against D1 databases:

**Via MCP** (preferred for agents):
- `execute_sql({ sql: "SELECT * FROM user" })` - read queries work by default
- `execute_sql({ sql: "INSERT...", allow_write: true })` - writes require allow_write
- Destructive ops (DROP, TRUNCATE, ALTER) are blocked via MCP - use CLI

**Via CLI**:
- `jack services db execute "SELECT * FROM user"` - read queries
- `jack services db execute "INSERT..." --write` - write queries
- `jack services db execute --file schema.sql --write` - run SQL from file

## Customizing Theme

The template uses shadcn/ui CSS variables for theming. To customize:

1. Visit [ui.shadcn.com/create](https://ui.shadcn.com/create)
2. Design your theme with the visual editor
3. Copy the generated CSS variables
4. Replace the `:root` and `.dark` blocks in `src/client/index.css`

The default theme uses neutral colors. The CSS variables control all component colors:

```css
:root {
  --background: 0 0% 100%;
  --foreground: 0 0% 3.9%;
  --primary: 0 0% 9%;
  --primary-foreground: 0 0% 98%;
  /* ... etc */
}
```

## External API Integration Principles

### 1. Don't trust cached data for real-time state

Libraries that sync external data via webhooks (like Better Auth's Stripe plugin) provide **eventual consistency**, not real-time truth. Webhooks may be delayed, fail silently, or not be configured yet.

**Rule**: For user-facing state that must be accurate (subscription status, payment state, cancellation), query the source API directly rather than relying on locally cached data.

### 2. Defensive coding for external data

External APIs return unpredictable shapes. Fields you expect may be null, undefined, or have different types in edge cases.

**Rule**: Always add null checks before transforming external data, especially timestamps, nested objects, and optional fields.

### 3. Return actionable error details

Generic "500 Internal Server Error" messages waste debugging time. During development, include the actual error.

**Rule**: In catch blocks, return `details: err.message` so you can see what actually failed. Strip these in production if needed.

### 4. Test the unhappy paths

The happy path (user signs up, subscribes, uses app) usually works. The bugs hide in: cancellation flows, expired states, partial failures, re-subscription after cancel.

**Rule**: Manually test state transitions, not just initial states.

## Resources

- [Better Auth Docs](https://www.betterauth.com/docs)
- [Better Auth Stripe Plugin](https://www.betterauth.com/docs/plugins/stripe)
- [Stripe Billing Docs](https://docs.stripe.com/billing)
- [Stripe Webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [shadcn/ui Theme Creator](https://ui.shadcn.com/create)
- [Hono Documentation](https://hono.dev)
- [Cloudflare D1 Docs](https://developers.cloudflare.com/d1)
