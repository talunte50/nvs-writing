// 本地测试（多租户版）：node:sqlite 模拟 D1，真实请求打到 worker 的 fetch
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
const env = { DB, LLM_KEY: "" }; // 注意：不走默认，LLM_KEY 留空
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
async function call(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const r = await fetch(B + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => r.text()) };
}

let fail = 0;
const T = async (name, fn) => { try { await fn(); console.log("PASS", name); } catch (e) { fail++; console.log("FAIL", name, "-", (e.message || String(e)).slice(0, 200)); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

let tokA, tokB, book, ch;

await T("GET / 返回 HTML（登录页）", async () => {
  const r = await (await fetch(B + "/")).text();
  assert(r.includes("NVS") && r.includes("li_email"), "html missing login");
});

await T("未认证 /api/books → 401", async () => {
  const r = await call("GET", "/api/books");
  assert(r.status === 401, "expected 401, got " + r.status);
});

await T("POST /api/register → token", async () => {
  const r = await call("POST", "/api/register", { email: "a@test.dev", password: "pass123" });
  assert(r.status === 200 && r.body.token, JSON.stringify(r.body).slice(0, 120));
  tokA = r.body.token;
});

await T("重复注册 → 409", async () => {
  const r = await call("POST", "/api/register", { email: "a@test.dev", password: "pass123" });
  assert(r.status === 409, "got " + r.status);
});

await T("POST /api/login 正确/错误密码", async () => {
  let r = await call("POST", "/api/login", { email: "a@test.dev", password: "wrong" });
  assert(r.status === 401, "bad pw should 401, got " + r.status);
  r = await call("POST", "/api/login", { email: "a@test.dev", password: "pass123" });
  assert(r.status === 200 && r.body.token, JSON.stringify(r.body));
});

await T("认证后 /api/settings 初始无 Key", async () => {
  const r = await call("GET", "/api/settings", null, tokA);
  assert(r.status === 200 && r.body.has_key === false, JSON.stringify(r.body));
});

await T("未配 Key 时 AI 调用 → 明确报错", async () => {
  const b = await call("POST", "/api/books", { title: "t" }, tokA);
  book = b.body.id;
  const chR = await call("POST", `/api/books/${book}/chapters`, {}, tokA);
  ch = chR.body.id;
  const r = await call("POST", "/api/ai/write", { bookId: book, chapterId: ch, action: "continue" }, tokA);
  assert(r.status === 500 && /API Key/.test(r.body.error), JSON.stringify(r.body));
});

await T("用户隔离：B 看不到 A 的书", async () => {
  const r = await call("POST", "/api/register", { email: "b@test.dev", password: "pass456" });
  tokB = r.body.token;
  const books = await call("GET", "/api/books", null, tokB);
  assert(books.body.length === 0, "B sees " + books.body.length + " books");
  const c = await call("GET", `/api/chapters/${ch}`, null, tokB);
  assert(c.status === 404, "B should not read A's chapter, got " + c.status);
});

await T("B 建书成功（各自独立）", async () => {
  const r = await call("POST", "/api/books", { title: "B的书" }, tokB);
  assert(r.status === 200 && r.body.id, JSON.stringify(r.body));
});

await T("A 配置自己的 LLM Key + 真实 AI 大纲", async () => {
  const s = await call("POST", "/api/settings", { provider: "openai", base_url: "https://openrouter.ai/api/v1", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", api_key: orKey }, tokA);
  assert(s.status === 200, JSON.stringify(s.body));
  const b = await call("GET", "/api/books", null, tokA);
  const bk = b.body.find((x) => x.title === "t");
  await call("PATCH", `/api/books/${bk.id}`, { logline: "少年获得残缺天书，踏上逆袭之路" }, tokA);
  const o = await call("POST", "/api/ai/outline", { bookId: bk.id, count: 5 }, tokA);
  assert(o.status === 200 && (o.body.text || "").length > 30, JSON.stringify(o.body).slice(0, 200));
  console.log("  大纲前80字:", (o.body.text || "").slice(0, 80).replace(/\n/g, " "));
});

await T("B 未配 Key（隔离验证：A 的 Key 不影响 B）", async () => {
  const s = await call("GET", "/api/settings", null, tokB);
  assert(s.body.has_key === false, "B has_key should be false");
});

await T("A 真实 AI 续写", async () => {
  const b = await call("GET", "/api/books", null, tokA);
  const bk = b.body.find((x) => x.title === "t");
  const chs = await call("GET", `/api/books/${bk.id}/chapters`, null, tokA);
  const r = await call("POST", "/api/ai/write", { bookId: bk.id, chapterId: chs.body[0].id, action: "continue", words: 200 }, tokA);
  assert(r.status === 200 && (r.body.text || "").length > 30, JSON.stringify(r.body).slice(0, 200));
  console.log("  正文前80字:", (r.body.text || "").slice(0, 80).replace(/\n/g, " "));
});

await T("token 重置（POST /api/account）", async () => {
  const r = await call("POST", "/api/account", { reset_token: true }, tokA);
  assert(r.status === 200 && r.body.token, JSON.stringify(r.body));
  const old = await call("GET", "/api/books", null, tokA);
  assert(old.status === 401, "old token should be invalid");
  tokA = r.body.token;
  const ok = await call("GET", "/api/books", null, tokA);
  assert(ok.status === 200, "new token should work");
});

server.close();
console.log(fail === 0 ? "\n全部通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail ? 1 : 0);
