# API 中转站

一键部署到 EdgeOne Pages 的免费 AI API 中转站。支持 OpenAI / Gemini / Claude/ 自定义，解决**跨境访问 + Key 隐藏 + CORS 跨域**，附带多轮对话与流式输出。

## 快速开始

### 1. 部署到 EdgeOne Pages

1. 打开 [pages.edgeone.ai](https://pages.edgeone.ai) 登录腾讯云账号
2. 创建项目 → 连接 GitHub 仓库 `lingzhanlab/apirelay`
3. 框架预设选 **None**，构建命令留空，输出目录填 `./`
4. 部署

### 2. 配置环境变量

在 EdgeOne Pages 后台 → Settings → Environment Variables：

| 变量名 | 必填 | 说明 | 示例 |
|--------|------|------|------|
| `ACCESS_TOKEN` | ⬜ | API 端点访问密钥（/v1/chat/completions），不设则 API 不强制鉴权 | `sk-relay-xxxx` |
| `OPENAI_API_KEY` | ⬜ | OpenAI API Key | `sk-proj-xxxx` |
| `GEMINI_API_KEY` | ⬜ | Google Gemini API Key | `AIzaSyDxxxx` |
| `CLAUDE_API_KEY` | ⬜ | Anthropic Claude API Key | `sk-ant-api03-xxxx` |
| `ALLOWED_ORIGIN` | ⬜ | CORS 允许的域名 | `https://your-site.com` |
| `DEFAULT_PROVIDER` | ⬜ | 默认供应商 | `openai` |
| `ENABLE_CHAT_PAGE` | ⬜ | 设为 `true` 才开放浏览器聊天页（默认关闭） | `true` |
| `CUSTOM_PROVIDERS` | ⬜ | 自定义供应商 JSON | 见下方 |
| `MODEL_OVERRIDES` | ⬜ | 覆盖默认模型 JSON | `{"openai":"gpt-4o"}` |
| `MAX_TOKENS` | ⬜ | 单次回复最大 token 数（仅 Claude 生效，默认 4096） | `8192` |

### 3. 使用

**浏览器聊天页**：`https://你的域名.edgeone.dev`（自带多轮对话 + 流式逐字显示）

> ⚠️ 聊天页**默认关闭**，需设置环境变量 `ENABLE_CHAT_PAGE=true` 才开放。未开启时访问域名只会看到「仅 API 模式」提示，不暴露任何信息。

**代码调用（非流式）**：
```bash
curl -X POST https://你的域名.edgeone.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你设的ACCESS_TOKEN" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"你好"}]}'
```

**代码调用（流式，OpenAI 兼容 SSE）**：
```bash
curl -X POST https://你的域名.edgeone.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你设的ACCESS_TOKEN" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"讲个故事"}],"stream":true}'
# 返回 OpenAI 兼容 SSE 流，第三方客户端直接接入
```

**客户端接入（LobeChat / ChatBox / OpenWebUI 等，OpenAI 兼容）**：
- API 地址：`https://你的域名.edgeone.dev`（**只填到域名根，不带 `/v1`**）
  - 客户端会自动拼 `/v1/chat/completions`，填了 `/v1` 会变成 `/v1/v1/chat/completions` 导致 404
- API Key：填 `ACCESS_TOKEN` 的值
- 模型选 `gpt-3.5-turbo` / `gemini-2.0-flash` / `claude-3-haiku-20240307` 或你设的默认模型
- 自动支持 `stream: true`，返回 OpenAI 兼容 SSE 流

> 💡 如果你的客户端不自动补全路径（要求填完整 URL），则填 `https://你的域名.edgeone.dev/v1/chat/completions`

**Anthropic SDK / Claude 客户端接入**：
- base_url：`https://你的域名.edgeone.dev`（**只填到域名根，不带 `/v1`**）
  - SDK 会自动拼 `/v1/messages`，填了 `/v1` 会变成 `/v1/v1/messages` 导致 404
- API Key：填 `ACCESS_TOKEN` 的值（SDK 会以 `x-api-key` header 发送，已兼容）
- 模型填 `claude-3-haiku-20240307` 等，或 `gpt-4o` / `gemini-2.0-flash`（自动路由到对应供应商）
- 入参用 Anthropic 格式（`system` 顶层字段、`max_tokens` 等），输出统一成 Anthropic 格式
- 支持 `stream: true`，返回 Anthropic SSE 事件流（`message_start` → `content_block_delta` → `message_stop`）

## API 端点

| 端点 | 说明 | 鉴权 | 流式 |
|------|------|------|------|
| `GET /api/config` | 前端配置接口（聊天页开放时返回供应商列表） | 无 | — |
| `POST /api/chat` | 聊天页专用（需 `ENABLE_CHAT_PAGE=true`） | 无 | `stream:true` → `text/plain` 纯文本流 |
| `POST /v1/chat/completions` | OpenAI 兼容格式（主接口） | `ACCESS_TOKEN` | `stream:true` → `text/event-stream` SSE |
| `POST /v1/messages` | Anthropic 兼容格式（Claude 客户端接入） | `ACCESS_TOKEN` | `stream:true` → Anthropic SSE 事件流 |

## 多轮对话

两个聊天端点都接受 `messages` 数组，支持多轮上下文与 system 角色：

```json
{
  "provider": "openai",
  "messages": [
    {"role": "system", "content": "你是简洁的助手"},
    {"role": "user", "content": "你好"},
    {"role": "assistant", "content": "你好！"},
    {"role": "user", "content": "再见"}
  ]
}
```

三种供应商的多轮都已正确处理：
- **OpenAI**：直接转发 `messages`
- **Claude**：`system` 提取到顶层 `system` 字段，其余多轮
- **Gemini**：`system` 提取到 `systemInstruction`，`assistant` 映射为 `model` 角色，多轮 `contents` 数组

`/api/chat` 也兼容旧前端的单轮 `prompt` 字符串（自动转成单条 user message）。

## 流式输出

请求体加 `"stream": true` 即可。上游三种格式的 SSE 都会被解析并转换：

- `/api/chat`：返回 `text/plain` 纯文本流，前端 `ReadableStream` reader 逐字读取
- `/v1/chat/completions`：返回 OpenAI 兼容 `text/event-stream`，第三方客户端直接用，含真实 `usage` 统计

SSE 事件顺序遵循 OpenAI 规范：`delta... → finish → usage → [DONE]`。

## 自定义供应商

设环境变量 `CUSTOM_PROVIDERS`，值为 JSON 数组：

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

| format | 鉴权 | 代表 |
|--------|------|------|
| `openai` | `Bearer` header | OpenAI、DeepSeek、Groq、通义千问… |
| `anthropic` | `x-api-key` header | Claude |
| `gemini` | URL query key | Gemini |

自定义供应商的 Key 用 `{ID大写}_API_KEY` 命名（如 `DEEPSEEK_API_KEY`）。

`/v1/chat/completions` 的模型名映射规则：`gpt-*`/`o*` → openai，`gemini-*` → gemini，`claude-*` → claude，其余按模型名是否包含供应商 `id` 模糊匹配，匹配不到回退到 `DEFAULT_PROVIDER`。

## 项目结构

```
├── index.html                    # 浏览器聊天页（多轮 + 流式）
└── edge-functions/
    ├── _shared.js                # 共享模块（配置/鉴权/CORS/构建/解析/流式）
    └── api/
    │   ├── chat.js               # 主接口 /api/chat
    │   └── config.js             # 配置接口 /api/config
    └── v1/
        └── chat/
            └── completions.js    # OpenAI 兼容 /v1/chat/completions
```

三个端点通过 ES module `import` 引入 `_shared.js`，所有重复逻辑（供应商配置、鉴权、CORS、上游请求构建、SSE 解析）集中一处。`_shared.js` 不导出 `onRequest`，不会被当作可访问路由。

## 安全说明

- API Key 存储在 EdgeOne 环境变量中
- **`/api/config` 不返回任何密钥**，未开启聊天页时连供应商列表都不返回
- **聊天页默认关闭**：不设 `ENABLE_CHAT_PAGE=true` 时，访问域名只显示「仅 API 模式」，`/api/chat` 接口也返回 403
- **API 端点鉴权**：设了 `ACCESS_TOKEN` 则 `/v1/chat/completions` 必须带 `Authorization: Bearer` 或 `X-API-Token`；不设则不强制（生产环境务必设置）
- 聊天页开放时不鉴权（信任域名不公开），如需更高安全性请关闭聊天页只走 API
- 建议设 `ALLOWED_ORIGIN` 锁定 CORS

## 限制

- EdgeOne Edge Functions：请求 body 1MB、CPU 时间 200ms（不含 I/O 等待，转发场景足够）
- 流式输出依赖 EdgeOne 对 `ReadableStream` 的支持（已确认支持）

## License

MIT License
