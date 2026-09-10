// NVS-Writing — CF Workers 轻量 AI 小说写作系统（Workers + D1，无构建步骤）
// 端点：/ 前端编辑器；/api/* 数据接口；LLM 走 OpenRouter 免费模型

const DEFAULT_SETTINGS = {
  llm_provider: "openai", // openai = 任意 OpenAI 兼容端点; cf-ai = Cloudflare Workers AI
  llm_base_url: "https://openrouter.ai/api/v1",
  llm_model: "nvidia/nemotron-3-super-120b-a12b:free",
  llm_key: "",
  admin_token: "nvs-writing-admin",
};

// ---------- helpers ----------
async function getSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of results || []) s[r.key] = r.value;
  if (!s.llm_key) s.llm_key = env.LLM_KEY || "";
  return s;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(key, value).run();
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", ...extraHeaders },
  });
}

async function chat(env, s, messages, { maxTokens = 4000, temperature = 0.8 } = {}) {
  // Cloudflare Workers AI：用 AI binding，模型形如 @cf/meta/llama-3.1-8b-instruct，免费额度内 0 成本
  if (s.llm_provider === "cf-ai") {
    if (!env.AI) throw new Error('Worker 缺少 AI binding（wrangler.toml 需 [[ai]] binding="AI"，并在 CF 控制台开启 AI 能力）');
    const out = await env.AI.run(s.llm_model || "@cf/meta/llama-3.1-8b-instruct", {
      messages,
      max_tokens: maxTokens,
      temperature,
    });
    return out.response ?? "";
  }
  // OpenAI 通用格式：/chat/completions（OpenRouter / Groq / DeepSeek / Moonshot / Ollama / vLLM…）
  const base = s.llm_base_url || DEFAULT_SETTINGS.llm_base_url;
  const url = base.replace(/\/+$/, "").endsWith("/chat/completions") ? base : base.replace(/\/+$/, "") + "/chat/completions";
  const headers = {
    "Content-Type": "application/json",
    "HTTP-Referer": "https://localhost",
    "X-Title": "nvs-writing",
  };
  if (s.llm_key) headers["Authorization"] = `Bearer ${s.llm_key}`;
  // 注意：无 key 也能发（Ollama 等本地网关），由各端点自行鉴权
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: s.llm_model, messages, max_tokens: maxTokens, temperature }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`LLM ${resp.status}: ${txt.slice(0, 300)}`);
  }
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
    (chapter
      ? `\n\n【当前章节 第${chapter.seq}章 ${chapter.title}】\n${(chapter.content || "").slice(-2500)}`
      : "") +
    `\n\n【任务】${task}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ---------- API ----------
const api = {
  "GET /api/books": async (env) => {
    const res = await env.DB.prepare(
      "SELECT b.*, (SELECT COUNT(*) FROM chapters c WHERE c.book_id=b.id) AS chapter_count FROM books b ORDER BY b.updated_at DESC"
    ).all();
    return json(res.results ?? []);
  },
  "POST /api/books": async (env, req) => {
    const b = await req.json().catch(() => ({}));
    const r = await env.DB.prepare(
      "INSERT INTO books(title, genre, logline, world_setting, characters) VALUES(?,?,?,?,?)"
    ).bind(b.title || "未命名", b.genre || "", b.logline || "", b.world_setting || "", b.characters || "").run();
    const id = r.meta?.last_rowid;
    return json({ id });
  },
  "PATCH /api/books/:id": async (env, req, p) => {
    const b = await req.json().catch(() => ({}));
    const fields = ["title", "genre", "logline", "world_setting", "characters"];
    const sets = [], vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (sets.length) {
      vals.push(p.id);
      await env.DB.prepare(`UPDATE books SET ${sets.join(",")}, updated_at=datetime('now') WHERE id=?`).bind(...vals).run();
    }
    return json({ ok: true });
  },
  "DELETE /api/books/:id": async (env, req, p) => {
    await env.DB.prepare("DELETE FROM books WHERE id=?").bind(p.id).run();
    return json({ ok: true });
  },
  "GET /api/books/:id/chapters": async (env, req, p) => {
    const res = await env.DB.prepare(
      "SELECT id, book_id, seq, title, ai_kind, summary, created_at, updated_at FROM chapters WHERE book_id=? ORDER BY seq"
    ).bind(p.id).all();
    return json(res.results ?? []);
  },
  "POST /api/books/:id/chapters": async (env, req, p) => {
    const maxRow = await env.DB.prepare("SELECT MAX(seq) AS m FROM chapters WHERE book_id=?").bind(p.id).first();
    const seq = (maxRow?.m || 0) + 1;
    const r = await env.DB.prepare("INSERT INTO chapters(book_id, seq, title) VALUES(?,?,?)").bind(p.id, seq, "新章节").run();
    return json({ id: r.meta?.last_rowid, seq });
  },
  "GET /api/chapters/:id": async (env, req, p) => {
    const row = await env.DB.prepare("SELECT * FROM chapters WHERE id=?").bind(p.id).first();
    if (!row) return json({ error: "not found" }, 404);
    return json(row);
  },
  "PATCH /api/chapters/:id": async (env, req, p) => {
    const b = await req.json().catch(() => ({}));
    await env.DB.prepare(
      "UPDATE chapters SET title=COALESCE(?,title), content=COALESCE(?,content), summary=COALESCE(?,summary), ai_kind=?, ai_prompt=?, updated_at=datetime('now') WHERE id=?"
    ).bind(b.title ?? null, b.content ?? null, b.summary ?? null, b.ai_kind ?? "", b.ai_prompt ?? "", p.id).run();
    return json({ ok: true });
  },
  "DELETE /api/chapters/:id": async (env, req, p) => {
    await env.DB.prepare("DELETE FROM chapters WHERE id=?").bind(p.id).run();
    return json({ ok: true });
  },

  // ---- AI 动作 ----
  "POST /api/ai/outline": async (env, req, p) => {
    const s = await getSettings(env);
    const { bookId, extra = "", count = 30 } = await req.json().catch(() => ({}));
    const book = await env.DB.prepare("SELECT * FROM books WHERE id=?").bind(bookId).first();
    if (!book) return json({ error: "book not found" }, 404);
    const msgs = [
      {
        role: "system",
        content:
          "你是网文策划。根据梗概输出章节大纲：每行一个章节，格式：N、章节标题（30-60字，含本章主要事件与钩子）。只输出大纲正文。",
      },
      {
        role: "user",
        content:
          `【故事梗概】${book.logline || "（未填写）"}\n【世界观】${book.world_setting || "（未填写）"}\n【主要角色】${book.characters || "（未填写）"}\n\n请生成 ${count} 章大纲。${extra ? `\n额外要求：${extra}` : ""}`,
      },
    ];
    const out = await chat(env, s, msgs, { maxTokens: 3000, temperature: 0.9 });
    await setSetting(env, `book_${book.id}_outline`, out);
    return json({ text: out });
  },
  "POST /api/ai/expand-setting": async (env, req, p) => {
    const s = await getSettings(env);
    const { bookId, kind = "world", extra = "" } = await req.json().catch(() => ({}));
    const book = await env.DB.prepare("SELECT * FROM books WHERE id=?").bind(bookId).first();
    if (!book) return json({ error: "book not found" }, 404);
    const label = kind === "world" ? "世界观设定" : "角色设定";
    const base = kind === "world" ? book.world_setting : book.characters;
    const msgs = [
      {
        role: "system",
        content: `你是网文设定顾问。扩展并完善【${label}】：保持原有条目，补充细节（力量体系/势力/地理/配角弧光等，视类型而定），条目化输出，直接给设定文本。`,
      },
      { role: "user", content: `现有【${label}】：${base || "（空）"}\n梗概：${book.logline || ""}\n${extra ? `额外要求：${extra}` : ""}\n\n请输出扩展后的完整${label}。` },
    ];
    const out = await chat(env, s, msgs, { maxTokens: 3000, temperature: 0.8 });
    if (kind === "world") await env.DB.prepare("UPDATE books SET world_setting=?, updated_at=datetime('now') WHERE id=?").bind(out, book.id).run();
    else await env.DB.prepare("UPDATE books SET characters=?, updated_at=datetime('now') WHERE id=?").bind(out, book.id).run();
    return json({ text: out });
  },
  "POST /api/ai/write": async (env, req, p) => {
    const s = await getSettings(env);
    const body = await req.json().catch(() => ({}));
    const book = await env.DB.prepare("SELECT * FROM books WHERE id=?").bind(body.bookId).first();
    if (!book) return json({ error: "book not found" }, 404);
    const { chapterId, action = "continue", extra = "", words = 2000 } = body;
    const chapter = await env.DB.prepare("SELECT * FROM chapters WHERE id=?").bind(chapterId).first();
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

  // ---- 设置 ----
  "GET /api/settings": async (env, req, p) => {
    const s = await getSettings(env);
    return json({
      llm_provider: s.llm_provider,
      llm_base_url: s.llm_base_url,
      llm_model: s.llm_model,
      has_key: !!s.llm_key,
      admin_token_hint: s.admin_token.slice(0, 6) + "****",
    });
  },
  "POST /api/settings": async (env, req, p) => {
    const s = await getSettings(env);
    if ((await req.json().catch(() => ({}))).admin_token !== s.admin_token) return json({ error: "wrong admin token" }, 403);
    const b = await req.json().catch(() => ({}));
    for (const k of ["llm_provider", "llm_base_url", "llm_model"]) if (b[k] !== undefined) await setSetting(env, k, b[k]);
    if (b.llm_key !== undefined && b.llm_key !== "") await setSetting(env, "llm_key", b.llm_key);
    return json({ ok: true });
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
#settings{max-width:520px;padding:20px}
.err{color:#ff7b72}
</style></head><body><div id="app">
<aside>
 <h1><span>NVS</span> 写作台</h1>
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
  <b>LLM 设置</b>
  <div style="margin-top:10px"><label class="tag">提供商</label><select id="s_provider" style="width:auto">
   <option value="openai">OpenAI 兼容（OpenRouter/Groq/DeepSeek/Moonshot/Ollama/vLLM…）</option>
   <option value="cf-ai">Cloudflare Workers AI（免费额度，模型如 @cf/meta/llama-3.1-8b-instruct）</option></select></div>
  <div style="margin-top:8px"><label class="tag">Base URL（OpenAI 兼容端点）</label><input id="s_base" value="https://openrouter.ai/api/v1"></div>
  <div style="margin-top:8px"><label class="tag">模型</label><input id="s_model" value="nvidia/nemotron-3-super-120b-a12b:free"></div>
  <div style="margin-top:8px"><label class="tag">API Key（留空=用服务端已存）</label><input id="s_key" type="password" placeholder="sk-…"></div>
  <div style="margin-top:8px"><label class="tag">管理密码</label><input id="s_token" type="password" placeholder="admin_token"></div>
  <div class="row" style="margin-top:12px"><button id="savecfg">保存设置</button><span id="cfgmsg" class="tag"></span><span id="s_note" class="tag" style="margin-left:8px"></span></div>
 </div>
</main></div>
<script>
let cur={book:null,ch:null};
const $=id=>document.getElementById(id);
const api=p=>{const r=p.method!=='GET'?{method:p.method,body:JSON.stringify(p.body||{})}:{};return fetch(p.url,{...r,headers:{"Content-Type":"application/json"}}).then(async x=>{const d=await x.json().catch(()=>({}));if(!x.ok)throw new Error(d.error||x.status);return d})};
async function loadBooks(){
 const bs=await (await fetch('/api/books')).json();
 $('books').innerHTML=bs.map(b=>\`<div class="item" data-b="\${b.id}"><b>\${b.title}</b><small>\${b.chapter_count||0} 章 · \${b.genre||'-'}</small></div>\`).join('')||'<div class="tag" style="padding:10px 16px">还没有书</div>';
 document.querySelectorAll('#books .item').forEach(el=>el.onclick=()=>openBook(el.dataset.b));
}
async function openBook(id){
 const b=await (await fetch('/api/books')).json().then(bs=>bs.find(x=>x.id==id));cur.book=id;
 const chs=await (await fetch('/api/books/'+id+'/chapters')).json();
 $('chapters').innerHTML=chs.map(c=>\`<div class="item" data-c="\${c.id}"><b>第\${c.seq}章 \${c.title}</b><small class="tag">\${c.ai_kind?'AI·'+c.ai_kind:''} \${c.updated_at||''}</small></div>\`).join('')||'';
 document.querySelectorAll('#chapters .item').forEach(el=>el.onclick=()=>openCh(el.dataset.c));
 if(chs[0])openCh(chs[0].id);
 else newChapter();
}
async function newChapter(){const r=await api({method:'POST',url:'/api/books/'+cur.book+'/chapters'});openCh(r.id);}
async function openCh(id){
 cur.ch=id;const c=await api({url:'/api/chapters/'+id});
 $('content').value=c.content;$('chapters').querySelectorAll('.item').forEach(el=>el.style.background=el.dataset.c==id?'#20262e':'');
}
async function newBook(){
 const t=prompt('书名');if(!t)return;
 const g=prompt('类型（如：都市/玄幻/科幻/悬疑）','都市')||'';
 const lg=prompt('一句话梗概（可选）')||'';
 const r=await api({method:'POST',url:'/api/books',body:{title:t,genre:g,logline:lg}});openBook(r.id);loadBooks();
}
async function gen(){
 const a=$('act').value,extra=$('extra').value;
 if(a==='outline'||a==='world'||a==='chars'){if(!cur.book)return alert('先建一本书');
  $('aiwrap').hidden=false;$('aistatus').textContent='生成中…';$('aiout').textContent='';
  try{const endpoint=a==='outline'?'/api/ai/outline':(a==='world'?'/api/ai/expand-setting?kind=world':'/api/ai/expand-setting?kind=chars');
  const r=await api({method:'POST',url:endpoint,body:{bookId:cur.book,extra,kind:a==='chars'?'chars':'world'}});$('aiout').textContent=r.text;$('aistatus').textContent='完成';
   if(a==='world'){$('aiout').textContent=r.text+'\\n\\n（已保存进世界观设定，点“复制”可粘贴覆盖）';}
  }catch(e){$('aiout').textContent=e.message;$('aistatus').textContent='失败'}return}
 if(!cur.ch)return alert('先选一章');
 const ch=await api({url:'/api/chapters/'+cur.ch});
 $('aiwrap').hidden=false;$('aistatus').textContent='生成中…';$('aiout').textContent='';
 try{
  const r=await api({method:'POST',url:'/api/ai/write',body:{bookId:cur.book,chapterId:cur.ch,action:a,extra}});
  $('aiout').textContent=r.text;$('aistatus').textContent='完成';
  await api({method:'PATCH',url:'/api/chapters/'+cur.ch,body:{ai_kind:a}});
 }catch(e){$('aiout').textContent=e.message;$('aistatus').textContent='失败'}
}
$('go').onclick=gen;
$('copy').onclick=()=>$('aiout').textContent&&navigator.clipboard.writeText($('aiout').textContent);
$('newbook').onclick=()=>{loadBooks().then(()=>newBook2())};
function newBook2(){const t=prompt('书名');if(!t)return;api({method:'POST',url:'/api/books',body:{title:t}}).then(r=>openBook(r.id)).then(loadBooks)}
$('cfg').onclick=()=>$('settings').hidden=!$('settings').hidden;
// 载入当前设置（脱敏）
(async()=>{try{const s=await (await fetch('/api/settings')).json();
 if(s.llm_model)$('s_model').value=s.llm_model;
 if(s.llm_base_url)$('s_base').value=s.llm_base_url;
 if(s.llm_provider)$('s_provider').value=s.llm_provider;
 $('s_note').textContent='已配 LLM Key: '+(s.has_key?'是':'否')+' · 管理密码: '+s.admin_token_hint}catch(e){}})();
$('savecfg').onclick=async()=>{
 try{await api({method:'POST',url:'/api/settings',body:{llm_provider:$('s_provider').value,llm_model:$('s_model').value,llm_base_url:$('s_base').value,llm_key:$('s_key').value,admin_token:$('s_token').value}});
  $('cfgmsg').textContent='已保存';$('cfgmsg').className='tag'}catch(e){$('cfgmsg').textContent=e.message;$('cfgmsg').className='err'}}
// 自动保存正文（防抖）
let t;$('content').oninput=()=>{clearTimeout(t);t=setTimeout(()=>cur.ch&&api({method:'PATCH',url:'/api/chapters/'+cur.ch,body:{content:$('content').value}}),1500)};
loadBooks();
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
        return await fn(env, req, match);
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }
    return json({ error: "not found" }, 404);
  },
};
