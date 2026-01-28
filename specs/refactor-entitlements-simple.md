# Refactor: Simplify Entitlements to Referrals-Only Model

## Confirmed Scope

**In scope:**
- Refactor billing API to simplified referrals-only model
- Remove promo code system entirely (endpoints + DB table)
- Keep `/referral/apply` endpoint (username entry flow)
- Both referrer AND referred user get +1 domain on payment
- Reset test data (clear test credits)
- Create `entitlements-config.ts` with all limits/bonuses
- Write detailed frontend prompt

**Out of scope:**
- Implementing frontend (just prompt)
- Auto-apply referral from URL param
- Multiple bonus types (just custom_domains for now)

---

## Goal
Replace verbose entitlements response with a clean, referral-based model. One successful referral = fixed bonus. Single config file.

## Current (Verbose)
```json
{
  "entitlements": {
    "custom_domains_base": 3,
    "custom_domains_bonus": 3,
    "custom_domains_pending": 1,
    "custom_domains_total": 6,
    "custom_domains_used": 2,
    "custom_domains_available": 4
  }
}
```

## Target (Clean)
```json
{
  "plan": { "tier": "pro", "is_paid": true },
  "referrals": { "code": "hellno", "successful": 5, "pending": 2 },
  "limits": {
    "custom_domains": { "limit": 8, "used": 2 }
  }
}
```

Frontend computes: `available = limit - used`

---

## Implementation Plan

### Task 1: Create Entitlements Config
**File:** `apps/control-plane/src/entitlements-config.ts` (new)

```typescript
import type { PlanTier } from "./types";

// Base limits per plan tier
export const TIER_LIMITS: Record<PlanTier, { custom_domains: number }> = {
  free: { custom_domains: 1 },  // Set to 0 when platform hits 100 domains
  pro: { custom_domains: 3 },
  team: { custom_domains: 10 },
};

// What ONE successful referral grants
export const REFERRAL_BONUS = {
  custom_domains: 1,
} as const;

// Max bonus from referrals
export const REFERRAL_CAP = {
  custom_domains: 25,
} as const;

// Compute final limits for an org
export function computeLimits(
  tier: PlanTier,
  successfulReferrals: number
): { custom_domains: number } {
  const base = TIER_LIMITS[tier];
  if (!base) throw new Error(`Unknown tier: ${tier}`);

  return {
    custom_domains: base.custom_domains + Math.min(
      successfulReferrals * REFERRAL_BONUS.custom_domains,
      REFERRAL_CAP.custom_domains
    ),
  };
}
```

### Task 2: Simplify CreditsService
**File:** `apps/control-plane/src/credits-service.ts`

Replace `getBonusDomains`, `getPendingBonusDomains`, `getReferralStats` with one method:

```typescript
async getReferrals(orgId: string): Promise<{
  code: string | null;
  successful: number;
  pending: number;
}> {
  // Get username as referral code
  const user = await this.db
    .prepare(`
      SELECT u.username FROM users u
      JOIN org_memberships om ON u.id = om.user_id
      WHERE om.org_id = ? LIMIT 1
    `)
    .bind(orgId)
    .first<{ username: string | null }>();

  // Count successful (active referral_given) and pending in one query
  const stats = await this.db
    .prepare(`
      SELECT
        SUM(CASE WHEN type = 'referral_given' AND status = 'active' THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN type = 'referral_received' AND status = 'pending' THEN 1 ELSE 0 END) as pending
      FROM credits WHERE org_id = ? OR code = ?
    `)
    .bind(orgId, user?.username)
    .first<{ successful: number; pending: number }>();

  return {
    code: user?.username ?? null,
    successful: stats?.successful ?? 0,
    pending: stats?.pending ?? 0,
  };
}
```

### Task 3: Update Billing Endpoint
**File:** `apps/control-plane/src/index.ts`

Replace current billing endpoint response:

```typescript
import { computeLimits, REFERRAL_CAP } from "./entitlements-config";

// GET /v1/orgs/:orgId/billing
api.get("/orgs/:orgId/billing", async (c) => {
  // ... existing auth/membership checks ...

  const billingService = new BillingService(c.env);
  const creditsService = new CreditsService(c.env);

  const billing = await billingService.getOrCreateBilling(orgId);
  const referrals = await creditsService.getReferrals(orgId);
  const limits = computeLimits(billing.plan_tier as PlanTier, referrals.successful);

  // Get usage
  const domainsUsed = await c.env.DB
    .prepare(`
      SELECT COUNT(*) as count FROM custom_domains
      WHERE org_id = ? AND status IN ('claimed','pending','pending_owner','pending_ssl','active')
    `)
    .bind(orgId)
    .first<{ count: number }>();

  return c.json({
    plan: {
      tier: billing.plan_tier,
      is_paid: billingService.isPaidTier(billing),
    },
    referrals: {
      code: referrals.code,
      successful: referrals.successful,
      pending: referrals.pending,
      cap: REFERRAL_CAP.custom_domains,
    },
    limits: {
      custom_domains: {
        limit: limits.custom_domains,
        used: domainsUsed?.count ?? 0,
      },
    },
  });
});
```

