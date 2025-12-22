# Authentication Implementation Plan (Chunks 1-4)

> **Prerequisites**: WorkOS account created, API keys obtained, Device Flow enabled, GitHub social provider configured.

---

## Overview

This plan implements WorkOS Device Flow authentication for jack CLI:
- **Chunk 1**: Auth worker shell deployed to `auth.getjack.org`
- **Chunk 2**: Device flow backend (WorkOS proxy)
- **Chunk 3**: `jack login` command
- **Chunk 4**: Auth state management + `logout`/`whoami` + protected commands

---

## Chunk 1: Auth Worker Shell

### Goal
Scaffold and deploy auth worker to `auth.getjack.org` with stub endpoints.

### Structure Decision

Create `apps/auth-worker/` directory in jack repo (not a workspace, just a separate deployable):

```
apps/
└── auth-worker/
    ├── src/
    │   └── index.ts       # Hono app entry
    ├── wrangler.toml
    ├── package.json
    └── tsconfig.json
```

### Implementation Steps

#### 1.1 Create directory structure
```bash
mkdir -p apps/auth-worker/src
```

#### 1.2 Create `apps/auth-worker/package.json`
```json
{
  "name": "@getjack/auth-worker",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241205.0",
    "typescript": "^5.0.0"
  }
}
```

#### 1.3 Create `apps/auth-worker/wrangler.toml`
```toml
name = "jack-auth"
main = "src/index.ts"
compatibility_date = "2024-12-01"

routes = [
  { pattern = "auth.getjack.org", custom_domain = true }
]

[vars]
WORKOS_CLIENT_ID = ""  # Set via wrangler secret

# Secrets (set via `wrangler secret put`):
# - WORKOS_API_KEY
```

#### 1.4 Create `apps/auth-worker/src/index.ts` (stub)
```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";

type Bindings = {
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("/*", cors({
  origin: "*",  // CLI requests come from localhost
  allowMethods: ["GET", "POST", "OPTIONS"],
}));

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "jack-auth" });
});

// Stub endpoints - return 501 Not Implemented
app.post("/auth/device/authorize", (c) => {
  return c.json({ error: "not_implemented" }, 501);
});

app.post("/auth/device/token", (c) => {
  return c.json({ error: "not_implemented" }, 501);
});

app.post("/auth/refresh", (c) => {
  return c.json({ error: "not_implemented" }, 501);
});

app.get("/auth/me", (c) => {
  return c.json({ error: "not_implemented" }, 501);
});

export default app;
```

#### 1.5 Create `apps/auth-worker/tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src/**/*"]
}
```

#### 1.6 Deploy
```bash
cd apps/auth-worker
bun install
wrangler secret put WORKOS_API_KEY  # Paste API key
wrangler secret put WORKOS_CLIENT_ID  # Paste client ID
wrangler deploy
```

### Verification
```bash
curl https://auth.getjack.org/health
# => {"status":"ok","service":"jack-auth"}

curl -X POST https://auth.getjack.org/auth/device/authorize
# => {"error":"not_implemented"} (501)
```

---

## Chunk 2: Device Flow Backend

### Goal
Implement WorkOS device flow proxy endpoints.

### WorkOS API Reference
- Device authorization: `POST https://api.workos.com/user-management/authorize`
- Token exchange: `POST https://api.workos.com/user-management/authenticate`

### Implementation Steps

#### 2.1 Add types (`apps/auth-worker/src/types.ts`)
```typescript
// WorkOS Device Authorization Response
export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

// WorkOS Token Response
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: "Bearer";
  user: {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    email_verified: boolean;
    profile_picture_url: string | null;
    created_at: string;
    updated_at: string;
  };
}

// WorkOS Pending Response
export interface AuthorizationPendingResponse {
  error: "authorization_pending";
  error_description: string;
}

// WorkOS Error Response
export interface WorkOSErrorResponse {
  error: string;
  error_description: string;
}

// Our API Response Types
export interface DeviceAuthorizeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
  };
}
```

