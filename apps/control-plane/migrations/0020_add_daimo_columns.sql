-- Add Daimo payment columns to org_billing
ALTER TABLE org_billing ADD COLUMN daimo_payment_id TEXT;
ALTER TABLE org_billing ADD COLUMN payment_provider TEXT;

-- Index for looking up by daimo payment ID (used in webhooks)
CREATE INDEX idx_org_billing_daimo_payment_id ON org_billing(daimo_payment_id);
