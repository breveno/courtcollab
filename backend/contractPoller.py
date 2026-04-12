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

SIGNWELL_BASE_URL     = "https://www.signwell.com/api/v1"
POLL_INTERVAL_SECONDS = 600   # 10 minutes
STORAGE_BUCKET        = "signed-contracts"


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


async def _save_signed_pdf_to_storage(deal_id: int, pdf_url: str) -> str:
    """
    Download the completed PDF from SignWell and upload it permanently to
    Supabase Storage.

    Returns the public URL of the stored file, or "" on failure.

    Required env vars:
      SUPABASE_URL         — e.g. https://xyz.supabase.co
      SUPABASE_SERVICE_KEY — service role key (has storage write access)
    """
    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    service_key  = os.environ.get("SUPABASE_SERVICE_KEY", "")

    if not supabase_url or not service_key:
        logging.warning(
            "[STORAGE] SUPABASE_URL or SUPABASE_SERVICE_KEY not set — "
            "skipping PDF storage for deal #%s", deal_id
        )
        return ""

    filename     = f"deal-{deal_id}-signed.pdf"
    upload_path  = f"{STORAGE_BUCKET}/{filename}"
    upload_url   = f"{supabase_url}/storage/v1/object/{upload_path}"
    public_url   = f"{supabase_url}/storage/v1/object/public/{upload_path}"

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            # 1. Download the signed PDF from SignWell
            pdf_resp = await client.get(pdf_url)
            pdf_resp.raise_for_status()
            pdf_bytes = pdf_resp.content

            # 2. Upload to Supabase Storage (upsert so re-runs don't fail)
            up_resp = await client.post(
                upload_url,
                content=pdf_bytes,
                headers={
                    "Authorization":  f"Bearer {service_key}",
                    "Content-Type":   "application/pdf",
                    "x-upsert":       "true",
                },
            )
            up_resp.raise_for_status()

        logging.info("[STORAGE] Saved signed PDF for deal #%s → %s", deal_id, public_url)
        return public_url

    except Exception as exc:
        logging.warning("[STORAGE] Failed to save PDF for deal #%s: %s", deal_id, exc)
        return ""


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

        use_ssl = os.environ.get("SMTP_SSL", "false").lower() == "true" or port == 465
        if use_ssl:
            with smtplib.SMTP_SSL(host, port, timeout=15) as srv:
                srv.login(user, passwd)
                srv.sendmail(sender, [to_email], msg.as_string())
        else:
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

    # 4a. If completing now, save the PDF to Supabase Storage first
    signed_contract_url = ""
    if updates.get("contract_status") == "contract_complete" and completed_url:
        signed_contract_url = await _save_signed_pdf_to_storage(deal_id, completed_url)
        if signed_contract_url:
            updates["signed_contract_url"] = signed_contract_url

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
        display_url   = signed_contract_url or completed_url

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
                    completed_url= display_url,
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


# ---------------------------------------------------------------------------
# Contract reminder / expiry job — runs every 24 hours
# ---------------------------------------------------------------------------

REMINDER_INTERVAL_SECONDS = 86_400  # 24 hours
REMINDER_THRESHOLD_HOURS  = 24      # send reminder after this many hours unsigned
EXPIRY_THRESHOLD_DAYS     = 7       # expire contract after this many days unsigned
APP_URL = os.environ.get("PUBLIC_URL", "https://courtcollab.com")


