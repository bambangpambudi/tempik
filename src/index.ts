import api from './api/routes';
import { handleEmail } from './email-handler';
import type { EmailHandlerEnv } from './email-handler';
import type { ApiEnv } from './api/routes';

export interface Env extends ApiEnv, EmailHandlerEnv {
  ASSETS: Fetcher; // Binding untuk file statis
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 1. Jika URL diawali /api/, arahkan ke Backend API (Hono)
    if (url.pathname.startsWith('/api/')) {
      const apiUrl = new URL(request.url);
      apiUrl.pathname = url.pathname.slice(4); // buang /api
      const apiRequest = new Request(apiUrl, request);
      return api.fetch(apiRequest, env, ctx);
    }

    // 2. ⭐️ KUNCI UTAMA: Teruskan ke file statis (HTML, JS, CSS)
    // Jika file tidak ada, Cloudflare akan otomatis pakai not_found_handling
    return env.ASSETS.fetch(request);
  },

  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleEmail(message, env);
  },
};
