-- nvs-writing D1 schema v2（多租户 + 注册码 + 管理员 + 写作流水线数据模型）
-- 数据模型参照 webnovel-writer 的「设定集/伏笔/角色/大纲→写章流水线→数据回写」链路
-- 与线上旧表字段名对齐（logline/characters/pass_hash/user_email/api_key），仅新增列和表

CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_email TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '未命名',
  genre TEXT DEFAULT '',
  logline TEXT DEFAULT '',              -- 故事梗概（一句话）
  world_setting TEXT DEFAULT '',
  characters TEXT DEFAULT '',           -- 遗留字段（v2 用 roles 表；旧数据已迁移进 roles）
  anti_ai_rules TEXT DEFAULT '',        -- 本书 AI 味负面清单（空=用站点默认 anti_ai_default）
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_books_owner ON books(owner_email);

CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  status TEXT DEFAULT 'draft',          -- draft / committed（流水线回写完成后）
  ai_kind TEXT DEFAULT '',
  ai_prompt TEXT DEFAULT '',
  outline_note TEXT DEFAULT '',         -- 本章大纲目标（流水线任务书第一步约束）
  hook TEXT DEFAULT '',                 -- 结尾钩子（下章承接点）
  summary TEXT DEFAULT '',              -- 前情摘要（data-agent 回写产物）
  review_json TEXT DEFAULT '',          -- 最近一次审查 JSON（reviewer 产物）
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id);
-- B3：同一本书内 seq 必须唯一（防并发双写同 seq 章）。
-- 幂等迁移：先给存量数据去重（每 (book_id,seq) 保留最小 id），再建唯一索引（已去重则 0 行）
DELETE FROM chapters WHERE id NOT IN (SELECT MIN(id) FROM chapters GROUP BY book_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_chapters_book_seq ON chapters(book_id, seq);

-- 角色设定（对应 webnovel-writer 设定集/角色索引）
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  role_type TEXT DEFAULT '角色',        -- 角色/组织/地点/物品/势力
  profile TEXT DEFAULT '',              -- 简介/能力/境界
  voice TEXT DEFAULT '',               -- 语言声纹：用词/句式/口头禅/信息量（对话区分度用）
  is_protagonist INTEGER NOT NULL DEFAULT 0,
  state_note TEXT DEFAULT '',           -- 当前状态（随章节推进更新，data-agent 回写）
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_roles_book ON roles(book_id);

-- 伏笔（对应 open_loop 事件模型：埋设/回收）
CREATE TABLE IF NOT EXISTS foreshadows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT DEFAULT 'open',           -- open / paid
  urgency INTEGER DEFAULT 50,           -- 0-100：紧急≈100 / 一般≈50 / 远期≈20
  planted_chapter INTEGER DEFAULT 0,    -- 埋设章
  payoff_chapter INTEGER DEFAULT 0,     -- 回收章
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_foreshadows_book ON foreshadows(book_id);

-- 章节事件流（data-agent 回写：open_loop_created / character_state_changed 等，对应参考项目长期记忆 events）
CREATE TABLE IF NOT EXISTS chapter_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  chapter_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,   -- 参考 data-agent 枚举：open_loop_created/open_loop_closed/character_state_changed/power_breakthrough/relationship_changed/world_rule_revealed/promise_created/promise_paid_off/artifact_obtained
  subject TEXT DEFAULT '',     -- 主体（角色名/实体 ID）
  payload TEXT DEFAULT '',     -- JSON：content/urgency/old/new 等
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_book ON chapter_events(book_id);

-- 大纲条目（卷/章纲）
CREATE TABLE IF NOT EXISTS outline_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT '',
  detail TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',        -- pending / in_progress / done
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outline_book ON outline_items(book_id);

-- 事实账本（跨章一致性真源：data-agent 提取 + 人工校正；写章前按 type 注入）
-- fact_type: state(状态) / knowledge(谁知道什么) / lineage(身世谱系) / rule(世界规则) / other
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  chapter_seq INTEGER DEFAULT 0,     -- 产生于哪章（0=开书前人工设定）
  fact_type TEXT DEFAULT 'state',
  subject TEXT DEFAULT '',            -- 主体（角色名/实体）
  fact TEXT NOT NULL,
  source TEXT DEFAULT 'ai',          -- ai(流水线提取) / manual(人工)
  status TEXT DEFAULT 'active',       -- active / superseded / corrected
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_book ON ledger(book_id);

-- 分层摘要（卷级滚动压缩：章节多了后 state-pack 注入摘要而非全量）
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  level TEXT DEFAULT 'volume',       -- volume（卷）
  seq_from INTEGER DEFAULT 1,
  seq_to INTEGER DEFAULT 0,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_summaries_book ON summaries(book_id);

CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL,             -- hex(sha256(salt + ':' + email + ':' + password))
  token TEXT DEFAULT '',               -- 访问 token（hex 40）
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 管理员（admin_auth 空表时可用 init 码创建首个管理员）
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

-- 注册码
CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  used_by TEXT,
  used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_settings (
  user_email TEXT PRIMARY KEY,
  provider TEXT DEFAULT 'openai',      -- openai | cf-ai
  base_url TEXT DEFAULT '',
  model TEXT DEFAULT '',
  api_key TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO settings(key,value) VALUES('require_invite','1');
INSERT OR IGNORE INTO settings(key,value) VALUES('site_name','NVS 写作台');
INSERT OR IGNORE INTO settings(key,value) VALUES('announcement','');
-- 站点默认 AI 味负面清单（书级 anti_ai_rules 为空时回退到此）
INSERT OR IGNORE INTO settings(key,value) VALUES('anti_ai_default','禁止套话：不禁/仿佛/眼中闪过一丝/嘴角勾起一抹/值得注意的是/总而言之/命运的齿轮；禁止连续三个以上排比句；禁止解释性旁白（用动作与细节代替评论）；句式长短必须有变化；每个角色说话要有区分度（用词/信息量/口头禅不同）');
-- SEO（meta description/keywords，前端启动时注入 head）
INSERT OR IGNORE INTO settings(key,value) VALUES('seo_desc','NVS 写作台：AI 长篇网文流水线。设定集、伏笔、角色声纹、事实账本四层一致性，一键写章、五维审查、去 AI 味润色、EPUB 导出。');
INSERT OR IGNORE INTO settings(key,value) VALUES('seo_keywords','AI写作,网络小说,长篇小说,写作助手,大纲,伏笔,EPUB导出');
-- 站点级默认 LLM（JSON：{provider,base_url,model,api_key}；用户未配模型时回退到此）
INSERT OR IGNORE INTO settings(key,value) VALUES('site_llm','');

-- 用量统计
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT,
  action TEXT DEFAULT '',
  ok INTEGER DEFAULT 1,
  ts TEXT DEFAULT (datetime('now'))
);

-- B1：D1 滑窗频控（key=nsv:auth:<ip> / nsv:pipe:<email> / nsv:chat:<email>；n=窗口内计数，ts=窗口起点，1h 重置）
CREATE TABLE IF NOT EXISTS rate_limit (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 1,
  ts INTEGER NOT NULL
);
-- C3：ai_usage 只保留 90 天（本地/CI 定期跑：DELETE FROM ai_usage WHERE ts < datetime('now','-90 day')）

-- B3：写章忙锁（一本书同时只允许一个流水线，防并发双写；TTL 兜底防死锁）
CREATE TABLE IF NOT EXISTS pipeline_lock (
  book_id INTEGER PRIMARY KEY,
  owner_email TEXT NOT NULL DEFAULT '',
  acquired_at INTEGER NOT NULL
);
