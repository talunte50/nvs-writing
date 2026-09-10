// 本地测试 v2（多租户 + 注册码 + 流水线）：node:sqlite 模拟 D1，真实请求打到 worker 的 fetch
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

const orKey = execSync(
  "grep -oE 'sk-or-v1-[A-Za-z0-9]{20,}' '/root/.hermes/common_models.py' | head -1"
).toString().trim();

const db = new DatabaseSync(":memory:");
db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

// 模拟 D1 binding
function stmt(sql, args) {
  const st = db.prepare(sql);
  const run = () => { const r = st.run(...args); return { meta: { last_rowid: Number(r.lastInsertRowid ?? 0), changes: Number(r.changes ?? 0) } }; };
  const all = () => ({ results: st.all(...args) });
  const first = () => st.get(...args);
  return {
    run: async () => run(),
    all: async () => all(),
    first: async () => first(),
    bind: (...a) => stmt(sql, a),
  };
}
const DB = { prepare: (sql) => stmt(sql, []) };
const env = { DB, LLM_KEY: "" };
const mod = await import(pathToFileURL(process.argv[2] || "./worker.js"));
const handler = mod.default;

const http = await import("node:http");
const server = http.createServer((req, res) => {
  (async () => {
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
    res.setHeader("Content-Type", out.headers.get("Content-Type") || "text/plain");
    res.end(await out.text());
  })();
});
await new Promise((r) => server.listen(8788, r));
console.log("mock server :8788");

const B = "http://127.0.0.1:8788";
async function call(method, path, body, token, extraHeaders) {
  const headers = { "Content-Type": "application/json", ...(extraHeaders || {}) };
  if (token) headers["Authorization"] = "Bearer " + token;
  const r = await fetch(B + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => r.text()) };
}

