#!/bin/bash
set -e

FIXTURES_DIR="/tmp/jack-test-fixtures"

echo "============================================"
echo "Setting up Jack test fixtures"
echo "============================================"
echo ""

# Clean up and create fixtures directory
echo "Cleaning up existing fixtures directory..."
rm -rf "$FIXTURES_DIR"
mkdir -p "$FIXTURES_DIR"
cd "$FIXTURES_DIR"

echo "Fixtures will be created in: $FIXTURES_DIR"
echo ""

# 1. vite-react
echo "============================================"
echo "[1/12] Creating vite-react fixture..."
echo "============================================"
bun create vite vite-react --template react-ts
cd vite-react && bun install
cd "$FIXTURES_DIR"
echo "vite-react fixture created successfully."
echo ""

# 2. vite-vue
echo "============================================"
echo "[2/12] Creating vite-vue fixture..."
echo "============================================"
bun create vite vite-vue --template vue-ts
cd vite-vue && bun install
cd "$FIXTURES_DIR"
echo "vite-vue fixture created successfully."
echo ""

# 3. hono-api
echo "============================================"
echo "[3/12] Creating hono-api fixture..."
echo "============================================"
mkdir -p hono-api
cd hono-api
cat > package.json << 'EOF'
{
  "name": "hono-api",
  "type": "module",
  "scripts": {
    "dev": "bun run --hot src/index.ts"
  }
}
EOF
bun add hono
mkdir -p src
cat > src/index.ts << 'EOF'
import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => {
  return c.json({ message: "Hello from Hono!" });
});

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

export default app;
EOF
cd "$FIXTURES_DIR"
echo "hono-api fixture created successfully."
echo ""

# 4. sveltekit-configured (with adapter-cloudflare)
echo "============================================"
echo "[4/12] Creating sveltekit-configured fixture..."
echo "============================================"
bunx --bun sv create sveltekit-configured --template minimal --types ts --no-add-ons --no-install
cd sveltekit-configured
bun install
bun add -d @sveltejs/adapter-cloudflare
# Update svelte.config.js to use cloudflare adapter
cat > svelte.config.js << 'EOF'
import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter()
	}
};

export default config;
EOF
cd "$FIXTURES_DIR"
echo "sveltekit-configured fixture created successfully."
echo ""

# 5. sveltekit-unconfigured (WITHOUT adapter-cloudflare, for error testing)
echo "============================================"
echo "[5/12] Creating sveltekit-unconfigured fixture..."
echo "============================================"
bunx --bun sv create sveltekit-unconfigured --template minimal --types ts --no-add-ons --no-install
cd sveltekit-unconfigured
bun install
cd "$FIXTURES_DIR"
echo "sveltekit-unconfigured fixture created successfully."
echo ""

# 6. unknown-project (express, for unknown type error testing)
echo "============================================"
echo "[6/12] Creating unknown-project fixture..."
echo "============================================"
mkdir -p unknown-project
cd unknown-project
cat > package.json << 'EOF'
{
  "name": "unknown-project",
  "type": "module",
  "scripts": {
    "start": "node src/index.js"
  }
}
EOF
bun add express
mkdir -p src
cat > src/index.js << 'EOF'
import express from 'express';

const app = express();

app.get('/', (req, res) => {
  res.json({ message: 'Hello from Express!' });
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});
EOF
cd "$FIXTURES_DIR"
echo "unknown-project fixture created successfully."
echo ""

# 7. no-package-json (empty folder, for error testing)
echo "============================================"
echo "[7/12] Creating no-package-json fixture..."
echo "============================================"
mkdir -p no-package-json
cd "$FIXTURES_DIR"
echo "no-package-json fixture created successfully."
echo ""

