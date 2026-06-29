# API 中转站

一键部署到 EdgeOne Pages 的免费 AI API 中转站。支持 OpenAI / Gemini / Claude / 自定义供应商，解决**跨境访问 + Key 隐藏 + CORS 跨域**，附带多轮对话与流式输出。

## 快速开始

### 1. 部署到 EdgeOne Pages

1. 打开 [pages.edgeone.ai](https://pages.edgeone.ai) 登录腾讯云账号
2. 创建项目 → 连接 GitHub 仓库 `lingzhanlab/apirelay`
3. 框架预设选 **Other**，构建命令留空，输出目录填 `./`
4. 部署

### 2. 配置环境变量

在 EdgeOne Pages 后台 → Settings → Environment Variables：

| 变量名 | 必填 | 说明 | 示例 |
|--------|------|------|------|
| `ACCESS_TOKEN` | ⬜ | API 端点访问密钥，不设则 API 不强制鉴权 | `sk-relay-xxxx` |
| `OPENAI_API_KEY` | ⬜ | OpenAI API Key | `sk-proj-xxxx` |
| `GEMINI_API_KEY` | ⬜ | Google Gemini API Key | `AIzaSyDxxxx` |
| `CLAUDE_API_KEY` | ⬜ | Anthropic Claude API Key | `sk-ant-api03-xxxx` |
| `CUSTOM_PROVIDERS` | ⬜ | 自定义供应商 JSON 数组 | 见下方 |
| `DEEPSEEK_API_KEY` | ⬜ | DeepSeek API Key（自定义供应商示例） | `sk-d30fxxxx` |
| `ALLOWED_ORIGIN` | ⬜ | CORS 允许的域名，不设则 `*` | `https://your-site.com` |
| `DEFAULT_PROVIDER` | ⬜ | 默认供应商，默认 `openai` | `deepseek` |
| `ENABLE_CHAT_PAGE` | ⬜ | 设为 `true` 才开放浏览器聊天页（默认关闭） | `true` |
| `MODEL_OVERRIDES` | ⬜ | 覆盖默认模型 JSON | `{"openai":"gpt-4o"}` |
| `MAX_TOKENS` | ⬜ | 单次回复最大 token 数（仅 Claude 生效，默认 4096） | `8192` |
| `UPSTREAM_TIMEOUT` | ⬜ | 上游请求超时毫秒数，默认 25000 | `30000` |

### 3. 使用

**浏览器聊天页**：`https://你的域名.edgeone.dev`

> ⚠️ 聊天页**默认关闭**，需设置环境变量 `ENABLE_CHAT_PAGE=true` 才开放。未开启时访问域名只会看到「仅 API 模式」提示，不暴露任何信息。

**代码调用（非流式）**：
```bash
curl -X POST https://你的域名.edgeone.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你设的ACCESS_TOKEN" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

**代码调用（流式）**：
```bash
curl -X POST https://你的域名.edgeone.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你设的ACCESS_TOKEN" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"讲个故事"}],"stream":true}'
```

**客户端接入（LobeChat / ChatBox / OpenWebUI / Cherry Studio 等，OpenAI 兼容）**：
- API 地址：`https://你的域名.edgeone.dev`（**只填到域名根，不带 `/v1`**）
  - 客户端会自动拼 `/v1/chat/completions`，填了 `/v1` 会变成 `/v1/v1/chat/completions` 导致 404
- API Key：填 `ACCESS_TOKEN` 的值
- 模型填你配置的供应商对应的模型名（如 `deepseek-chat` / `gpt-3.5-turbo` / `gemini-2.0-flash` / `claude-3-haiku-20240307`）
- 支持 `stream: true`，返回 OpenAI 兼容 SSE 格式

> 💡 如果你的客户端不自动补全路径（要求填完整 URL），则填 `https://你的域名.edgeone.dev/v1/chat/completions`

**Anthropic SDK / Claude 客户端接入**：
- base_url：`https://你的域名.edgeone.dev`（**只填到域名根，不带 `/v1`**）
  - SDK 会自动拼 `/v1/messages`，填了 `/v1` 会变成 `/v1/v1/messages` 导致 404
- API Key：填 `ACCESS_TOKEN` 的值（SDK 会以 `x-api-key` header 发送，已兼容）
- 模型填 `claude-3-haiku-20240307` 等，或 `gpt-4o` / `gemini-2.0-flash`（自动路由到对应供应商）
- 入参用 Anthropic 格式（`system` 顶层字段、`max_tokens` 等），输出统一成 Anthropic 格式
- 支持 `stream: true`，返回 Anthropic SSE 事件流格式

## API 端点

| 端点 | 说明 | 鉴权 | 流式 |
|------|------|------|------|
| `GET /api/config` | 前端配置接口（聊天页开放时返回供应商列表） | 无 | — |
| `POST /api/chat` | 聊天页专用（需 `ENABLE_CHAT_PAGE=true`） | 无 | `stream:true` → `text/plain` |
| `POST /v1/chat/completions` | OpenAI 兼容格式（主接口） | `ACCESS_TOKEN` | `stream:true` → `text/event-stream` SSE |
| `POST /v1/messages` | Anthropic 兼容格式（Claude 客户端接入） | `ACCESS_TOKEN` | `stream:true` → Anthropic SSE 事件流 |

## 多轮对话

所有聊天端点都接受 `messages` 数组，支持多轮上下文与 system 角色：

```json
{
  "model": "deepseek-chat",
  "messages": [
    {"role": "system", "content": "你是简洁的助手"},
    {"role": "user", "content": "你好"},
    {"role": "assistant", "content": "你好！"},
    {"role": "user", "content": "再见"}
  ]
}
```

三种供应商的多轮都已正确处理：
- **OpenAI**（及兼容格式）：直接转发 `messages`
- **Claude**：`system` 提取到顶层 `system` 字段，其余多轮
- **Gemini**：`system` 提取到 `systemInstruction`，`assistant` 映射为 `model` 角色，多轮 `contents` 数组

`/api/chat` 也兼容旧前端的单轮 `prompt` 字符串（自动转成单条 user message）。

## 流式输出

请求体加 `"stream": true` 即可。当前实现为**一次性返回**（上游非流式获取完整响应后包装成 SSE 格式），保证客户端协议兼容：

- `/api/chat`：返回 `text/plain` 纯文本
- `/v1/chat/completions`：返回 OpenAI 兼容 `text/event-stream`，SSE 事件顺序遵循 OpenAI 规范（`delta → finish → usage → [DONE]`），含真实 `usage` 统计
- `/v1/messages`：返回 Anthropic 兼容 SSE 事件流（`message_start → content_block_delta → message_stop`）

> ⚠️ 当前非逐字流式（完整响应一次性返回）。EdgeOne Edge Runtime 对 `ReadableStream` 作为 Response body 的支持仍在验证中，后续版本可能切换为真流式。

## 自定义供应商

设环境变量 `CUSTOM_PROVIDERS`，值为 **JSON 数组**（注意必须是合法 JSON，不能用单引号）：

```json
[
  {
    "id": "deepseek",
    "url": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "format": "openai"
  },
  {
    "id": "groq",
    "url": "https://api.groq.com/openai/v1",
    "model": "llama-3.3-70b-versatile",
    "format": "openai"
  }
]
```

支持的 `format` 值：

| format | 鉴权方式 | 代表供应商 |
|--------|---------|-----------|
| `openai` | `Authorization: Bearer` header | OpenAI、DeepSeek、Groq、通义千问… |
| `anthropic` | `x-api-key` header | Claude |
| `gemini` | `x-goog-api-key` header | Gemini |

自定义供应商的 Key 用 `{ID大写}_API_KEY` 命名（如 id 为 `deepseek` → `DEEPSEEK_API_KEY`）。

**模型名路由规则**（`/v1/chat/completions` 和 `/v1/messages`）：
1. 自定义供应商精确/前缀匹配（模型名等于 id 或以 `id-` 开头）
2. 内置供应商正则：`gpt-*`/`o*` → openai，`gemini-*` → gemini，`claude-*` → claude
3. 自定义供应商模糊匹配（模型名包含 id）
4. 都匹配不到 → 回退到 `DEFAULT_PROVIDER`

## 项目结构

```
├── index.html                    # 浏览器聊天页（多轮对话）
└── edge-functions/
    ├── _shared.js                # 共享模块（配置/鉴权/CORS/构建/解析）
    └── api/
    │   ├── chat.js               # 聊天页接口 /api/chat
    │   └── config.js             # 配置接口 /api/config
    └── v1/
        ├── chat/
        │   └── completions.js    # OpenAI 兼容 /v1/chat/completions
        └── messages.js           # Anthropic 兼容 /v1/messages
```

所有端点通过 ES module `import` 引入 `_shared.js`，共享逻辑（供应商配置、鉴权、CORS、上游请求构建、响应解析）集中一处。`_shared.js` 不导出 `onRequest`，不会被当作可访问路由。

## 安全说明

- API Key 存储在 EdgeOne 环境变量中，不出现在代码里
- **`/api/config` 不返回任何密钥**，未开启聊天页时连供应商列表都不返回
- **聊天页默认关闭**：不设 `ENABLE_CHAT_PAGE=true` 时，访问域名只显示「仅 API 模式」，`/api/chat` 接口返回 403
- **API 端点鉴权**：设了 `ACCESS_TOKEN` 则 `/v1/*` 必须带 `Authorization: Bearer`、`X-API-Token` 或 `x-api-key` header；不设则不强制（生产环境务必设置）
- 聊天页开放时不鉴权（信任域名不公开），如需更高安全性请关闭聊天页只走 API
- 上游错误响应经过消毒（截断 + 提取 message），不会泄露内部 URL/请求 ID
- 建议设 `ALLOWED_ORIGIN` 锁定 CORS

## 限制

- EdgeOne Edge Functions：请求 body 1MB、CPU 时间 200ms（不含 I/O 等待，转发场景足够）
- 上游请求超时默认 25s（可通过 `UPSTREAM_TIMEOUT` 调整）
- 流式输出当前为一次性返回（非逐字），详见上方「流式输出」章节

## License

MIT License
