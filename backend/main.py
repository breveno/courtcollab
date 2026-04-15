"""
CourtCollab API
===============
Auth
  POST   /api/signup
  POST   /api/login
  GET    /api/me

Creator Profiles
  PUT    /api/creator/profile
  GET    /api/creator/profile
  GET    /api/creators                 ?niche=&skill=&min_followers=&max_rate=
  GET    /api/creators/{user_id}

Brand Profiles
  PUT    /api/brand/profile
  GET    /api/brand/profile

Campaigns
  POST   /api/campaigns
  GET    /api/campaigns                ?niche=&status=&mine=true
  GET    /api/campaigns/{id}
  PATCH  /api/campaigns/{id}           (full content update)
  PATCH  /api/campaigns/{id}/status
  DELETE /api/campaigns/{id}

Matches / Discovery
  POST   /api/campaigns/{id}/matches   (compute & store scores for all creators)
  GET    /api/campaigns/{id}/matches
  GET    /api/discover                 ?niche=&skill=&age=&min_followers=&max_budget=

Deals
  POST   /api/deals
  GET    /api/deals
  PATCH  /api/deals/{id}/status

Messages
  GET    /api/conversations                  — all threads, last message + unread count
  POST   /api/messages                       — send; fan-out to WS if receiver online
  GET    /api/messages/{other_user_id}       — full thread, marks all as read
  PATCH  /api/messages/{message_id}/read     — explicit single-message read receipt

WebSocket
  WS     /ws?token=<jwt>                     — real-time delivery channel

Deals (updated)
  POST   /api/deals                          — brand proposes; creator notified
  GET    /api/deals                          — list own deals (brand or creator)
  GET    /api/deals/{id}                     — single deal with full context
  PATCH  /api/deals/{id}/status              — pending→active|declined / active→completed
                                               each transition notifies the other party

Notifications
  GET    /api/notifications                  — list (unread first, then read)
  GET    /api/notifications/unread-count     — quick badge count
  PATCH  /api/notifications/read-all         — mark every notification read
  PATCH  /api/notifications/{id}/read        — mark one read

Payments
  POST   /api/payments
  GET    /api/payments
  PATCH  /api/payments/{id}/release

Stripe Connect
  POST   /api/stripe/connect/onboard         — creator: create/resume Connect Express account
  GET    /api/stripe/connect/status          — creator: check onboarding status
  POST   /api/stripe/checkout/{deal_id}      — brand: create Checkout Session for a deal
  POST   /api/stripe/webhook                 — Stripe webhook (no auth)
"""

import base64
import hashlib
import hmac
import httpx
import json
import logging
import os
import sqlite3
import stripe
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple
from pathlib import Path

# Load .env file if present (dev convenience — production uses real env vars)
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    for _line in _env_path.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
import re as _re
from pydantic import BaseModel, EmailStr, Field, field_validator
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from database import get_conn, init_db

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SECRET_KEY     = os.environ.get("JWT_SECRET", "change-me-in-production-use-a-long-random-string")
ALGORITHM      = "HS256"
TOKEN_TTL_HRS        = 72
TOKEN_TTL_REMEMBER   = 24 * 30   # 30 days
PLATFORM_FEE   = 0.15          # 15 % taken by CourtCollab

# ---------------------------------------------------------------------------
# Stripe config
# ---------------------------------------------------------------------------
stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
STRIPE_SUCCESS_URL    = os.environ.get("STRIPE_SUCCESS_URL", "http://localhost:3000/deal-success")
STRIPE_CANCEL_URL     = os.environ.get("STRIPE_CANCEL_URL",  "http://localhost:3000/deal-cancel")

# ---------------------------------------------------------------------------
# SignWell config
# ---------------------------------------------------------------------------
SIGNWELL_API_KEY   = os.environ.get("SIGNWELL_API_KEY", "")
SIGNWELL_TEST_MODE = os.environ.get("SIGNWELL_TEST_MODE", "true").lower() == "true"

# ---------------------------------------------------------------------------
# Email config
# ---------------------------------------------------------------------------
# Runtime overrides via environment variables (set these before launching):
#   SMTP_HOST   — e.g. smtp.sendgrid.net or smtp.gmail.com
#   SMTP_PORT   — default 587
#   SMTP_USER   — SMTP username / API key
#   SMTP_PASS   — SMTP password
#   FROM_EMAIL  — override the sender address

FROM_EMAIL = os.environ.get("FROM_EMAIL", "noreply@courtcollab.com")

# Platform admins — always receive a copy of every deal notification email.
# Override via ADMIN_EMAILS env var (comma-separated) or edit the list below.
_env_admins = os.environ.get("ADMIN_EMAILS", "")
ADMIN_EMAILS: List[str] = (
    [e.strip() for e in _env_admins.split(",") if e.strip()]
    if _env_admins
    else ["ben@courtcollab.com", "julia@courtcollab.com"]
)

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer  = HTTPBearer()

# ---------------------------------------------------------------------------
# WebSocket connection manager
# ---------------------------------------------------------------------------

class ConnectionManager:
    """Tracks one active WebSocket per user (last connection wins)."""

    def __init__(self):
        self._conns: dict = {}   # user_id -> WebSocket

    async def connect(self, user_id: int, ws: WebSocket):
        await ws.accept()
        self._conns[user_id] = ws

    def disconnect(self, user_id: int):
        self._conns.pop(user_id, None)

    async def send(self, user_id: int, payload: dict) -> bool:
        """Push JSON to a user if they are connected. Returns True if delivered."""
        ws = self._conns.get(user_id)
        if not ws:
            return False
        try:
            await ws.send_json(payload)
            return True
        except Exception:
            self.disconnect(user_id)
            return False

    def online_ids(self) -> list:
        return list(self._conns.keys())


manager = ConnectionManager()

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="CourtCollab API", version="2.0.0")

limiter = Limiter(key_func=get_remote_address, default_limits=["200/minute"])
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_cors_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "*"
    return response

@app.on_event("startup")
def startup():
    init_db()
    sg_key = os.environ.get("SENDGRID_API_KEY", "")
    print(f"[STARTUP] SENDGRID_API_KEY present={bool(sg_key)} prefix={sg_key[:8] if sg_key else 'NONE'}", flush=True)


@app.on_event("startup")
async def start_contract_poller():
    """Start the SignWell status poller and daily reminder job as background asyncio tasks."""
    import asyncio as _asyncio
    try:
        from contractPoller import contract_poll_loop, contract_reminder_loop
        loop = _asyncio.get_event_loop()
        loop.create_task(contract_poll_loop(get_conn))
        loop.create_task(contract_reminder_loop(get_conn))
        print("[STARTUP] Contract poller + reminder tasks created.", flush=True)
    except Exception as exc:
        print(f"[STARTUP] Contract tasks failed to start: {exc}", flush=True)

@app.get("/debug/version")
def debug_version():
    import traceback as _tb
    db_info = {}
    try:
        with get_conn() as conn:
            tables = _rows(conn, """
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' ORDER BY table_name
            """)
            db_info["tables"] = [t["table_name"] for t in tables]
            try:
                cols = _rows(conn, """
                    SELECT column_name FROM information_schema.columns
                    WHERE table_name = 'creator_profiles' ORDER BY ordinal_position
                """)
                db_info["creator_profiles_cols"] = [c["column_name"] for c in cols]
            except Exception as ce:
                db_info["creator_profiles_cols_err"] = str(ce)
    except Exception as e:
        db_info["db_err"] = str(e)
    return {"version": "af76cb0-v2", "db_mode": "pg" if os.environ.get("DATABASE_URL") else "sqlite", "db_info": db_info}


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = Query(...)):
    """
    Connect:  ws://localhost:8000/ws?token=<jwt>
    Receive:  JSON messages pushed by the server when someone messages you.
    Send:     ping frames {"type":"ping"} — server echoes {"type":"pong"}.

    Payload shape for incoming messages:
    {
      "type":       "message",
      "id":         <int>,
      "sender_id":  <int>,
      "sender_name":"...",
      "body":       "...",
      "deal_id":    <int|null>,
      "created_at": "..."
    }
    """
    try:
        user_id = _decode_token(token)
    except HTTPException:
        await ws.close(code=4001)
        return

    await manager.connect(user_id, ws)
    try:
        while True:
            data = await ws.receive_json()
            if not isinstance(data, dict):
                continue
            if data.get("type") == "ping":
                await ws.send_json({"type": "pong"})
            elif data.get("type") == "typing":
                # Forward typing indicator to the recipient
                to_id = data.get("to")
                if to_id:
                    with get_conn() as conn:
                        sender = _row(conn, "SELECT name FROM users WHERE id = ?", (user_id,))
                    await manager.send(to_id, {
                        "type":        "typing",
                        "from":        user_id,
                        "sender_name": sender["name"] if sender else "",
                    })
    except WebSocketDisconnect:
        manager.disconnect(user_id)
    except Exception:
        manager.disconnect(user_id)

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _hash(plain: str) -> str:
    return pwd_ctx.hash(plain)

def _verify(plain: str, hashed: str) -> bool:
    return pwd_ctx.verify(plain, hashed)

def _make_token(user_id: int, remember: bool = True) -> str:
    ttl = TOKEN_TTL_REMEMBER if remember else TOKEN_TTL_HRS
    exp = datetime.now(timezone.utc) + timedelta(hours=ttl)
    return jwt.encode({"sub": str(user_id), "exp": exp}, SECRET_KEY, algorithm=ALGORITHM)

def _decode_token(token: str) -> int:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return int(payload["sub"])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

def _initials(name: str) -> str:
    return "".join(w[0].upper() for w in name.strip().split() if w)[:2]

def _row(conn, sql: str, params: tuple = ()) -> Optional[dict]:
    row = conn.execute(sql, params).fetchone()
    return dict(row) if row else None

def _rows(conn, sql: str, params: tuple = ()) -> List[dict]:
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


# ---------------------------------------------------------------------------
# Notification helpers
# ---------------------------------------------------------------------------

def _send_email(to_email: str, subject: str, body: str, event_type: str = ""):
    """
    Send notification email via SendGrid HTTP API in a background thread.
    Requires SENDGRID_API_KEY to be set; silently skips if not configured.
    """
    import threading
    def _send():
        api_key = os.environ.get("SENDGRID_API_KEY")
        print(f"[EMAIL] key_present={bool(api_key)} to={to_email} subject={subject}", flush=True)
        if not api_key:
            print(f"[EMAIL] SENDGRID_API_KEY not set — skipping", flush=True)
            return

        all_recipients = list({to_email} | set(ADMIN_EMAILS))

        try:
            personalizations = [{"to": [{"email": r} for r in all_recipients]}]
            payload = json.dumps({
                "personalizations": personalizations,
                "from": {"email": FROM_EMAIL, "name": "CourtCollab"},
                "subject": subject,
                "content": [{"type": "text/plain", "value": body}]
            }).encode("utf-8")

            req = urllib.request.Request(
                "https://api.sendgrid.com/v3/mail/send",
                data=payload,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json"
                },
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                logging.info("Email sent to %s — %s (status %s)", to_email, subject, resp.status)
        except Exception as exc:
            logging.warning("Email delivery failed for %s: %s", to_email, exc)

    threading.Thread(target=_send, daemon=True).start()


def _send_zoho_email(to_emails: list[str], subject: str, body: str) -> None:
    """
    Send email via Zoho SMTP (or any SMTP provider) using smtplib.

    Required Railway env vars:
      SMTP_HOST  — e.g. smtp.zoho.com
      SMTP_PORT  — default 587
      SMTP_USER  — your Zoho email address (also used as sender)
      SMTP_PASS  — Zoho app-specific password or account password
      FROM_EMAIL — sender address (falls back to SMTP_USER)
    """
    import smtplib
    import threading
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart

    def _send():
        host  = os.environ.get("SMTP_HOST", "smtp.zoho.com")
        port  = int(os.environ.get("SMTP_PORT", "587"))
        user  = os.environ.get("SMTP_USER", "")
        passwd= os.environ.get("SMTP_PASS", "")
        sender= os.environ.get("FROM_EMAIL", user) or user

        if not user or not passwd:
            logging.warning("[SMTP] SMTP_USER or SMTP_PASS not set — skipping Zoho email to %s", to_emails)
            return

        try:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"]    = f"CourtCollab <{sender}>"
            msg["To"]      = ", ".join(to_emails)
            msg.attach(MIMEText(body, "plain"))

            use_ssl = os.environ.get("SMTP_SSL", "false").lower() == "true" or port == 465
            if use_ssl:
                with smtplib.SMTP_SSL(host, port, timeout=15) as server:
                    server.login(user, passwd)
                    server.sendmail(sender, to_emails, msg.as_string())
            else:
                with smtplib.SMTP(host, port, timeout=15) as server:
                    server.ehlo()
                    server.starttls()
                    server.login(user, passwd)
                    server.sendmail(sender, to_emails, msg.as_string())

            logging.info("[SMTP] Email sent to %s — %s", to_emails, subject)
        except Exception as exc:
            logging.warning("[SMTP] Delivery failed for %s: %s", to_emails, exc)

    threading.Thread(target=_send, daemon=True).start()


def _verify_signwell_signature(raw_body: bytes, header_sig: str) -> bool:
    """
    Verify a SignWell webhook payload using HMAC-SHA256.

    SignWell signs the raw request body with the webhook secret and sends
    the hex digest in the X-SignWell-Signature header.

    Returns True if the signature is valid, False otherwise.
    If SIGNWELL_WEBHOOK_SECRET is not set, logs a warning and returns True
    (permissive fallback — set the secret on Railway to enforce verification).
    """
    secret = os.environ.get("SIGNWELL_WEBHOOK_SECRET", "")
    if not secret:
        logging.warning("[WEBHOOK] SIGNWELL_WEBHOOK_SECRET not set — skipping signature check")
        return True

    expected = hmac.new(
        secret.encode("utf-8"),
        msg=raw_body,
        digestmod=hashlib.sha256,
    ).hexdigest()

    # Strip optional "sha256=" prefix SignWell may prepend
    incoming = header_sig.removeprefix("sha256=").strip()
    return hmac.compare_digest(expected, incoming)


def _admin_email_body(
    notif_type: str,
    title:      str,
    user_body:  str,
    data:       dict,
) -> str:
    """Format a richer admin copy with deal context appended."""
    lines = [
        "CourtCollab Platform Notification",
        "=" * 40,
        f"Event : {notif_type}",
        f"Deal  : #{data.get('deal_id', '—')}",
        f"Campaign: #{data.get('campaign_id', '—')}",
        "",
        "User received:",
        f"  {title}",
        f"  {user_body}",
        "",
        "— CourtCollab Platform",
    ]
    return "\n".join(lines)


async def _notify(
    user_id:    int,
    notif_type: str,
    title:      str,
    body:       str,
    data:       Optional[dict] = None,
    email:      Optional[str]  = None,
):
    """
    1. Persist notification to DB.
    2. Push to user's WebSocket if they are online.
    3. Send email to the user (with BCC to platform admins).
    """
    payload = data or {}

    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO notifications (user_id, type, title, body, data) VALUES (?,?,?,?,?)",
            (user_id, notif_type, title, body, json.dumps(payload)),
        )
        conn.commit()
        nid   = cur.lastrowid
        notif = _row(conn, "SELECT * FROM notifications WHERE id = ?", (nid,))

    notif["data"] = json.loads(notif.get("data") or "{}")
    await manager.send(user_id, {"type": "notification", **notif})

    if email:
        # User gets the plain notification; admins are BCC'd with extra context
        email_body = (
            f"{body}\n\n"
            f"Log in to CourtCollab to view deal #{payload.get('deal_id', '')} details.\n\n"
            f"— The CourtCollab Team"
        )
        _send_email(email, title, email_body, event_type=notif_type)
    else:
        # No primary recipient but admins should still be notified
        admin_body = _admin_email_body(notif_type, title, body, payload)
        for admin in ADMIN_EMAILS:
            _send_email(admin, f"[Admin] {title}", admin_body, event_type=notif_type)


def current_user(creds: HTTPAuthorizationCredentials = Depends(bearer)) -> dict:
    uid  = _decode_token(creds.credentials)
    with get_conn() as conn:
        user = _row(conn, "SELECT * FROM users WHERE id = ?", (uid,))
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user

def require_role(role: str, user: dict):
    if user["role"] != role:
        raise HTTPException(status_code=403, detail=f"Only {role}s can do this")

# ---------------------------------------------------------------------------
# Schemas — Auth
# ---------------------------------------------------------------------------

def _validate_email(v: str) -> str:
    v = v.strip().lower()
    if not _re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', v):
        raise ValueError("Please enter a valid email address")
    return v

class SignupIn(BaseModel):
    name:     str = Field(min_length=2, max_length=100)
    email:    str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=6, max_length=200)
    role:     str

    @field_validator('email')
    @classmethod
    def email_valid(cls, v):
        return _validate_email(v)

class LoginIn(BaseModel):
    email:    str  = Field(min_length=5, max_length=254)
    password: str  = Field(min_length=1)
    remember: bool = False

    @field_validator('email')
    @classmethod
    def email_valid(cls, v):
        return _validate_email(v)

class UserOut(BaseModel):
    id:           int
    name:         str
    email:        str
    role:         str
    initials:     str
    company_name: Optional[str] = None

class AuthOut(BaseModel):
    token: str
    user:  UserOut

# ---------------------------------------------------------------------------
# Routes — Auth
# ---------------------------------------------------------------------------

