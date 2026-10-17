import api from './api/routes';
import { handleEmail } from './email-handler';
import { handleTelegramWebhook } from './telegram-handler';
import type { EmailHandlerEnv } from './email-handler';
import type { ApiEnv } from './api/routes';

export interface Env extends ApiEnv, EmailHandlerEnv {
  ASSETS: Fetcher;
  TELEGRAM_BOT_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Rute Webhook Telegram
    if (url.pathname === '/api/telegram/webhook' && request.method === 'POST') {
      return handleTelegramWebhook(request, env);
    }

    // Rute API biasa
    if (url.pathname.startsWith('/api/')) {
      const apiUrl = new URL(request.url);
      apiUrl.pathname = url.pathname.slice(4);
      const apiRequest = new Request(apiUrl, request);
      return api.fetch(apiRequest, env, ctx);
    }

    // File statis
    return env.ASSETS.fetch(request);
  },

  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleEmail(message, env);
  },

  // ⭐ FUNGSI CRON: Auto-Delete email lebih dari 24 jam
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      await env.DB.prepare("DELETE FROM messages WHERE received_at < datetime('now', '-24 hours')").run();
      await env.DB.prepare(
        "DELETE FROM inboxes WHERE created_at < datetime('now', '-24 hours') AND address NOT IN (SELECT DISTINCT inbox_address FROM messages)"
      ).run();
      await env.DB.prepare("DELETE FROM telegram_messages_to_delete WHERE delete_at < datetime('now', '-1 day')").run();
      console.log(`[cron] Auto-delete completed at ${new Date().toISOString()}`);
    } catch (e) {
      console.error(`[cron] Auto-delete failed:`, e);
    }
  }
};
