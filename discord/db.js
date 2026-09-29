import { DatabaseSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { selectPlayers, balanceTeams, balanceRoleTeams, closestCaptains } from './matchmaking.js';

export const DRAFT_PICK_ORDER = ['radiant', 'dire', 'dire', 'radiant', 'radiant', 'dire', 'dire', 'radiant'];

export function openDatabase(path, defaults = {}) {
  const queueMode = defaults.queueMode === 'mmr' ? 'captain' : defaults.queueMode || 'fifo';
  const gameMode = defaults.gameMode || 'cm';
  if (!['fifo', 'role', 'captain'].includes(queueMode)) throw new Error('QUEUE_MODE must be fifo, role, or captain');
  if (!['cm', 'ap'].includes(gameMode)) throw new Error('LOBBY_GAME_MODE must be cm or ap');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      discord_id TEXT PRIMARY KEY,
      steam_id TEXT NOT NULL UNIQUE,
      mmr INTEGER NOT NULL DEFAULT 3000 CHECK(mmr BETWEEN 0 AND 15000),
      preferred_positions TEXT NOT NULL DEFAULT '[]',
      linked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS queue (
      discord_id TEXT PRIMARY KEY REFERENCES players(discord_id),
      joined_at INTEGER NOT NULL,
      preferred_positions TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      queue_mode TEXT NOT NULL CHECK(queue_mode IN ('fifo','role','captain')),
      game_mode TEXT NOT NULL CHECK(game_mode IN ('cm','ap'))
    );
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL CHECK(status IN ('pending','creating','lobby','live','results_pending','complete','failed','cancelled')),
      game_mode TEXT NOT NULL DEFAULT 'cm' CHECK(game_mode IN ('cm','ap')),
      lobby_id TEXT,
      previous_lobby_id TEXT,
      dota_match_id TEXT UNIQUE,
      winner TEXT CHECK(winner IN ('radiant','dire') OR winner IS NULL),
      error TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      announced_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS match_players (
      match_id INTEGER NOT NULL REFERENCES matches(id),
      discord_id TEXT NOT NULL REFERENCES players(discord_id),
      steam_id TEXT NOT NULL,
      team TEXT NOT NULL CHECK(team IN ('radiant','dire')),
      mmr_at_match INTEGER NOT NULL,
      position INTEGER CHECK(position BETWEEN 1 AND 5 OR position IS NULL),
      mmr_change INTEGER,
      hero_id INTEGER,
      kills INTEGER,
      deaths INTEGER,
      assists INTEGER,
      PRIMARY KEY (match_id, discord_id)
    );
    CREATE INDEX IF NOT EXISTS match_players_by_discord ON match_players(discord_id);
    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL CHECK(status IN ('active','complete','cancelled')),
      first_captain TEXT NOT NULL REFERENCES players(discord_id),
      second_captain TEXT NOT NULL REFERENCES players(discord_id),
      next_pick INTEGER NOT NULL DEFAULT 0 CHECK(next_pick BETWEEN 0 AND 8),
      game_mode TEXT NOT NULL CHECK(game_mode IN ('cm','ap')),
      created_at INTEGER NOT NULL,
      announced_at INTEGER,
      match_id INTEGER REFERENCES matches(id)
    );
    CREATE TABLE IF NOT EXISTS draft_players (
      draft_id INTEGER NOT NULL REFERENCES drafts(id),
      discord_id TEXT NOT NULL REFERENCES players(discord_id),
      steam_id TEXT NOT NULL,
      mmr INTEGER NOT NULL,
      team TEXT CHECK(team IN ('radiant','dire') OR team IS NULL),
      PRIMARY KEY (draft_id, discord_id)
    );
    CREATE TABLE IF NOT EXISTS worker_control (
      id INTEGER PRIMARY KEY CHECK(id=1),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      steam_online INTEGER NOT NULL DEFAULT 0 CHECK(steam_online IN (0,1)),
      heartbeat_at INTEGER
    );
  `);
  const settingsSQL = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='settings'").get().sql;
  if (settingsSQL.includes("'mmr'")) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE settings_new (id INTEGER PRIMARY KEY CHECK(id=1), queue_mode TEXT NOT NULL CHECK(queue_mode IN ('fifo','role','captain')), game_mode TEXT NOT NULL CHECK(game_mode IN ('cm','ap')));
      INSERT INTO settings_new SELECT id, CASE WHEN queue_mode='mmr' THEN 'captain' ELSE queue_mode END, game_mode FROM settings;
      DROP TABLE settings;
      ALTER TABLE settings_new RENAME TO settings;
      COMMIT;`);
  }
  db.prepare('INSERT OR IGNORE INTO settings(id,queue_mode,game_mode) VALUES(1,?,?)').run(queueMode, gameMode);
  db.prepare('INSERT OR IGNORE INTO worker_control(id,enabled) VALUES(1,1)').run();
  if (!db.prepare('PRAGMA table_info(matches)').all().some(column => column.name === 'game_mode')) {
    db.exec("ALTER TABLE matches ADD COLUMN game_mode TEXT NOT NULL DEFAULT 'cm' CHECK(game_mode IN ('cm','ap'))");
    db.prepare("UPDATE matches SET game_mode=? WHERE status IN ('pending','creating') AND lobby_id IS NULL").run(getSettings(db).game_mode);
  }
  if (!db.prepare('PRAGMA table_info(players)').all().some(column => column.name === 'preferred_positions'))
    db.exec("ALTER TABLE players ADD COLUMN preferred_positions TEXT NOT NULL DEFAULT '[]'");
  if (!db.prepare('PRAGMA table_info(queue)').all().some(column => column.name === 'preferred_positions'))
    db.exec("ALTER TABLE queue ADD COLUMN preferred_positions TEXT NOT NULL DEFAULT '[]'");
  if (!db.prepare('PRAGMA table_info(match_players)').all().some(column => column.name === 'position'))
    db.exec('ALTER TABLE match_players ADD COLUMN position INTEGER');
  if (!db.prepare('PRAGMA table_info(match_players)').all().some(column => column.name === 'mmr_change'))
    db.exec('ALTER TABLE match_players ADD COLUMN mmr_change INTEGER');
  return db;
}

