#!/usr/bin/env bash
# Test runner: each test file gets its own process so singleton state
# (config service, rate-limit buckets, account manager) never leaks across files.
set -uo pipefail
cd "$(dirname "$0")/.."

failed=0
total=0
for f in tests/*.test.ts; do
  total=$((total + 1))
  echo "── $f"
  if ! bun test "$f"; then
    failed=$((failed + 1))
  fi
done

echo
if [ "$failed" -eq 0 ]; then
  echo "ALL TEST FILES PASSED ($total files)"
  exit 0
else
  echo "$failed/$total TEST FILES FAILED"
  exit 1
fi
