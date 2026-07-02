const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_DIR = path.join(process.cwd(), 'db');
const DB_PATH = path.join(DB_DIR, 'matches.db');

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

class MatchLogger {
  constructor(dbPath = DB_PATH) {
    ensureDbDir();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.init();
  }

  init() {
    this.db.exec(`
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
    `);

    this.insertMatchStmt = this.db.prepare(`
      INSERT OR IGNORE INTO matches
        (match_id, timestamp, map, team_a_score, team_b_score, players)
      VALUES
        (@match_id, @timestamp, @map, @team_a_score, @team_b_score, @players)
    `);
    this.existsStmt = this.db.prepare('SELECT 1 FROM matches WHERE match_id = ? LIMIT 1');
    this.fetchRecentStmt = this.db.prepare('SELECT * FROM matches ORDER BY timestamp DESC, id DESC LIMIT ?');
    this.fetchAllStmt = this.db.prepare('SELECT * FROM matches ORDER BY timestamp DESC, id DESC');
    this.upsertPlayerStmt = this.db.prepare(`
      INSERT INTO players (player_id, nickname, added_at, active)
      VALUES (@player_id, @nickname, @added_at, @active)
      ON CONFLICT(player_id) DO UPDATE SET
        nickname = excluded.nickname,
        active = excluded.active
    `);
    this.deactivatePlayerByNicknameStmt = this.db.prepare('UPDATE players SET active = 0 WHERE lower(nickname) = lower(?)');
  }

  insertMatch(matchData) {
    const players = (matchData.players || []).map(normalizePlayer);
    const result = this.insertMatchStmt.run({
      match_id: matchData.match_id,
      timestamp: Number(matchData.timestamp || Math.floor(Date.now() / 1000)),
      map: matchData.map || '-',
      team_a_score: Number(matchData.team_a_score || 0),
      team_b_score: Number(matchData.team_b_score || 0),
      players: JSON.stringify(players)
    });
    return result.changes > 0;
  }

  checkIfMatchExists(match_id) {
    return Boolean(this.existsStmt.get(match_id));
  }

  fetchRecentMatches(limit = 10) {
    return this.fetchRecentStmt.all(Math.max(1, Number(limit) || 10)).map(row => ({
      ...row,
      players: JSON.parse(row.players || '[]')
    }));
  }

  fetchPlayerMatches(player_id) {
    const needle = String(player_id || '').toLowerCase();
    return this.fetchAllStmt.all()
      .map(row => ({ ...row, players: JSON.parse(row.players || '[]') }))
      .filter(row => row.players.some(player => String(player.player_id || '').toLowerCase() === needle));
  }

  upsertPlayer(player) {
    if (!player?.player_id || !player?.nickname) return false;
    const result = this.upsertPlayerStmt.run({
      player_id: String(player.player_id),
      nickname: String(player.nickname),
      added_at: Number(player.added_at || Math.floor(Date.now() / 1000)),
      active: player.active === false ? 0 : 1
    });
    return result.changes > 0;
  }

  deactivatePlayerByNickname(nickname) {
    const result = this.deactivatePlayerByNicknameStmt.run(String(nickname || ''));
    return result.changes > 0;
  }
}

module.exports = new MatchLogger();
module.exports.MatchLogger = MatchLogger;
