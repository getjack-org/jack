#!/usr/bin/env bash
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl is required" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

CONTROL_BASE="${CONTROL_BASE:-https://control.getjack.org}"
JACK_API_TOKEN="${JACK_API_TOKEN:-}"
PROJECT_ID="${PROJECT_ID:-}"
PROJECT_SLUG="${PROJECT_SLUG:-}"
QUESTION="${QUESTION:-Why is /api/todos returning 500?}"
ENDPOINT_HINT="${ENDPOINT_HINT:-}"
METHOD_HINT="${METHOD_HINT:-GET}"

if [[ -z "$JACK_API_TOKEN" ]]; then
  echo "error: set JACK_API_TOKEN" >&2
  exit 1
fi

auth_header=("Authorization: Bearer $JACK_API_TOKEN")
json_header=("Content-Type: application/json")

resolve_project_id() {
  if [[ -n "$PROJECT_ID" ]]; then
    echo "$PROJECT_ID"
    return 0
  fi

  if [[ -n "$PROJECT_SLUG" ]]; then
    local body
    body="$(curl -sS \
      -H "${auth_header[0]}" \
      "$CONTROL_BASE/v1/projects/by-slug/$PROJECT_SLUG")"
    echo "$body" | jq -r '.project.id // empty'
    return 0
  fi

  local body
  body="$(curl -sS -H "${auth_header[0]}" "$CONTROL_BASE/v1/projects")"
  echo "$body" | jq -r '.projects[0].id // empty'
}

PID="$(resolve_project_id)"
if [[ -z "$PID" ]]; then
  echo "error: could not resolve PROJECT_ID (set PROJECT_ID or PROJECT_SLUG)" >&2
  exit 1
fi

echo "Using project: $PID"

payload="$(jq -n \
  --arg q "$QUESTION" \
  --arg endpoint "$ENDPOINT_HINT" \
  --arg method "$METHOD_HINT" \
  'if ($endpoint | length) > 0 then
     {
       question: $q,
       hints: {
         endpoint: $endpoint,
         method: ($method | ascii_upcase)
       }
     }
   else
     { question: $q }
   end'
)"

tmp_body="$(mktemp)"
http_code="$(
  curl -sS \
    -o "$tmp_body" \
    -w "%{http_code}" \
    -H "${auth_header[0]}" \
    -H "${json_header[0]}" \
    -X POST "$CONTROL_BASE/v1/projects/$PID/ask" \
    -d "$payload"
)"

if [[ "$http_code" == "404" ]]; then
  echo "ask endpoint not found (not implemented/deployed on target env yet)." >&2
  cat "$tmp_body" >&2 || true
  rm -f "$tmp_body"
  exit 2
fi

if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
  echo "error: ask endpoint returned HTTP $http_code" >&2
  cat "$tmp_body" >&2 || true
  rm -f "$tmp_body"
  exit 1
fi

jq . "$tmp_body"

jq -e '
  (.answer | type == "string" and length > 0) and
  (.evidence | type == "array" and length > 0)
' "$tmp_body" >/dev/null

jq -e '
  [.evidence[] |
    (has("id") and has("type") and has("source") and has("summary") and has("timestamp") and has("relation"))
  ] | all
' "$tmp_body" >/dev/null

jq -e '
  [.evidence[] | (.relation == "supports" or .relation == "conflicts" or .relation == "gap")] | all
' "$tmp_body" >/dev/null

echo "PASS: ask_project response contract is valid"
rm -f "$tmp_body"