@app.post("/api/signup", response_model=AuthOut, status_code=201)
@limiter.limit("5/minute")
def signup(request: Request, body: SignupIn):
    if body.role not in ("creator", "brand"):
        raise HTTPException(400, "role must be 'creator' or 'brand'")
    if len(body.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    try:
        with get_conn() as conn:
            cur = conn.execute(
                "INSERT INTO users (email, password, role, name, initials) VALUES (?,?,?,?,?)",
                (body.email.lower(), _hash(body.password), body.role,
                 body.name.strip(), _initials(body.name))
            )
            conn.commit()
            uid = cur.lastrowid
    except Exception as _dup_err:
        msg = str(_dup_err).lower()
        if "unique" in msg or "duplicate" in msg or "already exists" in msg:
            raise HTTPException(409, "An account with that email already exists")
        raise

    with get_conn() as conn:
        user = _row(conn, "SELECT * FROM users WHERE id = ?", (uid,))

    # Auto-create a blank creator profile so the creator appears on the explore page immediately
    if body.role == "creator":
        with get_conn() as conn:
            conn.execute("""
                INSERT INTO creator_profiles
                  (user_id, name, niche, bio, location, skill_level,
                   followers_ig, followers_tt, followers_yt, engagement_rate, avg_views,
                   rate_ig, rate_tiktok, rate_yt, rate_ugc, rate_notes,
                   skills, social_handles,
                   demo_age, demo_gender, demo_locations, demo_interests, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
                ON CONFLICT (user_id) DO NOTHING
            """, (uid, body.name.strip(), '', '', '', '', 0, 0, 0, 0.0, 0, 0, 0, 0, 0, '',
                  '[]', '{}', '', '', '', ''))
            conn.commit()

    # Notify platform admins of every new signup
    role_label = "Creator" if body.role == "creator" else "Brand"
    subject    = f"New {role_label} signup — {body.name}"
    email_body = (
        f"A new {role_label.lower()} just joined CourtCollab.\n\n"
        f"  Name  : {body.name}\n"
        f"  Email : {body.email.lower()}\n"
        f"  Role  : {role_label}\n"
        f"  ID    : #{uid}\n\n"
        f"— CourtCollab Platform"
    )
    for admin in ADMIN_EMAILS:
        _send_email(admin, subject, email_body, event_type="new_signup")

    return {"token": _make_token(uid), "user": UserOut(**user)}


@app.post("/api/login", response_model=AuthOut)
@limiter.limit("10/minute")
def login(request: Request, body: LoginIn):
    with get_conn() as conn:
        user = _row(conn, "SELECT * FROM users WHERE email = ?", (body.email.lower(),))
    if not user or not _verify(body.password, user["password"]):
        raise HTTPException(401, "Incorrect email or password")
    ttl = TOKEN_TTL_REMEMBER if body.remember else TOKEN_TTL_HRS
    exp = datetime.now(timezone.utc) + timedelta(hours=ttl)
    token = jwt.encode({"sub": str(user["id"]), "exp": exp}, SECRET_KEY, algorithm=ALGORITHM)
    user = dict(user)
    if user["role"] == "brand":
        with get_conn() as conn:
            bp = _row(conn, "SELECT company_name FROM brand_profiles WHERE user_id = ?", (user["id"],))
        user["company_name"] = bp["company_name"] if bp else None
    return {"token": token, "user": UserOut(**user)}


@app.get("/api/me", response_model=UserOut)
def me(user: dict = Depends(current_user)):
    user = dict(user)
    if user["role"] == "brand":
        with get_conn() as conn:
            bp = _row(conn, "SELECT company_name FROM brand_profiles WHERE user_id = ?", (user["id"],))
        user["company_name"] = bp["company_name"] if bp else None
    return UserOut(**user)

# ---------------------------------------------------------------------------
# Schemas — Creator Profile
# ---------------------------------------------------------------------------

class CreatorProfileIn(BaseModel):
    name:            Optional[str]   = None
    niche:           Optional[str]   = None
    bio:             Optional[str]   = None
    location:        Optional[str]   = None
    skill_level:     Optional[str]   = None
    followers_ig:    Optional[int]   = Field(default=0, ge=0)
    followers_tt:    Optional[int]   = Field(default=0, ge=0)
    followers_yt:    Optional[int]   = Field(default=0, ge=0)
    engagement_rate: Optional[float] = Field(default=0, ge=0, le=100)
    avg_views:       Optional[int]   = Field(default=0, ge=0)
    rate_ig:         Optional[int]   = Field(default=0, ge=0)
    rate_tiktok:     Optional[int]   = Field(default=0, ge=0)
    rate_yt:         Optional[int]   = Field(default=0, ge=0)
    rate_ugc:        Optional[int]   = Field(default=0, ge=0)
    rate_notes:      Optional[str]   = None
    skills:          Optional[List[str]] = []
    social_handles:  Optional[dict]  = {}
    demo_age:        Optional[str]   = None
    demo_gender:     Optional[str] = None
    demo_locations:  Optional[str] = None
    demo_interests:  Optional[str] = None
    birthday:        Optional[str]  = None  # YYYY-MM-DD, private — never returned to other users

# ---------------------------------------------------------------------------
# Routes — Creator Profiles
# ---------------------------------------------------------------------------

@app.put("/api/creator/profile", status_code=200)
def upsert_creator_profile(body: CreatorProfileIn, user: dict = Depends(current_user)):
    import traceback as _tb
    require_role("creator", user)
    try:
        with get_conn() as conn:
            conn.execute("""
                INSERT INTO creator_profiles
                  (user_id, name, niche, bio, location, skill_level,
                   followers_ig, followers_tt, followers_yt, engagement_rate, avg_views,
                   rate_ig, rate_tiktok, rate_yt, rate_ugc, rate_notes,
                   skills, social_handles,
                   demo_age, demo_gender, demo_locations, demo_interests,
                   birthday, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
                ON CONFLICT(user_id) DO UPDATE SET
                  name=excluded.name, niche=excluded.niche, bio=excluded.bio,
                  location=excluded.location, skill_level=excluded.skill_level,
                  followers_ig=excluded.followers_ig, followers_tt=excluded.followers_tt,
                  followers_yt=excluded.followers_yt, engagement_rate=excluded.engagement_rate,
                  avg_views=excluded.avg_views, rate_ig=excluded.rate_ig,
                  rate_tiktok=excluded.rate_tiktok, rate_yt=excluded.rate_yt,
                  rate_ugc=excluded.rate_ugc, rate_notes=excluded.rate_notes,
                  skills=excluded.skills, social_handles=excluded.social_handles,
                  demo_age=excluded.demo_age, demo_gender=excluded.demo_gender,
                  demo_locations=excluded.demo_locations, demo_interests=excluded.demo_interests,
                  birthday=excluded.birthday,
                  updated_at=datetime('now')
            """, (
                user["id"], body.name, body.niche, body.bio, body.location, body.skill_level,
                body.followers_ig, body.followers_tt, body.followers_yt,
                body.engagement_rate, body.avg_views,
                body.rate_ig, body.rate_tiktok, body.rate_yt, body.rate_ugc, body.rate_notes,
                json.dumps(body.skills), json.dumps(body.social_handles),
                body.demo_age, body.demo_gender, body.demo_locations, body.demo_interests,
                body.birthday
            ))
            conn.commit()
        return {"ok": True}
    except Exception as e:
        print("[upsert_creator_profile ERROR]", _tb.format_exc())
        raise HTTPException(500, detail=str(e))


@app.get("/api/creator/profile")
def get_own_creator_profile(user: dict = Depends(current_user)):
    require_role("creator", user)
    with get_conn() as conn:
        profile = _row(conn, "SELECT * FROM creator_profiles WHERE user_id = ?", (user["id"],))
    if not profile:
        raise HTTPException(404, "Profile not set up yet")
    profile["skills"]         = json.loads(profile.get("skills") or "[]")
    profile["social_handles"] = json.loads(profile.get("social_handles") or "{}")
    return profile


@app.delete("/api/creator/profile", status_code=204)
def delete_creator_profile(user: dict = Depends(current_user)):
    require_role("creator", user)
    with get_conn() as conn:
        conn.execute("DELETE FROM creator_profiles WHERE user_id = ?", (user["id"],))
        conn.commit()


@app.get("/api/featured-creators")
def featured_creators():
    """Public endpoint — returns all creators sorted by follower count for the hero carousel and featured strip."""
    import json as _json
    with get_conn() as conn:
        rows = _rows(conn, """
            SELECT
                u.id            AS user_id,
                u.initials,
                COALESCE(cp.name,            u.name) AS name,
                COALESCE(cp.niche,           '')     AS niche,
                COALESCE(cp.location,        '')     AS location,
                COALESCE(cp.followers_ig,    0)      AS followers_ig,
                COALESCE(cp.followers_tt,    0)      AS followers_tt,
                COALESCE(cp.followers_yt,    0)      AS followers_yt,
                COALESCE(cp.engagement_rate, 0)      AS engagement_rate,
                COALESCE(cp.social_handles,  '{}')   AS social_handles
            FROM users u
            LEFT JOIN creator_profiles cp ON cp.user_id = u.id
            WHERE u.role = 'creator'
        """)
    results = []
    for r in rows:
        r["social_handles"] = _json.loads(r.get("social_handles") or "{}")
        r["total_followers"] = (r.get("followers_ig") or 0) + (r.get("followers_tt") or 0) + (r.get("followers_yt") or 0)
        results.append(r)
    results.sort(key=lambda x: x["total_followers"], reverse=True)
    return results


@app.get("/api/creators")
def list_creators(
    niche:         Optional[str] = Query(None),
    skill:         Optional[str] = Query(None),
    min_followers: Optional[int] = Query(None),
    max_rate:      Optional[int] = Query(None),
    user:          dict          = Depends(current_user),
):
    import traceback as _tb
    try:
      with get_conn() as conn:
        # LEFT JOIN from users so every creator account appears even without a profile row.
        # COALESCE fills in sensible defaults for any missing profile fields.
        rows = _rows(conn, """
            SELECT
                u.id            AS user_id,
                u.email,
                u.initials,
                COALESCE(cp.name,           u.name) AS name,
                COALESCE(cp.niche,          '')     AS niche,
                COALESCE(cp.bio,            '')     AS bio,
                COALESCE(cp.location,       '')     AS location,
                COALESCE(cp.skill_level,    '')     AS skill_level,
                COALESCE(cp.followers_ig,   0)      AS followers_ig,
                COALESCE(cp.followers_tt,   0)      AS followers_tt,
                COALESCE(cp.followers_yt,   0)      AS followers_yt,
                COALESCE(cp.engagement_rate,0)      AS engagement_rate,
                COALESCE(cp.avg_views,      0)      AS avg_views,
                COALESCE(cp.rate_ig,        0)      AS rate_ig,
                COALESCE(cp.rate_tiktok,    0)      AS rate_tiktok,
                COALESCE(cp.rate_yt,        0)      AS rate_yt,
                COALESCE(cp.rate_ugc,       0)      AS rate_ugc,
                COALESCE(cp.rate_notes,     '')     AS rate_notes,
                COALESCE(cp.skills,         '[]')   AS skills,
                COALESCE(cp.social_handles, '{}')   AS social_handles,
                COALESCE(cp.demo_age,       '')     AS demo_age,
                COALESCE(cp.demo_gender,    '')     AS demo_gender,
                COALESCE(cp.demo_locations, '')     AS demo_locations,
                COALESCE(cp.demo_interests, '')     AS demo_interests
            FROM users u
            LEFT JOIN creator_profiles cp ON cp.user_id = u.id
            WHERE u.role = 'creator'
        """)

      results = []
      for r in rows:
          r["skills"]         = json.loads(r.get("skills") or "[]")
          r["social_handles"] = json.loads(r.get("social_handles") or "{}")
          total = (r.get("followers_ig") or 0) + (r.get("followers_tt") or 0) + (r.get("followers_yt") or 0)

          if niche and r.get("niche") != niche:
              continue
          if skill and skill not in r["skills"]:
              continue
          if min_followers and total < min_followers:
              continue
          if max_rate:
              min_rate = min(r.get("rate_ig") or 0, r.get("rate_tiktok") or 0,
                            r.get("rate_yt") or 0, r.get("rate_ugc") or 0)
              if min_rate > max_rate:
                  continue

          r["total_followers"] = total
          results.append(r)

      results.sort(key=lambda x: x["total_followers"], reverse=True)
      return results
    except Exception as e:
        print("[list_creators ERROR]", _tb.format_exc())
        raise HTTPException(500, detail=str(e))


@app.get("/api/creators/{user_id}")
def get_creator(user_id: int, user: dict = Depends(current_user)):
    with get_conn() as conn:
        profile = _row(conn, """
            SELECT cp.*, u.email, u.name AS account_name
            FROM creator_profiles cp
            JOIN users u ON u.id = cp.user_id
            WHERE cp.user_id = ?
        """, (user_id,))
        if not profile:
            raise HTTPException(404, "Creator not found")
        profile["skills"]         = json.loads(profile.get("skills") or "[]")
        profile["social_handles"] = json.loads(profile.get("social_handles") or "{}")

        # ── Portfolio: rating stats ──────────────────────────────────────────
        rating_stats = _row(conn, """
            SELECT COUNT(*) AS cnt, AVG(score) AS avg_score
            FROM ratings WHERE reviewee_id = ?
        """, (user_id,))

        # ── Portfolio: completed deal history (most recent 20) ───────────────
        deal_history = _rows(conn, """
            SELECT d.id, d.amount, d.updated_at AS completed_at,
                   c.title AS campaign_title,
                   COALESCE(bp.company_name, ub.name) AS brand_name,
                   r.score AS brand_rating
            FROM deals d
            JOIN campaigns c    ON c.id  = d.campaign_id
            JOIN users ub       ON ub.id = d.brand_id
            LEFT JOIN brand_profiles bp ON bp.user_id = d.brand_id
            LEFT JOIN ratings r ON r.deal_id = d.id AND r.reviewer_id = d.brand_id
            WHERE d.creator_id = ? AND d.status = 'completed'
            ORDER BY d.updated_at DESC
            LIMIT 20
        """, (user_id,))

        deals_completed = _row(conn, """
            SELECT COUNT(*) AS cnt FROM deals
            WHERE creator_id = ? AND status = 'completed'
        """, (user_id,))

    avg = (rating_stats or {}).get("avg_score")
    profile["avg_rating"]      = round(float(avg), 1) if avg is not None else None
    profile["rating_count"]    = (rating_stats or {}).get("cnt", 0) or 0
    profile["deals_completed"] = (deals_completed or {}).get("cnt", 0) or 0
    profile["deal_history"]    = deal_history
    return profile

# ---------------------------------------------------------------------------
# Schemas — Brand Profile
# ---------------------------------------------------------------------------

class BrandProfileIn(BaseModel):
    company_name:   Optional[str] = None
    industry:       Optional[str] = None
    website:        Optional[str] = None
    budget_min:     Optional[int] = 0
    budget_max:     Optional[int] = 0
    description:    Optional[str] = None
    social_handles: Optional[str] = None

# ---------------------------------------------------------------------------
# Routes — Brand Profiles
# ---------------------------------------------------------------------------

@app.put("/api/brand/profile", status_code=200)
def upsert_brand_profile(body: BrandProfileIn, user: dict = Depends(current_user)):
    require_role("brand", user)
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO brand_profiles
              (user_id, company_name, industry, website, budget_min, budget_max, description, social_handles, updated_at)
            VALUES (?,?,?,?,?,?,?,?,datetime('now'))
            ON CONFLICT(user_id) DO UPDATE SET
              company_name=excluded.company_name, industry=excluded.industry,
              website=excluded.website, budget_min=excluded.budget_min,
              budget_max=excluded.budget_max, description=excluded.description,
              social_handles=excluded.social_handles,
              updated_at=datetime('now')
        """, (user["id"], body.company_name, body.industry, body.website,
              body.budget_min, body.budget_max, body.description,
              body.social_handles or '{}'))
        conn.commit()
    return {"ok": True}


@app.get("/api/brand/profile")
def get_own_brand_profile(user: dict = Depends(current_user)):
    require_role("brand", user)
    with get_conn() as conn:
        profile = _row(conn, "SELECT * FROM brand_profiles WHERE user_id = ?", (user["id"],))
        if not profile:
            raise HTTPException(404, "Profile not set up yet")
        rating_stats = _row(conn, """
            SELECT COUNT(*) AS cnt, AVG(score) AS avg_score
            FROM ratings WHERE reviewee_id = ?
        """, (user["id"],))
        recent_ratings = _rows(conn, """
            SELECT r.score, r.comment, r.created_at,
                   COALESCE(cp.name, uc.name) AS creator_name,
                   c.title AS campaign_title
            FROM ratings r
            JOIN deals d      ON d.id         = r.deal_id
            JOIN users uc     ON uc.id         = r.reviewer_id
            LEFT JOIN creator_profiles cp ON cp.user_id = r.reviewer_id
            JOIN campaigns c  ON c.id          = d.campaign_id
            WHERE r.reviewee_id = ?
            ORDER BY r.created_at DESC
            LIMIT 10
        """, (user["id"],))
    avg = (rating_stats or {}).get("avg_score")
    profile["avg_rating"]     = round(float(avg), 1) if avg is not None else None
    profile["rating_count"]   = (rating_stats or {}).get("cnt", 0) or 0
    profile["recent_ratings"] = recent_ratings
    return profile


@app.get("/api/brands/{user_id}")
def get_brand_public(user_id: int, user: dict = Depends(current_user)):
    """Public brand profile — rating, completed deals, history. Visible to any authenticated user."""
    with get_conn() as conn:
        profile = _row(conn, """
            SELECT bp.*, u.name AS account_name
            FROM brand_profiles bp
            JOIN users u ON u.id = bp.user_id
            WHERE bp.user_id = ?
        """, (user_id,))
        if not profile:
            raise HTTPException(404, "Brand not found")
        rating_stats = _row(conn, """
            SELECT COUNT(*) AS cnt, AVG(score) AS avg_score
            FROM ratings WHERE reviewee_id = ?
        """, (user_id,))
        deal_history = _rows(conn, """
            SELECT d.id, d.amount, d.updated_at AS completed_at,
                   c.title AS campaign_title,
                   COALESCE(cp.name, uc.name) AS creator_name,
                   r.score AS creator_rating
            FROM deals d
            JOIN campaigns c   ON c.id          = d.campaign_id
            JOIN users uc      ON uc.id          = d.creator_id
            LEFT JOIN creator_profiles cp ON cp.user_id = d.creator_id
            LEFT JOIN ratings r ON r.deal_id = d.id AND r.reviewer_id = d.creator_id
            WHERE d.brand_id = ? AND d.status = 'completed'
            ORDER BY d.updated_at DESC
            LIMIT 20
        """, (user_id,))
        deals_completed = _row(conn, """
            SELECT COUNT(*) AS cnt FROM deals WHERE brand_id = ? AND status = 'completed'
        """, (user_id,))
    avg = (rating_stats or {}).get("avg_score")
    profile["avg_rating"]      = round(float(avg), 1) if avg is not None else None
    profile["rating_count"]    = (rating_stats or {}).get("cnt", 0) or 0
    profile["deals_completed"] = (deals_completed or {}).get("cnt", 0) or 0
    profile["deal_history"]    = deal_history
    return profile


@app.delete("/api/brand/profile", status_code=204)
def delete_brand_profile(user: dict = Depends(current_user)):
    require_role("brand", user)
    with get_conn() as conn:
        conn.execute("DELETE FROM brand_profiles WHERE user_id = ?", (user["id"],))
        conn.commit()

# ---------------------------------------------------------------------------
# Schemas — Campaigns
# ---------------------------------------------------------------------------

def _to_int(v):
    """Coerce strings/floats to int; treat empty string or None as 0."""
    if v is None or v == '':
        return 0
    try:
        return int(float(str(v)))
    except (ValueError, TypeError):
        return 0

class CampaignIn(BaseModel):
    title:            str                  = Field(min_length=2, max_length=200)
    description:      Optional[str]        = None
    budget:           Optional[int]        = Field(default=0, ge=0)
    niche:            Optional[str]        = None
    skills:           Optional[List[str]]  = []
    target_age:       Optional[str]        = None
    min_followers:    Optional[int]        = Field(default=0, ge=0)
    max_rate:         Optional[int]        = Field(default=0, ge=0)
    questions:        Optional[List[str]]  = []
    creators_needed:  Optional[int]        = Field(default=1, ge=1)
    status:           Optional[str]        = Field(default='open')

    @field_validator('budget', 'min_followers', 'max_rate', mode='before')
    @classmethod
    def coerce_ints(cls, v): return _to_int(v)

class CampaignUpdateIn(BaseModel):
    title:            Optional[str]       = None
    description:      Optional[str]       = None
    budget:           Optional[int]       = None
    niche:            Optional[str]       = None
    skills:           Optional[List[str]] = None
    target_age:       Optional[str]       = None
    min_followers:    Optional[int]       = None
    max_rate:         Optional[int]       = None
    questions:        Optional[List[str]] = None
    creators_needed:  Optional[int]       = None

    @field_validator('budget', 'min_followers', 'max_rate', mode='before')
    @classmethod
    def coerce_ints(cls, v): return _to_int(v) if v is not None else None

class ApplicationIn(BaseModel):
    answers: Optional[List[str]] = []
    message: Optional[str]       = None

class ApplicationStatusIn(BaseModel):
    status: str

class CampaignStatusIn(BaseModel):
    status: str

# ---------------------------------------------------------------------------
# Routes — Campaigns
# ---------------------------------------------------------------------------

async def _notify_campaign_matches(campaign: dict):
    """
    Run after a campaign is created. Score every creator; notify those ≥ 80%.
    Runs as a FastAPI BackgroundTask so it never blocks the HTTP response.
    """
    with get_conn() as conn:
        creators = _rows(conn, """
            SELECT cp.*, u.email
            FROM creator_profiles cp
            JOIN users u ON u.id = cp.user_id
        """)

    for creator in creators:
        score, reasons = _compute_score(creator, campaign)
        if score < 80:
            continue
        title = f"New campaign match: {campaign['title']}"
        body  = (
            f"A brand just posted a campaign that matches your profile "
            f"{score}% — \"{campaign['title']}\". Check it out on CourtCollab!"
        )
        await _notify(
            user_id    = creator["user_id"],
            notif_type = "campaign_match",
            title      = title,
            body       = body,
            data       = {"campaign_id": campaign["id"], "match_score": score, "reasons": reasons},
            email      = creator.get("email"),
        )


@app.post("/api/campaigns", status_code=201)
def create_campaign(body: CampaignIn, background_tasks: BackgroundTasks, user: dict = Depends(current_user)):
    require_role("brand", user)
    with get_conn() as conn:
        cur = conn.execute("""
            INSERT INTO campaigns
              (brand_id, title, description, budget, niche, skills,
               target_age, min_followers, max_rate, questions, creators_needed, status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """, (user["id"], body.title, body.description, body.budget,
              body.niche, json.dumps(body.skills),
              body.target_age, body.min_followers, body.max_rate,
              json.dumps(body.questions or []),
              body.creators_needed or 1,
              body.status or 'open'))
        conn.commit()
        cid = cur.lastrowid
    with get_conn() as conn:
        row = _row(conn, "SELECT * FROM campaigns WHERE id = ?", (cid,))
        row["skills"]    = json.loads(row.get("skills")    or "[]")
        row["questions"] = json.loads(row.get("questions") or "[]")
    background_tasks.add_task(_notify_campaign_matches, row)
    return row


@app.get("/api/campaigns")
def list_campaigns(
    niche:  Optional[str]  = Query(None),
    status: Optional[str]  = Query(None),
    mine:   Optional[bool] = Query(None),   # brands: only show their own campaigns
    user:   dict           = Depends(current_user),
):
    with get_conn() as conn:
        rows = _rows(conn, """
            SELECT c.*, u.name AS brand_name, bp.company_name,
                   CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END AS has_applied
            FROM campaigns c
            JOIN users u ON u.id = c.brand_id
            LEFT JOIN brand_profiles bp ON bp.user_id = c.brand_id
            LEFT JOIN applications a
                   ON a.campaign_id = c.id AND a.creator_id = ?
        """, (user["id"],))
    results = []
    for r in rows:
        r["skills"]      = json.loads(r.get("skills")    or "[]")
        r["questions"]   = json.loads(r.get("questions") or "[]")
        r["has_applied"] = bool(r.get("has_applied", 0))
        # Brands only see their own campaigns; creators see all
        if user["role"] == "brand" and r.get("brand_id") != user["id"]: continue
        if mine   and r.get("brand_id") != user["id"]: continue
        if niche  and r.get("niche")    != niche:      continue
        if status and r.get("status")   != status:     continue
        results.append(r)
    return results


@app.get("/api/campaigns/{campaign_id}")
def get_campaign(campaign_id: int, user: dict = Depends(current_user)):
    with get_conn() as conn:
        row = _row(conn, """
            SELECT c.*, u.name AS brand_name, bp.company_name
            FROM campaigns c
            JOIN users u ON u.id = c.brand_id
            LEFT JOIN brand_profiles bp ON bp.user_id = c.brand_id
            WHERE c.id = ?
        """, (campaign_id,))
    if not row:
        raise HTTPException(404, "Campaign not found")
    row["skills"]    = json.loads(row.get("skills")    or "[]")
    row["questions"] = json.loads(row.get("questions") or "[]")
    return row


@app.patch("/api/campaigns/{campaign_id}")
def update_campaign(campaign_id: int, body: CampaignUpdateIn, user: dict = Depends(current_user)):
    """Update any campaign content field. Only the campaign's brand owner can do this."""
    require_role("brand", user)
    with get_conn() as conn:
        row = _row(conn, "SELECT * FROM campaigns WHERE id = ? AND brand_id = ?",
                   (campaign_id, user["id"]))
        if not row:
            raise HTTPException(404, "Campaign not found or not yours")

        updates = {}
        if body.title         is not None: updates["title"]         = body.title
        if body.description   is not None: updates["description"]   = body.description
        if body.budget        is not None: updates["budget"]        = body.budget
        if body.niche         is not None: updates["niche"]         = body.niche
        if body.skills        is not None: updates["skills"]        = json.dumps(body.skills)
        if body.target_age    is not None: updates["target_age"]    = body.target_age
        if body.min_followers is not None: updates["min_followers"] = body.min_followers
        if body.max_rate      is not None: updates["max_rate"]      = body.max_rate
        if body.questions     is not None: updates["questions"]     = json.dumps(body.questions)

        if not updates:
            raise HTTPException(400, "No fields to update")

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        conn.execute(
            f"UPDATE campaigns SET {set_clause} WHERE id = ?",
            (*updates.values(), campaign_id)
        )
        conn.commit()
        updated = _row(conn, "SELECT * FROM campaigns WHERE id = ?", (campaign_id,))
        updated["skills"]    = json.loads(updated.get("skills")    or "[]")
        updated["questions"] = json.loads(updated.get("questions") or "[]")
        return updated


@app.patch("/api/campaigns/{campaign_id}/status")
def update_campaign_status(campaign_id: int, body: CampaignStatusIn, user: dict = Depends(current_user)):
    require_role("brand", user)
    if body.status not in ("open", "paused", "closed"):
        raise HTTPException(400, "status must be open | paused | closed")
    with get_conn() as conn:
        row = _row(conn, "SELECT * FROM campaigns WHERE id = ? AND brand_id = ?",
                   (campaign_id, user["id"]))
        if not row:
            raise HTTPException(404, "Campaign not found or not yours")
        conn.execute("UPDATE campaigns SET status = ? WHERE id = ?", (body.status, campaign_id))
        conn.commit()
    return {"ok": True}


@app.delete("/api/campaigns/{campaign_id}", status_code=204)
def delete_campaign(campaign_id: int, user: dict = Depends(current_user)):
    require_role("brand", user)
    with get_conn() as conn:
        row = _row(conn, "SELECT * FROM campaigns WHERE id = ? AND brand_id = ?",
                   (campaign_id, user["id"]))
        if not row:
            raise HTTPException(404, "Campaign not found or not yours")
        conn.execute("DELETE FROM campaigns WHERE id = ?", (campaign_id,))
        conn.commit()

# ---------------------------------------------------------------------------
# Routes — Applications
# ---------------------------------------------------------------------------

@app.post("/api/campaigns/{campaign_id}/apply", status_code=201)
def apply_to_campaign(campaign_id: int, body: ApplicationIn, user: dict = Depends(current_user)):
    require_role("creator", user)
    with get_conn() as conn:
        campaign = _row(conn, "SELECT * FROM campaigns WHERE id = ? AND status = 'open'", (campaign_id,))
        if not campaign:
            raise HTTPException(404, "Campaign not found or not open")
        existing = _row(conn, "SELECT id FROM applications WHERE campaign_id = ? AND creator_id = ?",
                        (campaign_id, user["id"]))
        if existing:
            raise HTTPException(409, "You have already applied to this campaign")
        conn.execute("""
            INSERT INTO applications (campaign_id, creator_id, answers, message)
            VALUES (?, ?, ?, ?)
        """, (campaign_id, user["id"], json.dumps(body.answers or []), body.message))
        conn.commit()
    return {"ok": True}


@app.get("/api/campaigns/{campaign_id}/applications")
def get_campaign_applications(campaign_id: int, user: dict = Depends(current_user)):
    require_role("brand", user)
    with get_conn() as conn:
        campaign = _row(conn, "SELECT id FROM campaigns WHERE id = ? AND brand_id = ?",
                        (campaign_id, user["id"]))
        if not campaign:
            raise HTTPException(404, "Campaign not found or not yours")
        rows = _rows(conn, """
            SELECT a.*, u.name AS creator_name, u.initials AS creator_initials,
                   cp.niche, cp.followers_ig, cp.followers_tt, cp.followers_yt,
                   cp.engagement_rate
            FROM applications a
            JOIN users u ON u.id = a.creator_id
            LEFT JOIN creator_profiles cp ON cp.user_id = a.creator_id
            WHERE a.campaign_id = ?
            ORDER BY
                CASE WHEN a.source = 'invite' AND a.status = 'pending' THEN 0 ELSE 1 END,
                a.created_at DESC
        """, (campaign_id,))
    for r in rows:
        r["answers"] = json.loads(r.get("answers") or "[]")
    return rows


@app.get("/api/creator/applications")
def get_my_applications(user: dict = Depends(current_user)):
    """Return all campaigns the current creator has applied to."""
    require_role("creator", user)
    with get_conn() as conn:
        rows = _rows(conn, """
            SELECT a.id, a.campaign_id, a.status, a.created_at
            FROM applications a
            WHERE a.creator_id = ?
            ORDER BY a.created_at DESC
        """, (user["id"],))
    return [dict(r) for r in rows]


@app.patch("/api/applications/{application_id}/status")
def update_application_status(application_id: int, body: ApplicationStatusIn, user: dict = Depends(current_user)):
    require_role("brand", user)
    if body.status not in ("accepted", "declined"):
        raise HTTPException(400, "status must be accepted or declined")
    with get_conn() as conn:
        row = _row(conn, """
            SELECT a.* FROM applications a
            JOIN campaigns c ON c.id = a.campaign_id
            WHERE a.id = ? AND c.brand_id = ?
        """, (application_id, user["id"]))
        if not row:
            raise HTTPException(404, "Application not found or not yours")
        conn.execute("UPDATE applications SET status = ? WHERE id = ?", (body.status, application_id))
        conn.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Routes — Campaign Invitations (brand → creator)
# ---------------------------------------------------------------------------

class InviteIn(BaseModel):
    message: Optional[str] = None

class InviteRespondIn(BaseModel):
    action: str   # "accept" | "decline"

@app.post("/api/campaigns/{campaign_id}/invite/{creator_id}", status_code=201)
async def invite_creator(campaign_id: int, creator_id: int, body: InviteIn,
                         user: dict = Depends(current_user)):
    require_role("brand", user)
    with get_conn() as conn:
        campaign = _row(conn, "SELECT * FROM campaigns WHERE id = ? AND brand_id = ? AND status = 'open'",
                        (campaign_id, user["id"]))
        if not campaign:
            raise HTTPException(404, "Campaign not found, not yours, or not open")
        creator = _row(conn, "SELECT * FROM users WHERE id = ? AND role = 'creator'", (creator_id,))
        if not creator:
            raise HTTPException(404, "Creator not found")
        existing = _row(conn, "SELECT id, source FROM applications WHERE campaign_id = ? AND creator_id = ?",
                        (campaign_id, creator_id))
        if existing:
            raise HTTPException(409, "This creator has already applied or been invited to this campaign")
        conn.execute("""
            INSERT INTO applications (campaign_id, creator_id, answers, source, invite_message, status)
            VALUES (?, ?, '[]', 'invite', ?, 'pending')
        """, (campaign_id, creator_id, body.message or None))
        conn.commit()

    brand_name = (user.get("company_name") or user.get("name") or "A brand")
    await _notify(
        user_id    = creator_id,
        notif_type = "campaign_invite",
        title      = f"You've been invited to a campaign!",
        body       = f"{brand_name} invited you to apply to \"{campaign['title']}\". Check your invitations to respond.",
        data       = {"campaign_id": campaign_id, "brand_id": user["id"]},
        email      = creator.get("email"),
    )
    return {"ok": True}


@app.get("/api/invitations")
def get_invitations(user: dict = Depends(current_user)):
    """Creator: list pending campaign invitations."""
    require_role("creator", user)
    with get_conn() as conn:
        rows = _rows(conn, """
            SELECT a.id, a.campaign_id, a.invite_message, a.status, a.created_at,
                   c.title AS campaign_title, c.description AS campaign_description,
                   c.budget, c.niche AS campaign_niche, c.status AS campaign_status,
                   u.name AS brand_name, bp.company_name, bp.industry, bp.logo_url
            FROM applications a
            JOIN campaigns c ON c.id = a.campaign_id
            JOIN users u     ON u.id = c.brand_id
            LEFT JOIN brand_profiles bp ON bp.user_id = c.brand_id
            WHERE a.creator_id = ? AND a.source = 'invite'
            ORDER BY a.created_at DESC
        """, (user["id"],))
    return rows


@app.patch("/api/invitations/{application_id}/respond")
async def respond_to_invitation(application_id: int, body: InviteRespondIn,
                                user: dict = Depends(current_user)):
    """Creator: accept or decline a campaign invitation."""
    require_role("creator", user)
    if body.action not in ("accept", "decline"):
        raise HTTPException(400, "action must be 'accept' or 'decline'")
    with get_conn() as conn:
        row = _row(conn, """
            SELECT a.*, c.title AS campaign_title, c.brand_id,
                   u.name AS brand_user_name, u.email AS brand_email,
                   bp.company_name
            FROM applications a
            JOIN campaigns c ON c.id = a.campaign_id
            JOIN users u     ON u.id = c.brand_id
            LEFT JOIN brand_profiles bp ON bp.user_id = c.brand_id
            WHERE a.id = ? AND a.creator_id = ? AND a.source = 'invite'
        """, (application_id, user["id"]))
        if not row:
            raise HTTPException(404, "Invitation not found")
        if row["status"] != "pending":
            raise HTTPException(409, "Invitation already responded to")
        new_status = "accepted" if body.action == "accept" else "declined"
        conn.execute("UPDATE applications SET status = ? WHERE id = ?", (new_status, application_id))
        conn.commit()

    # Notify the brand
    creator_name = user.get("name") or "A creator"
    brand_id     = row["brand_id"]
    brand_email  = row.get("brand_email")
    brand_name   = row.get("company_name") or row.get("brand_user_name") or "Brand"
    campaign_title = row.get("campaign_title", "your campaign")
    if body.action == "accept":
        await _notify(
            user_id    = brand_id,
            notif_type = "invite_accepted",
            title      = f"{creator_name} accepted your invitation!",
            body       = f"{creator_name} accepted your invitation to \"{campaign_title}\". Their application is now in your queue.",
            data       = {"campaign_id": row["campaign_id"], "application_id": application_id},
            email      = brand_email,
        )
    else:
        await _notify(
            user_id    = brand_id,
            notif_type = "invite_declined",
            title      = f"{creator_name} declined your invitation",
            body       = f"{creator_name} declined your invitation to \"{campaign_title}\".",
            data       = {"campaign_id": row["campaign_id"]},
            email      = brand_email,
        )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Routes — Matches
# ---------------------------------------------------------------------------

def _compute_score(creator: dict, campaign: dict) -> Tuple[int, List[str]]:
    """
    Port of the JS scoring algorithm in app.js → runMatching().
    Returns (score 0–100, reasons[]).

    Weights (matching JS exactly):
      Niche match          +20  |  niche specified but no match  -10
      Skill match          +20  |  skill specified but no match  -10
      Audience age match   +15
      Meets min_followers  +10  |  below threshold               -20
      Rate ≤ max_rate      +10  |  all rates above max_rate      -15
      Engagement ≥ 6 %     +10
      Total followers ≥ 200k +5
    """
    score   = 50
    reasons: List[str] = []

    def _parse_skills(v) -> List[str]:
        if isinstance(v, list): return v
        try: return json.loads(v or "[]")
        except Exception: return []

    c_skills  = _parse_skills(creator.get("skills"))
    ca_skills = _parse_skills(campaign.get("skills"))

    total = ((creator.get("followers_ig") or 0) +
             (creator.get("followers_tt") or 0) +
             (creator.get("followers_yt") or 0))

    # --- Niche ---
    niche = campaign.get("niche")
    if niche:
        if creator.get("niche") == niche:
            score += 20
            reasons.append(f"Specializes in {niche}")
        else:
            score -= 10

    # --- Skills (first required skill only, mirrors JS single-select) ---
    if ca_skills:
        matched_skill = next((s for s in ca_skills if s in c_skills), None)
        if matched_skill:
            score += 20
            reasons.append(f"Specializes in {matched_skill}")
        else:
            score -= 10

    # --- Audience age ---
    target_age = campaign.get("target_age")
    if target_age and creator.get("demo_age") == target_age:
        score += 15
        reasons.append(f"Audience is {target_age} age range")

    # --- Follower threshold ---
    min_followers = campaign.get("min_followers") or 0
    if min_followers:
        if total >= min_followers:
            score += 10
        else:
            score -= 20

    # --- Budget / rate match ---
    max_rate = campaign.get("max_rate") or 0
    if max_rate:
        min_creator_rate = min(
            creator.get("rate_ig")     or 0,
            creator.get("rate_tiktok") or 0,
            creator.get("rate_ugc")    or 0,
        )
        if min_creator_rate <= max_rate:
            score += 10
            reasons.append(f"Rates start at ${min_creator_rate}")
        else:
            score -= 15

    # --- Engagement bonus ---
    if (creator.get("engagement_rate") or 0) >= 6:
        score += 10
        reasons.append(f"High engagement ({creator.get('engagement_rate')}%)")

    # --- Audience size bonus ---
    if total >= 200_000:
        score += 5
        reasons.append(f"Large audience ({total:,})")

    score = min(100, max(0, score))
    if not reasons:
        reasons.append("General pickleball creator")

    return score, reasons


@app.post("/api/campaigns/{campaign_id}/matches", status_code=201)
def compute_matches(campaign_id: int, user: dict = Depends(current_user)):
    """Score every creator profile against this campaign and persist results."""
    require_role("brand", user)
    with get_conn() as conn:
        campaign = _row(conn, "SELECT * FROM campaigns WHERE id = ? AND brand_id = ?",
                        (campaign_id, user["id"]))
        if not campaign:
            raise HTTPException(404, "Campaign not found or not yours")
        creators = _rows(conn, "SELECT * FROM creator_profiles")

    stored = []
    with get_conn() as conn:
        for c in creators:
            score, reasons = _compute_score(c, campaign)
            conn.execute("""
                INSERT INTO matches (campaign_id, creator_id, match_score, match_reasons)
                VALUES (?,?,?,?)
                ON CONFLICT(campaign_id, creator_id) DO UPDATE SET
                  match_score=excluded.match_score,
                  match_reasons=excluded.match_reasons
            """, (campaign_id, c["user_id"], score, json.dumps(reasons)))
            stored.append({"creator_id": c["user_id"], "match_score": score, "match_reasons": reasons})
        conn.commit()

    return sorted(stored, key=lambda x: x["match_score"], reverse=True)


@app.get("/api/campaigns/{campaign_id}/matches")
def get_matches(campaign_id: int, user: dict = Depends(current_user)):
    with get_conn() as conn:
        rows = _rows(conn, """
            SELECT m.match_score, m.match_reasons, m.created_at,
                   cp.user_id, cp.name, cp.niche, cp.location,
                   cp.followers_ig, cp.followers_tt, cp.followers_yt,
                   cp.engagement_rate, cp.rate_ig, cp.rate_tiktok, cp.rate_ugc, cp.skills
            FROM matches m
            JOIN creator_profiles cp ON cp.user_id = m.creator_id
            WHERE m.campaign_id = ?
            ORDER BY m.match_score DESC
        """, (campaign_id,))
    for r in rows:
        r["skills"]          = json.loads(r.get("skills")        or "[]")
        r["match_reasons"]   = json.loads(r.get("match_reasons") or "[]")
        r["total_followers"] = ((r.get("followers_ig") or 0) +
                                (r.get("followers_tt") or 0) +
                                (r.get("followers_yt") or 0))
    return rows


@app.get("/api/discover")
def discover(
    niche:         Optional[str] = Query(None),
    skill:         Optional[str] = Query(None),
    age:           Optional[str] = Query(None),
    min_followers: Optional[int] = Query(None, ge=0),
    max_budget:    Optional[int] = Query(None, ge=0),
    user:          dict          = Depends(current_user),
):
    """
    Standalone discovery — score all creators against ad-hoc filter params.
    No campaign required. Mirrors the Discovery page filters in the frontend.
    """
    # Build a synthetic campaign dict so we can reuse _compute_score
    synthetic = {
        "niche":         niche,
        "skills":        json.dumps([skill]) if skill else "[]",
        "target_age":    age,
        "min_followers": min_followers or 0,
        "max_rate":      max_budget or 0,
    }

    with get_conn() as conn:
        creators = _rows(conn, """
            SELECT cp.*, u.email
            FROM creator_profiles cp
            JOIN users u ON u.id = cp.user_id
        """)

    results = []
    for c in creators:
        c["skills"]         = json.loads(c.get("skills")         or "[]")
        c["social_handles"] = json.loads(c.get("social_handles") or "{}")
        score, reasons      = _compute_score(c, synthetic)
        c["match_score"]    = score
        c["match_reasons"]  = reasons
        c["total_followers"] = ((c.get("followers_ig") or 0) +
                                (c.get("followers_tt") or 0) +
                                (c.get("followers_yt") or 0))
        results.append(c)

    results.sort(key=lambda x: x["match_score"], reverse=True)
    return results

# ---------------------------------------------------------------------------
# Schemas — Deals
# ---------------------------------------------------------------------------

class DealIn(BaseModel):
    campaign_id:   int
    creator_id:    int
    amount:        Optional[int] = Field(default=0, ge=0)
    terms:         Optional[str] = None
    contract_type: Optional[str] = None   # "template" | "custom"

class DealStatusIn(BaseModel):
    status: str

class RatingIn(BaseModel):
    score:   int            = Field(ge=1, le=5)
    comment: Optional[str] = None

class DisputeIn(BaseModel):
    reason: str = Field(min_length=10, max_length=2000)

class DisputeCommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=2000)

class DisputeUpdateIn(BaseModel):
    status:     str            # 'open' | 'resolved' | 'closed'
    resolution: Optional[str] = None

# ---------------------------------------------------------------------------
# Routes — Deals
# ---------------------------------------------------------------------------

# Allowed transitions per role
_CREATOR_TRANSITIONS = {"active", "declined"}   # creator accepts (active) or declines
_BRAND_TRANSITIONS   = {"completed"}             # brand marks work done

# Human-readable labels for notifications
_STATUS_LABELS = {
    "pending":   "Pending",
    "active":    "Active",
    "declined":  "Declined",
    "completed": "Completed",
}


def _generate_contract(deal: dict, campaign: dict, brand_profile: dict, creator_profile: dict) -> str:
    """
    Render a plain-text collaboration agreement pre-filled with deal data.
    Stored once when the creator accepts; both parties sign digitally.
    """
    today         = datetime.now().strftime("%B %d, %Y")
    brand_name    = (brand_profile.get("company_name") or deal.get("brand_name") or "Brand").strip()
    creator_name  = (creator_profile.get("name") or deal.get("creator_name") or "Creator").strip()
    campaign_title = campaign.get("title") or deal.get("campaign_title") or "—"
    deliverables  = (deal.get("terms") or "As mutually agreed upon by both parties").strip()
    amount        = deal.get("amount") or 0
    creator_payout = round(amount * 0.85)
    platform_fee   = amount - creator_payout
    niche          = campaign.get("niche") or "—"

    return f"""CONTENT CREATOR COLLABORATION AGREEMENT
════════════════════════════════════════════════════════
Date:         {today}
Agreement ID: CC-DEAL-{deal['id']}
Platform:     CourtCollab (courtcollab.com)
════════════════════════════════════════════════════════

PARTIES
───────────────────────────────────────────────────────
Brand / Company:  {brand_name}
Creator:          {creator_name}

CAMPAIGN DETAILS
───────────────────────────────────────────────────────
Campaign Title:   {campaign_title}
Content Category: {niche}
Campaign ID:      #{campaign.get('id', '—')}

DELIVERABLES
───────────────────────────────────────────────────────
{deliverables}

COMPENSATION
───────────────────────────────────────────────────────
Total Deal Value:  ${amount:,}
Platform Fee:      ${platform_fee:,}  (15% CourtCollab service fee)
Creator Payout:    ${creator_payout:,}  (85% of deal value)

Payment is held in escrow by CourtCollab until the Brand confirms that all
deliverables have been received and approved. Funds are released to the
Creator's connected bank account within 3–5 business days of confirmation.

TERMS & CONDITIONS
───────────────────────────────────────────────────────
1. CONTENT RIGHTS
   The Creator grants the Brand a non-exclusive, royalty-free, perpetual licence
   to use, share, and repurpose the delivered content across all owned digital
   channels (website, social media, email, paid advertising). The Creator retains
   the right to display the content in their portfolio.

2. EXCLUSIVITY
   Unless explicitly stated in the Deliverables section above, this agreement
   does not include category exclusivity. The Creator may work with other brands
   in the same industry.

3. FTC / ADVERTISING DISCLOSURE
   The Creator agrees to clearly disclose this paid partnership in all published
   content, consistent with FTC guidelines and each platform's policies
   (e.g. #ad, #sponsored, or "Paid Partnership" label on Instagram/TikTok).

4. CONTENT REVISIONS
   The Creator will provide up to two (2) rounds of revisions at no additional
   cost if submitted content does not materially match the agreed deliverables.
   Additional revision rounds may be negotiated separately.

5. DELIVERY TIMELINE
   Content must be delivered within the timeframe specified above. Where no
   timeline is stated, delivery is expected within thirty (30) days of the date
   of this agreement.

6. INTELLECTUAL PROPERTY
   Original content created under this agreement remains the intellectual
   property of the Creator until the full payout is received by the Creator.

7. MORAL RIGHTS & BRAND SAFETY
   The Brand may request removal of content that violates its brand guidelines,
   contains factual inaccuracies, or breaches platform terms of service.

8. CONFIDENTIALITY
   Both parties agree to keep the financial terms of this agreement confidential
   and not to disclose deal amounts to third parties without mutual consent.

9. DISPUTE RESOLUTION
   Any disputes will first be addressed through CourtCollab's platform mediation
   process. Both parties commit to good-faith negotiation before pursuing any
   external legal remedy.

10. GOVERNING LAW
    This agreement is governed by the laws of the United States. Any legal action
    must be brought in a jurisdiction mutually agreed upon by both parties.

11. PLATFORM TERMS
    Both parties agree to comply with CourtCollab's Terms of Service, accessible
    at courtcollab.com/terms, as amended from time to time.

SIGNATURES
───────────────────────────────────────────────────────
By digitally signing below, each party confirms that they have read, understood,
and agree to all terms and conditions stated in this agreement.

Brand ({brand_name}):
  Signature: ________________________________  Date: ____________

Creator ({creator_name}):
  Signature: ________________________________  Date: ____________

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This agreement was generated automatically by CourtCollab.
Deal Reference: #{deal['id']} | Generated: {today}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"""


def _build_contract_pdf(
    deal: dict, campaign: dict, brand_profile: dict, creator_profile: dict
) -> bytes:
    """
    Render the contract as a PDF using fpdf2 and return raw PDF bytes.
    Falls back gracefully if fpdf2 is not installed.
    """
    try:
        from fpdf import FPDF
    except ImportError:
        # fpdf2 not available — return plain-text bytes (SignWell still accepts .txt)
        text = _generate_contract(deal, campaign, brand_profile, creator_profile)
        return text.encode("utf-8")

    contract_text = _generate_contract(deal, campaign, brand_profile, creator_profile)

    # fpdf2 core fonts (Helvetica) are Latin-1 only; replace non-Latin-1 box-drawing
    # characters so the PDF renderer does not raise UnicodeEncodeError.
    _BOX_REPLACEMENTS = {
        "\u2550": "=",   # ═  double horizontal
        "\u2554": "+",   # ╔
        "\u2557": "+",   # ╗
        "\u255a": "+",   # ╚
        "\u255d": "+",   # ╝
        "\u2551": "|",   # ║ double vertical
        "\u2500": "-",   # ─ single horizontal
        "\u2502": "|",   # │ single vertical
        "\u2501": "-",   # ━ heavy horizontal
        "\u2503": "|",   # ┃ heavy vertical
        "\u2022": "-",   # • bullet
        "\u2013": "-",   # – en dash
        "\u2014": "--",  # — em dash
    }
    for ch, repl in _BOX_REPLACEMENTS.items():
        contract_text = contract_text.replace(ch, repl)

    # Encode to Latin-1, replacing any remaining non-encodable characters
    contract_text = contract_text.encode("latin-1", errors="replace").decode("latin-1")

    pdf = FPDF(orientation="P", unit="mm", format="A4")
    pdf.set_margins(left=20, top=20, right=20)
    pdf.set_auto_page_break(auto=True, margin=20)
    pdf.add_page()

    # Header — CourtCollab branding
    pdf.set_font("Helvetica", "B", 16)
    pdf.set_fill_color(26, 26, 46)   # #1a1a2e navy
    pdf.set_text_color(200, 241, 53) # #C8F135 lime
    pdf.cell(0, 10, "CourtCollab", ln=True, fill=True, align="C")

    pdf.set_text_color(0, 0, 0)
    pdf.set_font("Helvetica", "", 9)
    pdf.ln(4)

    # Body — contract text line by line
    for line in contract_text.split("\n"):
        # Section headers in bold
        stripped = line.strip()
        is_header = (
            stripped.isupper() and len(stripped) > 3
            or stripped.startswith("====")
            or stripped.startswith("----")
        )
        if is_header:
            pdf.set_font("Helvetica", "B", 9)
        else:
            pdf.set_font("Helvetica", "", 9)
        pdf.multi_cell(0, 4.5, line if line else " ")

    return bytes(pdf.output())


def _get_contract_signers(deal: dict, brand_profile: dict) -> list[dict]:
    """
    Return the two signers in signing order: brand first, creator second.
    Pulls names and emails from the enriched deal dict.
    """
    brand_display = (
        brand_profile.get("company_name") or deal.get("brand_name") or "Brand"
    ).strip()
    return [
        {
            "name":          brand_display,
            "email":         deal["brand_email"],
            "signing_order": 1,
        },
        {
            "name":          (deal.get("creator_name") or "Creator").strip(),
            "email":         deal["creator_email"],
            "signing_order": 2,
        },
    ]


def _deal_detail(conn, deal_id: int) -> Optional[dict]:
    return _row(conn, """
        SELECT d.*,
               c.title        AS campaign_title,
               c.niche        AS campaign_niche,
               ub.name        AS brand_name,
               ub.email       AS brand_email,
               uc.name        AS creator_name,
               uc.email       AS creator_email,
               uc.initials    AS creator_initials
        FROM deals d
        JOIN campaigns c ON c.id  = d.campaign_id
        JOIN users ub    ON ub.id = d.brand_id
        JOIN users uc    ON uc.id = d.creator_id
        WHERE d.id = ?
    """, (deal_id,))


@app.post("/api/deals", status_code=201)
@limiter.limit("10/minute")
async def create_deal(request: Request, body: DealIn, user: dict = Depends(current_user)):
    require_role("brand", user)
    with get_conn() as conn:
        campaign = _row(conn, "SELECT * FROM campaigns WHERE id = ? AND brand_id = ?",
                        (body.campaign_id, user["id"]))
        if not campaign:
            raise HTTPException(404, "Campaign not found or not yours")
        creator = _row(conn, "SELECT * FROM users WHERE id = ? AND role = 'creator'",
                       (body.creator_id,))
        if not creator:
            raise HTTPException(404, "Creator not found")

        cur = conn.execute(
            "INSERT INTO deals (campaign_id, creator_id, brand_id, amount, terms) VALUES (?,?,?,?,?)",
            (body.campaign_id, body.creator_id, user["id"], body.amount, body.terms),
        )
        conn.commit()
        did = cur.lastrowid

    with get_conn() as conn:
        deal = _deal_detail(conn, did)

    # Notify creator — deal proposed
    await _notify(
        user_id    = body.creator_id,
        notif_type = "deal_proposed",
        title      = f"New deal proposal from {user['name']}",
        body       = (f"{user['name']} proposed a ${body.amount:,} deal for "
                      f"\"{campaign['title']}\". Review and accept or decline."),
        data       = {"deal_id": did, "campaign_id": body.campaign_id},
        email      = creator["email"],
    )

    # Notify admins — new deal created
    admin_subject = f"[New Deal] {user['name']} → {creator['name']} — ${body.amount:,}"
    admin_body = (
        f"A new deal has been created on CourtCollab.\n\n"
        f"  Deal ID  : #{did}\n"
        f"  Brand    : {user['name']} ({user['email']})\n"
        f"  Creator  : {creator['name']} ({creator['email']})\n"
        f"  Campaign : {campaign['title']}\n"
        f"  Amount   : ${body.amount:,}\n"
        f"  Terms    : {body.terms or 'None provided'}\n\n"
        f"— CourtCollab Platform"
    )
    for admin in ADMIN_EMAILS:
        _send_email(admin, admin_subject, admin_body, event_type="new_deal")

    return deal


@app.get("/api/deals")
def list_deals(
    deal_status: Optional[str] = Query(None, alias="status"),
    user: dict = Depends(current_user),
):
    uid   = user["id"]
    field = "brand_id" if user["role"] == "brand" else "creator_id"
    with get_conn() as conn:
        rows = _rows(conn, f"""
            SELECT d.*,
                   c.title        AS campaign_title,
                   c.niche        AS campaign_niche,
                   ub.name        AS brand_name,
                   uc.name        AS creator_name,
                   uc.initials    AS creator_initials,
                   r_mine.score   AS my_rating
            FROM deals d
            JOIN campaigns c ON c.id  = d.campaign_id
            JOIN users ub    ON ub.id = d.brand_id
            JOIN users uc    ON uc.id = d.creator_id
            LEFT JOIN ratings r_mine ON r_mine.deal_id = d.id AND r_mine.reviewer_id = ?
            WHERE d.{field} = ?
            ORDER BY d.updated_at DESC
        """, (uid, uid))
    if deal_status:
        rows = [r for r in rows if r["status"] == deal_status]
    return rows


@app.get("/api/deals/{deal_id}")
def get_deal(deal_id: int, user: dict = Depends(current_user)):
    with get_conn() as conn:
        deal = _deal_detail(conn, deal_id)
    if not deal:
        raise HTTPException(404, "Deal not found")
    if user["id"] not in (deal["brand_id"], deal["creator_id"]):
        raise HTTPException(403, "Not your deal")
    return deal


async def _trigger_contract_for_deal(deal_id: int) -> None:
    """
    Full contract creation pipeline — called once both parties have confirmed terms.
    Builds PDF, creates SignWell document, updates deal to contract_sent.
    """
    import base64 as _base64
    try:
        with get_conn() as conn:
            full_deal     = _row(conn, """
                SELECT d.*,
                       c.title        AS campaign_title,
                       c.niche        AS campaign_niche,
                       c.description  AS campaign_description,
                       ub.name        AS brand_name,
                       ub.email       AS brand_email,
                       uc.name        AS creator_name,
                       uc.email       AS creator_email
                FROM deals d
                JOIN campaigns c ON c.id  = d.campaign_id
                JOIN users ub    ON ub.id = d.brand_id
                JOIN users uc    ON uc.id = d.creator_id
                WHERE d.id = ?
            """, (deal_id,))
            campaign_row    = _row(conn, "SELECT * FROM campaigns        WHERE id = ?",      (full_deal["campaign_id"],))
            brand_profile   = _row(conn, "SELECT * FROM brand_profiles   WHERE user_id = ?", (full_deal["brand_id"],))
            creator_profile = _row(conn, "SELECT * FROM creator_profiles WHERE user_id = ?", (full_deal["creator_id"],))

        # Store plain-text copy in contracts table
        contract_text = _generate_contract(
            full_deal, campaign_row or {}, brand_profile or {}, creator_profile or {}
        )
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO contracts (deal_id, content) VALUES (?,?) ON CONFLICT (deal_id) DO NOTHING",
                (deal_id, contract_text),
            )
            conn.commit()

        # Build PDF and send via SignWell
        pdf_bytes = _build_contract_pdf(
            full_deal, campaign_row or {}, brand_profile or {}, creator_profile or {}
        )
        pdf_b64   = _base64.b64encode(pdf_bytes).decode("ascii")
        signers   = _get_contract_signers(full_deal, brand_profile or {})
        brand_company = (brand_profile or {}).get("company_name") or full_deal.get("brand_name", "Brand")
        creator_name  = full_deal.get("creator_name", "Creator")
        doc_name  = f"CourtCollab Deal #{deal_id} — {brand_company} × {creator_name}"

        sw_doc = await sw.create_document(
            name    = doc_name,
            subject = f"Please sign: {doc_name}",
            message = (
                f"Hi,\n\nPlease review and sign the brand deal agreement for "
                f"\"{full_deal.get('campaign_title', 'your campaign')}\" on CourtCollab.\n\n"
                f"Deal amount: ${full_deal.get('amount', 0):,}\n\n"
                f"— The CourtCollab Team"
            ),
            signers       = signers,
            file_base64   = [{"data": pdf_b64, "name": f"courtcollab_deal_{deal_id}.pdf"}],
            send_in_order = True,
        )
        sw_doc_id = sw_doc.get("id", "")
        if sw_doc_id:
            with get_conn() as conn:
                conn.execute(
                    """UPDATE deals
                       SET contract_document_id = ?,
                           contract_status      = 'contract_sent',
                           contract_sent_at     = datetime('now'),
                           updated_at           = datetime('now')
                       WHERE id = ?""",
                    (sw_doc_id, deal_id),
                )
                conn.commit()
            logging.info("Contract triggered for deal #%s — doc %s", deal_id, sw_doc_id)

    except Exception as exc:
        logging.warning("_trigger_contract_for_deal failed for deal #%s: %s", deal_id, exc)


