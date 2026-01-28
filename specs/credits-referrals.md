# Credits, Referrals & Promo Codes Spec

## Problem

Jack Cloud needs user acquisition mechanisms before launch. Users have no way to earn bonus domains beyond their tier limits, and there's no viral growth loop (referrals) or promotional capability (promo codes).

## Success Criteria

1. User A shares referral link, User B signs up and pays → both get +1 bonus domain visible in billing
2. User redeems promo code → instant +1 bonus domain in entitlements
3. Free user with 2 bonus domains → can create 2 custom domains (not just 0)
4. Pro user with 2 bonus domains → can create 5 custom domains (3 base + 2 bonus)
5. User B (referred, unpaid) sees "+1 domain (unlocks when you upgrade)" pending state in billing

## Scope

### In Scope

- **Credits table** with status tracking (pending/active)
- **Promo codes table** for admin-managed instant grants
- **Referral flow**: capture `?ref=code` → store → apply after auth → qualify on payment
- **Updated entitlements** calculation: tier limit + bonus domains
- **Referral section in billing page** showing code + stats
- **Promo code redemption endpoint**
- **Rate limiting** on referral code checks + silent validation (no confirmation of validity)

### Out of Scope

- Referral dashboard UI beyond billing page section - future
- Expiring credits - future
- Cash/payment rewards - future
- Multi-level referrals - future
- Deploy-based qualification (payment only for V1)
- CLI `--ref` flag (web-only referral capture for V1)
- Notifications when referral qualifies (email or in-app) - future
- Social share buttons (copy button only for V1)
- Pre-seeded promo codes (create ad-hoc as needed)

## Constraints

### Must Follow

- Use existing `TIER_LIMITS` pattern from `apps/control-plane/src/types.ts:222-226`
- Follow billing service pattern from `apps/control-plane/src/billing-service.ts`
- Use Hono route patterns from `apps/control-plane/src/index.ts`
- Test pattern from `apps/control-plane/src/sql-utils.test.ts` (bun:test)
- Store referral code in localStorage before auth (standard SaaS pattern, see Dub.co `dub_id` cookie approach)
- Call `POST /v1/referral/apply` after auth to submit stored referral code

### Must Avoid