# 8. nextjs-unsupported (for unsupported framework error testing)
echo "============================================"
echo "[8/12] Creating nextjs-unsupported fixture..."
echo "============================================"
mkdir -p nextjs-unsupported
cd nextjs-unsupported
cat > package.json << 'EOF'
{
  "name": "nextjs-unsupported",
  "dependencies": {
    "next": "^14.0.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  }
}
EOF
cat > next.config.js << 'EOF'
module.exports = {}
EOF
cd "$FIXTURES_DIR"
echo "nextjs-unsupported fixture created successfully."
echo ""

# 9. astro-project (for coming-soon framework detection)
echo "============================================"
echo "[9/12] Creating astro-project fixture..."
echo "============================================"
mkdir -p astro-project
cd astro-project
cat > package.json << 'EOF'
{
  "name": "astro-project",
  "type": "module",
  "dependencies": {
    "astro": "^5.0.0"
  }
}
EOF
cat > astro.config.mjs << 'EOF'
import { defineConfig } from 'astro/config';
export default defineConfig({});
EOF
cd "$FIXTURES_DIR"
echo "astro-project fixture created successfully."
echo ""

# 10. react-router-project (for coming-soon framework detection)
echo "============================================"
echo "[10/12] Creating react-router-project fixture..."
echo "============================================"
mkdir -p react-router-project
cd react-router-project
cat > package.json << 'EOF'
{
  "name": "react-router-project",
  "type": "module",
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@react-router/dev": "^7.0.0"
  }
}
EOF
cat > vite.config.ts << 'EOF'
import { defineConfig } from 'vite';
export default defineConfig({});
EOF
cd "$FIXTURES_DIR"
echo "react-router-project fixture created successfully."
echo ""

# 11. nuxt-project (for coming-soon framework detection)
echo "============================================"
echo "[11/12] Creating nuxt-project fixture..."
echo "============================================"
mkdir -p nuxt-project
cd nuxt-project
cat > package.json << 'EOF'
{
  "name": "nuxt-project",
  "type": "module",
  "dependencies": {
    "nuxt": "^3.0.0",
    "vue": "^3.0.0"
  }
}
EOF
cat > nuxt.config.ts << 'EOF'
export default defineNuxtConfig({});
EOF
cd "$FIXTURES_DIR"
echo "nuxt-project fixture created successfully."
echo ""

# 12. tanstack-project (for coming-soon framework detection)
echo "============================================"
echo "[12/12] Creating tanstack-project fixture..."
echo "============================================"
mkdir -p tanstack-project
cd tanstack-project
cat > package.json << 'EOF'
{
  "name": "tanstack-project",
  "type": "module",
  "dependencies": {
    "react": "^19.0.0",
    "@tanstack/react-start": "^1.0.0"
  }
}
EOF
cat > vite.config.ts << 'EOF'
import { defineConfig } from 'vite';
export default defineConfig({});
EOF
cd "$FIXTURES_DIR"
echo "tanstack-project fixture created successfully."
echo ""

# Summary
echo "============================================"
echo "All fixtures created successfully!"
echo "============================================"
echo ""
echo "Created fixtures in $FIXTURES_DIR:"
ls -la "$FIXTURES_DIR"
echo ""
echo "Fixture details:"
echo "  1. vite-react             - Vite + React + TypeScript"
echo "  2. vite-vue               - Vite + Vue + TypeScript"
echo "  3. hono-api               - Minimal Hono API project"
echo "  4. sveltekit-configured   - SvelteKit with adapter-cloudflare"
echo "  5. sveltekit-unconfigured - SvelteKit without adapter (error testing)"
echo "  6. unknown-project        - Express project (unknown type error testing)"
echo "  7. no-package-json        - Empty folder (error testing)"
echo "  8. nextjs-unsupported     - Next.js project (unsupported framework)"
echo "  9. astro-project          - Astro project (coming-soon framework)"
echo " 10. react-router-project   - React Router v7 project (coming-soon framework)"
echo " 11. nuxt-project           - Nuxt project (coming-soon framework)"
echo " 12. tanstack-project       - TanStack Start project (coming-soon framework)"
echo ""
echo "Run 'jack ship' in each fixture directory to test auto-detection."
