// apirelay 共享模块 · 三个端点共用
// 注意：本文件只 export 工具函数，不放 onRequest 默认导出，
//       不应被 EdgeOne 当作可访问路由（若被映射，访问会返回 405/500，不影响业务端点）。

// ========== 常量 ==========

export const DEFAULTS = {
  openai: { url: 'https://api.openai.com/v1',                              model: 'gpt-3.5-turbo',          format: 'openai' },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta',       model: 'gemini-2.0-flash',       format: 'gemini' },
  claude: { url: 'https://api.anthropic.com/v1',                           model: 'claude-3-haiku-20240307', format: 'anthropic' },
};

// 内置供应商的环境变量名映射（自定义供应商用 {ID大写}_API_KEY）
export const KEY_ENV = { openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', claude: 'CLAUDE_API_KEY' };

// ========== 配置解析 ==========

export function loadCustomProviders(env) {
  try {
    const raw = env.CUSTOM_PROVIDERS;
    if (!raw) return {};
    const list = JSON.parse(raw);
    const map = {};
    for (const p of list) {
      // id 只允许字母数字 _ -，防 ../ 之类污染 provider 映射
      if (!p.id || !/^[a-zA-Z0-9_-]+$/.test(p.id)) continue;
      if (!p.url) continue;
      map[p.id] = {
        url: p.url.replace(/\/$/, ''),
        model: p.model || 'default',
        format: p.format || 'openai',
      };
    }
    return map;
  } catch { return {}; }
}

export function getAllProviders(env) {
  return { ...DEFAULTS, ...loadCustomProviders(env) };
}

export function parseModelOverrides(env) {
  try { return env.MODEL_OVERRIDES ? JSON.parse(env.MODEL_OVERRIDES) : {}; }
  catch { return {}; }
}

export function resolveApiKey(env, provider) {
  return env[KEY_ENV[provider]] || env[`${provider.toUpperCase()}_API_KEY`];
}

// ========== CORS ==========

export function allowedOrigin(env) {
  return env.ALLOWED_ORIGIN || '*';
}

export function corsHeaders(env, methods = 'POST, GET, OPTIONS') {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',  // 防止 EdgeOne CDN 缓存鉴权失败/错误响应导致后续请求命中旧缓存
    'Access-Control-Allow-Origin': allowedOrigin(env),
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Token, x-api-key, anthropic-version',
  };
}

// OPTIONS 预检统一处理；非 OPTIONS 返回 null
export function handlePreflight(env, request, methods = 'POST, GET, OPTIONS') {
  if (request.method !== 'OPTIONS') return null;
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': allowedOrigin(env),
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Token, x-api-key, anthropic-version',
    },
  });
}

// ========== 鉴权 ==========
//
// 简化设计（默认关闭最安全）：
//   - 聊天页（/api/chat + /api/config）由 ENABLE_CHAT_PAGE 开关控制，默认关闭
//     · 未设 ENABLE_CHAT_PAGE=true → 聊天页禁用，接口直接拒绝
//     · 设了 ENABLE_CHAT_PAGE=true → 聊天页开放，不鉴权（信任域名不公开）
//   - API 端点（/v1/chat/completions）用 ACCESS_TOKEN 鉴权
//     · 未设 ACCESS_TOKEN → 不强制（向后兼容，生产环境务必设置）
//
// 这样默认部署 = 聊天页关着，陌生人扫到域名只能看到"仅 API 模式"提示，无法白嫖。
// 要用聊天页就显式 ENABLE_CHAT_PAGE=true，并接受"知道域名就能用"。

// 校验 ACCESS_TOKEN；返回 null = 通过；返回 Response = 拒绝（直接 return）
export function checkAuth(env, request) {
  const secret = env.ACCESS_TOKEN;
  if (!secret) return null;  // 未设 = 不强制（向后兼容）

  // 兼容三种客户端 header 习惯：
  //   - OpenAI SDK / curl: Authorization: Bearer <token>
  //   - 自定义客户端: X-API-Token: <token>
  //   - Anthropic SDK: x-api-key: <token>（base_url 接入时 SDK 默认带这个）
  const bearer = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const header = request.headers.get('X-API-Token');
  const anthropicKey = request.headers.get('x-api-key');
  if (bearer === secret || header === secret || anthropicKey === secret) return null;

  return new Response(
    JSON.stringify({ error: { message: '未授权访问', type: 'authentication_error' } }),
    { status: 401, headers: corsHeaders(env) }
  );
}