export function getSettings(db) {
  return db.prepare('SELECT queue_mode,game_mode FROM settings WHERE id=1').get();
}

export function setQueueMode(db, mode) {
  if (!['fifo', 'role', 'captain'].includes(mode)) throw new Error('Queue mode must be fifo, role, or captain');
  db.prepare('UPDATE settings SET queue_mode=? WHERE id=1').run(mode);
}

export function setGameMode(db, mode) {
  if (!['cm', 'ap'].includes(mode)) throw new Error('Game mode must be cm or ap');
  db.prepare('UPDATE settings SET game_mode=? WHERE id=1').run(mode);
}

export function setWorkerEnabled(db, enabled) {
  db.prepare('UPDATE worker_control SET enabled=? WHERE id=1').run(enabled ? 1 : 0);
}

export function getWorkerStatus(db) {
  const row = db.prepare('SELECT enabled,steam_online,heartbeat_at FROM worker_control WHERE id=1').get();
  const running = row.heartbeat_at != null && Date.now() - row.heartbeat_at < 90000;
  return {
    enabled: row.enabled === 1,
    running,
    steamOnline: row.steam_online === 1 && running
  };
}

export function getPreferredPositions(db, discordId) {
  return db.prepare('SELECT preferred_positions FROM players WHERE discord_id=?').get(discordId);
}

export function setPreferredPositions(db, discordId, positions) {
  if (!Array.isArray(positions) || new Set(positions).size !== positions.length ||
      positions.some(position => !Number.isInteger(position) || position < 1 || position > 5))
    throw new Error('Choose distinct positions from 1 to 5');
  const result = db.prepare('UPDATE players SET preferred_positions=? WHERE discord_id=?').run(JSON.stringify([...positions].sort()), discordId);
  if (!result.changes) throw new Error('Link your Steam account with /link first');
  // A queued player keeps the preferences they joined with. Requeue to apply edits.
}

