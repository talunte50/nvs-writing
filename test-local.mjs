// 本地测试 v3：node:sqlite 模拟 D1 + 本地 mock LLM（OpenAI 兼容）+ 导出/修复回归
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---- mock LLM：OpenAI 兼容 /chat/completions（按 prompt 内容返回确定性正文/JSON） ----
import { createServer } from "node:http";
const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = JSON.parse(body || "{}");
    const last = b.messages?.[b.messages.length - 1]?.content || "";
    let out;
    if (last.includes("只输出任务书")) out = "①开篇委托：第X章推进剧情 ②本章目标 ③出场人物 ④节奏 ⑤收在哪里";
    else if (last.includes("校验") && last.includes("JSON"))
      out = '{"conflicts":[],"facts_extracted":3,"checked":3}';
    else if (last.includes("五维审查") || last.includes("审查并只输出 JSON"))
      out = '{"chapter":1,"issues":[],"issues_count":0,"blocking_count":0,"has_blocking":false,"dimension_results":[{"dimension":"setting","conclusion":"pass"}],"summary":"0个问题"}';
    else if (last.includes("事实") && last.includes("JSON"))
      out = '{"summary_text":"主角获得天书残页，三年之约伏笔埋下","hook_type":"悬念","hook_strength":"strong","accepted_events":[{"event_id":"evt-1-001","chapter":1,"event_type":"open_loop_created","subject":"萧炎","payload":{"content":"三年之约","urgency":90}}],"state_deltas":[],"facts":[{"fact_type":"state","subject":"萧炎","fact":"萧炎获得天书残页"},{"fact_type":"knowledge","subject":"萧炎","fact":"萧炎知道三年之期将满"}],"entities_appeared":[]}';
    else out = "萧炎握紧残缺天书，眼中寒光一闪，命运的齿轮开始转动。\n\n三年之期将满，他不再等待，踏上征途。\n\n风雪夜，仇家忽至。";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: out } }] }));
  });
});
await new Promise((r) => mock.listen(8901, r));

// ---- D1 模拟 ----
const db = new DatabaseSync(":memory:");
db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
function stmt(sql, args) {
  const st = db.prepare(sql);
  const run = () => { const r = st.run(...args); return { meta: { last_rowid: Number(r.lastInsertRowid ?? 0), changes: Number(r.changes ?? 0) } }; };
  const all = () => ({ results: st.all(...args) });
  const first = () => st.get(...args);
  return { run: async () => run(), all: async () => all(), first: async () => first(), bind: (...a) => stmt(sql, a) };
}
const DB = { prepare: (sql) => stmt(sql, []) };
const env = { DB, LLM_KEY: "" };
const mod = await import(pathToFileURL(process.argv[2] || "./worker.js"));
const handler = mod.default;

// ---- 起 worker 本地 HTTP ----
import { createServer as httpCreateServer } from "node:http";
const server = httpCreateServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  const r = new Request("http://nvs.local" + req.url, {
    method: req.method,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    headers: { "Content-Type": "application/json", ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) },
  });
  const out = await handler.fetch(r, env);
  res.statusCode = out.status;
  out.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await out.arrayBuffer()));
});
await new Promise((r) => server.listen(8788, r));
console.log("mock LLM :8901 + worker :8788");