- Do NOT allow self-referral (user's own code)
- Do NOT allow duplicate referral (first referral wins)
- Do NOT grant credits until payment is confirmed (prevents spam accounts)
- Do NOT add new dependencies for this feature
- Do NOT exceed 25 total bonus domains per org (cap from all sources combined)

### UX Requirements

- **Referral link format:** `getjack.org/?ref=username`
- **Share UX:** Copy button only (no social share buttons)
- **No username state:** Show "Set a username to get your referral code" with link to settings
- **Pending bonus display:** Show "+1 domain (unlocks when you upgrade)" for referred users who haven't paid
- **Promo code input:** Expandable "Have a promo code?" in both billing page AND entitlements section
- **Notifications:** None for V1 (users see updated stats on next billing page visit)
- **Multi-org:** Referral credit goes to user's first/primary org

### Security Notes

**Username enumeration via referral codes:** Referral codes = usernames, so validating a referral code reveals if a username exists. This is acceptable because:
1. Username existence is already exposed via `/v1/usernames/:name/available` endpoint
2. Rate limiting (via existing `USERNAME_CHECK_LIMITER`) prevents bulk enumeration
3. No exploit path - attacker still needs to pay to get any credit

## Technical Approach

### Database Schema

**New migration: `apps/control-plane/migrations/0021_create_credits.sql`**

```sql
-- Credits ledger: append-only log with status tracking
CREATE TABLE credits (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL,              -- 'referral_given' | 'referral_received' | 'promo' | 'manual'
  status TEXT NOT NULL DEFAULT 'active', -- 'pending' | 'active'
  amount INTEGER NOT NULL,         -- positive = grant, negative = revoke (future)
  code TEXT,                       -- referral code or promo code that triggered this
  source_org_id TEXT,              -- for referrals: who referred / who was referred
  note TEXT,                       -- optional description
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (org_id) REFERENCES orgs(id)
);

CREATE INDEX idx_credits_org_id ON credits(org_id);
CREATE INDEX idx_credits_code ON credits(code);
CREATE INDEX idx_credits_type ON credits(type);
CREATE INDEX idx_credits_status ON credits(status);

-- Promo codes table (admin-managed via direct DB inserts)
-- Each code is single-use. Issue multiple codes for multiple users.
CREATE TABLE promo_codes (
  code TEXT PRIMARY KEY,
  amount INTEGER NOT NULL DEFAULT 1, -- how many bonus domains
  redeemed_by_org_id TEXT,         -- NULL = unused, set on redemption
  redeemed_at DATETIME,            -- when it was used
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Type Definitions

**Update: `apps/control-plane/src/types.ts`**

```typescript
// Credit types
export type CreditType = 'referral_given' | 'referral_received' | 'promo' | 'manual';
export type CreditStatus = 'pending' | 'active';

export interface Credit {
  id: string;
  org_id: string;
  type: CreditType;
  status: CreditStatus;
  amount: number;
  code: string | null;
  source_org_id: string | null;
  note: string | null;
  created_at: string;
}

export interface PromoCode {
  code: string;
  amount: number;
  redeemed_by_org_id: string | null;
  redeemed_at: string | null;
  created_at: string;
}
```

### New Service

**Create: `apps/control-plane/src/credits-service.ts`**

```typescript
export class CreditsService {
  constructor(private db: D1Database) {}

  // Get total active bonus domains for an org (capped at 25)
  async getBonusDomains(orgId: string): Promise<number> {
    const result = await this.db
      .prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM credits
                WHERE org_id = ? AND status = 'active'`)
      .bind(orgId)
      .first<{ total: number }>();
    const total = result?.total ?? 0;
    return Math.min(total, 25); // Cap at 25 bonus domains
  }

  // Get referral stats for billing page
  // NOTE: pending_referrals query is different - looks at OTHER users' pending credits
  async getReferralStats(orgId: string, username: string | null): Promise<{
    code: string | null;
    successful_referrals: number;
    pending_referrals: number;
    domains_earned: number;
  }> {
    if (!username) {
      return { code: null, successful_referrals: 0, pending_referrals: 0, domains_earned: 0 };
    }

    // Successful = credits I earned from referrals
    const successful = await this.db
      .prepare(`SELECT COUNT(*) as count FROM credits
                WHERE org_id = ? AND type = 'referral_given' AND status = 'active'`)
      .bind(orgId)
      .first<{ count: number }>();

    // Pending = OTHER users who used my code but haven't paid yet
    // These are stored with code = my username, type = 'referral_received', status = 'pending'
    const pending = await this.db
      .prepare(`SELECT COUNT(*) as count FROM credits
                WHERE code = ? AND type = 'referral_received' AND status = 'pending'`)
      .bind(username)
      .first<{ count: number }>();

    // Domains earned = sum of my referral_given credits
    const earned = await this.db
      .prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM credits
                WHERE org_id = ? AND type = 'referral_given' AND status = 'active'`)
      .bind(orgId)
      .first<{ total: number }>();

    return {
      code: username,
      successful_referrals: successful?.count ?? 0,
      pending_referrals: pending?.count ?? 0,
      domains_earned: earned?.total ?? 0,
    };
  }

  // Record referral at signup (creates pending credit for referred user)
  async recordReferralSignup(referredOrgId: string, referralCode: string): Promise<void> { /* ... */ }

  // Qualify referral on payment (activates credits for both parties)
  async qualifyReferral(orgId: string): Promise<void> { /* ... */ }

  // Redeem promo code (instant active credit)
  async redeemPromoCode(orgId: string, code: string): Promise<{
    success: boolean;
    amount?: number;
    error?: string;
  }> { /* ... */ }
}
```

### API Endpoints

| Endpoint | Method | Auth | Rate Limit | Purpose |
|----------|--------|------|------------|---------|
| `/v1/referral/apply` | POST | User | `USERNAME_CHECK_LIMITER` | Apply stored referral code after auth |
| `/v1/promo/redeem` | POST | User | None (auth required) | Redeem a promo code |
| `/v1/orgs/:orgId/billing` | GET | User | None (auth required) | Updated to include referral stats + bonus domains |

**`/v1/referral/apply` response:**
```typescript
// Valid code, successfully applied
{ applied: true }

// Invalid code (doesn't exist), self-referral, or already referred
{ applied: false, reason?: 'invalid' | 'self_referral' | 'already_referred' }

