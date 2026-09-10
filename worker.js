// NVS-Writing — CF Workers 多租户 AI 小说写作系统（Workers + D1，无构建步骤）
// 认证：邮箱注册 / 登录 → 返回访问 token；数据按用户隔离
// LLM：OpenAI 通用格式（客户自填 Base URL + 模型 + Key）或 Cloudflare Workers AI

const LLM_DEFAULTS = {
  provider: "openai",
  base_url: "https://openrouter.ai/api/v1",
  model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
};

// ---------- helpers ----------
function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", ...extraHeaders },
  });
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function genToken() {
  const buf = await crypto.getRandomValues(new Uint8Array(20));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 认证：Authorization: Bearer <token>
async function authUser(env, req) {
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const row = await env.DB.prepare("SELECT email FROM users WHERE token=?").bind(m[1].trim()).first();
  return row ? row.email : null;
}

async function getLlm(env, email) {
  const row = await env.DB.prepare("SELECT provider, base_url, model, api_key FROM llm_settings WHERE user_email=?").bind(email).first();
  const s = { ...LLM_DEFAULTS, api_key: "" };
  if (row) Object.assign(s, row);
  return s;
}

async function chat(env, s, messages, { maxTokens = 4000, temperature = 0.8 } = {}) {
  if (s.provider === "cf-ai") {
    if (!env.AI) throw new Error("Worker 缺少 AI binding（wrangler.toml 需 [[ai]] binding=\"AI\"，并在 CF 控制台开启 AI 能力）");
    const out = await env.AI.run(s.model || "@cf/meta/llama-3.1-8b-instruct", { messages, max_tokens: maxTokens, temperature });
    return out.response ?? "";
  }
  // OpenAI 通用格式：/chat/completions（OpenRouter / Groq / DeepSeek / Moonshot / Ollama / vLLM…）
  if (!s.api_key) throw new Error("未配置 LLM API Key：请在右上角「设置」填写你的 LLM 地址/模型/Key 后重试");
  const base = (s.base_url || LLM_DEFAULTS.base_url).trim();
  const url = base.endsWith("/chat/completions") ? base : base.replace(/\/+$/, "") + "/chat/completions";
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.api_key}`, "HTTP-Referer": "https://nvs-writing.workers.dev", "X-Title": "nvs-writing" },
    body: JSON.stringify({ model: s.model, messages, max_tokens: maxTokens, temperature }),
  });
  if (!resp.ok) throw new Error(`LLM ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------- 上下文组装（大纲 + 设定 + 前情摘要） ----------
async function buildContextPrompt(env, book, chapter, task) {
  const parts = [];
  if (book.logline) parts.push(`【故事梗概】${book.logline}`);
  if (book.world_setting) parts.push(`【世界观设定】${book.world_setting}`);
  if (book.characters) parts.push(`【主要角色】${book.characters}`);
  const toc = await env.DB.prepare("SELECT seq, title FROM chapters WHERE book_id=? ORDER BY seq").bind(book.id).all();
  if (toc.results?.length) parts.push("【章节大纲】" + toc.results.map((c) => `第${c.seq}章 ${c.title}`).join("；"));
  if (chapter) {
    const prevs = (await env.DB.prepare(
      "SELECT seq, title, summary FROM chapters WHERE book_id=? AND seq < ? AND summary != '' ORDER BY seq DESC LIMIT 6"
    ).bind(book.id, chapter.seq).all()).results || [];
    if (prevs.length) parts.push("【前情摘要】" + [...prevs].reverse().map((c) => `第${c.seq}章：${c.summary}`).join("；"));
  }
  const system =
    "你是专业网文作者。直接输出中文正文，严禁输出思考过程、计划、解释或英文。保持人物口吻与世界观一致，遵循既有大纲不擅自偏离，新实体自然引入。";
  const user =
    parts.join("\n\n") +
    (chapter ? `\n\n【当前章节 第${chapter.seq}章 ${chapter.title}】\n${(chapter.content || "").slice(-2500)}` : "") +
    `\n\n【任务】${task}`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

// ---------- API ----------
const api = {
  // ---- 认证 ----
  "POST /api/register": async (env, req) => {
    const b = await req.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase();
    const password = String(b.password || "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "邮箱格式不正确" }, 400);
    if (password.length < 6) return json({ error: "密码至少 6 位" }, 400);
    const exists = await env.DB.prepare("SELECT 1 FROM users WHERE email=?").bind(email).first();
    if (exists) return json({ error: "该邮箱已注册，请直接登录" }, 409);
    const salt = await genToken();
    const hash = await sha256hex(salt + ":" + email + ":" + password);
    const token = await genToken();
    await env.DB.prepare("INSERT INTO users(email, pass_hash, salt, token) VALUES(?,?,?,?)").bind(email, hash, salt, token).run();
    await env.DB.prepare("INSERT INTO llm_settings(user_email, provider, base_url, model, api_key) VALUES(?,?,?,?,?)").bind(email, LLM_DEFAULTS.provider, LLM_DEFAULTS.base_url, LLM_DEFAULTS.model, "").run();
    return json({ token, email });
  },
  "POST /api/login": async (env, req) => {
    const b = await req.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase();
    const row = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
    if (!row) return json({ error: "账号不存在" }, 401);
    const hash = await sha256hex(row.salt + ":" + email + ":" + String(b.password || ""));
    if (hash !== row.pass_hash) return json({ error: "密码错误" }, 401);
    if (!row.token) {
      const t = await genToken();
      await env.DB.prepare("UPDATE users SET token=? WHERE email=?").bind(t, email).run();
      row.token = t;
    }
    return json({ token: row.token, email });
  },
  "POST /api/account": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const b = await req.json().catch(() => ({}));
    if (b.password && b.password.length >= 6) {
      const row = await env.DB.prepare("SELECT salt FROM users WHERE email=?").bind(email).first();
      const hash = await sha256hex(row.salt + ":" + email + ":" + b.password);
      await env.DB.prepare("UPDATE users SET pass_hash=? WHERE email=?").bind(hash, email).run();
    }
    let token;
    if (b.reset_token) {
      token = await genToken();
      await env.DB.prepare("UPDATE users SET token=? WHERE email=?").bind(token, email).run();
    } else {
      token = (await env.DB.prepare("SELECT token FROM users WHERE email=?").bind(email).first())?.token;
    }
    return json({ ok: true, token });
  },

  // ---- 书 / 章（按用户隔离） ----
  "GET /api/books": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const res = await env.DB.prepare(
      "SELECT b.id, b.title, b.genre, b.logline, b.created_at, b.updated_at, (SELECT COUNT(*) FROM chapters c WHERE c.book_id=b.id) AS chapter_count FROM books b WHERE b.owner_email=? ORDER BY b.updated_at DESC"
    ).bind(email).all();
    return json(res.results ?? []);
  },
  "POST /api/books": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const b = await req.json().catch(() => ({}));
    const r = await env.DB.prepare(
      "INSERT INTO books(owner_email, title, genre, logline) VALUES(?,?,?,?)"
    ).bind(email, b.title || "未命名", b.genre || "", b.logline || "").run();
    let id = Number(r.meta?.last_rowid);
    if (!id || Number.isNaN(id)) id = Number((await env.DB.prepare("SELECT MAX(id) AS m FROM books WHERE owner_email=?").bind(email).first())?.m ?? 0);
    return json({ id });
  },
  "PATCH /api/books/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT 1 FROM books WHERE id=? AND owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    const b = await req.json().catch(() => ({}));
    const fields = ["title", "genre", "logline", "world_setting", "characters"];
    const sets = [], vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (sets.length) { vals.push(p.id); await env.DB.prepare(`UPDATE books SET ${sets.join(",")}, updated_at=datetime('now') WHERE id=?`).bind(...vals).run(); }
    return json({ ok: true });
  },
  "DELETE /api/books/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT 1 FROM books WHERE id=? AND owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    await env.DB.prepare("DELETE FROM chapters WHERE book_id=?").bind(p.id).run();
    await env.DB.prepare("DELETE FROM books WHERE id=?").bind(p.id).run();
    return json({ ok: true });
  },
  "GET /api/books/:id/chapters": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT 1 FROM books WHERE id=? AND owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    const res = await env.DB.prepare("SELECT id, book_id, seq, title, ai_kind, summary, created_at, updated_at FROM chapters WHERE book_id=? ORDER BY seq").bind(p.id).all();
    return json(res.results ?? []);
  },
  "POST /api/books/:id/chapters": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT 1 FROM books WHERE id=? AND owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    const maxRow = await env.DB.prepare("SELECT MAX(seq) AS m FROM chapters WHERE book_id=?").bind(p.id).first();
    const seq = (maxRow?.m || 0) + 1;
    const r = await env.DB.prepare("INSERT INTO chapters(book_id, seq, title) VALUES(?,?,?)").bind(p.id, seq, "新章节").run();
    let id = Number(r.meta?.last_rowid);
    if (!id || Number.isNaN(id)) id = Number((await env.DB.prepare("SELECT MAX(id) AS m FROM chapters").first())?.m ?? 0);
    return json({ id, seq });
  },
  "GET /api/chapters/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const row = await env.DB.prepare("SELECT c.* FROM chapters c JOIN books b ON c.book_id=b.id WHERE c.id=? AND b.owner_email=?").bind(p.id, email).first();
    if (!row) return json({ error: "not found" }, 404);
    return json(row);
  },
  "PATCH /api/chapters/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT c.id FROM chapters c JOIN books b ON c.book_id=b.id WHERE c.id=? AND b.owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    const b = await req.json().catch(() => ({}));
    await env.DB.prepare(
      "UPDATE chapters SET title=COALESCE(?,title), content=COALESCE(?,content), summary=COALESCE(?,summary), ai_kind=?, ai_prompt=?, updated_at=datetime('now') WHERE id=?"
    ).bind(b.title ?? null, b.content ?? null, b.summary ?? null, b.ai_kind ?? "", b.ai_prompt ?? "", p.id).run();
    return json({ ok: true });
  },
  "DELETE /api/chapters/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT c.id FROM chapters c JOIN books b ON c.book_id=b.id WHERE c.id=? AND b.owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    await env.DB.prepare("DELETE FROM chapters WHERE id=?").bind(p.id).run();
    return json({ ok: true });
  },

  // ---- 每用户 LLM 设置 ----
  "GET /api/settings": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const s = await getLlm(env, email);
    return json({ provider: s.provider, base_url: s.base_url, model: s.model, has_key: !!s.api_key });
  },
  "POST /api/settings": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const b = await req.json().catch(() => ({}));
    await env.DB.prepare(
      `INSERT INTO llm_settings(user_email, provider, base_url, model, api_key) VALUES(?,?,?,?,?)
       ON CONFLICT(user_email) DO UPDATE SET
         provider=COALESCE(?,provider), base_url=COALESCE(?,base_url), model=COALESCE(?,model), api_key=CASE WHEN excluded.api_key != '' THEN excluded.api_key ELSE api_key END`
    ).bind(email, b.provider || LLM_DEFAULTS.provider, b.base_url || LLM_DEFAULTS.base_url, b.model || LLM_DEFAULTS.model, b.api_key || "", b.provider || null, b.base_url || null, b.model || null).run();
    return json({ ok: true });
  },

  // ---- AI 动作（走该用户自己的 LLM 配置） ----
  "POST /api/ai/outline": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const s = await getLlm(env, email);
    const { bookId, extra = "", count = 30 } = await req.json().catch(() => ({}));
    const book = await env.DB.prepare("SELECT * FROM books WHERE id=? AND owner_email=?").bind(bookId, email).first();
    if (!book) return json({ error: "book not found" }, 404);
    const msgs = [
      { role: "system", content: "你是网文策划。根据梗概输出章节大纲：每行一个章节，格式：N、章节标题（30-60字，含本章主要事件与钩子）。只输出大纲正文。" },
      { role: "user", content: `【故事梗概】${book.logline || "（未填写）"}\n【世界观】${book.world_setting || "（未填写）"}\n【主要角色】${book.characters || "（未填写）"}\n\n请生成 ${count} 章大纲。${extra ? `\n额外要求：${extra}` : ""}` },
    ];
    const out = await chat(env, s, msgs, { maxTokens: 3000, temperature: 0.9 });
    return json({ text: out });
  },
  "POST /api/ai/expand-setting": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const s = await getLlm(env, email);
    const { bookId, kind = "world", extra = "" } = await req.json().catch(() => ({}));
    const book = await env.DB.prepare("SELECT * FROM books WHERE id=? AND owner_email=?").bind(bookId, email).first();
    if (!book) return json({ error: "book not found" }, 404);
    const label = kind === "world" ? "世界观设定" : "角色设定";
    const base = kind === "world" ? book.world_setting : book.characters;
    const msgs = [
      { role: "system", content: `你是网文设定顾问。扩展并完善【${label}】：保持原有条目，补充细节（力量体系/势力/地理/配角弧光等，视类型而定），条目化输出，直接给设定文本。` },
      { role: "user", content: `现有【${label}】：${base || "（空）"}\n梗概：${book.logline || ""}\n${extra ? `额外要求：${extra}` : ""}\n\n请输出扩展后的完整${label}。` },
    ];
    const out = await chat(env, s, msgs, { maxTokens: 3000, temperature: 0.8 });
    if (kind === "world") await env.DB.prepare("UPDATE books SET world_setting=?, updated_at=datetime('now') WHERE id=?").bind(out, book.id).run();
    else await env.DB.prepare("UPDATE books SET characters=?, updated_at=datetime('now') WHERE id=?").bind(out, book.id).run();
    return json({ text: out });
  },
  "POST /api/ai/write": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const s = await getLlm(env, email);
    const body = await req.json().catch(() => ({}));
    const book = await env.DB.prepare("SELECT * FROM books WHERE id=? AND owner_email=?").bind(body.bookId, email).first();
    if (!book) return json({ error: "book not found" }, 404);
    const { chapterId, action = "continue", extra = "", words = 2000 } = body;
    const chapter = await env.DB.prepare("SELECT c.* FROM chapters c JOIN books b ON c.book_id=b.id WHERE c.id=? AND b.owner_email=?").bind(chapterId, email).first();
    if (!chapter) return json({ error: "chapter not found" }, 404);
    const taskMap = {
      continue: `续写第${chapter.seq}章正文，约${words}字，保持节奏与钩子，章末留悬念。`,
      rewrite: `重写第${chapter.seq}章正文，约${words}字。${extra}`,
      polish: `润色第${chapter.seq}章现有正文：修正语病、统一口吻、增强画面感，保持情节不变，输出完整润色后正文。`,
      summarize: `用150-300字总结第${chapter.seq}章的要点（事件、人物变化、伏笔），用于后续章节前情。`,
      hook: `基于第${chapter.seq}章结尾，写3个备选下章开场钩子（各约100字）。`,
    };
    const msgs = await buildContextPrompt(env, book, chapter, taskMap[action] || taskMap.continue + (extra ? `。额外要求：${extra}` : ""));
    const out = await chat(env, s, msgs, { maxTokens: 4000, temperature: action === "polish" ? 0.4 : 0.9 });
    if (action === "summarize") await env.DB.prepare("UPDATE chapters SET summary=?, ai_kind='summarize', updated_at=datetime('now') WHERE id=?").bind(out, chapterId).run();
    return json({ text: out });
  },
};

