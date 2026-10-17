import type { D1Database } from '@cloudflare/workers-types';
import { createInbox, inboxExists } from './db/queries';
import { generateUniqueAddress } from './utils/random-address';

export interface TelegramEnv {
  DB: D1Database;
  MAIL_DOMAIN: string;
  TELEGRAM_BOT_TOKEN: string;
}

async function sendTempMessage(env: TelegramEnv, chatId: string, text: string, inlineKeyboard: any = null) {
  const payload: any = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  
  const data: any = await res.json();
  if (data.ok && data.result.message_id) {
    const deleteAt = new Date(Date.now() + 60000).toISOString();
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO telegram_messages_to_delete (id, chat_id, message_id, delete_at) VALUES (?, ?, ?, ?)')
      .bind(id, chatId, data.result.message_id, deleteAt).run();
  }
}

async function sendMessage(token: string, chatId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

async function sendMessageWithKeyboard(token: string, chatId: string, text: string, keyboard: any) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: { keyboard, resize_keyboard: true } })
  });
}

async function deleteMessage(token: string, chatId: string, messageId: number) {
  if (!messageId) return;
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  }).catch(() => {});
}

async function processNewInbox(env: TelegramEnv, chatId: string, localPart?: string) {
  const domain = env.MAIL_DOMAIN.split(',')[0].trim();
  let address = '';

  if (localPart) {
    const cleanLocalPart = localPart.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!cleanLocalPart) {
      await sendTempMessage(env, chatId, `⚠️ <b>Invalid Username</b>\n\nPlease use only letters and numbers.`);
      return;
    }
    address = `${cleanLocalPart}@${domain}`;
    await createInbox(env.DB, address);
  } else {
    address = await generateUniqueAddress(async (addr) => await inboxExists(env.DB, addr), domain);
    await createInbox(env.DB, address);
  }

  await env.DB.prepare('INSERT OR IGNORE INTO telegram_inboxes (chat_id, inbox_address) VALUES (?, ?)')
    .bind(chatId, address).run();

  const type = localPart ? 'Custom' : 'Random';
  await sendTempMessage(env, chatId, `✅ <b>${type} Inbox Generated!</b>\n\n📬 <b>Address:</b> <code>${address}</code>`);
}

export async function handleTelegramWebhook(request: Request, env: TelegramEnv): Promise<Response> {
  try {
    const body: any = await request.json();
    const token = env.TELEGRAM_BOT_TOKEN;

    const mainKeyboard = [
      [{ text: '➕ New Inbox' }, { text: '📋 List Inboxes' }],
      [{ text: '🗑️ Delete All' }, { text: '❓ Help' }]
    ];

    // 1. INLINE MODE
    if (body.inline_query) {
      const iq = body.inline_query;
      const query = iq.query.trim();
      const domain = env.MAIL_DOMAIN.split(',')[0].trim();

      let address = '';
      if (query) {
        const clean = query.toLowerCase().replace(/[^a-z0-9]/g, '');
        address = `${clean}@${domain}`;
        await createInbox(env.DB, address);
      } else {
        address = await generateUniqueAddress(async (addr) => await inboxExists(env.DB, addr), domain);
        await createInbox(env.DB, address);
      }

      const result = {
        type: 'article',
        id: crypto.randomUUID(),
        title: address,
        description: `Click to send this email address to the chat`,
        input_message_content: {
          message_text: `📬 <b>Email Address:</b> <code>${address}</code>\n\n<i>Use this address. I will notify you when an email arrives.</i>`,
          parse_mode: 'HTML'
        }
      };

      await fetch(`https://api.telegram.org/bot${token}/answerInlineQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inline_query_id: iq.id, results: [result], cache_time: 0 })
      });
      return new Response('OK');
    }

    // 2. CALLBACK QUERY (TOMBOL INLINE)
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

      if (data === 'new_random') {
        await processNewInbox(env, chatId);
      } 
      else if (data === 'new_custom') {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: `⌨️ <b>Please type your desired username:</b>\n\n<i>Just type the name, e.g., <code>budi</code></i>`, parse_mode: 'HTML' })
        });
        const d: any = await res.json();
        if (d.ok) {
          await env.DB.prepare('INSERT OR REPLACE INTO telegram_states (chat_id, state, prompt_message_id) VALUES (?, ?, ?)')
            .bind(chatId, 'awaiting_custom_username', d.result.message_id).run();
        }
      }
      return new Response('OK');
    }

    // 3. PESAN TEKS BIASA
    if (!body.message || !body.message.text) return new Response('OK');

    const chatId = body.message.chat.id.toString();
    const messageId = body.message.message_id;
    const text = body.message.text.trim();

    await deleteMessage(token, chatId, messageId); 

    const stateRow = await env.DB.prepare('SELECT state, prompt_message_id FROM telegram_states WHERE chat_id = ?').bind(chatId).first();

    if (stateRow && stateRow.state === 'awaiting_custom_username') {
      if (stateRow.prompt_message_id) await deleteMessage(token, chatId, stateRow.prompt_message_id);
      await env.DB.prepare('DELETE FROM telegram_states WHERE chat_id = ?').bind(chatId).run();
      await processNewInbox(env, chatId, text);
      return new Response('OK');
    }

    if (text === '/start' || text === '🏠 Main Menu') {
      await sendMessageWithKeyboard(token, chatId, '🏠 <b>Main Menu</b>\n\nPlease choose an option below:', mainKeyboard);
      return new Response('OK');
    }

    if (text === '/new' || text === '➕ New Inbox') {
      const inlineButtons = [[
        { text: '🎲 Random', callback_data: 'new_random' },
        { text: '✏️ Custom', callback_data: 'new_custom' }
      ]];
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: `➕ <b>Create New Inbox</b>\n\nChoose the type:`, parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineButtons } })
      });
      const d: any = await res.json();
      if (d.ok) {
        await env.DB.prepare('INSERT INTO telegram_messages_to_delete (id, chat_id, message_id, delete_at) VALUES (?, ?, ?, ?)')
          .bind(crypto.randomUUID(), chatId, d.result.message_id, new Date(Date.now() + 60000).toISOString()).run();
      }
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
      await sendTempMessage(env, chatId, `🤖 <b>Help Center</b>\n\n1. Click <b>➕ New Inbox</b>.\n2. Type <b>@BotName</b> in any chat for quick email generation.`);
      return new Response('OK');
    }

    return new Response('OK');
  } catch (err: any) {
    console.error('❌ Fatal Error:', err.message);
    return new Response('Error', { status: 500 });
  }
}
