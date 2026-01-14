#!/bin/bash
# Test runner for jack auto-detect feature
# Runs jack ship --dry-run against generated fixtures and verifies output
set -e

# Ensure non-interactive mode (skip prompts)
export CI=true

FIXTURES_DIR="${1:-/tmp/jack-test-fixtures}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JACK_CLI="$SCRIPT_DIR/../apps/cli/src/index.ts"
FAILED=0
PASSED=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "============================================"
echo "Jack Auto-Detect Test Runner"
echo "============================================"
echo ""
echo "Fixtures directory: $FIXTURES_DIR"
echo "Jack CLI: $JACK_CLI"
echo ""

# Validate wrangler.jsonc has correct structure for project type
validate_wrangler_config() {
  local config_file="$1"
  local project_type="$2"

  if [ ! -f "$config_file" ]; then
    echo "wrangler.jsonc not found"
    return 1
  fi

  local config=$(cat "$config_file")

  case "$project_type" in
    vite)
      # Vite SPAs should have assets.directory pointing to dist, NOT main entry
      if ! echo "$config" | grep -q '"assets"'; then
        echo "Vite project missing 'assets' config"
        return 1
      fi
      if ! echo "$config" | grep -q '"directory".*"./dist"'; then
        echo "Vite project should have assets.directory: './dist'"
        return 1
      fi
      # Vite SPAs should NOT have a main entry (assets-only mode)
      if echo "$config" | grep -q '"main"'; then
        echo "Vite SPA should not have 'main' entry (use assets-only mode)"
        return 1
      fi
      ;;
    hono)
      # Hono should have main entry pointing to an index file
      if ! echo "$config" | grep -q '"main"'; then
        echo "Hono project missing 'main' entry"
        return 1
      fi
      if ! echo "$config" | grep -qE '"main".*"(src/)?index\.ts"'; then
        echo "Hono project should have main pointing to index.ts"
        return 1
      fi
      # Hono should NOT have assets (it's an API, not SPA)
      if echo "$config" | grep -q '"assets"'; then
        echo "Hono API should not have 'assets' config"
        return 1
      fi
      ;;
    sveltekit)
      # SvelteKit should have assets pointing to .svelte-kit/cloudflare
      if ! echo "$config" | grep -q '"assets"'; then
        echo "SvelteKit project missing 'assets' config"
        return 1
      fi
      if ! echo "$config" | grep -q '.svelte-kit/cloudflare'; then
        echo "SvelteKit should have assets.directory: '.svelte-kit/cloudflare'"
        return 1
      fi
      ;;
  esac

  # All configs should have name and compatibility_date
  if ! echo "$config" | grep -q '"name"'; then
    echo "Config missing 'name' field"
    return 1
  fi
  if ! echo "$config" | grep -q '"compatibility_date"'; then
    echo "Config missing 'compatibility_date' field"
    return 1
  fi

  return 0
}

# Check if build output directory exists (warning, not failure)
check_build_output() {
  local fixture_dir="$1"
  local project_type="$2"

  case "$project_type" in
    vite)
      if [ -d "$fixture_dir/dist" ]; then
        return 0
      fi
      ;;
    sveltekit)
      if [ -d "$fixture_dir/.svelte-kit/cloudflare" ]; then
        return 0
      fi
      ;;
    hono)
      # Hono doesn't have a build output dir (it's bundled by wrangler)
      return 0
      ;;
  esac
  return 1
}

