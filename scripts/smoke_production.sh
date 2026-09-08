#!/usr/bin/env bash
# scripts/smoke_production.sh
# Post-deploy smoke test. Checks that every route class answers, and answers
# quickly -- a hang is the failure mode that took production down, and it looks
# nothing like a 500.
#
#   ./scripts/smoke_production.sh [base-url]
set -uo pipefail

BASE="${1:-https://ai-prodgen.vercel.app}"
MAX_SECONDS=15
fail=0

check() {
    local method="$1" path="$2" expected="$3" note="${4:-}"
    local out code time
    out=$(curl -s -o /tmp/smoke_body.$$ -w '%{http_code} %{time_total}' \
          -X "$method" "$BASE$path" --max-time "$MAX_SECONDS" 2>/dev/null)
    code="${out%% *}"; time="${out##* }"

    if [ "$code" = "000" ]; then
        printf '  FAIL  %-6s %-30s no response in %ss (hanging)\n' "$method" "$path" "$MAX_SECONDS"
        fail=1
    elif [ "$code" != "$expected" ]; then
        printf '  FAIL  %-6s %-30s got %s, expected %s  %s\n' "$method" "$path" "$code" "$expected" "$note"
        fail=1
    else
        printf '  ok    %-6s %-30s %s in %ss\n' "$method" "$path" "$code" "$time"
    fi
    rm -f /tmp/smoke_body.$$
}

echo
echo "Smoke test: $BASE"
echo
echo "Static"
check GET  /                            302
check GET  /landing.html                200

echo
echo "Express routes (via api/index)"
check GET  /api/credits/packages        200
check GET  /api/definitely-not-a-route  404 "unknown paths must 404, not hang"

echo
echo "Standalone functions (own files, must not be swallowed by the rewrite)"
check POST /api/generate                401
check POST /api/keys/add                401
check POST /api/webhooks/razorpay       503 "503 until RAZORPAY_WEBHOOK_SECRET is set; 400 once it is"
check GET  /api/generations/abc         401 "404 here means the rewrite swallowed the dynamic route"

echo
echo "Configuration"
health=$(curl -s "$BASE/api/health" --max-time "$MAX_SECONDS")
if [ -z "$health" ]; then
    echo "  FAIL  /api/health returned nothing"
    fail=1
else
    echo "  $health" | head -c 400; echo
    case "$health" in
        *'"status":"ok"'*)            echo "  ok    fully configured" ;;
        *'"status":"misconfigured"'*) echo "  WARN  missing env vars (listed above)" ;;
    esac
fi

echo
[ "$fail" -eq 0 ] && echo "All checks passed." || echo "Some checks failed."
exit "$fail"
