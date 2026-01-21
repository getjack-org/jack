#!/bin/bash
# Test managed mode database commands without Cloudflare/wrangler auth
#
# This script simulates a user who:
# - IS logged into Jack Cloud (has ~/.jack/auth.json)
# - Is NOT logged into Cloudflare (no wrangler config)
# - Has NO CLOUDFLARE_API_TOKEN env var
#
# Usage: ./scripts/test-managed-mode-no-cf-auth.sh [project-dir]

set -e

PROJECT_DIR="${1:-$(pwd)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_PATH="$SCRIPT_DIR/../apps/cli/src/index.ts"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo ""
echo "======================================"
echo "Testing managed mode without CF auth"
echo "======================================"
echo ""

# Check if project is managed mode
if [ ! -f "$PROJECT_DIR/.jack/project.json" ]; then
    echo -e "${RED}Error: No .jack/project.json found in $PROJECT_DIR${NC}"
    echo "This test requires a managed (jack cloud) project."
    echo ""
    echo "Create one with: jack new my-test --cloud"
    exit 1
fi

DEPLOY_MODE=$(grep -o '"deploy_mode"[[:space:]]*:[[:space:]]*"[^"]*"' "$PROJECT_DIR/.jack/project.json" | sed 's/.*"\([^"]*\)"$/\1/')
if [ "$DEPLOY_MODE" != "managed" ]; then
    echo -e "${RED}Error: Project is not in managed mode (deploy_mode=$DEPLOY_MODE)${NC}"
    echo "This test requires a managed (jack cloud) project."
    exit 1
fi

echo -e "${GREEN}✓ Project is in managed mode${NC}"
echo ""

# Create temp HOME with just jack auth (no wrangler)
TEST_HOME=$(mktemp -d)
trap "rm -rf $TEST_HOME" EXIT

# Jack auth is stored in ~/.config/jack/auth.json
JACK_CONFIG_DIR="$HOME/.config/jack"
if [ -d "$JACK_CONFIG_DIR" ]; then
    mkdir -p "$TEST_HOME/.config"
    cp -r "$JACK_CONFIG_DIR" "$TEST_HOME/.config/jack"
    echo -e "${GREEN}✓ Copied Jack Cloud auth to test environment${NC}"
else
    echo -e "${RED}Error: No ~/.config/jack directory found. Please login first: jack login${NC}"
    exit 1
fi

# Don't copy wrangler config
if [ -d "$HOME/.wrangler" ]; then
    echo -e "${GREEN}✓ NOT copying ~/.wrangler (testing without wrangler auth)${NC}"
fi

echo ""
echo "Test environment:"
echo "  HOME=$TEST_HOME"
echo "  CLOUDFLARE_API_TOKEN=(unset)"
echo "  Project: $PROJECT_DIR"
echo ""

# Function to run jack command in isolated environment
run_jack() {
    HOME="$TEST_HOME" CLOUDFLARE_API_TOKEN="" bun run "$CLI_PATH" "$@"
}

# Test 1: jack services db info
echo "======================================"
echo "Test 1: jack services db info"
echo "======================================"
cd "$PROJECT_DIR"
if HOME="$TEST_HOME" CLOUDFLARE_API_TOKEN="" bun run "$CLI_PATH" services db 2>&1; then
    echo ""
    echo -e "${GREEN}✓ Test 1 PASSED: db info works without CF auth${NC}"
else
    echo ""
    echo -e "${RED}✗ Test 1 FAILED: db info failed without CF auth${NC}"
    exit 1
fi

echo ""
echo "======================================"
echo "All tests passed!"
echo "======================================"
echo ""
echo "Managed mode database commands work correctly without Cloudflare auth."
echo ""
