#!/usr/bin/env bash
# Full verification pass for RedZone. Writes everything to audits/verification/<date>/ and prints a
# summary. Read-only: deploys nothing and sends nothing on chain.
#   bash scripts/verify-all.sh            everyday depth
#   STRICT=1 bash scripts/verify-all.sh   10,000 fuzz runs, 1,000 x 200-call invariant campaigns
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/audits/verification/$(date -u +%Y-%m-%d)"
mkdir -p "$OUT"
export PATH="$HOME/.foundry/bin:$PATH"
PROFILE=default; [ "${STRICT:-0}" = 1 ] && PROFILE=strict
status() { printf '%-34s %s\n' "$1" "$2" | tee -a "$OUT/summary.txt"; }
: > "$OUT/summary.txt"
echo "RedZone verification, $(date -u), profile $PROFILE" | tee -a "$OUT/summary.txt"

cd "$ROOT/contracts"
forge build --sizes > "$OUT/sizes.txt" 2>&1 && status "contracts build" ok || status "contracts build" FAIL
FOUNDRY_PROFILE=$PROFILE forge test > "$OUT/forge-test.txt" 2>&1
status "forge test ($PROFILE)" "$(grep -E 'tests passed|test suites' "$OUT/forge-test.txt" | tail -1)"
forge coverage --match-path "test/v6/*" --report summary --ir-minimum > "$OUT/coverage.txt" 2>&1
status "coverage (live contracts)" "see coverage.txt"
python -m slither . --filter-paths "lib/|test/|script/" --exclude-informational --exclude-optimization \
  --json "$OUT/slither.json" > "$OUT/slither.txt" 2>&1
status "slither" "$(grep -E 'result\(s\) found' "$OUT/slither.txt" | tail -1)"

cd "$ROOT/backend"
npx tsc --noEmit > "$OUT/backend-typecheck.txt" 2>&1 && status "backend typecheck" ok || status "backend typecheck" FAIL
npx vitest run --exclude test/live.test.ts > "$OUT/backend-test.txt" 2>&1
status "backend tests" "$(grep -E 'Tests ' "$OUT/backend-test.txt" | tail -1 | sed 's/\x1b\[[0-9;]*m//g')"
npm audit --omit=dev > "$OUT/backend-npm-audit.txt" 2>&1
status "backend npm audit (prod deps)" "$(tail -3 "$OUT/backend-npm-audit.txt" | tr '\n' ' ')"

cd "$ROOT/web"
npm run build > "$OUT/web-build.txt" 2>&1 && status "web build" ok || status "web build" FAIL
npm audit --omit=dev > "$OUT/web-npm-audit.txt" 2>&1
status "web npm audit (prod deps)" "$(tail -3 "$OUT/web-npm-audit.txt" | tr '\n' ' ')"

echo "Details in $OUT"