#### 2.2 Implement `/auth/device/authorize`
```typescript
// In apps/auth-worker/src/index.ts

app.post("/auth/device/authorize", async (c) => {
  const workosResponse = await fetch(
    "https://api.workos.com/user-management/authorize",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.env.WORKOS_API_KEY}`,
      },
      body: JSON.stringify({
        client_id: c.env.WORKOS_CLIENT_ID,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    }
  );

  if (!workosResponse.ok) {
    const error = await workosResponse.json();
    return c.json({ error: "workos_error", details: error }, 500);
  }

  const data = await workosResponse.json() as DeviceAuthorizationResponse;

  return c.json({
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    verification_uri_complete: data.verification_uri_complete,
    expires_in: data.expires_in,
    interval: data.interval,
  });
});
```

#### 2.3 Implement `/auth/device/token`
```typescript
app.post("/auth/device/token", async (c) => {
  const body = await c.req.json<{ device_code: string }>();

  if (!body.device_code) {
    return c.json({ error: "missing_device_code" }, 400);
  }

  const workosResponse = await fetch(
    "https://api.workos.com/user-management/authenticate",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.env.WORKOS_API_KEY}`,
      },
      body: JSON.stringify({
        client_id: c.env.WORKOS_CLIENT_ID,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: body.device_code,
      }),
    }
  );

  const data = await workosResponse.json();

  // Still waiting for user to authorize
  if (data.error === "authorization_pending") {
    return c.json({ status: "pending" }, 202);
  }

  // Device code expired
  if (data.error === "expired_token") {
    return c.json({ error: "expired", message: "Device code expired" }, 410);
  }

  // Other error
  if (data.error) {
    return c.json({ error: data.error, message: data.error_description }, 400);
  }

  // Success - return tokens
  const tokenData = data as TokenResponse;
  return c.json({
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in,
    user: {
      id: tokenData.user.id,
      email: tokenData.user.email,
      first_name: tokenData.user.first_name,
      last_name: tokenData.user.last_name,
    },
  });
});
```

#### 2.4 Implement `/auth/refresh`
```typescript
app.post("/auth/refresh", async (c) => {
  const body = await c.req.json<{ refresh_token: string }>();

  if (!body.refresh_token) {
    return c.json({ error: "missing_refresh_token" }, 400);
  }

  const workosResponse = await fetch(
    "https://api.workos.com/user-management/authenticate",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.env.WORKOS_API_KEY}`,
      },
      body: JSON.stringify({
        client_id: c.env.WORKOS_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: body.refresh_token,
      }),
    }
  );

  if (!workosResponse.ok) {
    const error = await workosResponse.json();
    return c.json({ error: "refresh_failed", details: error }, 401);
  }

  const data = await workosResponse.json() as TokenResponse;

  return c.json({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    user: {
      id: data.user.id,
      email: data.user.email,
      first_name: data.user.first_name,
      last_name: data.user.last_name,
    },
  });
});
```

#### 2.5 Implement `/auth/me` (decode JWT, no DB yet)
```typescript
app.get("/auth/me", async (c) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const token = authHeader.slice(7);

  // For now, just decode the JWT payload (no verification yet - that's Chunk 5)
  // WorkOS JWTs are signed, but we'll add JWKS verification later
  try {
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(atob(payloadB64));

    return c.json({
      id: payload.sub,
      email: payload.email,
      // Add more fields as needed
    });
  } catch {
    return c.json({ error: "invalid_token" }, 401);
  }
});
```

### Verification
```bash
# Start device flow
curl -X POST https://auth.getjack.org/auth/device/authorize
# => { "device_code": "...", "user_code": "ABCD-1234", ... }

# Poll for token (will return pending until user completes auth)
curl -X POST https://auth.getjack.org/auth/device/token \
  -H "Content-Type: application/json" \
  -d '{"device_code": "..."}'
# => { "status": "pending" } (202) or tokens (200)
```

---

## Chunk 3: CLI Login Command

### Goal
Implement `jack login` that completes device flow and stores credentials.

### Implementation Steps

#### 3.1 Add auth constants (`src/lib/auth/constants.ts`)
```typescript
export const AUTH_API_URL = "https://auth.getjack.org";
export const AUTH_FILE = "auth.json";

// For local development, allow override
export function getAuthApiUrl(): string {
  return process.env.JACK_AUTH_URL || AUTH_API_URL;
}
```

#### 3.2 Add auth store (`src/lib/auth/store.ts`)
```typescript
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR } from "../config.ts";