// 校验模型名：只允许字母数字 - . _ ，防止 path traversal / 注入
export function sanitizeModel(m) {
  if (typeof m !== 'string') return '';
  const clean = m.replace(/[^a-zA-Z0-9._-]/g, '');
  return clean.slice(0, 128);  // 顺带限长
}

// 输入防御性上限（宽松，只挡恶意构造，不影响正常使用）
// 单条 content 不设限——coding 场景常一次塞多文件，靠 EdgeOne body 1MB 硬限制兜底
export const MAX_MESSAGES = 500;        // 消息条数上限（长对话+RAG 够用）

// 流式空闲超时（ms）。上游在流式过程中可能短暂停顿（推理模型 thinking），
// 但超过 STREAM_IDLE_TIMEOUT 无任何数据 = 连接异常，应中断并通知客户端。
export const STREAM_IDLE_TIMEOUT = 30000;

// 给 reader 加空闲看门狗：每次 read 返回数据后 reset，超时则 cancel reader + 触发回调。
// onTimeout 包 try/catch：防止 timer 已触发但 controller 已 close 时 enqueue 抛异常。
// 返回 { reset(), clear() }
function withIdleTimeout(reader, timeoutMs, onTimeout) {
  let timer;
  let cleared = false;
  const reset = () => {
    clearTimeout(timer);
    if (cleared) return;
    timer = setTimeout(() => {
      if (cleared) return;
      try { reader.cancel().catch(() => {}); } catch {}
      try { if (onTimeout) onTimeout(); } catch {}
    }, timeoutMs);
  };
  reset();
  return { reset, clear: () => { cleared = true; clearTimeout(timer); } };
}

// 校验 messages 数组：条数 + 基本结构
// 返回 null = 通过；返回 string = 错误消息
export function validateMessages(messages) {
  if (!Array.isArray(messages)) return 'messages 必须是数组';
  if (messages.length === 0) return 'messages 不能为空';
  if (messages.length > MAX_MESSAGES) return `messages 超过 ${MAX_MESSAGES} 条上限`;
  for (const m of messages) {
    if (!m || typeof m.role !== 'string') return 'message 缺少 role 字段';
  }
  return null;
}

// 模型名 → 供应商
// 顺序: 自定义供应商精确/前缀匹配 → 内置正则 → 自定义模糊匹配兜底 → 默认
// 这样自定义 id 含 openai/gemini/claude 子串时不会被内置正则抢匹配
export function resolveProvider(model, env) {
  const all = getAllProviders(env);
  const isBuiltin = id => id === 'openai' || id === 'gemini' || id === 'claude';
  const customs = Object.entries(all).filter(([id]) => !isBuiltin(id));

  if (!model) {
    const def = env.DEFAULT_PROVIDER || 'openai';
    return all[def] ? { provider: def, cfg: all[def] } : null;
  }
  const m = String(model);
  const ml = m.toLowerCase();

  // 1. 自定义供应商: 精确匹配 id 或前缀 id-（最高优先级，避免与内置正则冲突）
  for (const [id, cfg] of customs) {
    if (m === id || ml.startsWith(id.toLowerCase() + '-')) return { provider: id, cfg };
  }
  // 2. 内置供应商: 按模型名特征匹配
  if (/^gpt/i.test(m) || /^o\d/i.test(m)) return all.openai ? { provider: 'openai', cfg: all.openai } : null;
  if (/gemini/i.test(m))                  return all.gemini ? { provider: 'gemini', cfg: all.gemini } : null;
  if (/claude/i.test(m))                  return all.claude ? { provider: 'claude', cfg: all.claude } : null;
  // 3. 兜底: 自定义供应商模糊匹配（模型名包含 id）
  for (const [id, cfg] of customs) {
    if (ml.includes(id.toLowerCase())) return { provider: id, cfg };
  }
  const def = env.DEFAULT_PROVIDER || 'openai';
  return all[def] ? { provider: def, cfg: all[def] } : null;
}

// 上游请求超时（ms）。EdgeOne Edge Function 总时限 ~30s，留 5s 余量做收尾。
export const UPSTREAM_TIMEOUT = parseInt(process?.env?.UPSTREAM_TIMEOUT, 10) || 25000;

