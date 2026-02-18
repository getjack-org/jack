#!/usr/bin/env bash
# Quick curl examples for ask feature endpoints
# Set: JACK_API_TOKEN, PROJECT_ID, DEPLOYMENT_ID, CONTROL_URL

CONTROL_URL="${CONTROL_URL:-https://control.getjack.org}"

# Upload a session transcript
curl -X PUT \
  -H "Authorization: Bearer $JACK_API_TOKEN" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary '{"type":"user","message":{"role":"user","content":"why is /api broken?"},"sessionId":"s1","timestamp":"2026-01-01T00:00:00.000Z"}' \
  "$CONTROL_URL/v1/projects/$PROJECT_ID/deployments/$DEPLOYMENT_ID/session-transcript"

echo ""

# Ask a question
curl -X POST \
  -H "Authorization: Bearer $JACK_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"question":"Why did my endpoint break?","hints":{"endpoint":"/api/hello"}}' \
  "$CONTROL_URL/v1/projects/$PROJECT_ID/ask" | jq .
