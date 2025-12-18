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

## License

Apache-2.0
