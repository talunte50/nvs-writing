// 本地测试：用 node:sqlite 模拟 D1，真实请求打到 worker 的 fetch
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// LLM key（从本机配置取，不打印）
import { execSync } from "node:child_process";
const orKey = execSync(
  "grep -oE 'sk-or-v1-[A-Za-z0-9]{20,}' '/root/.hermes/common_models.py' | head -1"
).toString().trim();

const db = new DatabaseSync(":memory:");
db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
// 把 key 写进 settings
db.prepare("INSERT INTO settings(key,value) VALUES('llm_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(orKey);

// 模拟 D1 binding（完整双写：prepare 直接可 .all()/.first()/.run()，也可 .bind()）
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

function hit(method, path, body) {
  return fetch("http://nvs-writing.local" + path, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { "Content-Type": "application/json" } : {},
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => r.text()) }));
}
function get(path) { return fetch("http://nvs-writing.local" + path).then(r => r.text()); }

// 路由调用
async function call(req) { return handler.fetch(req, env); }

// 通过自定义协议打给 handler
const http = await import("node:http");
const server = http.createServer((req, res) => {
  (async () => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const r = new Request("http://nvs.local" + req.url, { method: req.method, body: req.method === "GET" ? undefined : body, headers: { "Content-Type": "application/json" } });
    const out = await call(r);
    res.statusCode = out.status;
    res.setHeader("Content-Type", out.headers.get("Content-Type") || "text/plain");
    res.end(await out.text());
  })();
});
await new Promise((r) => server.listen(8787, r));
console.log("mock server :8787");

// ---- 冒烟测试 ----
let fail = 0;
const T = async (name, fn) => { try { await fn(); console.log("PASS", name); } catch (e) { fail++; console.log("FAIL", name, "-", e.message?.slice(0, 200)); } };

await T("GET / 返回 HTML", async () => {
  const r = await (await fetch("http://127.0.0.1:8787/")).text();
  if (!r.includes("NVS")) throw new Error("html missing");
});

let book, ch;
await T("POST /api/books", async () => {
  const r = await (await fetch("http://127.0.0.1:8787/api/books", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "测试书", genre: "玄幻", logline: "少年获得残缺天书，踏上逆袭之路", world_setting: "九州大陆，灵气复苏", characters: "李七（主角）、老顽（师父）" }) })).json();
  book = r.id; if (!book) throw new Error("no id");
});

await T("POST /api/ai/outline（真实LLM）", async () => {
  const r = await (await fetch("http://127.0.0.1:8787/api/ai/outline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: book, count: 5 }) })).json();
  if (!r.text || r.text.length < 50) throw new Error("outline too short: " + JSON.stringify(r).slice(0, 200));
  console.log("  outline 前80字:", r.text.slice(0, 80).replace(/\n/g, " "));
});

await T("POST /api/books/:id/chapters", async () => {
  const r = await (await fetch("http://127.0.0.1:8787/api/books/" + book + "/chapters", { method: "POST" })).json();
  ch = r.id; if (!ch) throw new Error("no id");
});

await T("POST /api/ai/write continue（真实LLM，300字）", async () => {
  const r = await (await fetch("http://127.0.0.1:8787/api/ai/write", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: book, chapterId: ch, action: "continue", words: 300 }) })).json();
  if (!r.text || r.text.length < 50) throw new Error("write failed: " + JSON.stringify(r).slice(0, 300));
  console.log("  正文前100字:", r.text.slice(0, 100).replace(/\n/g, " "));
});

await T("PATCH chapter + summarize", async () => {
  await fetch("http://127.0.0.1:8787/api/chapters/" + ch, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "第一章 少年李七在雪夜拾到残卷……（测试正文）", ai_kind: "continue" }) });
  const r = await (await fetch("http://127.0.0.1:8787/api/ai/write", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: book, chapterId: ch, action: "summarize" }) })).json();
  if (!r.text) throw new Error("summarize failed");
  const c = await (await fetch("http://127.0.0.1:8787/api/chapters/" + ch)).json();
  if (!c.summary) throw new Error("summary not saved");
  console.log("  摘要:", c.summary.slice(0, 60));
});

await T("GET /api/books 列表含章节数", async () => {
  const r = await (await fetch("http://127.0.0.1:8787/api/books")).json();
  if (!Array.isArray(r) || !r.find((b) => b.id === book && b.chapter_count === 1)) throw new Error("list wrong: " + JSON.stringify(r).slice(0,150));
});

await T("POST /api/settings 错误密码 403", async () => {
  const r = await fetch("http://127.0.0.1:8787/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ admin_token: "wrong" }) });
  if (r.status !== 403) throw new Error("expected 403, got " + r.status);
});

server.close();
console.log(fail === 0 ? "\n全部通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail ? 1 : 0);
