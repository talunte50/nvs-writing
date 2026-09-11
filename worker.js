// NVS-Writing v2 — CF Workers 多租户 AI 小说写作系统（Workers + D1，无构建步骤）
// 流水线忠实复刻 webnovel-writer 6 步链路（CF 单线程约束下映射为 5 次 LLM + 1 次确定性回写）：
// ① 写作任务书（context-agent 五段）→ ② 起草（writer）→ ③ 五维审查（reviewer 严格 JSON）
// → ④ 润色（定点修 blocking + anti-AI）→ ⑤ 事实提取（data-agent extraction schema）→ ⑥ 确定性回写
// 三大定律：大纲即法律 / 设定即物理 / 上章钩子必须回应。
// 回写落库：chapters(summary/hook/review_json/status) + foreshadows(open_loop 埋/收) + roles(state_note)
//           + chapter_events(事件流) + outline_items(推进状态)。blocking>0 → rejected，不落库为 committed。

const LLM_DEFAULTS = {
  provider: "openai",
  base_url: "https://openrouter.ai/api/v1",
  model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
};

// ---------- helpers ----------
function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "***", ...extraHeaders },
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
// 从 LLM 输出中提取第一个完整 JSON 对象（reviewer / data-agent 均要求"只输出 JSON"，但模型偶尔夹带前后文）
function extractJson(text) {
  const s = String(text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fence ? fence[1].trim() : s;
  const start = src.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(src.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

// 认证：Authorization: Bearer ***（用户 token）
async function authUser(env, req) {
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const row = await env.DB.prepare("SELECT email FROM users WHERE token=? AND blocked=0").bind(m[1].trim()).first();
  return row ? row.email : null;
}
async function authAdmin(env, req) {
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const row = await env.DB.prepare("SELECT admin_email FROM admin_tokens WHERE token=?").bind(m[1].trim()).first();
  return row ? row.admin_email : null;
}
function isAdmin(email) {
  // 管理员邮箱同时也是普通用户？不：管理员接口仅认 admin token
  return !!email;
}

async function getLlm(env, email) {
  const row = await env.DB.prepare("SELECT provider, base_url, model, api_key FROM llm_settings WHERE user_email=?").bind(email).first();
  const s = { ...LLM_DEFAULTS, api_key: "" };
  if (row) Object.assign(s, row);
  if (s.provider === "openai" && !s.api_key && env.LLM_KEY) s.api_key = env.LLM_KEY; // 站点级兜底 key（wrangler [vars] LLM_KEY）
  return s;
}

async function chat(env, s, messages, { maxTokens = 4000, temperature = 0.8 } = {}) {
  if (s.provider === "cf-ai") {
    if (!env.AI) throw new Error("Worker 缺少 AI binding（wrangler.toml 需 [[ai]] binding=\"AI\"，并在 CF 控制台开启 AI 能力）");
    const out = await env.AI.run(s.model || "@cf/meta/llama-3.1-8b-instruct", { messages, max_tokens: maxTokens, temperature });
    return out.response ?? "";
  }
  if (!s.api_key) throw new Error("未配置 LLM API Key：请在「设置」填写 LLM 地址/模型/Key，或联系管理员配置站点 Key");
  const base = (s.base_url || LLM_DEFAULTS.base_url).trim();
  const url = base.endsWith("/chat/completions") ? base : base.replace(/\/+$/, "") + "/chat/completions";
  const doChat = async (mt) => {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.api_key}`, "HTTP-Referer": "https://nvs-writing.workers.dev", "X-Title": "nvs-writing" },
      body: JSON.stringify({ model: s.model, messages, max_tokens: mt, temperature }),
    });
    if (!resp.ok) throw new Error(`LLM ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
    const data = await resp.json();
    return data.choices?.[0]?.message?.content ?? "";
  };
  // 429/5xx 自动退避重试（限流是常态）：最多 4 次，间隔 5/10/20/40s 带抖动
  for (let attempt = 0; ; attempt++) {
    try { return await doChat(maxTokens); }
    catch (e) {
      const m = /LLM (\d{3})/.exec(String(e.message));
      const retryable = m && (m[1] === "429" || Number(m[1]) >= 500);
      if (!retryable || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, [5000, 10000, 20000, 40000][attempt] * (0.8 + Math.random() * 0.4)));
    }
  }
}
async function logUsage(env, email, action, ok) {
  try { await env.DB.prepare("INSERT INTO ai_usage(user_email, action, ok) VALUES(?,?,?)").bind(email, action, ok ? 1 : 0).run(); } catch {}
}
async function bookOrNone(env, p, email) {
  return await env.DB.prepare("SELECT b.* FROM books b WHERE b.id=? AND b.owner_email=?").bind(p.id, email).first();
}

// ---------- 流水线：上下文组装（参考 context-agent：数据权重 章纲 > 前情 > 伏笔紧急度 > 角色状态） ----------
// 状态包（buildStatePack）统一喂给任务书：账本/声纹/卷摘在此一次性注入，任务书不再各查各的
async function buildTaskSheet(env, s, book, target, mode, statePack, antiAiRules) {
  // 本章章纲（outline_items 中 seq 最大且 pending 的；或指定 seq）
  let item = null;
  if (target?.outlineSeq) {
    item = (await env.DB.prepare("SELECT * FROM outline_items WHERE book_id=? AND seq=?").bind(book.id, target.outlineSeq).first()) || null;
  }
  if (!item) {
    item = (await env.DB.prepare("SELECT * FROM outline_items WHERE book_id=? AND status IN ('pending','in_progress') ORDER BY seq LIMIT 1").bind(book.id).first()) || null;
  }
  const loops = statePack.loops;
  const urgent = loops.filter((l) => l.urgency >= 80);
  const tocs = (await env.DB.prepare("SELECT seq, title, status FROM chapters WHERE book_id=? ORDER BY seq").bind(book.id).all()).results || [];

  const targetLine = item ? `第${target.seq}章 ${item.title}：${item.detail || "（无细节）"}` : `第${target.seq}章${target.title ? " " + target.title : ""}${target.outline_note ? "：" + target.outline_note : "（无章纲，按故事自然推进，必须产生情节推进）"}`;

  const system =
    "你是网文主编，负责写前 research 并输出五段写作任务书。写作铁律：大纲即法律（章纲目标不可偏离，无法完成时如实标注）、设定即物理（角色能力不得超过既有档案记录）、上章钩子必须回应。事实账本是跨章真源：任务书不得与账本条目矛盾。" +
    (mode === "fast" ? "快速模式：任务书精简为三段。" : "标准模式：五段完整任务书。");
  const user =
    `${statePack.pack}\n\n` +
    `【本章硬性约束】${targetLine}\n` +
    `【紧急伏笔（必须进入本章）】${urgent.length ? urgent.map((l) => `- ${l.content}`).join("\n") : "（无）"}\n` +
    `【全书章节进度】${tocs.length ? tocs.map((c) => `第${c.seq}章${c.status === "committed" ? "✓" : ""}`).join(" ") : "（尚无章节）"}\n` +
    (antiAiRules ? `【文风负面清单（任务书须转达给作者）】${antiAiRules}\n` : "") +
    (mode === "fast"
      ? "请输出三段任务书：①本章目标与禁区 ②出场人物状态与动机 ③节奏与结尾钩子方向。只输出任务书文本。"
      : "请输出五段写作任务书：①开篇委托（章号/标题/一句话目标）②这章的故事（前文承接、本章目标与阻力、必须覆盖与禁区、紧急伏笔处理）③这章的人物（每人：状态、驱动力、本章作用、说话倾向）④怎么写更顺（节奏、情绪走向、避免 AI 味）⑤收在哪里（结尾停在什么感觉、留什么未完感）。只输出任务书，自然语气，不要出现系统术语。");
  const out = await chat(env, s, [{ role: "system", content: system }, { role: "user", content: user }], { maxTokens: 4000, temperature: 0.4 });
  return { taskSheet: out, item, urgent };
}
// ---------- 状态包组装（写章前的一致性地基：前情/卷摘/角色声纹与状态/未回收伏笔/账本事实/章纲/负面清单） ----------
// 账本（ledger）是跨章事实真源：rule/knowledge/lineage 全量注入，state 取最近 30 条；
// 章节多时（>3）前情用卷级摘要（summaries）而非全量，控制上下文成本。
async function buildStatePack(env, book, target, antiAiRules) {
  const roles = (await env.DB.prepare("SELECT name, role_type, profile, voice, is_protagonist, state_note FROM roles WHERE book_id=? ORDER BY is_protagonist DESC, id").bind(book.id).all()).results || [];
  const loops = (await env.DB.prepare("SELECT content, urgency, planted_chapter FROM foreshadows WHERE book_id=? AND status='open' ORDER BY urgency DESC LIMIT 10").bind(book.id).all()).results || [];
  const ledger = (await env.DB.prepare("SELECT fact_type, subject, fact FROM ledger WHERE book_id=? AND status='active' AND fact_type IN ('rule','knowledge','lineage')").bind(book.id).all()).results || [];
  const ledgerState = (await env.DB.prepare("SELECT fact_type, subject, fact, chapter_seq FROM ledger WHERE book_id=? AND status='active' AND fact_type='state' ORDER BY chapter_seq DESC, id DESC LIMIT 30").bind(book.id).all()).results || [];
  const vols = (await env.DB.prepare("SELECT text FROM summaries WHERE book_id=? ORDER BY seq_to DESC LIMIT 2").bind(book.id).all()).results || [];
  const maxRow = await env.DB.prepare("SELECT MAX(seq) AS m FROM chapters WHERE book_id=?").bind(book.id).first();
  const prevCh = (await env.DB.prepare("SELECT seq, title, summary, hook FROM chapters WHERE book_id=? AND seq < ? AND summary != '' ORDER BY seq DESC LIMIT 3").bind(book.id, target.seq).all()).results || [];
  const prevs = [...prevCh].reverse();

  const parts = [];
  parts.push(`【故事梗概】${book.logline || "（未填写）"}`);
  if (book.world_setting) parts.push(`【世界观设定】${book.world_setting}`);
  if (vols.length) parts.push("【此前卷级摘要】" + vols.map((v) => String(v.text).slice(0, 600)).join("\n"));
  if (prevs.length) parts.push("【前情摘要（近3章）】" + prevs.map((c) => `第${c.seq}章 ${c.title}：${c.summary}${c.hook ? `｜钩子：${c.hook}` : ""}`).join("\n"));
  if (roles.length) parts.push("【角色档案】" + roles.map((r) => `${r.name}（${r.role_type}${r.is_protagonist ? "，主角" : ""}）：${r.profile || "无简介"}${r.voice ? `｜声纹：${r.voice}` : ""}${r.state_note ? `｜当前状态：${r.state_note}` : ""}`).join("\n"));
  if (loops.length) parts.push("【未回收伏笔】" + loops.map((l) => `- ${l.content}（第${l.planted_chapter || "?"}章埋设，紧急度${l.urgency}）`).join("\n"));
  const facts = [...ledger, ...ledgerState.map((f) => ({ ...f, seqNote: f.chapter_seq ? `（第${f.chapter_seq}章）` : "" }))];
  if (facts.length) parts.push("【事实账本（必须自洽，不得矛盾）】" + facts.map((f) => `- [${f.fact_type}]${f.subject ? f.subject + "：" : ""}${f.fact}${f.seqNote || ""}`).join("\n"));
  if (antiAiRules) parts.push("【文风负面清单（硬约束）】" + antiAiRules);
  return { pack: parts.join("\n") || "（无既有状态）", roles, loops, maxSeq: Number(maxRow?.m) || 0 };
}

// reasoning 模型（如 agnes）思考过程与正文共享 max_tokens 预算：预算不足会 finish_reason=length 且正文为空。
// 统一放大预算；起草类结果若为空再升预算重试一次。
function draftBudget(words) { return Math.min(12000, Math.max(4000, (Number(words) || 2000) * 4)); }

// ---------- 校验闭环（verify：初稿抽事实 → 对账本/设定 → 冲突则带反馈重生成一次，rejection sampling） ----------
// 只报可验证矛盾（死而复生/左右手反了/提前知晓/能力越界），不评价文笔；standard+fast 跑，minimal 跳过。
async function buildVerify(env, s, book, target, draft, statePack, antiAiRules) {
  const system =
    "你是跨章一致性校验员。从本章初稿中抽取关键事实断言（人物状态/生死/已知信息/时间线/地名/能力），逐条对照【状态包】中的事实账本、角色档案、世界观、前情摘要。" +
    "只报可验证的矛盾，每条必须有初稿证据与账本证据。禁止报风格问题、禁止报未发生的伏笔（伏笔埋设不算矛盾）。" +
    '只输出严格 JSON：{"conflicts":[{"severity":"hard|soft","draft_evidence":"初稿原句","source":"账本/设定/前情条目原文","explanation":"为何矛盾","fix_hint":"修复方向"}],"facts_extracted":N,"checked":N}。无冲突时 conflicts 为空数组。';
  const user =
    `${statePack.pack}\n\n【故事梗概】${book.logline}\n【世界观】${book.world_setting || "（无）"}\n` +
    `【本章初稿 第${target.seq}章】\n${draft}\n\n请校验并只输出 JSON。`;
  const out = await chat(env, s, [{ role: "system", content: system }, { role: "user", content: user }], { maxTokens: 2500, temperature: 0.1 });
  const parsed = extractJson(out) || null;
  const conflicts = (parsed?.conflicts || []).filter((c) => c && c.draft_evidence && c.severity === "hard");
  return { raw: out, parsed, conflicts };
}
// 带冲突反馈重生成（rejection sampling，最多一次，避免无限循环烧预算）
async function regenerateDraft(env, s, book, target, draft, taskSheet, statePack, antiAiRules, conflicts) {
  const system =
    '你是专业网文作者。初稿已写出，但一致性校验发现与既有设定/账本矛盾。只修改矛盾句段使其自洽，其余原样保留；不改剧情走向，不破坏钩子；严格遵守负面清单；只输出修复后的完整正文。';
  const user =
    `【写作任务书】\n${taskSheet}\n\n【状态包】\n${statePack.pack}\n\n` +
    (antiAiRules ? `【文风负面清单】\n${antiAiRules}\n\n` : "") +
    `【初稿 第${target.seq}章】\n${draft}\n\n【校验冲突（逐条消除）】\n${conflicts.map((c, n) => `${n + 1}. ${c.draft_evidence} ← 与「${c.source}」矛盾（${c.explanation}；方向：${c.fix_hint}）`).join("\n")}\n\n请定点修复后输出完整正文。`;
  return await chat(env, s, [{ role: "system", content: system }, { role: "user", content: user }], { maxTokens: draftBudget(target.words), temperature: 0.7 });
}

// ---------- 流水线：起草（writer：任务书 + 状态包 + 负面清单，纯正文，无占位符） ----------
async function buildDraft(env, s, book, target, taskSheet, statePack, antiAiRules) {
  const system =
    '你是专业网文作者。根据写作任务书与状态包直接起草本章正文。要求：纯中文正文，禁止输出思考过程/计划/解释/英文，禁止占位符（如"此处省略"）；围绕任务书的章节节点展开；每章必须有情节推进；章末留悬念钩子；严格遵守状态包（设定/角色状态/前情/伏笔），与账本事实矛盾即重写该段；对话按角色声纹写，避免所有人一个腔调；只输出正文。';
  const user =
    `【书名】${book.title}\n【故事梗概】${book.logline}\n\n【写作任务书】\n${taskSheet}\n\n` +
    `【状态包（写章前必须自洽）】\n${statePack.pack}\n\n` +
    (antiAiRules ? `【文风负面清单（逐条遵守）】\n${antiAiRules}\n\n` : "") +
    `【本章】第${target.seq}章 ${target.title || "（按任务书标题）"}\n请起草本章正文，约${target.words}字。`;
  const out = await chat(env, s, [{ role: "system", content: system }, { role: "user", content: user }], { maxTokens: draftBudget(target.words), temperature: 0.9 });
  if (out && out.trim()) return out;
  // reasoning 模型思考吃满预算 → 正文为空：升预算重试一次
  return await chat(env, s, [{ role: "system", content: system }, { role: "user", content: user }], { maxTokens: Math.min(16000, draftBudget(target.words) * 1.5), temperature: 0.85 });
}

// ---------- 流水线：五维审查（reviewer：严格 JSON，5 维度逐一结论） ----------
async function buildReview(env, s, book, target, draft, taskSheet) {
  const system =
    "你是章节事实审查员。只查 5 个维度：设定一致性(setting)、时间线(timeline)、叙事连贯(continuity)、角色一致性(character)、逻辑(logic)。" +
    "不评分、不评价文笔、不建议情节改动、不重复大纲内容；只报可验证问题，每条必须有 evidence。" +
    "只输出严格 JSON（无任何其他文本），结构：{\"chapter\":N,\"issues\":[{\"severity\":\"critical|high|medium|low\",\"category\":\"setting|timeline|continuity|character|logic\",\"location\":\"第N段或引用\",\"description\":\"问题描述\",\"evidence\":\"原文引用 vs 数据记录\",\"fix_hint\":\"修复方向\",\"blocking\":true}]," +
    "\"issues_count\":0,\"blocking_count\":0,\"has_blocking\":false,\"dimension_results\":[{\"dimension\":\"setting\",\"conclusion\":\"pass\"},...必须覆盖全部5维度，无问题写pass],\"summary\":\"N个问题：X个阻断，Y个高优\"}。blocking 仅用于 critical 或确认阻断项。";
  const user =
    `【设定基准】${book.world_setting || "（无）"}\n【任务书（含禁区与紧急伏笔）】${taskSheet}\n\n【本章正文 第${target.seq}章】\n${draft}\n\n请审查并只输出 JSON。`;
  const out = await chat(env, s, [{ role: "system", content: system }, { role: "user", content: user }], { maxTokens: 3000, temperature: 0.1 });
  let parsed = extractJson(out) || null;
  if (parsed && !Array.isArray(parsed.dimension_results)) parsed.dimension_results = [];
  return { raw: out, parsed };
}

// 定点修复 blocking（参考 Step 3 规则：不改剧情不破设定，只修 blocking；不重跑审查）
async function fixBlocking(env, s, book, target, draft, review) {
  const blocking = (review?.parsed?.issues || []).filter((i) => i.blocking);
  if (!blocking.length) return { content: draft, fixed: 0 };
  const system = "你是网文编辑。针对审查列出的阻断问题做定点修复：只修改对应句段，不改剧情走向、不违反设定。输出修复后的完整正文，只输出正文。";
  const user =
    `【本章正文 第${target.seq}章】\n${draft}\n\n【阻断问题清单】\n${blocking.map((i, n) => `${n + 1}. [${i.category}] ${i.location}：${i.description}（证据：${i.evidence}；方向：${i.fix_hint}）`).join("\n")}\n\n请定点修复后输出完整正文。`;
  const out = await chat(env, s, [{ role: "system", content: system }, { role: "user", content: user }], { maxTokens: draftBudget(target.words), temperature: 0.4 });
  return { content: out, fixed: blocking.length };
}

// ---------- 流水线：润色 + anti-AI 终检（参考 Step 4：只改表达不改事实；负面清单驱动） ----------
async function buildPolish(env, s, book, target, content, review, mode, antiAiRules) {
  if (mode === "minimal") return { content, skipped: true };
  const nonBlocking = (review?.parsed?.issues || []).filter((i) => !i.blocking);
  const system =
    '你是网文润色编辑。执行顺序：①修复非阻断审查问题 ②风格统一（口吻/视角）③排版（段落断行）④Anti-AI 终检（逐条执行负面清单：删套话、拆长句、具体化描写、保留对话个性、按声纹区分角色）。只改表达不改事实与情节。输出润色后的完整正文，只输出正文。';
  const user =
    `【本章正文 第${target.seq}章】\n${content}\n\n` +
    `【非阻断问题】${nonBlocking.length ? nonBlocking.map((i) => `- [${i.category}] ${i.description}（${i.fix_hint}）`).join("\n") : "（无）"}\n\n` +
    (antiAiRules ? `【文风负面清单（Anti-AI 终检逐条对照）】\n${antiAiRules}\n\n` : "") +
    `请润色后输出完整正文。`;
  const out = await chat(env, s, [{ role: "system", content: system }, { role: "user", content: user }], { maxTokens: draftBudget(target.words), temperature: 0.4 });
  return { content: out, skipped: false };
}

// ---------- 流水线：事实提取（data-agent：extraction_result schema + 事实账本 facts，唯一真源见参考项目） ----------
async function buildExtraction(env, s, book, target, finalContent) {
  const roles = (await env.DB.prepare("SELECT name FROM roles WHERE book_id=?").bind(book.id).all()).results || [];
  const openLoops = (await env.DB.prepare("SELECT content, planted_chapter FROM foreshadows WHERE book_id=? AND status='open' LIMIT 20").bind(book.id).all()).results || [];
  const system =
    "你是数据 agent，从章节正文提取可跨章复用的故事事实。只输出严格 JSON（无任何其他文本），顶层直接放这些键（禁止外包对象）：\n" +
    '{"summary_text":"100-150字剧情摘要","hook_type":"结尾钩子类型","hook_strength":"strong|medium|weak","accepted_events":[{"event_id":"evt-ch'+target.seq+'-001","chapter":'+target.seq+',"event_type":"枚举","subject":"主体名（用已知角色名，非 id）","payload":{}}],"state_deltas":[{"entity_id":"角色名","field":"realm","old":"旧","new":"新"}],"facts":[{"fact_type":"state|knowledge|rule|lineage|other","subject":"主体名","fact":"一句话事实（可跨章复用）"}],"entities_appeared":[{"id":"角色名","type":"角色","mentions":["称呼"],"confidence":0.9}]}.\n' +
    "event_type 枚举：character_state_changed / power_breakthrough / relationship_changed / world_rule_revealed / open_loop_created / open_loop_closed / promise_created / promise_paid_off / artifact_obtained。\n" +
    "payload 必备字段：open_loop_created→{content(必填),urgency(0-100:紧急≈100/一般≈50/远期≈20)}；open_loop_closed→{content,recycled_loops:[]}；character_state_changed→{field,old,new}；power_breakthrough→{field,old,new}。\n" +
    "facts 是跨章事实账本：state=人物状态变化；knowledge=谁知道了什么（subject=知情者，fact 注明'知道X'）；rule=揭示的世界规则；lineage=身世谱系。只写正文确实发生的，宁缺毋滥。\n" +
    "纪律：正文里每埋一条新伏笔必须写一条 open_loop_created 事件；回收了既有伏笔必须写 open_loop_closed；拿不准的不写（宁缺毋滥）；不虚构正文未出现的事实。";
  const user =
    `【本书已知角色】${roles.map((r) => r.name).join("、") || "（未登记）"}\n【既有未回收伏笔】${openLoops.map((l) => `- ${l.content}（第${l.planted_chapter}章）`).join("\n") || "（无）"}\n\n【本章正文 第${target.seq}章】\n${finalContent}\n\n请提取事实，只输出 JSON。`;
  const out = await chat(env, s, [{ role: "system", content: system }, { role: "user", content: user }], { maxTokens: 2500, temperature: 0.1 });
  return { raw: out, parsed: extractJson(out) };
}

// ---------- 确定性回写（参考 chapter-commit 判定：blocking>0 → rejected） ----------
async function commitWriteback(env, book, target, finalContent, review, extraction, title, outlineNote, mode) {
  const chapter = (await env.DB.prepare("SELECT * FROM chapters WHERE book_id=? AND seq=?").bind(book.id, target.seq).first()) || null;
  const blockingCount = (review?.parsed?.blocking_count !== undefined && review.parsed.has_blocking !== false) ? Math.max(1, review.parsed.blocking_count || 0) : ((review?.parsed?.issues || []).filter((i) => i.blocking).length);
  const accepted = blockingCount === 0;
  const status = accepted ? "committed" : "rejected";

  // 摘要 + 钩子（hook_type/hook_strength 来自 data-agent；无 extraction 则留空待手动补）
  const summary = extraction?.parsed?.summary_text || "";
  const hook = extraction?.parsed?.hook_type ? `【${extraction.parsed.hook_type}${extraction.parsed.hook_strength ? "/" + extraction.parsed.hook_strength : ""}】${(extraction.parsed.summary_text || "").slice(-80)}` : "";

  if (chapter) {
    await env.DB.prepare(
      "UPDATE chapters SET title=COALESCE(NULLIF(?, ''), title), content=?, status=?, summary=?, hook=?, review_json=?, outline_note=?, ai_kind=?, ai_prompt=?, updated_at=datetime('now') WHERE id=?"
    ).bind(title, finalContent, status, summary, hook, review?.parsed ? JSON.stringify(review.parsed) : "", outlineNote, "pipeline", target.outlineSeq ? "outline#" + target.outlineSeq : "auto", chapter.id).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO chapters(book_id, seq, title, content, status, summary, hook, review_json, outline_note, ai_kind, ai_prompt) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(book.id, target.seq, title, finalContent, status, summary, hook, review?.parsed ? JSON.stringify(review.parsed) : "", outlineNote, "pipeline", target.outlineSeq ? "outline#" + target.outlineSeq : "auto").run();
  }

  // 伏笔回写：open_loop_created → 新伏笔；open_loop_closed → 既有伏笔置 paid
  const events = extraction?.parsed?.accepted_events || [];
  let loopsPlanted = 0, loopsRecycled = 0;
  for (const ev of events) {
    const pl = ev.payload || {};
    if (ev.event_type === "open_loop_created" && pl.content) {
      await env.DB.prepare("INSERT INTO foreshadows(book_id, content, urgency, planted_chapter) VALUES(?,?,?,?)")
        .bind(book.id, String(pl.content).slice(0, 300), Math.min(100, Math.max(0, Number(pl.urgency) || 50)), target.seq).run();
      loopsPlanted++;
    } else if (ev.event_type === "open_loop_closed") {
      // 回收：按正文关键词匹配紧急度最高的未回收伏笔（确定性、不猜）
      const target2 = String(pl.content || pl.recycled_loop || "");
      if (target2) {
        const hit = (await env.DB.prepare("SELECT id FROM foreshadows WHERE book_id=? AND status='open' AND (content LIKE ?) ORDER BY urgency DESC LIMIT 1").bind(book.id, "%" + target2.slice(0, 20) + "%").first());
        if (hit) { await env.DB.prepare("UPDATE foreshadows SET status='paid', payoff_chapter=? WHERE id=?").bind(target.seq, hit.id).run(); loopsRecycled++; }
      } else {
        const top = (await env.DB.prepare("SELECT id FROM foreshadows WHERE book_id=? AND status='open' ORDER BY urgency DESC LIMIT 1").bind(book.id).first());
        if (top) { await env.DB.prepare("UPDATE foreshadows SET status='paid', payoff_chapter=? WHERE id=?").bind(target.seq, top.id).run(); loopsRecycled++; }
      }
    }
  }
  // 事件流落库（长期记忆 events）
  for (const ev of events) {
    if (ev.event_type) {
      await env.DB.prepare("INSERT INTO chapter_events(book_id, chapter_seq, event_type, subject, payload) VALUES(?,?,?,?,?)")
        .bind(book.id, target.seq, ev.event_type, String(ev.subject || ""), JSON.stringify(ev.payload || {})).run();
    }
  }
  // 角色状态回写：state_deltas / character_state_changed → roles.state_note
  const deltas = extraction?.parsed?.state_deltas || [];
  for (const d of deltas) {
    if (!d.entity_id || !d.new) continue;
    const note = `${d.field || "状态"}: ${d.old ? `${d.old}→` : ""}${d.new}`;
    const ex = await env.DB.prepare("SELECT id FROM roles WHERE book_id=? AND name=?").bind(book.id, d.entity_id).first();
    if (ex) await env.DB.prepare("UPDATE roles SET state_note=? WHERE id=?").bind(note.slice(0, 200), ex.id).run();
  }
  // 事实账本回写：facts（state/knowledge/rule/lineage）→ ledger（跨章一致性真源，写章前注入）
  const facts = extraction?.parsed?.facts || [];
  let factsStored = 0;
  const allowedTypes = ["state", "knowledge", "rule", "lineage", "other"];
  for (const f of facts) {
    if (!f.fact || !String(f.fact).trim()) continue;
    const ft = allowedTypes.includes(f.fact_type) ? f.fact_type : "other";
    await env.DB.prepare("INSERT INTO ledger(book_id, chapter_seq, fact_type, subject, fact, source) VALUES(?,?,?,?,?,?)")
      .bind(book.id, target.seq, ft, String(f.subject || "").slice(0, 60), String(f.fact).slice(0, 300), "ai").run();
    factsStored++;
  }
  // 大纲推进：本章对应的 outline item 状态推进（done 若 accepted，in_progress 若 rejected）
  if (target.outlineSeq) {
    await env.DB.prepare("UPDATE outline_items SET status=? WHERE book_id=? AND seq=?").bind(accepted ? "done" : "in_progress", book.id, target.outlineSeq).run();
  }
  return { status, blockingCount, loopsPlanted, loopsRecycled, events: events.length, summary, hook, factsStored };
}

// 完整流水线入口：POST /api/pipeline/run
// 一致性四层：状态包(state-pack) → 起草 → verify 校验闭环(rejection sampling) → 五维审查 → 润色(anti-AI) → 提取(含事实账本) → 回写
async function runPipeline(env, email, book, target) {
  const s = await getLlm(env, email);
  const t0 = Date.now();
  const steps = { mode: target.mode || "standard" };
  // 负面清单：书级优先，空则回退站点默认
  const antiAiRules = book.anti_ai_rules || (await getSetting(env, "anti_ai_default", ""));
  // Step 0 状态包（前情/卷摘/角色声纹与状态/未回收伏笔/账本事实）——写章前一致性地基
  const statePack = await buildStatePack(env, book, target, antiAiRules);
  // Step 1 任务书（喂状态包）
  const ctx = await buildTaskSheet(env, s, book, target, target.mode, statePack, antiAiRules);
  steps.step1_ms = Date.now() - t0;
  // Step 2 起草（喂任务书 + 状态包 + 负面清单）
  let draft = await buildDraft(env, s, book, target, ctx.taskSheet, statePack, antiAiRules);
  // N6：用量记账统一在路由层做（成功/失败各一条），这里不再单独记，避免双记
  if (!draft || !draft.trim()) throw new Error("起草正文为空（LLM 返回空），已中止，未落库。请重试或检查 LLM 配置。");
  steps.step2_ms = Date.now() - t0;
  // Step 2.5 校验闭环（standard+fast：verify 抽事实对账本 → hard 冲突则带反馈重生成一次）
  let verify = { conflicts: [], regenerated: false };
  if (target.mode !== "minimal") {
    try {
      verify = await buildVerify(env, s, book, target, draft, statePack, antiAiRules);
      if (verify.conflicts.length) {
        const redone = await regenerateDraft(env, s, book, target, draft, ctx.taskSheet, statePack, antiAiRules, verify.conflicts);
        if (redone && redone.trim()) { draft = redone; verify.regenerated = true; }
      }
    } catch (e) { verify = { conflicts: [], regenerated: false, error: String(e.message || e) }; }
  }
  steps.verify_ms = Date.now() - t0;
  // Step 3 审查（minimal 跳过；fast 也全跑 5 维，成本可控）
  let review = { parsed: null, raw: "" };
  if (target.mode !== "minimal") {
    review = await buildReview(env, s, book, target, draft, ctx.taskSheet);
  } else {
    review = { parsed: { chapter: target.seq, issues: [], issues_count: 0, blocking_count: 0, has_blocking: false, review_skipped: true, review_mode: "minimal", summary: "minimal 模式：跳过审查" }, raw: "" };
  }
  steps.step3_ms = Date.now() - t0;
  // blocking 定点修复
  let fixed = 0;
  if (target.mode !== "minimal") {
    const fr = await fixBlocking(env, s, book, target, draft, review);
    draft = fr.content; fixed = fr.fixed;
  }
  // Step 4 润色（负面清单驱动 anti-AI）
  const polish = await buildPolish(env, s, book, target, draft, review, target.mode, antiAiRules);
  let finalContent = polish.content;
  steps.step4_ms = Date.now() - t0;
  // 占位符终检（硬规则：禁止占位正文）—— 确定性检测，命中则降级状态
  const hasPlaceholder = /此处省略|（略）|\[占位\]|TODO|待补|未完待续处/.test(finalContent);
  // Step 5 事实提取（minimal 也提取摘要，保证回写链不断；含事实账本 facts）
  let extraction = null;
  try { extraction = await buildExtraction(env, s, book, target, finalContent); steps.step5_ms = Date.now() - t0; }
  catch (e) { extraction = { raw: "", parsed: null, error: String(e.message || e) }; }
  // Step 6 回写
  const title = target.title || ((ctx.item?.title) ? ctx.item.title : "第" + target.seq + "章");
  const wb = await commitWriteback(env, book, target, finalContent, review, extraction, title, target.outline_note || (ctx.item?.detail ? "" : ""), target.mode);
  if (hasPlaceholder) await env.DB.prepare("UPDATE chapters SET status='rejected' WHERE book_id=? AND seq=?").bind(book.id, target.seq).run();
  // 用量记录由路由层成功分支统一记一次（N6：原先此处与路由层各记一条，统计虚高）
  return {
    ok: true, mode: target.mode || "standard", seq: target.seq, title, status: hasPlaceholder ? "rejected" : wb.status,
    blockingCount: wb.blockingCount, fixed, verifyConflicts: verify.conflicts?.length || 0, verifyRegenerated: verify.regenerated ? 1 : 0,
    loopsPlanted: wb.loopsPlanted, loopsRecycled: wb.loopsRecycled, events: wb.events,
    hasPlaceholder, steps, ms: Date.now() - t0,
    summary: wb.summary, hook: wb.hook,
    content: finalContent,
    review: review.parsed,
    extraction: extraction?.parsed || null,
  };
}

// ---------- API ----------
async function getSetting(env, key, def = "") {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
  return row ? row.value : def;
}
async function setSetting(env, key, value) {
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=?").bind(key, value, value).run();
}
function requireInvite(env) { return true; } // settings.require_invite 在 register 内读

const api = {
  // ---- 认证（注册需注册码，管理员可关闭 require_invite） ----
  "POST /api/register": async (env, req) => {
    const b = await req.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase();
    const password = String(b.password || "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "邮箱格式不正确" }, 400);
    if (password.length < 6) return json({ error: "密码至少 6 位" }, 400);
    const exists = await env.DB.prepare("SELECT 1 FROM users WHERE email=?").bind(email).first();
    if (exists) return json({ error: "该邮箱已注册，请直接登录" }, 409);
    // 注册码闸门
    const requireInvite = (await getSetting(env, "require_invite", "1")) === "1";
    if (requireInvite) {
      const code = String(b.invite || "").trim().toUpperCase();
      if (!code) return json({ error: "需要注册码", code_required: true }, 400);
      const ic = await env.DB.prepare("SELECT * FROM invite_codes WHERE code=?").bind(code).first();
      if (!ic) return json({ error: "注册码无效" }, 403);
      if (ic.revoked) return json({ error: "注册码已作废" }, 403);
      if (ic.used_by) return json({ error: "注册码已被使用" }, 403);
      await env.DB.prepare("UPDATE invite_codes SET used_by=?, used_at=datetime('now') WHERE code=?").bind(email, code).run();
    }
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
    if (row.blocked) return json({ error: "账号已被停用" }, 403);
    if (!row.token) {
      const t = await genToken();
      await env.DB.prepare("UPDATE users SET token=? WHERE email=?").bind(t, email).run();
      row.token = t;
    }
    return json({ token: row.token, email });
  },
  "GET /api/me": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const row = await env.DB.prepare("SELECT email, created_at FROM users WHERE email=?").bind(email).first();
    const ann = await getSetting(env, "announcement", "");
    return json({ email, created_at: row?.created_at, announcement: ann, site_name: await getSetting(env, "site_name", "NVS 写作台") });
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

  // ---- 管理端：init 码创建首个管理员（admin_auth 空表时可用） ----
  "POST /api/admin/init": async (env, req) => {
    const b = await req.json().catch(() => ({}));
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_auth").first();
    if (row && row.n > 0) return json({ error: "管理员已存在，不能重复初始化" }, 409);
    const email = String(b.email || "admin").trim().toLowerCase();
    const password = String(b.password || "");
    if (password.length < 8) return json({ error: "管理员密码至少 8 位" }, 400);
    const salt = await genToken();
    const hash = await sha256hex(salt + ":" + email + ":" + password);
    await env.DB.prepare("INSERT INTO admin_auth(email, salt, hash) VALUES(?,?,?)").bind(email, salt, hash).run();
    const token = await genToken();
    await env.DB.prepare("INSERT INTO admin_tokens(admin_email, token) VALUES(?,?)").bind(email, token).run();
    return json({ ok: true, admin_email: email, token });
  },
  "POST /api/admin/login": async (env, req) => {
    const b = await req.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase();
    const row = await env.DB.prepare("SELECT * FROM admin_auth WHERE email=?").bind(email).first();
    if (!row) return json({ error: "管理员不存在" }, 401);
    const hash = await sha256hex(row.salt + ":" + email + ":" + String(b.password || ""));
    if (hash !== row.hash) return json({ error: "密码错误" }, 401);
    let t = (await env.DB.prepare("SELECT token FROM admin_tokens WHERE admin_email=?").bind(email).first())?.token;
    if (!t) {
      t = await genToken();
      await env.DB.prepare("INSERT INTO admin_tokens(admin_email, token) VALUES(?,?) ON CONFLICT(admin_email) DO UPDATE SET token=excluded.token").bind(email, t).run();
    }
    return json({ token: t, admin_email: email });
  },
  "GET /api/admin/stats": async (env, req, p, admin) => {
    if (!admin) return json({ error: "unauthorized" }, 401);
    const [users, books, chapters, usage, loops, invite] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM users").first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM books").first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM chapters").first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE ts >= datetime('now','-7 day')").first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM foreshadows WHERE status='open'").first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM invite_codes WHERE used_by IS NULL AND revoked=0").first(),
    ]);
    const topUsers = (await env.DB.prepare("SELECT user_email, COUNT(*) AS n FROM ai_usage WHERE user_email!='' GROUP BY user_email ORDER BY n DESC LIMIT 10").all()).results || [];
    return json({ users: users.n, books: books.n, chapters: chapters.n, usage7d: usage.n, open_loops: loops.n, free_codes: invite.n, top_users: topUsers });
  },
  "GET /api/admin/users": async (env, req, p, admin) => {
    if (!admin) return json({ error: "unauthorized" }, 401);
    const res = await env.DB.prepare(
      "SELECT u.email, u.blocked, u.created_at, (SELECT COUNT(*) FROM books b WHERE b.owner_email=u.email) AS books, (SELECT COUNT(*) FROM ai_usage a WHERE a.user_email=u.email) AS ai_calls FROM users u ORDER BY u.created_at DESC LIMIT 200"
    ).all();
    return json(res.results ?? []);
  },
  "POST /api/admin/users/:email/flag": async (env, req, p, admin) => {
    if (!admin) return json({ error: "unauthorized" }, 401);
    const b = await req.json().catch(() => ({}));
    const email2 = String(p.email).toLowerCase();
    // N4 修复：前端可能发字符串 '0'（JS 里为真值）——必须按数值解析
    const blocked = Number(b.blocked) ? 1 : 0;
    await env.DB.prepare("UPDATE users SET blocked=? WHERE email=?").bind(blocked, email2).run();
    if (blocked) await env.DB.prepare("UPDATE users SET token='' WHERE email=?").bind(email2).run();
    return json({ ok: true });
  },
  "POST /api/admin/codes": async (env, req, p, admin) => {
    if (!admin) return json({ error: "unauthorized" }, 401);
    const b = await req.json().catch(() => ({}));
    const n = Math.min(50, Math.max(1, Number(b.count) || 1));
    const codes = [];
    for (let i = 0; i < n; i++) {
      let c;
      for (let tries = 0; tries < 5; tries++) {
        c = "NV-" + (await genToken()).slice(0, 12).toUpperCase();
        const ex = await env.DB.prepare("SELECT 1 FROM invite_codes WHERE code=?").bind(c).first();
        if (!ex) break;
      }
      await env.DB.prepare("INSERT INTO invite_codes(code) VALUES(?)").bind(c).run();
      codes.push(c);
    }
    if (b.require !== undefined) await setSetting(env, "require_invite", b.require ? "1" : "0");
    return json({ codes, require_invite: (await getSetting(env, "require_invite", "1")) === "1" });
  },
  "GET /api/admin/codes": async (env, req, p, admin) => {
    if (!admin) return json({ error: "unauthorized" }, 401);
    const res = await env.DB.prepare("SELECT code, used_by, used_at, revoked, created_at FROM invite_codes ORDER BY created_at DESC LIMIT 200").all();
    const set = (await getSetting(env, "require_invite", "1")) === "1";
    return json({ codes: res.results ?? [], require_invite: set });
  },
  "POST /api/admin/codes/:code/revoke": async (env, req, p, admin) => {
    if (!admin) return json({ error: "unauthorized" }, 401);
    await env.DB.prepare("UPDATE invite_codes SET revoked=1 WHERE code=?").bind(String(p.code).toUpperCase()).run();
    return json({ ok: true });
  },
  "POST /api/admin/settings": async (env, req, p, admin) => {
    if (!admin) return json({ error: "unauthorized" }, 401);
    const b = await req.json().catch(() => ({}));
    for (const k of ["require_invite", "site_name", "announcement", "anti_ai_default"]) {
      if (b[k] !== undefined) await setSetting(env, k, String(b[k]));
    }
    return json({ ok: true });
  },
  "GET /api/admin/settings": async (env, req, p, admin) => {
    if (!admin) return json({ error: "unauthorized" }, 401);
    const out = {};
    for (const k of ["require_invite", "site_name", "announcement", "anti_ai_default"]) out[k] = await getSetting(env, k);
    return json(out);
  },
};

