CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  genre TEXT DEFAULT '',
  logline TEXT DEFAULT '',
  world_setting TEXT DEFAULT '',
  characters TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '新章节',
  content TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  ai_kind TEXT DEFAULT '',
  ai_prompt TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, seq);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings(key, value) VALUES ('llm_provider','openai');
INSERT OR IGNORE INTO settings(key, value) VALUES ('llm_base_url','https://openrouter.ai/api/v1');
INSERT OR IGNORE INTO settings(key, value) VALUES ('llm_model','nvidia/nemotron-3-super-120b-a12b:free');
INSERT OR IGNORE INTO settings(key, value) VALUES ('admin_token','nvs-writing-admin');
