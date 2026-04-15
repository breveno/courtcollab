#!/bin/bash
# CourtCollab deploy script
# Usage: bash deploy.sh "describe what you changed"
# Example: bash deploy.sh "Added payment success page"
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

MSG="${1:-update}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " CourtCollab Deploy"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Step 1: Check JavaScript for syntax errors ──────────────────────────────
echo ""
echo "→ Checking app.js for syntax errors..."
if command -v node &>/dev/null; then
  if ! node --check app.js 2>&1; then
    echo ""
    echo "✗ DEPLOY STOPPED — app.js has a syntax error (see above)."
    echo "  Fix the error, then run this script again."
    exit 1
  fi
  echo "✓ app.js looks good"
else
  echo "⚠️  Node.js not found — skipping syntax check."
  echo "   Install it at https://nodejs.org to enable automatic error checking."
fi

# ── Step 2: Warn about files not in git (would not deploy to Netlify) ───────
echo ""
echo "→ Checking for untracked files..."
UNTRACKED=$(git ls-files --others --exclude-standard)
if [ -n "$UNTRACKED" ]; then
  echo ""
  echo "⚠️  WARNING — These files exist locally but are NOT in git."
  echo "   They will NOT appear on your live site unless you add them:"
  echo ""
  echo "$UNTRACKED" | sed 's/^/     /'
  echo ""
  read -p "   Add them all and continue? (y/n): " CONFIRM
  if [ "$CONFIRM" != "y" ]; then
    echo "  Deploy cancelled. Run again when ready."
    exit 1
  fi
fi

# ── Step 3: Commit and push everything ──────────────────────────────────────
echo ""
echo "→ Committing and pushing to GitHub..."
git add -A
git commit -m "$MSG" || echo "  (nothing new to commit)"
git push origin main

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✓ Deployed! Wait ~2 min then hard"
echo "  refresh with ⌘ + Shift + R"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
