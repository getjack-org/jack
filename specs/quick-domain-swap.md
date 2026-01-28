# Quick Domain Swap Optimization

## Problem

When users unassign a domain from one project and reassign to another, they see confusing TXT verification prompts even though DNS is already configured.

**Current behavior:**
1. Unassign → Deletes Cloudflare hostname
2. Reassign → Creates NEW Cloudflare hostname → Shows TXT instructions
3. Cloudflare auto-verifies via HTTP (CNAME still exists) → Active within seconds
4. User confused: "Why did it ask for TXT but then work?"

**Desired behavior:**
- Swap projects instantly without re-verification
- DNS verified ONCE, trusted on reassign
- No Cloudflare hostname deletion/recreation

## Root Cause

In `/apps/control-plane/src/index.ts`, the unassign endpoint (line 3285) deletes the Cloudflare hostname:

```typescript
// Current: DELETE from Cloudflare on unassign
if (domain.cloudflare_id) {
  await cfClient.deleteCustomHostname(domain.cloudflare_id);
}
// Then clears: cloudflare_id = NULL, ssl_status = NULL
```

This forces a full re-provisioning on reassign, even though:
- DNS (CNAME to runjack.xyz) is still valid
- Domain ownership was already verified
- SSL cert details are the same

## Solution

**Keep the Cloudflare hostname when unassigning.** Only remove project association and KV routing.

### New Flow

```
UNASSIGN (optimized):
  1. Set project_id = NULL
  2. Set status = 'unassigned' (new status)
  3. Delete KV cache (stops routing)
  4. KEEP: cloudflare_id, ssl_status, dns_verified, ownership_verification_*

REASSIGN (optimized):
  IF cloudflare_id exists:
    1. Verify hostname still exists in Cloudflare (GET, not CREATE)
    2. Update project_id
    3. Write to KV cache
    4. Return active status immediately
  ELSE:
    1. Normal flow: create in Cloudflare, wait for verification
```

## Schema Changes

Add new status to `CustomDomainStatus`:

```typescript
export type CustomDomainStatus =
  | "claimed"        // Slot reserved, no project, no Cloudflare
  | "unassigned"     // NEW: Was active, now unassigned but CF hostname kept
  | "pending_dns"    // Waiting for CNAME
  | "pending"        // Creating in Cloudflare
  | "pending_owner"  // Need TXT for ownership
  | "pending_ssl"    // SSL pending
  | "active"         // Working
  // ... rest unchanged
```

## Code Changes

### 1. Unassign Endpoint (`/v1/domains/:domainId/unassign`)

**Before:**
```typescript
// Delete from Cloudflare if provisioned
if (domain.cloudflare_id) {
  const cfClient = new CloudflareClient(c.env);
  cfClient.setZoneId(c.env.CLOUDFLARE_ZONE_ID);
  await cfClient.deleteCustomHostname(domain.cloudflare_id);
}

// Reset to claimed state
await c.env.DB.prepare(
  `UPDATE custom_domains
   SET project_id = NULL,
       cloudflare_id = NULL,
       status = 'claimed',
       ssl_status = NULL,
       ownership_verification_type = NULL,
       ownership_verification_name = NULL,
       ownership_verification_value = NULL,
       ...`
)
```

**After:**
```typescript
// DON'T delete from Cloudflare - keep for quick reassignment

// Delete KV cache to stop routing
const cacheService = new ProjectCacheService(c.env.PROJECTS_CACHE);
await cacheService.deleteCustomDomainConfig(domain.hostname);

// Set to unassigned state, keep Cloudflare provisioning
await c.env.DB.prepare(
  `UPDATE custom_domains
   SET project_id = NULL,
       status = CASE
         WHEN cloudflare_id IS NOT NULL THEN 'unassigned'
         ELSE 'claimed'
       END,
       updated_at = CURRENT_TIMESTAMP
   WHERE id = ?`
)
```