test_fixture() {
  local name="$1"
  local expected_output="$2"
  local should_fail="${3:-false}"
  local project_type="${4:-}"  # Optional: vite, hono, sveltekit

  echo -n "Testing: $name ... "

  # Check fixture exists
  if [ ! -d "$FIXTURES_DIR/$name" ]; then
    echo -e "${RED}SKIP${NC} (fixture not found)"
    return
  fi

  cd "$FIXTURES_DIR/$name"

  # Clean up any existing wrangler.jsonc and build outputs from previous runs
  rm -f wrangler.jsonc
  rm -rf dist .svelte-kit

  # Run jack ship with dry-run (tests detection, config generation, and build)
  local exit_code=0
  output=$("$JACK_CLI" ship --dry-run 2>&1) || exit_code=$?

  if [ "$should_fail" = "true" ]; then
    # Expected to fail
    if [ $exit_code -eq 0 ]; then
      echo -e "${RED}FAIL${NC}"
      echo "  Expected error but command succeeded"
      echo "  Output: $output"
      FAILED=$((FAILED + 1))
      return
    fi
  else
    # Expected to succeed
    if [ $exit_code -ne 0 ]; then
      echo -e "${RED}FAIL${NC}"
      echo "  Unexpected error (exit code $exit_code)"
      echo "  Output: $output"
      FAILED=$((FAILED + 1))
      return
    fi
  fi

  # Check expected output (use more specific pattern matching)
  if echo "$output" | grep -qi "$expected_output"; then
    if [ "$should_fail" = "false" ]; then
      # SUCCESS CASE: Validate wrangler.jsonc content
      if [ -f "wrangler.jsonc" ]; then
        if [ -n "$project_type" ]; then
          # Validate config structure matches project type
          local validation_error
          if ! validation_error=$(validate_wrangler_config "wrangler.jsonc" "$project_type" 2>&1); then
            echo -e "${RED}FAIL${NC}"
            echo "  wrangler.jsonc validation failed: $validation_error"
            FAILED=$((FAILED + 1))
            return
          fi

          # Check build output (warning only, not failure)
          if ! check_build_output "$(pwd)" "$project_type"; then
            echo -e "${YELLOW}WARN${NC} (no build output)"
          else
            echo -e "${GREEN}PASS${NC}"
          fi
        else
          echo -e "${GREEN}PASS${NC}"
        fi
        PASSED=$((PASSED + 1))
      else
        echo -e "${RED}FAIL${NC}"
        echo "  Expected wrangler.jsonc to be created"
        FAILED=$((FAILED + 1))
      fi
    else
      # ERROR CASE: Just check the error message was present
      echo -e "${GREEN}PASS${NC}"
      PASSED=$((PASSED + 1))
    fi
  else
    echo -e "${RED}FAIL${NC}"
    echo "  Expected output containing: '$expected_output'"
    echo "  Actual output: $output"
    FAILED=$((FAILED + 1))
  fi
}

echo "Running tests..."
echo ""

# ============================================
# SUCCESS CASES
# Should detect, generate correct config, build, and complete dry-run
# Format: test_fixture <name> <expected_output> <should_fail> <project_type>
# ============================================

test_fixture "vite-react" "Vite" false vite
test_fixture "vite-vue" "Vite" false vite
test_fixture "hono-api" "Hono" false hono
test_fixture "sveltekit-configured" "SvelteKit" false sveltekit

# ============================================
# ERROR CASES - SUPPORTED FRAMEWORKS (missing config)
# Should fail with specific error messages about missing dependencies
# ============================================

test_fixture "sveltekit-unconfigured" "adapter-cloudflare" true

# ============================================
# ERROR CASES - COMING SOON FRAMEWORKS
# Should detect the framework but show helpful setup instructions
# ============================================

test_fixture "astro-project" "Astro project detected" true
test_fixture "react-router-project" "React Router v7 project detected" true
test_fixture "nuxt-project" "Nuxt project detected" true
test_fixture "tanstack-project" "TanStack Start project detected" true

# ============================================
# ERROR CASES - UNSUPPORTED/UNKNOWN FRAMEWORKS
# Should fail with generic error messages
# ============================================

test_fixture "nextjs-unsupported" "Next.js project detected" true
test_fixture "unknown-project" "Could not detect" true
test_fixture "no-package-json" "package.json" true

echo ""
echo "============================================"
echo "Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"
echo "============================================"

if [ $FAILED -gt 0 ]; then
  echo ""
  echo -e "${RED}Some tests failed!${NC}"
  exit 1
else
  echo ""
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
fi