export interface AuthUser {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

export interface AuthCredentials {
  access_token: string;
  refresh_token: string;
  expires_at: number;  // Unix timestamp (seconds)
  user: AuthUser;
}

const AUTH_PATH = join(CONFIG_DIR, "auth.json");

/**
 * Read stored credentials
 */
export async function getCredentials(): Promise<AuthCredentials | null> {
  if (!existsSync(AUTH_PATH)) {
    return null;
  }
  try {
    return await Bun.file(AUTH_PATH).json();
  } catch {
    return null;
  }
}

/**
 * Save credentials to disk with secure permissions
 */
export async function saveCredentials(creds: AuthCredentials): Promise<void> {
  await Bun.write(AUTH_PATH, JSON.stringify(creds, null, 2));
  // Set file permissions to 0600 (owner read/write only)
  await chmod(AUTH_PATH, 0o600);
}

/**
 * Delete stored credentials
 */
export async function deleteCredentials(): Promise<void> {
  if (existsSync(AUTH_PATH)) {
    await Bun.write(AUTH_PATH, "");  // Clear contents
    const { unlink } = await import("node:fs/promises");
    await unlink(AUTH_PATH);
  }
}

/**
 * Check if user is logged in (has valid credentials)
 */
export async function isLoggedIn(): Promise<boolean> {
  const creds = await getCredentials();
  return creds !== null;
}

/**
 * Check if token is expired or expiring soon (within 5 minutes)
 */
export function isTokenExpired(creds: AuthCredentials): boolean {
  const now = Math.floor(Date.now() / 1000);
  const buffer = 5 * 60;  // 5 minutes
  return creds.expires_at < now + buffer;
}
```

#### 3.3 Add auth client (`src/lib/auth/client.ts`)
```typescript
import { getAuthApiUrl } from "./constants.ts";
import {
  type AuthCredentials,
  getCredentials,
  isTokenExpired,
  saveCredentials,
} from "./store.ts";

export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
  };
}

/**
 * Start device authorization flow
 */
export async function startDeviceAuth(): Promise<DeviceAuthResponse> {
  const response = await fetch(`${getAuthApiUrl()}/auth/device/authorize`, {
    method: "POST",
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || "Failed to start device authorization");
  }

  return response.json();
}

/**
 * Poll for device token
 * Returns null if still pending, tokens if complete
 */
export async function pollDeviceToken(
  deviceCode: string
): Promise<TokenResponse | null> {
  const response = await fetch(`${getAuthApiUrl()}/auth/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });

  // 202 = still pending
  if (response.status === 202) {
    return null;
  }

  // 410 = expired
  if (response.status === 410) {
    throw new Error("Device code expired. Please try again.");
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || "Failed to get token");
  }

  return response.json();
}

/**
 * Refresh access token
 */
export async function refreshToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${getAuthApiUrl()}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!response.ok) {
    throw new Error("Failed to refresh token. Please login again.");
  }

  return response.json();
}

/**
 * Get valid access token, refreshing if needed
 */
export async function getValidAccessToken(): Promise<string | null> {
  const creds = await getCredentials();
  if (!creds) {
    return null;
  }

  // Refresh if expired or expiring soon
  if (isTokenExpired(creds)) {
    try {
      const newTokens = await refreshToken(creds.refresh_token);
      const newCreds: AuthCredentials = {
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + newTokens.expires_in,
        user: newTokens.user,
      };
      await saveCredentials(newCreds);
      return newCreds.access_token;
    } catch {
      // Refresh failed, user needs to login again
      return null;
    }
  }

  return creds.access_token;
}

/**
 * Make authenticated fetch request
 */
export async function authFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = await getValidAccessToken();
  if (!token) {
    throw new Error("Not authenticated. Run 'jack login' first.");
  }

  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });
}
```

#### 3.4 Create login command (`src/commands/login.ts`)
```typescript
import open from "open";  // Need to add this dependency
import {
  type DeviceAuthResponse,
  pollDeviceToken,
  startDeviceAuth,
} from "../lib/auth/client.ts";
import { type AuthCredentials, saveCredentials } from "../lib/auth/store.ts";
import { error, info, spinner, success } from "../lib/output.ts";

export default async function login(): Promise<void> {
  info("Logging in to jack cloud...");
  console.error("");

  // Step 1: Start device authorization
  const spin = spinner("Starting login...");
  let deviceAuth: DeviceAuthResponse;

  try {
    deviceAuth = await startDeviceAuth();
    spin.stop();
  } catch (err) {
    spin.stop();
    error(err instanceof Error ? err.message : "Failed to start login");
    process.exit(1);
  }

  // Step 2: Show code and open browser
  console.error("");
  console.error("  ┌────────────────────────────────────┐");
  console.error("  │                                    │");
  console.error(`  │    Your code:  ${deviceAuth.user_code.padEnd(12)}      │`);
  console.error("  │                                    │");
  console.error("  └────────────────────────────────────┘");
  console.error("");
  info(`Opening ${deviceAuth.verification_uri} in your browser...`);
  console.error("");

  // Open browser
  try {
    await open(deviceAuth.verification_uri_complete);
  } catch {
    // Browser didn't open, user will need to navigate manually
    info(`If the browser didn't open, go to: ${deviceAuth.verification_uri_complete}`);
  }

  // Step 3: Poll for completion
  const pollSpin = spinner("Waiting for you to complete login in browser...");
  const interval = (deviceAuth.interval || 5) * 1000;  // Convert to ms
  const expiresAt = Date.now() + deviceAuth.expires_in * 1000;

  while (Date.now() < expiresAt) {
    await sleep(interval);

    try {
      const tokens = await pollDeviceToken(deviceAuth.device_code);

      if (tokens) {
        pollSpin.stop();

        // Save credentials
        const creds: AuthCredentials = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
          user: tokens.user,
        };
        await saveCredentials(creds);

        console.error("");
        success(`Logged in as ${tokens.user.email}`);
        return;
      }
    } catch (err) {
      pollSpin.stop();
      error(err instanceof Error ? err.message : "Login failed");
      process.exit(1);
    }
  }

  pollSpin.stop();
  error("Login timed out. Please try again.");
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

