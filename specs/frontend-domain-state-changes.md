# Frontend Agent Prompt: Custom Domain State Changes

## Context

We've updated the custom domain system to use a **DNS-first verification flow**. The backend API now returns new fields and statuses that the web UI needs to display.

## API Changes Summary

### New Domain Statuses

The `status` field can now have these values:

| Status | Meaning | User Action Needed |
|--------|---------|-------------------|
| `pending_dns` | **NEW** - Waiting for CNAME setup | Show DNS instructions |
| `pending_owner` | Waiting for TXT ownership verification | Show TXT instructions |
| `pending_ssl` | SSL certificate being issued | Show "Please wait..." |
| `active` | Domain is working | Show green checkmark |
| `unassigned` | **NEW** - Was active, now unassigned from project | Show "Ready to assign" |
| `moved` | DNS no longer points to us | Show "Delete and re-add" |
| `expired` | **NEW** - Timed out after 7 days | Show "Delete to free hostname" |
| `deleted` | **NEW** - Soft deleted (hidden) | Don't display |
| `blocked` | Cloudflare blocked | Show "Contact support" |
| `failed` | Setup failed | Show "Delete and re-add" |

### New Response Fields

The domain API response now includes:

```typescript
interface DomainResponse {
  id: string;
  hostname: string;
  status: DomainStatus;
  ssl_status: string | null;

  // NEW: DNS verification state
  dns?: {
    verified: boolean;           // true if CNAME points to runjack.xyz
    checked_at: string | null;   // ISO timestamp of last check
    current_target: string | null; // What the CNAME currently points to
    expected_target: string;     // Always "runjack.xyz"
    error: string | null;        // Error message if DNS check failed
  };

  // NEW: What user should do next
  next_step?: {
    action: "add_cname" | "add_txt" | "wait" | "delete" | "none";
    record_type?: "CNAME" | "TXT";
    record_name?: string;        // e.g., "app" for app.example.com
    record_value?: string;       // e.g., "runjack.xyz" or TXT value
    message: string;             // Human-readable instruction
  };

  created_at: string;
  updated_at?: string;
}
```

### New Endpoint

```
POST /v1/domains/:domainId/verify
```

Manually triggers DNS verification. Returns:
```typescript
{
  domain: DomainResponse;
  dns_check?: {
    verified: boolean;
    target: string | null;
    error: string | null;
  };
}
```

## UI Implementation Tasks

### 1. Domain Status Display

Update the domain status badge/indicator:

```tsx
function getDomainStatusBadge(status: DomainStatus) {
  switch (status) {
    case 'active':
      return <Badge variant="success">Working</Badge>;
    case 'unassigned':
      return <Badge variant="info">Ready</Badge>;
    case 'pending_dns':
      return <Badge variant="warning">Configure DNS</Badge>;
    case 'pending_owner':
      return <Badge variant="warning">Verify Ownership</Badge>;
    case 'pending_ssl':
      return <Badge variant="warning">Issuing SSL</Badge>;
    case 'moved':
      return <Badge variant="error">DNS Changed</Badge>;
    case 'expired':
      return <Badge variant="error">Expired</Badge>;
    case 'blocked':
    case 'failed':
      return <Badge variant="error">Failed</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}
```

### 2. DNS Instructions Component

Show DNS setup instructions when `status === 'pending_dns'` or when `next_step.action === 'add_cname'`:

```tsx
function DnsInstructions({ domain }: { domain: DomainResponse }) {
  if (!domain.next_step || domain.next_step.action === 'none') return null;

  const { next_step, dns } = domain;

  return (
    <div className="dns-instructions">
      <h4>Setup Required</h4>
      <p>{next_step.message}</p>

      {next_step.action === 'add_cname' && (
        <div className="record-card">
          <div className="record-type">CNAME Record</div>
          <div className="record-row">
            <span className="label">Name:</span>
            <code>{next_step.record_name}</code>
          </div>
          <div className="record-row">
            <span className="label">Value:</span>
            <code>{next_step.record_value}</code>
          </div>
        </div>
      )}

      {next_step.action === 'add_txt' && (
        <div className="record-card">
          <div className="record-type">TXT Record</div>
          <div className="record-row">
            <span className="label">Name:</span>
            <code>{next_step.record_name}</code>
          </div>
          <div className="record-row">
            <span className="label">Value:</span>
            <code>{next_step.record_value}</code>
          </div>
        </div>
      )}

      {/* Show current DNS error if available */}
      {dns?.error && (
        <div className="dns-error">
          <span className="icon">⚠️</span>
          <span>{dns.error}</span>
        </div>
      )}

      {/* Manual verify button */}
      {next_step.action === 'add_cname' && (
        <Button onClick={handleVerify}>Check DNS Now</Button>
      )}
    </div>
  );
}
```

