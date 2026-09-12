# NVS-Writing — CF Workers 轻量 AI 小说写作系统

单文件 Cloudflare Worker（Workers + D1，零构建）。AI 写作台：多书管理、章节编辑器自动保存、6 类 AI 动作（续写/重写/润色/摘要/下章钩子/章节大纲 + 扩展世界观/角色设定），上下文自动注入（梗概+世界观+角色+前情摘要，RAG-lite）。

**四大进阶能力**（对标 chinese-novelist-skill / novel-studio / mythpen / AI_NovelGenerator）：
- 💬 **问设定**：`POST /api/books/:id/chat`——带着本书状态包（世界观/角色/伏笔/事实账本/近3章）向 AI 提问，缺上下文会说「需补充」不编造
- ⏩ **连写 N 章**：前端循环跑流水线（快速模式），逐章刷新状态栏，随时可停，429/限流自动止损
- 📈 **创作看板**：`GET /api/books/:id/stats`——总字数/章数/未回收伏笔/角色数/连续写作天数/近14天写章柱状图
- **伏笔可视化**：伏笔 tab 未回收角标 + 紧急伏笔强制进任务书（prompt 注入）

## LLM 对接
- **OpenAI 兼容格式**：任意端点（OpenRouter / Groq / DeepSeek / Moonshot / Ollama / vLLM…），填 Base URL + Key + 模型
- **Cloudflare Workers AI**：`@cf/meta/llama-3.1-8b-instruct` 等，免费额度 0 成本
- 用户在页面右上角「设置」里填写并保存（存 D1，即时生效，无需重新部署）

## 本地部署
```bash
npx wrangler d1 create nvs-db            # 记录 database_id
# 编辑 wrangler.toml 填入 database_id
npx wrangler d1 execute nvs-db --file schema.sql --remote
npx wrangler deploy
```

## 自动更新（GitHub Actions）
1. 推送到本仓库
2. 在仓库 Settings → Secrets 添加：
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_API_TOKEN`（D1 + Workers 权限）
   - `LLM_KEY`（可选，服务端默认 LLM Key）
3. push `worker.js` / `schema.sql` 即自动部署
