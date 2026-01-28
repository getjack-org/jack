-- Credits ledger for referrals, promos, and manual adjustments
CREATE TABLE IF NOT EXISTS credits (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL,           -- 'referral_given' | 'referral_received' | 'promo' | 'manual'
  status TEXT NOT NULL DEFAULT 'active',  -- 'pending' | 'active'
  amount INTEGER NOT NULL,
  code TEXT,                    -- referral or promo code
  source_org_id TEXT,           -- for referrals: the other party
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (org_id) REFERENCES orgs(id)
);

CREATE INDEX IF NOT EXISTS idx_credits_org_id ON credits(org_id);
CREATE INDEX IF NOT EXISTS idx_credits_code ON credits(code);
CREATE INDEX IF NOT EXISTS idx_credits_type ON credits(type);
CREATE INDEX IF NOT EXISTS idx_credits_status ON credits(status);

-- Simplified promo codes (one-time use)
CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,
  amount INTEGER NOT NULL DEFAULT 1,
  redeemed_by_org_id TEXT,
  redeemed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