// ---- 用户数据路由：书 / 章 / 角色 / 伏笔 / 大纲 / 流水线 / LLM 设置 ----
Object.assign(api, {
  // ---- 书 ----
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
    const r = await env.DB.prepare("INSERT INTO books(owner_email, title, genre, logline, world_setting, characters) VALUES(?,?,?,?,?,?)").bind(email, b.title || "未命名", b.genre || "", b.logline || "", b.world_setting || "", b.characters || "").run();
    let id = Number(r.meta?.last_rowid);
    if (!id || Number.isNaN(id)) id = Number((await env.DB.prepare("SELECT MAX(id) AS m FROM books WHERE owner_email=?").bind(email).first())?.m ?? 0);
    return json({ id });
  },
  "GET /api/books/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const book = await bookOrNone(env, p, email);
    if (!book) return json({ error: "not found" }, 404);
    const [roles, loops, items, events] = await Promise.all([
      env.DB.prepare("SELECT * FROM roles WHERE book_id=? ORDER BY is_protagonist DESC, id").bind(p.id).all(),
      env.DB.prepare("SELECT * FROM foreshadows WHERE book_id=? ORDER BY urgency DESC, id").bind(p.id).all(),
      env.DB.prepare("SELECT * FROM outline_items WHERE book_id=? ORDER BY seq").bind(p.id).all(),
      env.DB.prepare("SELECT event_type, subject, payload, chapter_seq FROM chapter_events WHERE book_id=? ORDER BY chapter_seq DESC, id DESC LIMIT 30").bind(p.id).all(),
    ]);
    return json({ book, roles: roles.results || [], loops: loops.results || [], outline: items.results || [], events: events.results || [] });
  },
  "PATCH /api/books/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await bookOrNone(env, p, email);
    if (!own) return json({ error: "not found" }, 404);
    const b = await req.json().catch(() => ({}));
    const fields = ["title", "genre", "logline", "world_setting", "characters", "anti_ai_rules"];
    const sets = [], vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (sets.length) { vals.push(p.id); await env.DB.prepare(`UPDATE books SET ${sets.join(",")}, updated_at=datetime('now') WHERE id=?`).bind(...vals).run(); }
    return json({ ok: true });
  },
  "DELETE /api/books/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await bookOrNone(env, p, email);
    if (!own) return json({ error: "not found" }, 404);
    await env.DB.prepare("DELETE FROM chapters WHERE book_id=?").bind(p.id).run();
    await env.DB.prepare("DELETE FROM roles WHERE book_id=?").bind(p.id).run();
    await env.DB.prepare("DELETE FROM foreshadows WHERE book_id=?").bind(p.id).run();
    await env.DB.prepare("DELETE FROM outline_items WHERE book_id=?").bind(p.id).run();
    await env.DB.prepare("DELETE FROM chapter_events WHERE book_id=?").bind(p.id).run();
    await env.DB.prepare("DELETE FROM books WHERE id=?").bind(p.id).run();
    return json({ ok: true });
  },

  // ---- 章 ----
  "GET /api/books/:id/chapters": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    if (!(await bookOrNone(env, p, email))) return json({ error: "not found" }, 404);
    const res = await env.DB.prepare("SELECT id, book_id, seq, title, status, ai_kind, summary, hook, review_json, outline_note, created_at, updated_at FROM chapters WHERE book_id=? ORDER BY seq").bind(p.id).all();
    return json(res.results ?? []);
  },
  "POST /api/books/:id/chapters": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    if (!(await bookOrNone(env, p, email))) return json({ error: "not found" }, 404);
    const b = await req.json().catch(() => ({}));
    const maxRow = await env.DB.prepare("SELECT MAX(seq) AS m FROM chapters WHERE book_id=?").bind(p.id).first();
    const seq = (maxRow?.m || 0) + 1;
    // N3 修复：接受前端传来的空白章标题（原来 body 被丢弃，恒为「新章节」）
    const title = (b.title && String(b.title).trim()) || "新章节";
    const r = await env.DB.prepare("INSERT INTO chapters(book_id, seq, title) VALUES(?,?,?)").bind(p.id, seq, title).run();
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
      "UPDATE chapters SET title=COALESCE(?,title), content=COALESCE(?,content), summary=COALESCE(?,summary), hook=COALESCE(?,hook), status=COALESCE(?,status), updated_at=datetime('now') WHERE id=?"
    ).bind(b.title ?? null, b.content ?? null, b.summary ?? null, b.hook ?? null, b.status ?? null, p.id).run();
    return json({ ok: true });
  },
  "DELETE /api/chapters/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT c.id FROM chapters c JOIN books b ON c.book_id=b.id WHERE c.id=? AND b.owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    await env.DB.prepare("DELETE FROM chapters WHERE id=?").bind(p.id).run();
    return json({ ok: true });
  },

  // ---- 角色（设定集）----
  "POST /api/books/:id/roles": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    if (!(await bookOrNone(env, p, email))) return json({ error: "not found" }, 404);
    const b = await req.json().catch(() => ({}));
    if (!b.name || !String(b.name).trim()) return json({ error: "角色名必填" }, 400);
    const r = await env.DB.prepare("INSERT INTO roles(book_id, name, role_type, profile, voice, is_protagonist) VALUES(?,?,?,?,?,?)")
      .bind(p.id, String(b.name).trim(), b.role_type || "角色", b.profile || "", b.voice || "", b.is_protagonist ? 1 : 0).run();
    let id = Number(r.meta?.last_rowid);
    if (!id || Number.isNaN(id)) id = Number((await env.DB.prepare("SELECT MAX(id) AS m FROM roles").first())?.m ?? 0);
    return json({ id });
  },
  "PATCH /api/roles/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT r.id FROM roles r JOIN books b ON r.book_id=b.id WHERE r.id=? AND b.owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    const b = await req.json().catch(() => ({}));
    await env.DB.prepare(
      "UPDATE roles SET name=COALESCE(?,name), role_type=COALESCE(?,role_type), profile=COALESCE(?,profile), voice=COALESCE(?,voice), is_protagonist=COALESCE(?,is_protagonist), state_note=COALESCE(?,state_note) WHERE id=?"
    ).bind(b.name ?? null, b.role_type ?? null, b.profile ?? null, b.voice ?? null, b.is_protagonist === undefined ? null : (b.is_protagonist ? 1 : 0), b.state_note ?? null, p.id).run();
    return json({ ok: true });
  },
  "DELETE /api/roles/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT r.id FROM roles r JOIN books b ON r.book_id=b.id WHERE r.id=? AND b.owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    await env.DB.prepare("DELETE FROM roles WHERE id=?").bind(p.id).run();
    return json({ ok: true });
  },

  // ---- 伏笔（open_loop）----
  "POST /api/books/:id/loops": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    if (!(await bookOrNone(env, p, email))) return json({ error: "not found" }, 404);
    const b = await req.json().catch(() => ({}));
    if (!b.content || !String(b.content).trim()) return json({ error: "伏笔内容必填" }, 400);
    const r = await env.DB.prepare("INSERT INTO foreshadows(book_id, content, urgency, planted_chapter) VALUES(?,?,?,?)")
      .bind(p.id, String(b.content).trim(), Math.min(100, Math.max(0, Number(b.urgency) ?? 50)), Number(b.planted_chapter) || 0).run();
    let id = Number(r.meta?.last_rowid);
    if (!id || Number.isNaN(id)) id = Number((await env.DB.prepare("SELECT MAX(id) AS m FROM foreshadows").first())?.m ?? 0);
    return json({ id });
  },
  "PATCH /api/loops/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT f.id FROM foreshadows f JOIN books b ON f.book_id=b.id WHERE f.id=? AND b.owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    const b = await req.json().catch(() => ({}));
    await env.DB.prepare(
      "UPDATE foreshadows SET content=COALESCE(?,content), status=COALESCE(?,status), urgency=COALESCE(?,urgency), payoff_chapter=COALESCE(?,payoff_chapter) WHERE id=?"
    ).bind(b.content ?? null, b.status ?? null, b.urgency === undefined ? null : Number(b.urgency), b.payoff_chapter === undefined ? null : Number(b.payoff_chapter), p.id).run();
    return json({ ok: true });
  },
  "DELETE /api/loops/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT f.id FROM foreshadows f JOIN books b ON f.book_id=b.id WHERE f.id=? AND b.owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    await env.DB.prepare("DELETE FROM foreshadows WHERE id=?").bind(p.id).run();
    return json({ ok: true });
  },

  // ---- 大纲（章纲 = 法律）----
  "POST /api/books/:id/outline": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    if (!(await bookOrNone(env, p, email))) return json({ error: "not found" }, 404);
    const b = await req.json().catch(() => ({}));
    if (!b.title || !String(b.title).trim()) return json({ error: "标题必填" }, 400);
    // 支持批量：b.items = [{title, detail}]
    if (Array.isArray(b.items) && b.items.length) {
      const maxRow = await env.DB.prepare("SELECT MAX(seq) AS m FROM outline_items WHERE book_id=?").bind(p.id).first();
      let seq = Number(maxRow?.m) || 0;
      for (const it of b.items) {
        if (!it.title) continue;
        seq++;
        await env.DB.prepare("INSERT INTO outline_items(book_id, seq, title, detail) VALUES(?,?,?,?)")
          .bind(p.id, seq, String(it.title).trim(), it.detail || "").run();
      }
      return json({ ok: true, added: b.items.length });
    }
    const r = await env.DB.prepare("INSERT INTO outline_items(book_id, seq, title, detail) VALUES(?,?,?,?)")
      .bind(p.id, Number(b.seq) || 1, String(b.title).trim(), b.detail || "").run();
    let id = Number(r.meta?.last_rowid);
    if (!id || Number.isNaN(id)) id = Number((await env.DB.prepare("SELECT MAX(id) AS m FROM outline_items").first())?.m ?? 0);
    return json({ id });
  },
  "PATCH /api/outline/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT o.id FROM outline_items o JOIN books b ON o.book_id=b.id WHERE o.id=? AND b.owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    const b = await req.json().catch(() => ({}));
    await env.DB.prepare(
      "UPDATE outline_items SET title=COALESCE(?,title), detail=COALESCE(?,detail), status=COALESCE(?,status) WHERE id=?"
    ).bind(b.title ?? null, b.detail ?? null, b.status ?? null, p.id).run();
    return json({ ok: true });
  },
  "DELETE /api/outline/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT o.id FROM outline_items o JOIN books b ON o.book_id=b.id WHERE o.id=? AND b.owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    await env.DB.prepare("DELETE FROM outline_items WHERE id=?").bind(p.id).run();
    return json({ ok: true });
  },

  // ---- 事件流（只读，长期记忆）----
  "GET /api/books/:id/events": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    if (!(await bookOrNone(env, p, email))) return json({ error: "not found" }, 404);
    const res = await env.DB.prepare("SELECT * FROM chapter_events WHERE book_id=? ORDER BY chapter_seq DESC, id DESC LIMIT 100").bind(p.id).all();
    return json(res.results ?? []);
  },

  // ---- 事实账本 ledger（跨章一致性真源：AI 提取 + 人工校正；status: active/superseded/corrected）----
  "GET /api/books/:id/ledger": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    if (!(await bookOrNone(env, p, email))) return json({ error: "not found" }, 404);
    const res = await env.DB.prepare("SELECT * FROM ledger WHERE book_id=? ORDER BY fact_type, chapter_seq DESC, id DESC LIMIT 300").bind(p.id).all();
    return json(res.results ?? []);
  },
  "POST /api/books/:id/ledger": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    if (!(await bookOrNone(env, p, email))) return json({ error: "not found" }, 404);
    const b = await req.json().catch(() => ({}));
    if (!b.fact || !String(b.fact).trim()) return json({ error: "fact 必填" }, 400);
    const ft = ["state", "knowledge", "rule", "lineage", "other"].includes(b.fact_type) ? b.fact_type : "other";
    await env.DB.prepare("INSERT INTO ledger(book_id, chapter_seq, fact_type, subject, fact, source, status) VALUES(?,?,?,?,?,?,?)")
      .bind(p.id, Number(b.chapter_seq) || 0, ft, String(b.subject || "").slice(0, 60), String(b.fact).slice(0, 300), "manual", "active").run();
    return json({ ok: true });
  },
  "PATCH /api/ledger/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT l.id FROM ledger l JOIN books b ON l.book_id=b.id WHERE l.id=? AND b.owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    const b = await req.json().catch(() => ({}));
    await env.DB.prepare(
      "UPDATE ledger SET fact=COALESCE(?,fact), subject=COALESCE(?,subject), fact_type=COALESCE(?,fact_type), status=COALESCE(?,status), source=COALESCE(?,source) WHERE id=?"
    ).bind(b.fact ?? null, b.subject ?? null, ["state", "knowledge", "rule", "lineage", "other"].includes(b.fact_type) ? b.fact_type : null, b.status ?? null, b.status ? "corrected" : null, p.id).run();
    return json({ ok: true });
  },
  "DELETE /api/ledger/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT l.id FROM ledger l JOIN books b ON l.book_id=b.id WHERE l.id=? AND b.owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    await env.DB.prepare("UPDATE ledger SET status='superseded' WHERE id=?").bind(p.id).run();
    return json({ ok: true });
  },

  // ---- 卷级摘要 summaries（分层记忆：章节多了后 state-pack 注入摘要而非全量）----
  "GET /api/books/:id/summaries": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    if (!(await bookOrNone(env, p, email))) return json({ error: "not found" }, 404);
    const res = await env.DB.prepare("SELECT * FROM summaries WHERE book_id=? ORDER BY seq_from DESC").bind(p.id).all();
    return json(res.results ?? []);
  },
  // AI 生成卷摘要：把 from-to 章的 summary/content 压缩成 ~400 字卷摘（低温度）
  "POST /api/books/:id/summaries": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const book = await bookOrNone(env, p, email);
    if (!book) return json({ error: "not found" }, 404);
    const b = await req.json().catch(() => ({}));
    const from = Math.max(1, Number(b.from) || 1);
    const to = Math.max(from, Number(b.to) || from);
    const s = await getLlm(env, email);
    const chs = (await env.DB.prepare("SELECT seq, title, summary, content FROM chapters WHERE book_id=? AND seq BETWEEN ? AND ? ORDER BY seq").bind(p.id, from, to).all()).results || [];
    if (!chs.length) return json({ error: "该范围无章节" }, 400);
    const material = chs.map((c) => `第${c.seq}章 ${c.title}：${c.summary || (c.content || "").slice(0, 300)}`).join("\n");
    const out = await chat(env, s, [
      { role: "system", content: "你是网文编辑。把给定章节压缩成一段不超过 400 字的卷级摘要：只保留剧情推进/角色状态变化/关键揭示/伏笔埋收，去掉具体对白与场景细节。只输出摘要文本。" },
      { role: "user", content: `${book.title} 第${from}-${to}章：\n${material}\n\n请输出卷级摘要。` },
    ], { maxTokens: 1500, temperature: 0.3 });
    await logUsage(env, email, "ai:summarize", true);
    await env.DB.prepare("INSERT INTO summaries(book_id, level, seq_from, seq_to, text) VALUES(?,?,?,?,?)").bind(p.id, "volume", from, to, out.slice(0, 800)).run();
    return json({ ok: true, text: out.slice(0, 800) });
  },
  "PATCH /api/summaries/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT s.id FROM summaries s JOIN books b ON s.book_id=b.id WHERE s.id=? AND b.owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    const b = await req.json().catch(() => ({}));
    await env.DB.prepare("UPDATE summaries SET text=COALESCE(?,text) WHERE id=?").bind(b.text ?? null, p.id).run();
    return json({ ok: true });
  },
  "DELETE /api/summaries/:id": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const own = await env.DB.prepare("SELECT s.id FROM summaries s JOIN books b ON s.book_id=b.id WHERE s.id=? AND b.owner_email=?").bind(p.id, email).first();
    if (!own) return json({ error: "not found" }, 404);
    await env.DB.prepare("DELETE FROM summaries WHERE id=?").bind(p.id).run();
    return json({ ok: true });
  },

  // ---- 流水线（6 步链路：任务书→起草→审查→润色→提取→回写）----
  "POST /api/books/:id/pipeline": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const book = await bookOrNone(env, p, email);
    if (!book) return json({ error: "book not found" }, 404);
    const b = await req.json().catch(() => ({}));
    const maxRow = await env.DB.prepare("SELECT MAX(seq) AS m FROM chapters WHERE book_id=?").bind(p.id).first();
    const target = {
      seq: Number(b.seq) || ((maxRow?.m || 0) + 1),
      title: b.title || "",
      words: Number(b.words) || 2000,
      mode: ["standard", "fast", "minimal"].includes(b.mode) ? b.mode : "standard",
      outlineSeq: b.outlineSeq ? Number(b.outlineSeq) : 0,
      outline_note: b.outline_note || "",
    };
    const t = Date.now();
    let result;
    try {
      result = await runPipeline(env, email, book, target);
      await logUsage(env, email, `pipeline:${target.mode}`, true);
    } catch (e) {
      await logUsage(env, email, `pipeline:${target.mode}`, false);
      return json({ error: String(e.message || e), seq: target.seq }, 500);
    }
    return json(result);
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

  // ---- 便捷 AI 动作（旧版兼容 + 大纲生成入库）----
  "POST /api/ai/outline": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const s = await getLlm(env, email);
    // N2 修复：request body 只能读一次——原来 L766 读过、L778 又读一次（第二次必失败被 catch 吞掉，save 永远 undefined）
    const b = await req.json().catch(() => ({}));
    const bookId = b.bookId, extra = b.extra ?? "", count = b.count ?? 30, save = b.save;
    const book = await env.DB.prepare("SELECT * FROM books WHERE id=? AND owner_email=?").bind(bookId, email).first();
    if (!book) return json({ error: "book not found" }, 404);
    const msgs = [
      { role: "system", content: "你是网文策划。根据梗概输出章节大纲：每行一个章节，格式：N、章节标题｜本章要点。只输出大纲正文。" },
      { role: "user", content: `【故事梗概】${book.logline || "（未填写）"}\n【世界观】${book.world_setting || "（未填写）"}\n【主要角色】${(book.characters || "")}\n\n请生成 ${count} 章大纲。${extra ? `\n额外要求：${extra}` : ""}` },
    ];
    let out = "";
    try { out = await chat(env, s, msgs, { maxTokens: 3000, temperature: 0.9 }); await logUsage(env, email, "ai:outline", true); }
    catch (e) { await logUsage(env, email, "ai:outline", false); throw e; }
    // 大纲生成后自动入库为 outline_items（可写：b.save=true）
    let added = 0;
    if (bookId && save) {
      const lines = out.split("\n").map((l) => l.replace(/^\s*\d+[、.．,，]\s*/, "").trim()).filter((l) => l.length >= 2);
      for (const line of lines.slice(0, count)) {
        const [t, d] = line.split("｜").map((x) => x.trim());
        await env.DB.prepare("INSERT INTO outline_items(book_id, seq, title, detail) VALUES(?,?,?,?)")
          .bind(bookId, (await env.DB.prepare("SELECT COALESCE(MAX(seq),0)+1 AS s FROM outline_items WHERE book_id=?").bind(bookId).first()).s, t, d || "").run();
        added++;
      }
    }
    return json({ text: out, added });
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

  // ---- 导出（小说成品：TXT/MD/HTML/EPUB + 范围 + 附加资料） ----
  "GET /api/books/:id/export": async (env, req, p, email) => {
    if (!email) return json({ error: "unauthorized" }, 401);
    const book = await bookOrNone(env, p, email);
    if (!book) return json({ error: "not found" }, 404);
    const url = new URL(req.url);
    const q = url.searchParams;
    const fmt = ["txt", "md", "html", "epub"].includes(q.get("format")) ? q.get("format") : "txt";
    const from = Math.max(1, Number(q.get("from")) || 1);
    const to = Number(q.get("to")) || 0;
    const includeRoles = q.get("attach_roles") === "1";
    const includeLoops = q.get("attach_loops") === "1";
    const includeOutline = q.get("attach_outline") === "1";
    const includeWorld = q.get("attach_world") === "1";
    // 章内容（含 rejected，导出是作者全权）
    let chs = (await env.DB.prepare("SELECT seq, title, content, status, summary FROM chapters WHERE book_id=? ORDER BY seq").bind(book.id).all()).results || [];
    chs = chs.filter((c) => c.seq >= from && (!to || c.seq <= to));
    const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const para = (s) => String(s ?? "").trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const head = `《${book.title}》${book.genre ? "（" + book.genre + "）" : ""}\n\n${book.logline || ""}`;
    let roles = [], loops = [], outlines = [];
    if (includeRoles) roles = (await env.DB.prepare("SELECT name, role_type, profile, state_note FROM roles WHERE book_id=? ORDER BY is_protagonist DESC, id").bind(book.id).all()).results || [];
    if (includeLoops) loops = (await env.DB.prepare("SELECT content, status, planted_chapter, payoff_chapter, urgency FROM foreshadows WHERE book_id=? ORDER BY urgency DESC").bind(book.id).all()).results || [];
    if (includeOutline) outlines = (await env.DB.prepare("SELECT seq, title, detail, status FROM outline_items WHERE book_id=? ORDER BY seq").bind(book.id).all()).results || [];
    let extras = "";
    if (includeWorld && book.world_setting) extras += "\n\n—— 世界观设定 ——\n" + book.world_setting + "\n";
    if (roles.length) extras += "\n\n—— 角色档案 ——\n" + roles.map((r) => `${r.name}（${r.role_type}）：${r.profile || "无简介"}${r.state_note ? "｜状态：" + r.state_note : ""}`).join("\n") + "\n";
    if (loops.length) extras += "\n\n—— 伏笔清单 ——\n" + loops.map((l) => `[${l.status === "paid" ? "已回收" : "未回收"}] ${l.content}（第${l.planted_chapter || "?"}章${l.payoff_chapter ? "→第" + l.payoff_chapter + "章回收" : ""}）`).join("\n") + "\n";
    if (outlines.length) extras += "\n\n—— 全书大纲 ——\n" + outlines.map((o) => `${o.seq}、${o.title}${o.detail ? "：" + o.detail : ""}`).join("\n") + "\n";

    let payload, mime, ext;
    if (fmt === "txt") {
      payload = [head, "", ...chs.map((c) => `第${c.seq}章 ${c.title || ""}\n\n${c.content || "(本章暂无正文)"}`), extras].join("\n\n");
      mime = "text/plain;charset=utf-8"; ext = "txt";
    } else if (fmt === "md") {
      payload = [
        `# ${book.title}`,
        book.genre ? `> ${book.genre}` : null,
        book.logline ? `> ${book.logline}` : null,
        "",
        ...chs.map((c) => `## 第${c.seq}章 ${c.title || ""}\n\n${c.content || "(本章暂无正文)"}`),
        includeWorld && book.world_setting ? `# 世界观设定\n\n${book.world_setting}` : "",
        roles.length ? `# 角色档案\n\n${roles.map((r) => `- **${r.name}**（${r.role_type}）：${r.profile || "无简介"}${r.state_note ? "（状态：" + r.state_note + "）" : ""}`).join("\n")}` : "",
        loops.length ? `# 伏笔清单\n\n${loops.map((l) => `- [${l.status === "paid" ? "已回收" : "未回收"}] ${l.content}（第${l.planted_chapter || "?"}章${l.payoff_chapter ? "→第" + l.payoff_chapter + "章回收" : ""}）`).join("\n")}` : "",
        outlines.length ? `# 全书大纲\n\n${outlines.map((o) => `${o.seq}、${o.title}${o.detail ? "：" + o.detail : ""}`).join("\n")}` : "",
      ].filter(Boolean).join("\n\n");
      mime = "text/markdown;charset=utf-8"; ext = "md";
    } else if (fmt === "html") {
      const chsHtml = chs.map((c) => `<h2>第${c.seq}章 ${esc(c.title || "")}</h2>${(c.content || "").split("\n\n").map((para2) => `<p>${esc(para2)}</p>`).join("")}`).join("\n");
      const extraHtml =
        (includeWorld && book.world_setting ? `<h1>世界观设定</h1><p>${esc(book.world_setting)}</p>` : "") +
        (roles.length ? `<h1>角色档案</h1><ul>${roles.map((r) => `<li><b>${esc(r.name)}</b>（${esc(r.role_type)}）：${esc(r.profile || "无简介")}${r.state_note ? "｜状态：" + esc(r.state_note) : ""}</li>`).join("")}</ul>` : "") +
        (loops.length ? `<h1>伏笔清单</h1><ul>${loops.map((l) => `<li>[${l.status === "paid" ? "已回收" : "未回收"}] ${esc(l.content)}（第${l.planted_chapter || "?"}章）</li>`).join("")}</ul>` : "") +
        (outlines.length ? `<h1>全书大纲</h1><ol>${outlines.map((o) => `<li><b>${esc(o.title)}</b>${o.detail ? "：" + esc(o.detail) : ""}</li>`).join("")}</ol>` : "");
      payload = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(book.title)}</title><style>body{font:16px/1.8 'Noto Serif SC',serif;max-width:800px;margin:auto;padding:24px}h1{color:#2064d8}h2{border-bottom:1px solid #ccc;margin-top:2em}.tag{color:#888}</style></head><body><h1>${esc(book.title)}</h1><p class="tag">${esc(book.genre || "")}${book.logline ? "：" + esc(book.logline) : ""}</p>${chsHtml}${extraHtml}</body></html>`;
      mime = "text/html;charset=utf-8"; ext = "html";
    } else {
      // EPUB：mimetype（零压缩、必须位于 0 偏移）+ container.xml + content.opf + ncx + nav + 章节 xhtml
      // Workers 无 zip 库 → 手写 ZIP（STORE）；无 Buffer（未开 nodejs_compat）→ 纯 Uint8Array
      const encStr = (s) => new TextEncoder().encode(s);
      const concatBytes = (arrs) => { const total = arrs.reduce((a, b) => a + b.length, 0); const out = new Uint8Array(total); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
      const f = [];
      f.push([encStr("application/epub+zip"), "mimetype"]);
      f.push([encStr('<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'), "META-INF/container.xml"]);
      const chItems = chs.map((c, i) => `<item id="c${i + 1}" href="c${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join("\n      ");
      const spineRefs = chs.map((c, i) => `<itemref idref="c${i + 1}"/>`).join("\n      ");
      const ncx = `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtdepth" content="1"/></head><docTitle><text>${esc(book.title)}</text></docTitle><navMap>${chs.map((c, i) => `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>第${c.seq}章 ${esc(c.title || "")}</text></navLabel><content src="c${i + 1}.xhtml"/></navPoint>`).join("\n")}</navMap></ncx>`;
      const nav = `<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>${chs.map((c, i) => `<li><a href="c${i + 1}.xhtml">第${c.seq}章 ${esc(c.title || "")}</a></li>`).join("\n")}</ol></nav></body></html>`;
      const opf = `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="btitle"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(book.title)}</dc:title><dc:language>zh</dc:language><dc:identifier id="btitle">urn:uuid:nvs-book-${String(book.id)}</dc:identifier></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtncx+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chItems}</manifest><spine toc="ncx">${spineRefs}</spine></package>`;
      const chXml = chs.map((c, i) => `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第${c.seq}章</title></head><body><h2>第${c.seq}章 ${esc(c.title || "")}</h2>${(c.content || "").split("\n\n").map((para2) => `<p>${esc(para2)}</p>`).join("")}</body></html>`);
      const addX = (name, content) => f.push([encStr(content), "OEBPS/" + name]);
      addX("content.opf", opf); addX("toc.ncx", ncx); addX("nav.xhtml", nav);
      chXml.forEach((x, i) => addX(`c${i + 1}.xhtml`, x));
      const extrasXml = [];
      if (includeWorld && book.world_setting) extrasXml.push(`<h1>世界观设定</h1><p>${esc(book.world_setting)}</p>`);
      if (roles.length) extrasXml.push(`<h1>角色档案</h1><ul>${roles.map((r) => `<li><b>${esc(r.name)}</b>（${esc(r.role_type)}）：${esc(r.profile || "无简介")}</li>`).join("")}</ul>`);
      if (loops.length) extrasXml.push(`<h1>伏笔清单</h1><ul>${loops.map((l) => `<li>[${l.status === "paid" ? "已回收" : "未回收"}] ${esc(l.content)}</li>`).join("")}</ul>`);
      if (outlines.length) extrasXml.push(`<h1>全书大纲</h1><ol>${outlines.map((o) => `<li>${esc(o.title)}</li>`).join("")}</ol>`);
      if (extrasXml.length) addX("extras.xhtml", `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>资料</title></head><body>${extrasXml.join("")}</body></html>`);
      // 手写 ZIP（STORE，LE）：mimetype 必须在偏移 0 且零压缩
      let crcTable;
      const crc32 = (buf) => {
        if (!crcTable) { crcTable = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; } }
        let crc = 0xffffffff;
        for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
      };
      const parts = []; const central = []; let offset = 0;
      for (const [data, name] of f) {
        const nb = encStr(name), crc = crc32(data);
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, 0, true);
        lh.setUint16(10, 0, true); lh.setUint16(12, 0, true); lh.setUint32(14, crc, true);
        lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
        parts.push(new Uint8Array(lh.buffer), nb, data);
        const ch2 = new DataView(new ArrayBuffer(46));
        ch2.setUint32(0, 0x02014b50, true); ch2.setUint16(4, 20, true); ch2.setUint16(6, 20, true); ch2.setUint16(8, 0, true);
        ch2.setUint16(10, 0, true); ch2.setUint16(12, 0, true); ch2.setUint16(14, 0, true);
        ch2.setUint32(16, crc, true);
        ch2.setUint32(20, data.length, true); ch2.setUint32(24, data.length, true); ch2.setUint16(28, nb.length, true);
        ch2.setUint32(42, offset, true);
        central.push(new Uint8Array(ch2.buffer), nb);
        offset += 30 + nb.length + data.length;
      }
      const cd = concatBytes(central);
      const eocd = new DataView(new ArrayBuffer(22));
      eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(4, 0, true); eocd.setUint16(6, 0, true);
      eocd.setUint16(8, f.length, true); eocd.setUint16(10, f.length, true);
      eocd.setUint32(12, cd.length, true); eocd.setUint32(16, offset, true);
      payload = concatBytes([concatBytes(parts), cd, new Uint8Array(eocd.buffer)]);
      mime = "application/epub+zip"; ext = "epub";
    }
    // 文件名：filename*（RFC 5987）保留中文原名；filename（ASCII 回退）取纯 ASCII 书名
    const asciiTitle = ((book.title || "novel").replace(/[^\x20-\x7e]/g, "").replace(/[\\/:*?"<>|]/g, "_") || "novel");
    const rangeTag = to ? "_" + from + "-" + to : "_ch" + String(from) + "plus";
    const displayFilename = ((book.title || "novel").replace(/[\\/:*?"<>|]/g, "_") + rangeTag + "." + ext);
    const asciiFilename = asciiTitle + rangeTag + "." + ext;
    const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
    return new Response(bytes, { headers: { "Content-Type": mime, "Access-Control-Allow-Origin": "***", "Content-Disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(displayFilename)}`, "Content-Length": String(bytes.length) } });
  },
});
// ---------- 前端（统一 UI：三端响应式 + 昼夜主题 + 角色/伏笔/大纲管理 + 流水线 + 管理端） ----------
const HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NVS 写作台</title>
<style>
:root,[data-theme="day"]{--bg:#f5f6f8;--panel:#ffffff;--panel2:#eef0f4;--line:#d8dce2;--tx:#1c222b;--mut:#5d6675;--acc:#2064d8;--ok:#1f8a4c;--warn:#a8791a;--bad:#c03838}
[data-theme="night"]{--bg:#111418;--panel:#1a1f26;--panel2:#212832;--line:#2a313b;--tx:#d7dde5;--mut:#8b95a3;--acc:#4da3ff;--ok:#3fb96f;--warn:#e0b341;--bad:#e05d5d}
*{box-sizing:border-box}body{margin:0;font:14px/1.7 -apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;background:var(--bg);color:var(--tx)}
#app{display:grid;grid-template-columns:300px 1fr;grid-template-rows:auto 1fr;height:100vh}
header{grid-column:1/3;background:var(--panel);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;padding:10px 16px}
header h1{font-size:16px;margin:0;flex:1}header .mut{color:var(--mut);font-size:12px}
aside{background:var(--panel);border-right:1px solid var(--line);overflow-y:auto;padding:12px}
main{overflow-y:auto;padding:16px}
button{background:var(--panel2);border:1px solid var(--line);color:var(--tx);border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff}
button.danger{border-color:var(--bad);color:var(--bad)}
input,textarea,select{background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:6px;padding:7px 9px;font:inherit;width:100%}
label{color:var(--mut);font-size:12px;display:block;margin:10px 0 4px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px}
.card h3{margin:0 0 8px;font-size:14px}
.chips span{display:inline-block;border:1px solid var(--line);border-radius:12px;padding:2px 10px;margin:2px 4px 2px 0;font-size:12px}
.badge{font-size:11px;padding:1px 8px;border-radius:8px;background:var(--panel2);color:var(--mut)}
.badge.ok{color:var(--ok);border:1px solid var(--ok)}.badge.bad{color:var(--bad);border:1px solid var(--bad)}.badge.warn{color:var(--warn);border:1px solid var(--warn)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
.thumbs{color:var(--mut);font-size:12px}.tabbar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.tabbar button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--panel2);border-radius:8px;padding:10px;font-size:13px}
.muted{color:var(--mut)}.small{font-size:12px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
.progress{height:6px;background:var(--panel2);border-radius:3px;overflow:hidden;margin:6px 0}.progress i{display:block;height:100%;background:var(--acc);transition:width .3s}
#authPane{position:fixed;inset:0;z-index:50;display:none;place-items:center;background:rgba(0,0,0,.55)}
#authPane .card{max-width:360px;width:92%}
#authEdit{display:none;margin-top:10px;border-top:1px solid var(--line);padding-top:8px}
#exportPanel{margin-top:8px;border-top:1px dashed var(--line);padding-top:8px}
#authPane input{margin:4px 0}
#stageList div{padding:3px 0}
@media(max-width:1100px){#app{grid-template-columns:260px 1fr}}
@media(max-width:820px){#app{grid-template-columns:1fr;grid-template-rows:auto auto 1fr}aside{border-right:none;border-bottom:1px solid var(--line);max-height:280px}#mobileBooks{display:block}}
@media(max-width:520px){main{padding:10px}header .mut{display:none}}
</style></head><body><div id="app">
<header>
  <h1 id="siteName">NVS 写作台</h1>
  <button id="btnAuth">登录 / 注册</button>
  <span class="mut" id="who"></span>
  <button id="btnTheme" title="昼夜切换">◐</button>
  <button id="btnAdmin">管理</button>
  <button id="btnOut">退出</button>
</header>
<aside><div id="mobileBooks"></div>
  <div id="dataPane">
    <div class="row"><button class="primary" id="btnNewBook">＋ 新建书</button></div>
    <div id="bookList"></div>
  </div>
</aside>
<main>
  <div id="view" class="muted">先登录，再新建或选择一本书。</div>
</main>
</div>
<div id="authPane">
  <div class="card">
    <h3>登录 / 注册</h3>
    <label>邮箱</label><input id="liEmail">
    <label>密码</label><input id="liPass" type="password">
    <label>注册码（仅注册需）</label><input id="liInvite" placeholder="NV-XXXX">
    <div class="row" style="margin-top:10px">
      <button class="primary" id="btnLogin">登录</button>
      <button id="btnReg">注册（需码）</button>
      <button id="btnLoginClose" style="margin-left:auto">关闭</button>
    </div>
    <div id="authMsg" class="muted small" style="margin-top:8px"></div>
  </div>
</div>
<script>
let TK=localStorage.getItem('nvs_token')||'', EMAIL=localStorage.getItem('nvs_email')||'', ADMIN=null, BK=null, TAB='chapters';
const $=s=>document.querySelector(s);
function toast(m,t){const d=document.createElement('div');d.className='card '+(t==='bad'?'':'');d.style.animation='none';d.innerHTML=m;$('#view').prepend(d);setTimeout(()=>d.remove(),4000);}
async function api(path,opt={}){
  const r=await fetch(path,{method:opt.method||'GET',headers:{'Content-Type':'application/json',...(TK?{Authorization:'Bearer '+TK}:{})},body:opt.body?JSON.stringify(opt.body):undefined});
  let b;try{b=await r.json()}catch{b={}}
  if(!r.ok){const e=b.error||('HTTP '+r.status);const err=new Error(e);err.data=b;if(b.code_required)err.codeRequired=true;throw err}
  return b;
}
function save(){localStorage.setItem('nvs_token',TK);localStorage.setItem('nvs_email',EMAIL)}
function logout(){TK='';EMAIL='';ADMIN=null;BK=null;localStorage.clear();location.reload()}

// ---- 昼夜主题 ----
function setTheme(t){document.documentElement.setAttribute('data-theme',t);localStorage.setItem('nvs_theme',t)}
setTheme(localStorage.getItem('nvs_theme')||'night');
$('#btnTheme').onclick=()=>setTheme(document.documentElement.getAttribute('data-theme')==='day'?'night':'day');

// ---- 认证 ----
function setAuthUI(logged){ $('#btnAuth').style.display=logged?'none':''; $('#btnOut').style.display=logged?'':'none'; $('#who').textContent=logged?EMAIL:''; }
async function afterLogin(){
  const me=await api('/api/me').catch(()=>({}));EMAIL=me.email||EMAIL;save();
  if(me.site_name)$('#siteName').textContent=me.site_name;
  if(me.announcement)toast('<b>公告</b><br>'+me.announcement);
  $('#authPane').style.display='none';$('#dataPane').style.display='';setAuthUI(true);
  await loadBooks();
}
$('#btnAuth').onclick=()=>showLogin();
$('#btnLogin').onclick=async()=>{try{const b=await api('/api/login',{method:'POST',body:{email:$('#liEmail').value,password:$('#liPass').value}});TK=b.token;EMAIL=b.email;save();$('#authPane').style.display='none';await afterLogin()}catch(e){$('#authMsg').textContent=e.message}};
$('#btnReg').onclick=async()=>{try{const b=await api('/api/register',{method:'POST',body:{email:$('#liEmail').value,password:$('#liPass').value,invite:$('#liInvite').value}});TK=b.token;EMAIL=b.email;save();$('#authPane').style.display='none';await afterLogin()}catch(e){$('#authMsg').textContent=e.message}};
$('#btnLoginClose').onclick=()=>{$('#authPane').style.display='none';$('#authMsg').textContent=''};
$('#btnOut').onclick=logout;

async function loadBooks(){
  const books=await api('/api/books');
  const mk=bs=>{const el=document.createElement('div');el.className='card';el.innerHTML=\`<b>\${bs.title}</b> <span class="badge">\${bs.chapter_count} 章</span>\`;el.onclick=()=>openBook(bs.id,bs.title);return el}
  const c=$('#bookList');c.innerHTML='';books.forEach(b=>c.appendChild(mk(b)));
  const m=$('#mobileBooks');m.innerHTML='';books.forEach(b=>{const el=document.createElement('button');el.className='on';el.textContent=b.title;el.style.cssText='display:block;width:100%;text-align:left;margin:4px 0';el.onclick=()=>openBook(b.id,b.title);m.appendChild(el)});
  return books;
}
$('#btnNewBook').onclick=async()=>{const t=prompt('书名：');if(!t)return;const g=prompt('题材（武侠/都市/科幻…）：')||'';const l=prompt('一句话梗概：')||'';const b=await api('/api/books',{method:'POST',body:{title:t,genre:g,logline:l}});toast('已创建书 #'+b.id);await loadBooks();openBook(b.id,t)};

// ---- 主视图 ----
async function openBook(id,title){
  BK=id;TAB='chapters';
  const d=await api('/api/books/'+id);
  const main=$('#view');
  main.innerHTML=\`
  <div class="card"><b>\${d.book.title}</b> <span class="badge">\${d.book.genre||'未分题材'}</span>
    <div class="row"><button class="primary" id="vPipe">⚡ 一键写下一章</button><button id="vPipeFast">快速</button><button id="vPipeMin">极简</button><button id="vOutline">生成大纲</button><button id="vExpand">扩设定</button><button id="vAnti">AI味清单</button><button id="vExport">导出小说</button></div>
    <div class="small muted">一致性四层：状态包（账本/声纹/卷摘）→ 起草 → 校验闭环 → 五维审查 · 润色去AI味 · 事实提取回写</div>
    \${d.book.world_setting?\`<details><summary><b>世界观设定</b></summary><pre>\${d.book.world_setting}</pre></details>\`:''}
    \${d.book.characters?\`<details><summary><b>角色设定</b></summary><pre>\${d.book.characters}</pre></details>\`:''}
  </div>
  <div class="tabbar">
    \${['chapters:章节','roles:角色','loops:伏笔','outline:大纲','events:事件流','ledger:事实账本','sums:卷摘要'].map(t=>{const k=t.split(':');return \`<button data-tab="\${k[0]}" class="tb \${k[0]===TAB?'on':''}">\${k[1]}</button>\`}).join('')}
  </div>
  <div id="tabBody"></div>
  <div id="pipePanel" style="display:none"></div><div id="exportPanel"></div>\`;
  main.querySelectorAll('.tb').forEach(b=>b.onclick=()=>{TAB=b.dataset.tab;main.querySelectorAll('.tb').forEach(x=>x.classList.toggle('on',x===b));renderTab()});
  $('#vPipe').onclick=()=>runPipe('standard');$('#vPipeFast').onclick=()=>runPipe('fast');$('#vPipeMin').onclick=()=>runPipe('minimal');
  $('#vOutline').onclick=genOutline;$('#vExpand').onclick=expandSetting;$('#vAnti').onclick=editAnti;$('#vExport').onclick=showExportPanel;
  await renderTab();
}
function renderTab(){return TAB==='chapters'?tabChapters():TAB==='roles'?tabRoles():TAB==='loops'?tabLoops():TAB==='outline'?tabOutline():TAB==='events'?tabEvents():TAB==='ledger'?tabLedger():tabSums()}

async function tabChapters(){
  const cs=await api(\`/api/books/\${BK}/chapters\`);
  $('#tabBody').innerHTML=\`<div class="card"><b>共 \${cs.length} 章</b>（committed=已通过审查回写，rejected=有阻断待处理）
    <div id="chList"></div>
    <div class="row"><input id="chNew" placeholder="手动新章标题（可选，不填走流水线）" style="flex:1"><button class="primary" id="chNewBtn">＋ 空白章</button></div>
  </div>\`;
  const list=$('#chList');
  list.innerHTML=cs.length?'<table><tr><th>#</th><th>标题</th><th>状态</th><th>摘要/钩子</th><th></th></tr>'+cs.map(c=>\`
    <tr data-id="\${c.id}"><td>\${c.seq}</td><td>\${c.title||''}</td>
    <td><span class="badge \${c.status==='committed'?'ok':c.status==='rejected'?'bad':'warn'}">\${c.status||'draft'}</span></td>
    <td class="small muted">\${(c.summary||'').slice(0,50)}\${c.hook?'<br>钩：'+(c.hook||'').slice(0,40):''}</td>
    <td><button class="ev" data-id="\${c.id}">读</button> <button class="ed" data-id="\${c.id}">编</button> <button class="del" data-id="\${c.id}">删</button></td></tr>\`).join('')+'</table>':'<div class="muted">尚无章节。点「⚡ 一键写下一章」启动 6 步流水线。</div>';
  list.querySelectorAll('.ev').forEach(b=>b.onclick=async()=>{const r=await api('/api/chapters/'+b.dataset.id);toast(\`<b>第\${r.seq}章 \${r.title}</b><br><pre>\${r.content||'(空)'}</pre>\${r.review_json?'<b>审查</b><pre>'+JSON.stringify(JSON.parse(r.review_json),null,1).slice(0,600)+'</pre>':''}\`)});
  list.querySelectorAll('.del').forEach(b=>b.onclick=async()=>{if(!confirm('删除此章？'))return;await api('/api/chapters/'+b.dataset.id,{method:'DELETE'});tabChapters()});
  list.querySelectorAll('.ed').forEach(b=>b.onclick=async()=>{try{await editCh(b.dataset.id)}catch(e){toast(e.message,'bad')}});
  $('#chNewBtn').onclick=async()=>{try{const t=$('#chNew').value;const r=await api(\`/api/books/\${BK}/chapters\`,{method:'POST',body:{title:t}});toast('已创建空白章 #'+r.id+'（点「编」填写正文后跑流水线）');tabChapters()}catch(e){toast(e.message,'bad')}};
}

const escH=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
async function editCh(id){
  const r=await api('/api/chapters/'+id);
  const el=document.createElement('div');el.style.cssText='position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.55);display:grid;place-items:center';
  el.innerHTML='<div class="card" style="max-width:640px;width:94%">'
    +'<b>编辑第'+r.seq+'章</b>'
    +'<label>标题</label><input id="eTitle" value="'+escH(r.title)+'">'
    +'<label>正文（留空=保持原样）</label><textarea id="eContent" rows="8">'+escH(r.content)+'</textarea>'
    +'<label>摘要（留空=不改）</label><input id="eSummary" value="'+escH(r.summary)+'">'
    +'<label>钩子（留空=不改）</label><input id="eHook" value="'+escH(r.hook)+'">'
    +'<label>状态</label><select id="eStatus"><option value="">保持（'+(r.status||'draft')+'）</option><option value="draft">draft</option><option value="committed">committed</option><option value="rejected">rejected</option></select>'
    +'<div class="row"><button class="primary" id="eSave">保存</button><button id="eCancel">取消</button></div>'
    +'</div>';
  document.body.appendChild(el);
  $('#eCancel').onclick=()=>el.remove();
  $('#eSave').onclick=async()=>{const body={};if($('#eTitle').value.trim()&&$('#eTitle').value!==r.title)body.title=$('#eTitle').value;if($('#eContent').value!==String(r.content||''))body.content=$('#eContent').value;if($('#eSummary').value)body.summary=$('#eSummary').value;if($('#eHook').value)body.hook=$('#eHook').value;if($('#eStatus').value)body.status=$('#eStatus').value;try{await api('/api/chapters/'+id,{method:'PATCH',body});el.remove();toast('已保存第'+r.seq+'章');if(TAB==='chapters')tabChapters()}catch(e){toast(e.message,'bad')}};
}

async function tabRoles(){
  const d=await api('/api/books/'+BK);
  $('#tabBody').innerHTML=\`<div class="card"><b>角色设定集</b>（主角优先；state_note 随流水线自动回写；声纹=语言指纹，对话区分度用）
    <div class="row"><input id="rName" placeholder="角色名" style="width:140px"><select id="rType"><option>角色</option><option>组织</option><option>地点</option><option>物品</option><option>势力</option></select>
    <input id="rVoice" placeholder="声纹（口头禅/用词/信息量）" style="width:220px">
    <label class="small" style="display:inline"><input type="checkbox" id="rProto"> 主角</label><button class="primary" id="rAdd">＋</button></div>
    \${d.roles.map(r=>\`<div class="row"><b>\${r.name}</b> <span class="badge">\${r.role_type}</span>\${r.is_protagonist?' <span class="badge ok">主角</span>':''}
      <span class="muted small">\${r.profile||''}</span>\${r.state_note?\` <span class="badge warn">状态：\${r.state_note}</span>\`:''}
      <input class="rv" data-id="\${r.id}" data-val="\${escH(r.voice||'')}" placeholder="声纹（口头禅/用词/信息量）" style="width:220px" value="\${escH(r.voice||'')}"> <button class="rvSave" data-id="\${r.id}">存声纹</button>
      <button class="rm" data-id="\${r.id}">删</button></div>\`).join('')}
  </div>\`;
  $('#rAdd').onclick=async()=>{await api(\`/api/books/\${BK}/roles\`,{method:'POST',body:{name:$('#rName').value,type:$('#rType').value,role_type:$('#rType').value,profile:'',voice:$('#rVoice').value.trim(),is_protagonist:$('#rProto').checked}});tabRoles()};
  document.querySelectorAll('.rvSave').forEach(b=>b.onclick=async()=>{const inp=document.querySelector('.rv[data-id="'+b.dataset.id+'"]');const v=inp.value.trim();const body=v?{voice:v}:{voice:''};await api('/api/roles/'+b.dataset.id,{method:'PATCH',body});tabRoles()});
  document.querySelectorAll('.rm').forEach(b=>b.onclick=async()=>{await api('/api/roles/'+b.dataset.id,{method:'DELETE'});tabRoles()});
}

async function tabLoops(){
  const d=await api('/api/books/'+BK);
  const urgent=d.loops.filter(l=>l.status==='open'&&l.urgency>=80);
  $('#tabBody').innerHTML=\`<div class="card"><b>伏笔（open_loop）</b> \${urgent.length?\`<span class="badge bad">\${urgent.length} 条紧急，将强制进入下一章任务书</span>\`:''}
    <div class="row"><input id="fContent" placeholder="新伏笔" style="flex:1"><input id="fUrg" type="number" min="0" max="100" value="50" title="紧急度 0-100" style="width:70px"><button class="primary" id="fAdd">＋ 埋设</button></div>
    \${d.loops.map(l=>\`<div class="row"><span class="badge \${l.status==='paid'?'ok':'warn'}">\${l.status==='paid'?'已回收':'未回收'}</span>
      <span class="small">\${l.content}</span><span class="muted small">埋@\${l.planted_chapter||'?'}</span>
      <input class="lp" data-id="\${l.id}" type="number" min="1" placeholder="回收章" style="width:70px" value="\${l.payoff_chapter||''}">
      \${l.status==='open'?\`<button class="pay" data-id="\${l.id}" title="标记已回收（可填回收章）">✓</button> <button class="del" data-id="\${l.id}">删</button>\`:''}</div>\`).join('')}
  </div>\`;
  $('#fAdd').onclick=async()=>{await api(\`/api/books/\${BK}/loops\`,{method:'POST',body:{content:$('#fContent').value,urgency:+$('#fUrg').value}});tabLoops()};
  document.querySelectorAll('.pay').forEach(b=>b.onclick=async()=>{const lp=document.querySelector('.lp[data-id="'+b.dataset.id+'"]');const body={status:'paid'};if(lp&&lp.value)body.payoff_chapter=+lp.value;await api('/api/loops/'+b.dataset.id,{method:'PATCH',body});tabLoops()});
  document.querySelectorAll('.del').forEach(b=>b.onclick=async()=>{await api('/api/loops/'+b.dataset.id,{method:'DELETE'});tabLoops()});
}

async function tabOutline(){
  const d=await api('/api/books/'+BK);
  $('#tabBody').innerHTML=\`<div class="card"><b>大纲（法律）</b>
    <div class="row"><input id="oTitle" placeholder="章纲标题" style="flex:1"><input id="oDetail" placeholder="本章要点/禁区（可选）" style="flex:1"><button class="primary" id="oAdd">＋</button></div>
    \${d.outline.map(o=>\`<div class="row"><span class="badge">\${o.status}</span> <b>\${o.seq}、\${o.title}</b> \${o.detail?\`<span class="muted small">\${o.detail}</span>\`:''}
      \${o.status!=='done'?\`<button class="adv" data-id="\${o.id}">推进</button>\`:''} <button class="del" data-id="\${o.id}">删</button></div>\`).join('')||'<div class="muted">无大纲。点「生成大纲」用 AI 出章纲并入库。</div>'}
  </div>\`;
  $('#oAdd').onclick=async()=>{await api(\`/api/books/\${BK}/outline\`,{method:'POST',body:{title:$('#oTitle').value,detail:$('#oDetail').value}});tabOutline()};
  document.querySelectorAll('.adv').forEach(b=>b.onclick=async()=>{const cur=await api('/api/books/'+BK);const o=cur.outline.find(x=>x.id==b.dataset.id);await api('/api/outline/'+b.dataset.id,{method:'PATCH',body:{status:o.status==='pending'?'in_progress':'done'}});tabOutline()});
  document.querySelectorAll('.del').forEach(b=>b.onclick=async()=>{await api('/api/outline/'+b.dataset.id,{method:'DELETE'});tabOutline()});
}

async function tabEvents(){
  const es=await api('/api/books/'+BK+'/events');
  const label={open_loop_created:'埋伏笔',open_loop_closed:'收伏笔',character_state_changed:'状态变更',power_breakthrough:'突破',relationship_changed:'关系',world_rule_revealed:'规则',promise_created:'立誓',promise_paid_off:'偿约',artifact_obtained:'得物'};
  let rows=es.slice().reverse().map(e=>'<div class="row small"><span class="badge">'+e.chapter_seq+'章</span> <b>'+(label[e.event_type]||e.event_type)+'</b> '+(e.subject||'')+' <span class="muted">'+(e.payload||'')+'</span></div>').join('');
  if(!rows)rows='<div class="muted">暂无事件。写完一章（含回写）后这里会有记录。</div>';
  $('#tabBody').innerHTML='<div class="card"><b>事件流</b>（data-agent 回写的跨章事实，供后续任务书引用）'+rows+'</div>';
}

// ---- 事实账本 ledger（写章前按 type 注入 state-pack；人工可校正/作废）----
async function tabLedger(){
  const rows=await api('/api/books/'+BK+'/ledger');
  const act=rows.filter(r=>r.status==='active');
  const tl={state:'状态',knowledge:'知识(谁知道)',rule:'规则',lineage:'身世',other:'其他'};
  let opts='';for(const k in tl){opts+='<option value="'+k+'">'+tl[k]+'</option>';}
  let list='';
  if(act.length){list=act.map(r=>'<div class="row small"><span class="badge">'+(tl[r.fact_type]||r.fact_type)+'</span> <b>'+escH(r.subject||'')+'</b> <span>'+escH(r.fact)+'</span> <span class="muted">'+(r.chapter_seq?('第'+r.chapter_seq+'章'):'开书')+'·'+r.source+'</span><span class="muted small">'+(r.status==='corrected'?'已校正':'')+'</span> <button class="lgDel" data-id="'+r.id+'">作废</button></div>').join('');}
  else list='<div class="muted">暂无账本。跑一次流水线（含提取）后自动生成；也可人工补。</div>';
  const head='<div class="card"><b>事实账本</b>（跨章一致性真源；写下一章时自动注入。active '+act.length+' 条）';
  const form='<div class="row"><input id="lgSub" placeholder="主体（角色/实体）" style="width:160px"><select id="lgType">'+opts+'</select>'+
    '<input id="lgFact" placeholder="一句话事实，如：萧炎知道父亲未死" style="flex:1"><button class="primary" id="lgAdd">＋ 人工记一条</button></div>';
  $('#tabBody').innerHTML=head+form+list+'</div>';
  $('#lgAdd').onclick=async()=>{const f=$('#lgFact').value.trim();if(!f)return;await api('/api/books/'+BK+'/ledger',{method:'POST',body:{fact:f,subject:$('#lgSub').value.trim(),fact_type:$('#lgType').value}});tabLedger()};
  document.querySelectorAll('.lgDel').forEach(b=>b.onclick=async()=>{await api('/api/ledger/'+b.dataset.id,{method:'DELETE'});tabLedger()});
}

// ---- 卷级摘要 summaries（章节多了后 state-pack 注入摘要而非全量）----
async function tabSums(){
  const rows=await api('/api/books/'+BK+'/summaries');
  const head='<div class="card"><b>卷级摘要</b>（滚动压缩；写下一章时自动注入最近 2 卷）'+
    '<div class="row"><input id="sFrom" type="number" min="1" value="1" style="width:70px"><input id="sTo" type="number" min="1" value="10" style="width:70px"><button class="primary" id="sGen">⚡ AI 生成卷摘要</button></div>';
  let list='';
  if(rows.length){list=rows.map(s=>'<div class="card small"><b>第'+s.seq_from+'-'+s.seq_to+'章</b> <span class="muted">卷级</span><pre>'+escH(s.text)+'</pre><button class="sDel" data-id="'+s.id+'">删</button></div>').join('');}
  else list='<div class="muted">暂无卷摘要。点「AI 生成卷摘要」把一段章节压缩成 400 字卷摘。</div>';
  $('#tabBody').innerHTML=head+list+'</div>';
  $('#sGen').onclick=async()=>{try{const r=await api('/api/books/'+BK+'/summaries',{method:'POST',body:{from:+$('#sFrom').value,to:+$('#sTo').value}});toast('已生成卷摘要：<pre>'+escH(r.text.slice(0,300))+'</pre>');tabSums()}catch(e){toast(e.message,'bad')}};
  document.querySelectorAll('.sDel').forEach(b=>b.onclick=async()=>{await api('/api/summaries/'+b.dataset.id,{method:'DELETE'});tabSums()});
}

// ---- 生成大纲并入库 ----
async function genOutline(){try{const r=await api('/api/ai/outline',{method:'POST',body:{bookId:BK,count:10,save:true}});toast('已生成并入库 '+r.added+' 条章纲<br><pre>'+r.text.slice(0,400)+'</pre>');tabOutline()}catch(e){toast(e.message,'bad')}}
async function expandSetting(){try{const r=await api('/api/ai/expand-setting',{method:'POST',body:{bookId:BK,kind:'world'}});toast('设定已扩展（可切到世界观查看）')}catch(e){toast(e.message,'bad')}}

// ---- AI 味负面清单（本书定制，写章/润色/校验全链路生效；留空=用站点默认）----
async function editAnti(){
  const d=await api('/api/books/'+BK);
  const el=document.createElement('div');el.style.cssText='position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.55);display:grid;place-items:center';
  el.innerHTML='<div class="card" style="max-width:560px;width:94%">'
    +'<b>AI 味负面清单</b>（本书定制；起草/润色/校验全链路生效。留空=用站点默认）'
    +'<textarea id="antiTxt" rows="6" style="width:100%">'+escH(d.book.anti_ai_rules||'')+'</textarea>'
    +'<div class="muted small">站点默认：禁用套话/排比/解释性旁白；句式长短变化；角色说话有区分度</div>'
    +'<div class="row"><button class="primary" id="antiSave">保存</button><button id="antiClear">清空（用站点默认）</button><button id="antiCancel">取消</button></div>'
    +'</div>';
  document.body.appendChild(el);
  $('#antiCancel').onclick=()=>el.remove();
  $('#antiClear').onclick=()=>{$('#antiTxt').value=''};
  $('#antiSave').onclick=async()=>{try{await api('/api/books/'+BK,{method:'PATCH',body:{anti_ai_rules:$('#antiTxt').value.trim()}});el.remove();toast('已保存 AI 味负面清单（下一章流水线生效）')}catch(e){toast(e.message,'bad')}};
}

// ---- 导出设置（TXT/MD/HTML/EPUB + 范围 + 附加资料） ----
async function showExportPanel(){
  const p=$('#exportPanel');
  p.innerHTML='<div class="card"><b>导出设置</b>'
    +'<div class="row"><label>格式</label><select id="xFmt" style="width:150px"><option value="txt">TXT 纯文本</option><option value="md">Markdown</option><option value="html">HTML</option><option value="epub">EPUB 电子书</option></select>'
    +'<label>起始章</label><input id="xFrom" type="number" min="1" value="1" style="width:70px"><label>截止章（空=全部）</label><input id="xTo" type="number" min="1" style="width:70px"></div>'
    +'<div class="row">'
    +'<label class="small" style="display:inline"><input type="checkbox" id="xWorld"> 附世界观</label>'
    +'<label class="small" style="display:inline"><input type="checkbox" id="xRoles"> 附角色档案</label>'
    +'<label class="small" style="display:inline"><input type="checkbox" id="xLoops"> 附伏笔清单</label>'
    +'<label class="small" style="display:inline"><input type="checkbox" id="xOutline"> 附大纲</label></div>'
    +'<div class="row"><button class="primary" id="xGo">下载</button><span id="xMsg" class="muted small"></span></div>'
    +'</div>';
  $('#xGo').onclick=async()=>{
    const f=$('#xFmt').value,from=+$('#xFrom').value||1,to=+$('#xTo').value||0;
    const qs=new URLSearchParams({format:f,from:String(from)});if(to)qs.set('to',String(to));
    if($('#xWorld').checked)qs.set('attach_world','1');if($('#xRoles').checked)qs.set('attach_roles','1');if($('#xLoops').checked)qs.set('attach_loops','1');if($('#xOutline').checked)qs.set('attach_outline','1');
    try{
      const r=await fetch('/api/books/'+BK+'/export?'+qs.toString(),{headers:{Authorization:'Bearer '+TK}});
      if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error||('HTTP '+r.status))}
      const m=/filename="([^"]*)"/.exec(r.headers.get('Content-Disposition')||'');
      const blob=await r.blob();
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=m?m[1]:(BK+'.'+f);document.body.appendChild(a);a.click();a.remove();
      $('#xMsg').textContent='已导出 '+a.download+'（'+(blob.size/1024).toFixed(1)+' KB）';
    }catch(e){$('#xMsg').textContent='导出失败：'+e.message}
  };
}

// ---- 6 步流水线 UI ----
async function runPipe(mode){
  const p=$('#pipePanel');p.style.display='';
  p.innerHTML=\`<div class="card"><b>⚡ 写章流水线（\${mode}）</b><div class="progress"><i id="ppBar" style="width:0%"></i></div><div id="stageList">准备…</div></div>\`;
  const stages=['① 任务书','② 起草','②.5 校验闭环','③ 五维审查','④ 润色','⑤ 事实提取','⑥ 确定性回写'];
  const setStage=i=>{stages.slice(0,i).forEach(s=>0);$('#stageList').innerHTML=stages.map((s,j)=>\`<div>\${j<i?'✅':'⏳'} \${s}</div>\`).join('')+'<div class="muted small">运行中… 约 1-3 分钟，请勿刷新</div>';$('#ppBar').style.width=((i+0.5)/stages.length*100)+'%'};
  setStage(0);
  try{
    const r=await api(\`/api/books/\${BK}/pipeline\`,{method:'POST',body:{mode,words:2000}});
    $('#ppBar').style.width='100%';
    const rc=r.review||{};
    p.innerHTML=\`<div class="card"><b>✅ 第\${r.seq}章「\${r.title}」</b> <span class="badge \${r.status==='committed'?'ok':'bad'}">\${r.status==='committed'?'已回写 committed':'rejected（有阻断）'}</span>
      <span class="badge">\${r.ms}ms</span><span class="badge">\${r.fixed} 处阻断已修</span>
      <span class="badge">\${r.verifyConflicts||0} 处一致性冲突\${r.verifyRegenerated?'（已重生成）':''}</span>
      <span class="badge">埋\${r.loopsPlanted}/收\${r.loopsRecycled} 伏笔</span><span class="badge">\${r.events} 条事件</span><span class="badge">账本 +\${r.extraction?.facts?.length||0}</span>
      \${r.hasPlaceholder?'<span class="badge bad">检测到占位符，已降级</span>':''}
      <div class="row">\${['standard','fast','minimal'].map(m=>\`<button data-rerun="\${m}">⚡ 再写下一章（\${m==='standard'?'标准':m==='fast'?'快速':'极简'}）</button>\`).join('')}</div>
      <details><summary>正文</summary><pre>\${r.content}</pre></details>
      \${rc.issues?.length?\`<details><summary>审查（\${rc.issues_count} 项）</summary><pre>\${JSON.stringify(rc,null,1).slice(0,800)}</pre></details>\`:''}
      <details><summary>摘要 / 钩子</summary><pre>\${r.summary||'(空)'}\${r.hook?'\\n钩：'+r.hook:''}</pre></details>
      <div class="muted small">切到「伏笔/事件流/角色」标签查看回写结果；紧急伏笔会自动进入下一章任务书。</div>
    </div>\`;
    p.querySelectorAll('[data-rerun]').forEach(b=>b.onclick=()=>runPipe(b.dataset.rerun));
    // 刷新章节列表
    if(TAB==='chapters')tabChapters();
  }catch(e){p.innerHTML=\`<div class="card bad"><b>流水线失败</b><div>\${e.message}</div></div>\`}
}

// ---- 管理端 ----
const admtok=()=>localStorage.getItem('nvs_admin_token');
async function admFetch(path,method,body){const r=await fetch(path,{method:method||'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer '+admtok()},body:body?JSON.stringify(body):undefined});if(!r.ok)throw new Error('管理员请求失败 HTTP '+r.status);return r.json().catch(()=>({}))}
async function openAdmin(){
  const main=$('#view');
  main.innerHTML=\`<div class="card"><b>管理员</b><div class="row">
    <input id="aEmail" placeholder="admin@x.com" style="width:200px"><input id="aPass" type="password" placeholder="密码" style="width:150px">
    <button class="primary" id="aLogin">登录</button><button id="aInit">初始化首个管理员</button></div>
    <div id="aMsg" class="muted small"></div>
    <div id="aBody" style="display:none"></div>
  </div>\`;
if(admtok()){showAdmin();return}
  const doLogin=init=>{const b=async()=>{$('#aMsg').textContent='登录中…';try{const r=await admFetch(init?'/api/admin/init':'/api/admin/login','POST',{email:$('#aEmail').value,password:$('#aPass').value});if(r.token)localStorage.setItem('nvs_admin_token',r.token);$('#aMsg').textContent='';await showAdmin()}catch(e){$('#aMsg').textContent=e.message}};b()};
  $('#aLogin').onclick=()=>doLogin(false);$('#aInit').onclick=()=>doLogin(true);
  window._showAdmin=showAdmin;
  async function showAdmin(){
    let st={users:0,books:0,chapters:0,usage7d:0,open_loops:0,free_codes:0};
    let users=[], codes={codes:[],require_invite:true}, site={};
    try{st=await admFetch('/api/admin/stats','GET')}catch{}
    try{users=await admFetch('/api/admin/users','GET')}catch{users=[]}
    if(!Array.isArray(users))users=[];
    try{codes=await admFetch('/api/admin/codes','GET')}catch{}
    if(!codes||!Array.isArray(codes.codes))codes={codes:[],require_invite:!!st.require_invite};
    try{site=await admFetch('/api/admin/settings','GET')}catch{}
    $('#aBody').style.display='';
    $('#aBody').innerHTML=\`
    <div class="row"><b>站点</b> 用户 \${st.users} · 书 \${st.books} · 章 \${st.chapters} · 7日用量 \${st.usage7d} · 未回收伏笔 \${st.open_loops} · 可用注册码 \${st.free_codes}</div>
    <div class="card"><b>站点默认 AI 味负面清单</b>（书级清单为空时全局兜底；写章/润色/校验全链路生效）
      <textarea id="aAnti" rows="4" style="width:100%">\${escH(site.anti_ai_default||'')}</textarea>
      <div class="row"><button class="primary" id="aAntiSave">保存</button></div></div>
    <div class="card"><b>注册码</b> <label class="row"><input type="checkbox" id="aReq" \${codes.require_invite?'checked':''}> 要求注册码</label>
      <div class="row"><button class="primary" id="aGen">生成 5 个码</button></div>
      <div class="thumbs" id="aCodes"></div></div>
    <div class="card"><b>用户</b><table><tr><th>邮箱</th><th>书</th><th>AI调用</th><th>状态</th><th></th></tr>
      \${users.map(u=>\`<tr><td>\${u.email}</td><td>\${u.books}</td><td>\${u.ai_calls||0}</td><td>\${u.blocked?'<span class="badge bad">停用</span>':'<span class="badge ok">正常</span>'}</td>
      <td><button class="ub" data-e="\${u.email}">\${u.blocked?'解禁':'停用'}</button></td></tr>\`).join('')||'<tr><td colspan="5" class="muted">无用户</td></tr>'}</table></div>\`;
    $('#aCodes').innerHTML=codes.codes.map(c=>\`<span class="badge \${c.revoked?'bad':c.used_by?'':'ok'}">\${c.code}\${c.used_by?' ←'+c.used_by:''}</span>\`).join(' ');
    $('#aGen').onclick=async()=>{try{const d=await admFetch('/api/admin/codes','POST',{count:5,require:$('#aReq').checked});toast('已生成：<pre>'+(d.codes||[]).join('<br>')+'</pre>（发给用户注册）');await showAdmin()}catch(e){toast(e.message,'bad')}};
    $('#aAntiSave').onclick=async()=>{try{await admFetch('/api/admin/settings','POST',{anti_ai_default:$('#aAnti').value});toast('已保存站点默认 AI 味清单');await showAdmin()}catch(e){toast(e.message,'bad')}};
    $('#aReq').onchange=async()=>{try{await admFetch('/api/admin/settings','POST',{require_invite:$('#aReq').checked?1:0});await showAdmin()}catch(e){toast(e.message,'bad')}};
    document.querySelectorAll('.ub').forEach(b=>b.onclick=async()=>{try{await admFetch('/api/admin/users/'+encodeURIComponent(b.dataset.e)+'/flag','POST',{blocked:b.textContent==='停用'?'1':'0'});await showAdmin()}catch(e){toast(e.message,'bad')}});
  }
}
$('#btnAdmin').onclick=()=>openAdmin();

// ---- 启动 ----
(async function init(){
  if(TK){try{await afterLogin()}catch{localStorage.removeItem('nvs_token');TK=''}}
  if(!TK)showLogin();
  // 管理按钮常显（BUG-3）；面板内部走 admin token 登录（BUG-4），不会死循环
})();
function showLogin(){$('#authPane').style.display='grid';$('#dataPane').style.display='none';setAuthUI(false);$('#view').innerHTML='<div class="muted">未登录。点右上「登录 / 注册」开始；管理员请点右上「管理」。</div>';$('#authMsg').textContent=''}

</script>
</body></html>`;

// ---------- router ----------
// 公开路由无需 token；/api/admin/* 需 admin token（Header Authorization: Bearer <admin_token>）；其余需用户 token
const publicRoutes = ["POST /api/register", "POST /api/login"];
const adminRoutes = ["POST /api/admin/init", "POST /api/admin/login"];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS")
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
      });

    if (!url.pathname.startsWith("/api")) {
      return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    const authTok = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    for (const [route, fn] of Object.entries(api)) {
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
        if (adminRoutes.includes(route)) {
          // 初始化/登录：admin_auth 空表允许 init；登录需要已有管理员
          return await fn(env, req, match, null);
        }
        if (p.startsWith("/api/admin/")) {
          const admin = authTok ? await authAdmin(env, { headers: new Headers({ Authorization: "Bearer " + authTok }) }) : null;
          return await fn(env, req, match, admin);
        }
        const email = await authUser(env, req);
        return await fn(env, req, match, email);
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }
    return json({ error: "not found" }, 404);
  },
};
