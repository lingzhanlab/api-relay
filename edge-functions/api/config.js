// /api/config — 前端读取可用供应商列表
// 安全变更: 不再返回 accessToken。前端同源调用 /api/chat 时由后端 checkAuth 放行，
//          外部 API 调用仍需带 Authorization: Bearer 或 X-API-Token。
import { getAllProviders, resolveApiKey, corsHeaders, handlePreflight } from '../_shared.js';

export default async function onRequest(context) {
  const { env, request } = context;

  const preflight = handlePreflight(env, request, 'GET, OPTIONS');
  if (preflight) return preflight;

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
  }), { headers: corsHeaders(env) });
}
