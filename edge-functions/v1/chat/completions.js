// /v1/chat/completions — OpenAI 兼容端点（支持多轮 + 流式 + 真实 usage）
// 第三方客户端（LobeChat / ChatBox / OpenWebUI 等）填这个地址即可当 OpenAI API 用
// model 参数映射: gpt-*/o* → openai, gemini-* → gemini, claude-* → claude, 其余按供应商 id 模糊匹配
import {
  getAllProviders, resolveApiKey, resolveProvider,
  corsHeaders, handlePreflight, checkAuth,
  buildUpstreamRequest, parseUpstreamResponse, parseUpstreamUsage,
  sanitizeUpstreamError, fetchWithTimeout, validateMessages, logError,
  openaiSSEChunk, SSE_DONE,
} from '../../_shared.js';

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

    const validErr = validateMessages(messages);
    if (validErr) {
      return new Response(JSON.stringify({ error: { message: validErr, type: 'invalid_request_error' } }),
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

    // 上游强制非流式（EdgeOne ReadableStream 流式待验证，临时回退）
    const upReq = buildUpstreamRequest(cfg, messages, model, apiKey, env, { stream: false });
    let upRes;
    try {
      upRes = await fetchWithTimeout(upReq.url, { method: 'POST', headers: upReq.headers, body: upReq.body }, env);
    } catch (e) {
      logError('/v1/chat/completions', provider, model, 504, e.name === 'AbortError' ? 'upstream timeout' : e.message);
      return new Response(JSON.stringify({ error: { message: e.name === 'AbortError' ? '上游响应超时' : e.message, type: 'upstream_error' } }),
        { status: 504, headers: corsHeaders(env) });
    }

    if (!upRes.ok) {
      const errText = await upRes.text();
      logError('/v1/chat/completions', provider, model, upRes.status, sanitizeUpstreamError(errText));
      return new Response(JSON.stringify({ error: { message: sanitizeUpstreamError(errText), type: 'upstream_error' } }),
        { status: upRes.status, headers: corsHeaders(env) });
    }

    const data = await upRes.json();
    const content = parseUpstreamResponse(data, cfg.format);
    const usage = parseUpstreamUsage(data, cfg.format) || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    if (stream) {
      // 客户端要流式 → 把完整响应包装成单 chunk SSE（兼容客户端 stream 协议）
      const id = `chatcmpl-relay-${Date.now()}`;
      const sseBody =
        openaiSSEChunk(id, model || cfg.model, content) +
        openaiSSEChunk(id, model || cfg.model, '', { finish_reason: 'stop' }) +
        openaiSSEChunk(id, model || cfg.model, '', { usage }) +
        SSE_DONE;
      return new Response(sseBody, {
        headers: {
          ...corsHeaders(env),
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    return new Response(JSON.stringify({
      id: `chatcmpl-relay-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || cfg.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage,
    }), { headers: corsHeaders(env) });

  } catch (e) {
    logError('/v1/chat/completions', null, null, 500, e.message);
    return new Response(JSON.stringify({ error: { message: e.message, type: 'server_error' } }),
      { status: 500, headers: corsHeaders(env) });
  }
}