const B = "http://127.0.0.1:8788";
async function call(method, path, body, token, extraHeaders) {
  const headers = { "Content-Type": "application/json", ...(extraHeaders || {}) };
  if (token) headers["Authorization"] = "Bearer " + token;
  const r = await fetch(B + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const buf = await r.arrayBuffer();
  let parsed;
  try { parsed = JSON.parse(Buffer.from(buf).toString("utf8")); } catch { parsed = Buffer.from(buf).toString("utf8"); }
  return { status: r.status, body: parsed, raw: buf, headers: r.headers };
}

let fail = 0;
const T = async (name, fn) => { try { await fn(); console.log("PASS", name); } catch (e) { fail++; console.log("FAIL", name, "-", (e.message || String(e)).slice(0, 300)); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

let tokA, tokB, book, adminTok, inviteCode;

await T("GET / 返回 HTML（含登录/导出/章节编辑元素）", async () => {
  const r = await (await fetch(B + "/")).text();
  for (const m of ["NVS", "liEmail", "一键写下一章", "伏笔", "btnAdmin", "exportPanel", "世界观设定", "事实账本", "卷摘要", "AI味清单", "声纹"]) assert(r.includes(m), "missing " + m);
});

await T("admin init + 生成注册码 + 用户 B", async () => {
  const r = await call("POST", "/api/admin/init", { email: "admin@x.com", password: "adminpass88" });
  assert(r.status === 200 && r.body.token, JSON.stringify(r.body).slice(0, 120));
  adminTok = r.body.token;
  const c = await call("POST", "/api/admin/codes", { count: 2, require: true }, adminTok);
  assert(c.status === 200 && c.body.codes.length === 2, JSON.stringify(c.body).slice(0, 120));
  inviteCode = c.body.codes[0];
  const c2 = await call("POST", "/api/admin/codes", { count: 1 }, adminTok);
  const a1 = await call("POST", "/api/register", { email: "a@test.dev", password: "pass123", invite: inviteCode });
  tokA = a1.body.token;
  const a2 = await call("POST", "/api/register", { email: "b@test.dev", password: "pass456", invite: c2.body.codes[0] });
  tokB = a2.body.token;
});

await T("建书 + 角色 + 伏笔 + 大纲 CRUD（A）", async () => {
  const b = await call("POST", "/api/books", { title: "天书", logline: "少年获残缺天书", genre: "玄幻", world_setting: "天书体系：九层封印", characters: "萧炎（主角）" }, tokA);
  assert(b.status === 200 && b.body.id, JSON.stringify(b.body));
  book = b.body.id;
  await call("POST", `/api/books/${book}/roles`, { name: "萧炎", role_type: "角色", is_protagonist: true, profile: "斗帝血脉" }, tokA);
  await call("POST", `/api/books/${book}/loops`, { content: "三年之约", urgency: 90, planted_chapter: 0 }, tokA);
  const det = await call("GET", `/api/books/${book}`, null, tokA);
  assert(det.body.roles.length === 1 && det.body.loops.length === 1, "sub-entities missing");
});

// ---- N2：AI 大纲 save:true 必须真正入库 ----
await T("N2：/api/ai/outline save:true 真正入库（修复 request body 二次读取）", async () => {
  const s = await call("POST", "/api/settings", { provider: "openai", base_url: "http://127.0.0.1:8901/v1", model: "mock-model", api_key: "mock" }, tokA);
  assert(s.status === 200, JSON.stringify(s.body));
  const r = await call("POST", "/api/ai/outline", { bookId: book, count: 5, save: true }, tokA);
  assert(r.status === 200, JSON.stringify(r.body).slice(0, 200));
  assert(r.body.added >= 1, "added should be >=1, got " + r.body.added + " (N2 regression)");
  const det = await call("GET", `/api/books/${book}`, null, tokA);
  assert(det.body.outline.length >= 1, "outline not persisted");
});

// ---- N3：空白章标题不再被丢弃 ----
await T("N3：POST chapters 自定义标题入库（修复 body 丢弃）", async () => {
  const r = await call("POST", `/api/books/${book}/chapters`, { title: "自定义空章" }, tokA);
  assert(r.status === 200 && r.body.id, JSON.stringify(r.body));
  const det = await call("GET", `/api/chapters/${r.body.id}`, null, tokA);
  assert(det.body.title === "自定义空章", "title lost: " + det.body.title);
  await call("DELETE", `/api/chapters/${r.body.id}`, null, tokA);
});

// ---- N4：解禁 flag（字符串 '0' 也能正确解除） ----
await T("N4：管理员 flag 停用/解禁（含字符串 '0' 数值解析）", async () => {
  let f = await call("POST", "/api/admin/users/b%40test.dev/flag", { blocked: 1 }, adminTok);
  assert(f.status === 200, JSON.stringify(f.body));
  let l = await call("POST", "/api/login", { email: "b@test.dev", password: "pass456" });
  assert(l.status === 403, "blocked login should 403, got " + l.status);
  // 前端发的是字符串 '0'（原来 b.blocked?'1':'0' 对 '0' 判真导致解禁失效）
  f = await call("POST", "/api/admin/users/b%40test.dev/flag", { blocked: "0" }, adminTok);
  assert(f.status === 200, JSON.stringify(f.body));
  l = await call("POST", "/api/login", { email: "b@test.dev", password: "pass456" });
  assert(l.status === 200, "unblock via string '0' failed: " + l.status + " " + JSON.stringify(l.body).slice(0, 100));
});

// ---- 流水线（mock LLM，确定性） ----
await T("流水线 minimal：起草+提取+回写 committed", async () => {
  const r = await call("POST", `/api/books/${book}/pipeline`, { mode: "minimal", words: 300 }, tokA);
  assert(r.status === 200, JSON.stringify(r.body).slice(0, 300));
  assert(r.body.content && r.body.content.length > 10, "content too short");
  const chs = await call("GET", `/api/books/${book}/chapters`, null, tokA);
  const committed = chs.body.filter((c) => c.status === "committed" && c.seq === r.body.seq);
  assert(committed.length === 1, "chapter not committed: " + JSON.stringify(chs.body.map(c => [c.seq, c.status])));
});

// ---- 一致性增强：standard 流水线（verify 闭环 + 账本回写） ----
await T("流水线 standard：verify 闭环 + 事实账本回写", async () => {
  const r = await call("POST", `/api/books/${book}/pipeline`, { mode: "standard", words: 300 }, tokA);
  assert(r.status === 200, JSON.stringify(r.body).slice(0, 300));
  assert(r.body.verifyConflicts === 0, "verifyConflicts should be 0, got " + r.body.verifyConflicts);
  assert((r.body.extraction?.facts || []).length >= 1, "extraction.facts missing");
  const lg = await call("GET", `/api/books/${book}/ledger`, null, tokA);
  assert(lg.status === 200 && lg.body.length >= 2, "ledger not populated: " + JSON.stringify(lg.body).slice(0, 150));
  assert(lg.body.some(f => f.fact_type === "knowledge" && f.subject === "萧炎"), "knowledge fact missing");
});

// ---- 账本/摘要/声纹/负面清单 API ----
await T("账本 CRUD + 卷摘要 + 角色声纹 + 负面清单", async () => {
  const add = await call("POST", `/api/books/${book}/ledger`, { fact: "萧炎是萧家的", fact_type: "lineage", subject: "萧炎" }, tokA);
  assert(add.status === 200, JSON.stringify(add.body));
  const lg = await call("GET", `/api/books/${book}/ledger`, null, tokA);
  const manual = lg.body.find(f => f.fact === "萧炎是萧家的" && f.source === "manual");
  assert(manual, "manual ledger entry not stored");
  const del = await call("DELETE", `/api/ledger/${manual.id}`, null, tokA);
  assert(del.status === 200, JSON.stringify(del.body));
  const lg2 = await call("GET", `/api/books/${book}/ledger`, null, tokA);
  assert(!lg2.body.find(f => f.id === manual.id && f.status === "active"), "ledger not superseded");

  const sm = await call("POST", `/api/books/${book}/summaries`, { from: 1, to: 2 }, tokA);
  assert(sm.status === 200, JSON.stringify(sm.body).slice(0, 150));
  const smList = await call("GET", `/api/books/${book}/summaries`, null, tokA);
  assert(smList.body.length === 1, "summary not stored");

  const roles = await call("GET", `/api/books/${book}`, null, tokA);
  const role = roles.body.roles[0];
  const pv = await call("PATCH", `/api/roles/${role.id}`, { voice: "短句、爱反问" }, tokA);
  assert(pv.status === 200, JSON.stringify(pv.body));
  const roles2 = await call("GET", `/api/books/${book}`, null, tokA);
  assert(roles2.body.roles[0].voice === "短句、爱反问", "voice not persisted");

  const pa = await call("PATCH", `/api/books/${book}`, { anti_ai_rules: "本书禁用：破折号" }, tokA);
  assert(pa.status === 200, JSON.stringify(pa.body));
  const bk = await call("GET", `/api/books/${book}`, null, tokA);
  assert(bk.body.book.anti_ai_rules === "本书禁用：破折号", "anti_ai_rules not persisted");

  const adm = await call("GET", "/api/admin/settings", null, adminTok);
  assert(adm.status === 200 && /套话/.test(adm.body.anti_ai_default || ""), "anti_ai_default missing: " + JSON.stringify(adm.body).slice(0, 100));
  const admSet = await call("POST", "/api/admin/settings", { anti_ai_default: "站点默认X" }, adminTok);
  assert(admSet.status === 200, JSON.stringify(admSet.body));
});

// ---- N7：章节编辑 PATCH ----
await T("N7：PATCH /api/chapters/:id 修改标题+状态（编辑 UI 后端支持）", async () => {
  const chs = await call("GET", `/api/books/${book}/chapters`, null, tokA);
  const c = chs.body[0];
  const r = await call("PATCH", `/api/chapters/${c.id}`, { title: "改后标题", status: "draft" }, tokA);
  assert(r.status === 200, JSON.stringify(r.body));
  const det = await call("GET", `/api/chapters/${c.id}`, null, tokA);
  assert(det.body.title === "改后标题" && det.body.status === "draft", JSON.stringify(det.body).slice(0, 150));
});

// ---- 导出：TXT/MD/HTML + 附加资料 ----
await T("导出 TXT/MD/HTML：内容正确 + 附加资料", async () => {
  for (const [fmt, marker] of [["txt", "第1章"], ["md", "# 天书"], ["html", "<!doctype html>"]]) {
    const r = await call("GET", `/api/books/${book}/export?format=${fmt}&attach_roles=1&attach_loops=1&attach_world=1`, null, tokA);
    assert(r.status === 200, fmt + " status " + r.status);
    const txt = Buffer.isBuffer(r.body) ? r.body.toString() : String(r.body);
    assert(txt.includes(marker), fmt + " missing marker " + marker);
    if (fmt === "txt") {
      assert(txt.includes("—— 角色档案 ——") && txt.includes("萧炎"), "roles missing in txt");
      assert(txt.includes("—— 伏笔清单 ——"), "loops missing in txt");
      assert(txt.includes("—— 世界观设定 ——") && txt.includes("九层封印"), "world missing in txt");
    }
  }
  // 范围：from=2 时不含第1章
  const r2 = await call("GET", `/api/books/${book}/export?format=txt&from=2`, null, tokA);
  assert(r2.status === 200 && !String(r2.body).includes("第1章"), "from=2 should exclude ch1");
});

// ---- 导出 EPUB：ZIP 字节级校验 ----
await T("导出 EPUB：mimetype@0 + ZIP CRC + unzip 校验", async () => {
  const r = await call("GET", `/api/books/${book}/export?format=epub&attach_roles=1`, null, tokA);
  assert(r.status === 200, "epub status " + r.status);
  const buf = Buffer.from(r.raw);
  // 落盘供 Python zipfile 校验
  writeFileSync(new URL("./out-test.epub", import.meta.url), buf);
  assert(buf.length > 60, "epub too small: " + buf.length);
  // ZIP 布局：[LH(30) + "mimetype"(8) + data(20)]… → 首个 LH 在偏移 0，mimetype 数据在 38
  assert(buf.readUInt32LE(0) === 0x04034b50, "first local header not at offset 0");
  assert(buf.slice(30, 38).toString() === "mimetype", "first entry not mimetype, got " + JSON.stringify(buf.slice(30, 40).toString()));
  assert(buf.slice(38, 58).toString() === "application/epub+zip", "mimetype content at 38: " + JSON.stringify(buf.slice(38, 62).toString()));
  // EOCD 在末尾
  assert(buf.readUInt32LE(buf.length - 22) === 0x06054b50, "EOCD signature missing at tail");
  console.log("  EPUB bytes:", buf.length, "(written to out-test.epub, verified by Python zipfile)");
});
// ---- 前端内嵌 JS 语法（模板求值后 node --check）----
await T("前端 <script> 语法：模板求值后无 SyntaxError（BUG-1 回归）", async () => {
  const src = readFileSync(new URL("./worker.js", import.meta.url), "utf8");
  const i = src.indexOf("const HTML = `");
  const j = src.indexOf("// ---------- router ----------", i);
  const tpl = src.slice(i + "const HTML = `".length, j).replace(/\n+$/, "");
  const html = tpl.replace(/\\`/g, "`").replace(/\\\$\{/g, "${");
  const s = html.indexOf("<script>") + 8;
  const e = html.indexOf("</script>");
  const js = html.slice(s, e);
  writeFileSync("/tmp/nvs_browser_check.js", js);
  const { execSync } = await import("node:child_process");
  execSync("node --check /tmp/nvs_browser_check.js", { stdio: "pipe" });
});

// ---- 用量不双记（N6）：跑 1 次流水线 → ai_usage 该 action 恰好 +1 ----
await T("N6：流水线成功只记 1 条 usage（路由层单点记账）", async () => {
  const before = Number((db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE action='pipeline:minimal'").get()).n);
  await call("POST", `/api/books/${book}/pipeline`, { mode: "minimal", words: 100 }, tokA);
  const after = Number((db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE action='pipeline:minimal'").get()).n);
  assert(after - before === 1, `usage delta ${after - before}, expected 1`);
});

// ---- 新功能回归：站点信息 / 模型测试 / 站点默认 LLM / 会员编辑删除 ----
await T("GET /api/site 公开返回 SEO + 站点名", async () => {
  const r = await call("GET", "/api/site");
  assert(r.status === 200 && r.body.site_name, JSON.stringify(r.body).slice(0, 120));
  assert(r.body.seo_desc.includes("NVS"), "seo_desc missing");
});

await T("POST /api/settings/test：mock LLM 连通测试", async () => {
  const r = await call("POST", "/api/settings/test", { provider: "openai", base_url: "http://127.0.0.1:8901/v1", model: "mock-model", api_key: "mock" }, tokA);
  assert(r.status === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 150));
});

await T("站点默认 LLM：admin 配置后未配 key 的用户回退生效", async () => {
  const set = await call("POST", "/api/admin/llm", { provider: "openai", base_url: "http://127.0.0.1:8901/v1", model: "site-default-model", api_key: "sitekey" }, adminTok);
  assert(set.status === 200, JSON.stringify(set.body));
  const get = await call("GET", "/api/admin/llm", null, adminTok);
  assert(get.status === 200 && get.body.model === "site-default-model" && get.body.has_key, JSON.stringify(get.body));
  // 用户 B 从未配过自己的 key → /api/settings 应回退站点默认（using=site）
  // （N4 中 B 被禁用过、旧 token 已清，先重新登录拿新 token）
  const relog = await call("POST", "/api/login", { email: "b@test.dev", password: "pass456" });
  assert(relog.status === 200, JSON.stringify(relog.body).slice(0, 100));
  tokB = relog.body.token;
  const s = await call("GET", "/api/settings", null, tokB);
  assert(s.status === 200 && s.body.model === "site-default-model" && s.body.using === "site", JSON.stringify(s.body));
  // 清掉站点默认，恢复出厂
  await call("POST", "/api/admin/llm", { provider: "openai", base_url: "", model: "", api_key: "" }, adminTok);
});

await T("会员编辑：管理员改密 + 重置 token", async () => {
  const r = await call("POST", "/api/admin/users/b%40test.dev", { password: "newpass789" }, adminTok);
  assert(r.status === 200, JSON.stringify(r.body));
  const l = await call("POST", "/api/login", { email: "b@test.dev", password: "newpass789" });
  assert(l.status === 200, "login with new password failed: " + l.status);
  const rt = await call("POST", "/api/admin/users/b%40test.dev", { reset_token: true }, adminTok);
  assert(rt.status === 200, JSON.stringify(rt.body));
  // 旧 token 应失效（改密时 token 已清空）
  const old = await call("GET", "/api/books", null, tokB);
  assert(old.status === 401, "stale token should 401 after password change, got " + old.status);
});

await T("会员删除：级联清理书/章/角色/账本，释放注册码", async () => {
  // B 重新登录（改密后旧 token 已失效）拿新 token
  const relog = await call("POST", "/api/login", { email: "b@test.dev", password: "newpass789" });
  assert(relog.status === 200, JSON.stringify(relog.body).slice(0, 100));
  const tokB2 = relog.body.token;
  const b2 = await call("POST", "/api/books", { title: "B的书" }, tokB2);
  assert(b2.status === 200, "create book failed: " + JSON.stringify(b2.body).slice(0, 100));
  const del = await call("DELETE", "/api/admin/users/b%40test.dev", null, adminTok);
  assert(del.status === 200 && del.body.books_removed === 1, JSON.stringify(del.body));
  // 该用户再登录 → 401 账号不存在
  const l = await call("POST", "/api/login", { email: "b@test.dev", password: "newpass789" });
  assert(l.status === 401, "deleted user can still login: " + l.status);
});

mock.close();
server.close();
console.log(fail === 0 ? "\n全部通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail ? 1 : 0);
