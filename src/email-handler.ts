import PostalMime from 'postal-mime';
import type { D1Database } from '@cloudflare/workers-types';
import { inboxExists, insertMessage } from './db/queries';
import webpush from 'web-push';

export interface EmailHandlerEnv {
  DB: D1Database;
  MAIL_DOMAIN: string;
  TELEGRAM_BOT_TOKEN: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
}

function formatHtmlForTelegram(html: string): string {
  if (!html) return '';
  let text = html.replace(/<(br|p|div|tr|li)[^>]*>/gi, '\n');
  text = text.replace(/<(?!\/?(a|b|strong|i|em|u|s|code|pre|blockquote)\b)[^>]*>/gi, '');
  text = text.replace(/<strong>/gi, '<b>').replace(/<\/strong>/gi, '</b>');
  text = text.replace(/<em>/gi, '<i>').replace(/<\/em>/gi, '</i>');
  text = text.replace(/<a\s+([^>]*?)>/gi, (match, attrs) => {
    const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
    if (hrefMatch) {
      let href = hrefMatch[1];
      if (!/^(https?|mailto):/i.test(href)) href = '#';
      return `<a href="${href}">`;
    }
    return '<a>';
  });
  text = text.replace(/\n\s*\n+/g, '\n\n');
  if (text.length > 1500) text = text.substring(0, 1500) + '\n\n<i>... [Truncated]</i>';
  return text.trim();
}

async function sendPushNotification(env: EmailHandlerEnv, to: string, from: string, subject: string, body: string) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
  webpush.setVapidDetails('mailto:support@artexmail.web.id', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

  const { results } = await env.DB.prepare('SELECT subscription FROM push_subscriptions').all();
  if (!results || !results.length) return;

  const payload = JSON.stringify({
    title: `📧 New Email: ${subject.substring(0, 30)}`,
    body: `From: ${from}\nTo: ${to}\n\n${body.replace(/<[^>]*>?/gm, '').substring(0, 100)}...`,
    url: `/email=${to.split('@')[0]}`
  });

  for (const row of results) {
    try {
      const sub = JSON.parse((row as any).subscription);
      await webpush.sendNotification(sub, payload);
    } catch (e) {
      console.warn('Push failed:', e);
    }
  }
}

export async function handleEmail(message: ForwardableEmailMessage, env: EmailHandlerEnv): Promise<void> {
  const to = message.to.toLowerCase();
  const from = message.from.toLowerCase();

  try {
    const db = env.DB;

    if (!(await inboxExists(db, to))) {
      console.log(`[email] Rejected: ${to} does not exist (expired).`);
      return;
    }

    const parser = new PostalMime();
    const parsed = await parser.parse(message.raw);
    const subject = parsed.subject || '(no subject)';
    const body = parsed.html || parsed.text?.trim() || '';
    const rawText = parsed.text || body;

    const msgId = `msg_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    await insertMessage(db, { id: msgId, inbox_address: to, from_address: from, subject, body });

    const plainBody = body.replace(/<[^>]*>?/gm, '').substring(0, 100);
    await sendPushNotification(env, to, from, subject, plainBody).catch(() => {});

    const tgLink = await db.prepare('SELECT chat_id FROM telegram_inboxes WHERE inbox_address = ?').bind(to).first();
    if (tgLink && tgLink.chat_id && env.TELEGRAM_BOT_TOKEN) {
      const chatId = tgLink.chat_id;
      const formattedBody = formatHtmlForTelegram(body);

      // ⭐ Menggunakan 100% Tag Blockquote Bawaan Telegram (Tanpa Emoji)
      const text = 
        `<b>📧 NEW EMAIL RECEIVED</b>\n\n` +
        `<blockquote>` +
        `<b>To:</b> <code>${to}</code>\n` +
        `<b>From:</b> <code>${from}</code>\n` +
        `<b>Subject:</b> ${subject}` +
        `</blockquote>\n\n` +
        `<b>MESSAGE</b>\n` +
        `<blockquote>${formattedBody}</blockquote>`;

      const inlineKeyboard = [];
      const buttonsRow = [];

      const linkMatch = body.match(/<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/i);
      if (linkMatch && linkMatch[1] && !linkMatch[1].startsWith('mailto:')) {
        let url = linkMatch[1], linkText = linkMatch[2].replace(/<[^>]+>/g, '').trim() || 'Open Link';
        if (linkText.length > 30) linkText = linkText.substring(0, 30) + '...';
        buttonsRow.push({ text: `🔗 ${linkText}`, url: url });
      }
      const otpMatch = rawText.match(/\b\d{4,8}\b/);
      if (otpMatch && !/^202\d$/.test(otpMatch[0])) {
        buttonsRow.push({ text: otpMatch[0], copy_text: { text: otpMatch[0] } });
      }
      if (buttonsRow.length > 0) inlineKeyboard.push(buttonsRow);

      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          chat_id: chatId, 
          text: text, 
          parse_mode: 'HTML', 
          disable_web_page_preview: true,
          ...(inlineKeyboard.length > 0 ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {})
        })
      }).catch(err => console.error('TG error:', err));
    }

    console.log(`[email] Stored message ${msgId} for ${to}`);
  } catch (err) {
    console.error(`[email] Failed:`, err);
  }
}
