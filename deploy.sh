#!/bin/bash
# CourtCollab frontend deploy script
# Always run this from anywhere — it resolves its own directory.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "→ Deploying from: $DIR"
netlify deploy --prod --site e4db2949-f599-4fc3-9cad-74eb8a8fce47

echo ""
echo "→ Smoke-testing API..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST https://courtcollab-production.up.railway.app/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"smoke@test.invalid","password":"x"}' \
  --max-time 10)

if [ "$STATUS" = "401" ] || [ "$STATUS" = "422" ]; then
  echo "✓ API is reachable (HTTP $STATUS)"
else
  echo "✗ API check failed — got HTTP $STATUS. Investigate before assuming deploy is healthy."
  exit 1
fi
