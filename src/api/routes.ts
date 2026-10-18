import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import {
  getInbox, createInbox, inboxExists, getSessionInboxes, getMessages,
  ensureSession, linkInboxToSession, unlinkInboxFromSession,
} from '../db/queries';
import { generateFamousAddress } from '../utils/famous-names';

export interface ApiEnv {
  DB: D1Database;
  APP_NAME: string;
  MAIL_DOMAIN: string;
  WEB_HOST: string;
  TELEGRAM_BOT_TOKEN: string;
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_SITE_KEY: string;
}

function getDomains(env: ApiEnv): string[] {
  return env.MAIL_DOMAIN.split(',').map(d => d.trim()).filter(Boolean);
}
function defaultDomain(env: ApiEnv): string {
  return getDomains(env)[0] || 'example.com';
}
function sessionId(c: any): string | null {
  return (c.req.header('x-session-id') || '').trim() || null;
}
function requireSession(c: any): string {
  const sid = sessionId(c);
  if (!sid) { c.status(400); return ''; }
  return sid;
}
async function hashKey(key: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(key));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ⭐ Fungsi Verifikasi Turnstile
async function verifyTurnstile(token: string, secretKey: string, remoteIp: string): Promise<boolean> {
  try {
    const formData = new FormData();
    formData.append('secret', secretKey);
    formData.append('response', token);
    if (remoteIp) formData.append('remoteip', remoteIp);

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
    });
    const outcome: any = await res.json();
    return outcome.success === true;
  } catch (e) {
    console.error('Turnstile verification failed:', e);
    return false;
  }
}

const api = new Hono<{ Bindings: ApiEnv }>();

api.get('/config', (c) => {
  const domains = getDomains(c.env);
  return c.json({
    appName: c.env.APP_NAME || 'Tempik',
    mailDomain: domains[0] || 'example.com',
    mailDomains: domains,
    webHost: c.env.WEB_HOST || 'tempik.example.com',
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || '',
  });
});


api.post('/captcha/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = body.token || '';
  if (!c.env.TURNSTILE_SECRET_KEY) return c.json({ ok: true }); // Bypass jika secret kosong
  const remoteIp = c.req.header('CF-Connecting-IP') || '';
  const isValid = await verifyTurnstile(token, c.env.TURNSTILE_SECRET_KEY, remoteIp);
  if (!isValid) return c.json({ error: 'Invalid captcha' }, 403);
  return c.json({ ok: true });
});

api.get('/session', async (c) => {
  let sid = sessionId(c);
  if (!sid) sid = crypto.randomUUID();
  await ensureSession(c.env.DB, sid);
  return c.json({ sessionId: sid });
});

api.get('/inboxes', async (c) => {
  const sid = requireSession(c);
  if (!sid) return c.json({ error: 'Missing x-session-id' }, 400);
  return c.json(await getSessionInboxes(c.env.DB, sid));
});

