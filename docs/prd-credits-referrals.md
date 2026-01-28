# Credits, Referrals & Promo Codes PRD

## Problem

Jack Cloud needs ways to:
1. Reward users for referring others (viral growth like Dropbox's 3900% growth)
2. Grant promotional benefits (trials, free domains) via codes
3. Track and audit all earned benefits

Current state: Domain limits are tier-based only (`free: 0`, `pro: 3`, `team: 10`). No way to earn additional domains or apply promo codes.

## Success Criteria

1. Users can share their referral code and earn +1 bonus domain per successful referral
2. Referred users also get +1 bonus domain when they sign up
3. Admin can create promo codes that grant bonus domains
4. All credits are auditable (who earned what, when, why)
5. Bonus domains stack on top of tier limits
6. System is simple: one new table, minimal code changes

## Scope

### In Scope
- Credits ledger table for tracking all earned benefits
- Referral code generation (use username)
- Referral tracking at signup (`?ref=code`)
- Referral qualification trigger (first deploy or first payment)
- Promo code validation and redemption
- Updated entitlements calculation (tier limit + bonus)
- API endpoints for checking referral stats

### Out of Scope
- Referral dashboard UI (future)
- Expiring credits (future)
- Cash/payment rewards (future)
- Multi-level referrals (future)
- Automated promo code generation (manual for now)

## Technical Approach

### New Migration

File: `apps/control-plane/migrations/0021_create_credits.sql`

```sql
-- Credits ledger: append-only log of all earned benefits
CREATE TABLE credits (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL,              -- 'referral_given' | 'referral_received' | 'promo' | 'manual'
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

-- Promo codes table (admin-managed)
CREATE TABLE promo_codes (
  code TEXT PRIMARY KEY,
  type TEXT NOT NULL,              -- 'bonus_domains' | 'trial_days' (future)
  amount INTEGER NOT NULL,         -- how many domains or days
  max_redemptions INTEGER,         -- NULL = unlimited
  expires_at DATETIME,             -- NULL = never expires
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Track promo redemptions (prevent double-use)
CREATE INDEX idx_credits_promo ON credits(org_id, code) WHERE type = 'promo';
```

### Schema Updates

File: `apps/control-plane/src/types.ts`

```typescript
// Credit types
export type CreditType = 'referral_given' | 'referral_received' | 'promo' | 'manual';

export interface Credit {
  id: string;
  org_id: string;
  type: CreditType;
  amount: number;
  code: string | null;
  source_org_id: string | null;
  note: string | null;
  created_at: string;
}

export interface PromoCode {
  code: string;
  type: 'bonus_domains' | 'trial_days';
  amount: number;
  max_redemptions: number | null;
  expires_at: string | null;
  created_at: string;
}
```

### New Service

File: `apps/control-plane/src/credits-service.ts`

```typescript
class CreditsService {
  // Get total bonus domains for an org
  async getBonusDomains(orgId: string): Promise<number>

  // Get referral stats for an org
  async getReferralStats(orgId: string): Promise<{
    code: string;              // their referral code (= username)
    successful_referrals: number;
    pending_referrals: number; // signed up but not qualified yet
    domains_earned: number;
  }>

  // Record a referral signup (called during user registration)
  async recordReferralSignup(referredOrgId: string, referralCode: string): Promise<void>

  // Qualify a referral (called on first deploy or payment)
  async qualifyReferral(orgId: string): Promise<void>

  // Redeem a promo code
  async redeemPromoCode(orgId: string, code: string): Promise<{
    success: boolean;
    amount?: number;
    error?: string;
  }>

  // Admin: create promo code
  async createPromoCode(code: string, amount: number, maxRedemptions?: number, expiresAt?: string): Promise<void>
}
```

### Updated Entitlements

File: `apps/control-plane/src/index.ts`

```typescript
// GET /v1/orgs/:orgId/billing - Updated response
{
  billing: {
    plan_tier: "free",
    plan_status: "active",
    payment_provider: "daimo",
    current_period_end: "2025-04-27T...",
    is_paid: true,
  },
  entitlements: {
    custom_domains_base: 3,        // from tier
    custom_domains_bonus: 2,       // from credits (referrals + promos)
    custom_domains_total: 5,       // base + bonus
    custom_domains_used: 1,
    custom_domains_available: 4,
  },
  referral: {
    code: "hellno",                // their shareable code
    successful_referrals: 2,
    domains_earned: 2,
  }
}
```

### New Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /v1/referral/stats` | User | Get own referral code and stats |
| `POST /v1/promo/redeem` | User | Redeem a promo code |
| `POST /v1/admin/promo` | Admin | Create a promo code |

### Referral Flow

```
1. User A signs up
   └─> referral_code = username (e.g., "hellno")

2. User A shares link: jack.dev/?ref=hellno

3. User B clicks link, signs up
   └─> Store ref=hellno in signup flow
   └─> After org created: recordReferralSignup(B.orgId, "hellno")
   └─> Creates pending referral record (no credits yet)

4. User B deploys first project OR makes first payment
   └─> qualifyReferral(B.orgId)
   └─> INSERT credit: {org: A, type: 'referral_given', amount: 1}
   └─> INSERT credit: {org: B, type: 'referral_received', amount: 1}
   └─> Both A and B now have +1 bonus domain
```

### Promo Code Flow

```
1. Admin creates code via DB or endpoint:
   INSERT INTO promo_codes (code, type, amount, max_redemptions)
   VALUES ('LAUNCH2025', 'bonus_domains', 1, 100)

2. User enters code in UI, calls POST /v1/promo/redeem {code: "LAUNCH2025"}

3. Backend validates:
   - Code exists
   - Not expired
   - Under max redemptions
   - User hasn't already redeemed this code

4. If valid:
   └─> INSERT credit: {org: user.orgId, type: 'promo', amount: 1, code: 'LAUNCH2025'}
   └─> User now has +1 bonus domain
```

### Key Files to Modify

| File | Changes |
|------|---------|
| `migrations/0021_create_credits.sql` | CREATE tables |
| `src/types.ts` | Add Credit, PromoCode types |
| `src/credits-service.ts` | CREATE new service |
| `src/index.ts` | Add endpoints, update entitlements |
| Auth worker | Pass `?ref=` param through signup |

## Edge Cases

| Case | Handling |
|------|----------|
| User uses own referral code | Reject (can't self-refer) |
| Referral code doesn't exist | Ignore silently, continue signup |
| User already referred by someone | First referral wins, ignore subsequent |
| Promo code already used by org | Return error "Already redeemed" |
| Promo code expired | Return error "Code expired" |
| Promo code at max redemptions | Return error "Code no longer valid" |
| Referrer deletes account | Referred user keeps their bonus |
| Negative bonus (future) | Support via negative `amount` in credits |

## Verification

1. **Referral flow test:**
   - User A has username "alice"
   - User B signs up with `?ref=alice`
   - User B deploys a project
   - Verify: Both A and B have +1 in credits table
   - Verify: Both A and B see +1 bonus domain in entitlements

2. **Promo code test:**
   - Create code "TEST1" with amount=1, max_redemptions=2
   - User X redeems → success, +1 domain
   - User X redeems again → error "Already redeemed"
   - User Y redeems → success
   - User Z redeems → error "Code no longer valid"

3. **Entitlements calculation:**
   - Free user with 2 bonus domains → can create 2 domains
   - Pro user with 2 bonus domains → can create 5 domains (3 + 2)

## Migration Path

For existing users:
- `bonus_domains` starts at 0 (no existing credits)
- Referral code = their username (if set) or NULL
- No backfill needed

## Future Enhancements

1. **Expiring credits**: Add `expires_at` to credits table
2. **Credit types**: Storage, API calls, etc.
3. **Referral tiers**: More rewards at 5, 10, 25 referrals
4. **Referral dashboard**: UI to see stats and share code
5. **Automated promos**: Time-limited campaigns
