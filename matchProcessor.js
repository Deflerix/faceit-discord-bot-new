const { EmbedBuilder } = require('discord.js');

const CORE_PLAYERS = ['deflerix', 'w4kky', 'pawik100737'];

function getMention(nick) {
  const id = process.env[`MENTION_${nick}`];
  return id ? `<@${id}>` : nick;
}

function formatPlayerStats(players = []) {
  return players.map(p => {
    const s = p.player_stats || {};
    const kd = Number(s['K/D Ratio'] ?? 0);
    const kills = s.Kills ?? '-';
    const deaths = s.Deaths ?? '-';
    const hs = s['Headshots %'] ?? '-';
    const nick = (p.nickname || '?').slice(0, 12);

    return `${nick.padEnd(12)} | ${kills}/${deaths} | KD:${kd.toFixed(2)} | HS:${hs}`;
  }).join('\n');
}

function getTeamScore(round, ourTeam) {
  const [s1, s2] = (round.round_stats?.Score || '0/0')
    .split('/')
    .map(v => Number(v) || 0);

  const teams = round.teams || [];
  const index = teams.indexOf(ourTeam);

  if (index === 0) return { our: s1, enemy: s2 };
  return { our: s2, enemy: s1 };
}

function getTopFragger(players = []) {
  const coreOnly = players.filter(p =>
    CORE_PLAYERS.includes((p.nickname || '').toLowerCase())
  );

  const pool = coreOnly.length ? coreOnly : players;

  return pool.reduce((best, p) => {
    const kills = Number(p.player_stats?.Kills ?? 0);
    return kills > best.kills ? { nick: p.nickname || '?', kills } : best;
  }, { nick: '?', kills: -1 });
}

