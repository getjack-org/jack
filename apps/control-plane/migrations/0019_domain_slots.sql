-- Domain Slots: Make project_id nullable for claimed-but-unassigned domains
-- D1 doesn't support ALTER COLUMN, so we recreate the table

-- Step 1: Create new table with nullable project_id and 'claimed' default status
CREATE TABLE custom_domains_new (
  id TEXT PRIMARY KEY,                          -- dom_<uuid>
  project_id TEXT,                              -- NULL = claimed but unassigned
  org_id TEXT NOT NULL,                         -- Denormalized for entitlement queries
  hostname TEXT NOT NULL UNIQUE,                -- e.g., api.mycompany.com
  cloudflare_id TEXT,                           -- Custom hostname ID from Cloudflare API
  status TEXT NOT NULL DEFAULT 'claimed',       -- claimed, pending, pending_owner, pending_ssl, active, blocked, moved, failed, deleting
  ssl_status TEXT,                              -- pending_validation, pending_issuance, pending_deployment, active
  ownership_verification_type TEXT,             -- txt or cname
  ownership_verification_name TEXT,             -- DNS record name for verification
  ownership_verification_value TEXT,            -- DNS record value for verification
  validation_errors TEXT,                       -- JSON array of error messages
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (org_id) REFERENCES orgs(id)
);

-- Step 2: Copy existing data (all existing records have project_id set, so they stay "assigned")
INSERT INTO custom_domains_new (
  id, project_id, org_id, hostname, cloudflare_id, status, ssl_status,
  ownership_verification_type, ownership_verification_name, ownership_verification_value,
  validation_errors, created_at, updated_at
)
SELECT
  id, project_id, org_id, hostname, cloudflare_id, status, ssl_status,
  ownership_verification_type, ownership_verification_name, ownership_verification_value,
  validation_errors, created_at, updated_at
FROM custom_domains;

-- Step 3: Drop old table and trigger
DROP TRIGGER IF EXISTS custom_domains_updated_at;
DROP TABLE custom_domains;

-- Step 4: Rename new table
ALTER TABLE custom_domains_new RENAME TO custom_domains;

-- Step 5: Recreate indexes
CREATE INDEX idx_custom_domains_project_id ON custom_domains(project_id);
CREATE INDEX idx_custom_domains_org_id ON custom_domains(org_id);
CREATE INDEX idx_custom_domains_hostname ON custom_domains(hostname);
CREATE INDEX idx_custom_domains_status ON custom_domains(status);

-- Step 6: Recreate trigger for updated_at
CREATE TRIGGER custom_domains_updated_at
  AFTER UPDATE ON custom_domains
  FOR EACH ROW
BEGIN
  UPDATE custom_domains SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;
