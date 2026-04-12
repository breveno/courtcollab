"""
One-time script to register the SignWell webhook URL via their API.

Run from your project root:
  railway run python backend/register_webhook.py

Requires these env vars (already set on Railway):
  SIGNWELL_API_KEY        — your SignWell API key
  RAILWAY_PUBLIC_DOMAIN   — set automatically by Railway (e.g. courtcollab.up.railway.app)

After running, copy the printed secret and add it to Railway as:
  SIGNWELL_WEBHOOK_SECRET = <secret>
Then redeploy.
"""

import os
import json
import urllib.request

API_KEY = os.environ.get("SIGNWELL_API_KEY", "")
if not API_KEY:
    raise SystemExit("ERROR: SIGNWELL_API_KEY is not set.")

# Build the webhook URL from Railway's public domain
domain = (
    os.environ.get("RAILWAY_PUBLIC_DOMAIN")
    or os.environ.get("PUBLIC_URL", "")
).rstrip("/")

if not domain:
    raise SystemExit(
        "ERROR: Could not detect Railway domain.\n"
        "Set RAILWAY_PUBLIC_DOMAIN on Railway, or edit this script and hardcode your URL."
    )

# Strip protocol if accidentally included
if domain.startswith("http"):
    from urllib.parse import urlparse
    domain = urlparse(domain).netloc

webhook_url = f"https://{domain}/webhooks/signwell"

print(f"\nRegistering webhook URL: {webhook_url}\n")

payload = json.dumps({
    "api_webhook": {
        "url": webhook_url,
        "events": [
            "document_signed",
            "document_completed",
            "document_declined",
            "document_expired",
        ]
    }
}).encode("utf-8")

req = urllib.request.Request(
    "https://www.signwell.com/api/v1/api_webhooks",
    data=payload,
    headers={
        "X-Api-Token": API_KEY,
        "Content-Type": "application/json",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read())
except urllib.error.HTTPError as e:
    body = e.read().decode()
    raise SystemExit(f"ERROR: SignWell returned {e.code}: {body}")

webhook = result.get("api_webhook", result)
secret  = webhook.get("secret", "")
wid     = webhook.get("id", "")

print("=" * 55)
print("Webhook registered successfully!")
print(f"  Webhook ID : {wid}")
print(f"  URL        : {webhook_url}")
print()
if secret:
    print(f"  SECRET     : {secret}")
    print()
    print("Next step:")
    print(f"  Add this to Railway environment variables:")
    print(f"    SIGNWELL_WEBHOOK_SECRET = {secret}")
    print("  Then redeploy your Railway service.")
else:
    print("No secret returned — check SignWell dashboard or API response:")
    print(json.dumps(result, indent=2))
print("=" * 55)