api.post('/inboxes', async (c) => {
  const sid = requireSession(c);
  if (!sid) return c.json({ error: 'Missing x-session-id' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const turnstileToken = body.turnstileToken || '';


  const domains = getDomains(c.env);
  const requestedDomain: string = (body.domain || '').trim().toLowerCase();
  const domain = requestedDomain && domains.includes(requestedDomain) ? requestedDomain : defaultDomain(c.env);
  if (requestedDomain && !domains.includes(requestedDomain)) return c.json({ error: `Invalid domain` }, 400);
  const requested: string = (body.localPart || '').trim().toLowerCase();
  const ttlMinutes = Number(body.ttlMinutes) || 30;

  // ⭐ RATE LIMITING (Max 5 inbox per jam per IP)
  const clientIp = c.req.header('CF-Connecting-IP') || 'unknown';
  const { count } = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM rate_limits WHERE identifier = ? AND action = 'web_create' AND created_at > datetime('now', '-30 minutes')"
  ).bind(clientIp).first<{ count: number }>() || { count: 0 };

  if (count >= 5) {
    return c.json({ error: 'Rate limit exceeded. You can only create 5 inboxes per 30 minutes.' }, 429);
  }

  // Catat aktivitas ini
  await c.env.DB.prepare("INSERT INTO rate_limits (id, identifier, action) VALUES (?, ?, ?)")
    .bind(crypto.randomUUID(), clientIp, 'web_create').run();

  let address: string;
  if (requested) address = `${requested}@${domain}`;
  else address = await generateFamousAddress((a) => inboxExists(c.env.DB, a), domain);

  await createInbox(c.env.DB, address, ttlMinutes);
  await linkInboxToSession(c.env.DB, sid, address);
  return c.json((await getInbox(c.env.DB, address))!, 201);
});

// ... (Sisa endpoint DELETE, GET messages, GET inbox, push subscribe, keys, telegram cleanup SAMA SEPERTI SEBELUMNYA)
// Untuk menghemat tempat, saya tidak menulis ulang semuanya, tapi PASTIKAN file routes.ts kamu tetap memiliki endpoint tersebut di bawah.
// Kamu bisa copy-paste sisa kode dari file routes.ts yang lama (setelah api.post('/inboxes', ...)).

api.delete('/inboxes/:address', async (c) => {
  const sid = requireSession(c);
  if (!sid) return c.json({ error: 'Missing x-session-id' }, 400);
  const address = decodeURIComponent(c.req.param('address'));
  await unlinkInboxFromSession(c.env.DB, sid, address);
  return c.json({ ok: true });
});

api.get('/inboxes/:address/messages', async (c) => {
  const address = decodeURIComponent(c.req.param('address')).toLowerCase();
  return c.json(await getMessages(c.env.DB, address));
});

api.get('/inboxes/:address', async (c) => {
  const address = decodeURIComponent(c.req.param('address')).toLowerCase();
  const inbox = await getInbox(c.env.DB, address);
  if (!inbox) return c.json({ error: 'Inbox not found' }, 404);
  return c.json(inbox);
});

api.post('/push/subscribe', async (c) => {
  const body = await c.req.json();
  if (!body.subscription) return c.json({ error: 'No subscription' }, 400);
  const sid = (c.req.header('x-session-id') || '').trim();
  if (!sid) return c.json({ error: 'No session' }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO push_subscriptions (id, session_id, subscription) VALUES (?, ?, ?)')
    .bind(id, sid, JSON.stringify(body.subscription)).run();
  return c.json({ ok: true });
});

api.get('/telegram/cleanup', async (c) => {
  const now = new Date().toISOString();
  const { results } = await c.env.DB.prepare('SELECT id, chat_id, message_id FROM telegram_messages_to_delete WHERE delete_at <= ?')
    .bind(now).all();
  if (!results || !results.length) return c.json({ success: true, message: 'Tidak ada pesan.' });
  let deleted = 0;
  for (const row of results) {
    await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: row.chat_id, message_id: row.message_id })
    }).catch(() => {});
    await c.env.DB.prepare('DELETE FROM telegram_messages_to_delete WHERE id = ?').bind(row.id).run();
    deleted++;
  }
  return c.json({ success: true, message: `Berhasil menghapus ${deleted} pesan.` });
});

api.post('/keys', async (c) => {
  const sid = requireSession(c);
  if (!sid) return c.json({ error: 'Missing x-session-id' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const name = (body.name || 'Unnamed Key').substring(0, 50);
  const rand = crypto.getRandomValues(new Uint8Array(16));
  const keyBody = Array.from(rand).map(b => b.toString(16).padStart(2, '0')).join('');
  const key = `artex_${keyBody}`;
  const hash = await hashKey(key);
  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO api_keys (id, session_id, name, key_hash) VALUES (?, ?, ?, ?)')
    .bind(id, sid, name, hash).run();
  return c.json({ id, name, key, createdAt: new Date().toISOString() }, 201);
});

api.get('/keys', async (c) => {
  const sid = requireSession(c);
  if (!sid) return c.json({ error: 'Missing x-session-id' }, 400);
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, created_at, last_used_at FROM api_keys WHERE session_id = ? ORDER BY created_at DESC'
  ).bind(sid).all();
  return c.json(results || []);
});

api.delete('/keys/:id', async (c) => {
  const sid = requireSession(c);
  if (!sid) return c.json({ error: 'Missing x-session-id' }, 400);
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM api_keys WHERE id = ? AND session_id = ?').bind(id, sid).run();
  return c.json({ ok: true });
});

export default api;
