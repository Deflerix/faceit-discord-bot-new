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

    // 🔥 GRIND STATE
    this.grindSessions = readJson(this.paths.grindSessions, {});

    if (!Array.isArray(this.players)) this.players = [];
    this.players = [
      ...new Set(
        this.players.map(v => String(v).trim()).filter(Boolean)
      )
    ];

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
     PLAYERS
  ========================= */

  getLegacyPlayers() {
    return [...this.players];
  }

  getPlayers() {
    if (this.matchLogger) {
      try {
        return this.matchLogger
          .getAllPlayers()
          .map(p => p.nickname);
      } catch (err) {
        console.error(
          `[STORAGE] fallback to JSON players: ${err.message}`
        );
      }
    }
    return this.getLegacyPlayers();
  }

  addPlayerLegacy(nick) {
    const normalized = String(nick || '').trim();
    if (!normalized) {
      return { ok: false, reason: 'Nick jest pusty.' };
    }

    const exists = this.players.some(
      p => p.toLowerCase() === normalized.toLowerCase()
    );

    if (exists) {
      return { ok: false, reason: 'Gracz już istnieje.' };
    }

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

  async syncLegacyPlayers(faceit) {
    if (!this.matchLogger) return;

    const existing = new Set(
      this.matchLogger
        .getAllPlayers()
        .map(p => p.nickname.toLowerCase())
    );

    for (const nick of this.getLegacyPlayers()) {
      if (existing.has(nick.toLowerCase())) continue;

      try {
        const player = await faceit.getPlayer(nick);

        this.matchLogger.upsertPlayer({
          player_id: player.player_id,
          nickname: player.nickname || nick,
          active: true
        });

        existing.add((player.nickname || nick).toLowerCase());

        console.log(`[DB] Legacy player synced: ${player.nickname || nick}`);
      } catch (err) {
        console.error(
          `[STORAGE] sync failed for ${nick}: ${err.message}`
        );
      }
    }
  }

  /* =========================
     CONFIG
  ========================= */

  getChannelId(fallback) {
    return this.config.channelId || fallback;
  }

  setChannelId(channelId) {
    this.config.channelId = channelId;
    this.debounceWrite('config', () => this.config);
  }

  /* =========================
     MATCHES
  ========================= */

  hasLegacyMatch(matchId) {
    return this.checkedMatches.has(matchId);
  }

  addMatch(matchId) {
    this.checkedMatches.add(matchId);

    this.debounceWrite('matches', () =>
      [...this.checkedMatches].slice(-100)
    );
  }

  /* =========================
     LEADERBOARD
  ========================= */

  incrementLeaderboard(userId) {
    this.leaderboard[userId] =
      (this.leaderboard[userId] || 0) + 1;

    this.debounceWrite('leaderboard', () => this.leaderboard);

    return this.leaderboard[userId];
  }

  getLeaderboardSorted() {
    return Object.entries(this.leaderboard)
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1]);
  }

  /* =========================
     STREAKS
  ========================= */

  updateStreak(nick, type) {
    const key = String(nick || '').toLowerCase();
    const prev = this.streaks[key];

    let next;

    if (!prev || prev.type !== type) {
      next = { type, count: 1 };
    } else {
      next = { type, count: prev.count + 1 };
    }

    this.streaks[key] = next;
    this.debounceWrite('streaks', () => this.streaks);

    return next;
  }

  /* =========================
     🔥 GRIND SYSTEM
  ========================= */

  getGrindSessions() {
    return this.grindSessions || {};
  }

  saveGrindSessions(data) {
    this.grindSessions = data;

    this.debounceWrite('grindSessions', () => data);
  }
}

module.exports = new Storage(); // 🔥 FIX KRYTYCZNY
