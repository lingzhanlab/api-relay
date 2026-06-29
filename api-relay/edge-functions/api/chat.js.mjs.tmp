// /api/chat — 多供应商聊天接口（支持多轮对话 + 流式输出）
// 入参: { provider, prompt?, messages?, model?, stream? }
//   - prompt 单轮（向后兼容）/ messages 多轮，二选一
//   - stream=true 返回 text/plain 纯文本流，前端逐字显示
import {
  getAllProviders, parseModelOverrides, resolveApiKey,
  corsHeaders, handlePreflight, checkAuth,
  buildUpstreamRequest, parseUpstreamResponse, parseUpstreamUsage,
  createTextStream,
} from '../_shared.js';

export default async function onRequest(context) {
  const { env, request } = context;

  const preflight = handlePreflight(env, request);
  if (preflight) return preflight;

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: { message: 'POST only', type: 'invalid_request_error' } }),
      { status: 405, headers: corsHeaders(env) });
  }

  const authErr = checkAuth(env, request, 'chat');
  if (authErr) return authErr;

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
    const upRes = await fetch(upReq.url, { method: 'POST', headers: upReq.headers, body: upReq.body });

    if (!upRes.ok) {
      const errText = await upRes.text();
      let msg = errText;
      try { msg = JSON.parse(errText)?.error?.message || errText; } catch {}
      return new Response(JSON.stringify({ error: { message: msg, type: 'upstream_error', provider } }),
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
    return new Response(JSON.stringify({ error: { message: e.message, type: 'server_error' } }),
      { status: 500, headers: corsHeaders(env) });
  }
}