// 带 AbortController 的 fetch：超时自动中断，释放 Edge Function 执行槽位。
// 用法: const res = await fetchWithTimeout(url, { method, headers, body }, env);
export async function fetchWithTimeout(url, opts, env) {
  const timeoutMs = parseInt(env?.UPSTREAM_TIMEOUT, 10) || UPSTREAM_TIMEOUT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ========== 构建上游请求 ==========
//
// messages: [{role:'system'|'user'|'assistant', content:string}]，支持多轮
// 修复要点：
//   - Gemini 多轮不再拍成单字符串，用 contents:[{role,parts}] + systemInstruction
//   - Claude 保留 system + 多轮
//   - OpenAI 直接转发 messages
//   - stream=true 时各格式都带流式参数

export function buildUpstreamRequest(cfg, messages, model, apiKey, env, { stream = false } = {}) {
  const m = sanitizeModel(model || cfg.model);
  const maxTokens = parseInt(env.MAX_TOKENS, 10) || 4096;

  if (cfg.format === 'gemini') {
    const systemMsg = messages.find(x => x.role === 'system');
    const chatMsgs = messages.filter(x => x.role !== 'system');
    const body = {
      contents: chatMsgs.map(x => ({
        role: x.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(x.content ?? '') }],
      })),
    };
    if (systemMsg) body.systemInstruction = { parts: [{ text: String(systemMsg.content ?? '') }] };
    const method = stream ? 'streamGenerateContent' : 'generateContent';
    // alt=sse 让 Gemini 返回 SSE 格式（默认是 chunked JSON，解析麻烦）
    // key 走 x-goog-api-key header，避免进 URL 日志/上游错误回显
    const url = `${cfg.url}/models/${m}:${method}${stream ? '?alt=sse' : ''}`;
    return { url, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey } };
  }

  if (cfg.format === 'anthropic') {
    const systemMsg = messages.find(x => x.role === 'system');
    const chatMsgs = messages.filter(x => x.role !== 'system');
    const body = {
      model: m,
      max_tokens: maxTokens,
      messages: chatMsgs.map(x => ({ role: x.role, content: String(x.content ?? '') })),
    };
    if (stream) body.stream = true;
    if (systemMsg) body.system = String(systemMsg.content ?? '');
    return {
      url: `${cfg.url}/messages`,
      body: JSON.stringify(body),
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    };
  }

  // openai-compatible
  const body = { model: m, messages };
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true }; // OpenAI/DeepSeek/Groq 支持，拿真实 usage
  }
  return {
    url: `${cfg.url}/chat/completions`,
    body: JSON.stringify(body),
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  };
}

// ========== 非流式响应解析 ==========

export function parseUpstreamResponse(data, format) {
  if (format === 'gemini')    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (format === 'anthropic') return (data.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('') || '';
  return data.choices?.[0]?.message?.content || '';
}

// 统一成 OpenAI 风格 usage
export function parseUpstreamUsage(data, format) {
  if (format === 'openai' && data.usage) {
    return { prompt_tokens: data.usage.prompt_tokens || 0, completion_tokens: data.usage.completion_tokens || 0, total_tokens: data.usage.total_tokens || 0 };
  }
  if (format === 'anthropic' && data.usage) {
    const p = data.usage.input_tokens || 0, c = data.usage.output_tokens || 0;
    return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
  }
  if (format === 'gemini' && data.usageMetadata) {
    const u = data.usageMetadata;
    return { prompt_tokens: u.promptTokenCount || 0, completion_tokens: u.candidatesTokenCount || 0, total_tokens: u.totalTokenCount || 0 };
  }
  return null;
}

// ========== 流式 SSE ==========

// 解析上游一行 SSE data，返回统一结构：
//   { delta?: string, finish?: 'stop', final?: boolean, usage?: object }
export function parseUpstreamSSELine(line, format) {
  if (!line || !line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (!data) return null;
  if (data === '[DONE]') return { final: true };
  try {
    const json = JSON.parse(data);
    if (format === 'openai') {
      const delta = json.choices?.[0]?.delta?.content;
      const finish = json.choices?.[0]?.finish_reason === 'stop' ? 'stop' : null;
      return { delta, finish, usage: json.usage || null };
    }
    if (format === 'anthropic') {
      // message_start 带 input_tokens（prompt_tokens 初始值）；message_delta 只带 output_tokens 最终值，需合并
      if (json.type === 'message_start')       return { usage: { prompt_tokens: json.message?.usage?.input_tokens || 0, completion_tokens: json.message?.usage?.output_tokens || 0 } };
      if (json.type === 'content_block_delta') return { delta: json.delta?.text };
      if (json.type === 'message_delta')       return { usage: { completion_tokens: json.usage?.output_tokens || 0 } };
      if (json.type === 'message_stop')        return { final: true };
      return null;
    }
    if (format === 'gemini') {
      const delta = json.candidates?.[0]?.content?.parts?.[0]?.text;
      const finish = json.candidates?.[0]?.finishReason === 'STOP' ? 'stop' : null;
      return { delta, finish, usage: json.usageMetadata || null };
    }
  } catch { return null; }
  return null;
}

// 生成 OpenAI 兼容的 SSE chunk
export function openaiSSEChunk(id, model, delta, { finish_reason = null, usage = null } = {}) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: delta ? { content: delta } : {}, finish_reason }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';

// 上游错误文本消毒：截断 + 提取 message，防止泄露内部 URL/请求 ID
export function sanitizeUpstreamError(errText) {
  if (!errText) return 'upstream error';
  let msg = errText;
  try { msg = JSON.parse(errText)?.error?.message || msg; } catch {}
  // 截断到 500 字符，避免巨长错误响应
  if (typeof msg === 'string' && msg.length > 500) msg = msg.slice(0, 500) + '...';
  return msg;
}

// 结构化错误日志（进 EdgeOne 实时日志）。不记录任何敏感信息（token/key/messages 内容）。
// 字段: endpoint / provider / model / status / error / ts
export function logError(endpoint, provider, model, status, errMsg) {
  try {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      endpoint,
      provider: provider || null,
      model: model || null,
      status: status || null,
      error: typeof errMsg === 'string' ? errMsg.slice(0, 300) : String(errMsg).slice(0, 300),
    }));
  } catch {}
}

