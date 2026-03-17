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

TMP_FILES=()
cleanup() {
  if [[ "${#TMP_FILES[@]}" -gt 0 ]]; then
    rm -f "${TMP_FILES[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

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

# ── test 3: upload JSON payload (canonical + metadata + raw) ──────────────────

echo ""
echo "[ 3 ] Upload JSON transcript payload (canonical + raw)"

json_escape() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
    return
  fi
  if command -v jq >/dev/null 2>&1; then
    jq -Rs '.'
    return
  fi
  echo "ERROR: json_escape requires python3 or jq" >&2
  exit 1
}

CANONICAL_NDJSON=$'{"type":"user","message":{"role":"user","content":[{"type":"text","text":"How do I fix this deploy?"}]},"meta":{"provider":"claude-code","schema":"jack.event.v1","timestamp":"2026-01-01T00:00:00.000Z","source_type":"assistant","source_subtype":"message","sequence":1},"provider_payload":{"type":"text","text":"How do I fix this deploy?"}}\n{"type":"tool_call","tool_call":{"id":"tool_1","name":"Bash","input":{"command":"npm test"}},"meta":{"provider":"claude-code","schema":"jack.event.v1","timestamp":"2026-01-01T00:00:01.000Z","source_type":"assistant","source_subtype":"tool_use","sequence":2},"provider_payload":{"type":"tool_use","id":"tool_1","name":"Bash","input":{"command":"npm test"}}}\n{"type":"tool_result","tool_result":{"tool_call_id":"tool_1","output":"ok","is_error":false},"meta":{"provider":"claude-code","schema":"jack.event.v1","timestamp":"2026-01-01T00:00:02.000Z","source_type":"user","source_subtype":"tool_result","sequence":3},"provider_payload":{"type":"tool_result","tool_use_id":"tool_1","content":"ok","is_error":false}}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Run migrations and redeploy."}]},"meta":{"provider":"claude-code","schema":"jack.event.v1","timestamp":"2026-01-01T00:00:03.000Z","source_type":"assistant","source_subtype":"message","sequence":4},"provider_payload":{"type":"text","text":"Run migrations and redeploy."}}'
RAW_NDJSON='{"type":"response_item","payload":{"type":"message","role":"user","content":"secret sk_test_ABC1234567890"}}'

CANONICAL_ESCAPED=$(printf '%s' "$CANONICAL_NDJSON" | json_escape)
RAW_ESCAPED=$(printf '%s' "$RAW_NDJSON" | json_escape)

JSON_UPLOAD_BODY=$(cat <<EOF
{"schema_version":"jack.transcript-upload.v1","provider":"claude-code","canonical_format":"jack.event.v1","canonical_ndjson":${CANONICAL_ESCAPED},"raw_ndjson":${RAW_ESCAPED},"stats":{"event_count":4,"message_count":2,"tool_call_count":1,"tool_result_count":1,"reasoning_count":0,"other_event_count":0,"turn_count":2,"user_turn_count":1,"assistant_turn_count":1,"first_turn_at":"2026-01-01T00:00:00.000Z","last_turn_at":"2026-01-01T00:00:03.000Z"}}
EOF
)

JSON_UPLOAD_RESP=$(curl -s -w "\n%{http_code}" \
  -X PUT \
  -H "Authorization: Bearer ${JACK_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "${JSON_UPLOAD_BODY}" \
  "${CONTROL_URL}/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/session-transcript")

JSON_UPLOAD_STATUS=$(echo "$JSON_UPLOAD_RESP" | tail -1)
JSON_UPLOAD_BODY_RESP=$(echo "$JSON_UPLOAD_RESP" | head -1)

check "JSON upload returns 200" "$([[ "$JSON_UPLOAD_STATUS" == "200" ]] && echo true || echo false)"
check "JSON upload response includes session_transcript_meta" "$(echo "$JSON_UPLOAD_BODY_RESP" | grep -qc '"session_transcript_meta"' && echo true || echo false)"
check "JSON upload response includes provider claude-code" "$(echo "$JSON_UPLOAD_BODY_RESP" | grep -qc '"provider":"claude-code"' && echo true || echo false)"
check "JSON upload response has_raw is true" "$(echo "$JSON_UPLOAD_BODY_RESP" | grep -qc '"has_raw":true' && echo true || echo false)"
check "JSON upload response includes tool_call_count" "$(echo "$JSON_UPLOAD_BODY_RESP" | grep -qc '"tool_call_count":1' && echo true || echo false)"

# ── test 4: payload too large ─────────────────────────────────────────────────

echo ""
echo "[ 4 ] Reject oversized payloads (>1MB)"

# Generate ~1.1MB of text
BIG_BODY_FILE=$(mktemp)
TMP_FILES+=("$BIG_BODY_FILE")
if command -v python3 >/dev/null 2>&1; then
  python3 - <<'PY' > "$BIG_BODY_FILE"
print("x" * 1_100_000, end="")
PY
else
  dd if=/dev/urandom bs=1100000 count=1 2>/dev/null | base64 > "$BIG_BODY_FILE"
fi

OVERSIZE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT \
  -H "Authorization: Bearer ${JACK_API_TOKEN}" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary "@${BIG_BODY_FILE}" \
  "${CONTROL_URL}/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/session-transcript")