def _send_reminder_email(
    to_name: str,
    to_email: str,
    deal_id: int,
    campaign_title: str,
    partner_name: str,
    amount: int,
    hours_waiting: int,
) -> None:
    """Send a signature reminder email via Zoho SMTP."""
    host   = os.environ.get("SMTP_HOST",  "smtp.zoho.com")
    port   = int(os.environ.get("SMTP_PORT", "587"))
    user   = os.environ.get("SMTP_USER",  "")
    passwd = os.environ.get("SMTP_PASS",  "")
    sender = os.environ.get("FROM_EMAIL", user) or user

    if not user or not passwd:
        logging.warning("[REMINDER] SMTP not configured — skipping reminder to %s", to_email)
        return

    dashboard_url = APP_URL.rstrip("/")
    body = (
        f"Hi {to_name},\n\n"
        f"Your deal contract has been waiting for your signature for more than "
        f"{hours_waiting} hours. Please sign as soon as possible to keep your deal active.\n\n"
        f"  Deal          : {campaign_title}\n"
        f"  Partner       : {partner_name}\n"
        f"  Deal Amount   : ${amount:,}\n"
        f"  Deal ID       : #{deal_id}\n\n"
        f"Sign your contract now by logging into your CourtCollab dashboard:\n"
        f"{dashboard_url}\n\n"
        f"If you do not sign within 7 days of receiving the contract, the deal will "
        f"automatically expire and both parties will need to restart the process.\n\n"
        f"— The CourtCollab Team\n"
        f"courtcollab.com\n"
    )

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = "Action Required: Your CourtCollab Contract Needs Your Signature"
        msg["From"]    = f"CourtCollab <{sender}>"
        msg["To"]      = to_email
        msg.attach(MIMEText(body, "plain"))

        use_ssl = os.environ.get("SMTP_SSL", "false").lower() == "true" or port == 465
        if use_ssl:
            with smtplib.SMTP_SSL(host, port, timeout=15) as srv:
                srv.login(user, passwd)
                srv.sendmail(sender, [to_email], msg.as_string())
        else:
            with smtplib.SMTP(host, port, timeout=15) as srv:
                srv.ehlo()
                srv.starttls()
                srv.login(user, passwd)
                srv.sendmail(sender, [to_email], msg.as_string())

        logging.info("[REMINDER] Reminder sent to %s for deal #%s", to_email, deal_id)
    except Exception as exc:
        logging.warning("[REMINDER] Email failed for %s: %s", to_email, exc)


def _send_expiry_email(
    to_name: str,
    to_email: str,
    deal_id: int,
    campaign_title: str,
    partner_name: str,
    amount: int,
) -> None:
    """Send a contract-expired notice via Zoho SMTP."""
    host   = os.environ.get("SMTP_HOST",  "smtp.zoho.com")
    port   = int(os.environ.get("SMTP_PORT", "587"))
    user   = os.environ.get("SMTP_USER",  "")
    passwd = os.environ.get("SMTP_PASS",  "")
    sender = os.environ.get("FROM_EMAIL", user) or user

    if not user or not passwd:
        logging.warning("[REMINDER] SMTP not configured — skipping expiry email to %s", to_email)
        return

    dashboard_url = APP_URL.rstrip("/")
    body = (
        f"Hi {to_name},\n\n"
        f"Unfortunately, your brand deal contract on CourtCollab has expired because "
        f"it was not signed by all parties within 7 days.\n\n"
        f"  Deal          : {campaign_title}\n"
        f"  Partner       : {partner_name}\n"
        f"  Deal Amount   : ${amount:,}\n"
        f"  Deal ID       : #{deal_id}\n\n"
        f"If both parties are still interested in working together, you can restart "
        f"the process by creating a new deal on CourtCollab.\n\n"
        f"Visit your dashboard to get started:\n"
        f"{dashboard_url}\n\n"
        f"— The CourtCollab Team\n"
        f"courtcollab.com\n"
    )

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = "Your CourtCollab Contract Has Expired"
        msg["From"]    = f"CourtCollab <{sender}>"
        msg["To"]      = to_email
        msg.attach(MIMEText(body, "plain"))

        use_ssl = os.environ.get("SMTP_SSL", "false").lower() == "true" or port == 465
        if use_ssl:
            with smtplib.SMTP_SSL(host, port, timeout=15) as srv:
                srv.login(user, passwd)
                srv.sendmail(sender, [to_email], msg.as_string())
        else:
            with smtplib.SMTP(host, port, timeout=15) as srv:
                srv.ehlo()
                srv.starttls()
                srv.login(user, passwd)
                srv.sendmail(sender, [to_email], msg.as_string())

        logging.info("[REMINDER] Expiry notice sent to %s for deal #%s", to_email, deal_id)
    except Exception as exc:
        logging.warning("[REMINDER] Expiry email failed for %s: %s", to_email, exc)


