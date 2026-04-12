"""
database.py — dual-mode database layer
  • DATABASE_URL set  → PostgreSQL via psycopg2 (Supabase in production)
  • DATABASE_URL unset → SQLite (local dev fallback)

The compat wrapper makes psycopg2 behave like sqlite3 so main.py is unchanged:
  - ? placeholders  → %s
  - datetime('now') → NOW()
  - INSERT          → INSERT … RETURNING id (powers cursor.lastrowid)
  - rows            → plain dicts (same as sqlite3.Row)
  - PRAGMA …        → silently ignored
"""

import os
import re

DATABASE_URL = os.environ.get("DATABASE_URL", "")
_USE_PG = bool(DATABASE_URL)

# Startup diagnostic — always visible in Railway deploy logs
print(f"[DB] Mode: {'PostgreSQL/Supabase' if _USE_PG else 'SQLite (local)'}")
print(f"[DB] DATABASE_URL set: {bool(DATABASE_URL)}")

# ---------------------------------------------------------------------------
# SQLite path (local dev)
# ---------------------------------------------------------------------------
if not _USE_PG:
    import sqlite3
    DB_PATH = os.path.join(os.path.dirname(__file__), "courtcollab.db")

    def get_conn():
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

# ---------------------------------------------------------------------------
# PostgreSQL compat wrapper
# ---------------------------------------------------------------------------
else:
    import psycopg2
    import psycopg2.extras

    # Regexes compiled once
    _RE_PLACEHOLDER  = re.compile(r"\?")
    _RE_DATETIME_NOW = re.compile(r"datetime\('now'\)", re.IGNORECASE)
    _RE_PRAGMA       = re.compile(r"^\s*PRAGMA\b", re.IGNORECASE)

    class _CompatCursor:
        def __init__(self, raw):
            self._raw       = raw
            self._lastrowid = None

        @property
        def lastrowid(self):
            return self._lastrowid

        def fetchone(self):
            row = self._raw.fetchone()
            return dict(row) if row else None

        def fetchall(self):
            return [dict(r) for r in self._raw.fetchall()]

        def __iter__(self):
            for row in self._raw:
                yield dict(row)

        # sqlite3 exposes .description on the cursor
        @property
        def description(self):
            return self._raw.description

    class _CompatConn:
        def __init__(self, pg_conn):
            self._conn = pg_conn

        def execute(self, sql: str, params=()):
            # Silently ignore SQLite PRAGMA statements
            if _RE_PRAGMA.match(sql):
                return _CompatCursor(_NoOpCursor())

            # Translate SQLite → PostgreSQL syntax
            sql = _RE_PLACEHOLDER.sub("%s", sql)
            sql = _RE_DATETIME_NOW.sub("NOW()", sql)

            # Auto-add RETURNING * to plain INSERTs so .lastrowid works.
            # Use RETURNING * (not RETURNING id) so tables whose PK is not
            # named "id" (e.g. creator_profiles.user_id) don't throw
            # "column id does not exist".
            stripped = sql.strip().upper()
            is_insert = stripped.startswith("INSERT") and "RETURNING" not in stripped
            if is_insert:
                sql = sql.rstrip().rstrip(";") + " RETURNING *"

            cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(sql, params if params else None)

            compat = _CompatCursor(cur)
            if is_insert:
                row = cur.fetchone()
                if row:
                    # Prefer "id" column; fall back to first column value
                    compat._lastrowid = row.get("id") or next(iter(row.values()), None)

            return compat

        def commit(self):
            self._conn.commit()

        def close(self):
            self._conn.close()

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_val, exc_tb):
            if exc_type:
                self._conn.rollback()
            else:
                self._conn.commit()
            self._conn.close()

    class _NoOpCursor:
        """Placeholder for PRAGMA no-ops."""
        def fetchone(self):   return None
        def fetchall(self):   return []
        def __iter__(self):   return iter([])
        description = None

    def get_conn():
        conn = psycopg2.connect(DATABASE_URL, connect_timeout=10)
        return _CompatConn(conn)


# ---------------------------------------------------------------------------
# Schema — PostgreSQL syntax when DATABASE_URL is set, SQLite otherwise
# ---------------------------------------------------------------------------