### Task 4: Update checkCustomDomainGate
**File:** `apps/control-plane/src/index.ts`

```typescript
import { computeLimits } from "./entitlements-config";

async function checkCustomDomainGate(
  db: D1Database,
  orgId: string,
  currentCount: number,
): Promise<GatingResult> {
  const billing = await db
    .prepare("SELECT plan_tier FROM org_billing WHERE org_id = ?")
    .bind(orgId)
    .first<{ plan_tier: string }>();

  const tier = (billing?.plan_tier || "free") as PlanTier;

  // Count successful referrals
  const referrals = await db
    .prepare(`
      SELECT COUNT(*) as count FROM credits
      WHERE org_id = ? AND type = 'referral_given' AND status = 'active'
    `)
    .bind(orgId)
    .first<{ count: number }>();

  const limits = computeLimits(tier, referrals?.count ?? 0);

  if (currentCount >= limits.custom_domains) {
    return {
      allowed: false,
      error: {
        code: "limit_exceeded",
        message: `Custom domain limit reached (${limits.custom_domains}). Refer friends to earn more.`,
        upgrade_url: "https://jack.dev/pricing",
      },
    };
  }

  return { allowed: true };
}
```

### Task 5: Cleanup Types
**File:** `apps/control-plane/src/types.ts`

Remove:
- `TIER_LIMITS` constant (moved to entitlements-config.ts)
- `BONUS_DOMAINS_CAP` constant (moved to entitlements-config.ts)
- `PromoCode` interface (no longer needed)

Keep credit types minimal:
```typescript
export type CreditType = "referral_given" | "referral_received" | "manual";
export type CreditStatus = "pending" | "active";
```

### Task 6: Remove Promo Code System
**File:** `apps/control-plane/src/index.ts`

- Delete `POST /v1/promo/redeem` endpoint
- Remove any promo-related imports

**File:** `apps/control-plane/src/credits-service.ts`

- Delete `redeemPromoCode` method

### Task 7: Database Cleanup Migration
**File:** `apps/control-plane/migrations/0022_drop_promo_codes.sql` (new)

```sql
-- Drop promo codes table (moving to referrals-only model)
DROP TABLE IF EXISTS promo_codes;

-- Clear test data from credits
DELETE FROM credits WHERE type = 'promo';
```

### Task 8: Update Referral Logic
**File:** `apps/control-plane/src/credits-service.ts`

Ensure both parties get credit on payment:
- Referrer: `referral_given` (active, +1 domain)
- Referred: `referral_received` (pending → active on payment, +1 domain)

The `qualifyReferral` method already does this - just verify it's working.

---

## Files Changed

| File | Action |
|------|--------|
| `src/entitlements-config.ts` | Create (new) |
| `src/credits-service.ts` | Simplify, remove promo methods |
| `src/index.ts` | Update billing endpoint + gate, remove promo endpoint |
| `src/types.ts` | Remove old constants + PromoCode type |
| `migrations/0022_drop_promo_codes.sql` | Drop promo table, clear test data |

---

## API Response Comparison

### Before
```json
{
  "billing": {
    "plan_tier": "pro",
    "plan_status": "active",
    "payment_provider": "stripe",
    "current_period_end": "2024-02-01",
    "cancel_at_period_end": false,
    "is_paid": true
  },
  "entitlements": {
    "custom_domains_base": 3,
    "custom_domains_bonus": 5,
    "custom_domains_pending": 2,
    "custom_domains_total": 8,
    "custom_domains_used": 2,
    "custom_domains_available": 6
  },
  "referral": {
    "code": "hellno",
    "successful_referrals": 5,
    "pending_referrals": 2,
    "domains_earned": 5
  }
}
```

### After
```json
{
  "plan": {
    "tier": "pro",
    "is_paid": true
  },
  "referrals": {
    "code": "hellno",
    "successful": 5,
    "pending": 2,
    "cap": 25
  },
  "limits": {
    "custom_domains": {
      "limit": 8,
      "used": 2
    }
  }
}
```

**Reduction:** 19 keys → 9 keys

---

## Extensibility

To add a new referral benefit (e.g., `requests_per_min`):

```typescript
// 1. Add to TIER_LIMITS
export const TIER_LIMITS = {
  free: { custom_domains: 1, requests_per_min: 100 },
  pro: { custom_domains: 3, requests_per_min: 1000 },
  team: { custom_domains: 10, requests_per_min: 5000 },
};

// 2. Add to REFERRAL_BONUS
export const REFERRAL_BONUS = {
  custom_domains: 1,
  requests_per_min: 50,
};

// 3. Add to REFERRAL_CAP
export const REFERRAL_CAP = {
  custom_domains: 25,
  requests_per_min: 500,
};

// 4. Update computeLimits return type and logic
```