@app.patch("/api/deals/{deal_id}/status")
async def update_deal_status(deal_id: int, body: DealStatusIn, user: dict = Depends(current_user)):
    """
    Status machine:
      creator:  pending  → active | declined
      brand:    active   → completed
    """
    role = user["role"]
    allowed = _CREATOR_TRANSITIONS if role == "creator" else _BRAND_TRANSITIONS
    if body.status not in allowed:
        raise HTTPException(400, f"{role} can only set status to: {' | '.join(sorted(allowed))}")

    with get_conn() as conn:
        own_field = "creator_id" if role == "creator" else "brand_id"
        deal = _row(conn, f"SELECT * FROM deals WHERE id = ? AND {own_field} = ?",
                    (deal_id, user["id"]))
        if not deal:
            raise HTTPException(404, "Deal not found or not yours")

        # Guard valid from-state
        if body.status == "active"    and deal["status"] != "pending":
            raise HTTPException(409, "Can only accept a pending deal")
        if body.status == "declined"  and deal["status"] != "pending":
            raise HTTPException(409, "Can only decline a pending deal")
        if body.status == "completed" and deal["status"] != "active":
            raise HTTPException(409, "Can only complete an active deal")

        conn.execute(
            "UPDATE deals SET status = ?, updated_at = datetime('now') WHERE id = ?",
            (body.status, deal_id),
        )
        conn.commit()
        deal = _deal_detail(conn, deal_id)

    label = _STATUS_LABELS.get(body.status, body.status)

    # Contract will be triggered after both parties confirm deal terms
    # (see POST /api/deals/{deal_id}/confirm-terms)

    # Notify the other party
    if body.status == "active":
        # Creator accepted → notify brand
        await _notify(
            user_id    = deal["brand_id"],
            notif_type = "deal_active",
            title      = f"{deal['creator_name']} accepted your deal",
            body       = (f"Your ${deal['amount']:,} deal for \"{deal['campaign_title']}\" "
                          f"is now active. Please review and confirm the deal terms to generate your contract."),
            data       = {"deal_id": deal_id, "campaign_id": deal["campaign_id"]},
            email      = deal["brand_email"],
        )
    elif body.status == "declined":
        # Creator declined → notify brand
        await _notify(
            user_id    = deal["brand_id"],
            notif_type = "deal_declined",
            title      = f"{deal['creator_name']} declined your deal",
            body       = (f"Your proposal for \"{deal['campaign_title']}\" was declined. "
                          f"Consider adjusting terms or reaching out to other creators."),
            data       = {"deal_id": deal_id, "campaign_id": deal["campaign_id"]},
            email      = deal["brand_email"],
        )
    elif body.status == "completed":
        # Brand marked complete → notify creator
        await _notify(
            user_id    = deal["creator_id"],
            notif_type = "deal_completed",
            title      = f"Deal completed — payout incoming",
            body       = (f"Your deal with {deal['brand_name']} for "
                          f"\"{deal['campaign_title']}\" has been marked complete. "
                          f"Your payout of ${round(deal['amount'] * 0.85):,} is being processed."),
            data       = {"deal_id": deal_id, "campaign_id": deal["campaign_id"]},
            email      = deal["creator_email"],
        )

    return deal