// 上游 SSE body → OpenAI 兼容 SSE 流（供 /v1/chat/completions stream 模式直接返回）
// 顺序遵循 OpenAI 规范: delta... → finish → usage → [DONE]
// 带 30s 空闲超时：上游 stall 时自动收尾，防止客户端 reader 卡死
export function createRelayStream(upstreamBody, format, model) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-relay-${Date.now()}`;
  let buffer = '';
  let stopped = false;
  let pendingUsage = null;
  let reader = null;
  let watchdog = null;

  // 流结束时按规范顺序补齐: finish (若未发) → usage → [DONE]
  const flushTail = (controller) => {
    if (!stopped) {
      stopped = true;
      controller.enqueue(encoder.encode(openaiSSEChunk(id, model, '', { finish_reason: 'stop' })));
    }
    if (pendingUsage) {
      controller.enqueue(encoder.encode(openaiSSEChunk(id, model, '', { usage: pendingUsage })));
    }
    controller.enqueue(encoder.encode(SSE_DONE));
  };

  return new ReadableStream({
    async start(controller) {
      reader = upstreamBody.getReader();
      watchdog = withIdleTimeout(reader, STREAM_IDLE_TIMEOUT, () => {
        flushTail(controller);
        controller.close();
      });
      try {
        while (true) {
          const { done, value } = await reader.read();
          watchdog.reset();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of block.split('\n')) {
              const p = parseUpstreamSSELine(line, format);
              if (!p) continue;
              if (p.delta) controller.enqueue(encoder.encode(openaiSSEChunk(id, model, p.delta)));
              if (p.usage) pendingUsage = { ...pendingUsage, ...p.usage };
              if (p.finish && !stopped) {
                stopped = true;
                controller.enqueue(encoder.encode(openaiSSEChunk(id, model, '', { finish_reason: p.finish })));
              }
              if (p.final) { watchdog.clear(); flushTail(controller); controller.close(); return; }
            }
          }
        }
        watchdog.clear();
        flushTail(controller);
        controller.close();
      } catch (e) {
        watchdog.clear();
        try { controller.error(e); } catch {}  // controller 可能已被 onTimeout close
      }
    },
    cancel() {
      if (watchdog) watchdog.clear();
      if (reader) reader.cancel().catch(() => {});
    },
  });
}

// 供 /api/chat 简化流式：只吐纯文本 delta（前端逐字显示）
export function createTextStream(upstreamBody, format) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let reader = null;
  let watchdog = null;

  return new ReadableStream({
    async start(controller) {
      reader = upstreamBody.getReader();
      watchdog = withIdleTimeout(reader, STREAM_IDLE_TIMEOUT, () => {
        controller.close();
      });
      try {
        while (true) {
          const { done, value } = await reader.read();
          watchdog.reset();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of block.split('\n')) {
              const p = parseUpstreamSSELine(line, format);
              if (p?.delta) controller.enqueue(encoder.encode(p.delta));
            }
          }
        }
        watchdog.clear();
        controller.close();
      } catch (e) {
        watchdog.clear();
        try { controller.error(e); } catch {}  // controller 可能已被 onTimeout close
      }
    },
    cancel() {
      if (watchdog) watchdog.clear();
      if (reader) reader.cancel().catch(() => {});
    },
  });
}

// ========== Anthropic 兼容输出（供 /v1/messages）==========
//
// 把内部统一结构转成 Anthropic 格式：
//   - 非流式：{ content:[{type:'text',text}], usage:{input_tokens,output_tokens}, stop_reason, ... }
//   - 流式 SSE 事件序列遵循 Anthropic 规范:
//     message_start → content_block_start → content_block_delta... → content_block_stop → message_delta → message_stop

// 非流式响应转 Anthropic 格式
export function toAnthropicResponse(content, usage, model) {
  const inputTokens = usage?.prompt_tokens || 0;
  const outputTokens = usage?.completion_tokens || Math.ceil((content || '').length / 4);
  return {
    id: `msg_relay_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: content || '' }],
    model: model || 'relay',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

