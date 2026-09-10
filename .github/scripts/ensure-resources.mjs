#!/usr/bin/env node
// 确保 D1 数据库存在并应用 schema；把 database_id 写进 wrangler.toml
import { appendFileSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!ACCOUNT_ID || !API_TOKEN) throw new Error("缺少 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN");

const D1_NAME = process.env.NVS_D1_NAME || "nvs-db";
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

async function cf(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`CF ${r.status} ${path}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// 1. 找已有 D1，没有就创建
let db = null;
{
  const list = await cf("GET", `/d1/database`);
  db = list.result?.find((d) => d.name === D1_NAME);
}
if (!db) {
  console.log("creating D1", D1_NAME);
  db = (await cf("POST", "/d1/database", { name: D1_NAME })).result;
}
console.log("D1 id:", db.uuid, db.name);

// 2. 应用 schema（幂等：CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE）
const schema = readFileSync("schema.sql", "utf8");
await cf("POST", `/d1/database/${db.uuid}/query`, { sql: schema });
console.log("schema applied");

// 3. 生成 wrangler.local.toml（含 database_id + 可选 AI binding）
const toml = `name = "nvs-writing"
main = "worker.js"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "${D1_NAME}"
database_id = "${db.uuid}"

# 可选：启用 Workers AI（在 CF 控制台开启 AI capabilities 后取消注释）
# [[ai]]
# binding = "AI"
`;
writeFileSync("wrangler.local.toml", toml);
console.log("wrote wrangler.local.toml");
