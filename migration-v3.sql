-- nvs-writing D1 迁移 v2→v3（幂等：新表 IF NOT EXISTS；新列单独 ALTER）
-- 执行：npx wrangler d1 execute nvs-db --remote --file - < 逐段执行，或控制台粘贴
-- 1) 新表
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  chapter_seq INTEGER DEFAULT 0,
  fact_type TEXT DEFAULT 'state',
  subject TEXT DEFAULT '',
  fact TEXT NOT NULL,
  source TEXT DEFAULT 'ai',
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_book ON ledger(book_id);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  level TEXT DEFAULT 'volume',
  seq_from INTEGER DEFAULT 1,
  seq_to INTEGER DEFAULT 0,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_summaries_book ON summaries(book_id);

-- 2) 新列（已存在则报错可忽略）
ALTER TABLE roles ADD COLUMN voice TEXT DEFAULT '';
ALTER TABLE books ADD COLUMN anti_ai_rules TEXT DEFAULT '';

-- 3) 站点默认负面清单种子
INSERT OR IGNORE INTO settings(key,value) VALUES('anti_ai_default','禁止套话：不禁/仿佛/眼中闪过一丝/嘴角勾起一抹/值得注意的是/总而言之/命运的齿轮；禁止连续三个以上排比句；禁止解释性旁白（用动作与细节代替评论）；句式长短必须有变化；每个角色说话要有区分度（用词/信息量/口头禅不同）');
