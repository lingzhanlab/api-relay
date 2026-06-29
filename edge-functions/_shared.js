// apirelay 共享模块 · 端点共用
// 只 export 工具函数，不导出 onRequest，不会被当作可访问路由

// ========== 常量 ==========

export const DEFAULTS = {
  openai: { url: 'https://api.openai.com/v1',                        model: 'gpt-3.5-turbo',           format: 'openai' },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash',        format: 'gemini' },
  claude: { url: 'https://api.anthropic.com/v1',                     model: 'claude-3-haiku-20240307', format: 'anthropic' },
};

export const KEY_ENV = { openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', claude: 'CLAUDE_API_KEY' };

// ========== 配置解析 ==========

export function loadCustomProviders(env) {
  try {
    const raw = env.CUSTOM_PROVIDERS;
    if (!raw) return {};
    const list = JSON.parse(raw);
    const map = {};
    for (const p of list) {
      if (!p.id || !/^[a-zA-Z0-9_-]+$/.test(p.id)) continue;  // id 只允许字母数字 _ -
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
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': allowedOrigin(env),
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Token, x-api-key, anthropic-version',
  };
}

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
// 聊天页由 ENABLE_CHAT_PAGE 开关控制（默认关闭）；API 端点用 ACCESS_TOKEN 鉴权（未设则不强制）。
// 鉴权兼容三种 header：Authorization: Bearer / X-API-Token / x-api-key

export function checkAuth(env, request) {
  const secret = env.ACCESS_TOKEN;
  if (!secret) return null;

  const bearer = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const header = request.headers.get('X-API-Token');
  const anthropicKey = request.headers.get('x-api-key');
  if (bearer === secret || header === secret || anthropicKey === secret) return null;

  return new Response(
    JSON.stringify({ error: { message: '未授权访问', type: 'authentication_error' } }),
    { status: 401, headers: corsHeaders(env) }
  );
}

// ========== 输入校验 ==========

export function sanitizeModel(m) {
  if (typeof m !== 'string') return '';
  return m.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 128);
}

export const MAX_MESSAGES = 500;

export function validateMessages(messages) {
  if (!Array.isArray(messages)) return 'messages 必须是数组';
  if (messages.length === 0) return 'messages 不能为空';
  if (messages.length > MAX_MESSAGES) return `messages 超过 ${MAX_MESSAGES} 条上限`;
  for (const m of messages) {
    if (!m || typeof m.role !== 'string') return 'message 缺少 role 字段';
  }
  return null;
}

// ========== 供应商路由 ==========
//
// 优先级：自定义精确/前缀 → 内置正则 → 自定义模糊 → 默认

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

  for (const [id, cfg] of customs) {
    if (m === id || ml.startsWith(id.toLowerCase() + '-')) return { provider: id, cfg };
  }
  if (/^gpt/i.test(m) || /^o\d/i.test(m)) return all.openai ? { provider: 'openai', cfg: all.openai } : null;
  if (/gemini/i.test(m))                  return all.gemini ? { provider: 'gemini', cfg: all.gemini } : null;
  if (/claude/i.test(m))                  return all.claude ? { provider: 'claude', cfg: all.claude } : null;
  for (const [id, cfg] of customs) {
    if (ml.includes(id.toLowerCase())) return { provider: id, cfg };
  }
  const def = env.DEFAULT_PROVIDER || 'openai';
  return all[def] ? { provider: def, cfg: all[def] } : null;
}

// ========== 上游请求 ==========

export const UPSTREAM_TIMEOUT = 25000;

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
    body.stream_options = { include_usage: true };
  }
  return {
    url: `${cfg.url}/chat/completions`,
    body: JSON.stringify(body),
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  };
}

// ========== 响应解析 ==========

export function parseUpstreamResponse(data, format) {
  if (format === 'gemini')    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (format === 'anthropic') return (data.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('') || '';
  return data.choices?.[0]?.message?.content || '';
}

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

// ========== SSE 输出（假流式：完整响应包装成单 chunk）==========

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

// ========== Anthropic 格式输出 ==========

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

// ========== 错误处理 ==========

export function sanitizeUpstreamError(errText) {
  if (!errText) return 'upstream error';
  let msg = errText;
  try { msg = JSON.parse(errText)?.error?.message || msg; } catch {}
  if (typeof msg === 'string' && msg.length > 500) msg = msg.slice(0, 500) + '...';
  return msg;
}

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
