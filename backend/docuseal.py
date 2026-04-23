"""
DocuSeal API helper module for CourtCollab.
Replaces the SignWell integration.

Base URL: https://api.docuseal.com
Auth:     X-Auth-Token header

Set DOCUSEAL_API_KEY to the API token from your DocuSeal account
(Settings → API Tokens).
"""

import os
import httpx

DOCUSEAL_BASE_URL = "https://api.docuseal.com"


def _headers() -> dict:
    api_key = os.environ.get("DOCUSEAL_API_KEY", "")
    if not api_key:
        raise RuntimeError("DOCUSEAL_API_KEY environment variable is not set")
    return {
        "X-Auth-Token": api_key,
        "Content-Type": "application/json",
    }


async def create_submission(
    name: str,
    signers: list[dict],   # [{"name": "...", "email": "...", "role": "..."}] — order = signing order
    file_base64: str,      # raw base64, no data-URI prefix
    file_name: str = "contract.pdf",
    send_email: bool = False,
    fields: list[dict] | None = None,  # DocuSeal field definitions with areas/coordinates
) -> dict:
    """
    Create a signing request (submission) from a PDF.

    Step 1: POST /templates  — upload the PDF to create a one-off template.
    Step 2: POST /submissions — create a submission from that template_id.

    Signers are sequential (order="preserved"): second signer can only sign
    after the first completes.  send_email=False so DocuSeal won't email;
    signers use the embedded signing URL instead.

    Returns:
      {
        "submission_id": int,
        "submitters": [{"id", "slug", "email", "role", "status", ...}, ...]
      }
    """
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{DOCUSEAL_BASE_URL}/submissions/pdf",
            headers=_headers(),
            json={
                "name": name,
                "documents": [{
                    "name": file_name,
                    "file": f"data:application/pdf;base64,{file_base64}",
                    **({"fields": fields} if fields else {}),
                }],
                "send_email": send_email,
                "submitters": [
                    {
                        "name":  s["name"],
                        "email": s["email"],
                        "role":  s.get("role", s["name"]),
                    }
                    for s in signers
                ],
            },
            timeout=60,
        )
        if not resp.is_success:
            raise RuntimeError(f"DocuSeal {resp.status_code}: {resp.text[:500]}")
        data = resp.json()

    # /submissions/pdf returns {"id": N, "submitters": [...]}
    if isinstance(data, dict):
        submission_id = data.get("id")
        submitters = data.get("submitters", [])
    else:
        # fallback: flat list of submitters (older endpoint format)
        submitters = data
        submission_id = submitters[0]["submission_id"] if submitters else None

    return {
        "submission_id": submission_id,
        "submitters": submitters,
    }


async def get_submission(submission_id: int) -> dict:
    """Fetch the current status of a submission."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{DOCUSEAL_BASE_URL}/submissions/{submission_id}",
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()


async def cancel_submission(submission_id: int) -> dict:
    """Archive/cancel a submission so it can no longer be signed."""
    async with httpx.AsyncClient() as client:
        resp = await client.delete(
            f"{DOCUSEAL_BASE_URL}/submissions/{submission_id}",
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json() if resp.content else {"status": "cancelled"}


def signing_url(slug: str) -> str:
    """Return the embedded signing URL for a submitter slug."""
    return f"https://docuseal.com/s/{slug}"