#### 3.5 Add `open` package dependency
```bash
cd /home/user/jack
bun add open
```

#### 3.6 Register login command in `src/index.ts`
```typescript
// Add to switch statement in src/index.ts
case "login": {
  const { default: login } = await import("./commands/login.ts");
  await withTelemetry("login", login)();
  break;
}
```

#### 3.7 Update CLI help text
Add to the meow help string:
```
    login               Sign in to jack cloud
```

### Verification
```bash
jack login
# => Shows code, opens browser
# => After completing auth: "Logged in as hello@example.com"

# Check credentials file exists with correct permissions
ls -la ~/.config/jack/auth.json
# => -rw------- (0600 permissions)
```

---

## Chunk 4: Auth State Management

### Goal
Add `logout`, `whoami` commands and protect `jack cloud *` commands with auth.

### Implementation Steps

#### 4.1 Create logout command (`src/commands/logout.ts`)
```typescript
import { deleteCredentials, getCredentials } from "../lib/auth/store.ts";
import { info, success } from "../lib/output.ts";

export default async function logout(): Promise<void> {
  const creds = await getCredentials();

  if (!creds) {
    info("Not logged in");
    return;
  }

  await deleteCredentials();
  success("Logged out");
}
```

#### 4.2 Create whoami command (`src/commands/whoami.ts`)
```typescript
import { getCredentials } from "../lib/auth/store.ts";
import { info, item, success } from "../lib/output.ts";

export default async function whoami(): Promise<void> {
  const creds = await getCredentials();

  if (!creds) {
    info("Not logged in");
    info("Run 'jack login' to sign in");
    return;
  }

  console.error("");
  success("Logged in");
  item(`Email: ${creds.user.email}`);
  item(`ID: ${creds.user.id}`);

  if (creds.user.first_name) {
    item(`Name: ${creds.user.first_name}${creds.user.last_name ? ` ${creds.user.last_name}` : ""}`);
  }

  // Show token expiry
  const expiresIn = creds.expires_at - Math.floor(Date.now() / 1000);
  if (expiresIn > 0) {
    const hours = Math.floor(expiresIn / 3600);
    const minutes = Math.floor((expiresIn % 3600) / 60);
    item(`Token expires: ${hours}h ${minutes}m`);
  } else {
    item("Token: expired (will refresh on next request)");
  }
  console.error("");
}
```

#### 4.3 Add auth guard utility (`src/lib/auth/guard.ts`)
```typescript
import { JackError, JackErrorCode } from "../errors.ts";
import { getValidAccessToken } from "./client.ts";
import { getCredentials } from "./store.ts";

/**
 * Require authentication - throws JackError if not logged in
 */
export async function requireAuth(): Promise<string> {
  const token = await getValidAccessToken();

  if (!token) {
    throw new JackError(
      JackErrorCode.AUTH_FAILED,
      "Not logged in",
      "Run 'jack login' to sign in to jack cloud"
    );
  }

  return token;
}

/**
 * Get current user or null
 */
export async function getCurrentUser() {
  const creds = await getCredentials();
  return creds?.user ?? null;
}
```

