import { DatabaseSync } from 'node:sqlite';
import { selectPlayers, balanceTeams } from './matchmaking.js';

export function openDatabase(path, defaults = {}) {
  const queueMode = defaults.queueMode || 'fifo';
  const gameMode = defaults.gameMode || 'cm';
  if (!['fifo', 'role', 'mmr'].includes(queueMode)) throw new Error('QUEUE_MODE must be fifo, role, or mmr');
  if (!['cm', 'ap'].includes(gameMode)) throw new Error('LOBBY_GAME_MODE must be cm or ap');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      discord_id TEXT PRIMARY KEY,
      steam_id TEXT NOT NULL UNIQUE,
      mmr INTEGER NOT NULL DEFAULT 3000 CHECK(mmr BETWEEN 0 AND 15000),
      linked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS queue (
      discord_id TEXT PRIMARY KEY REFERENCES players(discord_id),
      joined_at INTEGER NOT NULL,
      role_ids TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      queue_mode TEXT NOT NULL CHECK(queue_mode IN ('fifo','role','mmr')),
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
      hero_id INTEGER,
      kills INTEGER,
      deaths INTEGER,
      assists INTEGER,
      PRIMARY KEY (match_id, discord_id)
    );
    CREATE INDEX IF NOT EXISTS match_players_by_discord ON match_players(discord_id);
  `);
  db.prepare('INSERT OR IGNORE INTO settings(id,queue_mode,game_mode) VALUES(1,?,?)').run(queueMode, gameMode);
  if (!db.prepare('PRAGMA table_info(matches)').all().some(column => column.name === 'game_mode')) {
    db.exec("ALTER TABLE matches ADD COLUMN game_mode TEXT NOT NULL DEFAULT 'cm' CHECK(game_mode IN ('cm','ap'))");
    db.prepare("UPDATE matches SET game_mode=? WHERE status IN ('pending','creating') AND lobby_id IS NULL").run(getSettings(db).game_mode);
  }
  return db;
}

export function getSettings(db) {
  return db.prepare('SELECT queue_mode,game_mode FROM settings WHERE id=1').get();
}

export function setQueueMode(db, mode) {
  if (!['fifo', 'role', 'mmr'].includes(mode)) throw new Error('Queue mode must be fifo, role, or mmr');
  db.prepare('UPDATE settings SET queue_mode=? WHERE id=1').run(mode);
}

export function setGameMode(db, mode) {
  if (!['cm', 'ap'].includes(mode)) throw new Error('Game mode must be cm or ap');
  db.prepare('UPDATE settings SET game_mode=? WHERE id=1').run(mode);
}

export function linkPlayer(db, discordId, steamId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const owner = db.prepare('SELECT discord_id FROM players WHERE steam_id = ?').get(steamId);
    if (owner && owner.discord_id !== discordId) throw new Error('Steam account is already linked to another Discord user');
    const queued = db.prepare('SELECT 1 FROM queue WHERE discord_id = ?').get(discordId);
    if (queued) throw new Error('Leave the queue before changing your linked account');
    db.prepare(`INSERT INTO players(discord_id,steam_id,linked_at) VALUES(?,?,?)
      ON CONFLICT(discord_id) DO UPDATE SET steam_id=excluded.steam_id,linked_at=excluded.linked_at`)
      .run(discordId, steamId, Date.now());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function joinQueue(db, discordId, roles, options) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const player = db.prepare('SELECT steam_id FROM players WHERE discord_id=?').get(discordId);
    if (!player) throw new Error('Link your Steam account with /link first');
    if (db.prepare('SELECT 1 FROM queue WHERE discord_id=?').get(discordId)) throw new Error('You are already queued');
    if (db.prepare(`SELECT 1 FROM match_players mp JOIN matches m ON m.id=mp.match_id
      WHERE mp.discord_id=? AND m.status IN ('pending','creating','lobby','live','results_pending')`).get(discordId)) throw new Error('You are already in a match');
    db.prepare('INSERT INTO queue(discord_id,joined_at,role_ids) VALUES(?,?,?)').run(discordId, Date.now(), JSON.stringify(roles));
    const match = createMatch(db, options);
    const count = db.prepare('SELECT COUNT(*) AS count FROM queue').get().count;
    db.exec('COMMIT');
    return { match, count };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function maybeCreateMatch(db, options) {
  db.exec('BEGIN IMMEDIATE');
  try { const match = createMatch(db, options); db.exec('COMMIT'); return match; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function createMatch(db, options) {
  if (db.prepare(`SELECT 1 FROM matches WHERE status IN ('pending','creating','lobby','live','results_pending') LIMIT 1`).get()) return null;
  const players = db.prepare(`SELECT q.discord_id,q.joined_at,q.rowid AS queue_order,q.role_ids,p.steam_id,p.mmr FROM queue q
    JOIN players p ON p.discord_id=q.discord_id ORDER BY q.rowid`).all();
  const settings = getSettings(db);
  const selected = selectPlayers(players, settings.queue_mode, options.priorityRoles, options.maxWaitMinutes);
  if (!selected) return null;
  const teams = balanceTeams(selected);
  const result = db.prepare("INSERT INTO matches(status,game_mode,created_at) VALUES('pending',?,?)").run(settings.game_mode, Date.now());
  const matchId = Number(result.lastInsertRowid);
  const add = db.prepare('INSERT INTO match_players(match_id,discord_id,steam_id,team,mmr_at_match) VALUES(?,?,?,?,?)');
  const remove = db.prepare('DELETE FROM queue WHERE discord_id=?');
  for (const player of teams) {
    add.run(matchId, player.discord_id, player.steam_id, player.team, player.mmr);
    remove.run(player.discord_id);
  }
  return { id: matchId, players: teams };
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
