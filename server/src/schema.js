export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS invite_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  max_uses   INTEGER NOT NULL DEFAULT 50,
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count <= max_uses),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  phone         TEXT,
  password_hash TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'approved'
                CHECK (status IN ('approved','banned','deleted')),
  muted_until   INTEGER,
  privacy       INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '',
  is_admin      INTEGER NOT NULL DEFAULT 0,
  is_npc        INTEGER NOT NULL DEFAULT 0,
  balance       INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  frozen        INTEGER NOT NULL DEFAULT 0 CHECK (frozen >= 0),
  emoji         TEXT NOT NULL DEFAULT '🫵',
  title         TEXT NOT NULL DEFAULT '新人玩家',
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  streak        INTEGER NOT NULL DEFAULT 0,
  max_streak    INTEGER NOT NULL DEFAULT 0,
  best_win_odds REAL    NOT NULL DEFAULT 0,
  reputation    INTEGER NOT NULL DEFAULT 100,
  checkin_streak INTEGER NOT NULL DEFAULT 0,
  last_supply_at INTEGER,
  token_version INTEGER NOT NULL DEFAULT 0,
  invite_code_id INTEGER REFERENCES invite_codes(id),
  created_at    INTEGER NOT NULL,
  banned_at     INTEGER,
  deleted_at    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name_alive ON users(name) WHERE status != 'deleted';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_alive ON users(phone) WHERE phone IS NOT NULL AND status != 'deleted';

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id       INTEGER NOT NULL REFERENCES users(id),
  key           TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS reset_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mode         TEXT NOT NULL CHECK (mode IN ('match','banker','pool')),
  title        TEXT NOT NULL,
  option_a     TEXT NOT NULL,
  option_b     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','matched','consensus','settled','voided')),
  result       TEXT CHECK (result IN ('A','B')),
  owner_id     INTEGER NOT NULL REFERENCES users(id),
  owner_side   TEXT CHECK (owner_side IN ('A','B')),
  odds         REAL CHECK (odds IS NULL OR odds > 1),
  owner_stake  INTEGER CHECK (owner_stake IS NULL OR owner_stake > 0),
  taker_id     INTEGER REFERENCES users(id),
  taker_side   TEXT CHECK (taker_side IN ('A','B')),
  taker_stake  INTEGER CHECK (taker_stake IS NULL OR taker_stake > 0),
  banker_odds  REAL CHECK (banker_odds IS NULL OR banker_odds > 1),
  banker_cap   INTEGER CHECK (banker_cap IS NULL OR banker_cap > 0),
  invited_ids  TEXT,
  consensus    TEXT,
  deadline     INTEGER,
  side_bet_text TEXT,
  side_bet_fulfilled INTEGER NOT NULL DEFAULT 0,
  side_bet_fulfilled_at INTEGER,
  settled_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status, created_at);
