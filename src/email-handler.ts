import PostalMime from 'postal-mime';
import type { D1Database } from '@cloudflare/workers-types';
import { createInbox, inboxExists, insertMessage } from './db/queries';

export interface EmailHandlerEnv {
  DB: D1Database;
  MAIL_DOMAIN: string;
  TELEGRAM_BOT_TOKEN: string;
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

export async function handleEmail(message: ForwardableEmailMessage, env: EmailHandlerEnv): Promise<void> {
  const to = message.to.toLowerCase();
  const from = message.from.toLowerCase();

  try {
    const parser = new PostalMime();
    const parsed = await parser.parse(message.raw);
    const subject = parsed.subject || '(no subject)';
    const body = parsed.html || parsed.text?.trim() || '';
    const rawText = parsed.text || body;

    const db = env.DB;
    if (!(await inboxExists(db, to))) await createInbox(db, to);

    const msgId = `msg_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    await insertMessage(db, { id: msgId, inbox_address: to, from_address: from, subject, body });

    const tgLink = await db.prepare('SELECT chat_id FROM telegram_inboxes WHERE inbox_address = ?').bind(to).first();
    
    if (tgLink && tgLink.chat_id && env.TELEGRAM_BOT_TOKEN) {
      const chatId = tgLink.chat_id;
      const formattedBody = formatHtmlForTelegram(body);
      
      const text = `📧 <b>New Email Received!</b>\n\n` +
                   `📥 <b>To:</b> <code>${to}</code>\n` +
                   `👤 <b>From:</b> <code>${from}</code>\n` +
                   `📌 <b>Subject:</b> ${subject}\n\n` +
                   `📝 <b>Message:</b>\n${formattedBody}`;

      const inlineKeyboard: any[][] = [];
      const buttonsRow: any[] = [];

      // Link
      const linkMatch = body.match(/<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/i);
      if (linkMatch && linkMatch[1] && !linkMatch[1].startsWith('mailto:')) {
        let url = linkMatch[1];
        let linkText = linkMatch[2].replace(/<[^>]+>/g, '').trim() || 'Open Link';
        if (linkText.length > 30) linkText = linkText.substring(0, 30) + '...';
        buttonsRow.push({ text: `🔗 ${linkText}`, url: url });
      }

      // OTP
      const otpMatch = rawText.match(/\b\d{4,8}\b/);
      if (otpMatch) {
        const otpCode = otpMatch[0];
        if (!/^202\d$/.test(otpCode)) {
          // ⭐️ HANYA ANGKA TANPA EMOJI & TULISAN
          buttonsRow.push({ 
            text: otpCode, 
            copy_text: { text: otpCode } 
          });
        }
      }

      if (buttonsRow.length > 0) inlineKeyboard.push(buttonsRow);

      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          chat_id: chatId, 
          text: text, 
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(inlineKeyboard.length > 0 ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {})
        })
      }).catch(err => console.error('Failed to send TG notification:', err));
    }

    console.log(`[email] Stored message ${msgId} for ${to}`);
  } catch (err) {
    console.error(`[email] Failed:`, err);
  }
}
