import type { D1Database } from '@cloudflare/workers-types';
import { createInbox, inboxExists } from './db/queries';
import { generateUniqueAddress } from './utils/random-address';
import { generateFamousAddress } from './utils/famous-names';

export interface TelegramEnv {
  DB: D1Database;
  MAIL_DOMAIN: string;
  TELEGRAM_BOT_TOKEN: string;
}

async function sendTempMessage(env: TelegramEnv, chatId: string, text: string, inlineKeyboard: any = null): Promise<number | null> {
  const payload: any = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  
  const data: any = await res.json();
  if (data.ok && data.result.message_id) {
    const deleteAt = new Date(Date.now() + 60000).toISOString();
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO telegram_messages_to_delete (id, chat_id, message_id, delete_at) VALUES (?, ?, ?, ?)')
      .bind(id, chatId, data.result.message_id, deleteAt).run();
    return data.result.message_id;
  }
  return null;
}

async function sendPersistentMessageWithKeyboard(env: TelegramEnv, chatId: string, text: string, keyboard: any) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: { keyboard, resize_keyboard: true } })
  });
}

async function deleteMessage(token: string, chatId: string, messageId: number) {
  if (!messageId) return;
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  }).catch(() => {});
}

async function processNewInbox(env: TelegramEnv, chatId: string, localPart: string | undefined, ttlMinutes: number) {
  const domain = env.MAIL_DOMAIN.split(',')[0].trim();
  let address = '';

  if (localPart) {
    const cleanLocalPart = localPart.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!cleanLocalPart) {
      await sendTempMessage(env, chatId, `⚠️ <b>Invalid Username</b>\n\nPlease use only letters and numbers.`);
      return;
    }
    address = `${cleanLocalPart}@${domain}`;
    await createInbox(env.DB, address, ttlMinutes);
  } else {
    address = await generateFamousAddress(async (addr) => await inboxExists(env.DB, addr), domain);
    await createInbox(env.DB, address, ttlMinutes);
  }

  await env.DB.prepare('INSERT OR IGNORE INTO telegram_inboxes (chat_id, inbox_address) VALUES (?, ?)')
    .bind(chatId, address).run();

  const type = localPart ? 'Custom' : 'Random';
  const ttlLabel = ttlMinutes >= 1440 ? `${ttlMinutes/1440} Day(s)` : ttlMinutes >= 60 ? `${ttlMinutes/60} Hour` : `${ttlMinutes} Min`;
  await sendTempMessage(env, chatId, `✅ <b>${type} Inbox Generated!</b>\n\n📬 <b>Address:</b> <code>${address}</code>\n⏱ <b>Expires in:</b> ${ttlLabel}`);
}