@app.post("/api/deals/{deal_id}/rate", status_code=201)
def rate_deal(deal_id: int, body: RatingIn, user: dict = Depends(current_user)):
    """
    Submit a 1–5 star rating for a completed deal.
    The brand rates the creator; the creator rates the brand.
    Each party may submit exactly one rating per deal.
    """
    with get_conn() as conn:
        deal = _row(conn, "SELECT * FROM deals WHERE id = ?", (deal_id,))
        if not deal:
            raise HTTPException(404, "Deal not found")
        if user["id"] not in (deal["brand_id"], deal["creator_id"]):
            raise HTTPException(403, "Not your deal")
        if deal["status"] != "completed":
            raise HTTPException(400, "Can only rate a completed deal")

        # The person being rated is the other party
        reviewee_id = deal["creator_id"] if user["id"] == deal["brand_id"] else deal["brand_id"]

        existing = _row(conn, "SELECT id FROM ratings WHERE deal_id = ? AND reviewer_id = ?",
                        (deal_id, user["id"]))
        if existing:
            raise HTTPException(409, "You have already rated this deal")

        conn.execute(
            "INSERT INTO ratings (deal_id, reviewer_id, reviewee_id, score, comment) VALUES (?,?,?,?,?)",
            (deal_id, user["id"], reviewee_id, body.score, body.comment),
        )
        conn.commit()
    return {"ok": True}


