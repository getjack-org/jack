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
