const fs = require('fs');

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

class Storage {
  constructor({ playersFromEnv = [], matchLogger = null } = {}) {
    this.paths = {
      matches: 'matches.json',
      leaderboard: 'leaderboard.json',
      streaks: 'streaks.json',
      players: 'players.json',
      config: 'config.json',
      grindSessions: 'grindSessions.json'
    };

    this.checkedMatches = new Set(readJson(this.paths.matches, []));
    this.leaderboard = readJson(this.paths.leaderboard, {});
    this.streaks = readJson(this.paths.streaks, {});
    this.players = readJson(this.paths.players, playersFromEnv);
    this.config = readJson(this.paths.config, {});
    this.matchLogger = matchLogger;

    this.grindSessions = readJson(this.paths.grindSessions, {
      active: null,
      history: []
    });

    if (!Array.isArray(this.players)) this.players = [];
    this.players = [...new Set(this.players.map(v => String(v).trim()).filter(Boolean))];

    this.timers = new Map();
  }

  debounceWrite(key, payloadBuilder, delayMs = 2000) {
    if (this.timers.has(key)) clearTimeout(this.timers.get(key));

    const timer = setTimeout(() => {
      this.timers.delete(key);
      try {
        fs.writeFileSync(
          this.paths[key],
          JSON.stringify(payloadBuilder(), null, 2)
        );
      } catch (err) {
        console.error(`[STORAGE] save ${key} failed: ${err.message}`);
      }
    }, delayMs);

    this.timers.set(key, timer);
  }

  /* =========================
  GRIND SYSTEM 🔥
  ========================= */

  startGrind(userId) {
    this.grindSessions.active = {
      startedAt: Date.now(),
      startedBy: userId,
      matches: []
    };

    this.debounceWrite('grindSessions', () => this.grindSessions);

    return this.grindSessions.active;
  }

  endGrind() {
    const session = this.grindSessions.active;
    if (!session) return null;

    session.endedAt = Date.now();

    this.grindSessions.history.push(session);
    this.grindSessions.active = null;

    this.debounceWrite('grindSessions', () => this.grindSessions);

    return session;
  }

  addMatchToGrind(match) {
    if (!this.grindSessions.active) return;

    this.grindSessions.active.matches.push(match);

    this.debounceWrite('grindSessions', () => this.grindSessions);
  }

  getGrindSessions() {
    return this.grindSessions;
  }

  /* =========================
  PLAYERS
  ========================= */

  getLegacyPlayers() {
    return [...this.players];
  }

  getPlayers() {
    if (this.matchLogger) {
      try {
        return this.matchLogger.getAllPlayers().map(p => p.nickname);
      } catch (err) {
        console.error(`[STORAGE] fallback: ${err.message}`);
      }
    }
    return this.getLegacyPlayers();
  }

  addPlayerLegacy(nick) {
    const normalized = String(nick || '').trim();
    if (!normalized) return { ok: false, reason: 'Nick jest pusty.' };

    const exists = this.players.some(
      p => p.toLowerCase() === normalized.toLowerCase()
    );

    if (exists) return { ok: false, reason: 'Gracz już istnieje.' };

    this.players.push(normalized);
    this.debounceWrite('players', () => this.players);

    return { ok: true, nick: normalized };
  }

  removePlayerLegacy(nick) {
    const normalized = String(nick || '').trim();
    const before = this.players.length;

    this.players = this.players.filter(
      p => p.toLowerCase() !== normalized.toLowerCase()
    );

    if (this.players.length === before) {
      return { ok: false, reason: 'Nie znaleziono gracza.' };
    }

    this.debounceWrite('players', () => this.players);
    return { ok: true, nick: normalized };
  }

  getChannelId(fallback) {
    return this.config.channelId || fallback;
  }

  setChannelId(channelId) {
    this.config.channelId = channelId;
    this.debounceWrite('config', () => this.config);
  }

  hasLegacyMatch(matchId) {
    return this.checkedMatches.has(matchId);
  }

  addMatch(matchId) {
    this.checkedMatches.add(matchId);
    this.debounceWrite('matches', () =>
      [...this.checkedMatches].slice(-100)
    );
  }

  incrementLeaderboard(userId) {
    this.leaderboard[userId] =
      (this.leaderboard[userId] || 0) + 1;

    this.debounceWrite('leaderboard', () => this.leaderboard);

    return this.leaderboard[userId];
  }

  getLeaderboardSorted() {
    return Object.entries(this.leaderboard)
      .filter(([_, value]) => value > 0)
      .sort((a, b) => b[1] - a[1]);
  }

  updateStreak(nick, type) {
    const key = String(nick || '').toLowerCase();
    const prev = this.streaks[key];

    let next;
    if (!prev || prev.type !== type) next = { type, count: 1 };
    else next = { type, count: prev.count + 1 };

    this.streaks[key] = next;
    this.debounceWrite('streaks', () => this.streaks);

    return next;
  }
}

module.exports = {
  Storage
};