@app.get("/api/deals/{deal_id}/contract")
def get_contract(deal_id: int, request: Request, user: dict = Depends(current_user)):
    """Return the contract for a deal, including signing status."""
    with get_conn() as conn:
        deal     = _row(conn, "SELECT * FROM deals WHERE id = ?", (deal_id,))
        if not deal:
            raise HTTPException(404, "Deal not found")
        if user["id"] not in (deal["brand_id"], deal["creator_id"]):
            raise HTTPException(403, "Not your deal")
        contract = _row(conn, "SELECT * FROM contracts WHERE deal_id = ?", (deal_id,))
    if not contract:
        raise HTTPException(404, "Contract not generated yet")
    contract["is_brand_signed"]   = bool(contract.get("brand_signed_at"))
    contract["is_creator_signed"] = bool(contract.get("creator_signed_at"))
    contract["is_fully_signed"]   = contract["is_brand_signed"] and contract["is_creator_signed"]
    # Tell the caller whether *they* have signed
    if user["id"] == deal["brand_id"]:
        contract["i_have_signed"] = contract["is_brand_signed"]
    else:
        contract["i_have_signed"] = contract["is_creator_signed"]
    return contract


@app.post("/api/deals/{deal_id}/contract/sign", status_code=200)
def sign_contract(deal_id: int, request: Request, user: dict = Depends(current_user)):
    """Digitally sign the contract. Records timestamp and IP address."""
    client_ip = request.client.host if request.client else "unknown"
    with get_conn() as conn:
        deal     = _row(conn, "SELECT * FROM deals WHERE id = ?", (deal_id,))
        if not deal:
            raise HTTPException(404, "Deal not found")
        if user["id"] not in (deal["brand_id"], deal["creator_id"]):
            raise HTTPException(403, "Not your deal")
        contract = _row(conn, "SELECT * FROM contracts WHERE deal_id = ?", (deal_id,))
        if not contract:
            raise HTTPException(404, "Contract not found")

        if user["id"] == deal["brand_id"]:
            if contract.get("brand_signed_at"):
                raise HTTPException(409, "You have already signed this contract")
            conn.execute(
                "UPDATE contracts SET brand_signed_at = datetime('now'), brand_ip = ? WHERE deal_id = ?",
                (client_ip, deal_id),
            )
        else:
            if contract.get("creator_signed_at"):
                raise HTTPException(409, "You have already signed this contract")
            conn.execute(
                "UPDATE contracts SET creator_signed_at = datetime('now'), creator_ip = ? WHERE deal_id = ?",
                (client_ip, deal_id),
            )
        conn.commit()
        contract = _row(conn, "SELECT * FROM contracts WHERE deal_id = ?", (deal_id,))

    contract["is_brand_signed"]   = bool(contract.get("brand_signed_at"))
    contract["is_creator_signed"] = bool(contract.get("creator_signed_at"))
    contract["is_fully_signed"]   = contract["is_brand_signed"] and contract["is_creator_signed"]
    contract["i_have_signed"]     = True
    return contract


# ---------------------------------------------------------------------------
# Schemas — Messages
# ---------------------------------------------------------------------------

class MessageIn(BaseModel):
    receiver_id: int
    body:        str            = Field(min_length=1, max_length=5000)
    deal_id:     Optional[int] = None

# ---------------------------------------------------------------------------
# Routes — Messages
# ---------------------------------------------------------------------------

@app.get("/api/conversations")
def list_conversations(user: dict = Depends(current_user)):
    """
    Return one entry per unique conversation partner, ordered by most recent
    message.  Each entry includes partner info, last message preview, and
    unread count (messages sent TO the current user that have no read_at).
    """
    uid = user["id"]
    with get_conn() as conn:
        # All unique partner IDs the current user has exchanged messages with
        pairs = _rows(conn, """
            SELECT DISTINCT
              CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS partner_id
            FROM messages
            WHERE sender_id = ? OR receiver_id = ?
        """, (uid, uid, uid))

        results = []
        for p in pairs:
            pid = p["partner_id"]

            partner = _row(conn, "SELECT id, name, initials, role FROM users WHERE id = ?", (pid,))
            if not partner:
                continue

            last_msg = _row(conn, """
                SELECT * FROM messages
                WHERE (sender_id = ? AND receiver_id = ?)
                   OR (sender_id = ? AND receiver_id = ?)
                ORDER BY created_at DESC, id DESC LIMIT 1
            """, (uid, pid, pid, uid))

            unread_row = conn.execute("""
                SELECT COUNT(*) AS cnt FROM messages
                WHERE sender_id = ? AND receiver_id = ? AND read_at IS NULL
            """, (pid, uid)).fetchone()
            unread = (unread_row or {}).get("cnt", 0)

            results.append({
                "partner":      partner,
                "last_message": last_msg,
                "unread_count": unread,
            })

        # Sort by most recent message first
        results.sort(
            key=lambda x: x["last_message"]["created_at"] if x["last_message"] else "",
            reverse=True,
        )
    return results


@app.post("/api/messages", status_code=201)
@limiter.limit("30/minute")
async def send_message(request: Request, body: MessageIn, user: dict = Depends(current_user)):
    if body.receiver_id == user["id"]:
        raise HTTPException(400, "Cannot message yourself")

    with get_conn() as conn:
        receiver = _row(conn, "SELECT id, name FROM users WHERE id = ?", (body.receiver_id,))
        if not receiver:
            raise HTTPException(404, "Recipient not found")
        cur = conn.execute(
            "INSERT INTO messages (sender_id, receiver_id, body, deal_id) VALUES (?,?,?,?)",
            (user["id"], body.receiver_id, body.body, body.deal_id),
        )
        conn.commit()
        mid = cur.lastrowid
        msg = _row(conn, "SELECT * FROM messages WHERE id = ?", (mid,))

    # Clear typing indicator now that message is sent
    _typing_store.pop((user["id"], body.receiver_id), None)

    # Real-time fan-out — push to receiver's WebSocket if they are online
    await manager.send(body.receiver_id, {
        "type":        "message",
        "id":          msg["id"],
        "sender_id":   user["id"],
        "sender_name": user["name"],
        "sender_initials": user["initials"],
        "body":        msg["body"],
        "deal_id":     msg["deal_id"],
        "created_at":  msg["created_at"],
    })

    return msg


@app.get("/api/messages/{other_user_id}")
def get_conversation(other_user_id: int, user: dict = Depends(current_user)):
    """Fetch full thread and mark all incoming unread messages as read."""
    uid = user["id"]
    with get_conn() as conn:
        rows = _rows(conn, """
            SELECT m.*, u.name AS sender_name, u.initials AS sender_initials
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE (m.sender_id = ? AND m.receiver_id = ?)
               OR (m.sender_id = ? AND m.receiver_id = ?)
            ORDER BY m.created_at ASC
        """, (uid, other_user_id, other_user_id, uid))

        # Mark all unread messages from the other user as read
        conn.execute("""
            UPDATE messages
            SET read_at = datetime('now')
            WHERE sender_id = ? AND receiver_id = ? AND read_at IS NULL
        """, (other_user_id, uid))
        conn.commit()

    return rows


# ---------------------------------------------------------------------------
# Typing indicators — simple in-memory store (per-process, good enough)
# ---------------------------------------------------------------------------
import time as _time
_typing_store: dict = {}   # (sender_id, receiver_id) -> expires_at

@app.post("/api/typing/{receiver_id}", status_code=200)
def set_typing(receiver_id: int, user: dict = Depends(current_user)):
    """Mark the current user as typing to receiver_id for 2 minutes."""
    _typing_store[(user["id"], receiver_id)] = _time.time() + 120
    return {}

@app.get("/api/typing/{sender_id}")
def get_typing(sender_id: int, user: dict = Depends(current_user)):
    """Check if sender_id is currently typing to the current user."""
    key = (sender_id, user["id"])
    expires = _typing_store.get(key, 0)
    return {"is_typing": _time.time() < expires}


@app.patch("/api/messages/{message_id}/read", status_code=200)
def mark_message_read(message_id: int, user: dict = Depends(current_user)):
    """Explicit single-message read receipt."""
    with get_conn() as conn:
        msg = _row(conn, "SELECT * FROM messages WHERE id = ? AND receiver_id = ?",
                   (message_id, user["id"]))
        if not msg:
            raise HTTPException(404, "Message not found or not addressed to you")
        conn.execute(
            "UPDATE messages SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL",
            (message_id,),
        )
        conn.commit()
    return {"ok": True}

# ---------------------------------------------------------------------------
# Schemas — Payments
# ---------------------------------------------------------------------------

class PaymentIn(BaseModel):
    deal_id: int

# ---------------------------------------------------------------------------
# Routes — Payments
# ---------------------------------------------------------------------------

@app.post("/api/payments", status_code=201)
def create_payment(body: PaymentIn, user: dict = Depends(current_user)):
    require_role("brand", user)
    with get_conn() as conn:
        deal = _row(conn,
            "SELECT * FROM deals WHERE id = ? AND brand_id = ? AND status = 'active'",
            (body.deal_id, user["id"]))
        if not deal:
            raise HTTPException(404, "Accepted deal not found or not yours")

        existing = _row(conn,
            "SELECT id FROM payments WHERE deal_id = ? AND status NOT IN ('refunded')",
            (body.deal_id,))
        if existing:
            raise HTTPException(409, "Payment already exists for this deal")

        amount   = deal["amount"]
        fee      = round(amount * PLATFORM_FEE)
        payout   = amount - fee

        cur = conn.execute("""
            INSERT INTO payments
              (deal_id, brand_id, creator_id, amount, platform_fee, creator_payout, status)
            VALUES (?,?,?,?,?,?,'held')
        """, (body.deal_id, user["id"], deal["creator_id"], amount, fee, payout))
        conn.commit()
        pid = cur.lastrowid

    with get_conn() as conn:
        return _row(conn, "SELECT * FROM payments WHERE id = ?", (pid,))


@app.get("/api/payments")
def list_payments(user: dict = Depends(current_user)):
    field = "brand_id" if user["role"] == "brand" else "creator_id"
    with get_conn() as conn:
        rows = _rows(conn, f"""
            SELECT p.*,
                   d.amount       AS deal_amount,
                   c.title        AS campaign_title,
                   ub.name        AS brand_name,
                   uc.name        AS creator_name
            FROM payments p
            JOIN deals     d  ON d.id  = p.deal_id
            JOIN campaigns c  ON c.id  = d.campaign_id
            JOIN users     ub ON ub.id = p.brand_id
            JOIN users     uc ON uc.id = p.creator_id
            WHERE p.{field} = ?
            ORDER BY p.created_at DESC
        """, (user["id"],))
    return rows


@app.patch("/api/payments/{payment_id}/release")
def release_payment(payment_id: int, user: dict = Depends(current_user)):
    """
    Brand marks content delivered — releases funds to creator.
    If Stripe is configured and the creator has a Connect account,
    a transfer is created for the creator_payout amount.
    """
    require_role("brand", user)
    with get_conn() as conn:
        payment = _row(conn,
            "SELECT * FROM payments WHERE id = ? AND brand_id = ? AND status = 'held'",
            (payment_id, user["id"]))
        if not payment:
            raise HTTPException(404, "Held payment not found or not yours")

        creator_profile = _row(conn,
            "SELECT stripe_account_id FROM creator_profiles WHERE user_id = ?",
            (payment["creator_id"],))

    stripe_transfer_id = None

    # Attempt Stripe transfer if keys are configured and creator has an account
    if (stripe.api_key
            and not stripe.api_key.startswith("sk_test_REPLACE")
            and creator_profile
            and creator_profile.get("stripe_account_id")
            and payment.get("stripe_payment_id")):
        try:
            transfer = stripe.Transfer.create(
                amount=int(payment["creator_payout"]) * 100,  # cents
                currency="usd",
                destination=creator_profile["stripe_account_id"],
                source_transaction=payment["stripe_payment_id"],
                metadata={"deal_id": str(payment["deal_id"]), "payment_id": str(payment_id)},
            )
            stripe_transfer_id = transfer["id"]
        except stripe.error.StripeError as exc:
            logging.error("Stripe transfer failed for payment %s: %s", payment_id, exc)
            raise HTTPException(502, f"Stripe transfer failed: {exc.user_message}")

    with get_conn() as conn:
        conn.execute("""
            UPDATE payments
            SET status = 'released',
                released_at = datetime('now'),
                stripe_transfer_id = COALESCE(?, stripe_transfer_id)
            WHERE id = ?
        """, (stripe_transfer_id, payment_id))
        # Mark deal complete
        conn.execute(
            "UPDATE deals SET status = 'completed', updated_at = datetime('now') WHERE id = ?",
            (payment["deal_id"],)
        )
        conn.commit()

    # Notify admins — payment released / deal completed
    with get_conn() as conn:
        creator_user = _row(conn, "SELECT name, email FROM users WHERE id = ?", (payment["creator_id"],))
    admin_subject = f"[Payment Released] Deal #{payment['deal_id']} — ${payment['creator_payout']:,} to creator"
    admin_body = (
        f"A payment has been released on CourtCollab.\n\n"
        f"  Deal ID        : #{payment['deal_id']}\n"
        f"  Brand          : {user['name']} ({user['email']})\n"
        f"  Creator        : {creator_user['name'] if creator_user else payment['creator_id']} "
        f"({creator_user['email'] if creator_user else ''})\n"
        f"  Total Amount   : ${payment['amount']:,}\n"
        f"  Creator Payout : ${payment['creator_payout']:,} (85%)\n"
        f"  Platform Fee   : ${payment['amount'] - payment['creator_payout']:,} (15%)\n"
        f"  Stripe Transfer: {stripe_transfer_id or 'Manual'}\n\n"
        f"— CourtCollab Platform"
    )
    for admin in ADMIN_EMAILS:
        _send_email(admin, admin_subject, admin_body, event_type="payment_released")

    return {
        "ok": True,
        "creator_payout":    payment["creator_payout"],
        "stripe_transfer_id": stripe_transfer_id,
    }