export function linkPlayer(db, discordId, steamId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const owner = db.prepare('SELECT discord_id FROM players WHERE steam_id = ?').get(steamId);
    if (owner && owner.discord_id !== discordId) throw new Error('Steam account is already linked to another Discord user');
    const queued = db.prepare('SELECT 1 FROM queue WHERE discord_id = ?').get(discordId);
    if (queued) throw new Error('Leave the queue before changing your linked account');
    if (db.prepare(`SELECT 1 FROM draft_players dp JOIN drafts d ON d.id=dp.draft_id
      WHERE dp.discord_id=? AND d.status='active'`).get(discordId)) throw new Error('Finish or cancel the active draft before changing your linked account');
    db.prepare(`INSERT INTO players(discord_id,steam_id,linked_at) VALUES(?,?,?)
      ON CONFLICT(discord_id) DO UPDATE SET steam_id=excluded.steam_id,linked_at=excluded.linked_at`)
      .run(discordId, steamId, Date.now());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function joinQueue(db, discordId, options = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const player = db.prepare('SELECT steam_id,preferred_positions FROM players WHERE discord_id=?').get(discordId);
    if (!player) throw new Error('Link your Steam account with /link first');
    if (db.prepare('SELECT 1 FROM queue WHERE discord_id=?').get(discordId)) throw new Error('You are already queued');
    if (db.prepare(`SELECT 1 FROM match_players mp JOIN matches m ON m.id=mp.match_id
      WHERE mp.discord_id=? AND m.status IN ('pending','creating','lobby','live','results_pending')`).get(discordId)) throw new Error('You are already in a match');
    if (db.prepare(`SELECT 1 FROM draft_players dp JOIN drafts d ON d.id=dp.draft_id
      WHERE dp.discord_id=? AND d.status='active'`).get(discordId)) throw new Error('You are already in the active captain draft');
    if (getSettings(db).queue_mode === 'role' && JSON.parse(player.preferred_positions).length === 0)
      throw new Error('Set your preferred positions with /roles set before joining the role queue');
    db.prepare('INSERT INTO queue(discord_id,joined_at,preferred_positions) VALUES(?,?,?)').run(discordId, Date.now(), player.preferred_positions);
    const result = createMatch(db, options);
    const count = db.prepare('SELECT COUNT(*) AS count FROM queue').get().count;
    db.exec('COMMIT');
    return { match: result?.draft ? null : result, draft: result?.draft || null, count };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function maybeCreateMatch(db, options) {
  db.exec('BEGIN IMMEDIATE');
  try { const match = createMatch(db, options); db.exec('COMMIT'); return match; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function createMatch(db, options) {
  if (db.prepare(`SELECT 1 FROM matches WHERE status IN ('pending','creating','lobby','live','results_pending') LIMIT 1`).get()) return null;
  if (getActiveDraft(db)) return null;
  const players = db.prepare(`SELECT q.discord_id,q.joined_at,q.rowid AS queue_order,q.preferred_positions,p.steam_id,p.mmr FROM queue q
    JOIN players p ON p.discord_id=q.discord_id ORDER BY q.rowid`).all();
  const settings = getSettings(db);
  const selected = options.testSoloLobby ? (players.length ? players.slice(0, 1) : null) : selectPlayers(players, settings.queue_mode);
  if (!selected) return null;
  if (!options.testSoloLobby && settings.queue_mode === 'captain') {
    const captains = closestCaptains(selected);
    const first = captains[options.coinFlip?.() ?? randomInt(2)];
    const second = captains.find(p => p.discord_id !== first.discord_id);
    const draftId = Number(db.prepare(`INSERT INTO drafts(status,first_captain,second_captain,game_mode,created_at)
      VALUES('active',?,?,?,?)`).run(first.discord_id, second.discord_id, settings.game_mode, Date.now()).lastInsertRowid);
    const add = db.prepare('INSERT INTO draft_players(draft_id,discord_id,steam_id,mmr,team) VALUES(?,?,?,?,?)');
    const remove = db.prepare('DELETE FROM queue WHERE discord_id=?');
    for (const p of selected) {
      add.run(draftId, p.discord_id, p.steam_id, p.mmr,
        p.discord_id === first.discord_id ? 'radiant' : p.discord_id === second.discord_id ? 'dire' : null);
      remove.run(p.discord_id);
    }
    return { draft: getDraft(db, draftId) };
  }
  const teams = options.testSoloLobby ? selected.map(p => ({ ...p, team: 'radiant' })) : settings.queue_mode === 'role' ? balanceRoleTeams(selected) : balanceTeams(selected);
  return insertMatch(db, teams, settings.game_mode);
}

function insertMatch(db, teams, gameMode) {
  const result = db.prepare("INSERT INTO matches(status,game_mode,created_at) VALUES('pending',?,?)").run(gameMode, Date.now());
  const matchId = Number(result.lastInsertRowid);
  const add = db.prepare('INSERT INTO match_players(match_id,discord_id,steam_id,team,mmr_at_match,position) VALUES(?,?,?,?,?,?)');
  const remove = db.prepare('DELETE FROM queue WHERE discord_id=?');
  for (const player of teams) {
    add.run(matchId, player.discord_id, player.steam_id, player.team, player.mmr, player.position ?? null);
    remove.run(player.discord_id);
  }
  return { id: matchId, players: teams };
}

export function getDraft(db, draftId) {
  const row = db.prepare('SELECT * FROM drafts WHERE id=?').get(draftId);
  if (!row) return null;
  return { ...row, players: db.prepare('SELECT * FROM draft_players WHERE draft_id=? ORDER BY rowid').all(draftId) };
}

export function getActiveDraft(db) {
  const row = db.prepare("SELECT id FROM drafts WHERE status='active' ORDER BY id LIMIT 1").get();
  return row ? getDraft(db, row.id) : null;
}

export function pickDraftPlayer(db, captainId, playerId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const draft = getActiveDraft(db);
    if (!draft) throw new Error('There is no active captain draft');
    const team = DRAFT_PICK_ORDER[draft.next_pick];
    const captain = team === 'radiant' ? draft.first_captain : draft.second_captain;
    if (captainId !== captain) throw new Error(`It is <@${captain}>'s turn to pick`);
    const target = draft.players.find(p => p.discord_id === playerId);
    if (!target || target.team) throw new Error('Choose an unpicked player from this draft');
    db.prepare('UPDATE draft_players SET team=? WHERE draft_id=? AND discord_id=?').run(team, draft.id, playerId);
    db.prepare('UPDATE drafts SET next_pick=next_pick+1 WHERE id=?').run(draft.id);
    if (draft.next_pick === 7) {
      const completed = getDraft(db, draft.id);
      const match = insertMatch(db, completed.players, draft.game_mode);
      db.prepare("UPDATE drafts SET status='complete',match_id=? WHERE id=?").run(match.id, draft.id);
      db.exec('COMMIT');
      return { draft: getDraft(db, draft.id), match };
    }
    db.exec('COMMIT');
    return { draft: getDraft(db, draft.id), match: null };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function cancelActiveDraft(db) {
  return db.prepare("UPDATE drafts SET status='cancelled' WHERE status='active'").run().changes > 0;
}

export function leaveQueue(db, discordId) { return db.prepare('DELETE FROM queue WHERE discord_id=?').run(discordId).changes > 0; }
export function queueList(db) { return db.prepare('SELECT q.discord_id,q.joined_at,p.mmr FROM queue q JOIN players p USING(discord_id) ORDER BY q.rowid').all(); }
export function getStats(db, discordId) {
  return db.prepare(`SELECT p.mmr, COUNT(CASE WHEN m.status='complete' THEN 1 END) AS games,
    COUNT(CASE WHEN m.status='complete' AND mp.team=m.winner THEN 1 END) AS wins,
    SUM(CASE WHEN m.status='complete' THEN COALESCE(mp.kills,0) ELSE 0 END) AS kills,
    SUM(CASE WHEN m.status='complete' THEN COALESCE(mp.deaths,0) ELSE 0 END) AS deaths,
    SUM(CASE WHEN m.status='complete' THEN COALESCE(mp.assists,0) ELSE 0 END) AS assists
    FROM players p LEFT JOIN match_players mp ON mp.discord_id=p.discord_id
    LEFT JOIN matches m ON m.id=mp.match_id WHERE p.discord_id=? GROUP BY p.discord_id`).get(discordId);
}
export function getRecentMatches(db, limit = 5) { return db.prepare("SELECT id,dota_match_id,winner,finished_at FROM matches WHERE status='complete' ORDER BY finished_at DESC LIMIT ?").all(limit); }
export function getActiveMatch(db) { return db.prepare("SELECT * FROM matches WHERE status IN ('pending','creating','lobby','live','results_pending') ORDER BY id LIMIT 1").get(); }
export function setMMR(db, discordId, mmr) { return db.prepare('UPDATE players SET mmr=? WHERE discord_id=?').run(mmr, discordId).changes > 0; }
