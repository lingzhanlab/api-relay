// /api/config — 前端读取可用供应商列表
// 聊天页开关由 ENABLE_CHAT_PAGE 控制（默认关闭，必须显式 =true 才开放）。
// 开放时不鉴权（信任域名不公开）；关闭时不暴露供应商列表，只返回 chatEnabled=false。
import { getAllProviders, resolveApiKey, corsHeaders, handlePreflight } from '../_shared.js';

export default async function onRequest(context) {
  const { env, request } = context;

  const preflight = handlePreflight(env, request, 'GET, OPTIONS');
  if (preflight) return preflight;

  // 聊天页默认关闭：未显式设 ENABLE_CHAT_PAGE=true → 不暴露供应商列表
  const chatEnabled = env.ENABLE_CHAT_PAGE === 'true';
  if (!chatEnabled) {
    return new Response(JSON.stringify({
      providers: [],
      defaultProvider: env.DEFAULT_PROVIDER || 'openai',
      chatEnabled: false,
    }), { headers: corsHeaders(env) });
  }

  // 聊天页开放：返回供应商列表（不鉴权，信任域名不公开）
  const all = getAllProviders(env);
  const providers = Object.entries(all).map(([id, cfg]) => ({
    id,
    model: cfg.model,
    hasKey: !!resolveApiKey(env, id),
  }));

  return new Response(JSON.stringify({
    providers,
    defaultProvider: env.DEFAULT_PROVIDER || 'openai',
    chatEnabled: true,
  }), { headers: corsHeaders(env) });
}