### 2. Assign Endpoint (`/v1/domains/:domainId/assign`)

**Before:**
```typescript
// Always creates new Cloudflare hostname
const cfHostname = await cfClient.createCustomHostname(domain.hostname);
```

**After:**
```typescript
let cfHostname: CloudflareCustomHostname;
let jackStatus: CustomDomainStatus;

if (domain.cloudflare_id && domain.status === 'unassigned') {
  // Quick reassign: verify existing hostname is still valid
  try {
    cfHostname = await cfClient.getCustomHostname(domain.cloudflare_id);
    jackStatus = mapCloudflareToJackStatus(cfHostname.status, cfHostname.ssl?.status);

    // If still active in Cloudflare, we're good
    if (jackStatus === 'active') {
      // Just update project and KV cache
      await c.env.DB.prepare(
        `UPDATE custom_domains
         SET project_id = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).bind(body.project_id, domainId).run();

      // Update KV cache for routing
      const projectConfig = await cacheService.getProjectConfig(body.project_id);
      if (projectConfig) {
        await cacheService.setCustomDomainConfig(domain.hostname, projectConfig);
      }

      const updatedDomain = await c.env.DB.prepare("SELECT * FROM custom_domains WHERE id = ?")
        .bind(domainId).first<CustomDomain>();
      return c.json({ domain: formatDomainResponse(updatedDomain!) });
    }
  } catch (error) {
    // Hostname was deleted from CF externally - fall through to create new
    console.log(`Cloudflare hostname ${domain.cloudflare_id} not found, creating new`);
  }
}

// Standard flow: create new Cloudflare hostname
cfHostname = await cfClient.createCustomHostname(domain.hostname);
jackStatus = mapCloudflareToJackStatus(cfHostname.status, cfHostname.ssl?.status);
// ... rest of existing code
```

### 3. Update Status Checks

Update `SLOT_CONSUMING_STATUSES` to include `unassigned`:

```typescript
const SLOT_CONSUMING_STATUSES: CustomDomainStatus[] = [
  "claimed",
  "unassigned",  // NEW
  "pending_dns",
  "pending",
  "pending_owner",
  "pending_ssl",
  "active",
  "moved",
];
```

### 4. Update `getNextStep` for Unassigned Status

```typescript
case 'unassigned':
  return {
    action: 'none',
    message: 'Ready to assign to a project: jack domain assign <hostname> <project>',
  };
```

### 5. CLI Updates

Update status display in `domain.ts` and `domains.ts`:

```typescript
case "unassigned":
  return `${colors.cyan}○${colors.reset}`; // icon

case "unassigned":
  return "ready"; // label
```

## Edge Cases

### 1. Cloudflare Hostname Deleted Externally

If someone deletes the hostname directly in Cloudflare dashboard:
- GET hostname returns 404
- Fall back to creating new hostname (standard flow)

### 2. SSL Certificate Expired

Cloudflare auto-renews, but if expired:
- GET hostname returns ssl_status != 'active'
- May need to recreate or wait for renewal

### 3. Domain Unassigned for Long Time

After 90 days (Cloudflare cert lifetime), cert may need renewal:
- Check ssl_status on reassign
- If not active, may need to wait for renewal or recreate

## Migration

No migration needed - existing domains continue to work. The optimization only affects future unassign/assign operations.

## Testing Checklist

- [ ] Unassign domain → status becomes 'unassigned', CF hostname kept
- [ ] Reassign unassigned domain → instant active, no TXT prompt
- [ ] Reassign after CF hostname externally deleted → creates new, shows TXT
- [ ] CLI shows 'ready' status for unassigned domains
- [ ] Unassigned domains still count toward slot limit
- [ ] KV cache cleared on unassign, restored on reassign

## Success Criteria

1. Project swaps are instant (< 1 second)
2. No TXT/DNS prompts when swapping projects
3. Users understand domain is "ready to assign" when unassigned
