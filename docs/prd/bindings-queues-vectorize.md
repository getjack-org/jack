# PRD: Queues & Vectorize Bindings for Jack

## Overview

Extend Jack's binding support to include **Queues** (producer + consumer) and **Vectorize** (vector indexes), following established resource management patterns.

---

## Scope

### In Scope

| Binding | Capabilities | Auto-Provision |
|---------|--------------|----------------|
| **Queues** | Producer (`env.QUEUE.send()`) + Consumer (`queue()` handler) | Yes |
| **Vectorize** | Insert + Query vectors | Yes |

### Explicitly Out of Scope

| Binding | Reason | Timeline |
|---------|--------|----------|
| Hyperdrive | Requires external Postgres setup | Future |
| Services | Complex multi-project UX | Future |
| Tail Consumers | Jack internal use first (live logs feature) | Future |
| Durable Objects | Complex migrations, class management | No current plans |
| Browser Rendering | Niche, account requirements | No current plans |
| Email Routes | Niche | No current plans |
| mTLS Certificates | Enterprise use case | No current plans |

---

## Architecture Principles

From prior learnings, all new bindings MUST follow:

### 1. Single Source of Truth

```
Managed Mode: Control plane is authority
- wrangler.jsonc is local cache, synced from cloud
- CLI reads intent, control plane resolves to resources
```

### 2. Resource Registration Pattern

Every resource stored with ALL identifiers at creation:

| Field | Example | Purpose |
|-------|---------|---------|
| `projectId` | `proj_abc123` | Parent relationship |
| `type` | `queue`, `vectorize` | Resource type |
| `bindingName` | `TASKS`, `EMBEDDINGS` | User-facing name |
| `resourceName` | `jack-abc123-tasks` | Jack-generated name |
| `providerId` | `cf-uuid-xyz` | Cloudflare's ID |

### 3. Naming Authority

```
CLI → "I want a queue bound to TASKS" → Control Plane
Control Plane → "Created queue 'jack-abc123-tasks' (id: xyz)" → CLI
CLI → writes resolved name to wrangler.jsonc
```

### 4. Atomic Operations

Create/delete must touch all storage locations:
1. Control plane DB (soft delete for audit)
2. Cloudflare API
3. Local wrangler.jsonc

---

## Binding Specifications

### Queues

#### Concepts
- **Queue**: Named message buffer with configurable batching/retry
- **Producer**: Sends messages via `env.QUEUE.send()`
- **Consumer**: Receives messages via `queue()` export handler
- A single worker can be both producer AND consumer

#### User Config (Minimal)

```jsonc
{
  "queues": {
    "producers": [{ "binding": "TASKS" }],
    "consumers": [{ "binding": "TASKS" }]
  }
}
```

Jack resolves queue names, consumer settings, and auto-creates DLQ.

#### Omakase Defaults

| Setting | Default | Rationale |
|---------|---------|-----------|
| `max_batch_size` | 10 | Balance throughput vs memory |
| `max_batch_timeout` | 5s | Reasonable latency |
| `max_retries` | 3 | Standard retry pattern |
| `dead_letter_queue` | Auto-create | Don't lose failed messages |

---

### Vectorize

#### Concepts
- **Index**: Vector database with fixed dimensions and distance metric
- **Vectors**: Embeddings with IDs and optional metadata
- Common pattern: AI binding generates embeddings → Vectorize stores/queries

#### User Config (Minimal)

```jsonc
{
  "vectorize": [{ "binding": "EMBEDDINGS" }]
}
```

Or with preset:

```jsonc
{
  "vectorize": [{ "binding": "EMBEDDINGS", "preset": "openai-large" }]
}
```

#### Omakase Defaults

Default to **Cloudflare's free embedding model** for zero-cost getting started:

| Setting | Default | Rationale |
|---------|---------|-----------|
| `dimensions` | 768 | Cloudflare `@cf/baai/bge-base-en-v1.5` |
| `metric` | cosine | Best for text similarity |
| `model` | `@cf/baai/bge-base-en-v1.5` | Free, no API key needed |

#### Presets for Upgrades

Users can specify a preset to use different embedding models:

