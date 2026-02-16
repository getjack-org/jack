# AI and Vectorize Bindings in Jack Cloud

## Quick Reference for Coding Agents

### AI — Uses Proxy

AI uses a metered proxy (`__AI_PROXY`). Templates need a `jack-ai.ts` wrapper:

```typescript
import { createJackAI } from "./jack-ai";

function getAI(env: Env) {
  if (env.__AI_PROXY) {
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

### Vectorize — Direct Binding (Metered via Code Injection)

Vectorize uses `env.VECTORS` directly. No wrapper needed. The control plane injects a metering
layer at deploy time that wraps the binding before your code runs.

```typescript
// Just use env.VECTORS — metering happens automatically
const results = await env.VECTORS.query(embedding, { topK: 10 });
await env.VECTORS.insert([{ id: "doc1", values: embedding, metadata: {} }]);
```

**Do NOT create a vectorize wrapper.** The old `jack-vectorize.ts` proxy pattern is deprecated.

## Why Different Patterns?

- **AI** is a global shared service. The proxy enforces per-project quota (sync check before forwarding).
- **Vectorize** is per-tenant (each project gets its own index). The control plane wraps `env.VECTORS` via code injection (`__jack_meter.mjs`) for async metering. No proxy needed.

## Environment Bindings

### Jack Cloud (Managed Deploy)

Control plane injects:
- `__AI_PROXY` — Service binding to jack-binding-proxy for AI (metering + quota)
- `VECTORS` — Direct Vectorize binding to the project's own index
- `__JACK_VECTORIZE_USAGE` — Analytics Engine binding for vectorize metering (injected, not visible to user code)

`env.AI` is **NOT available** in jack cloud (use `getAI()` helper). `env.VECTORS` **IS available** directly.

### Local Development

wrangler.jsonc provides:
- `AI` — Direct Cloudflare AI binding for local testing
- `VECTORS` — Direct Vectorize binding for local testing

The `getAI()` helper automatically uses the right binding. For vectorize, `env.VECTORS` works in both environments.

## Template Pattern

### AI Templates

1. **src/jack-ai.ts** — Client wrapper (copy from ai-chat or semantic-search template)

2. **Env interface** with optional bindings:
```typescript
interface Env {
  AI?: Ai;                    // Local dev
  __AI_PROXY?: Fetcher;       // Jack cloud
}
```

3. **getAI() helper** that handles both environments

4. **wrangler.jsonc** with AI binding:
```jsonc
{
  "ai": { "binding": "AI" }
}
```

### Vectorize Templates

1. **Env interface** with direct binding:
```typescript
interface Env {
  VECTORS: VectorizeIndex;
}
```

2. **Use `env.VECTORS` directly** — no wrapper, no helper needed

3. **wrangler.jsonc** with Vectorize binding:
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

### Vectorize

Vectorize calls go directly to the binding. There is no sync quota enforcement — metering is async via Analytics Engine. If Cloudflare's own rate limits are hit, the binding returns standard errors.

## BYOC Mode

For Bring Your Own Cloud deployments:
- User configures their own Cloudflare account
- Direct AI binding is used (no proxy)
- No metering (it's their account)
- Standard Cloudflare docs apply

## See Also

- `apps/binding-proxy-worker/` — AI proxy implementation
- `apps/control-plane/src/metering-wrapper.ts` — Vectorize metering code injection
- `apps/control-plane/src/deployment-service.ts` — Binding injection logic
