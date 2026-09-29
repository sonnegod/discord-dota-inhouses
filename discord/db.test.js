import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, linkPlayer, joinQueue, getStats, queueList, maybeCreateMatch, getSettings, setQueueMode, setGameMode } from './db.js';

test('ten linked players form one persistent match and results drive stats', () => {
  const db = openDatabase(':memory:');
  const options = { priorityRoles: [], maxWaitMinutes: 30 };
  let formed;
  for (let i = 0; i < 10; i++) {
    const discordId = String(i + 1);
    linkPlayer(db, discordId, String(76561197960265729n + BigInt(i)));
    const result = joinQueue(db, discordId, [], options);
    if (i < 9) assert.equal(result.match, null);
    else formed = result.match;
  }
  assert.equal(formed.players.length, 10);
  assert.equal(queueList(db).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM match_players').get().n, 10);
  assert.throws(() => joinQueue(db, '1', [], options), /already in a match/);
  db.prepare('UPDATE match_players SET kills=7,deaths=2,assists=11 WHERE match_id=? AND discord_id=?').run(formed.id, formed.players[0].discord_id);
  db.prepare("UPDATE matches SET status='complete',winner='radiant',dota_match_id='123',finished_at=1 WHERE id=?").run(formed.id);
  const winner = formed.players.find(p => p.team === 'radiant');
  const stats = getStats(db, winner.discord_id);
  assert.equal(stats.games, 1);
  assert.equal(stats.wins, 1);
  const firstStats = getStats(db, formed.players[0].discord_id);
  assert.equal(firstStats.kills, 7);
  assert.equal(firstStats.deaths, 2);
  assert.equal(firstStats.assists, 11);
  db.close();
});

test('solo test mode forms a persistent Radiant lobby and keeps later players queued', () => {
  const db = openDatabase(':memory:');
  try {
    const options = { testSoloLobby: true };
    linkPlayer(db, 'a', '76561197960265729');
    const { match } = joinQueue(db, 'a', [], options);
    assert.equal(match.players.length, 1);
    assert.equal(match.players[0].team, 'radiant');
    assert.equal(db.prepare('SELECT status FROM matches WHERE id=?').get(match.id).status, 'pending');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM match_players').get().n, 1);
    linkPlayer(db, 'b', '76561197960265730');
    assert.equal(joinQueue(db, 'b', [], options).match, null);
    assert.equal(queueList(db).length, 1);
    db.prepare("UPDATE matches SET status='cancelled' WHERE id=?").run(match.id);
    assert.equal(maybeCreateMatch(db, {}), null);
    assert.equal(maybeCreateMatch(db, options).players[0].discord_id, 'b');
  } finally { db.close(); }
});

test('a Steam ID cannot be linked to two Discord accounts', () => {
  const db = openDatabase(':memory:');
  linkPlayer(db, 'a', '76561197960265729');
  assert.throws(() => linkPlayer(db, 'b', '76561197960265729'), /already linked/);
  db.close();
});

test('admin settings persist and new matches snapshot the selected game mode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dota-inhouses-'));
  const path = join(directory, 'inhouses.db');
  let db;
  try {
    db = openDatabase(path, { queueMode: 'fifo', gameMode: 'cm' });
    setQueueMode(db, 'role');
    setGameMode(db, 'ap');
    db.prepare("INSERT INTO matches(status,created_at) VALUES('pending',?)").run(Date.now());
    const options = { priorityRoles: ['priority'], maxWaitMinutes: 30 };
    for (let i = 0; i < 11; i++) {
      const id = String(i + 1);
      linkPlayer(db, id, String(76561197960265729n + BigInt(i)));
      joinQueue(db, id, i === 10 ? ['priority'] : [], options);
    }
    db.prepare("UPDATE matches SET status='cancelled' WHERE id=1").run();
    const match = maybeCreateMatch(db, options);
    assert.equal(match.players.length, 10);
    assert.ok(match.players.some(player => player.discord_id === '11'));
    assert.ok(!match.players.some(player => player.discord_id === '10'));
    assert.equal(db.prepare('SELECT game_mode FROM matches WHERE id=?').get(match.id).game_mode, 'ap');
    setGameMode(db, 'cm');
    db.close();
    db = openDatabase(path, { queueMode: 'fifo', gameMode: 'ap' });
    assert.deepEqual({ ...getSettings(db) }, { queue_mode: 'role', game_mode: 'cm' });
    assert.equal(db.prepare('SELECT game_mode FROM matches WHERE id=?').get(match.id).game_mode, 'ap');
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('opening an existing database adds the game mode to pending matches', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dota-inhouses-'));
  const path = join(directory, 'inhouses.db');
  let db;
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE matches (id INTEGER PRIMARY KEY, status TEXT NOT NULL, lobby_id TEXT); INSERT INTO matches(id,status) VALUES(1,'pending'),(2,'complete')");
    legacy.close();
    db = openDatabase(path, { queueMode: 'fifo', gameMode: 'ap' });
    assert.equal(db.prepare('SELECT game_mode FROM matches WHERE id=1').get().game_mode, 'ap');
    assert.equal(db.prepare('SELECT game_mode FROM matches WHERE id=2').get().game_mode, 'cm');
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
