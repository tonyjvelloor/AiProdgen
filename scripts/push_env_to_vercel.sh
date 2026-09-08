#!/usr/bin/env bash
# scripts/push_env_to_vercel.sh
# Copies the variables this app needs from the local .env into the Vercel
# project. Run it yourself -- the values are read straight from .env on this
# machine and piped to the Vercel CLI; they are not printed.
#
#   ./scripts/push_env_to_vercel.sh production
set -euo pipefail

TARGET="${1:-production}"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"

[ -f "$ENV_FILE" ] || { echo "No .env found at $ENV_FILE"; exit 1; }

VARS=(
  SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY JWT_SECRET KEY_ENCRYPTION_SECRET
  RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET
  GEMINI_API_KEY REPLICATE_API_TOKEN
  UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN
  APP_URL SENTRY_DSN
)

for KEY in "${VARS[@]}"; do
  VALUE="$(grep -E "^${KEY}=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
  if [ -z "$VALUE" ]; then
    echo "skip  $KEY (not set in .env)"
    continue
  fi
  # Remove first so re-runs update rather than erroring on a duplicate.
  vercel env rm "$KEY" "$TARGET" --yes >/dev/null 2>&1 || true
  printf '%s' "$VALUE" | vercel env add "$KEY" "$TARGET" >/dev/null 2>&1 \
    && echo "set   $KEY -> $TARGET" \
    || echo "FAIL  $KEY"
done

echo
echo "Done. Verify with:  vercel env ls $TARGET"