async def contract_reminder_job(get_conn=None) -> None:
    """
    Runs once every 24 hours.

    1. Query all deals with pending contract signatures where contract_sent_at
       is more than REMINDER_THRESHOLD_HOURS old.
    2. Send a reminder email to any party that has not yet signed.
    3. For contracts unsigned for more than EXPIRY_THRESHOLD_DAYS days:
       - Update contract_status to 'contract_expired' in the database.
       - Send an expiry email to both parties.
    """
    try:
        from database import get_conn as _get_conn
        _gc = get_conn or _get_conn
    except Exception:
        logging.error("[REMINDER] Could not import get_conn")
        return

    logging.info("[REMINDER] Running contract reminder job...")

    with _gc() as conn:
        pending_deals = conn.execute("""
            SELECT d.id,
                   d.contract_sent_at,
                   d.brand_signed,
                   d.creator_signed,
                   d.amount,
                   ub.name  AS brand_name,
                   ub.email AS brand_email,
                   uc.name  AS creator_name,
                   uc.email AS creator_email,
                   c.title  AS campaign_title
            FROM deals d
            JOIN users ub    ON ub.id = d.brand_id
            JOIN users uc    ON uc.id = d.creator_id
            JOIN campaigns c ON c.id  = d.campaign_id
            WHERE d.contract_status IN ('contract_sent', 'brand_signed', 'creator_signed')
              AND d.contract_sent_at IS NOT NULL
              AND d.contract_sent_at != ''
        """).fetchall()

    if not pending_deals:
        logging.info("[REMINDER] No pending contracts to check.")
        return

    now = datetime.now(timezone.utc)

    for deal in pending_deals:
        deal_id        = deal["id"]
        campaign_title = deal["campaign_title"] or f"Deal #{deal_id}"
        amount         = deal["amount"] or 0

        # Parse contract_sent_at
        try:
            sent_str = deal["contract_sent_at"].replace(" ", "T")
            if not sent_str.endswith("Z") and "+" not in sent_str:
                sent_str += "+00:00"
            sent_at = datetime.fromisoformat(sent_str)
            if sent_at.tzinfo is None:
                sent_at = sent_at.replace(tzinfo=timezone.utc)
        except Exception as exc:
            logging.warning("[REMINDER] Could not parse contract_sent_at for deal #%s: %s", deal_id, exc)
            continue

        hours_since = (now - sent_at).total_seconds() / 3600
        days_since  = hours_since / 24

        # ── 7-day expiry ────────────────────────────────────────────────────
        if days_since >= EXPIRY_THRESHOLD_DAYS:
            with _gc() as conn:
                conn.execute(
                    """UPDATE deals
                       SET contract_status = 'contract_expired',
                           updated_at      = ?
                       WHERE id = ?""",
                    (_now_utc(), deal_id),
                )
                conn.commit()

            logging.info(
                "[REMINDER] Deal #%s contract expired after %.1f days",
                deal_id, days_since,
            )

            # Notify both parties
            for name, email in [
                (deal["brand_name"],   deal["brand_email"]),
                (deal["creator_name"], deal["creator_email"]),
            ]:
                if email:
                    _send_expiry_email(
                        to_name        = name   or "there",
                        to_email       = email,
                        deal_id        = deal_id,
                        campaign_title = campaign_title,
                        partner_name   = deal["creator_name"] if email == deal["brand_email"] else deal["brand_name"],
                        amount         = amount,
                    )
            continue  # skip reminder for expired deals

        # ── 24-hour reminder ─────────────────────────────────────────────────
        if hours_since < REMINDER_THRESHOLD_HOURS:
            continue  # too soon to remind

        # Send reminder only to the party that has NOT yet signed
        unsigned = []
        if not deal["brand_signed"]:
            unsigned.append((deal["brand_name"], deal["brand_email"], deal["creator_name"]))
        if not deal["creator_signed"]:
            unsigned.append((deal["creator_name"], deal["creator_email"], deal["brand_name"]))

        for name, email, partner in unsigned:
            if email:
                _send_reminder_email(
                    to_name        = name    or "there",
                    to_email       = email,
                    deal_id        = deal_id,
                    campaign_title = campaign_title,
                    partner_name   = partner or "your partner",
                    amount         = amount,
                    hours_waiting  = int(hours_since),
                )

    logging.info("[REMINDER] Contract reminder job complete.")


async def contract_reminder_loop(get_conn=None) -> None:
    """
    Infinite loop that runs contract_reminder_job every 24 hours.
    Staggered by 60 seconds after server boot so the poller starts first.

        asyncio.create_task(contract_reminder_loop())
    """
    logging.info("[REMINDER] Contract reminder loop started — interval 24h")
    await asyncio.sleep(60)  # let server fully boot

    while True:
        try:
            await contract_reminder_job(get_conn)
        except Exception as exc:
            logging.error("[REMINDER] Unexpected error: %s", exc, exc_info=True)

        await asyncio.sleep(REMINDER_INTERVAL_SECONDS)
