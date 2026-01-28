# Referral Flow Testing Guide

This document provides step-by-step instructions for testing the referral system in Jack Cloud.

## Verified Billing API Response

The billing endpoint (`GET /v1/orgs/:orgId/billing`) returns the expected format:

```json
{
  "plan": {
    "tier": "free",
    "is_paid": false
  },
  "referrals": {
    "code": "hellno",
    "successful": 0,
    "pending": 0,
    "cap": 25
  },
  "limits": {
    "custom_domains": {
      "limit": 1,
      "used": 1
    }
  }
}
```

**Response fields:**
- `plan.tier`: Current plan tier (`"free"` or `"pro"`)
- `plan.is_paid`: Whether the org has an active paid subscription
- `referrals.code`: The user's referral code (their username, or `null` if no username set)
- `referrals.successful`: Number of successful referrals (referees who have paid)
- `referrals.pending`: Number of pending referrals (referees who signed up but haven't paid)
- `referrals.cap`: Maximum bonus domains from referrals (25)
- `limits.custom_domains.limit`: Total custom domains allowed (tier base + bonus)
- `limits.custom_domains.used`: Number of custom domains currently in use

---

## Test Method 1: Two Browser Windows (Different Accounts)

Use this method to test the full referral flow with different user accounts.

### Prerequisites
- Two different email addresses for authentication
- Access to getjack.org in two browser windows (use incognito/private for the second)

### Setup User A (Referrer)

1. Open browser window 1 at `https://getjack.org`
2. Sign in with email A
3. Go to Settings and set a username (e.g., `testuser-a`)
4. Go to Billing page
5. Verify referral code appears:
   - Should see "Your referral link: getjack.org/?ref=testuser-a"
   - Copy the referral link

### Setup User B (Referee)

1. Open browser window 2 (incognito/private)
2. Navigate to the referral link: `https://getjack.org/?ref=testuser-a`
3. Sign in with email B (new account)
4. After auth completes, check the billing page

### Expected Results After Signup

**User A's billing response:**
```json
{
  "referrals": {
    "code": "testuser-a",
    "successful": 0,
    "pending": 1,
    "cap": 25
  }
}
```

**User B's billing response:**
```json
{
  "referrals": {
    "code": null,
    "successful": 0,
    "pending": 0,
    "cap": 25
  },
  "limits": {
    "custom_domains": {
      "limit": 0,
      "used": 0
    }
  }
}
```

### Complete Referral (User B Makes Payment)

1. In User B's browser, go to Billing page
2. Click "Upgrade to Pro"
3. Complete payment (Stripe or Daimo)

### Expected Results After Payment

**User A's billing response:**
```json
{
  "referrals": {
    "code": "testuser-a",
    "successful": 1,
    "pending": 0,
    "cap": 25
  },
  "limits": {
    "custom_domains": {
      "limit": 2,
      "used": 1
    }
  }
}
```
- `successful` increased from 0 to 1
- `limit` increased by 1 (bonus domain earned)

**User B's billing response:**
```json
{
  "plan": {
    "tier": "pro",
    "is_paid": true
  },
  "referrals": {
    "code": null,
    "successful": 0,
    "pending": 0,
    "cap": 25
  },
  "limits": {
    "custom_domains": {
      "limit": 4,
      "used": 0
    }
  }
}
```
- `tier` changed to `"pro"`
- `is_paid` changed to `true`
- `limit` is now 4 (3 pro base + 1 referral bonus)

---

## Test Method 2: Two Jack CLI Installs (Different Config Dirs)

Use this method to test the API directly without browser UI.

### Prerequisites
- Jack CLI installed
- Two terminal windows
- Two different email addresses

### Setup Isolated Environments

**Terminal 1 (User A):**
```bash
# Use custom config directory for User A
export XDG_CONFIG_HOME=/tmp/jack-test-user-a
mkdir -p $XDG_CONFIG_HOME/jack

# Authenticate
cd /path/to/some/project
jack auth login

# Set username
jack auth username set testuser-a

# Get auth token and org ID
cat $XDG_CONFIG_HOME/jack/auth.json | jq .
```

**Terminal 2 (User B):**
```bash
# Use custom config directory for User B
export XDG_CONFIG_HOME=/tmp/jack-test-user-b
mkdir -p $XDG_CONFIG_HOME/jack

# Authenticate
cd /path/to/some/project
jack auth login
```

### Test Referral API Flow

**Step 1: Get User A's billing info**
```bash
# Terminal 1 (User A)
TOKEN_A=$(cat $XDG_CONFIG_HOME/jack/auth.json | jq -r '.access_token')
ORG_A=$(cat $XDG_CONFIG_HOME/jack/auth.json | jq -r '.org_id')

curl -s -H "Authorization: Bearer $TOKEN_A" \
  "https://control.getjack.org/v1/orgs/$ORG_A/billing" | jq .
```

Expected: `referrals.code` should be `"testuser-a"`

**Step 2: Apply referral code for User B**
```bash
# Terminal 2 (User B)
TOKEN_B=$(cat $XDG_CONFIG_HOME/jack/auth.json | jq -r '.access_token')

# Apply the referral code
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN_B" \
  -H "Content-Type: application/json" \
  -d '{"code": "testuser-a"}' \
  "https://control.getjack.org/v1/referral/apply" | jq .
```

Expected response:
```json
{"applied": true}
```

**Step 3: Verify pending referral on User A**
```bash
# Terminal 1 (User A)
curl -s -H "Authorization: Bearer $TOKEN_A" \
  "https://control.getjack.org/v1/orgs/$ORG_A/billing" | jq .
```

Expected: `referrals.pending` should be `1`

**Step 4: Make payment for User B**

Use the checkout endpoint to get a payment URL:
```bash
# Terminal 2 (User B)
ORG_B=$(cat $XDG_CONFIG_HOME/jack/auth.json | jq -r '.org_id')

# Create Daimo checkout
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN_B" \
  -H "Content-Type: application/json" \
  -d '{"success_url": "https://getjack.org/billing?success=true"}' \
  "https://control.getjack.org/v1/orgs/$ORG_B/billing/checkout/daimo" | jq .
```

Complete the payment at the returned URL.

**Step 5: Verify completed referral**
```bash
# Terminal 1 (User A) - check referral completed
curl -s -H "Authorization: Bearer $TOKEN_A" \
  "https://control.getjack.org/v1/orgs/$ORG_A/billing" | jq .

# Terminal 2 (User B) - check bonus domain applied
curl -s -H "Authorization: Bearer $TOKEN_B" \
  "https://control.getjack.org/v1/orgs/$ORG_B/billing" | jq .
```

---

## Edge Case Tests

### Self-Referral Prevention
```bash
# Try to apply own referral code
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN_A" \
  -H "Content-Type: application/json" \
  -d '{"code": "testuser-a"}' \
  "https://control.getjack.org/v1/referral/apply" | jq .
```

Expected:
```json
{"applied": false, "reason": "self_referral"}
```

### Invalid Referral Code
```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN_B" \
  -H "Content-Type: application/json" \
  -d '{"code": "nonexistent-user-xyz"}' \
  "https://control.getjack.org/v1/referral/apply" | jq .
```

Expected:
```json
{"applied": false, "reason": "invalid"}
```

### Duplicate Referral Prevention
```bash
# After already applying a referral, try to apply another
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN_B" \
  -H "Content-Type: application/json" \
  -d '{"code": "another-user"}' \
  "https://control.getjack.org/v1/referral/apply" | jq .
```

Expected:
```json
{"applied": false, "reason": "already_referred"}
```

### No Username Set
If User B never set a username, their billing response should show:
```json
{
  "referrals": {
    "code": null,
    "successful": 0,
    "pending": 0,
    "cap": 25
  }
}
```

---

## API Endpoints Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /v1/orgs/:orgId/billing` | GET | Get billing info including referral stats |
| `POST /v1/referral/apply` | POST | Apply a referral code (body: `{"code": "username"}`) |
| `POST /v1/orgs/:orgId/billing/checkout/daimo` | POST | Create Daimo payment checkout |
| `POST /v1/orgs/:orgId/billing/checkout/stripe` | POST | Create Stripe payment checkout |

---

## Cleanup

After testing, clean up the test config directories:
```bash
rm -rf /tmp/jack-test-user-a
rm -rf /tmp/jack-test-user-b
```
