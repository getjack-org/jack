#!/usr/bin/env bash
# Benchmark dispatch worker CPU limits against a live tenant worker.
#
# Usage:
#   ./scripts/benchmark-dispatch-limits.sh <url>
#   ./scripts/benchmark-dispatch-limits.sh https://alice-my-api.runjack.xyz
#   ./scripts/benchmark-dispatch-limits.sh https://alice-my-api.runjack.xyz /api/heavy
#
# What it measures:
#   - Response time (wall-clock)
#   - HTTP status (to detect CPU/subrequest limit errors)
#   - Runs 5 sequential requests to show consistency
#
# Before/after workflow:
#   1. Run this script -> note baseline times and any 503s
#   2. Deploy dispatch-worker with bumped limits
#   3. Run this script again -> compare

set -euo pipefail

URL="${1:?Usage: $0 <base-url> [path]}"
PATH_SUFFIX="${2:-/}"

# Normalize: strip trailing slash from URL, add path
URL="${URL%/}"
FULL_URL="${URL}${PATH_SUFFIX}"

echo "=== Jack Dispatch Limit Benchmark ==="
echo "URL:  ${FULL_URL}"
echo "Date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

echo "--- Warmup request (not counted) ---"
curl -s -o /dev/null -w "  status=%{http_code} time=%{time_total}s\n" "${FULL_URL}"
echo ""

echo "--- 5 sequential requests ---"
total_time=0
failures=0

for i in $(seq 1 5); do
  result=$(curl -s -o /dev/null -w "%{http_code} %{time_total} %{time_starttransfer}" "${FULL_URL}")
  status=$(echo "$result" | awk '{print $1}')
  total=$(echo "$result" | awk '{print $2}')
  ttfb=$(echo "$result" | awk '{print $3}')

  if [ "$status" -ge 500 ]; then
    failures=$((failures + 1))
    echo "  #${i}: status=${status} total=${total}s ttfb=${ttfb}s  ** FAILED **"
  else
    echo "  #${i}: status=${status} total=${total}s ttfb=${ttfb}s"
  fi

  total_time=$(echo "$total_time + $total" | bc)
done

avg_time=$(echo "scale=3; $total_time / 5" | bc)

echo ""
echo "--- Summary ---"
echo "  Avg response time: ${avg_time}s"
echo "  Failures (5xx):    ${failures}/5"
echo ""

if [ "$failures" -gt 0 ]; then
  echo "** ${failures} requests failed — likely hitting CPU or subrequest limits **"
  echo "** Check dispatch-worker logs for 'Worker exceeded CPU time limit' **"
fi

echo ""
echo "--- Single verbose request (shows headers) ---"
curl -s -D - -o /dev/null "${FULL_URL}" 2>&1 | grep -iE "^(HTTP|x-ratelimit|cf-|content-type|server)" || true