### 3. Domain List Updates

Filter out `deleted` domains from display:

```tsx
const visibleDomains = domains.filter(d => d.status !== 'deleted');
```

Show appropriate actions based on status:

```tsx
function DomainActions({ domain }: { domain: DomainResponse }) {
  const canVerify = domain.status === 'pending_dns';
  const canAssign = domain.status === 'unassigned';
  const canDelete = ['pending_dns', 'unassigned', 'moved', 'expired', 'failed', 'blocked'].includes(domain.status);

  return (
    <div className="actions">
      {canVerify && <Button onClick={() => verifyDomain(domain.id)}>Check DNS</Button>}
      {canAssign && <Button onClick={() => openAssignModal(domain.id)}>Assign to Project</Button>}
      {canDelete && <Button variant="danger" onClick={() => deleteDomain(domain.id)}>Delete</Button>}
    </div>
  );
}
```

### 4. Verify Domain API Call

```tsx
async function verifyDomain(domainId: string) {
  const response = await fetch(`/v1/domains/${domainId}/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  const result = await response.json();

  if (result.dns_check?.verified) {
    toast.success('DNS verified! SSL certificate being issued...');
  } else if (result.dns_check?.error) {
    toast.warning(`DNS not ready: ${result.dns_check.error}`);
  }

  // Refresh domain list
  refetchDomains();
}
```

### 5. Status-Specific Messaging

| Status | Primary Message | Secondary Message |
|--------|-----------------|-------------------|
| `pending_dns` | "Configure your DNS" | "Add CNAME record pointing to runjack.xyz" |
| `pending_owner` | "Verify domain ownership" | "Add the TXT record shown below" |
| `pending_ssl` | "Issuing SSL certificate" | "This usually takes 1-2 minutes" |
| `active` | "Domain is working!" | Shows the live URL |
| `unassigned` | "Ready to assign" | "Assign to a project to start routing traffic" |
| `moved` | "DNS configuration changed" | "Delete and re-add the domain to restore" |
| `expired` | "Domain setup expired" | "Delete to free the hostname" |
| `failed` | "Setup failed" | "Delete and try adding the domain again" |

### 6. Auto-Refresh Behavior

For domains in `pending_dns`, `pending_ssl`, or `pending_owner` status:
- Poll every 30 seconds to check for status updates
- Stop polling when status becomes `active`, `failed`, `moved`, or `expired`

```tsx
useEffect(() => {
  const pendingStatuses = ['pending_dns', 'pending_ssl', 'pending_owner'];
  const hasPending = domains.some(d => pendingStatuses.includes(d.status));

  if (!hasPending) return;

  const interval = setInterval(() => refetchDomains(), 30000);
  return () => clearInterval(interval);
}, [domains]);
```

## Testing Checklist

- [ ] Domain with `pending_dns` status shows CNAME instructions
- [ ] Domain with `pending_owner` status shows TXT instructions
- [ ] Domain with `pending_ssl` status shows "Issuing SSL" message
- [ ] Domain with `active` status shows green "Working" badge
- [ ] Domain with `unassigned` status shows "Ready" badge with "Assign to Project" button
- [ ] Domain with `moved` status shows "DNS Changed" with delete option
- [ ] Domain with `expired` status shows "Expired" with delete option
- [ ] Domains with `deleted` status are hidden from list
- [ ] "Check DNS" button triggers verification and shows result
- [ ] DNS error message is displayed when present
- [ ] Auto-refresh works for pending domains
- [ ] Reassigning an `unassigned` domain activates instantly (no DNS/TXT prompts)

## Files to Modify

Based on your frontend structure, likely files to update:
- Domain list component
- Domain detail/card component
- Domain status badge component
- API client/hooks for domain operations
- Add verify domain mutation/action
