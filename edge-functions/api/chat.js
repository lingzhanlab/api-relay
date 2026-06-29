// /api/chat — 多供应商聊天接口（支持多轮对话 + 流式输出）
// 入参: { provider, prompt?, messages?, model?, stream? }
//   - prompt 单轮（向后兼容）/ messages 多轮，二选一
//   - stream=true 返回 text/plain 纯文本流，前端逐字显示
import {
  getAllProviders, parseModelOverrides, resolveApiKey,
  corsHeaders, handlePreflight,
  buildUpstreamRequest, parseUpstreamResponse, parseUpstreamUsage,
  createTextStream, sanitizeUpstreamError, fetchWithTimeout, validateMessages, logError,
} from '../_shared.js';

export default async function onRequest(context) {
  const { env, request } = context;

  const preflight = handlePreflight(env, request);
  if (preflight) return preflight;

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: { message: 'POST only', type: 'invalid_request_error' } }),
      { status: 405, headers: corsHeaders(env) });
  }

  // 聊天页关闭时，/api/chat 也拒绝（防止陌生人绕过前端直接调接口白嫖）
  if (env.ENABLE_CHAT_PAGE !== 'true') {
    return new Response(JSON.stringify({ error: { message: '聊天页未启用', type: 'forbidden_error' } }),
      { status: 403, headers: corsHeaders(env) });
  }

  try {
    const body = await request.json();
    const { provider, prompt, messages: rawMsgs, model: reqModel, stream = false } = body;

    if (!provider) {
      return new Response(JSON.stringify({ error: { message: '缺少 provider', type: 'invalid_request_error' } }),
        { status: 400, headers: corsHeaders(env) });
    }

    // 兼容旧前端: prompt 单轮 → messages；多轮优先用 messages
    let messages;
    if (Array.isArray(rawMsgs) && rawMsgs.length) {
      messages = rawMsgs;
    } else if (typeof prompt === 'string' && prompt) {
      messages = [{ role: 'user', content: prompt }];
    } else {
      return new Response(JSON.stringify({ error: { message: '缺少 prompt 或 messages', type: 'invalid_request_error' } }),
        { status: 400, headers: corsHeaders(env) });
    }

    const validErr = validateMessages(messages);
    if (validErr) {
      return new Response(JSON.stringify({ error: { message: validErr, type: 'invalid_request_error' } }),
        { status: 400, headers: corsHeaders(env) });
    }

    const all = getAllProviders(env);
    const cfg = all[provider];
    if (!cfg) {
      return new Response(JSON.stringify({ error: { message: `未知供应商，可选: ${Object.keys(all).join(' / ')}`, type: 'invalid_request_error' } }),
        { status: 400, headers: corsHeaders(env) });
    }

    const overrides = parseModelOverrides(env);
    const model = reqModel || overrides[provider] || cfg.model;
    const apiKey = resolveApiKey(env, provider);
    if (!apiKey) {
      return new Response(JSON.stringify({ error: { message: `${provider} API Key 未配置`, type: 'server_error' } }),
        { status: 500, headers: corsHeaders(env) });
    }

    const upReq = buildUpstreamRequest(cfg, messages, model, apiKey, env, { stream });
    let upRes;
    try {
      upRes = await fetchWithTimeout(upReq.url, { method: 'POST', headers: upReq.headers, body: upReq.body }, env);
    } catch (e) {
      logError('/api/chat', provider, model, 504, e.name === 'AbortError' ? 'upstream timeout' : e.message);
      return new Response(JSON.stringify({ error: { message: e.name === 'AbortError' ? '上游响应超时' : e.message, type: 'upstream_error', provider } }),
        { status: 504, headers: corsHeaders(env) });
    }

    if (!upRes.ok) {
      const errText = await upRes.text();
      logError('/api/chat', provider, model, upRes.status, sanitizeUpstreamError(errText));
      return new Response(JSON.stringify({ error: { message: sanitizeUpstreamError(errText), type: 'upstream_error', provider } }),
        { status: upRes.status, headers: corsHeaders(env) });
    }

    if (stream) {
      // 纯文本流：前端 reader 读 UTF-8 chunk 逐字 append
      return new Response(createTextStream(upRes.body, cfg.format), {
        headers: {
          ...corsHeaders(env),
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      });
    }

    const data = await upRes.json();
    return new Response(JSON.stringify({
      provider,
      model,
      content: parseUpstreamResponse(data, cfg.format),
      usage: parseUpstreamUsage(data, cfg.format),
    }), { headers: corsHeaders(env) });

  } catch (e) {
    logError('/api/chat', null, null, 500, e.message);
    return new Response(JSON.stringify({ error: { message: e.message, type: 'server_error' } }),
      { status: 500, headers: corsHeaders(env) });
  }
}
