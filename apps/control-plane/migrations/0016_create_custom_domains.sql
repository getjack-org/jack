-- Custom domains table for Cloudflare Custom Hostnames
CREATE TABLE IF NOT EXISTS custom_domains (
  id TEXT PRIMARY KEY,                          -- dom_<uuid>
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,                         -- Denormalized for entitlement queries
  hostname TEXT NOT NULL UNIQUE,                -- e.g., api.mycompany.com
  cloudflare_id TEXT,                           -- Custom hostname ID from Cloudflare API
  status TEXT NOT NULL DEFAULT 'pending',       -- pending, pending_owner, pending_ssl, active, blocked, moved, failed, deleting
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

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_custom_domains_project_id ON custom_domains(project_id);
CREATE INDEX IF NOT EXISTS idx_custom_domains_org_id ON custom_domains(org_id);
CREATE INDEX IF NOT EXISTS idx_custom_domains_hostname ON custom_domains(hostname);
CREATE INDEX IF NOT EXISTS idx_custom_domains_status ON custom_domains(status);

-- Trigger to update updated_at on row changes
CREATE TRIGGER IF NOT EXISTS custom_domains_updated_at
  AFTER UPDATE ON custom_domains
  FOR EACH ROW
BEGIN
  UPDATE custom_domains SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;
