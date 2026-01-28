# Custom Domain State Machine Design (v2)

## Problem

We relied entirely on Cloudflare's `active` status which only means "SSL cert ready", not "traffic can flow". We never verify:
- CNAME record exists
- CNAME points to our fallback origin (`runjack.xyz`)
- Traffic actually routes

**Result:** Users see green "Active" badge but domain doesn't work because DNS isn't configured.

**Root causes:**
1. Trusted Cloudflare `active` blindly
2. No DNS verification at all
3. Created SSL certs before knowing if user will configure DNS (wasted Cloudflare requests)

## Scope

### In Scope
- Subdomain custom hostnames (e.g., `app.example.com`, `dash.mysite.io`)
- DNS-first verification flow
- 7-day expiry for unconfigured domains
- Both CLI + Web UI show `pending_dns` status and CNAME instructions

### Out of Scope
- **Apex/root domains** (`example.com` without subdomain) - requires Cloudflare Enterprise with dedicated IP prefixes
- Wildcard domains (`*.example.com`)
- BYOIP configurations
- A record fallback (CNAME only)
- Email/webhook notifications (v1 = manual status checks only)

### Key Behaviors
- **Uniqueness**: Hostname globally unique across ALL users (first-come-first-served)
- **Removal**: Soft delete - keep in DB as `deleted` for audit, remove from Cloudflare
- **Expired domains**: Hostname freed after 7-day expiry, available for others to claim
- **Expired action**: User must delete (cannot restart), then re-add if wanted
- **DNS drift (`moved`)**: User must delete and re-add domain (no auto-recovery)

---

## Solution: DNS-First Flow

**Key insight:** Verify DNS BEFORE creating hostname in Cloudflare. This:
- Ensures users complete DNS setup before we request SSL
- Avoids wasted Cloudflare API calls for abandoned domains
- Makes `active` actually mean "working" (SSL + DNS both verified)

### New State Flow

```
User adds domain
       │
       ▼
┌─────────────┐
│ pending_dns │ ← Show CNAME instructions
└─────────────┘
       │ (CNAME to runjack.xyz verified)
       ▼
┌─────────────┐
│ pending_ssl │ ← Create hostname in Cloudflare, wait for SSL
└─────────────┘
       │ (Cloudflare may require TXT for ownership)
       ▼
┌──────────────┐
│pending_owner │ ← Show TXT record instructions (if needed)
└──────────────┘
       │ (ownership verified)
       ▼
┌─────────────┐
│   active    │ ← Actually working! SSL + DNS both verified
└─────────────┘
```

### Schema Changes

```sql
-- Migration: add_dns_verification.sql
ALTER TABLE custom_domains ADD COLUMN dns_verified INTEGER DEFAULT 0;
ALTER TABLE custom_domains ADD COLUMN dns_verified_at DATETIME;
ALTER TABLE custom_domains ADD COLUMN dns_last_checked_at DATETIME;
ALTER TABLE custom_domains ADD COLUMN dns_target TEXT;
ALTER TABLE custom_domains ADD COLUMN dns_error TEXT;

-- New status value: 'pending_dns' added to status enum
-- Status progression: pending_dns → pending_ssl → pending_owner (optional) → active

CREATE INDEX idx_custom_domains_dns_check
ON custom_domains(status, dns_last_checked_at);
```

### Updated Types

```typescript
export type CustomDomainStatus =
  | "claimed"        // Slot reserved, not yet assigned
  | "pending_dns"    // NEW: Waiting for CNAME to runjack.xyz
  | "pending"        // Creating in Cloudflare (transitional)
  | "pending_owner"  // Need TXT for ownership verification
  | "pending_ssl"    // Ownership OK, SSL pending
  | "active"         // SSL ready AND DNS verified = actually working
  | "blocked"        // Cloudflare blocked
  | "moved"          // DNS moved away from runjack.xyz (must delete & re-add)
  | "failed"         // Timeout/error
  | "expired"        // NEW: pending_dns timed out after 7 days (hostname freed)
  | "deleted"        // NEW: Soft deleted (audit trail, hostname freed)
  | "deleting";      // Removal in progress
```

