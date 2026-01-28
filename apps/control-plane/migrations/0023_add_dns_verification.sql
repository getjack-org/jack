-- DNS-first domain verification: Add DNS verification columns and new statuses
-- D1 doesn't support ALTER COLUMN, so we recreate the table

-- Step 1: Create new table with DNS verification columns
-- New statuses: pending_dns (default), expired, deleted
-- New columns: dns_verified, dns_verified_at, dns_last_checked_at, dns_target, dns_error
CREATE TABLE custom_domains_new (
  id TEXT PRIMARY KEY,                          -- dom_<uuid>
  project_id TEXT,                              -- NULL = claimed but unassigned
  org_id TEXT NOT NULL,                         -- Denormalized for entitlement queries
  hostname TEXT NOT NULL,                       -- e.g., api.mycompany.com (unique constraint below)
  cloudflare_id TEXT,                           -- Custom hostname ID from Cloudflare API
  status TEXT NOT NULL DEFAULT 'pending_dns',   -- pending_dns, claimed, pending, pending_owner, pending_ssl, active, blocked, moved, failed, deleting, expired, deleted
  ssl_status TEXT,                              -- pending_validation, pending_issuance, pending_deployment, active
  ownership_verification_type TEXT,             -- txt or cname
  ownership_verification_name TEXT,             -- DNS record name for verification
  ownership_verification_value TEXT,            -- DNS record value for verification
  validation_errors TEXT,                       -- JSON array of error messages
  -- DNS verification columns
  dns_verified INTEGER DEFAULT 0,               -- 0 = not verified, 1 = verified
  dns_verified_at DATETIME,                     -- When DNS was verified
  dns_last_checked_at DATETIME,                 -- Last time we checked DNS
  dns_target TEXT,                              -- Current CNAME target we found
  dns_error TEXT,                               -- Last DNS check error message
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (org_id) REFERENCES orgs(id)
);

-- Step 2: Copy existing data
-- For existing 'active' domains, set dns_verified = 1 (they already work)
-- For other statuses, keep dns_verified = 0 (they need verification)
INSERT INTO custom_domains_new (
  id, project_id, org_id, hostname, cloudflare_id, status, ssl_status,
  ownership_verification_type, ownership_verification_name, ownership_verification_value,
  validation_errors, dns_verified, dns_verified_at, created_at, updated_at
)
SELECT
  id, project_id, org_id, hostname, cloudflare_id, status, ssl_status,
  ownership_verification_type, ownership_verification_name, ownership_verification_value,
  validation_errors,
  CASE WHEN status = 'active' THEN 1 ELSE 0 END,           -- dns_verified
  CASE WHEN status = 'active' THEN updated_at ELSE NULL END, -- dns_verified_at
  created_at, updated_at
FROM custom_domains;

-- Step 3: Drop old table and trigger
DROP TRIGGER IF EXISTS custom_domains_updated_at;
DROP TABLE custom_domains;

-- Step 4: Rename new table
ALTER TABLE custom_domains_new RENAME TO custom_domains;

-- Step 5: Create indexes
-- Standard indexes
CREATE INDEX idx_custom_domains_project_id ON custom_domains(project_id);
CREATE INDEX idx_custom_domains_org_id ON custom_domains(org_id);
CREATE INDEX idx_custom_domains_status ON custom_domains(status);

-- Unique constraint on hostname, excluding deleted/expired statuses
-- D1/SQLite doesn't support partial unique indexes directly, so we use a unique index with WHERE
CREATE UNIQUE INDEX idx_custom_domains_hostname_active ON custom_domains(hostname)
  WHERE status NOT IN ('deleted', 'expired');

-- Index for DNS polling: find domains that need checking
-- Optimized for query: SELECT * FROM custom_domains WHERE status = 'pending_dns' AND (dns_last_checked_at IS NULL OR dns_last_checked_at < ?)
CREATE INDEX idx_custom_domains_dns_check ON custom_domains(status, dns_last_checked_at);

-- Step 6: Recreate trigger for updated_at
CREATE TRIGGER custom_domains_updated_at
  AFTER UPDATE ON custom_domains
  FOR EACH ROW
BEGIN
  UPDATE custom_domains SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;
