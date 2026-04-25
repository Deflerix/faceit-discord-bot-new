const { EmbedBuilder } = require('discord.js');

const CORE_PLAYERS = ['deflerix', 'w4kky', 'pawik100737'];

function getMention(nick) {
  const id = process.env[`MENTION_${nick}`];
  return id ? `<@${id}>` : nick;
}

function formatPlayerStats(players = [], mvpNick = null) {
  return players.map(p => {
    const s = p.player_stats || {};
    const kd = Number(s['K/D Ratio'] ?? 0);
    const kills = s.Kills ?? '-';
    const deaths = s.Deaths ?? '-';
    const hs = s['Headshots %'] ?? '-';

    let nick = (p.nickname || '?').slice(0, 12);

    if (mvpNick && p.nickname === mvpNick) {
      nick = `👑 ${nick}`;
    }

    return `${nick.padEnd(14)} | ${kills}/${deaths} | KD:${kd.toFixed(2)} | HS:${hs}`;
  }).join('\n');
}

function getTeamScore(round, ourTeam) {
  const [s1, s2] = (round.round_stats?.Score || '0/0').split('/').map(v => Number(v) || 0);
  const [team1] = round.teams || [];
  return ourTeam === team1 ? { our: s1, enemy: s2 } : { our: s2, enemy: s1 };
}

function getCorePlayers(players = []) {
  return players.filter(p =>
    CORE_PLAYERS.includes((p.nickname || '').toLowerCase())
  );
}

// MVP z całego meczu
function getMVPFromMatch(round) {
  const allPlayers = (round.teams || []).flatMap(t => t.players || []);

  return allPlayers.reduce((best, p) => {
    const kills = Number(p.player_stats?.Kills ?? 0);
    return kills > best.kills ? { nick: p.nickname, kills } : best;
  }, { nick: null, kills: -1 });
}

// GOAT (tylko core jeśli są)
function getGoat(players = []) {
  const core = getCorePlayers(players);
  const pool = core.length ? core : players;

  return pool.reduce((best, p) => {
    const kills = Number(p.player_stats?.Kills ?? 0);
    return kills > best.kills ? { nick: p.nickname, kills } : best;
  }, { nick: null, kills: -1 });
}

// PROFESORE (najmniej killów)
function getProfesore(players = []) {
  const core = getCorePlayers(players);
  const pool = core.length ? core : players;

  return pool.reduce((worst, p) => {
    const kills = Number(p.player_stats?.Kills ?? 0);
    return kills < worst.kills ? { nick: p.nickname, kills } : worst;
  }, { nick: null, kills: Infinity });
}

// czy gra cała trójka
function isFullTeamPlaying(players = []) {
  const lower = players.map(p => (p.nickname || '').toLowerCase());
  return CORE_PLAYERS.every(nick => lower.includes(nick));
}

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

function toDateText(unixTs) {
  return new Date(unixTs * 1000).toLocaleString('pl-PL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

async function processMatches({ client, storage, faceit, defaultChannelId, eloCache }) {
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
    if (storage.hasMatch(matchId)) continue;

    const stats = await faceit.getMatchStats(matchId, { ctx: tickCtx });
    const round = stats?.rounds?.[0];
    if (!round) continue;

    const allRoundPlayers = (round.teams || []).flatMap(t => t.players || []);
    const activeTracked = allRoundPlayers.filter(p =>
      trackedMap.has((p.nickname || '').toLowerCase())
    );
    if (!activeTracked.length) continue;

    const ourTeam = (round.teams || []).find(t =>
      (t.players || []).some(p =>
        trackedMap.has((p.nickname || '').toLowerCase())
      )
    );
    if (!ourTeam) continue;

    const enemyTeam = (round.teams || []).find(t => t !== ourTeam) || { players: [] };

    const { our, enemy } = getTeamScore(round, ourTeam);
    const isWin = our > enemy;
    const resultType = isWin ? 'win' : 'lose';
    const resultText = `${isWin ? '🟢 WIN' : '🔴 LOSE'} | ${our}:${enemy}`;

    const mvp = getMVPFromMatch(round);
    const goat = getGoat(ourTeam.players);
    const profesore = getProfesore(ourTeam.players);

    let streakText = '';
    if (isFullTeamPlaying(ourTeam.players)) {
      const streak = storage.updateStreak('team', resultType);
      streakText = `🔥 STREAK ${streak.type.toUpperCase()} ${streak.count}`;
    }

    let eloLines = '';
    for (const nick of trackedPlayers) {
      try {
        const p = await faceit.getPlayer(nick, { forceRefresh: true, ctx: tickCtx });
        const elo = Number(p.games?.cs2?.faceit_elo ?? 0);
        const prev = eloCache[nick] ?? 'X';
        eloLines += `- ${nick} ${prev} → ${elo}\n`;
        eloCache[nick] = elo;
      } catch {
        eloLines += `- ${nick} brak danych\n`;
      }
    }

    let mentions = '';
    if (isFullTeamPlaying(ourTeam.players)) {
      const roleId = process.env.CORE_ROLE_ID;
      mentions = roleId ? `<@&${roleId}>` : 'CORE';
    } else {
      mentions = activeTracked
        .map(p => trackedMap.get((p.nickname || '').toLowerCase()) || p.nickname)
        .map(getMention)
        .join(' ');
    }

    const rawTs =
      lastMatches.find(m => m?.match_id === matchId)?.finished_at ||
      lastMatches.find(m => m?.match_id === matchId)?.started_at ||
      Math.floor(Date.now() / 1000);

    const dateText = toDateText(rawTs);
    const mapName = round.round_stats?.Map || '-';

    const message = [
      `📊 Raport ${mentions}`,
      `📅 Data: ${dateText}`,
      resultText,
      streakText,
      `🌍 Mapa: ${mapName}`,

      '',
      goat ? `🐐 GOAT: ${goat.nick} (${goat.kills})` : '',
      profesore ? `🚑 PROFESORE: ${profesore.nick} (${profesore.kills})` : '',

      '',
      '📈 ELO:',
      eloLines.trimEnd()
    ].filter(Boolean).join('\n');

    const statsEmbed = new EmbedBuilder()
      .setColor(isWin ? 0x2ecc71 : 0xe74c3c)
      .setTitle('📋 Statystyki meczu')
      .addFields(
        {
          name: 'OUR',
          value: `\`\`\`\n${formatPlayerStats(ourTeam.players, mvp?.nick)}\n\`\`\``
        },
        {
          name: 'ENEMY',
          value: `\`\`\`\n${formatPlayerStats(enemyTeam.players, mvp?.nick)}\n\`\`\``
        },
        ...(mvp ? [{ name: 'MVP', value: `👑 ${mvp.nick}`, inline: true }] : [])
      );

    await channel.send({ content: message, embeds: [statsEmbed] });

    const image = getRandomImage(isWin, lastImageRef);
    if (image) await channel.send({ files: [image] });

    storage.addMatch(matchId);
  }
}

module.exports = {
  processMatches,
  getMention
};
