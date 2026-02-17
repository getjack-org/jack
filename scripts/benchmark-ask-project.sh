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
BENCHMARK_FILE="${BENCHMARK_FILE:-scripts/fixtures/ask-project-benchmark.json}"
MIN_USEFUL_RATE="${MIN_USEFUL_RATE:-75}"

if [[ -z "$JACK_API_TOKEN" ]]; then
  echo "error: set JACK_API_TOKEN" >&2
  exit 1
fi

if [[ ! -f "$BENCHMARK_FILE" ]]; then
  echo "error: benchmark file not found: $BENCHMARK_FILE" >&2
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
echo "Benchmark file: $BENCHMARK_FILE"

total="$(jq 'length' "$BENCHMARK_FILE")"
if [[ "$total" -eq 0 ]]; then
  echo "error: benchmark file is empty" >&2
  exit 1
fi

pass=0
fail=0
unknown=0
idx=0

while IFS= read -r row; do
  idx=$((idx + 1))
  name="$(echo "$row" | jq -r '.name')"
  question="$(echo "$row" | jq -r '.question')"
  min_evidence="$(echo "$row" | jq -r '.min_evidence // 1')"
  expect_contains="$(echo "$row" | jq -r '.expect_answer_contains // ""')"
  hints="$(echo "$row" | jq -c '.hints // {}')"

  payload="$(jq -n \
    --arg q "$question" \
    --argjson h "$hints" \
    '{question:$q,hints:$h}')"

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
    echo "[$idx/$total] $name -> SKIP (endpoint missing)"
    rm -f "$tmp_body"
    unknown=$((unknown + 1))
    continue
  fi

  if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
    echo "[$idx/$total] $name -> FAIL (HTTP $http_code)"
    fail=$((fail + 1))
    rm -f "$tmp_body"
    continue
  fi

  ok_shape=0
  if jq -e '
    (.answer | type == "string" and length > 0) and
    (.evidence | type == "array")
  ' "$tmp_body" >/dev/null; then
    ok_shape=1
  fi

  evidence_count="$(jq '.evidence | length' "$tmp_body")"
  ok_evidence=0
  if [[ "$evidence_count" -ge "$min_evidence" ]]; then
    ok_evidence=1
  fi

  ok_text=1
  if [[ -n "$expect_contains" ]]; then
    if ! jq -e --arg s "$expect_contains" '.answer | ascii_downcase | contains($s | ascii_downcase)' "$tmp_body" >/dev/null; then
      ok_text=0
    fi
  fi

  if [[ "$ok_shape" -eq 1 && "$ok_evidence" -eq 1 && "$ok_text" -eq 1 ]]; then
    echo "[$idx/$total] $name -> PASS"
    pass=$((pass + 1))
  else
    echo "[$idx/$total] $name -> FAIL (shape=$ok_shape evidence=$evidence_count text=$ok_text)"
    fail=$((fail + 1))
  fi

  rm -f "$tmp_body"
done < <(jq -c '.[]' "$BENCHMARK_FILE")

echo
echo "Summary: pass=$pass fail=$fail unknown=$unknown total=$total"
useful_rate="$(awk -v p="$pass" -v t="$total" 'BEGIN { if (t==0) print 0; else printf "%.2f", (p*100.0)/t }')"
echo "Useful rate (raw pass/total): ${useful_rate}%"

if [[ "$unknown" -eq "$total" ]]; then
  echo "No benchmark cases executed because endpoint is unavailable."
  exit 2
fi

if awk -v r="$useful_rate" -v m="$MIN_USEFUL_RATE" 'BEGIN { exit !(r < m) }'; then
  echo "FAIL: useful rate ${useful_rate}% is below MIN_USEFUL_RATE=${MIN_USEFUL_RATE}%"
  exit 1
fi

echo "PASS: useful rate ${useful_rate}% meets MIN_USEFUL_RATE=${MIN_USEFUL_RATE}%"
