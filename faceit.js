const axios = require('axios');

function createFaceitService(apiKey, { playerTtlMs = 5 * 60 * 1000, maxAttempts = 2 } = {}) {
  const api = axios.create({
    timeout: 5000,
    headers: { Authorization: `Bearer ${apiKey}` }
  });

  const playerCache = {};

  async function requestWithRetry(url) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const res = await api.get(url);
        return res.data;
      } catch (err) {
        lastErr = err;
        if (attempt === maxAttempts) break;
        await new Promise(resolve => setTimeout(resolve, 250 * attempt));
      }
    }
    throw lastErr;
  }

  function memo(ctx, key, factory) {
    if (!ctx.inFlight.has(key)) ctx.inFlight.set(key, factory());
    return ctx.inFlight.get(key);
  }

  function createTickContext() {
    return { inFlight: new Map() };
  }

  async function getPlayer(nick, { forceRefresh = false, ctx } = {}) {
    const key = String(nick || '').toLowerCase();
    return memo(ctx || createTickContext(), `player:${key}:${forceRefresh}`, async () => {
      const cached = playerCache[key];
      const now = Date.now();
      if (!forceRefresh && cached && now - cached.timestamp < playerTtlMs) {
        return cached.data;
      }

      const data = await requestWithRetry(`https://open.faceit.com/data/v4/players?nickname=${encodeURIComponent(nick)}`);
      playerCache[key] = { data, timestamp: now };
      return data;
    });
  }

  async function getLastMatch(playerId, { ctx } = {}) {
    return memo(ctx || createTickContext(), `last:${playerId}`, async () => {
      const data = await requestWithRetry(`https://open.faceit.com/data/v4/players/${playerId}/history?game=cs2&limit=1`);
      return data.items?.[0];
    });
  }

  async function getMatchStats(matchId, { ctx } = {}) {
    return memo(ctx || createTickContext(), `stats:${matchId}`, async () => {
      return requestWithRetry(`https://open.faceit.com/data/v4/matches/${matchId}/stats`);
    });
  }

  return {
    createTickContext,
    getPlayer,
    getLastMatch,
    getMatchStats
  };
}

module.exports = {
  createFaceitService
};
