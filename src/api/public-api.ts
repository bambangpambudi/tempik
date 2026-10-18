import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import { getInbox, createInbox, inboxExists, getMessages } from '../db/queries';
import { generateUniqueAddress } from '../utils/random-address';
import { generateFamousAddress } from '../utils/famous-names';

export interface PublicApiEnv {
  DB: D1Database;
  MAIL_DOMAIN: string;
}

async function hashKey(key: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(key));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const api = new Hono<{ Bindings: PublicApiEnv }>();

// Middleware: Cek API Key
api.use('/*', async (c, next) => {
  const auth = c.req.header('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return c.json({ error: 'Missing Bearer token' }, 401);

  const key = m[1].trim();
  if (!key.startsWith('artex_')) return c.json({ error: 'Invalid token format' }, 401);

  const hash = await hashKey(key);
  const row = await c.env.DB.prepare('SELECT id FROM api_keys WHERE key_hash = ?').bind(hash).first();
  if (!row) return c.json({ error: 'Invalid API key' }, 401);

  await c.env.DB.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').bind(row.id).run();
  await next();
});

// POST /api/v1/inboxes
api.post('/inboxes', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const domain = c.env.MAIL_DOMAIN.split(',')[0].trim();
  const requested = (body.localPart || '').trim().toLowerCase();

  let address: string;
  if (requested) {
    if (!/^[a-z0-9]+$/.test(requested)) return c.json({ error: 'localPart only allows a-z, 0-9' }, 400);
    address = `${requested}@${domain}`;
    if (await inboxExists(c.env.DB, address)) return c.json({ error: 'Inbox already exists' }, 409);
  } else {
    address = await generateFamousAddress((a) => inboxExists(c.env.DB, a), domain);
  }

  await createInbox(c.env.DB, address);
  const inbox = await getInbox(c.env.DB, address);
  return c.json(inbox, 201);
});

// GET /api/v1/inboxes/:address
api.get('/inboxes/:address', async (c) => {
  const address = decodeURIComponent(c.req.param('address')).toLowerCase();
  const inbox = await getInbox(c.env.DB, address);
  if (!inbox) return c.json({ error: 'Inbox not found' }, 404);
  return c.json(inbox);
});

// GET /api/v1/inboxes/:address/messages
api.get('/inboxes/:address/messages', async (c) => {
  const address = decodeURIComponent(c.req.param('address')).toLowerCase();
  const messages = await getMessages(c.env.DB, address);
  return c.json(messages);
});

// DELETE /api/v1/inboxes/:address
api.delete('/inboxes/:address', async (c) => {
  const address = decodeURIComponent(c.req.param('address')).toLowerCase();
  await c.env.DB.prepare('DELETE FROM messages WHERE inbox_address = ?').bind(address).run();
  await c.env.DB.prepare('DELETE FROM telegram_inboxes WHERE inbox_address = ?').bind(address).run();
  await c.env.DB.prepare('DELETE FROM session_inboxes WHERE inbox_address = ?').bind(address).run();
  await c.env.DB.prepare('DELETE FROM inboxes WHERE address = ?').bind(address).run();
  return c.json({ ok: true });
});

export default api;
