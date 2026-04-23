"""
SignWell API helper module for CourtCollab.
All calls go through this module — the API key is read from the
SIGNWELL_API_KEY environment variable and never hardcoded.

Base URL: https://www.signwell.com/api/v1
Auth:     X-Api-Token header (SignWell's documented format)

Set SIGNWELL_API_KEY to the exact API key string shown in the SignWell
dashboard under Settings → API. Do not encode or decode it.
"""

import os
import httpx

SIGNWELL_BASE_URL = "https://www.signwell.com/api/v1"
SIGNWELL_TEST_MODE = os.environ.get("SIGNWELL_TEST_MODE", "true").lower() == "true"


def _headers() -> dict:
    api_key = os.environ.get("SIGNWELL_API_KEY", "")
    if not api_key:
        raise RuntimeError("SIGNWELL_API_KEY environment variable is not set")
    return {
        "X-Api-Token": api_key,
        "Content-Type": "application/json",
    }


# ---------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------

async def create_document(
    name: str,
    subject: str,
    message: str,
    signers: list[dict],           # [{"name": "...", "email": "...", "signing_order"?: int}]
    file_urls: list[str] = None,   # list of public PDF URLs
    file_base64: list[dict] = None,# [{"data": "<base64>", "name": "contract.pdf", "fields"?: [...]}]
    fields: list[dict] = None,     # top-level fields array (preferred by SignWell API)
    redirect_url: str = None,
    send_in_order: bool = False,   # enforce sequential signing when True
) -> dict:
    """
    Create a new signature request document.

    Returns the SignWell document object including `id` and per-signer
    `embedded_signing_url` values.

    signers may include an optional `signing_order` key (int, 1-based) to
    enforce a sequential signing sequence. Set send_in_order=True alongside it.
    file_base64 entries have keys: `data` (base64 string), `name` (filename).
    """
    recipients = []
    for i, s in enumerate(signers):
        r = {"id": str(i + 1), "name": s["name"], "email": s["email"]}
        if "signing_order" in s:
            r["signing_order"] = s["signing_order"]
        recipients.append(r)

    files = []
    for i, url in enumerate(file_urls or []):
        files.append({"file_url": url, "name": f"contract_{i+1}.pdf"})
    for entry in (file_base64 or []):
        files.append({"file_base64": entry["data"], "name": entry["name"]})

    payload = {
        "test_mode": SIGNWELL_TEST_MODE,
        "name": name,
        "subject": subject,
        "message": message,
        "recipients": recipients,
        "files": files,
    }
    # Fields go at top level per SignWell API spec, with api_id required per field
    if fields:
        payload["fields"] = fields
    if send_in_order:
        payload["send_in_order"] = True
    if redirect_url:
        payload["redirect_url"] = redirect_url

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{SIGNWELL_BASE_URL}/documents",
            headers=_headers(),
            json=payload,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()


async def get_document(document_id: str) -> dict:
    """Fetch the current status and metadata of a document."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{SIGNWELL_BASE_URL}/documents/{document_id}",
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()


async def cancel_document(document_id: str) -> dict:
    """Cancel (delete) a pending document."""
    async with httpx.AsyncClient() as client:
        resp = await client.delete(
            f"{SIGNWELL_BASE_URL}/documents/{document_id}",
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json() if resp.content else {"status": "cancelled"}


async def get_completed_pdf_url(document_id: str) -> str:
    """
    Returns the download URL for the completed (fully signed) PDF.
    Only available once all signers have signed.
    """
    doc = await get_document(document_id)
    return doc.get("completed_pdf_url", "")


# ---------------------------------------------------------------------------
# Embedded signing
# ---------------------------------------------------------------------------

async def get_embedded_signing_url(document_id: str, recipient_id: str) -> str:
    """
    Generate an embedded signing URL for a specific recipient so they can
    sign inside the CourtCollab UI without leaving the platform.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{SIGNWELL_BASE_URL}/documents/{document_id}/recipients/{recipient_id}/embedded_signing_url",
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("embedded_signing_url", "")


# ---------------------------------------------------------------------------
# Templates (optional — used when you have a pre-built contract template)
# ---------------------------------------------------------------------------

async def list_templates() -> list:
    """List all available document templates in the SignWell account."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{SIGNWELL_BASE_URL}/document_templates",
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json().get("document_templates", [])


# ---------------------------------------------------------------------------
# Webhook management
# ---------------------------------------------------------------------------

async def register_webhook(url: str, events: list[str] = None) -> dict:
    """
    Register a webhook URL with SignWell so it receives signature events.

    Default events:
      document_signed, document_completed, document_declined, document_expired

    Returns the created webhook object (includes `id` and `secret`).
    """
    if events is None:
        events = [
            "document_signed",
            "document_completed",
            "document_declined",
            "document_expired",
        ]
    payload = {"api_webhook": {"url": url, "events": events}}
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{SIGNWELL_BASE_URL}/api_webhooks",
            headers=_headers(),
            json=payload,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()


async def list_webhooks() -> list:
    """List all registered webhooks on the SignWell account."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{SIGNWELL_BASE_URL}/api_webhooks",
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        # SignWell returns { "api_webhooks": [...] } or a bare list
        if isinstance(data, list):
            return data
        return data.get("api_webhooks", data)


async def delete_webhook(webhook_id: str) -> dict:
    """Delete a registered webhook by ID."""
    async with httpx.AsyncClient() as client:
        resp = await client.delete(
            f"{SIGNWELL_BASE_URL}/api_webhooks/{webhook_id}",
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json() if resp.content else {"deleted": True}


async def create_document_from_template(
    template_id: str,
    name: str,
    subject: str,
    message: str,
    signers: list[dict],
    fields: dict = None,
    redirect_url: str = None,
) -> dict:
    """
    Create a signature request from a saved SignWell template.

    `signers`  — [{"name": "...", "email": "...", "role": "template_role"}]
    `fields`   — {"field_name": "value"} merge-field overrides
    """
    payload = {
        "test_mode": SIGNWELL_TEST_MODE,
        "name": name,
        "subject": subject,
        "message": message,
        "template_id": template_id,
        "recipients": [
            {
                "id": str(i + 1),
                "name": s["name"],
                "email": s["email"],
                **({"role": s["role"]} if "role" in s else {}),
            }
            for i, s in enumerate(signers)
        ],
    }
    if fields:
        payload["fields"] = [{"api_id": k, "value": v} for k, v in fields.items()]
    if redirect_url:
        payload["redirect_url"] = redirect_url

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{SIGNWELL_BASE_URL}/document_templates/{template_id}/documents",
            headers=_headers(),
            json=payload,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()