CREATE INDEX IF NOT EXISTS idx_matches_owner ON matches(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_matches_taker ON matches(taker_id, status);

CREATE TABLE IF NOT EXISTS match_bets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  side       TEXT NOT NULL CHECK (side IN ('A','B')),
  stake      INTEGER NOT NULL CHECK (stake > 0),
  payout     INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mbets_match ON match_bets(match_id);
CREATE INDEX IF NOT EXISTS idx_mbets_user ON match_bets(user_id);

CREATE TABLE IF NOT EXISTS pm_bets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  event_id    TEXT NOT NULL,
  market_id   TEXT,
  event_title TEXT NOT NULL,
  market_question TEXT,
  outcome     TEXT NOT NULL,
  zh_outcome  TEXT NOT NULL DEFAULT '',
  prob        REAL NOT NULL CHECK (prob > 0 AND prob <= 1),
  odds        REAL NOT NULL CHECK (odds >= 1),
  stake       INTEGER NOT NULL CHECK (stake > 0),
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','won','lost','voided')),
  result      TEXT,
  payout      INTEGER NOT NULL DEFAULT 0,
  settled_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pmbets_pending ON pm_bets(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pmbets_user ON pm_bets(user_id, created_at);

CREATE TABLE IF NOT EXISTS ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  type          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'player'
                CHECK (kind IN ('player','system')),
  amount        INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  ref           TEXT,
  actor_admin_id INTEGER REFERENCES users(id),
  reason        TEXT,
  request_id    TEXT,
  created_at    INTEGER NOT NULL,
  CHECK (type != 'admin_adjust' OR (reason IS NOT NULL AND actor_admin_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_type ON ledger(type, created_at);

CREATE TABLE IF NOT EXISTS appeals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  reason     TEXT NOT NULL DEFAULT '',
  stake      INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
  verdict    TEXT CHECK (verdict IN ('uphold','overturn')),
  new_result TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by INTEGER REFERENCES users(id),
  UNIQUE (match_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL CHECK (scope IN ('match','pm')),
  ref_id     TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  text       TEXT NOT NULL,
  is_slap    INTEGER NOT NULL DEFAULT 0,
  reply_to_comment_id INTEGER REFERENCES comments(id),
  deleted_at INTEGER,
  deleted_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_ref ON comments(scope, ref_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_recent ON comments(created_at);

CREATE TABLE IF NOT EXISTS friendships (
  user_a     INTEGER NOT NULL REFERENCES users(id),
  user_b     INTEGER NOT NULL REFERENCES users(id),
  status     TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','accepted')),
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a != user_b)
);
CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_b, status);

CREATE TABLE IF NOT EXISTS chats (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    INTEGER NOT NULL REFERENCES users(id),
  to_id      INTEGER NOT NULL REFERENCES users(id),
  text       TEXT NOT NULL,
  read_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_pair ON chats(from_id, to_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chats_to ON chats(to_id, read_at);
CREATE INDEX IF NOT EXISTS idx_chats_created ON chats(created_at); -- admin 发言看板按时间倒序用

CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS traffic_hourly (
  hour       TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('api','static')),
  requests   INTEGER NOT NULL DEFAULT 0,
  bytes_out  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, source)
);

CREATE TABLE IF NOT EXISTS feed (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  actor_id   INTEGER REFERENCES users(id),
  target_user_id INTEGER REFERENCES users(id),
  text       TEXT NOT NULL,
  ref        TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checkins (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  day        TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  streak     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS activity_days (
  user_id INTEGER NOT NULL REFERENCES users(id),
  day     TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind    TEXT NOT NULL CHECK (kind IN ('matches','pm')),
  ref_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, ref_id)
);

CREATE TABLE IF NOT EXISTS season_archives (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  season_start INTEGER NOT NULL,
  ended_at   INTEGER NOT NULL,
  wins INTEGER, losses INTEGER, max_streak INTEGER, best_win_odds REAL, balance INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settlement_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL DEFAULT 'running'
              CHECK (status IN ('running','done','partial','failed')),
  scanned     INTEGER NOT NULL DEFAULT 0,
  settled     INTEGER NOT NULL DEFAULT 0,
  errors      TEXT
);

CREATE TABLE IF NOT EXISTS admin_alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT NOT NULL CHECK (level IN ('warn','critical')),
  kind       TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
`

export function migrate(db) {
  db.exec(SCHEMA_SQL)
  const ensureColumn = (table, column, ddl) => {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
  ensureColumn('comments', 'reply_to_comment_id', 'reply_to_comment_id INTEGER REFERENCES comments(id)')
  ensureColumn('feed', 'target_user_id', 'target_user_id INTEGER REFERENCES users(id)')
  // 团码大小写不敏感化（2026-06-12）：注册输入统一转小写比对，旧库存的大写团码（如 BEEEEET）
  // 必须一并转小写，否则老团码注册查不到返回 INVITE_INVALID。幂等：再跑一次 lower 不变。
  db.exec("UPDATE invite_codes SET code = lower(code) WHERE code != lower(code)")
}