#### 4.4 Add auth error code to errors.ts
```typescript
// Add to JackErrorCode enum in src/lib/errors.ts
JACK_AUTH_REQUIRED = "JACK_AUTH_REQUIRED",
JACK_AUTH_EXPIRED = "JACK_AUTH_EXPIRED",
```

#### 4.5 Protect cloud command (`src/commands/cloud.ts`)

Add auth check at the start of the cloud command:
```typescript
import { requireAuth } from "../lib/auth/guard.ts";

export default async function cloud(subcommand?: string, args: string[] = []): Promise<void> {
  // Require authentication for all cloud operations
  await requireAuth();

  // ... rest of existing code
}
```

#### 4.6 Register new commands in `src/index.ts`
```typescript
case "login": {
  const { default: login } = await import("./commands/login.ts");
  await withTelemetry("login", login)();
  break;
}
case "logout": {
  const { default: logout } = await import("./commands/logout.ts");
  await withTelemetry("logout", logout)();
  break;
}
case "whoami": {
  const { default: whoami } = await import("./commands/whoami.ts");
  await withTelemetry("whoami", whoami)();
  break;
}
```

#### 4.7 Update CLI help text
```
  Commands
    login               Sign in to jack cloud
    logout              Sign out
    whoami              Show current user
```

#### 4.8 Export auth utilities for other commands
Create barrel export (`src/lib/auth/index.ts`):
```typescript
export { getAuthApiUrl } from "./constants.ts";
export { startDeviceAuth, pollDeviceToken, refreshToken, authFetch, getValidAccessToken } from "./client.ts";
export { getCredentials, saveCredentials, deleteCredentials, isLoggedIn, isTokenExpired, type AuthCredentials, type AuthUser } from "./store.ts";
export { requireAuth, getCurrentUser } from "./guard.ts";
```

### Verification
```bash
# Test whoami when not logged in
jack whoami
# => "Not logged in"

# Login
jack login
# => Complete device flow
# => "Logged in as hello@example.com"

# Test whoami when logged in
jack whoami
# => Shows email, ID, token expiry

# Test cloud commands require auth
jack logout
jack cloud list
# => Error: "Not logged in. Run 'jack login' to sign in to jack cloud"

# Test logout
jack login
jack logout
# => "Logged out"
jack whoami
# => "Not logged in"
```

---

## File Summary

### New Files
```
apps/auth-worker/
├── src/
│   ├── index.ts        # Hono app with auth endpoints
│   └── types.ts        # TypeScript types
├── wrangler.toml       # Worker config
├── package.json
└── tsconfig.json

src/lib/auth/
├── constants.ts        # API URL constants
├── store.ts            # Credential storage
├── client.ts           # Auth API client
├── guard.ts            # Auth guard utilities
└── index.ts            # Barrel export

src/commands/
├── login.ts            # jack login
├── logout.ts           # jack logout
└── whoami.ts           # jack whoami
```

### Modified Files
```
src/index.ts            # Add login, logout, whoami commands
src/lib/errors.ts       # Add JACK_AUTH_* error codes
src/commands/cloud.ts   # Add requireAuth() call
package.json            # Add 'open' dependency
```

---

## Environment Variables

### Auth Worker (Cloudflare Secrets)
```bash
wrangler secret put WORKOS_API_KEY    # sk_... from WorkOS dashboard
wrangler secret put WORKOS_CLIENT_ID   # client_... from WorkOS dashboard
```

### CLI (for local development)
```bash
JACK_AUTH_URL=http://localhost:8787  # Point to local worker dev server
```

---

## Testing Checklist

### Chunk 1
- [ ] `curl https://auth.getjack.org/health` returns 200
- [ ] Stub endpoints return 501

### Chunk 2
- [ ] Device authorize returns codes
- [ ] Token polling returns pending/success correctly
- [ ] Refresh token works

### Chunk 3
- [ ] `jack login` opens browser
- [ ] Completing auth stores credentials
- [ ] Credentials file has 0600 permissions

### Chunk 4
- [ ] `jack whoami` shows user info
- [ ] `jack logout` clears credentials
- [ ] `jack cloud list` requires auth
- [ ] Token auto-refresh works