# ---------------------------------------------------------------------------
# Routes — Stripe Connect
# ---------------------------------------------------------------------------

@app.post("/api/stripe/connect/onboard")
def stripe_connect_onboard(user: dict = Depends(current_user)):
    """Creator: create or retrieve a Stripe Express account and get the onboarding URL."""
    require_role("creator", user)
    if not stripe.api_key or stripe.api_key.startswith("sk_test_REPLACE"):
        raise HTTPException(503, "Stripe is not configured on this server")

    with get_conn() as conn:
        profile = _row(conn,
            "SELECT stripe_account_id FROM creator_profiles WHERE user_id = ?",
            (user["id"],))

    acct_id = profile["stripe_account_id"] if profile else None

    # Create a new Express account if the creator doesn't have one yet
    if not acct_id:
        acct = stripe.Account.create(
            type="express",
            capabilities={"transfers": {"requested": True}},
            metadata={"courtcollab_user_id": str(user["id"])},
        )
        acct_id = acct["id"]
        with get_conn() as conn:
            conn.execute(
                "UPDATE creator_profiles SET stripe_account_id = ? WHERE user_id = ?",
                (acct_id, user["id"]),
            )
            conn.commit()

    # Generate a fresh onboarding link (links expire after ~24 h)
    link = stripe.AccountLink.create(
        account=acct_id,
        refresh_url=f"{STRIPE_CANCEL_URL}?reason=refresh",
        return_url=f"{STRIPE_SUCCESS_URL}?stripe_onboard=1",
        type="account_onboarding",
    )
    return {"url": link["url"], "stripe_account_id": acct_id}


@app.get("/api/stripe/connect/status")
def stripe_connect_status(user: dict = Depends(current_user)):
    """Creator: check whether their Stripe Connect account is fully onboarded."""
    require_role("creator", user)
    if not stripe.api_key or stripe.api_key.startswith("sk_test_REPLACE"):
        return {"onboarded": False, "reason": "stripe_not_configured"}

    with get_conn() as conn:
        profile = _row(conn,
            "SELECT stripe_account_id, stripe_onboarded FROM creator_profiles WHERE user_id = ?",
            (user["id"],))

    if not profile or not profile["stripe_account_id"]:
        return {"onboarded": False, "stripe_account_id": None}

    acct = stripe.Account.retrieve(profile["stripe_account_id"])
    charges_enabled  = acct.get("charges_enabled", False)
    payouts_enabled  = acct.get("payouts_enabled", False)
    details_submitted = acct.get("details_submitted", False)
    fully_onboarded  = charges_enabled and payouts_enabled and details_submitted

    # Persist onboarded flag so we don't have to call Stripe every time
    if fully_onboarded and not profile["stripe_onboarded"]:
        with get_conn() as conn:
            conn.execute(
                "UPDATE creator_profiles SET stripe_onboarded = 1 WHERE user_id = ?",
                (user["id"],),
            )
            conn.commit()

    return {
        "onboarded":         fully_onboarded,
        "stripe_account_id": profile["stripe_account_id"],
        "charges_enabled":   charges_enabled,
        "payouts_enabled":   payouts_enabled,
        "details_submitted": details_submitted,
    }


@app.post("/api/stripe/checkout/{deal_id}")
@limiter.limit("5/minute")
def stripe_checkout(request: Request, deal_id: int, user: dict = Depends(current_user)):
    """
    Brand: create a Stripe Checkout Session for a deal.
    Returns a redirect URL to Stripe's hosted payment page.
    85% will be transferred to the creator on release; 15% stays on platform.
    """
    require_role("brand", user)
    if not stripe.api_key or stripe.api_key.startswith("sk_test_REPLACE"):
        raise HTTPException(503, "Stripe is not configured on this server")

    with get_conn() as conn:
        deal = _row(conn,
            "SELECT d.*, c.title AS campaign_title, u.name AS creator_name "
            "FROM deals d "
            "JOIN campaigns c ON c.id = d.campaign_id "
            "JOIN users u     ON u.id = d.creator_id "
            "WHERE d.id = ? AND d.brand_id = ? AND d.status = 'active'",
            (deal_id, user["id"]))
        if not deal:
            raise HTTPException(404, "Active deal not found or not yours")

        # Server-side contract gate — both parties must have signed before payment
        if deal.get("contract_status") != "contract_complete":
            raise HTTPException(
                403,
                "Payment is locked until both parties have signed the contract. "
                "Complete contract signing to unlock payment."
            )

        # Block duplicate payments
        existing = _row(conn,
            "SELECT id FROM payments WHERE deal_id = ? AND status NOT IN ('refunded')",
            (body.deal_id,)) if False else _row(conn,
            "SELECT id FROM payments WHERE deal_id = ? AND status NOT IN ('refunded')",
            (deal_id,))
        if existing:
            raise HTTPException(409, "Payment already initiated for this deal")

        # Get creator's Stripe account
        creator_profile = _row(conn,
            "SELECT stripe_account_id, stripe_onboarded FROM creator_profiles WHERE user_id = ?",
            (deal["creator_id"],))

    if not creator_profile or not creator_profile["stripe_account_id"]:
        raise HTTPException(422, "Creator has not connected their Stripe account yet")
    if not creator_profile["stripe_onboarded"]:
        raise HTTPException(422, "Creator's Stripe account is not fully verified yet")

    amount_cents     = int(deal["amount"]) * 100          # convert dollars → cents
    platform_fee_c   = int(round(amount_cents * PLATFORM_FEE))

    session = stripe.checkout.Session.create(
        payment_method_types=["card"],
        line_items=[{
            "price_data": {
                "currency": "usd",
                "unit_amount": amount_cents,
                "product_data": {
                    "name": f"Campaign: {deal['campaign_title']}",
                    "description": f"Creator partnership with {deal['creator_name']} — CourtCollab",
                },
            },
            "quantity": 1,
        }],
        mode="payment",
        success_url=f"{STRIPE_SUCCESS_URL}?deal_id={deal_id}&session_id={{CHECKOUT_SESSION_ID}}",
        cancel_url=f"{STRIPE_CANCEL_URL}?deal_id={deal_id}",
        payment_intent_data={
            "application_fee_amount": platform_fee_c,
            "transfer_data": {"destination": creator_profile["stripe_account_id"]},
            "metadata": {
                "deal_id":    str(deal_id),
                "brand_id":   str(user["id"]),
                "creator_id": str(deal["creator_id"]),
            },
        },
        metadata={
            "deal_id":    str(deal_id),
            "brand_id":   str(user["id"]),
            "creator_id": str(deal["creator_id"]),
        },
    )

    # Pre-create the payment record in 'pending' state
    amount_dollars   = int(deal["amount"])
    platform_fee_d   = int(round(amount_dollars * PLATFORM_FEE))
    creator_payout_d = amount_dollars - platform_fee_d

    with get_conn() as conn:
        cur = conn.execute("""
            INSERT INTO payments
              (deal_id, brand_id, creator_id, amount, platform_fee, creator_payout,
               stripe_payment_id, checkout_session_id, status)
            VALUES (?,?,?,?,?,?,?,?,'pending')
        """, (
            deal_id, user["id"], deal["creator_id"],
            amount_dollars, platform_fee_d, creator_payout_d,
            session.get("payment_intent"), session["id"],
        ))
        conn.commit()

    return {"checkout_url": session["url"], "session_id": session["id"]}


@app.post("/api/stripe/webhook", include_in_schema=False)
async def stripe_webhook(request: Request):
    """
    Stripe sends signed events here. No JWT auth — verified by Stripe signature.
    Handles:
      checkout.session.completed  → mark payment 'held'
      charge.refunded             → mark payment 'refunded'
    """
    payload   = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    try:
        if STRIPE_WEBHOOK_SECRET and not STRIPE_WEBHOOK_SECRET.startswith("whsec_REPLACE"):
            event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
        else:
            # Dev mode: parse without verification (never do this in production)
            event = stripe.Event.construct_from(json.loads(payload), stripe.api_key)
    except (ValueError, stripe.error.SignatureVerificationError) as e:
        logging.warning("Stripe webhook signature failed: %s", e)
        raise HTTPException(400, "Invalid Stripe signature")

    etype = event["type"]
    data  = event["data"]["object"]

    if etype == "checkout.session.completed":
        session_id     = data["id"]
        payment_intent = data.get("payment_intent")
        deal_id        = int(data["metadata"].get("deal_id", 0))

        with get_conn() as conn:
            conn.execute("""
                UPDATE payments
                SET status = 'held',
                    stripe_payment_id = COALESCE(stripe_payment_id, ?)
                WHERE checkout_session_id = ?
            """, (payment_intent, session_id))
            conn.commit()

            payment = _row(conn,
                "SELECT * FROM payments WHERE checkout_session_id = ?", (session_id,))

        if payment and deal_id:
            # Notify creator that funds are held
            with get_conn() as conn:
                deal_row = _row(conn,
                    "SELECT d.*, u.email AS creator_email "
                    "FROM deals d JOIN users u ON u.id = d.creator_id "
                    "WHERE d.id = ?", (deal_id,))
            if deal_row:
                import asyncio
                asyncio.create_task(_notify(
                    user_id=deal_row["creator_id"],
                    notif_type="payment_received",
                    title="Payment received — funds held",
                    body=f"${payment['amount']} has been received and is held for deal #{deal_id}. "
                         f"Funds will be released once the brand confirms delivery.",
                    data={"deal_id": deal_id},
                    email=deal_row["creator_email"],
                ))

    elif etype == "charge.refunded":
        payment_intent = data.get("payment_intent")
        if payment_intent:
            with get_conn() as conn:
                conn.execute("""
                    UPDATE payments SET status = 'refunded'
                    WHERE stripe_payment_id = ?
                """, (payment_intent,))
                conn.commit()

    return {"ok": True}


# ---------------------------------------------------------------------------
# Routes — Notifications
# ---------------------------------------------------------------------------

@app.get("/api/notifications")
def list_notifications(
    unread_only: bool = Query(False),
    user: dict = Depends(current_user),
):
    """Unread notifications first, then read, capped at 100 most recent."""
    with get_conn() as conn:
        rows = _rows(conn, """
            SELECT * FROM notifications
            WHERE user_id = ?
            ORDER BY (read_at IS NULL) DESC, created_at DESC
            LIMIT 100
        """, (user["id"],))
    for r in rows:
        r["data"] = json.loads(r.get("data") or "{}")
    if unread_only:
        rows = [r for r in rows if r["read_at"] is None]
    return rows


@app.get("/api/notifications/unread-count")
def unread_count(user: dict = Depends(current_user)):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND read_at IS NULL",
            (user["id"],),
        ).fetchone()
        count = (row or {}).get("cnt", 0)
    return {"count": count}


@app.patch("/api/notifications/read-all", status_code=200)
def mark_all_read(user: dict = Depends(current_user)):
    with get_conn() as conn:
        conn.execute(
            "UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL",
            (user["id"],),
        )
        conn.commit()
    return {"ok": True}


@app.patch("/api/notifications/{notif_id}/read", status_code=200)
def mark_one_read(notif_id: int, user: dict = Depends(current_user)):
    with get_conn() as conn:
        row = _row(conn, "SELECT * FROM notifications WHERE id = ? AND user_id = ?",
                   (notif_id, user["id"]))
        if not row:
            raise HTTPException(404, "Notification not found")
        conn.execute(
            "UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL",
            (notif_id,),
        )
        conn.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Routes — Password Reset
# ---------------------------------------------------------------------------

class ForgotPasswordIn(BaseModel):
    email: str = Field(min_length=5, max_length=254)

    @field_validator('email')
    @classmethod
    def email_valid(cls, v):
        return _validate_email(v)

class ResetPasswordIn(BaseModel):
    token: str
    password: str = Field(min_length=6, max_length=200)


