-- Backfill org_billing with free tier for all existing orgs that don't have a billing record
INSERT INTO org_billing (org_id, plan_tier, plan_status)
SELECT id, 'free', 'active'
FROM orgs
WHERE id NOT IN (SELECT org_id FROM org_billing);