check "Oversized payload returns 413" "$([[ "$OVERSIZE_STATUS" == "413" ]] && echo true || echo false)"

OVERSIZE_CANONICAL_JSON_FILE=$(mktemp)
TMP_FILES+=("$OVERSIZE_CANONICAL_JSON_FILE")
python3 - "$BIG_BODY_FILE" "$OVERSIZE_CANONICAL_JSON_FILE" <<'PY'
import json, sys
big_path, out_path = sys.argv[1], sys.argv[2]
with open(big_path, "r", encoding="utf-8") as f:
    big_body = f.read()
payload = {
    "schema_version": "jack.transcript-upload.v1",
    "provider": "claude-code",
    "canonical_format": "jack.event.v1",
    "canonical_ndjson": big_body,
    "stats": {
        "event_count": 0,
        "message_count": 0,
        "tool_call_count": 0,
        "tool_result_count": 0,
        "reasoning_count": 0,
        "other_event_count": 0,
        "turn_count": 0,
        "user_turn_count": 0,
        "assistant_turn_count": 0,
        "first_turn_at": None,
        "last_turn_at": None,
    },
}
with open(out_path, "w", encoding="utf-8") as f:
    f.write(json.dumps(payload))
PY

OVERSIZE_CANONICAL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT \
  -H "Authorization: Bearer ${JACK_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "@${OVERSIZE_CANONICAL_JSON_FILE}" \
  "${CONTROL_URL}/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/session-transcript")

check "Oversized JSON canonical returns 413" "$([[ "$OVERSIZE_CANONICAL_STATUS" == "413" ]] && echo true || echo false)"

OVERSIZE_RAW_JSON_FILE=$(mktemp)
TMP_FILES+=("$OVERSIZE_RAW_JSON_FILE")
python3 - "$BIG_BODY_FILE" "$OVERSIZE_RAW_JSON_FILE" <<'PY'
import json, sys
big_path, out_path = sys.argv[1], sys.argv[2]
with open(big_path, "r", encoding="utf-8") as f:
    big_body = f.read()
payload = {
    "schema_version": "jack.transcript-upload.v1",
    "provider": "claude-code",
    "canonical_format": "jack.event.v1",
    "canonical_ndjson": '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"ok"}]},"meta":{"provider":"claude-code","schema":"jack.event.v1","timestamp":"2026-01-01T00:00:00.000Z","source_type":"user","source_subtype":"message","sequence":1},"provider_payload":{"type":"text","text":"ok"}}',
    "raw_ndjson": big_body,
    "stats": {
        "event_count": 1,
        "message_count": 1,
        "tool_call_count": 0,
        "tool_result_count": 0,
        "reasoning_count": 0,
        "other_event_count": 0,
        "turn_count": 1,
        "user_turn_count": 1,
        "assistant_turn_count": 0,
        "first_turn_at": "2026-01-01T00:00:00.000Z",
        "last_turn_at": "2026-01-01T00:00:00.000Z",
    },
}
with open(out_path, "w", encoding="utf-8") as f:
    f.write(json.dumps(payload))
PY

OVERSIZE_RAW_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT \
  -H "Authorization: Bearer ${JACK_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "@${OVERSIZE_RAW_JSON_FILE}" \
  "${CONTROL_URL}/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/session-transcript")

check "Oversized JSON raw returns 413" "$([[ "$OVERSIZE_RAW_STATUS" == "413" ]] && echo true || echo false)"