@app.post("/api/forgot-password", status_code=200)
@limiter.limit("3/minute")
def forgot_password(request: Request, body: ForgotPasswordIn):
    import secrets as _secrets
    import datetime as _dt

    with get_conn() as conn:
        user = _row(conn, "SELECT * FROM users WHERE email = ?", (body.email.lower(),))

    # Always return success to avoid email enumeration
    if not user:
        return {"ok": True}

    token   = _secrets.token_urlsafe(32)
    expires = (datetime.now(timezone.utc) + timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S")

    with get_conn() as conn:
        conn.execute(
            "UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?",
            (token, expires, user["id"]),
        )
        conn.commit()

    reset_url  = f"https://www.courtcollab.com/?reset_token={token}"
    email_body = (
        f"Hi {user['name']},\n\n"
        f"Someone requested a password reset for your CourtCollab account.\n\n"
        f"Click the link below to set a new password (expires in 1 hour):\n"
        f"{reset_url}\n\n"
        f"If you didn't request this, you can safely ignore this email.\n\n"
        f"— The CourtCollab Team"
    )
    _send_email(body.email.lower(), "Reset your CourtCollab password", email_body)
    return {"ok": True}


@app.post("/api/reset-password", status_code=200)
@limiter.limit("5/minute")
def reset_password(request: Request, body: ResetPasswordIn):
    with get_conn() as conn:
        user = _row(conn,
            "SELECT * FROM users WHERE reset_token = ?", (body.token,))

    if not user:
        raise HTTPException(400, "Invalid or expired reset link")

    # Check expiry
    expires_str = user.get("reset_token_expires")
    if not expires_str:
        raise HTTPException(400, "Invalid or expired reset link")

    try:
        expires_dt = datetime.strptime(expires_str[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(400, "Invalid or expired reset link")

    if datetime.now(timezone.utc) > expires_dt:
        raise HTTPException(400, "This reset link has expired. Please request a new one.")

    with get_conn() as conn:
        conn.execute(
            "UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?",
            (_hash(body.password), user["id"]),
        )
        conn.commit()

    return {"ok": True}


# ---------------------------------------------------------------------------
# Routes — Change Password (authenticated)
# ---------------------------------------------------------------------------

class ChangePasswordIn(BaseModel):
    current_password: str = Field(min_length=1)
    password:         str = Field(min_length=8, max_length=200)

@app.post("/api/change-password", status_code=200)
@limiter.limit("10/minute")
def change_password(request: Request, body: ChangePasswordIn, user: dict = Depends(current_user)):
    if not _verify(body.current_password, user["password"]):
        raise HTTPException(400, "Current password is incorrect")
    with get_conn() as conn:
        conn.execute(
            "UPDATE users SET password = ? WHERE id = ?",
            (_hash(body.password), user["id"]),
        )
        conn.commit()
    return {"ok": True}


class DeleteAccountIn(BaseModel):
    password: str = Field(min_length=1)

@app.delete("/api/account", status_code=200)
@limiter.limit("5/minute")
def delete_account(request: Request, body: DeleteAccountIn, user: dict = Depends(current_user)):
    if not _verify(body.password, user["password"]):
        raise HTTPException(400, "Incorrect password")
    with get_conn() as conn:
        # Remove role-specific profile first
        if user["role"] == "creator":
            conn.execute("DELETE FROM creator_profiles WHERE user_id = ?", (user["id"],))
        elif user["role"] == "brand":
            conn.execute("DELETE FROM brand_profiles WHERE user_id = ?", (user["id"],))
        conn.execute("DELETE FROM users WHERE id = ?", (user["id"],))
        conn.commit()
    return {"ok": True}


class AccountUpdateIn(BaseModel):
    name:         Optional[str]      = None
    email:        Optional[EmailStr] = None
    company_name: Optional[str]      = None

@app.put("/api/account", response_model=UserOut)
@limiter.limit("20/minute")
def update_account(request: Request, body: AccountUpdateIn, user: dict = Depends(current_user)):
    with get_conn() as conn:
        if body.name is not None or body.email is not None:
            updates, params = [], []
            if body.name is not None:
                clean = body.name.strip()
                if len(clean) < 2:
                    raise HTTPException(400, "Name must be at least 2 characters")
                updates.append("name = ?")
                params.append(clean)
                updates.append("initials = ?")
                params.append(_initials(clean))
            if body.email is not None:
                updates.append("email = ?")
                params.append(body.email.lower())
            if updates:
                params.append(user["id"])
                conn.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", params)
        if body.company_name is not None and user["role"] == "brand":
            conn.execute("""
                INSERT INTO brand_profiles (user_id, company_name, updated_at)
                VALUES (?, ?, NOW())
                ON CONFLICT(user_id) DO UPDATE SET
                  company_name = excluded.company_name,
                  updated_at   = NOW()
            """, (user["id"], body.company_name.strip()))
        conn.commit()
        updated = _row(conn, "SELECT * FROM users WHERE id = ?", (user["id"],))
    updated = dict(updated)
    if updated["role"] == "brand":
        with get_conn() as conn:
            bp = _row(conn, "SELECT company_name FROM brand_profiles WHERE user_id = ?", (updated["id"],))
        updated["company_name"] = bp["company_name"] if bp else None
    return UserOut(**updated)


# ---------------------------------------------------------------------------
# Routes — Contact Form
# ---------------------------------------------------------------------------

class ContactIn(BaseModel):
    name:    str = Field(min_length=1, max_length=200)
    email:   EmailStr
    role:    str = ""
    subject: str = ""
    message: str = Field(min_length=1, max_length=5000)

@app.post("/api/contact", status_code=200)
@limiter.limit("5/minute")
def submit_contact(request: Request, body: ContactIn):
    """Forward contact form submissions to the CourtCollab team."""
    email_body = (
        f"New contact form submission from {body.name} ({body.email})\n"
        f"Role: {body.role or 'Not specified'}\n"
        f"Subject: {body.subject or 'Not specified'}\n\n"
        f"Message:\n{body.message}\n\n"
        f"— CourtCollab Contact Form"
    )
    subject = f"[CourtCollab Contact] {body.subject or 'New message'} — from {body.name}"
    for recipient in ["ben@courtcollab.com", "julia@courtcollab.com"]:
        _send_email(recipient, subject, email_body, event_type="contact_form")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Routes — Admin
# ---------------------------------------------------------------------------

def require_admin(user: dict = Depends(current_user)) -> dict:
    """Only allow platform admins (ADMIN_EMAILS list) to call this endpoint."""
    if user["email"] not in ADMIN_EMAILS:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


class AdminDeleteIn(BaseModel):
    ids: List[int]


@app.get("/api/admin/users")
def admin_list_users(admin: dict = Depends(require_admin)):
    """Return all users with basic profile info for the admin dashboard."""
    with get_conn() as conn:
        users = _rows(conn, """
            SELECT
                u.id,
                u.name,
                u.email,
                u.role,
                u.created_at,
                cp.niche,
                cp.followers_ig,
                cp.followers_tt,
                cp.followers_yt,
                bp.company_name
            FROM users u
            LEFT JOIN creator_profiles cp ON cp.user_id = u.id
            LEFT JOIN brand_profiles   bp ON bp.user_id = u.id
            ORDER BY u.id DESC
        """)
    return users


@app.delete("/api/admin/users", status_code=200)
def admin_delete_users(body: AdminDeleteIn, admin: dict = Depends(require_admin)):
    """
    Permanently delete users by ID.
    All child rows (profiles, deals, messages, etc.) are removed via CASCADE.
    """
    if not body.ids:
        raise HTTPException(400, "No user IDs provided")

    # Never let an admin accidentally delete themselves
    safe_ids = [i for i in body.ids if i != admin["id"]]
    if not safe_ids:
        raise HTTPException(400, "Cannot delete your own admin account")

    with get_conn() as conn:
        # Use PostgreSQL ANY() or a simple IN clause that works for both modes.
        # The compat layer translates ? → %s automatically, so we need one ? per id.
        placeholders = ",".join(["?" for _ in safe_ids])
        conn.execute(
            f"DELETE FROM users WHERE id IN ({placeholders})",
            tuple(safe_ids),
        )
        conn.commit()

    return {"deleted": len(safe_ids), "ids": safe_ids}


# ---------------------------------------------------------------------------
# Routes — Disputes
# ---------------------------------------------------------------------------

@app.post("/api/deals/{deal_id}/dispute", status_code=201)
def file_dispute(deal_id: int, body: DisputeIn, request: Request,
                 user: dict = Depends(current_user)):
    """
    File a dispute on an active or completed deal.
    Both the brand and creator in the deal can file; only one dispute per deal.
    """
    uid = user["id"]
    with get_conn() as conn:
        deal = _row(conn, "SELECT * FROM deals WHERE id = ?", (deal_id,))
        if not deal:
            raise HTTPException(404, "Deal not found")
        if deal["brand_id"] != uid and deal["creator_id"] != uid:
            raise HTTPException(403, "Not a participant in this deal")
        if deal["status"] not in ("active", "completed"):
            raise HTTPException(400, "Disputes can only be filed on active or completed deals")

        # Check for existing dispute
        existing = _row(conn, "SELECT id FROM disputes WHERE deal_id = ?", (deal_id,))
        if existing:
            raise HTTPException(409, "A dispute has already been filed for this deal")

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cur = conn.execute(
            "INSERT INTO disputes (deal_id, filed_by, reason, status, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?)",
            (deal_id, uid, body.reason.strip(), now, now)
        )
        dispute_id = cur.lastrowid
        conn.commit()

    # Notify the other party + admins
    other_id = deal["brand_id"] if uid == deal["creator_id"] else deal["creator_id"]
    filer_name = user.get("name", "Someone")
    with get_conn() as conn:
        other = _row(conn, "SELECT email, name FROM users WHERE id = ?", (other_id,))

    if other:
        _send_email(
            other["email"],
            f"Dispute Filed — Deal #{deal_id}",
            f"Hi {other['name']},\n\n{filer_name} has filed a dispute on your deal (#{deal_id}).\n\n"
            f"Reason:\n{body.reason}\n\n"
            "Log in to CourtCollab to respond and our team will mediate.\n\nCourtCollab",
        )
    _send_email(
        ADMIN_EMAILS[0],
        f"[Admin] New Dispute — Deal #{deal_id}",
        f"A dispute has been filed by user #{uid} ({filer_name}) on deal #{deal_id}.\n\n"
        f"Reason:\n{body.reason}",
    )

    return {"id": dispute_id, "status": "open"}


@app.get("/api/deals/{deal_id}/dispute")
def get_dispute(deal_id: int, user: dict = Depends(current_user)):
    """Return the dispute for a deal (if any) including all comments."""
    uid = user["id"]
    is_admin = user.get("email") in ADMIN_EMAILS
    with get_conn() as conn:
        deal = _row(conn, "SELECT * FROM deals WHERE id = ?", (deal_id,))
        if not deal:
            raise HTTPException(404, "Deal not found")
        if not is_admin and deal["brand_id"] != uid and deal["creator_id"] != uid:
            raise HTTPException(403, "Not authorised")

        dispute = _row(conn, """
            SELECT d.*, u.name AS filed_by_name, u.role AS filed_by_role
            FROM disputes d
            JOIN users u ON u.id = d.filed_by
            WHERE d.deal_id = ?
        """, (deal_id,))

        if not dispute:
            return None

        comments = _rows(conn, """
            SELECT dc.*, u.name AS author_name, u.role AS author_role
            FROM dispute_comments dc
            JOIN users u ON u.id = dc.author_id
            WHERE dc.dispute_id = ?
            ORDER BY dc.created_at ASC
        """, (dispute["id"],))

    dispute["comments"] = comments
    return dispute


@app.post("/api/disputes/{dispute_id}/comment", status_code=201)
def add_dispute_comment(dispute_id: int, body: DisputeCommentIn,
                        user: dict = Depends(current_user)):
    """Post a comment on a dispute (participants or admin)."""
    uid = user["id"]
    is_admin = user.get("email") in ADMIN_EMAILS
    with get_conn() as conn:
        dispute = _row(conn, "SELECT * FROM disputes WHERE id = ?", (dispute_id,))
        if not dispute:
            raise HTTPException(404, "Dispute not found")

        deal = _row(conn, "SELECT * FROM deals WHERE id = ?", (dispute["deal_id"],))
        if not is_admin and deal["brand_id"] != uid and deal["creator_id"] != uid:
            raise HTTPException(403, "Not authorised")

        if dispute["status"] == "closed":
            raise HTTPException(400, "This dispute has been closed")

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        conn.execute(
            "INSERT INTO dispute_comments (dispute_id, author_id, body, is_admin, created_at) VALUES (?, ?, ?, ?, ?)",
            (dispute_id, uid, body.body.strip(), 1 if is_admin else 0, now)
        )
        conn.commit()

    return {"ok": True}


@app.patch("/api/disputes/{dispute_id}")
def update_dispute(dispute_id: int, body: DisputeUpdateIn,
                   admin: dict = Depends(require_admin)):
    """Admin-only: update dispute status and optionally add a resolution note."""
    if body.status not in ("open", "resolved", "closed"):
        raise HTTPException(400, "Invalid status")
    with get_conn() as conn:
        dispute = _row(conn, "SELECT * FROM disputes WHERE id = ?", (dispute_id,))
        if not dispute:
            raise HTTPException(404, "Dispute not found")

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        conn.execute(
            "UPDATE disputes SET status = ?, resolution = ?, updated_at = ? WHERE id = ?",
            (body.status, body.resolution, now, dispute_id)
        )
        conn.commit()

    # Notify both parties
    deal_id = dispute["deal_id"]
    with get_conn() as conn:
        deal = _row(conn, "SELECT * FROM deals WHERE id = ?", (deal_id,))
        if deal:
            for pid in (deal["brand_id"], deal["creator_id"]):
                p = _row(conn, "SELECT email, name FROM users WHERE id = ?", (pid,))
                if p:
                    _send_email(
                        p["email"],
                        f"Dispute Update — Deal #{deal_id}",
                        f"Hi {p['name']},\n\nYour dispute on deal #{deal_id} has been updated.\n\n"
                        f"Status: {body.status.upper()}\n"
                        + (f"Resolution:\n{body.resolution}\n" if body.resolution else "")
                        + "\nLog in to CourtCollab to view full details.\n\nCourtCollab",
                    )

    return {"ok": True}


@app.get("/api/admin/disputes")
def admin_list_disputes(admin: dict = Depends(require_admin)):
    """Return all disputes ordered by creation date (newest first)."""
    with get_conn() as conn:
        disputes = _rows(conn, """
            SELECT
                d.id,
                d.deal_id,
                d.reason,
                d.status,
                d.resolution,
                d.created_at,
                d.updated_at,
                u.name  AS filed_by_name,
                u.role  AS filed_by_role,
                c.title AS campaign_title,
                ub.name AS brand_name,
                uc.name AS creator_name,
                (SELECT COUNT(*) FROM dispute_comments dc WHERE dc.dispute_id = d.id) AS comment_count
            FROM disputes d
            JOIN users u     ON u.id  = d.filed_by
            JOIN deals  dl   ON dl.id = d.deal_id
            JOIN campaigns c ON c.id  = dl.campaign_id
            JOIN users ub    ON ub.id = dl.brand_id
            JOIN users uc    ON uc.id = dl.creator_id
            ORDER BY d.created_at DESC
        """)
    return disputes


# ---------------------------------------------------------------------------
# Saved Creators
# ---------------------------------------------------------------------------

@app.post("/api/saved-creators/{creator_id}", status_code=200)
def toggle_saved_creator(creator_id: int, user: dict = Depends(current_user)):
    """Toggle save/unsave a creator for the current brand. Returns {saved: bool}."""
    if user["role"] != "brand":
        raise HTTPException(403, "Brands only")
    with get_conn() as conn:
        existing = _row(conn,
            "SELECT id FROM saved_creators WHERE brand_id=? AND creator_id=?",
            (user["id"], creator_id))
        if existing:
            conn.execute("DELETE FROM saved_creators WHERE brand_id=? AND creator_id=?",
                         (user["id"], creator_id))
            conn.commit()
            return {"saved": False}
        else:
            conn.execute("INSERT INTO saved_creators (brand_id, creator_id) VALUES (?,?)",
                         (user["id"], creator_id))
            conn.commit()
            return {"saved": True}


@app.get("/api/saved-creators/ids")
def get_saved_creator_ids(user: dict = Depends(current_user)):
    """Return list of saved creator user_ids for the current brand."""
    if user["role"] != "brand":
        return []
    with get_conn() as conn:
        rows = _rows(conn,
            "SELECT creator_id FROM saved_creators WHERE brand_id=?",
            (user["id"],))
    return [r["creator_id"] for r in rows]


@app.get("/api/saved-creators")
def get_saved_creators(user: dict = Depends(current_user)):
    """Return full creator profiles for all saved creators (same shape as /api/creators)."""
    if user["role"] != "brand":
        return []
    with get_conn() as conn:
        rows = _rows(conn, """
            SELECT cp.*, u.email
            FROM saved_creators sc
            JOIN creator_profiles cp ON cp.user_id = sc.creator_id
            JOIN users u             ON u.id        = sc.creator_id
            WHERE sc.brand_id = ?
            ORDER BY sc.created_at DESC
        """, (user["id"],))
    results = []
    for r in rows:
        r["skills"]         = json.loads(r.get("skills") or "[]")
        r["social_handles"] = json.loads(r.get("social_handles") or "{}")
        r["total_followers"] = (
            (r.get("followers_ig") or 0) +
            (r.get("followers_tt") or 0) +
            (r.get("followers_yt") or 0)
        )
        results.append(r)
    return results


# ---------------------------------------------------------------------------
# SignWell — contract signing
# ---------------------------------------------------------------------------
import signwell as sw

@app.post("/api/contracts/send", status_code=201)
async def send_contract(payload: dict, user: dict = Depends(current_user)):
    """
    Create and send a signature request via SignWell.

    Expected body:
    {
      "deal_id": 123,
      "name": "CourtCollab Deal #123",
      "subject": "Please sign your collaboration agreement",
      "message": "Hi — please review and sign below.",
      "signers": [{"name": "Jane", "email": "jane@example.com"}],
      "file_urls": ["https://...pdf"]          // optional
    }
    """
    try:
        doc = await sw.create_document(
            name=payload["name"],
            subject=payload.get("subject", "Please sign your agreement"),
            message=payload.get("message", "Please review and sign the attached agreement."),
            signers=payload["signers"],
            file_urls=payload.get("file_urls"),
        )
        # Persist document_id against the deal so we can look it up later
        deal_id = payload.get("deal_id")
        if deal_id:
            with get_conn() as conn:
                conn.execute(
                    "UPDATE deals SET contract_document_id = ?, contract_status = 'sent' WHERE id = ?",
                    (doc["id"], deal_id),
                )
        return {"document_id": doc["id"], "document": doc}
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.get("/api/contracts/{document_id}")
async def get_contract(document_id: str, user: dict = Depends(current_user)):
    """Return the current status of a SignWell document."""
    try:
        return await sw.get_document(document_id)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


@app.get("/api/contracts/{document_id}/signing-url/{recipient_id}")
async def get_signing_url(document_id: str, recipient_id: str, user: dict = Depends(current_user)):
    """Get an embedded signing URL for a specific recipient."""
    try:
        url = await sw.get_embedded_signing_url(document_id, recipient_id)
        return {"signing_url": url}
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


@app.get("/api/contracts/{document_id}/download")
async def download_contract(document_id: str, user: dict = Depends(current_user)):
    """Return the completed PDF download URL (only available once fully signed)."""
    try:
        pdf_url = await sw.get_completed_pdf_url(document_id)
        if not pdf_url:
            raise HTTPException(status_code=404, detail="Signed PDF not yet available")
        return {"pdf_url": pdf_url}
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


@app.delete("/api/contracts/{document_id}", status_code=200)
async def cancel_contract(document_id: str, user: dict = Depends(current_user)):
    """Cancel a pending signature request."""
    try:
        result = await sw.cancel_document(document_id)
        return result
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


async def _handle_signwell_event(event: dict) -> None:
    """
    Shared logic for processing a verified SignWell webhook event.

    Handles:
      document_signed    — marks brand_signed or creator_signed; triggers
                           contract_complete when both have signed
      document_completed — fallback for platforms that emit this instead
      document_declined  — marks contract declined
      document_expired   — marks contract expired
    """
    event_type  = (event.get("event") or {}).get("type") or event.get("type", "")
    doc         = event.get("document") or {}
    doc_id      = doc.get("id", "")
    signer      = event.get("signer") or {}        # present on document_signed
    signer_email= (signer.get("email") or "").lower().strip()
    signed_at   = signer.get("signed_at") or datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    if not doc_id:
        return

    # ── document_signed: one signer just signed ────────────────────────────
    if event_type == "document_signed":
        with get_conn() as conn:
            deal = _row(conn, """
                SELECT d.id, d.brand_signed, d.creator_signed,
                       ub.email AS brand_email,
                       uc.email AS creator_email,
                       ub.name  AS brand_name,
                       uc.name  AS creator_name
                FROM deals d
                JOIN users ub ON ub.id = d.brand_id
                JOIN users uc ON uc.id = d.creator_id
                WHERE d.contract_document_id = ?
            """, (doc_id,))

            if not deal:
                return

            brand_email   = (deal["brand_email"]   or "").lower().strip()
            creator_email = (deal["creator_email"] or "").lower().strip()
            deal_id       = deal["id"]

            # Identify which party signed by matching email
            if signer_email == brand_email:
                conn.execute(
                    """UPDATE deals SET brand_signed = 1, brand_signed_at = ?,
                       contract_status = 'brand_signed', updated_at = datetime('now')
                       WHERE id = ?""",
                    (signed_at, deal_id),
                )
                logging.info("[WEBHOOK] Brand signed deal #%s at %s", deal_id, signed_at)

            elif signer_email == creator_email:
                conn.execute(
                    """UPDATE deals SET creator_signed = 1, creator_signed_at = ?,
                       contract_status = 'creator_signed', updated_at = datetime('now')
                       WHERE id = ?""",
                    (signed_at, deal_id),
                )
                logging.info("[WEBHOOK] Creator signed deal #%s at %s", deal_id, signed_at)
            else:
                logging.warning(
                    "[WEBHOOK] Unrecognised signer email %s for deal #%s",
                    signer_email, deal_id,
                )

            conn.commit()

            # Re-fetch to check if both have now signed
            deal = _row(conn, "SELECT * FROM deals WHERE id = ?", (deal_id,))

        # Both signed → contract_complete
        if deal and deal["brand_signed"] and deal["creator_signed"]:
            # Try to fetch the completed PDF URL from SignWell
            completed_url = ""
            try:
                completed_url = await sw.get_completed_pdf_url(doc_id) or ""
            except Exception:
                pass

            with get_conn() as conn:
                conn.execute(
                    """UPDATE deals
                       SET contract_status        = 'contract_complete',
                           contract_completed_url = ?,
                           updated_at             = datetime('now')
                       WHERE id = ?""",
                    (completed_url, deal_id),
                )
                conn.commit()

            logging.info("[WEBHOOK] Deal #%s contract_complete — both parties signed", deal_id)

            # Send confirmation email to both parties via Zoho SMTP
            brand_name   = deal.get("brand_name",   "Brand")
            creator_name = deal.get("creator_name", "Creator")
            brand_email_addr   = (deal.get("brand_email")   or "").strip()
            creator_email_addr = (deal.get("creator_email") or "").strip()

            subject = "Your CourtCollab contract is fully signed — payment is now unlocked"
            body_template = (
                "Hi {name},\n\n"
                "Great news! Your brand deal agreement on CourtCollab has been signed by both parties "
                "and the contract is now fully executed.\n\n"
                "  Deal ID         : #{deal_id}\n"
                "  Brand           : {brand}\n"
                "  Creator         : {creator}\n"
                "  Contract Status : Fully Signed\n"
                "{pdf_line}"
                "\n"
                "What happens next:\n"
                "  • Creator — you can now begin work on the agreed deliverables.\n"
                "  • Brand — payment is unlocked and will be held in escrow by CourtCollab "
                "until you confirm delivery of all content.\n"
                "  • Once the brand confirms delivery, the creator receives 85% of the deal "
                "amount within 7 days.\n\n"
                "Log in to CourtCollab at any time to track progress: https://courtcollab.com\n\n"
                "— The CourtCollab Team\n"
                "courtcollab.com\n"
            )
            pdf_line = (
                f"  Signed PDF      : {completed_url}\n" if completed_url else ""
            )

            recipients = [r for r in [brand_email_addr, creator_email_addr] if r]
            if recipients:
                for addr, name in [(brand_email_addr, brand_name), (creator_email_addr, creator_name)]:
                    if not addr:
                        continue
                    _send_zoho_email(
                        to_emails=[addr],
                        subject=subject,
                        body=body_template.format(
                            name=name,
                            deal_id=deal_id,
                            brand=brand_name,
                            creator=creator_name,
                            pdf_line=pdf_line,
                        ),
                    )

    # ── document_completed: all signers done (fallback event) ──────────────
    elif event_type == "document_completed":
        completed_url = ""
        try:
            recipients_list = doc.get("recipients") or []
            for r in recipients_list:
                pass  # SignWell may embed the URL in the doc
            completed_url = doc.get("completed_pdf_url") or await sw.get_completed_pdf_url(doc_id) or ""
        except Exception:
            pass

        with get_conn() as conn:
            conn.execute(
                """UPDATE deals
                   SET brand_signed = 1, creator_signed = 1,
                       contract_status        = 'contract_complete',
                       contract_completed_url = ?,
                       updated_at             = datetime('now')
                   WHERE contract_document_id = ?""",
                (completed_url, doc_id),
            )
            conn.commit()

    # ── document_declined / document_expired ───────────────────────────────
    elif event_type in ("document_declined", "document_expired"):
        new_status = event_type.replace("document_", "")
        with get_conn() as conn:
            conn.execute(
                """UPDATE deals SET contract_status = ?, updated_at = datetime('now')
                   WHERE contract_document_id = ?""",
                (new_status, doc_id),
            )
            conn.commit()


@app.post("/webhooks/signwell", include_in_schema=False)
async def signwell_webhook_v2(request: Request):
    """
    Primary SignWell webhook receiver — POST /webhooks/signwell

    Configure this URL in your SignWell dashboard under Settings → Webhooks.
    Set SIGNWELL_WEBHOOK_SECRET on Railway to the secret shown in the dashboard.

    Handles events:
      document_signed    — per-signer tracking; triggers contract_complete + emails
      document_completed — fallback for fully-signed documents
      document_declined  — marks contract declined
      document_expired   — marks contract expired
    """
    raw_body = await request.body()

    # ── Signature verification ─────────────────────────────────────────────
    sig_header = request.headers.get("X-SignWell-Signature", "")
    if not _verify_signwell_signature(raw_body, sig_header):
        logging.warning("[WEBHOOK] Invalid SignWell signature — rejecting request")
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    try:
        event = json.loads(raw_body)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    await _handle_signwell_event(event)
    return {"received": True}


@app.post("/api/signwell/webhook", include_in_schema=False)
async def signwell_webhook_legacy(request: Request):
    """
    Legacy webhook path — kept for backward compatibility.
    New installs should use POST /webhooks/signwell.
    """
    raw_body = await request.body()

    sig_header = request.headers.get("X-SignWell-Signature", "")
    if not _verify_signwell_signature(raw_body, sig_header):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    try:
        event = json.loads(raw_body)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    await _handle_signwell_event(event)
    return {"received": True}


@app.get("/api/contracts/templates")
async def list_contract_templates(user: dict = Depends(current_user)):
    """List all available SignWell document templates."""
    try:
        return await sw.list_templates()
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


# ---------------------------------------------------------------------------
# SignWell Webhook Registration (admin only)
# ---------------------------------------------------------------------------

@app.post("/api/admin/signwell/webhooks/register", status_code=201)
async def register_signwell_webhook(payload: dict, user: dict = Depends(require_admin)):
    """
    Register the CourtCollab webhook URL with SignWell via their API.

    Call this ONCE after deploying to Railway — there is no webhook UI in the
    SignWell dashboard, so this API call is how the URL gets registered.

    Body (all optional):
      {
        "url": "https://your-app.railway.app/webhooks/signwell",  // auto-built from HOST if omitted
        "events": ["document_signed", "document_completed", ...]  // defaults to all 4
      }

    Returns the created webhook object from SignWell, including its `id`
    and `secret`. Store the `secret` as SIGNWELL_WEBHOOK_SECRET on Railway.
    """
    webhook_url = (payload.get("url") or "").strip()
    if not webhook_url:
        # Auto-build from the Railway PUBLIC_URL / HOST env var
        host = (
            os.environ.get("RAILWAY_PUBLIC_DOMAIN")
            or os.environ.get("PUBLIC_URL")
            or os.environ.get("HOST", "")
        ).rstrip("/")
        if not host:
            raise HTTPException(
                400,
                "Provide 'url' in the request body, or set RAILWAY_PUBLIC_DOMAIN on Railway.",
            )
        webhook_url = f"https://{host}/webhooks/signwell"

    events = payload.get("events") or [
        "document_signed",
        "document_completed",
        "document_declined",
        "document_expired",
    ]

    try:
        result = await sw.register_webhook(url=webhook_url, events=events)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    webhook_id     = (result.get("api_webhook") or result).get("id", "")
    webhook_secret = (result.get("api_webhook") or result).get("secret", "")

    return {
        "registered_url": webhook_url,
        "webhook_id":     webhook_id,
        "secret":         webhook_secret,
        "next_step": (
            f"Set SIGNWELL_WEBHOOK_SECRET={webhook_secret!r} "
            "as an environment variable on Railway, then redeploy."
        ) if webhook_secret else "Webhook registered. Check SignWell for the secret.",
        "raw": result,
    }


@app.get("/api/admin/signwell/webhooks")
async def list_signwell_webhooks(user: dict = Depends(require_admin)):
    """List all webhooks currently registered with SignWell (admin only)."""
    try:
        return await sw.list_webhooks()
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


@app.delete("/api/admin/signwell/webhooks/{webhook_id}")
async def delete_signwell_webhook(webhook_id: str, user: dict = Depends(require_admin)):
    """Delete a registered SignWell webhook by ID (admin only)."""
    try:
        return await sw.delete_webhook(webhook_id)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


@app.get("/api/deals/{deal_id}/summary")
async def get_deal_summary(deal_id: int, request: Request, user: dict = Depends(current_user)):
    """
    Return enriched deal data for the terms confirmation screen.
    Includes both parties' names, all deal terms, and confirmation status.
    """
    with get_conn() as conn:
        deal = _row(conn, """
            SELECT d.*,
                   c.title       AS campaign_title,
                   c.niche       AS campaign_niche,
                   ub.name       AS brand_name,
                   ub.email      AS brand_email,
                   uc.name       AS creator_name,
                   uc.email      AS creator_email,
                   bp.company_name   AS brand_company,
                   ub.name           AS brand_contact,
                   cp.social_handles AS creator_social_handles
            FROM deals d
            JOIN campaigns c    ON c.id  = d.campaign_id
            JOIN users ub       ON ub.id = d.brand_id
            JOIN users uc       ON uc.id = d.creator_id
            LEFT JOIN brand_profiles   bp ON bp.user_id = d.brand_id
            LEFT JOIN creator_profiles cp ON cp.user_id = d.creator_id
            WHERE d.id = ?
        """, (deal_id,))

    if not deal:
        raise HTTPException(404, "Deal not found")
    if user["id"] not in (deal["brand_id"], deal["creator_id"]):
        raise HTTPException(403, "Not your deal")

    # Parse social handles for platform list
    social_handles_raw = deal.get("creator_social_handles") or "{}"
    try:
        social_handles = json.loads(social_handles_raw) if isinstance(social_handles_raw, str) else (social_handles_raw or {})
    except Exception:
        social_handles = {}

    # Build platform string from which handles are filled in
    platforms = [p.capitalize() for p, h in social_handles.items() if h and str(h).strip()]
    if not platforms:
        platforms = [deal.get("campaign_niche") or "Social Media"]

    amount = int(deal.get("amount") or 0)
    creator_payout = round(amount * 0.85)
    platform_fee   = amount - creator_payout

    role = "brand" if user["id"] == deal["brand_id"] else "creator"

    return {
        "deal_id":           deal_id,
        "campaign_title":    deal.get("campaign_title") or f"Deal #{deal_id}",
        "creator_name":      deal.get("creator_name") or "",
        "creator_handles":   social_handles,
        "brand_company":     deal.get("brand_company") or deal.get("brand_name") or "",
        "brand_contact":     deal.get("brand_contact") or deal.get("brand_name") or "",
        "deliverables":      deal.get("terms") or "As mutually agreed upon by both parties",
        "num_posts":         deal.get("num_posts") or 1,
        "deadline":          deal.get("deadline") or "",
        "platforms":         platforms,
        "usage_rights":      deal.get("usage_rights_duration") or "1 year",
        "exclusivity":       deal.get("exclusivity_terms") or "None",
        "amount":            amount,
        "creator_payout":    creator_payout,
        "platform_fee":      platform_fee,
        "my_role":           role,
        "brand_confirmed":   bool(deal.get("brand_terms_confirmed")),
        "creator_confirmed": bool(deal.get("creator_terms_confirmed")),
        "my_confirmed":      bool(deal.get("brand_terms_confirmed") if role == "brand" else deal.get("creator_terms_confirmed")),
    }


@app.post("/api/deals/{deal_id}/confirm-terms", status_code=200)
async def confirm_deal_terms(deal_id: int, request: Request, user: dict = Depends(current_user)):
    """
    Log that the current user has reviewed and confirmed the deal terms.
    When both parties have confirmed, automatically triggers contract generation.
    """
    client_ip = request.client.host if request.client else "unknown"

    with get_conn() as conn:
        deal = _row(conn,
            """SELECT d.*, ub.name AS brand_name, ub.email AS brand_email,
                      uc.name AS creator_name, uc.email AS creator_email
               FROM deals d
               JOIN users ub ON ub.id = d.brand_id
               JOIN users uc ON uc.id = d.creator_id
               WHERE d.id = ?""",
            (deal_id,))

    if not deal:
        raise HTTPException(404, "Deal not found")
    if user["id"] not in (deal["brand_id"], deal["creator_id"]):
        raise HTTPException(403, "Not your deal")
    if deal["status"] != "active":
        raise HTTPException(409, "Deal must be active to confirm terms")
    if deal.get("contract_status") not in (None, "", "none"):
        raise HTTPException(409, "Contract has already been generated for this deal")

    role = "brand" if user["id"] == deal["brand_id"] else "creator"

    # Check if already confirmed
    already_confirmed = bool(
        deal.get("brand_terms_confirmed") if role == "brand"
        else deal.get("creator_terms_confirmed")
    )
    if already_confirmed:
        # Idempotent — return current state
        return {
            "ok": True,
            "my_role": role,
            "brand_confirmed": bool(deal.get("brand_terms_confirmed")),
            "creator_confirmed": bool(deal.get("creator_terms_confirmed")),
            "both_confirmed": bool(deal.get("brand_terms_confirmed")) and bool(deal.get("creator_terms_confirmed")),
        }

    # Insert confirmation record (ignore duplicate)
    now_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO deal_confirmations (deal_id, user_id, role, confirmed_at, ip_address)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (deal_id, user_id) DO NOTHING""",
            (deal_id, user["id"], role, now_ts, client_ip),
        )
        # Update convenience column on deals
        col = "brand_terms_confirmed" if role == "brand" else "creator_terms_confirmed"
        conn.execute(
            f"UPDATE deals SET {col} = 1, updated_at = datetime('now') WHERE id = ?",
            (deal_id,),
        )
        conn.commit()

    # Re-fetch to get updated confirmation state
    with get_conn() as conn:
        updated = _row(conn,
            "SELECT brand_terms_confirmed, creator_terms_confirmed FROM deals WHERE id = ?",
            (deal_id,))

    brand_confirmed   = bool(updated.get("brand_terms_confirmed"))
    creator_confirmed = bool(updated.get("creator_terms_confirmed"))
    both_confirmed    = brand_confirmed and creator_confirmed

    logging.info(
        "Deal #%s terms confirmed by %s (%s) from %s — both_confirmed=%s",
        deal_id, user["id"], role, client_ip, both_confirmed,
    )

    # If both parties have confirmed, trigger contract generation
    if both_confirmed:
        import asyncio as _asyncio
        _asyncio.create_task(_trigger_contract_for_deal(deal_id))
        logging.info("Deal #%s — both confirmed, contract generation triggered", deal_id)

    return {
        "ok": True,
        "my_role": role,
        "brand_confirmed": brand_confirmed,
        "creator_confirmed": creator_confirmed,
        "both_confirmed": both_confirmed,
    }


@app.get("/api/deals/{deal_id}/contract-status")
async def get_deal_contract_status(deal_id: int, user: dict = Depends(current_user)):
    """
    Lightweight endpoint for the frontend contract-status poller.
    Returns only the contract fields needed to render the UI banner.
    """
    with get_conn() as conn:
        deal = _row(conn, """
            SELECT d.id, d.brand_id, d.creator_id,
                   d.contract_status, d.contract_document_id,
                   d.brand_signed, d.brand_signed_at,
                   d.creator_signed, d.creator_signed_at,
                   d.contract_completed_url,
                   ub.name AS brand_name,
                   uc.name AS creator_name
            FROM deals d
            JOIN users ub ON ub.id = d.brand_id
            JOIN users uc ON uc.id = d.creator_id
            WHERE d.id = ?
        """, (deal_id,))

    if not deal:
        raise HTTPException(404, "Deal not found")
    if user["id"] not in (deal["brand_id"], deal["creator_id"]):
        raise HTTPException(403, "Not your deal")

    # Tell the frontend which party the current user is
    role = "brand" if user["id"] == deal["brand_id"] else "creator"
    return {**dict(deal), "my_role": role}


@app.get("/api/contracts/signed")
def get_signed_contracts(user: dict = Depends(current_user)):
    """
    Return all fully-signed contracts where the current user is brand or creator.
    Includes the permanent Supabase Storage URL (signed_contract_url) and
    a fallback to contract_completed_url if storage upload wasn't available.
    """
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT d.id               AS deal_id,
                   d.amount,
                   d.contract_status,
                   d.contract_completed_url,
                   d.signed_contract_url,
                   d.brand_signed_at,
                   d.creator_signed_at,
                   c.title            AS campaign_title,
                   ub.name            AS brand_name,
                   ub.email           AS brand_email,
                   uc.name            AS creator_name,
                   uc.email           AS creator_email,
                   bp.company_name    AS brand_company
            FROM deals d
            JOIN campaigns c    ON c.id  = d.campaign_id
            JOIN users ub       ON ub.id = d.brand_id
            JOIN users uc       ON uc.id = d.creator_id
            LEFT JOIN brand_profiles bp ON bp.user_id = d.brand_id
            WHERE d.contract_status = 'contract_complete'
              AND (d.brand_id = ? OR d.creator_id = ?)
            ORDER BY d.updated_at DESC
        """, (user["id"], user["id"])).fetchall()

    results = []
    for r in rows:
        row = dict(r)
        # Prefer permanent Supabase URL; fall back to SignWell temporary URL
        row["download_url"] = row.get("signed_contract_url") or row.get("contract_completed_url") or ""
        # Determine the user's role in this deal
        row["my_role"] = "brand" if row.get("brand_email", "").lower() == (user.get("email") or "").lower() else "creator"
        results.append(row)

    return {"contracts": results}


@app.get("/api/deals/{deal_id}/my-signing-url")
async def get_my_signing_url(deal_id: int, user: dict = Depends(current_user)):
    """
    Return the embedded SignWell signing URL for the current user.
    Brand is always recipient "1"; creator is always recipient "2".
    """
    with get_conn() as conn:
        deal = _row(conn,
            "SELECT id, brand_id, creator_id, contract_document_id FROM deals WHERE id = ?",
            (deal_id,))

    if not deal:
        raise HTTPException(404, "Deal not found")
    if user["id"] not in (deal["brand_id"], deal["creator_id"]):
        raise HTTPException(403, "Not your deal")

    doc_id = deal.get("contract_document_id", "")
    if not doc_id:
        raise HTTPException(404, "No contract document found for this deal")

    # Brand = recipient "1", Creator = recipient "2" (matches create_deal_contract signing order)
    recipient_id = "1" if user["id"] == deal["brand_id"] else "2"

    try:
        url = await sw.get_embedded_signing_url(doc_id, recipient_id)
        if not url:
            raise HTTPException(404, "Signing URL not available — document may already be signed or expired")
        return {"signing_url": url, "recipient_id": recipient_id}
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


@app.post("/api/contracts/deals/{deal_id}/create", status_code=201)
async def create_deal_contract(deal_id: int, user: dict = Depends(current_user)):
    """
    Full contract creation pipeline for a deal:

    1. Fetch all deal terms from the database (deal + campaign + profiles).
    2. Populate the contract template with those terms.
    3. Generate a PDF of the contract.
    4. Create a SignWell document with the PDF attached.
    5. Add two signers — brand contact (signing_order=1) then creator (signing_order=2).
    6. send_in_order=True so brand must sign before creator receives the request.
    7. SignWell emails both parties automatically.
    8. Update deal: contract_status = 'contract_sent', contract_document_id = doc['id'].
    """
    # ── 1. Fetch deal + related rows ───────────────────────────────────────
    with get_conn() as conn:
        deal = _row(conn, """
            SELECT d.*,
                   c.title        AS campaign_title,
                   c.niche        AS campaign_niche,
                   c.description  AS campaign_description,
                   ub.name        AS brand_name,
                   ub.email       AS brand_email,
                   uc.name        AS creator_name,
                   uc.email       AS creator_email
            FROM deals d
            JOIN campaigns c ON c.id  = d.campaign_id
            JOIN users ub    ON ub.id = d.brand_id
            JOIN users uc    ON uc.id = d.creator_id
            WHERE d.id = ?
        """, (deal_id,))

        if not deal:
            raise HTTPException(404, "Deal not found")

        # Only brand or creator on this deal may trigger contract creation
        if user["id"] not in (deal["brand_id"], deal["creator_id"]):
            raise HTTPException(403, "Not your deal")

        campaign    = _row(conn, "SELECT * FROM campaigns    WHERE id = ?",      (deal["campaign_id"],))
        brand_prof  = _row(conn, "SELECT * FROM brand_profiles   WHERE user_id = ?", (deal["brand_id"],))
        creator_prof= _row(conn, "SELECT * FROM creator_profiles WHERE user_id = ?", (deal["creator_id"],))

    campaign     = campaign     or {}
    brand_prof   = brand_prof   or {}
    creator_prof = creator_prof or {}

    # ── 2 & 3. Populate template → generate PDF ─────────────────────────
    pdf_bytes  = _build_contract_pdf(deal, campaign, brand_prof, creator_prof)
    pdf_b64    = base64.b64encode(pdf_bytes).decode("ascii")
    doc_name   = f"CourtCollab Deal #{deal_id} — {brand_prof.get('company_name') or deal['brand_name']} × {deal['creator_name']}"

    # ── 4 & 5. Signers: brand first (order=1), creator second (order=2) ──
    signers = _get_contract_signers(deal, brand_prof)

    # ── 6 & 7. Create SignWell document; send_in_order enforces sequence ─
    try:
        sw_doc = await sw.create_document(
            name    = doc_name,
            subject = f"Please sign: {doc_name}",
            message = (
                f"Hi,\n\nPlease review and sign the brand deal agreement for "
                f"\"{deal.get('campaign_title', 'your campaign')}\" on CourtCollab.\n\n"
                f"Deal amount: ${deal.get('amount', 0):,}\n\n"
                f"— The CourtCollab Team"
            ),
            signers      = signers,
            file_base64  = [{"data": pdf_b64, "name": f"courtcollab_deal_{deal_id}.pdf"}],
            send_in_order= True,
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code,
                            detail=f"SignWell error: {e.response.text}")
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    # ── 8. Persist document ID and update contract status ────────────────
    sw_doc_id = sw_doc.get("id", "")
    with get_conn() as conn:
        conn.execute(
            """UPDATE deals
               SET contract_document_id = ?,
                   contract_status      = 'contract_sent',
                   contract_sent_at     = datetime('now'),
                   updated_at           = datetime('now')
               WHERE id = ?""",
            (sw_doc_id, deal_id),
        )
        conn.commit()

    return {
        "document_id":     sw_doc_id,
        "contract_status": "contract_sent",
        "signers":         signers,
        "document":        sw_doc,
    }


# ---------------------------------------------------------------------------
# Run directly
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