// Rate limited
{ error: 'rate_limited', message: 'Too many requests. Try again in a minute.' }
```

### Updated Billing Response

```typescript
// GET /v1/orgs/:orgId/billing
{
  billing: { /* existing */ },
  entitlements: {
    custom_domains_base: 3,        // from tier
    custom_domains_bonus: 2,       // from active credits (capped at 25)
    custom_domains_bonus_max: 25,  // cap for display
    custom_domains_total: 5,       // base + bonus
    custom_domains_used: 1,
    custom_domains_available: 4,
    custom_domains_pending: 1,     // pending bonus (unlocks on payment)
  },
  referral: {
    code: "hellno",                // username or null if not set
    link: "getjack.org/?ref=hellno", // full shareable link (null if no username)
    successful_referrals: 2,
    pending_referrals: 1,
    domains_earned: 2,
  }
}
```

### Referral Flow

```
1. User A signs up, sets username "alice"
   └─> referral code = "alice"

2. User A shares: getjack.org/?ref=alice
   └─> Billing page shows link + copy button

3. User B visits getjack.org/?ref=alice
   └─> Web UI: capture ?ref=alice, store in localStorage
   └─> User B clicks "Sign in" → WorkOS auth

4. User B completes auth, web UI calls POST /v1/referral/apply {code: "alice"}
   └─> Validate: code exists (username lookup), not self-referral, not already referred
   └─> Get User B's first/primary org (earliest created)
   └─> INSERT credit: {org: B's primary org, type: 'referral_received', status: 'pending', code: 'alice'}
   └─> Clear localStorage
   └─> User B sees "+1 domain (unlocks when you upgrade)" in billing

5. User B makes first payment (Stripe or Daimo webhook)
   └─> qualifyReferral(B's primary org)
   └─> UPDATE credits SET status = 'active' WHERE org_id = B AND status = 'pending'
   └─> Look up User A's org via username
   └─> INSERT credit: {org: A, type: 'referral_given', status: 'active', code: 'alice', source_org_id: B}
   └─> Both A and B now have +1 active bonus domain (no notification, visible on next billing page visit)
```

### Promo Code Flow

```
1. Admin creates single-use promo codes via D1 console:
   INSERT INTO promo_codes (code, amount) VALUES ('LAUNCH-ABC123', 1);
   INSERT INTO promo_codes (code, amount) VALUES ('LAUNCH-DEF456', 1);
   (Generate unique codes for each user/giveaway)

2. User enters code in billing page → POST /v1/promo/redeem {code: "LAUNCH-ABC123"}

3. Backend validates:
   - Code exists
   - Not already redeemed (redeemed_by_org_id IS NULL)

4. If valid:
   └─> UPDATE promo_codes SET redeemed_by_org_id = ?, redeemed_at = NOW()
   └─> INSERT credit: {org: user.orgId, type: 'promo', status: 'active', code: 'LAUNCH-ABC123'}
   └─> User immediately has +1 bonus domain
```

### Key Files to Modify

**Control Plane (apps/control-plane):**
| File | Changes |
|------|---------|
| `migrations/0021_create_credits.sql` | New tables |
| `src/types.ts` | Add Credit, PromoCode, CreditType, CreditStatus |
| `src/credits-service.ts` | New service file |
| `src/index.ts` | Add endpoints, update billing response, hook into payment webhooks |

**Web UI (cozy-paws-relate) - separate implementation chunk:**
| File | Changes |
|------|---------|
| `src/App.tsx` or landing | Capture `?ref=` param on page load, store in localStorage |
| `src/App.tsx` (post-auth) | After auth, call `POST /v1/referral/apply` with stored code, clear localStorage |
| `src/components/BillingPage.tsx` | Add referral section (see UX spec below) |
| `src/components/BillingPage.tsx` | Add expandable promo code input |
| Entitlements display | Add expandable promo code input here too |

**Web UI - Referral Section UX:**
```
┌─ Your Referral Code ────────────────────────┐
│                                             │
│  [If username set:]                         │
│  Share your link: getjack.org/?ref=hellno   │
│  [Copy Link]                                │
│                                             │
│  Successful referrals: 2                    │
│  Pending referrals: 1                       │
│  Bonus domains earned: 2                    │
│                                             │
│  [If NO username:]                          │
│  Set a username to get your referral code   │
│  [Go to Settings →]                         │
│                                             │
└─────────────────────────────────────────────┘

┌─ Bonus Domains ─────────────────────────────┐
│                                             │
│  From referrals: 2                          │
│  From promo codes: 1                        │
│  ─────────────────                          │
│  Total bonus: 3 / 25 max                    │
│                                             │
│  [If pending referral:]                     │
│  +1 domain (unlocks when you upgrade)       │
│                                             │
│  ▸ Have a promo code?                       │
│    [________] [Redeem]                      │
│                                             │
└─────────────────────────────────────────────┘
```

### Existing Code to Leverage

- `TIER_LIMITS` from `src/types.ts:222-226` for base domain limits
- `BillingService.isPaidTier()` from `src/billing-service.ts:183-197` for paid status check
- `DaimoBillingService.handlePaymentSuccess()` and Stripe webhook handlers for payment triggers
- `ensureOrgForUser()` from `src/index.ts:4350` as reference for org lookup patterns
- `USERNAME_CHECK_LIMITER` from `wrangler.toml:45-48` - already configured (30 req/60s), reuse for referral apply endpoint
- Rate limit pattern from `src/index.ts:418-427` - copy for referral endpoint

## Edge Cases

| Case | Handling |
|------|----------|
| User uses own referral code | Return `{applied: false, reason: 'self_referral'}` |
| Referral code doesn't exist | Return `{applied: false, reason: 'invalid'}` |
| User already referred | Return `{applied: false, reason: 'already_referred'}` |
| Promo code already used (by anyone) | Return error "Code already redeemed" |
| Promo code doesn't exist | Return error "Invalid code" |
| Referrer deletes account | Referred user keeps their active bonus |
| User has pending referral, never pays | Credits stay pending forever (harmless) |
| Rate limit exceeded | Return 429 with "Too many requests" message |
| User at 25 bonus domain cap | Still allow earning credits, but entitlements capped at 25 |

## Verification

### End-to-end referral test
1. User A sets username "alice"
2. User B signs up via `getjack.org/?ref=alice`
3. Verify: User B sees "+1 domain (unlocks when you upgrade)" in billing (`custom_domains_pending: 1`)
4. User B makes a Daimo payment
5. Verify: credits table has 2 active rows (A: referral_given, B: referral_received)
6. Verify: Both A and B see +1 in `custom_domains_bonus` on billing endpoint
7. Verify: User B no longer sees pending bonus (`custom_domains_pending: 0`)

### Promo code test
1. Insert `('TEST1', 1)` into promo_codes
2. User X calls POST /v1/promo/redeem {code: 'TEST1'} → success, +1 domain
3. User Y calls POST /v1/promo/redeem {code: 'TEST1'} → error "Code already redeemed"
4. Verify promo_codes row has redeemed_by_org_id = X's org

### Entitlements math test
- Free user (base: 0) + 2 bonus domains = 2 total, can create 2 domains
- Pro user (base: 3) + 2 bonus domains = 5 total, can create 5 domains

### Bonus cap test
- User with 30 credits in database → `custom_domains_bonus` returns 25 (capped)

### No username test
- User without username → billing shows `referral.code: null`, `referral.link: null`
- Web UI shows "Set a username to get your referral code"

## Admin: Creating Promo Codes

Each code is single-use. Generate unique codes for each user/giveaway.

Connect to D1 database via Cloudflare dashboard or wrangler:

```sql
-- Create single-use codes (one per user)
INSERT INTO promo_codes (code, amount) VALUES ('LAUNCH-ABC123', 1);
INSERT INTO promo_codes (code, amount) VALUES ('LAUNCH-DEF456', 1);
INSERT INTO promo_codes (code, amount) VALUES ('LAUNCH-GHI789', 1);

-- Create a batch of 10 codes with a simple pattern
INSERT INTO promo_codes (code, amount) VALUES
  ('BETA-001', 1), ('BETA-002', 1), ('BETA-003', 1),
  ('BETA-004', 1), ('BETA-005', 1), ('BETA-006', 1),
  ('BETA-007', 1), ('BETA-008', 1), ('BETA-009', 1),
  ('BETA-010', 1);

-- Check which codes have been used
SELECT code, redeemed_by_org_id, redeemed_at FROM promo_codes WHERE redeemed_by_org_id IS NOT NULL;
```

## Open Questions

None - all requirements clarified during interview.
