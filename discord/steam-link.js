import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { linkPlayer } from './db.js';

const endpoint = 'https://steamcommunity.com/openid/login';
const identity = 'http://specs.openid.net/auth/2.0/identifier_select';
const claimedPattern = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

export function createSteamLinks(db, baseURL) {
  const base = new URL(baseURL);
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') throw new Error('PUBLIC_BASE_URL must use HTTPS');
  const pending = new Map();

  function linkURL(discordId) {
    for (const [key, session] of pending) if (session.expires < Date.now()) pending.delete(key);
    const state = randomBytes(24).toString('hex');
    pending.set(state, { discordId, expires: Date.now() + 10 * 60_000 });
    const start = new URL('/auth/steam', base);
    start.searchParams.set('state', state);
    return start.toString();
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, base);
      const state = url.searchParams.get('state');
      const session = pending.get(state);
      if (!session || session.expires < Date.now()) return reply(res, 400, 'Link expired. Run /link again.');
      if (url.pathname === '/auth/steam') {
        const callback = new URL('/auth/steam/callback', base);
        callback.searchParams.set('state', state);
        const auth = new URL(endpoint);
        for (const [key, value] of Object.entries({
          'openid.ns': 'http://specs.openid.net/auth/2.0',
          'openid.mode': 'checkid_setup',
          'openid.return_to': callback.toString(),
          'openid.realm': base.origin,
          'openid.identity': identity,
          'openid.claimed_id': identity
        })) auth.searchParams.set(key, value);
        res.writeHead(302, { Location: auth.toString() }); res.end(); return;
      }
      if (url.pathname !== '/auth/steam/callback') return reply(res, 404, 'Not found');
      pending.delete(state);
      const expected = new URL('/auth/steam/callback', base);
      expected.searchParams.set('state', state);
      if (url.searchParams.get('openid.return_to') !== expected.toString() ||
          url.searchParams.get('openid.op_endpoint') !== endpoint ||
          url.searchParams.get('openid.mode') !== 'id_res') return reply(res, 400, 'Invalid Steam sign-in response');
      const match = claimedPattern.exec(url.searchParams.get('openid.claimed_id') || '');
      if (!match || url.searchParams.get('openid.identity') !== url.searchParams.get('openid.claimed_id') ||
          BigInt(match[1]) <= 76561197960265728n || BigInt(match[1]) > 76561197960265728n + 0xffffffffn) return reply(res, 400, 'Invalid Steam identity');
      const body = new URLSearchParams();
      for (const [key, value] of url.searchParams) if (key.startsWith('openid.')) body.set(key, value);
      body.set('openid.mode', 'check_authentication');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let response;
      try { response = await fetch(endpoint, { method: 'POST', body, signal: controller.signal }); }
      finally { clearTimeout(timer); }
      if (!response.ok || !/^is_valid:true$/m.test(await response.text())) return reply(res, 400, 'Steam did not verify this sign-in');
      linkPlayer(db, session.discordId, match[1]);
      reply(res, 200, 'Steam account linked. You can return to Discord and run /queue join.');
    } catch (error) { console.error('Steam link error:', error); reply(res, 500, 'Steam linking failed. Please try /link again.'); }
  });
  return { server, linkURL };
}

function reply(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(message);
}
