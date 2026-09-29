import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, linkPlayer, joinQueue, getStats, queueList, maybeCreateMatch, getSettings, setQueueMode, setGameMode, setPreferredPositions, getPreferredPositions, getActiveDraft, pickDraftPlayer, cancelActiveDraft, getWorkerStatus, setWorkerEnabled, DRAFT_PICK_ORDER } from './db.js';

test('ten linked players form one persistent match and results drive stats', () => {
  const db = openDatabase(':memory:');
  const options = { maxWaitMinutes: 30 };
  let formed;
  for (let i = 0; i < 10; i++) {
    const discordId = String(i + 1);
    linkPlayer(db, discordId, String(76561197960265729n + BigInt(i)));
    const result = joinQueue(db, discordId, options);
    if (i < 9) assert.equal(result.match, null);
    else formed = result.match;
  }
  assert.equal(formed.players.length, 10);
  assert.equal(queueList(db).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM match_players').get().n, 10);
  assert.throws(() => joinQueue(db, '1', options), /already in a match/);
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
    const { match } = joinQueue(db, 'a', options);
    assert.equal(match.players.length, 1);
    assert.equal(match.players[0].team, 'radiant');
    assert.equal(db.prepare('SELECT status FROM matches WHERE id=?').get(match.id).status, 'pending');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM match_players').get().n, 1);
    linkPlayer(db, 'b', '76561197960265730');
    assert.equal(joinQueue(db, 'b', options).match, null);
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
    const options = { maxWaitMinutes: 30 };
    for (let i = 0; i < 11; i++) {
      const id = String(i + 1);
      linkPlayer(db, id, String(76561197960265729n + BigInt(i)));
      const positions = [[1, 2], [1], [1], [2], [3], [3], [4], [4], [5], [1], [5]][i];
      setPreferredPositions(db, id, positions);
      joinQueue(db, id, options);
    }
    db.prepare("UPDATE matches SET status='cancelled' WHERE id=1").run();
    const match = maybeCreateMatch(db, options);
    assert.equal(match.players.length, 10);
    assert.ok(match.players.some(player => player.discord_id === '11'));
    assert.ok(!match.players.some(player => player.discord_id === '10'));
    for (const team of ['radiant', 'dire'])
      assert.deepEqual(match.players.filter(p => p.team === team).map(p => p.position).sort(), [1, 2, 3, 4, 5]);
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

test('position preferences persist and queue takes a snapshot', () => {
  const db = openDatabase(':memory:', { queueMode: 'role' });
  try {
    linkPlayer(db, 'a', '76561197960265729');
    assert.throws(() => joinQueue(db, 'a'), /Set your preferred positions/);
    assert.throws(() => setPreferredPositions(db, 'a', [1, 1]), /distinct/);
    setPreferredPositions(db, 'a', [1, 3]);
    joinQueue(db, 'a');
    setPreferredPositions(db, 'a', [5]);
    assert.deepEqual(JSON.parse(getPreferredPositions(db, 'a').preferred_positions), [5]);
    assert.deepEqual(JSON.parse(db.prepare('SELECT preferred_positions FROM queue WHERE discord_id=?').get('a').preferred_positions), [1, 3]);
    setPreferredPositions(db, 'a', []);
    assert.deepEqual(JSON.parse(getPreferredPositions(db, 'a').preferred_positions), []);
  } finally { db.close(); }
});

test('captain draft survives restart, enforces snake turns, and creates the match after eight picks', () => {
  assert.deepEqual(DRAFT_PICK_ORDER, ['radiant', 'dire', 'dire', 'radiant', 'radiant', 'dire', 'dire', 'radiant']);
  const directory = mkdtempSync(join(tmpdir(), 'dota-captain-draft-'));
  const path = join(directory, 'inhouses.db');
  let db;
  try {
    db = openDatabase(path, { queueMode: 'captain', gameMode: 'cm' });
    const mmrs = [1000, 5000, 4000, 3000, 3001, 7000, 8000, 9000, 10000, 11000];
    let started;
    for (let i = 0; i < 10; i++) {
      const id = String(i + 1);
      linkPlayer(db, id, String(76561197960265729n + BigInt(i)));
      db.prepare('UPDATE players SET mmr=? WHERE discord_id=?').run(mmrs[i], id);
      started = joinQueue(db, id, { coinFlip: () => 1 });
    }
    assert.equal(started.match, null);
    assert.equal(started.draft.first_captain, '5');
    assert.equal(started.draft.second_captain, '4');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM matches').get().n, 0);
    assert.equal(queueList(db).length, 0);
    assert.throws(() => joinQueue(db, '1'), /active captain draft/);
    assert.throws(() => pickDraftPlayer(db, '4', '1'), /turn to pick/);
    assert.throws(() => pickDraftPlayer(db, '5', '5'), /unpicked player/);
    let draft = getActiveDraft(db);
    for (let i = 0; i < 3; i++) {
      const captain = DRAFT_PICK_ORDER[i] === 'radiant' ? draft.first_captain : draft.second_captain;
      const target = draft.players.find(p => !p.team).discord_id;
      draft = pickDraftPlayer(db, captain, target).draft;
      assert.equal(draft.next_pick, i + 1);
    }
    db.close();
    db = openDatabase(path, { queueMode: 'fifo', gameMode: 'ap' });
    draft = getActiveDraft(db);
    assert.equal(draft.next_pick, 3);
    setGameMode(db, 'ap');
    for (let i = 3; i < 8; i++) {
      const captain = DRAFT_PICK_ORDER[i] === 'radiant' ? draft.first_captain : draft.second_captain;
      const target = draft.players.find(p => !p.team).discord_id;
      const result = pickDraftPlayer(db, captain, target);
      draft = result.draft;
      if (i < 7) assert.equal(result.match, null);
      else {
        assert.equal(result.match.players.length, 10);
        assert.equal(result.match.players.filter(p => p.team === 'radiant').length, 5);
        assert.equal(result.match.players.filter(p => p.team === 'dire').length, 5);
        assert.equal(db.prepare('SELECT game_mode FROM matches WHERE id=?').get(result.match.id).game_mode, 'cm');
        const ratings = db.prepare(`SELECT mp.team,mp.mmr_at_match,dp.team AS drafted_team,dp.mmr AS drafted_mmr
          FROM match_players mp JOIN draft_players dp ON dp.discord_id=mp.discord_id
          WHERE mp.match_id=? AND dp.draft_id=?`).all(result.match.id, draft.id);
        assert.equal(ratings.length, 10);
        assert.ok(ratings.every(p => p.team === p.drafted_team && p.mmr_at_match === p.drafted_mmr));
      }
    }
    assert.equal(draft.status, 'complete');
    assert.equal(getActiveDraft(db), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM matches').get().n, 1);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cancelling a captain draft releases its players to queue again', () => {
  const db = openDatabase(':memory:', { queueMode: 'captain' });
  try {
    for (let i = 0; i < 10; i++) {
      const id = String(i + 1);
      linkPlayer(db, id, String(76561197960265729n + BigInt(i)));
      joinQueue(db, id);
    }
    assert.ok(getActiveDraft(db));
    assert.equal(cancelActiveDraft(db), true);
    assert.equal(getActiveDraft(db), null);
    assert.equal(joinQueue(db, '1').count, 1);
  } finally { db.close(); }
});

test('worker pause persists without stopping the Discord database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dota-worker-control-'));
  const path = join(directory, 'inhouses.db');
  let db;
  try {
    db = openDatabase(path);
    assert.equal(getWorkerStatus(db).enabled, true);
    setWorkerEnabled(db, false);
    db.close();
    db = openDatabase(path);
    assert.equal(getWorkerStatus(db).enabled, false);
    linkPlayer(db, 'a', '76561197960265729');
    assert.equal(joinQueue(db, 'a').count, 1);
    setWorkerEnabled(db, true);
    assert.equal(getWorkerStatus(db).enabled, true);
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
    legacy.exec(`CREATE TABLE matches (id INTEGER PRIMARY KEY, status TEXT NOT NULL, lobby_id TEXT);
      INSERT INTO matches(id,status) VALUES(1,'pending'),(2,'complete');
      CREATE TABLE players (discord_id TEXT PRIMARY KEY, steam_id TEXT, mmr INTEGER, linked_at INTEGER);
      CREATE TABLE queue (discord_id TEXT PRIMARY KEY, joined_at INTEGER, role_ids TEXT DEFAULT '[]');
      CREATE TABLE match_players (match_id INTEGER, discord_id TEXT, team TEXT, mmr_at_match INTEGER);
      CREATE TABLE settings (id INTEGER PRIMARY KEY, queue_mode TEXT CHECK(queue_mode IN ('fifo','role','mmr')), game_mode TEXT);
      INSERT INTO settings VALUES(1,'mmr','ap');`);
    legacy.close();
    db = openDatabase(path, { queueMode: 'fifo', gameMode: 'ap' });
    assert.equal(db.prepare('SELECT game_mode FROM matches WHERE id=1').get().game_mode, 'ap');
    assert.equal(db.prepare('SELECT game_mode FROM matches WHERE id=2').get().game_mode, 'cm');
    assert.equal(getSettings(db).queue_mode, 'captain');
    assert.throws(() => setQueueMode(db, 'mmr'), /fifo, role, or captain/);
    assert.ok(db.prepare('PRAGMA table_info(players)').all().some(column => column.name === 'preferred_positions'));
    assert.ok(db.prepare('PRAGMA table_info(queue)').all().some(column => column.name === 'preferred_positions'));
    assert.ok(db.prepare('PRAGMA table_info(match_players)').all().some(column => column.name === 'mmr_change'));
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
