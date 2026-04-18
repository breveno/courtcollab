"""
staleDealsChecker.py — Monitors held payments for stale / undelivered deals.

Flow:
  1. Every 12 hours, query all deals that have a held payment older than 14 days
     where the brand has NOT yet marked the deal complete.
  2. Send reminder emails to both parties every 3 days (starting at day 14).
     Brand  : "please review the creator's content and mark the deal as complete
               in your dashboard if you are satisfied."
     Creator: "please ensure your content has been delivered and follow up with
               the brand to mark the deal complete so your payment can be released."
  3. After 30 days, flag the deal as needs_review=1 in the DB and notify
     ben@courtcollab.com for manual intervention.
  4. Reminder count and last-sent timestamp are stored in deals.reminders_sent
     and deals.last_reminder_sent.

Hooked into FastAPI startup in main.py:
    asyncio.create_task(stale_deal_check_loop(get_conn))
"""

import asyncio
import logging
import os
import smtplib
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

CHECK_INTERVAL_SECONDS = 43_200    # run every 12 hours
REMINDER_START_DAYS    = 14        # begin reminders after this many days
REMINDER_INTERVAL_DAYS = 3         # re-send every N days after the first reminder
ESCALATION_DAYS        = 30        # flag needs_review after this many days
APP_URL                = os.environ.get("PUBLIC_URL", "https://courtcollab.com")
ADMIN_EMAIL            = os.environ.get("ADMIN_EMAILS", "").split(",")[0].strip() or "ben@courtcollab.com"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _parse_utc(ts: str) -> datetime:
    """Parse a stored UTC timestamp string into an aware datetime."""
    if not ts:
        raise ValueError("empty timestamp")
    ts = ts.strip().replace(" ", "T")
    # Add UTC offset if missing
    if not ts.endswith("Z") and "+" not in ts[10:] and ts.count("-") < 3:
        ts += "+00:00"
    dt = datetime.fromisoformat(ts)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _send_email(to_email: str, subject: str, body: str) -> None:
    """Send a plain-text email via Zoho SMTP."""
    host   = os.environ.get("SMTP_HOST",  "smtp.zoho.com")
    port   = int(os.environ.get("SMTP_PORT", "587"))
    user   = os.environ.get("SMTP_USER",  "")
    passwd = os.environ.get("SMTP_PASS",  "")
    sender = os.environ.get("FROM_EMAIL", user) or user

    if not user or not passwd:
        logging.warning("[STALE] SMTP not configured — skipping email to %s", to_email)
        return

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
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

        logging.info("[STALE] Email sent to %s — %s", to_email, subject)
    except Exception as exc:
        logging.warning("[STALE] Email failed for %s: %s", to_email, exc)


# ---------------------------------------------------------------------------
# Core job
# ---------------------------------------------------------------------------