def init_db():
    if _USE_PG:
        _init_pg()
    else:
        _init_sqlite()


def _init_pg():
    """Create all tables in Supabase / PostgreSQL."""
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id         SERIAL PRIMARY KEY,
                email      TEXT   NOT NULL UNIQUE,
                password   TEXT   NOT NULL,
                role       TEXT   NOT NULL CHECK(role IN ('creator','brand')),
                name       TEXT   NOT NULL,
                initials   TEXT   NOT NULL,
                created_at          TEXT   NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
                reset_token         TEXT,
                reset_token_expires TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS creator_profiles (
                user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                name            TEXT,
                niche           TEXT,
                bio             TEXT,
                location        TEXT,
                skill_level     TEXT,
                followers_ig    INTEGER DEFAULT 0,
                followers_tt    INTEGER DEFAULT 0,
                followers_yt    INTEGER DEFAULT 0,
                engagement_rate REAL    DEFAULT 0,
                avg_views       INTEGER DEFAULT 0,
                rate_ig         INTEGER DEFAULT 0,
                rate_tiktok     INTEGER DEFAULT 0,
                rate_yt         INTEGER DEFAULT 0,
                rate_ugc        INTEGER DEFAULT 0,
                rate_notes      TEXT,
                skills          TEXT    DEFAULT '[]',
                social_handles  TEXT    DEFAULT '{}',
                demo_age        TEXT,
                demo_gender     TEXT,
                demo_locations  TEXT,
                demo_interests  TEXT,
                stripe_account_id  TEXT,
                stripe_onboarded   INTEGER DEFAULT 0,
                updated_at      TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS brand_profiles (
                user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                company_name TEXT,
                industry     TEXT,
                website      TEXT,
                budget_min   INTEGER DEFAULT 0,
                budget_max   INTEGER DEFAULT 0,
                description  TEXT,
                updated_at   TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS campaigns (
                id            SERIAL PRIMARY KEY,
                brand_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title         TEXT    NOT NULL,
                description   TEXT,
                budget        INTEGER DEFAULT 0,
                niche         TEXT,
                skills        TEXT    DEFAULT '[]',
                target_age    TEXT,
                min_followers INTEGER DEFAULT 0,
                max_rate      INTEGER DEFAULT 0,
                status        TEXT    NOT NULL DEFAULT 'open'
                                  CHECK(status IN ('open','paused','closed')),
                created_at    TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_campaigns_brand  ON campaigns(brand_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status)")
        conn.execute("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS questions TEXT DEFAULT '[]'")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS applications (
                id          SERIAL PRIMARY KEY,
                campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
                creator_id  INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
                answers     TEXT    NOT NULL DEFAULT '[]',
                message     TEXT,
                status      TEXT    NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('pending','accepted','declined')),
                created_at  TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
                UNIQUE(campaign_id, creator_id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_applications_campaign ON applications(campaign_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_applications_creator  ON applications(creator_id)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS matches (
                id             SERIAL PRIMARY KEY,
                campaign_id    INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
                creator_id     INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
                match_score    INTEGER NOT NULL DEFAULT 0,
                match_reasons  TEXT    DEFAULT '[]',
                created_at     TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
                UNIQUE(campaign_id, creator_id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_matches_campaign ON matches(campaign_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_matches_creator  ON matches(creator_id)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS deals (
                id          SERIAL PRIMARY KEY,
                campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
                creator_id  INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
                brand_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
                status      TEXT    NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('pending','active','declined','completed')),
                amount      INTEGER NOT NULL DEFAULT 0,
                terms       TEXT,
                created_at  TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
                updated_at  TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_deals_creator  ON deals(creator_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_deals_brand    ON deals(brand_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_deals_campaign ON deals(campaign_id)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id          SERIAL PRIMARY KEY,
                sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                body        TEXT    NOT NULL,
                deal_id     INTEGER REFERENCES deals(id) ON DELETE SET NULL,
                read_at     TEXT,
                created_at  TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_sender   ON messages(sender_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_deal     ON messages(deal_id)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS notifications (
                id         SERIAL PRIMARY KEY,
                user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                type       TEXT    NOT NULL,
                title      TEXT    NOT NULL,
                body       TEXT    NOT NULL,
                data       TEXT    DEFAULT '{}',
                read_at    TEXT,
                created_at TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notif_read ON notifications(user_id, read_at)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS payments (
                id                  SERIAL PRIMARY KEY,
                deal_id             INTEGER NOT NULL REFERENCES deals(id)  ON DELETE CASCADE,
                brand_id            INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
                creator_id          INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
                amount              INTEGER NOT NULL,
                platform_fee        INTEGER NOT NULL,
                creator_payout      INTEGER NOT NULL,
                stripe_payment_id   TEXT,
                checkout_session_id TEXT,
                stripe_transfer_id  TEXT,
                status              TEXT    NOT NULL DEFAULT 'pending'
                                        CHECK(status IN ('pending','held','released','refunded')),
                created_at          TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
                released_at         TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_deal    ON payments(deal_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_brand   ON payments(brand_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_creator ON payments(creator_id)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS ratings (
                id          SERIAL PRIMARY KEY,
                deal_id     INTEGER NOT NULL REFERENCES deals(id)  ON DELETE CASCADE,
                reviewer_id INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
                reviewee_id INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
                score       INTEGER NOT NULL CHECK(score >= 1 AND score <= 5),
                comment     TEXT,
                created_at  TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
                UNIQUE(deal_id, reviewer_id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ratings_reviewee ON ratings(reviewee_id)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS contracts (
                id                SERIAL PRIMARY KEY,
                deal_id           INTEGER NOT NULL UNIQUE REFERENCES deals(id) ON DELETE CASCADE,
                content           TEXT    NOT NULL,
                brand_signed_at   TEXT,
                creator_signed_at TEXT,
                brand_ip          TEXT,
                creator_ip        TEXT,
                created_at        TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_contracts_deal ON contracts(deal_id)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS disputes (
                id          SERIAL PRIMARY KEY,
                deal_id     INTEGER NOT NULL UNIQUE REFERENCES deals(id) ON DELETE CASCADE,
                filed_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                reason      TEXT    NOT NULL,
                status      TEXT    NOT NULL DEFAULT 'open'
                                CHECK(status IN ('open','resolved','closed')),
                resolution  TEXT,
                created_at  TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
                updated_at  TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_disputes_deal     ON disputes(deal_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_disputes_filed_by ON disputes(filed_by)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS dispute_comments (
                id          SERIAL PRIMARY KEY,
                dispute_id  INTEGER NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
                author_id   INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
                body        TEXT    NOT NULL,
                is_admin    INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dcomments_dispute ON dispute_comments(dispute_id)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS saved_creators (
                id          SERIAL PRIMARY KEY,
                brand_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                creator_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at  TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
                UNIQUE(brand_id, creator_id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_saved_brand ON saved_creators(brand_id)")

        # Migrations — add columns to existing tables if they don't exist yet
        # users
        conn.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token         TEXT")
        conn.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TEXT")
        conn.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS initials            TEXT NOT NULL DEFAULT ''")

        # creator_profiles — ensure every column exists regardless of when the table was first created
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS name            TEXT")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS niche           TEXT")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS bio             TEXT")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS location        TEXT")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS skill_level     TEXT")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS followers_ig    INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS followers_tt    INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS followers_yt    INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS engagement_rate REAL    DEFAULT 0")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS avg_views       INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS rate_ig         INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS rate_tiktok     INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS rate_yt         INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS rate_ugc        INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS rate_notes      TEXT")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS skills          TEXT DEFAULT '[]'")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS social_handles  TEXT DEFAULT '{}'")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS demo_age        TEXT")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS demo_gender     TEXT")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS demo_locations  TEXT")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS demo_interests  TEXT")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS stripe_account_id TEXT")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS stripe_onboarded  INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS birthday          TEXT")  # YYYY-MM-DD, private

        # campaigns
        conn.execute("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS niche         TEXT")
        conn.execute("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS skills        TEXT DEFAULT '[]'")
        conn.execute("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_age    TEXT")
        conn.execute("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS min_followers INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS max_rate      INTEGER DEFAULT 0")

        # deals — SignWell contract tracking
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS contract_document_id TEXT")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS contract_status      TEXT DEFAULT 'none'")

        conn.commit()


def _init_sqlite():
    """Original SQLite schema — used for local dev only."""
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                email        TEXT    NOT NULL UNIQUE,
                password     TEXT    NOT NULL,
                role         TEXT    NOT NULL CHECK(role IN ('creator','brand')),
                name         TEXT    NOT NULL,
                initials     TEXT    NOT NULL,
                created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS creator_profiles (
                user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                name            TEXT,
                niche           TEXT,
                bio             TEXT,
                location        TEXT,
                skill_level     TEXT,
                followers_ig    INTEGER DEFAULT 0,
                followers_tt    INTEGER DEFAULT 0,
                followers_yt    INTEGER DEFAULT 0,
                engagement_rate REAL    DEFAULT 0,
                avg_views       INTEGER DEFAULT 0,
                rate_ig         INTEGER DEFAULT 0,
                rate_tiktok     INTEGER DEFAULT 0,
                rate_yt         INTEGER DEFAULT 0,
                rate_ugc        INTEGER DEFAULT 0,
                rate_notes      TEXT,
                skills          TEXT    DEFAULT '[]',
                social_handles  TEXT    DEFAULT '{}',
                demo_age        TEXT,
                demo_gender     TEXT,
                demo_locations  TEXT,
                demo_interests  TEXT,
                updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS brand_profiles (
                user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                company_name TEXT,
                industry     TEXT,
                website      TEXT,
                budget_min   INTEGER DEFAULT 0,
                budget_max   INTEGER DEFAULT 0,
                description  TEXT,
                updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS campaigns (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                brand_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title         TEXT    NOT NULL,
                description   TEXT,
                budget        INTEGER DEFAULT 0,
                niche         TEXT,
                skills        TEXT    DEFAULT '[]',
                target_age    TEXT,
                min_followers INTEGER DEFAULT 0,
                max_rate      INTEGER DEFAULT 0,
                status        TEXT    NOT NULL DEFAULT 'open'
                                  CHECK(status IN ('open','paused','closed')),
                created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_campaigns_brand   ON campaigns(brand_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_campaigns_status  ON campaigns(status)")
        conn.execute("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS questions TEXT DEFAULT '[]'")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS applications (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
                creator_id  INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
                answers     TEXT    NOT NULL DEFAULT '[]',
                message     TEXT,
                status      TEXT    NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('pending','accepted','declined')),
                created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
                UNIQUE(campaign_id, creator_id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_applications_campaign ON applications(campaign_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_applications_creator  ON applications(creator_id)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS matches (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id    INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
                creator_id     INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
                match_score    INTEGER NOT NULL DEFAULT 0,
                match_reasons  TEXT    DEFAULT '[]',
                created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
                UNIQUE(campaign_id, creator_id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_matches_campaign ON matches(campaign_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_matches_creator  ON matches(creator_id)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS deals (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
                creator_id  INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
                brand_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
                status      TEXT    NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('pending','active','declined','completed')),
                amount      INTEGER NOT NULL DEFAULT 0,
                terms       TEXT,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_deals_creator  ON deals(creator_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_deals_brand    ON deals(brand_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_deals_campaign ON deals(campaign_id)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                body        TEXT    NOT NULL,
                deal_id     INTEGER REFERENCES deals(id) ON DELETE SET NULL,
                read_at     TEXT,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_sender   ON messages(sender_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_deal     ON messages(deal_id)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS notifications (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                type       TEXT    NOT NULL,
                title      TEXT    NOT NULL,
                body       TEXT    NOT NULL,
                data       TEXT    DEFAULT '{}',
                read_at    TEXT,
                created_at TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notif_user    ON notifications(user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notif_read    ON notifications(user_id, read_at)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS payments (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                deal_id           INTEGER NOT NULL REFERENCES deals(id)  ON DELETE CASCADE,
                brand_id          INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
                creator_id        INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
                amount            INTEGER NOT NULL,
                platform_fee      INTEGER NOT NULL,
                creator_payout    INTEGER NOT NULL,
                stripe_payment_id TEXT,
                status            TEXT    NOT NULL DEFAULT 'pending'
                                      CHECK(status IN ('pending','held','released','refunded')),
                created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
                released_at       TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_deal    ON payments(deal_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_brand   ON payments(brand_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_creator ON payments(creator_id)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ratings (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                deal_id     INTEGER NOT NULL REFERENCES deals(id)  ON DELETE CASCADE,
                reviewer_id INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
                reviewee_id INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
                score       INTEGER NOT NULL CHECK(score >= 1 AND score <= 5),
                comment     TEXT,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
                UNIQUE(deal_id, reviewer_id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ratings_reviewee ON ratings(reviewee_id)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS contracts (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                deal_id           INTEGER NOT NULL UNIQUE REFERENCES deals(id) ON DELETE CASCADE,
                content           TEXT    NOT NULL,
                brand_signed_at   TEXT,
                creator_signed_at TEXT,
                brand_ip          TEXT,
                creator_ip        TEXT,
                created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_contracts_deal ON contracts(deal_id)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS disputes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                deal_id     INTEGER NOT NULL UNIQUE REFERENCES deals(id) ON DELETE CASCADE,
                filed_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                reason      TEXT    NOT NULL,
                status      TEXT    NOT NULL DEFAULT 'open'
                                CHECK(status IN ('open','resolved','closed')),
                resolution  TEXT,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_disputes_deal     ON disputes(deal_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_disputes_filed_by ON disputes(filed_by)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS dispute_comments (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                dispute_id  INTEGER NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
                author_id   INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
                body        TEXT    NOT NULL,
                is_admin    INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dcomments_dispute ON dispute_comments(dispute_id)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS saved_creators (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                brand_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                creator_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
                UNIQUE(brand_id, creator_id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_saved_brand ON saved_creators(brand_id)")
        conn.commit()

    _migrate_deal_statuses()
    _add_column_if_missing("campaigns",        "target_age",           "TEXT")
    _add_column_if_missing("campaigns",        "min_followers",        "INTEGER DEFAULT 0")
    _add_column_if_missing("campaigns",        "max_rate",             "INTEGER DEFAULT 0")
    _add_column_if_missing("matches",          "match_reasons",        "TEXT DEFAULT '[]'")
    _add_column_if_missing("messages",         "read_at",              "TEXT")
    _add_column_if_missing("creator_profiles", "stripe_account_id",    "TEXT")
    _add_column_if_missing("creator_profiles", "stripe_onboarded",     "INTEGER DEFAULT 0")
    _add_column_if_missing("payments",         "checkout_session_id",  "TEXT")
    _add_column_if_missing("payments",         "stripe_transfer_id",   "TEXT")
    _add_column_if_missing("users",            "reset_token",          "TEXT")
    _add_column_if_missing("users",            "reset_token_expires",  "TEXT")
    _add_column_if_missing("deals",            "contract_document_id", "TEXT")
    _add_column_if_missing("deals",            "contract_status",      "TEXT DEFAULT 'none'")


def _migrate_deal_statuses():
    """SQLite only — rename v1 status values to v2."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='deals'"
        ).fetchone()
        if not row:
            return
        if "'pending'" in row["sql"]:
            return
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("""
            CREATE TABLE deals_v2 (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
                creator_id  INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
                brand_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
                status      TEXT    NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('pending','active','declined','completed')),
                amount      INTEGER NOT NULL DEFAULT 0,
                terms       TEXT,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            INSERT INTO deals_v2
            SELECT id, campaign_id, creator_id, brand_id,
                   CASE status WHEN 'proposed' THEN 'pending'
                               WHEN 'accepted' THEN 'active'
                               ELSE status END,
                   amount, terms, created_at, updated_at
            FROM deals
        """)
        conn.execute("DROP TABLE deals")
        conn.execute("ALTER TABLE deals_v2 RENAME TO deals")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.commit()


def _add_column_if_missing(table: str, column: str, definition: str):
    """SQLite only — idempotent column migration."""
    with get_conn() as conn:
        cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
        if column not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            conn.commit()