---

## User-Facing Status Matrix

| Status | Label | Show User |
|--------|-------|-----------|
| `claimed` | "Reserved" | "Assign to a project to continue" |
| `pending_dns` | "Configure DNS" | CNAME instructions to `runjack.xyz` |
| `pending_ssl` | "Issuing Certificate" | "DNS verified, waiting for SSL..." |
| `pending_owner` | "Verify Ownership" | TXT record instructions |
| `active` | "Working" | Green checkmark |
| `moved` | "DNS Changed" | "Delete and re-add domain to restore" |
| `blocked` | "Blocked" | "Contact support" |
| `failed` | "Failed" | "Delete and re-add domain" |
| `expired` | "Expired" | "Domain expired after 7 days. Delete to free hostname." |
| `deleted` | (hidden) | Not shown in lists, kept for audit |

---

## API Response Enhancement

```typescript
export interface CustomDomainResponse {
  id: string;
  hostname: string;
  status: CustomDomainStatus;
  ssl_status: string | null;

  // DNS verification state
  dns: {
    verified: boolean;
    checked_at: string | null;
    current_target: string | null;
    expected_target: string;  // "runjack.xyz"
    error: string | null;
  };

  // What user should do next
  next_step: {
    action: "add_cname" | "add_txt" | "wait" | "none";
    record_type?: "CNAME" | "TXT";
    record_name?: string;
    record_value?: string;
    message: string;
  } | null;
}
```

---

## DNS Verification Logic

```typescript
// Normalize DNS names (handle trailing dots, case)
function normalizeDnsName(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

async function verifyDns(hostname: string): Promise<{
  verified: boolean;
  target: string | null;
  error: string | null;
}> {
  const expectedTarget = 'runjack.xyz';

  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${hostname}&type=CNAME`,
    { headers: { 'Accept': 'application/dns-json' } }
  );
  const data = await response.json();

  if (data.Answer?.length > 0) {
    const rawTarget = data.Answer[0].data;
    const target = normalizeDnsName(rawTarget);
    const verified = target === normalizeDnsName(expectedTarget);
    return {
      verified,
      target,
      error: verified ? null : `Points to ${target}, expected ${expectedTarget}`
    };
  }

  // NXDOMAIN (Status 3) vs NODATA - different user guidance
  if (data.Status === 3) {
    return {
      verified: false,
      target: null,
      error: 'Domain not found (NXDOMAIN) - check hostname spelling'
    };
  }

  return {
    verified: false,
    target: null,
    error: 'No CNAME record found - add CNAME pointing to runjack.xyz'
  };
}
```

---

## Polling Strategy

| Domain State | Poll DNS | Poll Cloudflare | Interval | Timeout |
|--------------|----------|-----------------|----------|---------|
| `pending_dns` | Yes | No | 1 minute | 7 days → `expired` |
| `pending_ssl` | No | Yes | 30 seconds | — |
| `pending_owner` | No | Yes | 2 minutes | — |
| `active` | Yes | No | Daily | — |
| `moved` | Yes | Yes | 10 minutes | — |
| `blocked`, `failed`, `expired`, `claimed` | No | No | Never | — |

### Expiry Logic

```typescript
// In polling job, before processing pending_dns domains:
if (domain.status === 'pending_dns' &&
    domain.created_at < Date.now() - 7 * 24 * 60 * 60 * 1000) {
  await db.prepare("UPDATE custom_domains SET status = 'expired' WHERE id = ?")
    .bind(domain.id).run();
  continue; // Skip further processing
}
```

### Race Condition Prevention

Update `dns_last_checked_at` immediately when picking up a domain to prevent double-processing:

```typescript
// Atomic: mark as being processed, return only if we got it
const result = await db.prepare(`
  UPDATE custom_domains
  SET dns_last_checked_at = CURRENT_TIMESTAMP
  WHERE id = ? AND (dns_last_checked_at IS NULL OR dns_last_checked_at < datetime('now', '-1 minute'))
  RETURNING *
`).bind(domainId).first();

