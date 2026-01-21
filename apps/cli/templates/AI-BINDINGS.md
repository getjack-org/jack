# AI and Vectorize Bindings in Jack Cloud

## Quick Reference for Coding Agents

**DO NOT add `[ai]` or `[[vectorize]]` bindings directly for jack cloud projects.**

Jack cloud uses metered proxies for AI and Vectorize calls. Use the patterns below:

### AI Pattern

```typescript
import { createJackAI } from "./jack-ai";

function getAI(env: Env) {
  if (env.__AI_PROXY && env.__JACK_PROJECT_ID && env.__JACK_ORG_ID) {
    return createJackAI(env);
  }
  if (env.AI) {
    return env.AI;
  }
  throw new Error("No AI binding available");
}

// Usage:
const ai = getAI(env);
const result = await ai.run("@cf/meta/llama-3.2-1b-instruct", { messages });
```

### Vectorize Pattern

```typescript
import { createJackVectorize } from "./jack-vectorize";

const INDEX_NAME = "my-vectors";

function getVectorize(env: Env) {
  if (env.__VECTORIZE_PROXY && env.__JACK_PROJECT_ID && env.__JACK_ORG_ID) {
    return createJackVectorize(env, INDEX_NAME);
  }
  if (env.VECTORS) {
    return env.VECTORS;
  }
  throw new Error("No Vectorize binding available");
}

// Usage:
const vectors = getVectorize(env);
const results = await vectors.query(embedding, { topK: 10 });
await vectors.insert([{ id: "doc1", values: embedding, metadata: {} }]);
```

## Why This Pattern?

Jack cloud is multi-tenant. All users share Cloudflare's AI quota (10k neurons/day). Without metering:
- One user could exhaust the daily quota for everyone
- No visibility into per-project usage
- No ability to bill for AI usage

The proxy:
1. Checks per-project quota
2. Logs usage to Analytics Engine
3. Forwards to real AI binding
4. Returns response unchanged

## Environment Bindings

### Jack Cloud (Managed Deploy)

Control plane injects these bindings:
- `__AI_PROXY` - Service binding to jack-binding-proxy for AI
- `__VECTORIZE_PROXY` - Service binding to jack-binding-proxy for Vectorize
- `__JACK_PROJECT_ID` - Project ID for metering
- `__JACK_ORG_ID` - Organization ID for billing

`env.AI` and `env.VECTORS` are **NOT available** in jack cloud. Direct calls will fail.

### Local Development

wrangler.jsonc provides:
- `AI` - Direct Cloudflare AI binding for local testing
- `VECTORS` - Direct Vectorize binding for local testing

The helper functions automatically use the right binding based on environment.

## Template Pattern

### AI Templates

1. **src/jack-ai.ts** - Client wrapper (copy from ai-chat or semantic-search template)

2. **Env interface** with optional bindings:
```typescript
interface Env {
  AI?: Ai;                    // Local dev
  __AI_PROXY?: Fetcher;       // Jack cloud
  __JACK_PROJECT_ID?: string; // Jack cloud
  __JACK_ORG_ID?: string;     // Jack cloud
}
```

3. **getAI() helper** that handles both environments

4. **wrangler.jsonc** with AI binding for local dev only:
```jsonc
{
  "ai": { "binding": "AI" }
}
```

### Vectorize Templates

1. **src/jack-vectorize.ts** - Client wrapper (copy from semantic-search template)

2. **Env interface** with optional bindings:
```typescript
interface Env {
  VECTORS?: VectorizeIndex;      // Local dev
  __VECTORIZE_PROXY?: Fetcher;   // Jack cloud
  __JACK_PROJECT_ID?: string;    // Jack cloud
  __JACK_ORG_ID?: string;        // Jack cloud
}
```

3. **getVectorize() helper** that handles both environments

4. **wrangler.jsonc** with Vectorize binding for local dev only:
```jsonc
{
  "vectorize": [{
    "binding": "VECTORS",
    "index_name": "my-vectors",
    "preset": "cloudflare"
  }]
}
```

## Error Handling

Quota exceeded returns 429:

### AI Quota
```typescript
try {
  const result = await ai.run(model, inputs);
} catch (error) {
  if (error.code === "AI_QUOTA_EXCEEDED") {
    // Daily limit (1000 requests) reached, resets at midnight UTC
    console.log(`Retry in ${error.resetIn} seconds`);
  }
}
```

### Vectorize Quota
```typescript
try {
  const results = await vectors.query(embedding, { topK: 10 });
} catch (error) {
  if (error.code === "VECTORIZE_QUERY_QUOTA_EXCEEDED") {
    // Query limit (33,000/day) reached
    console.log(`Retry in ${error.resetIn} seconds`);
  }
  if (error.code === "VECTORIZE_MUTATION_QUOTA_EXCEEDED") {
    // Mutation limit (10,000/day) reached
    console.log(`Retry in ${error.resetIn} seconds`);
  }
}
```

## BYOC Mode

For Bring Your Own Cloud deployments:
- User configures their own Cloudflare account
- Direct AI binding is used (no proxy)
- No metering (it's their account)
- Standard Cloudflare docs apply

## See Also

- `/docs/internal/specs/binding-proxy-worker.md` - Full architecture spec
- `apps/binding-proxy-worker/` - Proxy implementation
- `apps/control-plane/src/deployment-service.ts` - Binding injection logic
