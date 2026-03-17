#!/usr/bin/env bash
set -euo pipefail

# Runs two headless agent sessions (Codex + Claude), each making a tiny change
# and shipping via jack. Then verifies deployment + transcript metadata via API.
#
# Usage:
#   scripts/test-agent-ship-both.sh [project_dir]
#
# Env overrides:
#   CONTROL_URL=https://control.getjack.org
#   RUN_ID=manual-123
#   POLL_TIMEOUT_SECONDS=180
#   POLL_INTERVAL_SECONDS=4
#   JACK_SHIP_CMD="jack ship --json"

require_cmd() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "error: required command not found: $1" >&2
		exit 1
	fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_DIR="${1:-$PWD}"
CONTROL_URL="${CONTROL_URL:-https://control.getjack.org}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
POLL_TIMEOUT_SECONDS="${POLL_TIMEOUT_SECONDS:-180}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-4}"
JACK_SHIP_CMD="${JACK_SHIP_CMD:-jack ship --json}"

require_cmd jq
require_cmd curl
require_cmd jack
require_cmd codex
require_cmd claude

if [[ ! -d "$PROJECT_DIR" ]]; then
	echo "error: project directory not found: $PROJECT_DIR" >&2
	exit 1
fi

PROJECT_LINK="${PROJECT_DIR}/.jack/project.json"
if [[ ! -f "$PROJECT_LINK" ]]; then
	echo "error: missing $PROJECT_LINK" >&2
	echo "run from a linked jack project (or pass one as arg)." >&2
	exit 1
fi

PROJECT_ID="$(jq -r '.project_id // empty' "$PROJECT_LINK")"
DEPLOY_MODE="$(jq -r '.deploy_mode // empty' "$PROJECT_LINK")"
if [[ -z "$PROJECT_ID" ]]; then
	echo "error: could not read project_id from $PROJECT_LINK" >&2
	exit 1
fi
if [[ "$DEPLOY_MODE" != "managed" ]]; then
	echo "error: project deploy_mode is '$DEPLOY_MODE' (needs 'managed')" >&2
	exit 1
fi

get_token() {
	if [[ -n "${JACK_API_TOKEN:-}" ]]; then
		printf "%s" "$JACK_API_TOKEN"
		return 0
	fi

	if command -v bun >/dev/null 2>&1; then
		(
			cd "$REPO_ROOT"
			bun -e 'import { getValidAccessToken } from "./apps/cli/src/lib/auth/client.ts"; const t = await getValidAccessToken(); if (t) process.stdout.write(t);'
		)
		return 0
	fi

	return 0
}

TOKEN="$(get_token)"
if [[ -z "$TOKEN" ]]; then
	echo "error: could not resolve auth token." >&2
	echo "set JACK_API_TOKEN, or install bun and run while logged in with jack." >&2
	exit 1
fi

api_get() {
	local path="$1"
	local token
	token="$(get_token)"
	if [[ -z "$token" ]]; then
		echo "error: could not resolve auth token for API request." >&2
		exit 1
	fi
	curl -fsS -H "Authorization: Bearer ${token}" "${CONTROL_URL}${path}"
}

wait_for_deployment_id() {
	local message="$1"
	local deadline=$((SECONDS + POLL_TIMEOUT_SECONDS))
	while ((SECONDS < deadline)); do
		local dep_id
		dep_id="$(
			api_get "/v1/projects/${PROJECT_ID}/deployments" \
				| jq -r --arg message "$message" '.deployments[] | select(.message == $message) | .id' \
				| head -n 1
		)"
		if [[ -n "$dep_id" ]]; then
			printf "%s" "$dep_id"
			return 0
		fi
		sleep "$POLL_INTERVAL_SECONDS"
	done
	return 1
}

wait_for_provider_meta() {
	local deployment_id="$1"
	local expected_provider="$2"
	local deadline=$((SECONDS + POLL_TIMEOUT_SECONDS))
	while ((SECONDS < deadline)); do
		local provider
		provider="$(
			api_get "/v1/projects/${PROJECT_ID}/deployments" \
				| jq -r --arg id "$deployment_id" '.deployments[] | select(.id == $id) | .session_transcript_meta.provider // empty' \
				| head -n 1
		)"
		local has_transcript
		has_transcript="$(
			api_get "/v1/projects/${PROJECT_ID}/deployments" \
				| jq -r --arg id "$deployment_id" '.deployments[] | select(.id == $id) | .has_session_transcript // false' \
				| head -n 1
		)"
		local schema_version
		schema_version="$(
			api_get "/v1/projects/${PROJECT_ID}/deployments" \
				| jq -r --arg id "$deployment_id" '.deployments[] | select(.id == $id) | .session_transcript_meta.schema_version // empty' \
				| head -n 1
		)"
		if [[ "$provider" == "$expected_provider" && "$has_transcript" == "true" && "$schema_version" == "jack.event.v1" ]]; then
			return 0
		fi
		sleep "$POLL_INTERVAL_SECONDS"
	done
	return 1
}

