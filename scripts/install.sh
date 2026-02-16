#!/bin/bash
# Jack CLI installer — curl -fsSL getjack.org/install | bash
set -euo pipefail

JACK_PACKAGE="@getjack/jack"
MIN_NODE_VERSION=18

# Colors (disabled if not a TTY)
if [ -t 1 ]; then
  GREEN='\033[32m'
  CYAN='\033[36m'
  RED='\033[31m'
  DIM='\033[90m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  GREEN='' CYAN='' RED='' DIM='' BOLD='' RESET=''
fi

info()    { echo -e "${CYAN}>${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
fail()    { echo -e "${RED}✗${RESET} $*"; exit 1; }

# --- Node.js ---

check_node() {
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$ver" -ge "$MIN_NODE_VERSION" ]; then
      return 0
    fi
  fi
  return 1
}

install_node() {
  info "Node.js not found (or < v${MIN_NODE_VERSION}). Installing via nvm..."

  if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
    fail "curl or wget required to install nvm"
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi

  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"

  nvm install --lts
  nvm use --lts

  if ! check_node; then
    fail "Node.js installation failed"
  fi

  success "Node.js $(node -v) installed"
}

# --- Install jack CLI ---

install_jack() {
  info "Installing ${JACK_PACKAGE}..."
  npm i -g "${JACK_PACKAGE}" 2>&1 | tail -1

  # Verify
  local jack_bin
  jack_bin=$(command -v jack 2>/dev/null || true)

  if [ -z "$jack_bin" ]; then
    # npm global bin might not be in PATH — check common locations
    for dir in \
      "$(npm prefix -g 2>/dev/null)/bin" \
      "$HOME/.npm-global/bin" \
      "$HOME/.bun/bin" \
      "/opt/homebrew/bin" \
      "/usr/local/bin"; do
      if [ -x "$dir/jack" ]; then
        jack_bin="$dir/jack"
        export PATH="$dir:$PATH"
        break
      fi
    done
  fi

  if [ -z "$jack_bin" ]; then
    fail "jack installed but not found in PATH. You may need to restart your shell."
  fi

  success "jack $(jack --version) installed at ${jack_bin}"
}

# --- MCP configs ---

write_json_mcp() {
  local config_path="$1"
  local display_name="$2"
  local jack_bin
  jack_bin=$(command -v jack)

  # Build the jack MCP server entry
  local npm_bin
  npm_bin="$(npm prefix -g 2>/dev/null)/bin"
  local mcp_entry
  mcp_entry=$(cat <<JSONEOF
{
  "type": "stdio",
  "command": "${jack_bin}",
  "args": ["mcp", "serve"],
  "env": {
    "PATH": "${HOME}/.bun/bin:${HOME}/.npm-global/bin:${npm_bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  }
}
JSONEOF
)

  if [ -f "$config_path" ]; then
    # Merge into existing config
    if command -v node &>/dev/null; then
      node -e "
        const fs = require('fs');
        const p = '${config_path}';
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
        if (!cfg.mcpServers) cfg.mcpServers = {};
        cfg.mcpServers.jack = ${mcp_entry};
        fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
      "
    fi
  else
    # Create config directory if needed
    mkdir -p "$(dirname "$config_path")"
    node -e "
      const fs = require('fs');
      const cfg = { mcpServers: { jack: ${mcp_entry} } };
      fs.writeFileSync('${config_path}', JSON.stringify(cfg, null, 2));
    "
  fi

  success "MCP config written to ${display_name}"
}

configure_mcp() {
  local configured=0

  # Claude Code
  local claude_code_dir="$HOME/.claude"
  local claude_code_config="$HOME/.claude.json"
  if [ -d "$claude_code_dir" ]; then
    write_json_mcp "$claude_code_config" "Claude Code (~/.claude.json)"
    configured=$((configured + 1))
  fi

  # Claude Desktop
  local claude_desktop_config
  if [ "$(uname)" = "Darwin" ]; then
    claude_desktop_config="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
  else
    claude_desktop_config="$HOME/.config/Claude/claude_desktop_config.json"
  fi
  if [ -d "$(dirname "$claude_desktop_config")" ]; then
    write_json_mcp "$claude_desktop_config" "Claude Desktop"
    configured=$((configured + 1))
  fi

  # Cursor
  local cursor_config="$HOME/.cursor/mcp.json"
  if [ -d "$HOME/.cursor" ]; then
    write_json_mcp "$cursor_config" "Cursor (~/.cursor/mcp.json)"
    configured=$((configured + 1))
  fi

  if [ "$configured" -eq 0 ]; then
    info "No AI editors detected. Run ${BOLD}jack mcp install${RESET} after installing one."
  else
    info "Restart your AI editor(s) to pick up the MCP config."
  fi
}

# --- Main ---

main() {
  echo ""
  echo -e "${BOLD}jack${RESET} — deploy from the command line"
  echo ""

  if check_node; then
    success "Node.js $(node -v) found"
  else
    install_node
  fi

  install_jack
  configure_mcp

  echo ""
  echo -e "${BOLD}Ready!${RESET} Next steps:"
  echo ""
  echo "  jack new my-api          Create and deploy a project"
  echo "  jack new my-api -t api   Use a specific template"
  echo ""
  echo -e "  ${DIM}Auth happens automatically on first deploy.${RESET}"
  echo ""
}

main "$@"
