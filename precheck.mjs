// 部署前卡点（BUG-6）：worker 本体 + 内嵌浏览器 JS 双重语法校验。
// 用法：node precheck.mjs [worker.js]
// 原理：HTML 前端是以 JS 模板字面量嵌入 worker.js 的。磁盘字节经过 Node 引擎
//       求值后才得到浏览器实际执行的 <script>。必须对"求值后"的浏览器 JS 做
//       node --check，否则 worker 本体语法通过、但浏览器 JS 报废（曾发生 BUG-1）。
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const workerPath = process.argv[2] || "./worker.js";
const src = readFileSync(workerPath, "utf8");

// 1) worker.js 本体语法
execSync(`node --check ${JSON.stringify(workerPath)}`, { stdio: "pipe" });
console.log("✓ worker.js 本体语法 OK");

// 2) 提取 HTML 模板（const HTML = `...` 到 router 注释前），让 Node 引擎求值转义
const start = src.indexOf("const HTML = `");
if (start < 0) throw new Error("未找到 const HTML = ` 模板定义");
const router = src.indexOf("// ---------- router ----------", start);
if (router < 0) throw new Error("未找到 router 注释（模板边界）");
// 模板体：const HTML = ` ... ` ;  截取到 router 注释前，末尾应含闭合反引号
let seg = src.slice(start, router).trim();
if (!/`;\s*$|`\s*$/.test(seg)) throw new Error("HTML 模板未正确闭合（末尾应含 `）");

const dir = mkdtempSync(join(tmpdir(), "nvs-precheck-"));
const tplFile = join(dir, "tpl.mjs");
writeFileSync(tplFile, seg + "\nexport { HTML };\n");
const mod = await import(pathToFileURL(tplFile).href);
const html = String(mod.HTML);

// 3) 提取 <script> 段做浏览器 JS 语法检查
const s = html.indexOf("<script>") + "<script>".length;
const e = html.indexOf("</script>");
if (s < 8 || e < s) throw new Error("HTML 中未找到 <script> 段");
const browserJs = html.slice(s, e);
const jsFile = join(dir, "browser.js");
writeFileSync(jsFile, browserJs);
execSync(`node --check ${JSON.stringify(jsFile)}`, { stdio: "pipe" });
console.log(`✓ 内嵌浏览器 JS 语法 OK（求值后 ${browserJs.length} 字节）`);

// 4) 关键元素/路由存在性断言（防误删）
const must = [
  "btnAdmin", "authPane", "exportPanel", "showExportPanel", "editCh",
  "vExport", "btnLogin", "btnReg", "btnTheme", "runPipe", "openAdmin",
  "admFetch", "statusBar", "btnModel", "openModelPane", "adminUsers", "adminLlm", "adminSite",
  "runPipeN", "openChatPane", "tabStats", "vPipeN", "vChat",
];
for (const m of must) {
  if (!browserJs.includes(m)) throw new Error(`浏览器 JS 缺少关键符号：${m}`);
}
console.log("✓ 关键前端符号齐全");

// 5) 后端路由存在性断言（防误删导出/管理路由）
const routes = [
  "GET /api/books/:id/export", "POST /api/ai/outline", "POST /api/admin/init",
  "POST /api/admin/login", "GET /api/admin/stats", "POST /api/books/:id/pipeline",
  "POST /api/books/:id/chat", "GET /api/books/:id/stats",
  "PATCH /api/chapters/:id", "POST /api/books/:id/chapters",
  "GET /api/site", "POST /api/settings/test", "GET /api/admin/llm", "POST /api/admin/llm",
  "POST /api/admin/users/:email", "DELETE /api/admin/users/:email",
];
for (const r of routes) {
  if (!src.includes(`"${r}"`)) throw new Error(`worker 缺少路由：${r}`);
}
console.log("✓ 关键后端路由齐全");

console.log("\nPRECHECK PASS ✅ 可部署");