if (!result) return; // Another worker got it
```

### Polling Query

```sql
SELECT * FROM custom_domains
WHERE status IN ('pending_dns', 'pending_ssl', 'pending_owner', 'active', 'moved')
  AND (
    (status = 'pending_dns' AND (dns_last_checked_at IS NULL OR dns_last_checked_at < datetime('now', '-1 minute')))
    OR (status = 'active' AND (dns_last_checked_at IS NULL OR dns_last_checked_at < datetime('now', '-1 day')))
    OR status IN ('pending_ssl', 'pending_owner', 'moved')
  )
ORDER BY
  CASE status
    WHEN 'pending_dns' THEN 1
    WHEN 'pending_ssl' THEN 2
    WHEN 'pending_owner' THEN 3
    WHEN 'active' THEN 4
    ELSE 5
  END,
  dns_last_checked_at ASC NULLS FIRST
LIMIT 50
```

---

## Handling DNS Drift (Was Working, Now Broken)

1. **Detection:** Daily check for `active` domains
2. **If CNAME gone/changed:** Set `status = 'moved'`, `dns_verified = 0`, delete from Cloudflare
3. **User sees:** "DNS Changed - Delete and re-add domain to restore"
4. **Recovery:** User must delete domain and add it again (no auto-recovery)

This simplifies the state machine - once DNS breaks, the domain enters a terminal state requiring user action.

---

## Migration for Existing Domains

**Scope:** Currently just one domain (`dash.getjack.org`) affected.

**Safe migration approach:**
1. Run DNS verification on all existing `active` domains
2. If CNAME to `runjack.xyz` exists → keep `active`, set `dns_verified = 1`
3. If CNAME missing/wrong → delete from Cloudflare, set `status = 'pending_dns'`

This preserves any domains that ARE currently working while fixing orphaned ones.

---

## Implementation Tasks

1. [ ] Add migration for DNS verification columns + `pending_dns` + `expired` + `deleted` statuses
2. [ ] Add unique constraint on hostname (globally unique across all users)
3. [ ] Update `CustomDomain` types in `types.ts`
4. [ ] Add `verifyDns()` function with normalized comparison
5. [ ] Change domain creation to start at `pending_dns` (not create in CF immediately)
6. [ ] Add DNS polling for `pending_dns` domains with atomic lock
7. [ ] Add 7-day expiry check in polling job (free hostname on expiry)
8. [ ] On DNS verified: create hostname in Cloudflare, move to `pending_ssl`
9. [ ] Implement soft delete (set `status = 'deleted'`, remove from CF, free hostname)
10. [ ] Update `formatDomainResponse()` to always include `next_step`
11. [ ] Add `POST /v1/domains/:id/verify` endpoint for manual refresh
12. [ ] Backfill: verify DNS first, then reset orphaned domains to `pending_dns`
13. [ ] Update CLI display logic for all new statuses
14. [ ] Update web UI to show DNS instructions for `pending_dns` status

## Design Decisions

- **Apex domains:** Out of scope (requires Cloudflare Enterprise)
- **Retry limits:** Use Cloudflare defaults, assume high reliability
- **Expiry:** 7 days for `pending_dns` → `expired`, hostname freed for others
- **Race conditions:** Atomic timestamp update before processing
- **`pending_ssl`/`pending_owner` timeout:** 48 hours → `failed` (rare edge case)
- **`moved` handling:** Terminal state, user must delete and re-add (no auto-recovery)
- **`expired` action:** Delete only (cannot restart), must re-add as new domain
- **Removal:** Soft delete - set `status = 'deleted'`, remove from CF, keep DB record
- **Uniqueness:** Hostname globally unique across all users (first-come-first-served)
- **Error cleanup:** Clear `dns_error = NULL` when `dns_verified = 1`
- **Migration idempotency:** Check CF status before deleting, handle partial failures