run_agent_ship() {
	local provider="$1"
	local deploy_message="agent-ship-e2e-${provider}-${RUN_ID}"
	local marker_rel=".jack-agent-smoke/${provider}-${RUN_ID}.txt"
	local log_file="/tmp/jack-${provider}-${RUN_ID}.log"
	local ship_token
	ship_token="$(get_token)"
	if [[ -z "$ship_token" ]]; then
		echo "error: could not resolve auth token for ${provider} ship." >&2
		exit 1
	fi

	local prompt
	prompt="Make only this minimal change in the current project:
1) Create directory .jack-agent-smoke if needed.
2) Write file ${marker_rel} with exactly one line:
${deploy_message}
3) Run: ${JACK_SHIP_CMD} -m \"${deploy_message}\"
4) Stop after shipping.
Do not ask questions. Do not make any other code changes."

	echo ""
	echo "==> Running ${provider} agent"
	echo "    marker: ${marker_rel}"
	echo "    deploy message: ${deploy_message}"
	echo "    log: ${log_file}"

	case "$provider" in
	codex)
		JACK_API_TOKEN="$ship_token" codex exec --full-auto --skip-git-repo-check -C "$PROJECT_DIR" "$prompt" >"$log_file" 2>&1
		;;
	claude-code)
		(
			cd "$PROJECT_DIR"
			# Avoid leaking Codex thread env into Claude runs; force Claude transcript detection.
			env -u CODEX_THREAD_ID -u CODEX_CI -u CODEX_SANDBOX -u CODEX_SANDBOX_NETWORK_DISABLED \
				JACK_API_TOKEN="$ship_token" \
				claude -p --dangerously-skip-permissions "$prompt"
		) >"$log_file" 2>&1
		;;
	*)
		echo "error: unsupported provider '$provider'" >&2
		exit 1
		;;
	esac

	local deployment_id
	if ! deployment_id="$(wait_for_deployment_id "$deploy_message")"; then
		echo "error: ${provider} deployment not found by message '${deploy_message}'" >&2
		echo "last agent log lines:" >&2
		tail -n 80 "$log_file" >&2 || true
		exit 1
	fi

	if ! wait_for_provider_meta "$deployment_id" "$provider"; then
		echo "error: transcript metadata for ${provider} did not become ready for ${deployment_id}" >&2
		echo "last agent log lines:" >&2
		tail -n 80 "$log_file" >&2 || true
		exit 1
	fi

	local deployment_json
	deployment_json="$(
		api_get "/v1/projects/${PROJECT_ID}/deployments" \
			| jq -c --arg id "$deployment_id" '.deployments[] | select(.id == $id)'
	)"
	local turn_count
	turn_count="$(printf "%s" "$deployment_json" | jq -r '.session_transcript_meta.turn_count // 0')"
	local event_count
	event_count="$(printf "%s" "$deployment_json" | jq -r '.session_transcript_meta.event_count // 0')"
	local tool_call_count
	tool_call_count="$(printf "%s" "$deployment_json" | jq -r '.session_transcript_meta.tool_call_count // 0')"
	local schema_version
	schema_version="$(printf "%s" "$deployment_json" | jq -r '.session_transcript_meta.schema_version // "null"')"
	local canonical_provider
	canonical_provider="$(
		api_get "/v1/projects/${PROJECT_ID}/deployments/${deployment_id}/session-transcript" \
			| sed -n '1p' \
			| jq -r '.meta.provider // empty' 2>/dev/null || true
	)"

	echo "    deployment_id: ${deployment_id}"
	echo "    transcript_provider(meta): $(printf "%s" "$deployment_json" | jq -r '.session_transcript_meta.provider // "null"')"
	echo "    transcript_schema(meta): ${schema_version}"
	echo "    transcript_turn_count: ${turn_count}"
	echo "    transcript_event_count: ${event_count}"
	echo "    transcript_tool_call_count: ${tool_call_count}"
	echo "    transcript_provider(first_line): ${canonical_provider:-unknown}"

	if [[ "$provider" == "codex" ]]; then
		CODEX_DEPLOYMENT_ID="$deployment_id"
	elif [[ "$provider" == "claude-code" ]]; then
		CLAUDE_DEPLOYMENT_ID="$deployment_id"
	fi
}

CODEX_DEPLOYMENT_ID=""
CLAUDE_DEPLOYMENT_ID=""

echo "Project: ${PROJECT_DIR}"
echo "Project ID: ${PROJECT_ID}"
echo "Control URL: ${CONTROL_URL}"
echo "Run ID: ${RUN_ID}"

run_agent_ship "codex"
run_agent_ship "claude-code"

PROJECT_URL="$(api_get "/v1/projects/${PROJECT_ID}/overview" | jq -r '.project.url // empty')"

echo ""
echo "Done."
echo "Live URL: ${PROJECT_URL}"
echo "Codex deployment:  ${CODEX_DEPLOYMENT_ID}"
echo "Claude deployment: ${CLAUDE_DEPLOYMENT_ID}"
echo ""
echo "Verify in API:"
echo "  curl -sS -H 'Authorization: Bearer ***' '${CONTROL_URL}/v1/projects/${PROJECT_ID}/deployments' | jq '.deployments[:5]'"
echo "  curl -sS -H 'Authorization: Bearer ***' '${CONTROL_URL}/v1/projects/${PROJECT_ID}/deployments/${CODEX_DEPLOYMENT_ID}/session-transcript' | head -n 5"
echo "  curl -sS -H 'Authorization: Bearer ***' '${CONTROL_URL}/v1/projects/${PROJECT_ID}/deployments/${CLAUDE_DEPLOYMENT_ID}/session-transcript' | head -n 5"
