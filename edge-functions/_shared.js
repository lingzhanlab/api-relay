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
      if (!p.id || !p.url) continue;
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

export function corsHeaders(env, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedOrigin(env),
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Token',
    ...extra,
  };
}

// OPTIONS 预检统一处理；非 OPTIONS 返回 null
export function handlePreflight(env, request, methods = 'POST, GET, OPTIONS') {
  if (request.method !== 'OPTIONS') return null;
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': allowedOrigin(env),
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Token',
    },
  });
}

// ========== 鉴权 ==========
//
// 策略：
//   1. 未设 ACCESS_TOKEN → 不强制（保持向后兼容，但生产环境强烈建议设置）
//   2. 来自自身 index.html 的同源请求 + ENABLE_CHAT_PAGE 未关闭 → 放行（前端无需持有 token）
//   3. 其余请求必须带 Authorization: Bearer <token> 或 X-API-Token: <token>
//
// 这样前端不再需要拿到 accessToken（修复 config.js 旧版把 token 直接返回给前端的风险）。

export function isSameOriginRequest(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    return origin === new URL(request.url).origin;
  } catch { return false; }
}

// 返回 null = 通过；返回 Response = 拒绝（直接 return 该 Response）
export function checkAuth(env, request) {
  if (!env.ACCESS_TOKEN) return null;
  if (env.ENABLE_CHAT_PAGE !== 'false' && isSameOriginRequest(request)) return null;

  const bearer = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const header = request.headers.get('X-API-Token');
  if (bearer === env.ACCESS_TOKEN || header === env.ACCESS_TOKEN) return null;

  return new Response(
    JSON.stringify({ error: { message: '未授权访问', type: 'authentication_error' } }),
    { status: 401, headers: corsHeaders(env) }
  );
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
  const m = model || cfg.model;
  const maxTokens = parseInt(env.MAX_TOKENS, 10) || 4096;

  if (cfg.format === 'gemini') {
    const systemMsg = messages.find(x => x.role === 'system');
    const chatMsgs = messages.filter(x => x.role !== 'system');
    const body = {
      contents: chatMsgs.map(x => ({
        role: x.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: x.content }],
      })),
    };
    if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    const method = stream ? 'streamGenerateContent' : 'generateContent';
    // alt=sse 让 Gemini 返回 SSE 格式（默认是 chunked JSON，解析麻烦）
    const url = `${cfg.url}/models/${m}:${method}?key=${apiKey}${stream ? '&alt=sse' : ''}`;
    return { url, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } };
  }

  if (cfg.format === 'anthropic') {
    const systemMsg = messages.find(x => x.role === 'system');
    const chatMsgs = messages.filter(x => x.role !== 'system');
    const body = {
      model: m,
      max_tokens: maxTokens,
      messages: chatMsgs.map(x => ({ role: x.role, content: x.content })),
    };
    if (stream) body.stream = true;
    if (systemMsg) body.system = systemMsg.content;
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
  if (format === 'anthropic') return data.content?.[0]?.text || '';
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
      if (json.type === 'content_block_delta') return { delta: json.delta?.text };
      if (json.type === 'message_delta')       return { usage: json.usage || null };
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

// 上游 SSE body → OpenAI 兼容 SSE 流（供 /v1/chat/completions stream 模式直接返回）
// 顺序遵循 OpenAI 规范: delta... → finish → usage → [DONE]
export function createRelayStream(upstreamBody, format, model) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-relay-${Date.now()}`;
  let buffer = '';
  let stopped = false;
  let pendingUsage = null;

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
      const reader = upstreamBody.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of block.split('\n')) {
              const p = parseUpstreamSSELine(line, format);
              if (!p) continue;
              if (p.delta) controller.enqueue(encoder.encode(openaiSSEChunk(id, model, p.delta)));
              if (p.usage) pendingUsage = p.usage;          // 暂存，结尾再发
              if (p.finish && !stopped) {                   // finish chunk（只发一次）
                stopped = true;
                controller.enqueue(encoder.encode(openaiSSEChunk(id, model, '', { finish_reason: p.finish })));
              }
              if (p.final) { flushTail(controller); controller.close(); return; }
            }
          }
        }
        // 流自然结束（gemini 无 [DONE]，anthropic/openai 异常断流兜底）
        flushTail(controller);
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

// 供 /api/chat 简化流式：只吐纯文本 delta（前端逐字显示）
export function createTextStream(upstreamBody, format) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new ReadableStream({
    async start(controller) {
      const reader = upstreamBody.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
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
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}