| Preset | Dimensions | Model | Notes |
|--------|------------|-------|-------|
| `cloudflare` (default) | 768 | `@cf/baai/bge-base-en-v1.5` | Free, built-in |
| `cloudflare-small` | 384 | `@cf/baai/bge-small-en-v1.5` | Free, faster |
| `cloudflare-large` | 1024 | `@cf/baai/bge-large-en-v1.5` | Free, higher quality |
| `openai` | 1536 | `text-embedding-ada-002` | Requires OPENAI_API_KEY |
| `openai-large` | 3072 | `text-embedding-3-large` | Requires OPENAI_API_KEY |

Upgrade path: User adds `OPENAI_API_KEY` secret, changes preset to `openai-large`, redeploys.

---

## Templates

### Template: `queue-worker`

**Purpose**: Showcase queue producer + consumer pattern

**Key Features**:
- HTTP API that enqueues tasks (producer)
- Background processor that handles tasks (consumer)
- Dead letter queue for failed messages
- Type-safe message handling

**Bindings**:
- `TASKS` queue (producer + consumer)

**Example Use Cases**:
- Background job processing
- Webhook delivery
- Email sending queue
- Data processing pipeline

---

### Template: `semantic-search`

**Purpose**: Showcase AI + Vectorize for RAG/semantic search

**Key Features**:
- Document indexing endpoint
- Semantic search endpoint
- Uses free Cloudflare AI for embeddings
- D1 for storing full document content

**Bindings**:
- `AI` - Cloudflare Workers AI (free)
- `DOCS` - Vectorize index (768 dims, cosine)
- `DB` - D1 database for document storage

**Example Use Cases**:
- Documentation search
- FAQ matching
- Content recommendations
- RAG for chatbots

---

## Implementation Changes

### CLI

1. **Add to `SUPPORTED_BINDINGS`**: `queues`, `vectorize`
2. **Update `WranglerConfig`**: Parse queues and vectorize config
3. **Update `ManifestData`**: Include binding intent for new types
4. **Update `extractBindingsFromConfig()`**: Extract queue/vectorize bindings

### Control Plane

1. **Add resource types**: `queue`, `queue_dlq`, `vectorize`
2. **Add provisioning functions**: `provisionQueue()`, `provisionVectorizeIndex()`
3. **Update manifest validation**: Accept new binding types
4. **Update `resolveBindingsFromManifest()`**: Resolve queue/vectorize to Cloudflare resources
5. **Add Cloudflare API methods**: Queue and Vectorize CRUD operations

### Database

No schema changes needed—existing `resources` table handles new types via `resource_type` column.

---

## Deployment Flow

```
jack deploy
    │
    ▼
CLI: Parse wrangler.jsonc
    │ Extract queues/vectorize binding INTENT
    ▼
CLI: Build manifest.json
    │ Include binding names (not resolved resources)
    ▼
Control Plane: Validate manifest
    │
    ▼
Control Plane: Resolve bindings
    │ For each binding:
    │   - Check DB for existing resource (by project + type + binding_name)
    │   - If not exists: provision via Cloudflare API
    │   - Register with ALL identifiers
    │   - Return DispatchScriptBinding
    ▼
Control Plane: Upload to Cloudflare
    │ Include resolved bindings in metadata
    ▼
Control Plane: Return resolved config
    │
    ▼
CLI: Update local wrangler.jsonc
    (Control plane is authority, local is cache)
```

---

## Delete Flow

```
jack delete --resource TASKS
    │
    ▼
Control Plane: Find resource
    │ Match by: binding_name > provider_id > resource_name (fallbacks)
    ▼
Control Plane: Atomic delete
    │ 1. Mark deleted in DB (audit trail)
    │ 2. Delete from Cloudflare
    │ 3. Return success
    ▼
CLI: Remove from local wrangler.jsonc
```

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Time to first queue message | < 5 min from `jack init --template queue-worker` |
| Time to first vector search | < 5 min from `jack init --template semantic-search` |
| Zero manual Cloudflare dashboard visits | Templates work without CF console |
| Binding resolution success rate | > 99% (no orphaned resources) |

---

## Open Questions

1. **Queue DLQ naming**: Auto-create as `{queue}-dlq` or let user name it?
2. **Vectorize index limits**: Cloudflare has limits on indexes per account—should Jack track/warn?
3. **Preset extensibility**: Allow custom presets in `.jack.json` or hardcode common ones?

---

## Future Considerations

- **Hyperdrive**: Connection string management, secrets integration
- **Services**: Cross-project binding resolution, permission model
- **Tail Consumers**: Jack-managed logging infrastructure first
