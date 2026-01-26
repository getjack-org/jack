-- Organization billing table for Stripe subscription management
CREATE TABLE IF NOT EXISTS org_billing (
  org_id TEXT PRIMARY KEY,
  plan_tier TEXT NOT NULL DEFAULT 'free', -- free | pro | team
  plan_status TEXT NOT NULL DEFAULT 'active', -- active | trialing | past_due | canceled | unpaid | incomplete | incomplete_expired
  current_period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  trial_end TEXT,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id TEXT,
  stripe_product_id TEXT,
  stripe_status TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (org_id) REFERENCES orgs(id)
);

CREATE INDEX IF NOT EXISTS idx_org_billing_plan_tier ON org_billing(plan_tier);
CREATE INDEX IF NOT EXISTS idx_org_billing_stripe_customer_id ON org_billing(stripe_customer_id);

-- Trigger to update updated_at on row changes
CREATE TRIGGER IF NOT EXISTS org_billing_updated_at
  AFTER UPDATE ON org_billing
  FOR EACH ROW
BEGIN
  UPDATE org_billing SET updated_at = CURRENT_TIMESTAMP WHERE org_id = OLD.org_id;
END;