# ── test 5: deployment APIs expose session_transcript_meta ────────────────────

echo ""
echo "[ 5 ] Deployment APIs include session_transcript_meta"

DEPLOYS_RESP=$(curl -s \
  -H "Authorization: Bearer ${JACK_API_TOKEN}" \
  "${CONTROL_URL}/v1/projects/${PROJECT_ID}/deployments")
LATEST_RESP=$(curl -s \
  -H "Authorization: Bearer ${JACK_API_TOKEN}" \
  "${CONTROL_URL}/v1/projects/${PROJECT_ID}/deployments/latest")
OVERVIEW_RESP=$(curl -s \
  -H "Authorization: Bearer ${JACK_API_TOKEN}" \
  "${CONTROL_URL}/v1/projects/${PROJECT_ID}/overview")

check "deployments list includes session_transcript_meta" "$(echo "$DEPLOYS_RESP" | grep -qc '"session_transcript_meta"' && echo true || echo false)"
check "deployments/latest includes session_transcript_meta" "$(echo "$LATEST_RESP" | grep -qc '"session_transcript_meta"' && echo true || echo false)"
check "overview latest_deployment includes session_transcript_meta" "$(echo "$OVERVIEW_RESP" | grep -qc '"session_transcript_meta"' && echo true || echo false)"

# ── test 6: get transcript returns canonical NDJSON ───────────────────────────

echo ""
echo "[ 6 ] GET /session-transcript returns canonical NDJSON"

GET_TRANSCRIPT_RESP=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: Bearer ${JACK_API_TOKEN}" \
  "${CONTROL_URL}/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/session-transcript")
GET_TRANSCRIPT_STATUS=$(echo "$GET_TRANSCRIPT_RESP" | tail -1)
GET_TRANSCRIPT_BODY=$(echo "$GET_TRANSCRIPT_RESP" | sed '$d')

check "GET /session-transcript returns 200" "$([[ "$GET_TRANSCRIPT_STATUS" == "200" ]] && echo true || echo false)"
check "GET /session-transcript contains canonical provider metadata" "$(echo "$GET_TRANSCRIPT_BODY" | grep -qc '"provider":"claude-code"' && echo true || echo false)"

# ── test 7: ask endpoint returns answer + evidence ───────────────────────────

echo ""
echo "[ 7 ] Ask endpoint — basic response shape"

ASK_RESP=$(curl -s \
  -X POST \
  -H "Authorization: Bearer ${JACK_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"question\":\"Why did the api endpoint break?\",\"hints\":{\"deployment_id\":\"${DEPLOYMENT_ID}\"}}" \
  "${CONTROL_URL}/v1/projects/${PROJECT_ID}/ask")

echo "  Response: $(echo "$ASK_RESP" | head -c 300)..."

check "ask response has 'answer' field" "$(echo "$ASK_RESP" | grep -qc '"answer"' && echo true || echo false)"
check "ask response has 'evidence' field" "$(echo "$ASK_RESP" | grep -qc '"evidence"' && echo true || echo false)"

# ── test 8: session_transcript evidence is present ───────────────────────────

echo ""
echo "[ 8 ] Ask evidence includes session_transcript entry"

check "Evidence contains session_transcript type" "$(echo "$ASK_RESP" | grep -qc '"session_transcript"' && echo true || echo false)"

# ── test 9: LLM synthesis fields (present when ANTHROPIC_API_KEY is set) ─────

echo ""
echo "[ 9 ] LLM synthesis fields (optional — only present when ANTHROPIC_API_KEY is configured)"

HAS_CONFIDENCE=$(echo "$ASK_RESP" | grep -c '"confidence"' || true)
if [[ "$HAS_CONFIDENCE" -gt 0 ]]; then
  check "confidence field present (LLM synthesis active)" "true"
  check "confidence is valid value" "$(echo "$ASK_RESP" | grep -qE '"confidence":\s*"(high|medium|low)"' && echo true || echo false)"
  check "root_cause field present" "$(echo "$ASK_RESP" | grep -qc '"root_cause"' && echo true || echo false)"
else
  echo "  SKIP  confidence/root_cause fields — ANTHROPIC_API_KEY not set, using fallback pickAnswer"
fi

# ── test 10: unauthorized request is rejected ────────────────────────────────

echo ""
echo "[ 10 ] Unauthorized upload is rejected"

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