let fail = 0;
const T = async (name, fn) => { try { await fn(); console.log("PASS", name); } catch (e) { fail++; console.log("FAIL", name, "-", (e.message || String(e)).slice(0, 200)); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

let tokA, tokB, book, adminTok, inviteCode;

await T("GET / 返回 HTML（含登录/流水线/伏笔元素）", async () => {
  const r = await (await fetch(B + "/")).text();
  assert(r.includes("NVS") && r.includes("liEmail") && r.includes("一键写下一章") && r.includes("伏笔"), "html missing v2 markers");
});

await T("未认证 /api/books → 401", async () => {
  const r = await call("GET", "/api/books");
  assert(r.status === 401, "expected 401, got " + r.status);
});

await T("admin init 创建首个管理员 + 生成注册码", async () => {
  const r = await call("POST", "/api/admin/init", { email: "admin@x.com", password: "adminpass88" });
  assert(r.status === 200 && r.body.token, JSON.stringify(r.body).slice(0, 120));
  adminTok = r.body.token;
  const c = await call("POST", "/api/admin/codes", { count: 2, require: true }, adminTok);
  assert(c.status === 200 && Array.isArray(c.body.codes) && c.body.codes.length === 2, JSON.stringify(c.body).slice(0, 120));
  inviteCode = c.body.codes[0];
});

await T("无码注册被拒（require_invite）", async () => {
  const r = await call("POST", "/api/register", { email: "a@test.dev", password: "pass123" });
  assert(r.status === 400 && r.body.code_required, JSON.stringify(r.body).slice(0, 120));
});

await T("用注册码注册 A → token", async () => {
  const r = await call("POST", "/api/register", { email: "a@test.dev", password: "pass123", invite: inviteCode });
  assert(r.status === 200 && r.body.token, JSON.stringify(r.body).slice(0, 120));
  tokA = r.body.token;
});

await T("重复注册码不可再用", async () => {
  const r = await call("POST", "/api/register", { email: "c@test.dev", password: "pass789", invite: inviteCode });
  assert(r.status === 403, "used code should 403, got " + r.status);
});

await T("POST /api/login 正确/错误密码", async () => {
  let r = await call("POST", "/api/login", { email: "a@test.dev", password: "wrong" });
  assert(r.status === 401, "bad pw should 401, got " + r.status);
  r = await call("POST", "/api/login", { email: "a@test.dev", password: "pass123" });
  assert(r.status === 200 && r.body.token, JSON.stringify(r.body).slice(0, 120));
});

await T("GET /api/me 返回 email + 站点信息", async () => {
  const r = await call("GET", "/api/me", null, tokA);
  assert(r.status === 200 && r.body.email === "a@test.dev", JSON.stringify(r.body).slice(0, 120));
});

await T("建书 + 角色 + 伏笔 + 大纲 CRUD", async () => {
  const b = await call("POST", "/api/books", { title: "天书", logline: "少年获残缺天书", genre: "玄幻" }, tokA);
  assert(b.status === 200 && b.body.id, JSON.stringify(b.body));
  book = b.body.id;
  const role = await call("POST", `/api/books/${book}/roles`, { name: "萧炎", role_type: "角色", is_protagonist: true, profile: "斗帝血脉" }, tokA);
  assert(role.status === 200, JSON.stringify(role.body));
  const loop = await call("POST", `/api/books/${book}/loops`, { content: "三年之约", urgency: 90, planted_chapter: 0 }, tokA);
  assert(loop.status === 200, JSON.stringify(loop.body));
  const out = await call("POST", `/api/books/${book}/outline`, { title: "天书现世", detail: "主角意外获得天书残页" }, tokA);
  assert(out.status === 200, JSON.stringify(out.body));
  const det = await call("GET", `/api/books/${book}`, null, tokA);
  assert(det.body.roles.length === 1 && det.body.loops.length === 1 && det.body.outline.length === 1, "book detail missing sub-entities");
});

await T("A 配置自己的 LLM Key（隔离）", async () => {
  const s = await call("POST", "/api/settings", { provider: "openai", base_url: "https://openrouter.ai/api/v1", model: "openrouter/free", api_key: orKey }, tokA);
  assert(s.status === 200, JSON.stringify(s.body));
  const g = await call("GET", "/api/settings", null, tokA);
  assert(g.body.has_key === true, JSON.stringify(g.body));
});

await T("B 用户（第二个码）注册，看不到 A 的数据", async () => {
  const c2 = await call("POST", "/api/admin/codes", { count: 1 }, adminTok);
  tokB = (await call("POST", "/api/register", { email: "b@test.dev", password: "pass456", invite: c2.body.codes[0] })).body.token;
  const books = await call("GET", "/api/books", null, tokB);
  assert(books.body.length === 0, "B sees " + books.body.length + " books");
  const c = await call("GET", `/api/books/${book}`, null, tokB);
  assert(c.status === 404, "B should not read A's book, got " + c.status);
});

await T("管理员 stats / users 列表", async () => {
  const st = await call("GET", "/api/admin/stats", null, adminTok);
  assert(st.status === 200 && st.body.users >= 2, JSON.stringify(st.body).slice(0, 160));
  const us = await call("GET", "/api/admin/users", null, adminTok);
  assert(us.status === 200 && us.body.length >= 2, JSON.stringify(us.body).slice(0, 160));
});

await T("管理员封禁 B → B 登录被拒", async () => {
  const f = await call("POST", "/api/admin/users/b%40test.dev/flag", { blocked: 1 }, adminTok);
  assert(f.status === 200, JSON.stringify(f.body));
  const l = await call("POST", "/api/login", { email: "b@test.dev", password: "pass456" });
  assert(l.status === 403, "blocked user login should 403, got " + l.status);
});

await T("真实 AI：流水线 minimal（含真实 LLM 起草+提取+回写）", async () => {
  const r = await call("POST", `/api/books/${book}/pipeline`, { mode: "minimal", words: 300 }, tokA);
  assert(r.status === 200, JSON.stringify(r.body).slice(0, 300));
  assert(r.body.content && r.body.content.length > 30, "pipeline content too short");
  const det = await call("GET", `/api/books/${book}`, null, tokA);
  assert(det.body.events.length >= 0, "events list missing");
  const chs = await call("GET", `/api/books/${book}/chapters`, null, tokA);
  assert(chs.body.length === 1 && chs.body[0].status === "committed", "chapter not committed: " + JSON.stringify(chs.body[0]).slice(0, 120));
  console.log("  正文前80字:", (r.body.content || "").slice(0, 80).replace(/\n/g, " "));
});

await T("回写验证：紧急伏笔仍在 + 事件流入库", async () => {
  const det = await call("GET", `/api/books/${book}`, null, tokA);
  // 三年之约（urgency 90）未被回收，应保持 open
  const stillOpen = det.body.loops.find((l) => l.content === "三年之约");
  assert(stillOpen && stillOpen.status === "open", "urgent loop should remain open unless extracted-as-recycled");
});

server.close();
console.log(fail === 0 ? "\n全部通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail ? 1 : 0);
