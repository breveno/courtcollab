"""
CourtCollab API
---------------
POST /api/signup   — create account, return JWT
POST /api/login    — verify credentials, return JWT
GET  /api/me       — validate JWT, return current user
"""

import os
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr

from database import get_conn, init_db

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SECRET_KEY = os.environ.get("JWT_SECRET", "change-me-in-production-use-a-long-random-string")
ALGORITHM  = "HS256"
TOKEN_TTL_HOURS = 72          # token valid for 3 days

pwd_ctx    = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer     = HTTPBearer()

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="CourtCollab API", version="1.0.0")

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
# Schemas
# ---------------------------------------------------------------------------

class SignupRequest(BaseModel):
    name:     str
    email:    EmailStr
    password: str
    role:     str          # "creator" | "brand"

class LoginRequest(BaseModel):
    email:    EmailStr
    password: str

class UserOut(BaseModel):
    id:       int
    name:     str
    email:    str
    role:     str
    initials: str

class AuthResponse(BaseModel):
    token: str
    user:  UserOut

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_initials(name: str) -> str:
    parts = name.strip().split()
    return "".join(p[0].upper() for p in parts if p)[:2]

def hash_password(plain: str) -> str:
    return pwd_ctx.hash(plain)

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_ctx.verify(plain, hashed)

def create_token(user_id: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(hours=TOKEN_TTL_HOURS)
    return jwt.encode({"sub": str(user_id), "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)

def decode_token(token: str) -> int:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return int(payload["sub"])
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

def get_user_by_id(user_id: int) -> Optional[dict]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None

def current_user(creds: HTTPAuthorizationCredentials = Depends(bearer)) -> dict:
    user_id = decode_token(creds.credentials)
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/api/signup", response_model=AuthResponse, status_code=201)
def signup(body: SignupRequest):
    if body.role not in ("creator", "brand"):
        raise HTTPException(status_code=400, detail="role must be 'creator' or 'brand'")
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    initials = make_initials(body.name)
    try:
        with get_conn() as conn:
            cursor = conn.execute(
                "INSERT INTO users (name, email, password, role, initials) VALUES (?,?,?,?,?)",
                (body.name.strip(), body.email.lower(), hash_password(body.password), body.role, initials)
            )
            conn.commit()
            user_id = cursor.lastrowid
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="An account with that email already exists")

    user = get_user_by_id(user_id)
    return {"token": create_token(user_id), "user": UserOut(**user)}


@app.post("/api/login", response_model=AuthResponse)
def login(body: LoginRequest):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (body.email.lower(),)).fetchone()

    if not row or not verify_password(body.password, row["password"]):
        raise HTTPException(status_code=401, detail="Incorrect email or password")

    user = dict(row)
    return {"token": create_token(user["id"]), "user": UserOut(**user)}


@app.get("/api/me", response_model=UserOut)
def me(user: dict = Depends(current_user)):
    return UserOut(**user)


# ---------------------------------------------------------------------------
# Run directly: python main.py
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
