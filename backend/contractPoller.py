"""
contractPoller.py — SignWell document status poller for CourtCollab

Runs as a background asyncio task every 10 minutes.
Replaces the need for a SignWell webhook (which requires a paid plan).

Flow:
  1. Query deals with status='contract_sent' that have a contract_document_id
  2. Call SignWell GET /documents/{id} to check per-recipient signing status
  3. Update brand_signed / creator_signed + timestamps as each party signs
  4. When both signed → contract_complete + save completed PDF URL + send emails

Hooked into FastAPI startup in main.py:
  asyncio.create_task(contract_poll_loop())
"""

import asyncio
import logging
import os
import smtplib
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import httpx

SIGNWELL_BASE_URL = "https://www.signwell.com/api/v1"
POLL_INTERVAL_SECONDS = 600  # 10 minutes


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _signwell_headers() -> dict:
    api_key = os.environ.get("SIGNWELL_API_KEY", "")
    if not api_key:
        raise RuntimeError("SIGNWELL_API_KEY is not set")
    return {"X-Api-Token": api_key, "Content-Type": "application/json"}


def _now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _send_contract_complete_email(
    to_name: str,
    to_email: str,
    deal_id: int,
    brand_name: str,
    creator_name: str,
    completed_url: str,
) -> None:
    """Send a 'contract fully signed' confirmation via Zoho SMTP."""
    host   = os.environ.get("SMTP_HOST",  "smtp.zoho.com")
    port   = int(os.environ.get("SMTP_PORT", "587"))
    user   = os.environ.get("SMTP_USER",  "")
    passwd = os.environ.get("SMTP_PASS",  "")
    sender = os.environ.get("FROM_EMAIL", user) or user

    if not user or not passwd:
        logging.warning("[POLLER] SMTP_USER/SMTP_PASS not set — skipping email to %s", to_email)
        return

    pdf_line = f"\n  Signed PDF      : {completed_url}" if completed_url else ""

    body = (
        f"Hi {to_name},\n\n"
        f"Great news! Your brand deal agreement on CourtCollab has been signed "
        f"by both parties and is now fully executed.\n\n"
        f"  Deal ID         : #{deal_id}\n"
        f"  Brand           : {brand_name}\n"
        f"  Creator         : {creator_name}\n"
        f"  Contract Status : Fully Signed{pdf_line}\n\n"
        f"What happens next:\n"
        f"  • Creator — you can now begin work on the agreed deliverables.\n"
        f"  • Brand — payment is now unlocked and held in escrow by CourtCollab "
        f"until you confirm delivery of all content.\n"
        f"  • Once the brand confirms delivery, the creator receives 85% of the "
        f"deal amount within 7 days.\n\n"
        f"Log in at any time to track progress: https://courtcollab.com\n\n"
        f"— The CourtCollab Team\n"
        f"courtcollab.com\n"
    )

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = "Your CourtCollab contract is fully signed — payment is now unlocked"
        msg["From"]    = f"CourtCollab <{sender}>"
        msg["To"]      = to_email
        msg.attach(MIMEText(body, "plain"))

        with smtplib.SMTP(host, port, timeout=15) as srv:
            srv.ehlo()
            srv.starttls()
            srv.login(user, passwd)
            srv.sendmail(sender, [to_email], msg.as_string())

        logging.info("[POLLER] Confirmation email sent to %s", to_email)
    except Exception as exc:
        logging.warning("[POLLER] Email failed for %s: %s", to_email, exc)


# ---------------------------------------------------------------------------
# Core polling logic
# ---------------------------------------------------------------------------

async def poll_contract_statuses(get_conn) -> None:
    """
    Check all pending SignWell documents and update the deals table.
    `get_conn` is the same database connection factory used in main.py.
    """
    # 1. Fetch all deals awaiting signatures
    try:
        from database import get_conn as _get_conn  # local import to avoid circular
        _gc = get_conn or _get_conn
    except Exception:
        logging.error("[POLLER] Could not import get_conn")
        return

    with _gc() as conn:
        pending_deals = conn.execute("""
            SELECT d.id,
                   d.contract_document_id,
                   d.brand_signed,
                   d.creator_signed,
                   ub.name  AS brand_name,
                   ub.email AS brand_email,
                   uc.name  AS creator_name,
                   uc.email AS creator_email,
                   bp.company_name AS brand_company
            FROM deals d
            JOIN users ub ON ub.id = d.brand_id
            JOIN users uc ON uc.id = d.creator_id
            LEFT JOIN brand_profiles bp ON bp.user_id = d.brand_id
            WHERE d.contract_status = 'contract_sent'
              AND d.contract_document_id IS NOT NULL
              AND d.contract_document_id != ''
        """).fetchall()

    if not pending_deals:
        logging.debug("[POLLER] No pending contracts to check.")
        return

    logging.info("[POLLER] Checking %d pending contract(s)...", len(pending_deals))

    async with httpx.AsyncClient(timeout=20) as client:
        for deal in pending_deals:
            await _check_one_deal(deal, client, _gc)


