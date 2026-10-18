import api from './api/routes';
import publicApi from './api/public-api';
import { handleEmail } from './email-handler';
import { handleTelegramWebhook } from './telegram-handler';
import type { EmailHandlerEnv } from './email-handler';
import type { ApiEnv } from './api/routes';
import type { PublicApiEnv } from './api/public-api';

export interface Env extends ApiEnv, EmailHandlerEnv, PublicApiEnv {
  ASSETS: Fetcher;
  TELEGRAM_BOT_TOKEN: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/telegram/webhook' && request.method === 'POST') {
      return handleTelegramWebhook(request, env);
    }

    if (url.pathname.startsWith('/api/v1/')) {
      const apiUrl = new URL(request.url);
      apiUrl.pathname = url.pathname.slice(7);
      return publicApi.fetch(new Request(apiUrl, request), env, ctx);
    }

    if (url.pathname.startsWith('/api/')) {
      const apiUrl = new URL(request.url);
      apiUrl.pathname = url.pathname.slice(4);
      return api.fetch(new Request(apiUrl, request), env, ctx);
    }

    return env.ASSETS.fetch(request);
  },

  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleEmail(message, env);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date().toISOString();
    try {
      // 1. Hapus pesan bot Telegram yang berumur > 60 detik
      const { results: tgQueue } = await env.DB.prepare(
        'SELECT id, chat_id, message_id FROM telegram_messages_to_delete WHERE delete_at <= ?'
      ).bind(now).all();
      if (tgQueue && tgQueue.length > 0) {
        for (const row of tgQueue) {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: row.chat_id, message_id: row.message_id })
          }).catch(() => {});
          await env.DB.prepare('DELETE FROM telegram_messages_to_delete WHERE id = ?').bind(row.id).run();
        }
      }

      // 2. Hapus inbox yang sudah expired (berdasarkan expires_at)
      await env.DB.prepare(
        "DELETE FROM messages WHERE inbox_address IN (SELECT address FROM inboxes WHERE expires_at <= datetime('now'))"
      ).run();
      await env.DB.prepare(
        "DELETE FROM telegram_inboxes WHERE inbox_address IN (SELECT address FROM inboxes WHERE expires_at <= datetime('now'))"
      ).run();
      await env.DB.prepare(
        "DELETE FROM session_inboxes WHERE inbox_address IN (SELECT address FROM inboxes WHERE expires_at <= datetime('now'))"
      ).run();
      await env.DB.prepare(
        "DELETE FROM inboxes WHERE expires_at <= datetime('now')"
      ).run();

      console.log(`[cron] Auto-delete done at ${now}`);
    } catch (e) {
      console.error(`[cron] Failed:`, e);
    }
  }
};