// 上游 SSE body → Anthropic 兼容 SSE 事件流
// 入参与 createRelayStream 一致（统一 parseUpstreamSSELine 解析上游）
export function createAnthropicStream(upstreamBody, format, model, inputUsage) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const msgId = `msg_relay_${Date.now()}`;
  let buffer = '';
  let started = false;
  let blockClosed = false;
  let finalUsage = { input_tokens: inputUsage || 0, output_tokens: 0 };
  let reader = null;
  let watchdog = null;

  const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  const openMessage = (controller) => {
    if (started) return;
    started = true;
    controller.enqueue(encoder.encode(sse('message_start', {
      type: 'message_start',
      message: {
        id: msgId, type: 'message', role: 'assistant', content: [],
        model: model || 'relay', stop_reason: null, stop_sequence: null,
        usage: { input_tokens: finalUsage.input_tokens, output_tokens: 1 },
      },
    })));
    controller.enqueue(encoder.encode(sse('content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    })));
  };

  const closeStream = (controller) => {
    if (!started) openMessage(controller);
    if (!blockClosed) {
      blockClosed = true;
      controller.enqueue(encoder.encode(sse('content_block_stop', { type: 'content_block_stop', index: 0 })));
    }
    controller.enqueue(encoder.encode(sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: finalUsage.output_tokens || 1 },
    })));
    controller.enqueue(encoder.encode(sse('message_stop', { type: 'message_stop' })));
  };

  return new ReadableStream({
    async start(controller) {
      reader = upstreamBody.getReader();
      watchdog = withIdleTimeout(reader, STREAM_IDLE_TIMEOUT, () => {
        closeStream(controller);
        controller.close();
      });
      try {
        while (true) {
          const { done, value } = await reader.read();
          watchdog.reset();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of block.split('\n')) {
              const p = parseUpstreamSSELine(line, format);
              if (!p) continue;
              if (p.delta) {
                openMessage(controller);
                finalUsage.output_tokens += Math.max(1, Math.ceil(p.delta.length / 4));
                controller.enqueue(encoder.encode(sse('content_block_delta', {
                  type: 'content_block_delta', index: 0,
                  delta: { type: 'text_delta', text: p.delta },
                })));
              }
              if (p.usage) {
                if (typeof p.usage.prompt_tokens === 'number') finalUsage.input_tokens = p.usage.prompt_tokens;
                if (typeof p.usage.completion_tokens === 'number') finalUsage.output_tokens = p.usage.completion_tokens;
              }
              if (p.final) { watchdog.clear(); closeStream(controller); controller.close(); return; }
            }
          }
        }
        watchdog.clear();
        closeStream(controller);
        controller.close();
      } catch (e) {
        watchdog.clear();
        try { controller.error(e); } catch {}  // controller 可能已被 onTimeout close
      }
    },
    cancel() {
      if (watchdog) watchdog.clear();
      if (reader) reader.cancel().catch(() => {});
    },
  });
}