async def _check_one_deal(deal, client: httpx.AsyncClient, get_conn) -> None:
    """Fetch the SignWell document status for a single deal and update the DB."""
    deal_id     = deal["id"]
    doc_id      = deal["contract_document_id"]
    brand_email = (deal["brand_email"]   or "").lower().strip()
    creator_email=(deal["creator_email"] or "").lower().strip()

    # 2. Call SignWell API
    try:
        headers = _signwell_headers()
    except RuntimeError as exc:
        logging.error("[POLLER] %s", exc)
        return

    try:
        resp = await client.get(
            f"{SIGNWELL_BASE_URL}/documents/{doc_id}",
            headers=headers,
        )
        resp.raise_for_status()
        doc = resp.json()
    except httpx.HTTPStatusError as exc:
        logging.warning("[POLLER] SignWell %s for deal #%s doc %s", exc.response.status_code, deal_id, doc_id)
        return
    except Exception as exc:
        logging.warning("[POLLER] Request error for deal #%s: %s", deal_id, exc)
        return

    recipients    = doc.get("recipients") or []
    doc_status    = doc.get("status", "")
    completed_url = doc.get("completed_pdf_url") or ""

    brand_signed   = bool(deal["brand_signed"])
    creator_signed = bool(deal["creator_signed"])
    updates        = {}

    # 3. Check each recipient's signing status
    for r in recipients:
        r_email  = (r.get("email") or "").lower().strip()
        r_status = r.get("status", "")        # "completed" means signed
        r_signed_at = r.get("signed_at") or _now_utc()

        if r_status == "completed":
            if r_email == brand_email and not brand_signed:
                updates["brand_signed"]    = 1
                updates["brand_signed_at"] = r_signed_at
                brand_signed = True
                logging.info("[POLLER] Deal #%s — brand signed at %s", deal_id, r_signed_at)

            elif r_email == creator_email and not creator_signed:
                updates["creator_signed"]    = 1
                updates["creator_signed_at"] = r_signed_at
                creator_signed = True
                logging.info("[POLLER] Deal #%s — creator signed at %s", deal_id, r_signed_at)

    # Detect fully signed via document status as fallback
    if doc_status == "completed":
        if not brand_signed:
            updates["brand_signed"]    = 1
            updates["brand_signed_at"] = updates.get("brand_signed_at", _now_utc())
            brand_signed = True
        if not creator_signed:
            updates["creator_signed"]    = 1
            updates["creator_signed_at"] = updates.get("creator_signed_at", _now_utc())
            creator_signed = True

    if not updates:
        return  # nothing changed for this deal

    # 4. Persist updates
    updates["updated_at"] = _now_utc()

    if brand_signed and creator_signed:
        updates["contract_status"]        = "contract_complete"
        updates["contract_completed_url"] = completed_url

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values     = list(updates.values()) + [deal_id]

    with get_conn() as conn:
        conn.execute(
            f"UPDATE deals SET {set_clause} WHERE id = ?",
            values,
        )
        conn.commit()

    logging.info("[POLLER] Deal #%s updated: %s", deal_id, list(updates.keys()))

    # 5. Send confirmation emails if contract is now complete
    if updates.get("contract_status") == "contract_complete":
        brand_display = (deal.get("brand_company") or deal.get("brand_name") or "Brand").strip()
        creator_name  = (deal.get("creator_name") or "Creator").strip()

        for name, email in [
            (brand_display, deal["brand_email"]),
            (creator_name,  deal["creator_email"]),
        ]:
            if email:
                _send_contract_complete_email(
                    to_name      = name,
                    to_email     = email,
                    deal_id      = deal_id,
                    brand_name   = brand_display,
                    creator_name = creator_name,
                    completed_url= completed_url,
                )


# ---------------------------------------------------------------------------
# Asyncio background loop — called once at FastAPI startup
# ---------------------------------------------------------------------------

async def contract_poll_loop(get_conn=None) -> None:
    """
    Infinite loop that polls SignWell every POLL_INTERVAL_SECONDS.
    Designed to run as an asyncio background task:

        asyncio.create_task(contract_poll_loop())
    """
    logging.info("[POLLER] Contract poller started — interval %ds", POLL_INTERVAL_SECONDS)

    # Stagger the first run by 30 seconds so the server is fully ready
    await asyncio.sleep(30)

    while True:
        try:
            await poll_contract_statuses(get_conn)
        except Exception as exc:
            logging.error("[POLLER] Unexpected error: %s", exc, exc_info=True)

        await asyncio.sleep(POLL_INTERVAL_SECONDS)
