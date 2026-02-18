#!/usr/bin/env bash
# E2E test: session transcript upload + ask endpoint
#
# Usage:
#   JACK_API_TOKEN=jkt_xxx PROJECT_ID=proj_xxx DEPLOYMENT_ID=dep_xxx bash scripts/test-ask-e2e.sh
#
# Optional:
#   CONTROL_URL=https://control.getjack.org   (default)
#
# How to get IDs:
#   PROJECT_ID:    jack info --json | jq -r '.project.id'
#   DEPLOYMENT_ID: jack deploys --json | jq -r '.[0].id'

set -euo pipefail

CONTROL_URL="${CONTROL_URL:-https://control.getjack.org}"
PASS=0
FAIL=0

# ── helpers ──────────────────────────────────────────────────────────────────

check() {
  local label="$1"
  local result="$2"
  if [[ "$result" == "true" ]]; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label"
    FAIL=$((FAIL + 1))
  fi
}

require_var() {
  if [[ -z "${!1:-}" ]]; then
    echo "ERROR: $1 is required. See usage at the top of this script."
    exit 1
  fi
}

# ── preflight ─────────────────────────────────────────────────────────────────

require_var JACK_API_TOKEN
require_var PROJECT_ID
require_var DEPLOYMENT_ID

echo ""
echo "Control URL : $CONTROL_URL"
echo "Project     : $PROJECT_ID"
echo "Deployment  : $DEPLOYMENT_ID"
echo ""

# ── test 1: upload session transcript ────────────────────────────────────────

echo "[ 1 ] Upload session transcript"

# Minimal valid Claude Code JSONL (two turns)
TRANSCRIPT_BODY='{"type":"user","message":{"role":"user","content":"Why did the /api/hello endpoint break after deploy?"},"sessionId":"test","timestamp":"2026-01-01T00:00:00.000Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The error is likely a missing D1 table. Check your schema migrations."}]},"sessionId":"test","timestamp":"2026-01-01T00:00:01.000Z"}'

UPLOAD_RESP=$(curl -s -w "\n%{http_code}" \
  -X PUT \
  -H "Authorization: Bearer ${JACK_API_TOKEN}" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary "${TRANSCRIPT_BODY}" \
  "${CONTROL_URL}/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/session-transcript")

UPLOAD_STATUS=$(echo "$UPLOAD_RESP" | tail -1)
UPLOAD_BODY=$(echo "$UPLOAD_RESP" | head -1)

check "PUT /session-transcript returns 200" "$([[ "$UPLOAD_STATUS" == "200" ]] && echo true || echo false)"
check "Response body contains ok:true" "$(echo "$UPLOAD_BODY" | grep -qc '"ok":true' && echo true || echo false)"

echo "  Response: $UPLOAD_BODY (HTTP $UPLOAD_STATUS)"

# ── test 2: upload idempotency ────────────────────────────────────────────────

echo ""
echo "[ 2 ] Upload again (idempotency)"

UPLOAD2_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT \
  -H "Authorization: Bearer ${JACK_API_TOKEN}" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary "${TRANSCRIPT_BODY}" \
  "${CONTROL_URL}/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/session-transcript")

check "Second upload also returns 200" "$([[ "$UPLOAD2_STATUS" == "200" ]] && echo true || echo false)"

# ── test 3: payload too large ─────────────────────────────────────────────────

echo ""
echo "[ 3 ] Reject oversized payload (>1MB)"

# Generate ~1.1MB of text
BIG_BODY=$(python3 -c "print('x' * 1_100_000)" 2>/dev/null || dd if=/dev/urandom bs=1100000 count=1 2>/dev/null | base64)

OVERSIZE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT \
  -H "Authorization: Bearer ${JACK_API_TOKEN}" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary "${BIG_BODY}" \
  "${CONTROL_URL}/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/session-transcript")

check "Oversized payload returns 413" "$([[ "$OVERSIZE_STATUS" == "413" ]] && echo true || echo false)"

# ── test 4: ask endpoint returns answer + evidence ───────────────────────────

echo ""
echo "[ 4 ] Ask endpoint — basic response shape"

ASK_RESP=$(curl -s \
  -X POST \
  -H "Authorization: Bearer ${JACK_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"question\":\"Why did the api endpoint break?\",\"hints\":{\"deployment_id\":\"${DEPLOYMENT_ID}\"}}" \
  "${CONTROL_URL}/v1/projects/${PROJECT_ID}/ask")

echo "  Response: $(echo "$ASK_RESP" | head -c 300)..."

check "ask response has 'answer' field" "$(echo "$ASK_RESP" | grep -qc '"answer"' && echo true || echo false)"
check "ask response has 'evidence' field" "$(echo "$ASK_RESP" | grep -qc '"evidence"' && echo true || echo false)"

# ── test 5: session_transcript evidence is present ───────────────────────────

echo ""
echo "[ 5 ] Ask evidence includes session_transcript entry"

check "Evidence contains session_transcript type" "$(echo "$ASK_RESP" | grep -qc '"session_transcript"' && echo true || echo false)"

# ── test 6: LLM synthesis fields (present when ANTHROPIC_API_KEY is set) ─────

echo ""
echo "[ 6 ] LLM synthesis fields (optional — only present when ANTHROPIC_API_KEY is configured)"

HAS_CONFIDENCE=$(echo "$ASK_RESP" | grep -c '"confidence"' || true)
if [[ "$HAS_CONFIDENCE" -gt 0 ]]; then
  check "confidence field present (LLM synthesis active)" "true"
  check "confidence is valid value" "$(echo "$ASK_RESP" | grep -qE '"confidence":\s*"(high|medium|low)"' && echo true || echo false)"
  check "root_cause field present" "$(echo "$ASK_RESP" | grep -qc '"root_cause"' && echo true || echo false)"
else
  echo "  SKIP  confidence/root_cause fields — ANTHROPIC_API_KEY not set, using fallback pickAnswer"
fi

# ── test 7: unauthorized request is rejected ─────────────────────────────────

echo ""
echo "[ 7 ] Unauthorized upload is rejected"

UNAUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT \
  -H "Authorization: Bearer bad_token" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary "${TRANSCRIPT_BODY}" \
  "${CONTROL_URL}/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/session-transcript")

check "Unauthorized request returns 401 or 403" "$([[ "$UNAUTH_STATUS" == "401" || "$UNAUTH_STATUS" == "403" ]] && echo true || echo false)"

# ── summary ───────────────────────────────────────────────────────────────────

echo ""
echo "──────────────────────────────"
echo "  $PASS passed / $FAIL failed"
echo "──────────────────────────────"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
