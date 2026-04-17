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
                user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                company_name   TEXT,
                industry       TEXT,
                website        TEXT,
                budget_min     INTEGER DEFAULT 0,
                budget_max     INTEGER DEFAULT 0,
                description    TEXT,
                social_handles TEXT DEFAULT '{}',
                updated_at     TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
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
                target_age       TEXT,
                min_followers    INTEGER DEFAULT 0,
                max_rate         INTEGER DEFAULT 0,
                creators_needed  INTEGER DEFAULT 1,
                status        TEXT    NOT NULL DEFAULT 'open'
                                  CHECK(status IN ('open','paused','closed','draft')),
                created_at    TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_campaigns_brand  ON campaigns(brand_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status)")
        conn.execute("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS questions TEXT DEFAULT '[]'")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS applications (
                id             SERIAL PRIMARY KEY,
                campaign_id    INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
                creator_id     INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
                answers        TEXT    NOT NULL DEFAULT '[]',
                message        TEXT,
                status         TEXT    NOT NULL DEFAULT 'pending'
                                   CHECK(status IN ('pending','accepted','declined')),
                source         TEXT    NOT NULL DEFAULT 'creator',
                invite_message TEXT,
                created_at     TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
                UNIQUE(campaign_id, creator_id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_applications_campaign ON applications(campaign_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_applications_creator  ON applications(creator_id)")
        # Invite columns — safe to run every startup for existing deployments
        conn.execute("ALTER TABLE applications ADD COLUMN IF NOT EXISTS source         TEXT NOT NULL DEFAULT 'creator'")
        conn.execute("ALTER TABLE applications ADD COLUMN IF NOT EXISTS invite_message TEXT")

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

        conn.execute("""
            CREATE TABLE IF NOT EXISTS deal_confirmations (
                id           SERIAL PRIMARY KEY,
                deal_id      INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
                user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role         TEXT    NOT NULL CHECK(role IN ('brand','creator')),
                confirmed_at TEXT    NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
                ip_address   TEXT,
                UNIQUE(deal_id, user_id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_deal_confirmations_deal ON deal_confirmations(deal_id)")

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
        conn.execute("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_age      TEXT")
        conn.execute("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS min_followers  INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS max_rate       INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS creators_needed INTEGER DEFAULT 1")

        # deals — SignWell contract tracking + contract terms + per-signer status
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS contract_document_id  TEXT")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS contract_status       TEXT DEFAULT 'none'")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS num_posts             INTEGER DEFAULT 1")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS deadline              TEXT")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS usage_rights_duration TEXT DEFAULT '1 year'")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS exclusivity_terms     TEXT DEFAULT 'None'")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS brand_signed          INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS brand_signed_at       TEXT")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS creator_signed        INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS creator_signed_at     TEXT")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS contract_completed_url TEXT")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS contract_sent_at      TEXT")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS signed_contract_url  TEXT")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS brand_terms_confirmed      INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS creator_terms_confirmed    INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS stripe_payment_intent_id  TEXT")
        conn.execute("ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS social_handles TEXT DEFAULT '{}'")

        # Stale deal tracking
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS reminders_sent     INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS last_reminder_sent TEXT")
        conn.execute("ALTER TABLE deals ADD COLUMN IF NOT EXISTS needs_review       INTEGER DEFAULT 0")

        # Allow 'draft' status on campaigns (constraint originally only had open/paused/closed)
        conn.execute("ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check")
        conn.execute("""
            ALTER TABLE campaigns ADD CONSTRAINT campaigns_status_check
            CHECK(status IN ('open','paused','closed','draft'))
        """)

        # Allow 'payout_complete' on deals
        conn.execute("ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_status_check")
        conn.execute("""
            ALTER TABLE deals ADD CONSTRAINT deals_status_check
            CHECK(status IN ('pending','active','declined','completed','payout_complete'))
        """)

        conn.commit()


def _sqlite_add_column(conn, sql: str):
    """Execute an ALTER TABLE … ADD COLUMN, silently skipping if it already exists.
    Needed because SQLite < 3.37 does not support ADD COLUMN IF NOT EXISTS."""
    try:
        conn.execute(sql)
    except Exception:
        pass  # column already exists


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
                user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                company_name   TEXT,
                industry       TEXT,
                website        TEXT,
                budget_min     INTEGER DEFAULT 0,
                budget_max     INTEGER DEFAULT 0,
                description    TEXT,
                social_handles TEXT DEFAULT '{}',
                updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
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
                target_age       TEXT,
                min_followers    INTEGER DEFAULT 0,
                max_rate         INTEGER DEFAULT 0,
                creators_needed  INTEGER DEFAULT 1,
                status        TEXT    NOT NULL DEFAULT 'open'
                                  CHECK(status IN ('open','paused','closed')),
                created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_campaigns_brand   ON campaigns(brand_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_campaigns_status  ON campaigns(status)")
        _sqlite_add_column(conn, "ALTER TABLE campaigns ADD COLUMN questions TEXT DEFAULT '[]'")

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
        conn.execute("""
            CREATE TABLE IF NOT EXISTS deal_confirmations (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                deal_id      INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
                user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role         TEXT    NOT NULL CHECK(role IN ('brand','creator')),
                confirmed_at TEXT    NOT NULL DEFAULT (datetime('now')),
                ip_address   TEXT,
                UNIQUE(deal_id, user_id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_deal_confirmations_deal ON deal_confirmations(deal_id)")
        conn.commit()

    _migrate_deal_statuses()
    _migrate_sqlite_payout_status()
    _add_column_if_missing("campaigns",        "target_age",           "TEXT")
    _add_column_if_missing("campaigns",        "min_followers",        "INTEGER DEFAULT 0")
    _add_column_if_missing("campaigns",        "max_rate",             "INTEGER DEFAULT 0")
    _add_column_if_missing("campaigns",        "creators_needed",      "INTEGER DEFAULT 1")
    _add_column_if_missing("matches",          "match_reasons",        "TEXT DEFAULT '[]'")
    _add_column_if_missing("messages",         "read_at",              "TEXT")
    _add_column_if_missing("creator_profiles", "stripe_account_id",    "TEXT")
    _add_column_if_missing("creator_profiles", "stripe_onboarded",     "INTEGER DEFAULT 0")
    _add_column_if_missing("payments",         "checkout_session_id",  "TEXT")
    _add_column_if_missing("payments",         "stripe_transfer_id",   "TEXT")
    _add_column_if_missing("users",            "reset_token",          "TEXT")
    _add_column_if_missing("users",            "reset_token_expires",  "TEXT")
    _add_column_if_missing("deals",            "contract_document_id",    "TEXT")
    _add_column_if_missing("deals",            "contract_status",         "TEXT DEFAULT 'none'")
    _add_column_if_missing("deals",            "num_posts",               "INTEGER DEFAULT 1")
    _add_column_if_missing("deals",            "deadline",                "TEXT")
    _add_column_if_missing("deals",            "usage_rights_duration",   "TEXT DEFAULT '1 year'")
    _add_column_if_missing("deals",            "exclusivity_terms",       "TEXT DEFAULT 'None'")
    _add_column_if_missing("deals",            "brand_signed",            "INTEGER DEFAULT 0")
    _add_column_if_missing("deals",            "brand_signed_at",         "TEXT")
    _add_column_if_missing("deals",            "creator_signed",          "INTEGER DEFAULT 0")
    _add_column_if_missing("deals",            "creator_signed_at",       "TEXT")
    _add_column_if_missing("deals",            "contract_completed_url",  "TEXT")
    _add_column_if_missing("deals",            "contract_sent_at",        "TEXT")
    _add_column_if_missing("deals",            "signed_contract_url",     "TEXT")
    _add_column_if_missing("deals",          "brand_terms_confirmed",   "INTEGER DEFAULT 0")
    _add_column_if_missing("deals",          "creator_terms_confirmed", "INTEGER DEFAULT 0")
    _add_column_if_missing("deals",          "brand_marked_complete",    "INTEGER DEFAULT 0")
    _add_column_if_missing("deals",          "creator_marked_complete",  "INTEGER DEFAULT 0")
    _add_column_if_missing("deals",          "stripe_payment_intent_id", "TEXT")
    _add_column_if_missing("brand_profiles", "social_handles",           "TEXT DEFAULT '{}'")
    _add_column_if_missing("deals",          "reminders_sent",           "INTEGER DEFAULT 0")
    _add_column_if_missing("deals",          "last_reminder_sent",       "TEXT")
    _add_column_if_missing("deals",          "needs_review",             "INTEGER DEFAULT 0")


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


def _migrate_sqlite_payout_status():
    """
    SQLite only — add 'payout_complete' to the deals.status CHECK constraint.
    Recreates the table (SQLite cannot ALTER constraints in-place).
    Safe to call multiple times — exits immediately if already migrated.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='deals'"
        ).fetchone()
        if not row or "'payout_complete'" in row["sql"]:
            return  # Already migrated or table doesn't exist yet

        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS deals_v3 (
                id                       INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id              INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
                creator_id               INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
                brand_id                 INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
                status                   TEXT    NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','active','declined','completed','payout_complete')),
                amount                   INTEGER NOT NULL DEFAULT 0,
                terms                    TEXT,
                created_at               TEXT    NOT NULL DEFAULT (datetime('now')),
                updated_at               TEXT    NOT NULL DEFAULT (datetime('now')),
                contract_document_id     TEXT,
                contract_status          TEXT    DEFAULT 'none',
                num_posts                INTEGER DEFAULT 1,
                deadline                 TEXT,
                usage_rights_duration    TEXT    DEFAULT '1 year',
                exclusivity_terms        TEXT    DEFAULT 'None',
                brand_signed             INTEGER DEFAULT 0,
                brand_signed_at          TEXT,
                creator_signed           INTEGER DEFAULT 0,
                creator_signed_at        TEXT,
                contract_completed_url   TEXT,
                contract_sent_at         TEXT,
                signed_contract_url      TEXT,
                brand_terms_confirmed    INTEGER DEFAULT 0,
                creator_terms_confirmed  INTEGER DEFAULT 0,
                brand_marked_complete    INTEGER DEFAULT 0,
                creator_marked_complete  INTEGER DEFAULT 0,
                stripe_payment_intent_id TEXT
            )
        """)

        # Copy only columns that exist in both old and new table (handles partial schemas)
        old_cols = {r["name"] for r in conn.execute("PRAGMA table_info(deals)").fetchall()}
        new_cols = {r["name"] for r in conn.execute("PRAGMA table_info(deals_v3)").fetchall()}
        shared   = [c for c in old_cols if c in new_cols]
        col_list = ", ".join(shared)
        conn.execute(f"INSERT INTO deals_v3 ({col_list}) SELECT {col_list} FROM deals")
        conn.execute("DROP TABLE deals")
        conn.execute("ALTER TABLE deals_v3 RENAME TO deals")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.commit()


def _add_column_if_missing(table: str, column: str, definition: str):
    """SQLite only — idempotent column migration."""
    with get_conn() as conn:
        cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
        if column not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            conn.commit()
