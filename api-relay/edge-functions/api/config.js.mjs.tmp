// /api/config — 前端读取可用供应商列表
// 安全变更: 不返回 accessToken；聊天页要求输入 CHAT_PASSWORD（密码门防白嫖）。
//          设了 CHAT_PASSWORD 时，本接口也要求带密码才能拿到供应商列表。
//          未设 CHAT_PASSWORD → 聊天页禁用，返回 chatEnabled=false（陌生人无法白嫖、也探测不到供应商）。
import { getAllProviders, resolveApiKey, corsHeaders, handlePreflight, checkAuth } from '../_shared.js';

export default async function onRequest(context) {
  const { env, request } = context;

  const preflight = handlePreflight(env, request, 'GET, OPTIONS');
  if (preflight) return preflight;

  // 未设 CHAT_PASSWORD → 聊天页禁用，直接返回（不暴露供应商列表）
  if (!env.CHAT_PASSWORD) {
    return new Response(JSON.stringify({
      providers: [],
      defaultProvider: env.DEFAULT_PROVIDER || 'openai',
      chatEnabled: false,
      authRequired: false,
    }), { headers: corsHeaders(env) });
  }

  // 设了 CHAT_PASSWORD → 本接口也要鉴权（否则陌生人能探测你配了哪些供应商）
  const authErr = checkAuth(env, request, 'chat');
  if (authErr) return authErr;

  const all = getAllProviders(env);
  const providers = Object.entries(all).map(([id, cfg]) => ({
    id,
    model: cfg.model,
    hasKey: !!resolveApiKey(env, id),
  }));

  return new Response(JSON.stringify({
    providers,
    defaultProvider: env.DEFAULT_PROVIDER || 'openai',
    chatEnabled: env.ENABLE_CHAT_PAGE !== 'false',
    authRequired: !!env.CHAT_PASSWORD,
  }), { headers: corsHeaders(env) });
}
