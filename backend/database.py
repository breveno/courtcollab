import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "courtcollab.db")


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with get_conn() as conn:

        # ------------------------------------------------------------------ #
        # users                                                                #
        # ------------------------------------------------------------------ #
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

        # ------------------------------------------------------------------ #
        # creator_profiles                                                     #
        # ------------------------------------------------------------------ #
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

        # ------------------------------------------------------------------ #
        # brand_profiles                                                       #
        # ------------------------------------------------------------------ #
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

        # ------------------------------------------------------------------ #
        # campaigns                                                            #
        # ------------------------------------------------------------------ #
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

        # ------------------------------------------------------------------ #
        # matches                                                              #
        # ------------------------------------------------------------------ #
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

        # ------------------------------------------------------------------ #
        # deals                                                                #
        # Status flow:  pending → active → completed                          #
        #               pending → declined  (terminal)                        #
        # ------------------------------------------------------------------ #
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

        # ------------------------------------------------------------------ #
        # messages                                                             #
        # ------------------------------------------------------------------ #
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

        # ------------------------------------------------------------------ #
        # notifications                                                        #
        # data — arbitrary JSON for deep-linking (deal_id, campaign_id, etc.) #
        # ------------------------------------------------------------------ #
        conn.execute("""
            CREATE TABLE IF NOT EXISTS notifications (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                type       TEXT    NOT NULL,   -- deal_proposed | deal_active | deal_declined
                                              --   deal_completed | payment_received | message
                title      TEXT    NOT NULL,
                body       TEXT    NOT NULL,
                data       TEXT    DEFAULT '{}',
                read_at    TEXT,
                created_at TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notif_user    ON notifications(user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notif_read    ON notifications(user_id, read_at)")

        # ------------------------------------------------------------------ #
        # payments                                                             #
        # ------------------------------------------------------------------ #
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

        conn.commit()

    # ---------------------------------------------------------------------- #
    # Migrations — safe to re-run; each is idempotent                        #
    # ---------------------------------------------------------------------- #
    _migrate_deal_statuses()
    _add_column_if_missing("campaigns", "target_age",    "TEXT")
    _add_column_if_missing("campaigns", "min_followers", "INTEGER DEFAULT 0")
    _add_column_if_missing("campaigns", "max_rate",      "INTEGER DEFAULT 0")
    _add_column_if_missing("matches",          "match_reasons",        "TEXT DEFAULT '[]'")
    _add_column_if_missing("messages",         "read_at",              "TEXT")
    # Stripe Connect
    _add_column_if_missing("creator_profiles", "stripe_account_id",    "TEXT")
    _add_column_if_missing("creator_profiles", "stripe_onboarded",     "INTEGER DEFAULT 0")
    _add_column_if_missing("payments",         "checkout_session_id",  "TEXT")
    _add_column_if_missing("payments",         "stripe_transfer_id",   "TEXT")


def _migrate_deal_statuses():
    """
    Rename deal status values from v1 naming (proposed/accepted) to v2
    (pending/active).  Uses table-rebuild because SQLite doesn't allow
    ALTER TABLE … DROP CONSTRAINT.  Safe to call repeatedly.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='deals'"
        ).fetchone()
        if not row:
            return
        if "'pending'" in row["sql"]:
            return  # already migrated

        # Rebuild deals with new constraint, mapping old status values
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
                   CASE status
                       WHEN 'proposed' THEN 'pending'
                       WHEN 'accepted' THEN 'active'
                       ELSE status
                   END,
                   amount, terms, created_at, updated_at
            FROM deals
        """)
        conn.execute("DROP TABLE deals")
        conn.execute("ALTER TABLE deals_v2 RENAME TO deals")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.commit()


def _add_column_if_missing(table: str, column: str, definition: str):
    with get_conn() as conn:
        cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
        if column not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            conn.commit()
