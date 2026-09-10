-- nvs-writing D1 迁移 v1→v2（线上幂等：新表 IF NOT EXISTS；新列逐条执行，已存在则跳过/报错无害）
-- 执行方式：node migrate-local.mjs（本地）/ 逐条 wrangler d1 execute（线上，见 README）

-- ===== 新表 =====
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  role_type TEXT DEFAULT '角色',
  profile TEXT DEFAULT '',
  is_protagonist INTEGER NOT NULL DEFAULT 0,
  state_note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_roles_book ON roles(book_id);

CREATE TABLE IF NOT EXISTS foreshadows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  urgency INTEGER DEFAULT 50,
  planted_chapter INTEGER DEFAULT 0,
  payoff_chapter INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_foreshadows_book ON foreshadows(book_id);

CREATE TABLE IF NOT EXISTS chapter_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  chapter_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  subject TEXT DEFAULT '',
  payload TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_book ON chapter_events(book_id);

CREATE TABLE IF NOT EXISTS outline_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT '',
  detail TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outline_book ON outline_items(book_id);

CREATE TABLE IF NOT EXISTS admin_auth (
  email TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_tokens (
  admin_email TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  used_by TEXT,
  used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT,
  action TEXT DEFAULT '',
  ok INTEGER DEFAULT 1,
  ts TEXT DEFAULT (datetime('now'))
);

-- ===== 新列（SQLite 每次一条）=====
ALTER TABLE chapters ADD COLUMN status TEXT DEFAULT 'draft';
ALTER TABLE chapters ADD COLUMN outline_note TEXT DEFAULT '';
ALTER TABLE chapters ADD COLUMN hook TEXT DEFAULT '';
ALTER TABLE chapters ADD COLUMN review_json TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;

-- ===== settings 默认值 =====
INSERT OR IGNORE INTO settings(key,value) VALUES('require_invite','1');
INSERT OR IGNORE INTO settings(key,value) VALUES('site_name','NVS 写作台');
INSERT OR IGNORE INTO settings(key,value) VALUES('announcement','');

-- ===== 旧数据迁移：books.characters 拆行 → roles（每行一个角色，「名：档案」格式）=====
-- 由 migrate script 以 JS 分批执行（D1 单语句限制）；无旧数据则跳过。
