# NVS-Writing — CF Workers 轻量 AI 小说写作系统

单文件 Cloudflare Worker（Workers + D1，零构建）。AI 写作台：多书管理、章节编辑器自动保存、6 类 AI 动作（续写/重写/润色/摘要/下章钩子/章节大纲 + 扩展世界观/角色设定），上下文自动注入（梗概+世界观+角色+前情摘要，RAG-lite）。

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
