// /v1/messages — Anthropic 兼容端点
// 让 Anthropic SDK / Claude 客户端能用 base_url 接入：
//   base_url = https://你的域名.edgeone.dev
//   API Key  = ACCESS_TOKEN 的值（SDK 会以 x-api-key header 发送，checkAuth 已兼容）
//
// 入参（Anthropic 格式）:
//   { model, messages, system?, max_tokens?, stream? }
// model 参数路由同 /v1/chat/completions：claude-*→claude, gpt-*→openai, gemini-*→gemini
// 输出统一转成 Anthropic 格式（非流式 message 对象 / 流式 SSE 事件序列）
import {
  getAllProviders, resolveApiKey, resolveProvider,
  corsHeaders, handlePreflight, checkAuth,
  buildUpstreamRequest, parseUpstreamResponse, parseUpstreamUsage,
  toAnthropicResponse, sanitizeUpstreamError, fetchWithTimeout, validateMessages, logError,
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
    const { model, messages: rawMsgs, system, max_tokens, stream = false } = body;

    if (!Array.isArray(rawMsgs) || !rawMsgs.length) {
      return new Response(JSON.stringify({ error: { message: '缺少 messages', type: 'invalid_request_error' } }),
        { status: 400, headers: corsHeaders(env) });
    }

    // Anthropic 格式 → 内部统一 messages
    // Anthropic 的 system 是顶层字段（支持字符串或 [{type:'text',text}] 数组），messages 数组里无 system 角色
    const messages = [];
    if (typeof system === 'string' && system) {
      messages.push({ role: 'system', content: system });
    } else if (Array.isArray(system)) {
      const sysText = system.filter(b => b.type === 'text').map(b => b.text || '').join('');
      if (sysText) messages.push({ role: 'system', content: sysText });
    }
    for (const m of rawMsgs) {
      if (m.role === 'user' || m.role === 'assistant') {
        // Anthropic content 可能是字符串或 [{type:'text',text}]，统一成字符串
        const content = typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text || '').join('') : '');
        messages.push({ role: m.role, content });
      }
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

    // 估算 input tokens（流式时上游可能不返回 prompt_tokens，做兜底）
    const inputText = messages.map(m => m.content).join('');
    const inputUsageEst = Math.ceil(inputText.length / 4);

    // 如果客户端指定 max_tokens，透传给上游（由上游校验是否超过模型上限）
    const maxTokRaw = parseInt(max_tokens, 10);
    const envWithMax = Number.isFinite(maxTokRaw) && maxTokRaw > 0 ? { ...env, MAX_TOKENS: String(maxTokRaw) } : env;

    // 上游强制非流式（EdgeOne ReadableStream 流式待验证，临时回退）
    const upReq = buildUpstreamRequest(cfg, messages, model, apiKey, envWithMax, { stream: false });
    let upRes;
    try {
      upRes = await fetchWithTimeout(upReq.url, { method: 'POST', headers: upReq.headers, body: upReq.body }, env);
    } catch (e) {
      logError('/v1/messages', provider, model, 504, e.name === 'AbortError' ? 'upstream timeout' : e.message);
      return new Response(JSON.stringify({ error: { message: e.name === 'AbortError' ? '上游响应超时' : e.message, type: 'upstream_error' } }),
        { status: 504, headers: corsHeaders(env) });
    }

    if (!upRes.ok) {
      const errText = await upRes.text();
      logError('/v1/messages', provider, model, upRes.status, sanitizeUpstreamError(errText));
      return new Response(JSON.stringify({ error: { message: sanitizeUpstreamError(errText), type: 'upstream_error' } }),
        { status: upRes.status, headers: corsHeaders(env) });
    }

    const data = await upRes.json();
    const content = parseUpstreamResponse(data, cfg.format);
    const usage = parseUpstreamUsage(data, cfg.format);

    if (stream) {
      // 客户端要流式 → 把完整响应包装成 Anthropic SSE 事件序列
      const msgId = `msg_relay_${Date.now()}`;
      const sse = (event, d) => `event: ${event}\ndata: ${JSON.stringify(d)}\n\n`;
      const resp = toAnthropicResponse(content, usage, model || cfg.model);
      const sseBody =
        sse('message_start', { type: 'message_start', message: { ...resp, content: [] } }) +
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content || '' } }) +
        sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: resp.usage.output_tokens } }) +
        sse('message_stop', { type: 'message_stop' });
      return new Response(sseBody, {
        headers: {
          ...corsHeaders(env),
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    return new Response(JSON.stringify(toAnthropicResponse(content, usage, model || cfg.model)),
      { headers: corsHeaders(env) });

  } catch (e) {
    logError('/v1/messages', null, null, 500, e.message);
    return new Response(JSON.stringify({ error: { message: e.message, type: 'server_error' } }),
      { status: 500, headers: corsHeaders(env) });
  }
}