All changes in one file. API response automatically includes new limit.

---

## Migration

1. Run migration 0022 to drop promo table and clear test data
2. Deploy backend with new response structure
3. Frontend can be built against new API

---

## Frontend Agent Prompt

```markdown
# Referrals UI Implementation

## Overview
Implement referral system UI for Jack Cloud. Users earn +1 bonus custom domain for each successful referral. Both referrer and referred user get the bonus when the referred user pays.

## API Endpoints

### GET /v1/orgs/:orgId/billing
Returns plan info, referral stats, and limits.

**Response:**
```json
{
  "plan": {
    "tier": "free",
    "is_paid": false
  },
  "referrals": {
    "code": "hellno",
    "successful": 5,
    "pending": 2,
    "cap": 25
  },
  "limits": {
    "custom_domains": {
      "limit": 6,
      "used": 2
    }
  }
}
```

**Fields:**
- `plan.tier`: "free" | "pro" | "team"
- `plan.is_paid`: whether user has active paid subscription
- `referrals.code`: user's referral code (their username)
- `referrals.successful`: completed referrals (both paid)
- `referrals.pending`: signups waiting to pay
- `referrals.cap`: max bonus domains from referrals (25)
- `limits.custom_domains.limit`: total allowed (base + referral bonus)
- `limits.custom_domains.used`: currently used

**Computed by frontend:**
- `available = limit - used`
- `bonus_domains = successful` (1 referral = 1 domain)

---

### POST /v1/referral/apply
Apply a referral code (for new users who were referred).

**Request:**
```json
{ "code": "referrer-username" }
```

**Responses:**
- `{"applied": true}` - Success, pending credit created
- `{"applied": false, "reason": "invalid"}` - Username doesn't exist
- `{"applied": false, "reason": "self_referral"}` - Can't refer yourself
- `{"applied": false, "reason": "already_referred"}` - Already used a referral
- `429` - Rate limited

---

## UI Components

### 1. Settings/Billing Page - Referral Section

```
┌─────────────────────────────────────────────────────┐
│ 🎁 Refer Friends, Earn Domains                      │
├─────────────────────────────────────────────────────┤
│ Your referral code: hellno                          │
│ Share link: https://jack.dev?ref=hellno    [Copy]   │
│                                                     │
│ Successful referrals: 5  (+5 bonus domains)         │
│ Pending: 2 (waiting for friends to upgrade)         │
│                                                     │
│ ━━━━━━━━━━━━━━━━━━━━━━ 5/25                         │
│ Progress toward max bonus (25 domains)              │
└─────────────────────────────────────────────────────┘
```

### 2. Settings/Billing Page - Domain Limits

```
┌─────────────────────────────────────────────────────┐
│ Custom Domains                                      │
├─────────────────────────────────────────────────────┤
│ Limit: 6 (1 base + 5 from referrals)                │
│ Used: 2                                             │
│ Available: 4                                        │
│                                                     │
│ [Add Domain]                                        │
└─────────────────────────────────────────────────────┘
```

### 3. Referral Input (Onboarding or Settings)

Show for users who haven't applied a referral yet:

```
┌─────────────────────────────────────────────────────┐
│ Were you referred by someone?                       │
│ ┌────────────────────────────┐ ┌─────────┐         │
│ │ Enter their username       │ │ Apply   │         │
│ └────────────────────────────┘ └─────────┘         │
└─────────────────────────────────────────────────────┘
```

After applying:
```
✓ Referral applied! You'll both get +1 bonus domain when you upgrade.
```

Hide this section if user has `already_referred`.

---

## User Flows

### Flow 1: Share Referral
1. User goes to Settings → Referrals
2. Sees their code and shareable link
3. Copies link, shares with friends
4. When friend signs up + pays → both get +1 domain

### Flow 2: Apply Referral (New User)
1. New user signs up
2. In onboarding or settings, enters referrer's username
3. POST `/v1/referral/apply` with `{"code": "friend"}`
4. Shows "pending" status
5. After payment, credit activates

### Flow 3: Check Domain Availability
1. User tries to add custom domain
2. Frontend checks `limits.custom_domains`
3. If `used >= limit`, show upgrade prompt or referral CTA
4. If `used < limit`, allow adding domain

---

## Edge Cases

| Case | Handling |
|------|----------|
| Self-referral | Show "You can't use your own code" |
| Invalid username | Show "This username doesn't exist" |
| Already referred | Hide referral input, show "Referral already applied" |
| Rate limited | Show "Too many attempts, try again later" |
| At cap (25) | Show "Maximum bonus reached" in referral section |
| No domains available | Show "Upgrade or refer friends to add domains" |

---

## Tier Base Limits

| Tier | Base Custom Domains |
|------|---------------------|
| free | 1 |
| pro | 3 |
| team | 10 |

Referral bonus: +1 per successful referral, max 25 bonus
```