export async function handleTelegramWebhook(request: Request, env: TelegramEnv): Promise<Response> {
  try {
    const body: any = await request.json();
    const token = env.TELEGRAM_BOT_TOKEN;

    const mainKeyboard = [
      [{ text: '➕ New Inbox' }, { text: '📋 List Inboxes' }],
      [{ text: '🗑️ Delete All' }, { text: '❓ Help' }]
    ];

    // 1. CALLBACK QUERY (TOMBOL INLINE)
    if (body.callback_query) {
      const cb = body.callback_query;
      const chatId = cb.message.chat.id.toString();
      const messageId = cb.message.message_id;
      const data = cb.data;

      await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cb.id })
      });

      await deleteMessage(token, chatId, messageId);

      // ⭐ Alur TTL: Pilih TTL dulu
      if (data.startsWith('ttl_')) {
        const ttl = parseInt(data.replace('ttl_', ''));
        const inlineButtons = [[
          { text: '🎲 Random', callback_data: `type_random_${ttl}` },
          { text: '✏️ Custom', callback_data: `type_custom_${ttl}` }
        ]];
        await sendTempMessage(env, chatId, `⏱ <b>TTL: ${ttl} minutes</b>\n\nChoose inbox type:`, inlineButtons);
        return new Response('OK');
      }

      // ⭐ Alur TTL: Pilih Random
      if (data.startsWith('type_random_')) {
        const ttl = parseInt(data.replace('type_random_', ''));
        await processNewInbox(env, chatId, undefined, ttl);
        return new Response('OK');
      }

      // ⭐ Alur TTL: Pilih Custom
      if (data.startsWith('type_custom_')) {
        const ttl = parseInt(data.replace('type_custom_', ''));
        const promptId = await sendTempMessage(env, chatId, `⌨️ <b>Enter username for inbox (TTL: ${ttl}m):</b>`);
        if (promptId) {
          await env.DB.prepare('INSERT OR REPLACE INTO telegram_states (chat_id, state, prompt_message_id) VALUES (?, ?, ?)')
            .bind(chatId, `awaiting_custom_username_${ttl}`, promptId).run();
        }
        return new Response('OK');
      }

      return new Response('OK');
    }

    // 2. PESAN TEKS BIASA
    if (!body.message || !body.message.text) return new Response('OK');

    const chatId = body.message.chat.id.toString();
    const messageId = body.message.message_id;
    const text = body.message.text.trim();

    await deleteMessage(token, chatId, messageId);

    const stateRow = await env.DB.prepare('SELECT state, prompt_message_id FROM telegram_states WHERE chat_id = ?').bind(chatId).first();

    // ⭐ Tangkap input username beserta TTL-nya
    if (stateRow && stateRow.state.startsWith('awaiting_custom_username')) {
      if (stateRow.prompt_message_id) await deleteMessage(token, chatId, stateRow.prompt_message_id);
      
      // Parse TTL dari state string (contoh: "awaiting_custom_username_30")
      let ttl = 30;
      const parts = stateRow.state.split('_');
      if (parts.length >= 4) ttl = parseInt(parts[3]) || 30;

      await env.DB.prepare('DELETE FROM telegram_states WHERE chat_id = ?').bind(chatId).run();
      await processNewInbox(env, chatId, text, ttl);
      return new Response('OK');
    }

    if (text === '/start' || text === '🏠 Main Menu') {
      await sendPersistentMessageWithKeyboard(env, chatId, '🏠 <b>Main Menu</b>\n\nPlease choose an option below:', mainKeyboard);
      return new Response('OK');
    }

    // ⭐ Tampilkan pilihan TTL saat user menekan "New Inbox"
    if (text === '/new' || text === '➕ New Inbox') {
      const inlineButtons = [
        [
          { text: '⚡ 10 Minutes', callback_data: 'ttl_10' },
          { text: '⏱ 30 Minutes', callback_data: 'ttl_30' }
        ],
        [
          { text: '🕐 1 Hour', callback_data: 'ttl_60' },
          { text: '📅 24 Hours', callback_data: 'ttl_1440' }
        ],
        [
          { text: '📆 7 Days', callback_data: 'ttl_10080' }
        ]
      ];
      await sendTempMessage(env, chatId, `➕ <b>Create New Inbox</b>\n\n⏱ <b>Select expiry time:</b>`, inlineButtons);
      return new Response('OK');
    }

    if (text === '/list' || text === '📋 List Inboxes') {
      const { results } = await env.DB.prepare('SELECT inbox_address FROM telegram_inboxes WHERE chat_id = ?').bind(chatId).all();
      if (!results || results.length === 0) {
        await sendTempMessage(env, chatId, '📭 <b>No inboxes found.</b>');
      } else {
        const list = results.map((r: any) => `• <code>${r.inbox_address}</code>`).join('\n');
        await sendTempMessage(env, chatId, `📬 <b>Your Active Inboxes:</b>\n\n${list}`);
      }
      return new Response('OK');
    }

    if (text === '/deleteall' || text === '🗑️ Delete All') {
      const { results } = await env.DB.prepare('SELECT inbox_address FROM telegram_inboxes WHERE chat_id = ?').bind(chatId).all();
      if (!results || results.length === 0) {
        await sendTempMessage(env, chatId, `📭 <b>Nothing to delete.</b>`);
        return new Response('OK');
      }
      for (const row of results) {
        const addr = (row as any).inbox_address;
        await env.DB.prepare('DELETE FROM messages WHERE inbox_address = ?').bind(addr).run();
        await env.DB.prepare('DELETE FROM session_inboxes WHERE inbox_address = ?').bind(addr).run();
        await env.DB.prepare('DELETE FROM inboxes WHERE address = ?').bind(addr).run();
      }
      await env.DB.prepare('DELETE FROM telegram_inboxes WHERE chat_id = ?').bind(chatId).run();
      await sendTempMessage(env, chatId, `🗑️ <b>Clean Sweep!</b>\n\nSuccessfully deleted <b>${results.length} inbox(es)</b>.`);
      return new Response('OK');
    }

    if (text === '/help' || text === '❓ Help') {
      await sendTempMessage(env, chatId, `🤖 <b>Help Center</b>\n\n1. Click <b>➕ New Inbox</b> to generate an email.\n2. Choose TTL (10m, 30m, 1h, 24h, 7d) then Random/Custom.`);
      return new Response('OK');
    }

    return new Response('OK');
  } catch (err: any) {
    console.error('❌ Fatal Error:', err.message);
    return new Response('Error', { status: 500 });
  }
}
