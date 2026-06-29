// /v1/chat/completions — OpenAI 兼容端点（支持多轮 + 流式 + 真实 usage）
// 第三方客户端（LobeChat / ChatBox / OpenWebUI 等）填这个地址即可当 OpenAI API 用
// model 参数映射: gpt-*/o* → openai, gemini-* → gemini, claude-* → claude, 其余按供应商 id 模糊匹配
import {
  getAllProviders, resolveApiKey,
  corsHeaders, handlePreflight, checkAuth,
  buildUpstreamRequest, parseUpstreamResponse, parseUpstreamUsage,
  createRelayStream,
} from '../../_shared.js';

// 模型名 → 供应商
function resolveProvider(model, env) {
  const all = getAllProviders(env);
  if (!model) {
    const def = env.DEFAULT_PROVIDER || 'openai';
    return all[def] ? { provider: def, cfg: all[def] } : null;
  }
  const m = String(model);
  if (/^gpt/i.test(m) || /^o\d/i.test(m)) return all.openai ? { provider: 'openai', cfg: all.openai } : null;
  if (/gemini/i.test(m))  return all.gemini ? { provider: 'gemini', cfg: all.gemini } : null;
  if (/claude/i.test(m))  return all.claude ? { provider: 'claude', cfg: all.claude } : null;
  // 自定义供应商: 模型名包含 id
  for (const [id, cfg] of Object.entries(all)) {
    if (m.toLowerCase().includes(id.toLowerCase())) return { provider: id, cfg };
  }
  const def = env.DEFAULT_PROVIDER || 'openai';
  return all[def] ? { provider: def, cfg: all[def] } : null;
}

export default async function onRequest(context) {
  const { env, request } = context;

  const preflight = handlePreflight(env, request);
  if (preflight) return preflight;

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: { message: 'POST only', type: 'invalid_request_error' } }),
      { status: 405, headers: corsHeaders(env) });
  }

  const authErr = checkAuth(env, request);
  if (authErr) return authErr;

  try {
    const body = await request.json();
    const { model, messages, stream = false } = body;

    if (!Array.isArray(messages) || !messages.length) {
      return new Response(JSON.stringify({ error: { message: '缺少 messages', type: 'invalid_request_error' } }),
        { status: 400, headers: corsHeaders(env) });
    }

    const resolved = resolveProvider(model, env);
    if (!resolved) {
      return new Response(JSON.stringify({ error: { message: '无可用供应商', type: 'server_error' } }),
        { status: 500, headers: corsHeaders(env) });
    }

    const { provider, cfg } = resolved;
    const apiKey = resolveApiKey(env, provider);
    if (!apiKey) {
      return new Response(JSON.stringify({ error: { message: `${provider} API Key 未配置`, type: 'server_error' } }),
        { status: 500, headers: corsHeaders(env) });
    }

    const upReq = buildUpstreamRequest(cfg, messages, model, apiKey, env, { stream });
    const upRes = await fetch(upReq.url, { method: 'POST', headers: upReq.headers, body: upReq.body });

    if (!upRes.ok) {
      const errText = await upRes.text();
      let msg = errText;
      try { msg = JSON.parse(errText)?.error?.message || errText; } catch {}
      return new Response(JSON.stringify({ error: { message: msg, type: 'upstream_error' } }),
        { status: upRes.status, headers: corsHeaders(env) });
    }

    if (stream) {
      // OpenAI 兼容 SSE 流
      return new Response(createRelayStream(upRes.body, cfg.format, model || cfg.model), {
        headers: {
          ...corsHeaders(env),
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    const data = await upRes.json();
    const content = parseUpstreamResponse(data, cfg.format);
    const usage = parseUpstreamUsage(data, cfg.format) || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    return new Response(JSON.stringify({
      id: `chatcmpl-relay-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || cfg.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage,
    }), { headers: corsHeaders(env) });

  } catch (e) {
    return new Response(JSON.stringify({ error: { message: e.message, type: 'server_error' } }),
      { status: 500, headers: corsHeaders(env) });
  }
}
