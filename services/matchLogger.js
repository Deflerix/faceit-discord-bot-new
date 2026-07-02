const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_DIR = path.join(process.cwd(), 'db');
const DB_PATH = path.join(DB_DIR, 'matches.db');

let db = null;
let statements = null;

function ensureDbDir() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
}

function normalizePlayer(player) {
  return {
    player_id: String(player.player_id || ''),
    nickname: String(player.nickname || ''),
    kills: Number(player.kills || 0),
    deaths: Number(player.deaths || 0),
    assists: Number(player.assists || 0),
    hs: Number(player.hs || 0),
    kd: Number(player.kd || 0),
    mvp: Boolean(player.mvp),
    elo_before: Number(player.elo_before || 0),
    elo_after: Number(player.elo_after || 0),
    elo_delta: Number(player.elo_delta || 0),
    result: player.result === 'win' ? 'win' : 'loss'
  };
}

function parseMatchRow(row) {
  if (!row) return null;
  return {
    ...row,
    players: JSON.parse(row.players || '[]')
  };
}

function initDatabase(dbPath = DB_PATH) {
  if (db && statements) return db;

  ensureDbDir();
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT NOT NULL UNIQUE,
      timestamp INTEGER NOT NULL,
      map TEXT,
      team_a_score INTEGER NOT NULL DEFAULT 0,
      team_b_score INTEGER NOT NULL DEFAULT 0,
      players TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS players (
      player_id TEXT NOT NULL UNIQUE,
      nickname TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_matches_timestamp ON matches(timestamp);
    CREATE INDEX IF NOT EXISTS idx_players_nickname ON players(nickname);
    CREATE INDEX IF NOT EXISTS idx_players_active ON players(active);
  `);

  statements = {
    insertMatch: db.prepare(`
      INSERT INTO matches
        (match_id, timestamp, map, team_a_score, team_b_score, players)
      VALUES
        (@match_id, @timestamp, @map, @team_a_score, @team_b_score, @players)
    `),
    getMatchById: db.prepare('SELECT * FROM matches WHERE match_id = ? LIMIT 1'),
    getRecentMatches: db.prepare('SELECT * FROM matches ORDER BY timestamp DESC, id DESC LIMIT ?'),
    getAllMatches: db.prepare('SELECT * FROM matches ORDER BY timestamp DESC, id DESC'),
    upsertPlayer: db.prepare(`
      INSERT INTO players (player_id, nickname, added_at, active)
      VALUES (@player_id, @nickname, @added_at, @active)
      ON CONFLICT(player_id) DO UPDATE SET
        nickname = excluded.nickname,
        active = excluded.active
    `),
    getAllPlayers: db.prepare('SELECT player_id, nickname, added_at, active FROM players WHERE active = 1 ORDER BY nickname COLLATE NOCASE'),
    getPlayerByNickname: db.prepare('SELECT player_id, nickname, added_at, active FROM players WHERE lower(nickname) = lower(?) LIMIT 1'),
    deactivatePlayerByNickname: db.prepare('UPDATE players SET active = 0 WHERE lower(nickname) = lower(?)')
  };

  console.log('[DB] SQLite initialized at db/matches.db');
  return db;
}

function insertMatch(matchData) {
  initDatabase();
  if (checkIfMatchExists(matchData.match_id)) {
    console.log(`[DB] Duplicate match skipped: ${matchData.match_id}`);
    return false;
  }

  const players = (matchData.players || []).map(normalizePlayer);
  statements.insertMatch.run({
    match_id: matchData.match_id,
    timestamp: Number(matchData.timestamp || Math.floor(Date.now() / 1000)),
    map: matchData.map || '-',
    team_a_score: Number(matchData.team_a_score || 0),
    team_b_score: Number(matchData.team_b_score || 0),
    players: JSON.stringify(players)
  });
  console.log(`[DB] Match inserted: ${matchData.match_id}`);
  return true;
}

function getMatchById(match_id) {
  initDatabase();
  return parseMatchRow(statements.getMatchById.get(match_id));
}

function checkIfMatchExists(match_id) {
  return Boolean(getMatchById(match_id));
}

function getRecentMatches(limit = 10) {
  initDatabase();
  return statements.getRecentMatches.all(Math.max(1, Number(limit) || 10)).map(parseMatchRow);
}

function getPlayerMatches(player_id) {
  initDatabase();
  const needle = String(player_id || '').toLowerCase();
  return statements.getAllMatches.all()
    .map(parseMatchRow)
    .filter(row => row.players.some(player => String(player.player_id || '').toLowerCase() === needle));
}

function upsertPlayer(player) {
  initDatabase();
  if (!player?.player_id || !player?.nickname) return { ok: false, reason: 'missing player_id or nickname' };
  const existing = statements.getPlayerByNickname.get(player.nickname);
  if (existing && existing.player_id !== String(player.player_id) && existing.active) {
    return { ok: false, reason: 'duplicate nickname' };
  }

  const result = statements.upsertPlayer.run({
    player_id: String(player.player_id),
    nickname: String(player.nickname),
    added_at: Number(player.added_at || Math.floor(Date.now() / 1000)),
    active: player.active === false ? 0 : 1
  });
  console.log(`[DB] Player upserted: ${player.nickname}`);
  return { ok: result.changes > 0, changes: result.changes };
}

function getAllPlayers() {
  initDatabase();
  return statements.getAllPlayers.all();
}

function getPlayerByNickname(nickname) {
  initDatabase();
  return statements.getPlayerByNickname.get(String(nickname || '')) || null;
}

function deactivatePlayerByNickname(nickname) {
  initDatabase();
  const result = statements.deactivatePlayerByNickname.run(String(nickname || ''));
  if (result.changes > 0) console.log(`[DB] Player deactivated: ${nickname}`);
  return result.changes > 0;
}

module.exports = {
  initDatabase,
  insertMatch,
  getMatchById,
  checkIfMatchExists,
  getRecentMatches,
  getPlayerMatches,
  fetchRecentMatches: getRecentMatches,
  fetchPlayerMatches: getPlayerMatches,
  upsertPlayer,
  getAllPlayers,
  getPlayerByNickname,
  deactivatePlayerByNickname
};
