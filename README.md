# jack

CLI for vibecoders to rapidly deploy to Cloudflare Workers.

## Install

```bash
# Install Bun (if needed)
curl -fsSL https://bun.sh/install | bash

# Run directly
bunx @getjack/jack new my-app

# Or install globally
bun add -g @getjack/jack
jack new my-app
```

## Usage

```bash
# Create a new project
jack new my-app

# Deploy to Cloudflare Workers
jack ship

# List your projects
jack list
```

## Requirements

- [Bun](https://bun.sh) >= 1.0.0
- Cloudflare account (for deployments)

## Releasing

This project uses [Semantic Versioning](https://semver.org/).

```bash
# Bump version, commit, and tag
npm version patch   # 0.1.1 → 0.1.2 (bug fixes)
npm version minor   # 0.1.1 → 0.2.0 (new features)
npm version major   # 0.1.1 → 1.0.0 (breaking changes)

# Push to trigger publish
git push && git push --tags
```

GitHub Actions automatically publishes to npm when a version tag is pushed.

## License

Apache-2.0
