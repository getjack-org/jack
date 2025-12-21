# Docs Site - Agent Context

## Build & Deploy

- **Framework**: Vocs (vocs.dev) - React-based docs framework
- **Build**: `bun run docs:build` → outputs to `docs/dist/`
- **Deploy**: GitHub Pages via Actions (NOT legacy branch mode)

## Critical: GitHub Pages Configuration

The repo must have `build_type: workflow` for the Actions deployment to work:

```bash
# Check current config
gh api repos/getjack-org/jack/pages

# If build_type is "legacy", fix it:
gh api repos/getjack-org/jack/pages -X PUT -f build_type=workflow
```

**Why this matters**: With `build_type: legacy`, GitHub ignores the workflow artifact and serves raw files from the branch path instead. The workflow shows green but the site 404s.

## Farcaster Miniapp Integration

The docs site is also a Farcaster miniapp. Key setup in `vocs.config.tsx`:

1. **Meta tag injection**: `fc:miniapp` meta tag with manifest JSON
2. **SDK initialization**: Must wait for page load before calling `ready()`

```typescript
// Correct pattern - wait for page load
import('https://esm.sh/@farcaster/miniapp-sdk@0.2.1').then(({ sdk }) => {
  if (document.readyState === 'complete') {
    sdk.actions.ready();
  } else {
    window.addEventListener('load', () => sdk.actions.ready());
  }
}).catch(() => {});
```

## Workflow Trigger Paths

The workflow (`.github/workflows/docs.yml`) triggers on:
- `docs/**` - any docs content changes
- `vocs.config.tsx` - config changes (note: `.tsx` not `.ts`)
- `.github/workflows/docs.yml` - workflow changes

## Debugging Checklist

If docs site returns 404:

1. Check GitHub Pages config: `gh api repos/getjack-org/jack/pages`
   - Must have `"build_type":"workflow"` not `"legacy"`
2. Check workflow ran: `gh run list --workflow=docs.yml --limit 3`
3. Check DNS: `dig docs.getjack.org` should resolve to GitHub IPs or Cloudflare proxy
4. Manual trigger: `gh workflow run docs.yml`