// ---------- 前端 ----------
const HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NVS 写作台</title>
<style>
:root{--bg:#111418;--panel:#1a1f26;--line:#2a313b;--tx:#d7dde5;--mut:#8b95a3;--acc:#4da3ff}
*{box-sizing:border-box}body{margin:0;font:14px/1.7 -apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;background:var(--bg);color:var(--tx)}
#app{display:grid;grid-template-columns:320px 1fr;height:100vh}
aside{background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column}
main{display:flex;flex-direction:column;min-width:0}
h1{font-size:16px;padding:14px 16px;margin:0;border-bottom:1px solid var(--line)}
h1 span{color:var(--acc)}
.bk-list,.ch-list{flex:1;overflow:auto}
.item{padding:10px 16px;border-bottom:1px solid var(--line);cursor:pointer}
.item:hover{background:#20262e}
.item b{display:block;font-size:14px}
.item small{color:var(--mut)}
button{background:var(--acc);border:0;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--tx)}
button.small{padding:3px 8px;font-size:12px}
input,textarea,select{width:100%;background:#11151a;border:1px solid var(--line);color:var(--tx);border-radius:6px;padding:8px;font:inherit}
textarea{resize:vertical}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#topbar{display:flex;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
#editor{flex:1;margin:0 auto;width:min(860px,100%);padding:20px}
#aiout{white-space:pre-wrap;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;min-height:60px;max-height:50vh;overflow:auto}
.tag{font-size:11px;color:var(--mut)}
.err{color:#ff7b72}
#login{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:10}
#login .box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:28px;width:340px}
#login .box h2{margin:0 0 14px;font-size:18px}
#login .box input{margin-top:8px}
#login .box button{width:100%;margin-top:14px;padding:9px}
#login .swap{margin-top:10px;font-size:12px;color:var(--mut);text-align:center}
#login .swap a{color:var(--acc);cursor:pointer}
#mebox{padding:10px 16px;border-bottom:1px solid var(--line);font-size:12px;color:var(--mut);display:flex;justify-content:space-between;align-items:center}
#settings{max-width:520px;padding:20px}
</style></head><body>
<div id="login"><div class="box">
 <h2><span style="color:var(--acc)">NVS</span> 写作台</h2>
 <div id="loginmsg"></div>
 <input id="li_email" type="email" placeholder="邮箱">
 <input id="li_pass" type="password" placeholder="密码（至少6位）">
 <button id="li_btn">登 录</button>
 <div class="swap" id="li_swap">没有账号？<a id="li_to_reg">注册</a></div>
</div></div>
<div id="app" style="visibility:hidden">
<aside>
 <h1><span>NVS</span> 写作台</h1>
 <div id="mebox"><span id="me"></span><button class="ghost small" id="logout">退出</button></div>
 <div style="padding:10px 16px" class="row"><button id="newbook">+ 新建书</button><button class="ghost small" id="cfg">设置</button></div>
 <div class="bk-list" id="books"></div>
 <div class="ch-list" id="chapters"></div>
</aside>
<main>
 <div id="topbar"><select id="act" style="width:170px">
  <option value="continue">AI 续写</option><option value="rewrite">AI 重写</option><option value="polish">AI 润色</option>
  <option value="summarize">AI 摘要(存前情)</option><option value="hook">AI 下章钩子×3</option>
  <option value="outline">生成章节大纲</option><option value="world">扩展世界观</option><option value="chars">扩展角色设定</option></select>
 <input id="extra" placeholder="额外要求（可选）" style="flex:1;min-width:180px">
 <button id="go">生成</button><button class="ghost" id="copy">复制</button></div>
 <div id="editor"><textarea id="content" placeholder="在此书写……（AI 生成结果可点击“复制”填入）" rows="20"></textarea></div>
 <div style="padding:0 16px 16px" id="aiwrap" hidden>
  <div class="row" style="justify-content:space-between"><b>AI 输出</b><span class="tag" id="aistatus"></span></div>
  <div id="aiout"></div>
 </div>
 <div id="settings" hidden>
  <b>LLM 设置（仅此账号生效）</b>
  <div style="margin-top:10px"><label class="tag">提供商</label><select id="s_provider" style="width:auto">
   <option value="openai">OpenAI 兼容（OpenRouter/Groq/DeepSeek/Moonshot/Ollama/vLLM…）</option>
   <option value="cf-ai">Cloudflare Workers AI（免费额度，模型如 @cf/meta/llama-3.1-8b-instruct）</option></select></div>
  <div style="margin-top:8px"><label class="tag">Base URL（OpenAI 兼容端点）</label><input id="s_base" value="https://openrouter.ai/api/v1"></div>
  <div style="margin-top:8px"><label class="tag">模型</label><input id="s_model"></div>
  <div style="margin-top:8px"><label class="tag">API Key</label><input id="s_key" type="password" placeholder="sk-…"></div>
  <div class="row" style="margin-top:12px"><button id="savecfg">保存</button><span id="cfgmsg" class="tag"></span><span id="s_note" class="tag" style="margin-left:8px"></span></div>
 </div>
</div></div>
<script>
let token=localStorage.getItem('nvs_token')||'';
const $=id=>document.getElementById(id);
const H=()=>({'Content-Type':'application/json','Authorization':'Bearer '+token});
async function api(method,url,body){const r=await fetch(url,{method,headers:H(),body:body?JSON.stringify(body):undefined});
 const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
let cur={book:null,ch:null};

// ---- 登录 / 注册 ----
let regMode=false;
function setReg(on){regMode=on;$('li_btn').textContent=on?'注 册':'登 录';$('li_swap').innerHTML=on?'已有账号？<a id="li_to_login">登录</a>':'没有账号？<a id="li_to_reg">注册</a>';(on?$('li_to_login'):$('li_to_reg')).onclick=()=>setReg(!on)}
$('li_to_reg').onclick=()=>setReg(true);
async function submitAuth(){
 const email=$('li_email').value.trim(),pass=$('li_pass').value;
 $('loginmsg').textContent='';$('loginmsg').className='tag';
 try{const r=await api(regMode?'POST':'POST',regMode?'/api/register':'/api/login',{email,password:pass});
  token=r.token;localStorage.setItem('nvs_token',token);enterApp(r.email);
 }catch(e){$('loginmsg').textContent=e.message;$('loginmsg').className='err'}
}
$('li_btn').onclick=submitAuth;$('li_pass').onkeydown=e=>{if(e.key==='Enter')submitAuth()};

function enterApp(email){$('login').style.display='none';$('app').style.visibility='visible';$('me').textContent=email;}
$('logout').onclick=()=>{localStorage.removeItem('nvs_token');token='';location.reload()};

// ---- 书籍 ----
async function loadBooks(){
 try{const bs=await api('GET','/api/books')}catch(e){if(String(e).includes('401')||/unauthorized/i.test(e.message))return doLogout();return}
 $('books').innerHTML=(bs||[]).map(b=>\`<div class="item" data-b="\${b.id}"><b>\${b.title}</b><small>\${b.chapter_count||0} 章 · \${b.genre||'-'}</small></div>\`).join('')||'<div class="tag" style="padding:10px 16px">还没有书</div>';
 document.querySelectorAll('#books .item').forEach(el=>el.onclick=()=>openBook(el.dataset.b));
}
function doLogout(){localStorage.removeItem('nvs_token');$('app').style.visibility='hidden';$('login').style.display='flex'}
async function openBook(id){
 const bs=await api('GET','/api/books');const b=bs.find(x=>x.id==id);cur.book=id;
 const chs=await api('GET','/api/books/'+id+'/chapters');
 $('chapters').innerHTML=chs.map(c=>\`<div class="item" data-c="\${c.id}"><b>第\${c.seq}章 \${c.title}</b><small class="tag">\${c.ai_kind?'AI·'+c.ai_kind:''} \${c.updated_at||''}</small></div>\`).join('')||'';
 document.querySelectorAll('#chapters .item').forEach(el=>el.onclick=()=>openCh(el.dataset.c));
 if(chs[0])openCh(chs[0].id);else newChapter();
}
async function newChapter(){const r=await api('POST','/api/books/'+cur.book+'/chapters');openCh(r.id)}
async function openCh(id){
 cur.ch=id;const c=await api('GET','/api/chapters/'+id);
 $('content').value=c.content;$('chapters').querySelectorAll('.item').forEach(el=>el.style.background=el.dataset.c==id?'#20262e':'');
}
$('newbook').onclick=()=>{const t=prompt('书名');if(!t)return;const g=prompt('类型（如：都市/玄幻/科幻/悬疑）','都市')||'';const lg=prompt('一句话梗概（可选）')||'';
 api('POST','/api/books',{title:t,genre:g,logline:lg}).then(r=>{loadBooks();openBook(r.id)})};

// ---- AI ----
async function gen(){
 const a=$('act').value,extra=$('extra').value;
 if(a==='outline'||a==='world'||a==='chars'){if(!cur.book)return alert('先建一本书');
  $('aiwrap').hidden=false;$('aistatus').textContent='生成中…';$('aiout').textContent='';
  try{const endpoint=a==='outline'?'/api/ai/outline':'/api/ai/expand-setting';
   const r=await api('POST',endpoint,{bookId:cur.book,extra,kind:a==='chars'?'chars':'world'});
   $('aiout').textContent=r.text+(a!=='outline'?'\\n\\n（已保存进设定）':'');$('aistatus').textContent='完成';
  }catch(e){$('aiout').textContent=e.message;$('aistatus').textContent='失败'}return}
 if(!cur.ch)return alert('先选一章');
 $('aiwrap').hidden=false;$('aistatus').textContent='生成中…';$('aiout').textContent='';
 try{const r=await api('POST','/api/ai/write',{bookId:cur.book,chapterId:cur.ch,action:a,extra});
  $('aiout').textContent=r.text;$('aistatus').textContent='完成';
  await api('PATCH','/api/chapters/'+cur.ch,{ai_kind:a});
 }catch(e){$('aiout').textContent=e.message;$('aistatus').textContent='失败'}
}
$('go').onclick=gen;
$('copy').onclick=()=>$('aiout').textContent&&navigator.clipboard.writeText($('aiout').textContent);

// ---- 设置（当前用户的 LLM） ----
$('cfg').onclick=()=>$('settings').hidden=!$('settings').hidden;
(async()=>{try{const s=await api('GET','/api/settings');
 if(s.provider)$('s_provider').value=s.provider;if(s.base_url)$('s_base').value=s.base_url;if(s.model)$('s_model').value=s.model;
 $('s_note').textContent='Key: '+(s.has_key?'已配置':'未配置')}catch(e){}})();
$('savecfg').onclick=async()=>{
 try{await api('POST','/api/settings',{provider:$('s_provider').value,base_url:$('s_base').value,model:$('s_model').value,api_key:$('s_key').value});
  $('cfgmsg').textContent='已保存';$('cfgmsg').className='tag';$('s_note').textContent='Key: 已配置'}catch(e){$('cfgmsg').textContent=e.message;$('cfgmsg').className='err'}}
// 自动保存正文（防抖）
let t;$('content').oninput=()=>{clearTimeout(t);t=setTimeout(()=>cur.ch&&api('PATCH','/api/chapters/'+cur.ch,{content:$('content').value}).catch(()=>{}),1500)};

// ---- 启动：有 token 直接进，没有先验一次 ----
(async()=>{
 if(!token)return; // 显示登录
 try{await api('GET','/api/books');enterApp(localStorage.getItem('nvs_email')||'');loadBooks()}
 catch(e){if(/unauthorized/i.test(e.message)||String(e).includes('401')){doLogout()}else{enterApp('');loadBooks()}}
})();
</script></body></html>`;

// ---------- router ----------
const routes = Object.entries(api);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS")
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" } });

    if (!url.pathname.startsWith("/api")) {
      return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    const publicRoutes = ["POST /api/register", "POST /api/login"];
    for (const [route, fn] of routes) {
      const [m, p] = route.split(" ");
      const head = p.split("/").filter(Boolean);
      const parts = url.pathname.split("/").filter(Boolean);
      if (head.length !== parts.length) continue;
      let ok = true;
      const match = {};
      head.forEach((seg, i) => {
        const m2 = seg.match(/^:(\w+)$/);
        if (m2) match[m2[1]] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) ok = false;
      });
      if (!ok || req.method !== m) continue;
      try {
        if (publicRoutes.includes(route)) return await fn(env, req, match, null);
        const email = await authUser(env, req);
        return await fn(env, req, match, email);
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }
    return json({ error: "not found" }, 404);
  },
};