function getStatNumber(player, statName, fallback = 0) {
  const raw = player?.player_stats?.[statName];
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function toDateText(unixTs) {
  return new Date(unixTs * 1000).toLocaleString('pl-PL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/* =========================
   🔥 IMAGE SYSTEM (PRZYWRÓCONE)
========================= */
function getRandomImage(isWin, lastImageRef) {
  const images = isWin
    ? [process.env.IMAGE_WIN_1, process.env.IMAGE_WIN_2, process.env.IMAGE_WIN_3]
    : [process.env.IMAGE_LOSE_1, process.env.IMAGE_LOSE_2, process.env.IMAGE_LOSE_3];

  const allValid = images.filter(Boolean);
  const valid = allValid.filter(img => img !== lastImageRef.value);
  const pool = valid.length ? valid : allValid;

  if (!pool.length) return null;

  const selected = pool[Math.floor(Math.random() * pool.length)];
  lastImageRef.value = selected;

  return selected;
}

async function processMatches({
  client,
  storage,
  faceit,
  defaultChannelId,
  eloCache,
  matchLogger
}) {
  const trackedPlayers = storage.getPlayers();
  if (!trackedPlayers.length) return;

  const trackedMap = new Map(trackedPlayers.map(n => [n.toLowerCase(), n]));
  const tickCtx = faceit.createTickContext();

  const lastMatches = await Promise.all(
    trackedPlayers.map(async nick => {
      const player = await faceit.getPlayer(nick, { ctx: tickCtx });
      return faceit.getLastMatch(player.player_id, { ctx: tickCtx });
    })
  );

  const uniqueMatchIds = [...new Set(lastMatches.map(m => m?.match_id).filter(Boolean))];
  if (!uniqueMatchIds.length) return;

  const channelId = storage.getChannelId(defaultChannelId);
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) return;

  const lastImageRef = { value: null };

  for (const matchId of uniqueMatchIds) {

    let matchExists = false;
    try {
      matchExists = matchLogger.checkIfMatchExists(matchId);
    } catch (err) {
      console.error(`[DB] fallback to JSON match check for ${matchId}: ${err.message}`);
      matchExists = storage.hasLegacyMatch(matchId);
    }

    if (matchExists) {
      console.log(`[DB] Duplicate match skipped: ${matchId}`);
      storage.addMatch(matchId);
      continue;
    }

    const stats = await faceit.getMatchStats(matchId, { ctx: tickCtx });
    const round = stats?.rounds?.[0];
    if (!round) continue;

    const allPlayers = (round.teams || []).flatMap(t => t.players || []);
    const activeTracked = allPlayers.filter(p =>
      trackedMap.has((p.nickname || '').toLowerCase())
    );

    if (!activeTracked.length) continue;

    const ourTeam = (round.teams || []).find(t =>
      (t.players || []).some(p =>
        trackedMap.has((p.nickname || '').toLowerCase())
      )
    );

    if (!ourTeam) continue;

    /* 🔧 FIX SAFE ENEMY TEAM (bez crashy) */
    const enemyTeam = (round.teams || []).find(t => t !== ourTeam) || { players: [] };

    const { our, enemy } = getTeamScore(round, ourTeam);
    const isWin = our > enemy;

    const resultText = `${isWin ? '🟢 WIN' : '🔴 LOSE'} | ${our}:${enemy}`;

    const teamResults = new Map(
      (round.teams || []).map(team => {
        const { our: a, enemy: b } = getTeamScore(round, team);
        return [team, a > b ? 'win' : 'loss'];
      })
    );

    const mvp = getTopFragger(ourTeam.players || []);

    /* =========================
       ELO
    ========================== */
    let eloLines = '';
    const eloByNick = new Map();

    for (const nick of trackedPlayers) {
      try {
        const p = await faceit.getPlayer(nick, { forceRefresh: true, ctx: tickCtx });
        const elo = Number(p.games?.cs2?.faceit_elo ?? 0);
        const prev = Number.isFinite(Number(eloCache[nick])) ? Number(eloCache[nick]) : elo;

        eloLines += `- ${nick} ${eloCache[nick] ?? 'X'} → ${elo}\n`;

        eloCache[nick] = elo;

        eloByNick.set(nick.toLowerCase(), {
          before: prev,
          after: elo,
          delta: elo - prev
        });
      } catch {
        eloLines += `- ${nick} brak danych\n`;
      }
    }

    /* =========================
       STREAK (ORIGINAL BEHAVIOR)
    ========================== */
    const streakLines = activeTracked.map(p => {
      const displayNick = trackedMap.get((p.nickname || '').toLowerCase()) || p.nickname;

      const playerTeam = (round.teams || []).find(t =>
        (t.players || []).some(tp =>
          (tp.nickname || '').toLowerCase() === (p.nickname || '').toLowerCase()
        )
      );

      const streakType =
        playerTeam && teamResults.get(playerTeam) === 'win' ? 'win' : 'lose';

      const streak = storage.updateStreak(displayNick, streakType);

      return `🔥 STREAK ${streak.type.toUpperCase()} ${streak.count} (${displayNick})`;
    });

    /* =========================
       CORE ROLE PING FIX
    ========================== */
    const activeNicknames = activeTracked.map(p =>
      (p.nickname || '').toLowerCase()
    );

    const allCorePresent = CORE_PLAYERS.every(p =>
      activeNicknames.includes(p)
    );

    const coreRoleId = process.env.CORE_ROLE_ID;

    let mentions;

    if (allCorePresent && coreRoleId) {
      mentions = `<@&${coreRoleId}>`;
    } else {
      mentions = activeTracked
        .map(p => trackedMap.get((p.nickname || '').toLowerCase()) || p.nickname)
        .map(getMention)
        .join(' ');
    }

    const rawTs =
      lastMatches.find(m => m?.match_id === matchId)?.finished_at ||
      Math.floor(Date.now() / 1000);

    const dateText = toDateText(rawTs);
    const mapName = round.round_stats?.Map || '-';

    /* =========================
       MESSAGE (BEZ ZMIAN FLOW)
    ========================== */
    const message = [
      `📊 Raport ${mentions}`,
      `📅 Data: ${dateText}`,
      resultText,
      `🌍 Mapa: ${mapName}`,
      '',
      ...streakLines,
      '',
      '📈 ELO:',
      eloLines.trimEnd()
    ].join('\n');

    const statsEmbed = new EmbedBuilder()
      .setColor(isWin ? 0x2ecc71 : 0xe74c3c)
      .setTitle('📋 Statystyki meczu')
      .addFields(
        { name: 'OUR', value: `\`\`\`\n${formatPlayerStats(ourTeam.players)}\n\`\`\`` },
        { name: 'ENEMY', value: `\`\`\`\n${formatPlayerStats(enemyTeam.players)}\n\`\`\`` },
        { name: 'MVP', value: mvp.nick || '?', inline: true }
      );

    await channel.send({ content: message, embeds: [statsEmbed] });

    /* =========================
       IMAGE SEND (PRZYWRÓCONE)
    ========================== */
    const image = getRandomImage(isWin, lastImageRef);
    if (image) await channel.send({ files: [image] });

    storage.addMatch(matchId);
  }
}

module.exports = {
  processMatches,
  getMention
};
