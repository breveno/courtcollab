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
"""

import json
import logging
import os
import smtplib
import sqlite3
from email.mime.text import MIMEText
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr

from database import get_conn, init_db

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SECRET_KEY     = os.environ.get("JWT_SECRET", "change-me-in-production-use-a-long-random-string")
ALGORITHM      = "HS256"
TOKEN_TTL_HRS  = 72
PLATFORM_FEE   = 0.15          # 15 % taken by CourtCollab

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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://127.0.0.1:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup():
    init_db()


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
            if isinstance(data, dict) and data.get("type") == "ping":
                await ws.send_json({"type": "pong"})
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

def _make_token(user_id: int) -> str:
    exp = datetime.now(timezone.utc) + timedelta(hours=TOKEN_TTL_HRS)
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
    Send notification email to `to_email` and BCC platform admins.

    Requires SMTP_HOST to be set; silently skips in dev if not configured.
    Admin BCC list: ADMIN_EMAILS (ben@courtcollab.com, julia@courtcollab.com).
    """
    host = os.environ.get("SMTP_HOST")
    if not host:
        logging.debug("SMTP not configured — skipping email to %s (%s)", to_email, subject)
        return

    # Deduplicate: if the recipient IS an admin, don't double-deliver
    all_recipients = list({to_email} | set(ADMIN_EMAILS))

    try:
        msg             = MIMEText(body, "plain")
        msg["Subject"]  = subject
        msg["From"]     = FROM_EMAIL
        msg["To"]       = to_email

        # Admins receive as BCC so the primary recipient doesn't see them
        bcc_list = [a for a in ADMIN_EMAILS if a != to_email]
        if bcc_list:
            msg["Bcc"] = ", ".join(bcc_list)

        port = int(os.environ.get("SMTP_PORT", 587))
        user = os.environ.get("SMTP_USER", "")
        pw   = os.environ.get("SMTP_PASS", "")
        with smtplib.SMTP(host, port) as s:
            s.starttls()
            if user:
                s.login(user, pw)
            s.sendmail(FROM_EMAIL, all_recipients, msg.as_string())

        logging.info("Email sent to %s (BCC: %s) — %s", to_email, bcc_list, subject)
    except Exception as exc:
        logging.warning("Email delivery failed for %s: %s", to_email, exc)


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

class SignupIn(BaseModel):
    name:     str
    email:    EmailStr
    password: str
    role:     str

class LoginIn(BaseModel):
    email:    EmailStr
    password: str

class UserOut(BaseModel):
    id:       int
    name:     str
    email:    str
    role:     str
    initials: str

class AuthOut(BaseModel):
    token: str
    user:  UserOut

# ---------------------------------------------------------------------------
# Routes — Auth
# ---------------------------------------------------------------------------

@app.post("/api/signup", response_model=AuthOut, status_code=201)
def signup(body: SignupIn):
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
    except sqlite3.IntegrityError:
        raise HTTPException(409, "An account with that email already exists")
    with get_conn() as conn:
        user = _row(conn, "SELECT * FROM users WHERE id = ?", (uid,))
    return {"token": _make_token(uid), "user": UserOut(**user)}


@app.post("/api/login", response_model=AuthOut)
def login(body: LoginIn):
    with get_conn() as conn:
        user = _row(conn, "SELECT * FROM users WHERE email = ?", (body.email.lower(),))
    if not user or not _verify(body.password, user["password"]):
        raise HTTPException(401, "Incorrect email or password")
    return {"token": _make_token(user["id"]), "user": UserOut(**user)}


@app.get("/api/me", response_model=UserOut)
def me(user: dict = Depends(current_user)):
    return UserOut(**user)

# ---------------------------------------------------------------------------
# Schemas — Creator Profile
# ---------------------------------------------------------------------------

class CreatorProfileIn(BaseModel):
    name:            Optional[str] = None
    niche:           Optional[str] = None
    bio:             Optional[str] = None
    location:        Optional[str] = None
    skill_level:     Optional[str] = None
    followers_ig:    Optional[int] = 0
    followers_tt:    Optional[int] = 0
    followers_yt:    Optional[int] = 0
    engagement_rate: Optional[float] = 0
    avg_views:       Optional[int] = 0
    rate_ig:         Optional[int] = 0
    rate_tiktok:     Optional[int] = 0
    rate_yt:         Optional[int] = 0
    rate_ugc:        Optional[int] = 0
    rate_notes:      Optional[str] = None
    skills:          Optional[List[str]] = []
    social_handles:  Optional[dict] = {}
    demo_age:        Optional[str] = None
    demo_gender:     Optional[str] = None
    demo_locations:  Optional[str] = None
    demo_interests:  Optional[str] = None

