import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { openDatabase } from './db.js';
import { createSteamLinks } from './steam-link.js';

function request(url) {
  return new Promise((resolve, reject) => get(url, response => {
    let body = '';
    response.on('data', chunk => body += chunk);
    response.on('end', () => resolve({ status: response.statusCode, body }));
  }).on('error', reject));
}

test('Steam linking rejects unverified identity and accepts provider verification', async () => {
  const db = openDatabase(':memory:');
  const base = 'http://localhost:8123';
  const { server, linkURL } = createSteamLinks(db, base);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const originalFetch = globalThis.fetch;
  try {
    function callback(discordId, claimed) {
      const start = new URL(linkURL(discordId));
      const expected = new URL('/auth/steam/callback', base);
      expected.searchParams.set('state', start.searchParams.get('state'));
      const actual = new URL(expected);
      actual.hostname = '127.0.0.1';
      actual.port = String(port);
      actual.searchParams.set('openid.mode', 'id_res');
      actual.searchParams.set('openid.op_endpoint', 'https://steamcommunity.com/openid/login');
      actual.searchParams.set('openid.return_to', expected.toString());
      actual.searchParams.set('openid.claimed_id', claimed);
      actual.searchParams.set('openid.identity', claimed);
      return actual;
    }
    globalThis.fetch = async () => ({ ok: true, text: async () => 'is_valid:true\n' });
    const bad = await request(callback('first', 'https://evil.example/id/76561197960265729'));
    assert.equal(bad.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM players').get().n, 0);
    const good = await request(callback('second', 'https://steamcommunity.com/openid/id/76561197960265729'));
    assert.equal(good.status, 200);
    assert.equal(db.prepare('SELECT steam_id FROM players WHERE discord_id=?').get('second').steam_id, '76561197960265729');
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
