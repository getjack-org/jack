#!/bin/bash
# Comprehensive test for managed mode without Cloudflare auth
#
# This script tests ALL database and project commands to verify they work
# for managed (Jack Cloud) users who don't have Cloudflare/wrangler auth.
#
# Usage: ./scripts/test-managed-mode-isolation.sh [project-dir]
#
# The script will:
# 1. Create an isolated environment (no wrangler auth, only Jack Cloud auth)
# 2. Run each command and report pass/fail
# 3. Show a summary of what works and what doesn't

set -e

PROJECT_DIR="${1:-$(pwd)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_PATH="$SCRIPT_DIR/../apps/cli/src/index.ts"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test results
declare -a PASSED=()
declare -a FAILED=()
declare -a SKIPPED=()

echo ""
echo "========================================"
echo "Managed Mode Isolation Test Suite"
echo "========================================"
echo ""

# Validate project
if [ ! -f "$PROJECT_DIR/.jack/project.json" ]; then
    echo -e "${RED}Error: No .jack/project.json found in $PROJECT_DIR${NC}"
    echo "This test requires a managed (Jack Cloud) project."
    exit 1
fi

DEPLOY_MODE=$(grep -o '"deploy_mode"[[:space:]]*:[[:space:]]*"[^"]*"' "$PROJECT_DIR/.jack/project.json" | sed 's/.*"\([^"]*\)"$/\1/')
if [ "$DEPLOY_MODE" != "managed" ]; then
    echo -e "${RED}Error: Project is not in managed mode (deploy_mode=$DEPLOY_MODE)${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Project is in managed mode${NC}"

# Check for database in the project (some tests require it)
HAS_DATABASE=false
if grep -q '"d1"' "$PROJECT_DIR/.jack/project.json" 2>/dev/null || \
   grep -q 'd1_databases' "$PROJECT_DIR/wrangler.jsonc" 2>/dev/null; then
    HAS_DATABASE=true
fi

# Create isolated environment
TEST_HOME=$(mktemp -d)
trap "rm -rf $TEST_HOME" EXIT

# Copy Jack Cloud auth only
JACK_CONFIG_DIR="$HOME/.config/jack"
if [ -d "$JACK_CONFIG_DIR" ]; then
    mkdir -p "$TEST_HOME/.config"
    cp -r "$JACK_CONFIG_DIR" "$TEST_HOME/.config/jack"
    echo -e "${GREEN}✓ Copied Jack Cloud auth${NC}"
else
    echo -e "${RED}Error: No ~/.config/jack directory. Run: jack login${NC}"
    exit 1
fi

echo -e "${GREEN}✓ NOT copying wrangler auth (simulating user without CF credentials)${NC}"
echo ""
echo "Test Environment:"
echo "  HOME=$TEST_HOME"
echo "  CLOUDFLARE_API_TOKEN=(unset)"
echo "  Project: $PROJECT_DIR"
echo ""

# Helper to run command in isolated environment
run_isolated() {
    HOME="$TEST_HOME" CLOUDFLARE_API_TOKEN="" "$@" 2>&1
}

# Helper to run a test
run_test() {
    local name="$1"
    local description="$2"
    shift 2

    echo "----------------------------------------"
    echo -e "${BLUE}Test: $name${NC}"
    echo "  $description"
    echo "  Command: $@"
    echo ""

    cd "$PROJECT_DIR"
    if output=$(run_isolated "$@" 2>&1); then
        echo "$output" | head -20
        if [ $(echo "$output" | wc -l) -gt 20 ]; then
            echo "  ... (truncated)"
        fi
        echo ""
        echo -e "${GREEN}✓ PASSED${NC}"
        PASSED+=("$name")
        return 0
    else
        echo "$output" | head -20
        echo ""
        echo -e "${RED}✗ FAILED${NC}"
        FAILED+=("$name")
        return 1
    fi
}

# Helper for tests that should be skipped
skip_test() {
    local name="$1"
    local reason="$2"
    echo "----------------------------------------"
    echo -e "${BLUE}Test: $name${NC}"
    echo -e "${YELLOW}⊘ SKIPPED: $reason${NC}"
    SKIPPED+=("$name")
}

echo ""
echo "========================================"
echo "Running Tests"
echo "========================================"

# Test 1: jack services db (info)
run_test "db-info" \
    "Get database info via control plane" \
    bun run "$CLI_PATH" services db || true

# Test 2: jack services db list
run_test "db-list" \
    "List databases (currently uses wrangler)" \
    bun run "$CLI_PATH" services db list || true

# Test 3: jack services db execute (read query)
if [ "$HAS_DATABASE" = true ]; then
    run_test "db-execute-read" \
        "Execute read-only SQL query" \
        bun run "$CLI_PATH" services db execute "SELECT 1 as test" || true
else
    skip_test "db-execute-read" "No database configured in project"
fi

# Test 4: jack info
run_test "project-info" \
    "Get project info (calls checkWorkerExists)" \
    bun run "$CLI_PATH" info || true

# Test 5: jack services db export
run_test "db-export" \
    "Export database to SQL file" \
    bun run "$CLI_PATH" services db export || true

# Summary
echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
echo ""

if [ ${#PASSED[@]} -gt 0 ]; then
    echo -e "${GREEN}PASSED (${#PASSED[@]}):${NC}"
    for t in "${PASSED[@]}"; do
        echo -e "  ${GREEN}✓${NC} $t"
    done
    echo ""
fi

if [ ${#FAILED[@]} -gt 0 ]; then
    echo -e "${RED}FAILED (${#FAILED[@]}):${NC}"
    for t in "${FAILED[@]}"; do
        echo -e "  ${RED}✗${NC} $t"
    done
    echo ""
fi

if [ ${#SKIPPED[@]} -gt 0 ]; then
    echo -e "${YELLOW}SKIPPED (${#SKIPPED[@]}):${NC}"
    for t in "${SKIPPED[@]}"; do
        echo -e "  ${YELLOW}⊘${NC} $t"
    done
    echo ""
fi

# Exit code based on failures
if [ ${#FAILED[@]} -gt 0 ]; then
    echo -e "${RED}Some tests failed. These commands need fixes for managed mode.${NC}"
    exit 1
else
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
fi
