-- nvs-writing D1 schema（多租户版）

CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_email TEXT DEFAULT '',
  title TEXT NOT NULL DEFAULT '未命名',
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
  title TEXT DEFAULT '新章节',
  content TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  ai_kind TEXT DEFAULT '',
  ai_prompt TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 用户
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  pass_hash TEXT NOT NULL,          -- hex(sha256(salt + ':' + email + ':' + password))
  salt TEXT NOT NULL,
  token TEXT DEFAULT '',            -- 访问 token（hex 40）
  created_at TEXT DEFAULT (datetime('now'))
);

-- 每用户 LLM 配置（客户自填，OpenAI 通用格式 / CF Workers AI）
CREATE TABLE IF NOT EXISTS llm_settings (
  user_email TEXT PRIMARY KEY,
  provider TEXT DEFAULT 'openai',   -- openai | cf-ai
  base_url TEXT DEFAULT 'https://openrouter.ai/api/v1',
  model TEXT DEFAULT 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  api_key TEXT DEFAULT ''
);

-- 运营方全局设置（可选共享 Key 等；默认不配置，客户必须自填）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