# ---------------------------------------------------------------------------
# Routes — Creator Profiles
# ---------------------------------------------------------------------------

@app.put("/api/creator/profile", status_code=200)
def upsert_creator_profile(body: CreatorProfileIn, user: dict = Depends(current_user)):
    require_role("creator", user)
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO creator_profiles
              (user_id, name, niche, bio, location, skill_level,
               followers_ig, followers_tt, followers_yt, engagement_rate, avg_views,
               rate_ig, rate_tiktok, rate_yt, rate_ugc, rate_notes,
               skills, social_handles,
               demo_age, demo_gender, demo_locations, demo_interests, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
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
              updated_at=datetime('now')
        """, (
            user["id"], body.name, body.niche, body.bio, body.location, body.skill_level,
            body.followers_ig, body.followers_tt, body.followers_yt,
            body.engagement_rate, body.avg_views,
            body.rate_ig, body.rate_tiktok, body.rate_yt, body.rate_ugc, body.rate_notes,
            json.dumps(body.skills), json.dumps(body.social_handles),
            body.demo_age, body.demo_gender, body.demo_locations, body.demo_interests
        ))
        conn.commit()
    return {"ok": True}


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


@app.get("/api/creators")
def list_creators(
    niche:         Optional[str] = Query(None),
    skill:         Optional[str] = Query(None),
    min_followers: Optional[int] = Query(None),
    max_rate:      Optional[int] = Query(None),
    user:          dict          = Depends(current_user),
):
    with get_conn() as conn:
        rows = _rows(conn, """
            SELECT cp.*, u.email
            FROM creator_profiles cp
            JOIN users u ON u.id = cp.user_id
            WHERE 1=1
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
    return profile

# ---------------------------------------------------------------------------
# Schemas — Brand Profile
# ---------------------------------------------------------------------------

class BrandProfileIn(BaseModel):
    company_name: Optional[str] = None
    industry:     Optional[str] = None
    website:      Optional[str] = None
    budget_min:   Optional[int] = 0
    budget_max:   Optional[int] = 0
    description:  Optional[str] = None

# ---------------------------------------------------------------------------
# Routes — Brand Profiles
# ---------------------------------------------------------------------------

@app.put("/api/brand/profile", status_code=200)
def upsert_brand_profile(body: BrandProfileIn, user: dict = Depends(current_user)):
    require_role("brand", user)
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO brand_profiles
              (user_id, company_name, industry, website, budget_min, budget_max, description, updated_at)
            VALUES (?,?,?,?,?,?,?,datetime('now'))
            ON CONFLICT(user_id) DO UPDATE SET
              company_name=excluded.company_name, industry=excluded.industry,
              website=excluded.website, budget_min=excluded.budget_min,
              budget_max=excluded.budget_max, description=excluded.description,
              updated_at=datetime('now')
        """, (user["id"], body.company_name, body.industry, body.website,
              body.budget_min, body.budget_max, body.description))
        conn.commit()
    return {"ok": True}


@app.get("/api/brand/profile")
def get_own_brand_profile(user: dict = Depends(current_user)):
    require_role("brand", user)
    with get_conn() as conn:
        profile = _row(conn, "SELECT * FROM brand_profiles WHERE user_id = ?", (user["id"],))
    if not profile:
        raise HTTPException(404, "Profile not set up yet")
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

class CampaignIn(BaseModel):
    title:         str
    description:   Optional[str]       = None
    budget:        Optional[int]        = 0
    niche:         Optional[str]        = None
    skills:        Optional[List[str]]  = []
    target_age:    Optional[str]        = None   # e.g. "25-34"
    min_followers: Optional[int]        = 0
    max_rate:      Optional[int]        = 0      # max $/post brand will pay

class CampaignUpdateIn(BaseModel):
    title:         Optional[str]       = None
    description:   Optional[str]       = None
    budget:        Optional[int]       = None
    niche:         Optional[str]       = None
    skills:        Optional[List[str]] = None
    target_age:    Optional[str]       = None
    min_followers: Optional[int]       = None
    max_rate:      Optional[int]       = None

class CampaignStatusIn(BaseModel):
    status: str

# ---------------------------------------------------------------------------
# Routes — Campaigns
# ---------------------------------------------------------------------------

@app.post("/api/campaigns", status_code=201)
def create_campaign(body: CampaignIn, user: dict = Depends(current_user)):
    require_role("brand", user)
    with get_conn() as conn:
        cur = conn.execute("""
            INSERT INTO campaigns
              (brand_id, title, description, budget, niche, skills,
               target_age, min_followers, max_rate)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, (user["id"], body.title, body.description, body.budget,
              body.niche, json.dumps(body.skills),
              body.target_age, body.min_followers, body.max_rate))
        conn.commit()
        cid = cur.lastrowid
    with get_conn() as conn:
        row = _row(conn, "SELECT * FROM campaigns WHERE id = ?", (cid,))
        row["skills"] = json.loads(row.get("skills") or "[]")
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
            SELECT c.*, u.name AS brand_name, bp.company_name
            FROM campaigns c
            JOIN users u ON u.id = c.brand_id
            LEFT JOIN brand_profiles bp ON bp.user_id = c.brand_id
        """)
    results = []
    for r in rows:
        r["skills"] = json.loads(r.get("skills") or "[]")
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
    row["skills"] = json.loads(row.get("skills") or "[]")
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

        if not updates:
            raise HTTPException(400, "No fields to update")

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        conn.execute(
            f"UPDATE campaigns SET {set_clause} WHERE id = ?",
            (*updates.values(), campaign_id)
        )
        conn.commit()
        updated = _row(conn, "SELECT * FROM campaigns WHERE id = ?", (campaign_id,))
        updated["skills"] = json.loads(updated.get("skills") or "[]")
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
    campaign_id: int
    creator_id:  int
    amount:      int
    terms:       Optional[str] = None

class DealStatusIn(BaseModel):
    status: str

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
async def create_deal(body: DealIn, user: dict = Depends(current_user)):
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
    return deal


@app.get("/api/deals")
def list_deals(
    deal_status: Optional[str] = Query(None, alias="status"),
    user: dict = Depends(current_user),
):
    field = "brand_id" if user["role"] == "brand" else "creator_id"
    with get_conn() as conn:
        rows = _rows(conn, f"""
            SELECT d.*,
                   c.title        AS campaign_title,
                   c.niche        AS campaign_niche,
                   ub.name        AS brand_name,
                   uc.name        AS creator_name,
                   uc.initials    AS creator_initials
            FROM deals d
            JOIN campaigns c ON c.id  = d.campaign_id
            JOIN users ub    ON ub.id = d.brand_id
            JOIN users uc    ON uc.id = d.creator_id
            WHERE d.{field} = ?
            ORDER BY d.updated_at DESC
        """, (user["id"],))
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

    # Notify the other party
    if body.status == "active":
        # Creator accepted → notify brand
        await _notify(
            user_id    = deal["brand_id"],
            notif_type = "deal_active",
            title      = f"{deal['creator_name']} accepted your deal",
            body       = (f"Your ${deal['amount']:,} deal for \"{deal['campaign_title']}\" "
                          f"is now active. Payment can be released once content is delivered."),
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

# ---------------------------------------------------------------------------
# Schemas — Messages
# ---------------------------------------------------------------------------

class MessageIn(BaseModel):
    receiver_id: int
    body:        str
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

            unread = conn.execute("""
                SELECT COUNT(*) FROM messages
                WHERE sender_id = ? AND receiver_id = ? AND read_at IS NULL
            """, (pid, uid)).fetchone()[0]

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
async def send_message(body: MessageIn, user: dict = Depends(current_user)):
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
    """Brand marks content delivered — releases funds to creator."""
    require_role("brand", user)
    with get_conn() as conn:
        payment = _row(conn,
            "SELECT * FROM payments WHERE id = ? AND brand_id = ? AND status = 'held'",
            (payment_id, user["id"]))
        if not payment:
            raise HTTPException(404, "Held payment not found or not yours")

        conn.execute("""
            UPDATE payments
            SET status = 'released', released_at = datetime('now')
            WHERE id = ?
        """, (payment_id,))
        # Mark deal complete
        conn.execute(
            "UPDATE deals SET status = 'completed', updated_at = datetime('now') WHERE id = ?",
            (payment["deal_id"],)
        )
        conn.commit()
    return {"ok": True, "creator_payout": payment["creator_payout"]}


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
        count = conn.execute(
            "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL",
            (user["id"],),
        ).fetchone()[0]
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
# Run directly
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