async def stale_deal_check_job(get_conn=None) -> None:
    """
    Single pass: find held payments older than 14 days with no brand confirmation,
    send reminders every 3 days, and escalate after 30 days.
    """
    try:
        from database import get_conn as _get_conn  # avoid circular import
        _gc = get_conn or _get_conn
    except Exception:
        logging.error("[STALE] Could not import get_conn")
        return

    logging.info("[STALE] Running stale deal check...")

    with _gc() as conn:
        rows = conn.execute("""
            SELECT
                d.id                    AS deal_id,
                d.brand_marked_complete,
                d.reminders_sent,
                d.last_reminder_sent,
                d.needs_review,
                p.id                    AS payment_id,
                p.created_at            AS payment_created_at,
                p.amount,
                p.creator_payout,
                ub.name                 AS brand_name,
                ub.email                AS brand_email,
                uc.name                 AS creator_name,
                uc.email                AS creator_email,
                c.title                 AS campaign_title
            FROM payments p
            JOIN deals    d  ON d.id    = p.deal_id
            JOIN users    ub ON ub.id   = d.brand_id
            JOIN users    uc ON uc.id   = d.creator_id
            LEFT JOIN campaigns c ON c.id = d.campaign_id
            WHERE p.status            = 'held'
              AND d.brand_marked_complete = 0
              AND (d.needs_review IS NULL OR d.needs_review = 0)
              AND d.status NOT IN ('payout_complete', 'declined')
        """).fetchall()

    if not rows:
        logging.info("[STALE] No stale deals found.")
        return

    logging.info("[STALE] Checking %d held deal(s)...", len(rows))
    now          = datetime.now(timezone.utc)
    dashboard    = APP_URL.rstrip("/")

    for deal in rows:
        deal_id = deal["deal_id"]

        # Parse payment creation timestamp
        try:
            payment_created = _parse_utc(deal["payment_created_at"])
        except Exception as exc:
            logging.warning(
                "[STALE] Cannot parse payment_created_at for deal #%s: %s", deal_id, exc
            )
            continue

        days_since = (now - payment_created).total_seconds() / 86_400

        if days_since < REMINDER_START_DAYS:
            continue  # not yet overdue

        campaign_title = deal["campaign_title"] or f"Deal #{deal_id}"
        brand_name     = deal["brand_name"]   or "Brand"
        creator_name   = deal["creator_name"] or "Creator"
        brand_email    = deal["brand_email"]
        creator_email  = deal["creator_email"]
        amount         = deal["amount"]        or 0
        creator_payout = deal["creator_payout"] or 0
        reminders_sent = deal["reminders_sent"] or 0

        # ── 30-day escalation ─────────────────────────────────────────────────
        if days_since >= ESCALATION_DAYS:
            logging.info(
                "[STALE] Deal #%s held for %.1f days — flagging needs_review", deal_id, days_since
            )
            with _gc() as conn:
                conn.execute(
                    """UPDATE deals
                          SET needs_review = 1,
                              updated_at   = ?
                        WHERE id = ?""",
                    (_now_utc(), deal_id),
                )
                conn.commit()

            admin_body = (
                f"Hi Ben,\n\n"
                f"A CourtCollab deal has been held in escrow for more than "
                f"{int(days_since)} days without the brand confirming delivery. "
                f"Please review and resolve this manually.\n\n"
                f"  Deal ID        : #{deal_id}\n"
                f"  Campaign       : {campaign_title}\n"
                f"  Brand          : {brand_name} ({brand_email})\n"
                f"  Creator        : {creator_name} ({creator_email})\n"
                f"  Creator Payout : ${creator_payout:,}\n"
                f"  Days In Escrow : {int(days_since)}\n"
                f"  Reminders Sent : {reminders_sent}\n\n"
                f"Log into the admin dashboard to investigate and resolve:\n"
                f"{dashboard}\n\n"
                f"— CourtCollab System\n"
            )
            _send_email(
                ADMIN_EMAIL,
                f"[Action Required] Deal #{deal_id} needs manual review — CourtCollab",
                admin_body,
            )
            continue  # skip the reminder on the same run

        # ── Reminder every 3 days after day 14 ───────────────────────────────
        overdue_days       = days_since - REMINDER_START_DAYS
        expected_reminders = int(overdue_days / REMINDER_INTERVAL_DAYS) + 1

        if reminders_sent >= expected_reminders:
            continue  # already sent everything due so far

        # Guard against clock drift / rapid restart sending twice too soon
        if deal["last_reminder_sent"]:
            try:
                last_sent = _parse_utc(deal["last_reminder_sent"])
                hours_since_last = (now - last_sent).total_seconds() / 3600
                if hours_since_last < (REMINDER_INTERVAL_DAYS * 24 - 1):
                    continue  # too soon for next reminder
            except Exception:
                pass  # unparseable → proceed anyway

        logging.info(
            "[STALE] Deal #%s — sending reminder #%d (%.1f days in escrow)",
            deal_id, reminders_sent + 1, days_since,
        )

        # Brand reminder
        if brand_email:
            brand_body = (
                f"Hi {brand_name},\n\n"
                f"This is a friendly reminder that your CourtCollab deal with "
                f"{creator_name} has a payment of ${amount:,} being held in escrow.\n\n"
                f"  Campaign : {campaign_title}\n"
                f"  Deal ID  : #{deal_id}\n"
                f"  Amount   : ${amount:,}\n\n"
                f"Please review the creator's content and mark the deal as complete "
                f"in your dashboard if you are satisfied. Once both you and the creator "
                f"confirm completion, the payment will be released automatically.\n\n"
                f"Log in to your dashboard:\n"
                f"{dashboard}\n\n"
                f"If you have concerns about the delivered content, please reach out to "
                f"our support team and we will assist you.\n\n"
                f"— The CourtCollab Team\n"
                f"courtcollab.com\n"
            )
            _send_email(
                brand_email,
                f"Reminder: Please Review {creator_name}'s Content — CourtCollab",
                brand_body,
            )

        # Creator reminder
        if creator_email:
            creator_body = (
                f"Hi {creator_name},\n\n"
                f"This is a reminder about your CourtCollab deal with {brand_name}. "
                f"Your payout of ${creator_payout:,} is waiting in escrow and will "
                f"be released as soon as both parties confirm delivery.\n\n"
                f"  Campaign : {campaign_title}\n"
                f"  Deal ID  : #{deal_id}\n"
                f"  Payout   : ${creator_payout:,}\n\n"
                f"Please ensure your content has been delivered and follow up with "
                f"the brand to mark the deal complete so your payment can be released.\n\n"
                f"Log in to your dashboard to track your deal:\n"
                f"{dashboard}\n\n"
                f"— The CourtCollab Team\n"
                f"courtcollab.com\n"
            )
            _send_email(
                creator_email,
                f"Action Required: Follow Up with {brand_name} to Release Your Payout — CourtCollab",
                creator_body,
            )

        # Persist updated reminder count and timestamp
        with _gc() as conn:
            conn.execute(
                """UPDATE deals
                      SET reminders_sent     = ?,
                          last_reminder_sent = ?,
                          updated_at         = ?
                    WHERE id = ?""",
                (reminders_sent + 1, _now_utc(), _now_utc(), deal_id),
            )
            conn.commit()

    logging.info("[STALE] Stale deal check complete.")


# ---------------------------------------------------------------------------
# Asyncio background loop — called once at FastAPI startup
# ---------------------------------------------------------------------------

async def stale_deal_check_loop(get_conn=None) -> None:
    """
    Infinite loop that checks for stale deals every CHECK_INTERVAL_SECONDS (12h).
    Staggered by 90 seconds so the server and contract poller are ready first.

        asyncio.create_task(stale_deal_check_loop(get_conn))
    """
    logging.info(
        "[STALE] Stale deal checker started — interval %dh",
        CHECK_INTERVAL_SECONDS // 3600,
    )
    await asyncio.sleep(90)   # let contract_poll_loop (30s) and reminder_loop (60s) go first

    while True:
        try:
            await stale_deal_check_job(get_conn)
        except Exception as exc:
            logging.error("[STALE] Unexpected error: %s", exc, exc_info=True)

        await asyncio.sleep(CHECK_INTERVAL_SECONDS)
