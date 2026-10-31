const { EmbedBuilder } = require('discord.js');
const { getReportAchievements } = require('./services/reportAchievements');

const CORE_PLAYERS = ['deflerix', 'w4kky', 'pawik100737'];

// Pełna piątka ("Active Roster") – tylko gdy gra cała ona: ping roli ACTIVE_ROSTER_ROLE_ID
// zamiast @core oraz liczony jest streak. Nicki małymi literami.
const ACTIVE_ROSTER = [...CORE_PLAYERS, 'fazardrx', 'foxer36'];

// Dokładna pisownia nicków na FACEIT – API rozróżnia wielkość liter,
// więc to ta lista służy do automatycznego dodawania graczy (ensureDefaultPlayers).
const ROSTER_NICKS = ['Deflerix', 'W4KKY', 'pawik100737', 'FazardRX', 'Foxer36'];

// Prefiks nazwy emotki poziomu na serwerze (lvl1 ... lvl10). Można zmienić w .env.
const LEVEL_EMOJI_PREFIX = process.env.LEVEL_EMOJI_PREFIX || 'lvl';

// Klucz streaka drużyny (osobny od starych streaków per nick)
const ROSTER_STREAK_KEY = 'active_roster';

/* =========================
🔥 GLOBAL DUPLICATE LOCK
========================= */
const processedMatches = new Set();

// MENTION_<nick> w .env – wielkość liter w nazwie zmiennej nie ma znaczenia
// (np. MENTION_FazardRX, MENTION_Foxer36, MENTION_deflerix)
function getMention(nick) {
  const wanted = `mention_${String(nick || '').toLowerCase()}`;
  const key = Object.keys(process.env).find(k => k.toLowerCase() === wanted);
  const id = key ? process.env[key] : null;
  return id ? `<@${id}>` : nick;
}

function lowerNick(player) {
  return (player?.nickname || '').toLowerCase();
}

function hasAllPlayers(players = [], wantedNicks = []) {
  const present = new Set(players.map(lowerNick));
  return wantedNicks.every(n => present.has(n));
}

let adrKeysLogged = false;

// ADR z FACEIT: bezpośrednio ze statystyki albo wyliczony z Damage / liczby rund
function getAdr(player, roundsPlayed = 0) {
  const s = player?.player_stats || {};

  const direct = Number(s['ADR'] ?? s['Average Damage per Round'] ?? s['Average Damage Per Round']);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const damage = Number(s['Damage'] ?? s['Total Damage']);
  if (Number.isFinite(damage) && damage > 0 && roundsPlayed > 0) return damage / roundsPlayed;

  if (!adrKeysLogged) {
    adrKeysLogged = true;
    console.log(`[STATS] Brak ADR w danych FACEIT. Dostępne statystyki: ${Object.keys(s).join(', ')}`);
  }
  return 0;
}

// Emotki poziomów z serwera (<:lvl7:id>) – szukane po nazwie
async function resolveLevelEmojis(client, channel) {
  const map = new Map();

  try {
    await channel.guild?.emojis?.fetch();
  } catch (err) {
    console.error(`[EMOJI] fetch failed: ${err.message}`);
  }

  const sources = [client?.emojis?.cache, channel.guild?.emojis?.cache].filter(Boolean);
  for (const cache of sources) {
    for (const emoji of cache.values()) {
      if (emoji.available === false || !emoji.name) continue;
      map.set(emoji.name.toLowerCase(), emoji.toString());
    }
  }
  return map;
}

function levelLabel(emojiMap, lvl) {
  return emojiMap.get(`${LEVEL_EMOJI_PREFIX}${lvl}`.toLowerCase()) || `(lvl ${lvl})`;
}

// Tabela: posortowana po killach (najwięcej na górze), korona przy MVP, opcjonalnie ADR
function formatPlayerStats(players = [], { mvpNick = null, showAdr = false, roundsPlayed = 0 } = {}) {
  const mvpLower = (mvpNick || '').toLowerCase();

  const sorted = [...players].sort((a, b) => {
    const ka = Number(a.player_stats?.Kills ?? 0);
    const kb = Number(b.player_stats?.Kills ?? 0);
    if (kb !== ka) return kb - ka;
    return Number(a.player_stats?.Deaths ?? 0) - Number(b.player_stats?.Deaths ?? 0);
  });

  return sorted.map(p => {
    const s = p.player_stats || {};
    const kd = Number(s['K/D Ratio'] ?? 0);
    const kills = s.Kills ?? '-';
    const deaths = s.Deaths ?? '-';
    const hs = s['Headshots %'] ?? '-';
    const nick = (p.nickname || '?').slice(0, 12);
    const crown = mvpLower && lowerNick(p) === mvpLower ? ' 👑' : '   ';
    const adrText = showAdr ? ` | ADR:${getAdr(p, roundsPlayed).toFixed(0)}` : '';
    return `${nick.padEnd(12)}${crown} | ${kills}/${deaths} | KD:${kd.toFixed(2)} | HS:${hs}${adrText}`;
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
  const rosterOnly = players.filter(p =>
    ACTIVE_ROSTER.includes((p.nickname || '').toLowerCase())
  );

  const pool = rosterOnly.length ? rosterOnly : players;

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
IMAGE SYSTEM (UNCHANGED)
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
  let levelEmojis = null;

  for (const matchId of uniqueMatchIds) {

    /* =========================
    🔥 HARD DUPLICATE FIX (REAL)
    ========================= */
    let matchExists = false;

    try {
      matchExists = matchLogger.checkIfMatchExists(matchId);
    } catch {
      matchExists = storage.hasLegacyMatch(matchId);
    }

    if (matchExists || processedMatches.has(matchId)) {
      continue;
    }

    processedMatches.add(matchId);

    const stats = await faceit.getMatchStats(matchId, { ctx: tickCtx });
    const round = stats?.rounds?.[0];
    if (!round) continue;

    const allPlayers = (round.teams || []).flatMap(t => t.players || []);

    const activeTracked = allPlayers.filter(p =>
      trackedMap.has((p.nickname || '').toLowerCase())
    );

    if (!activeTracked.length) continue;

    const ourTeam = (round.teams || []).find(t =>
      t.players?.some(p =>
        trackedMap.has((p.nickname || '').toLowerCase())
      )
    );

    if (!ourTeam) continue;

    const enemyTeam = (round.teams || []).find(t => t !== ourTeam) || { players: [] };

    const { our, enemy } = getTeamScore(round, ourTeam);
    const isWin = our > enemy;

    const resultText = `${isWin ? '🟢 WIN' : '🔴 LOSE'} | ${our}:${enemy}`;

    const mvp = getTopFragger(ourTeam.players || []);

    const roundsPlayed = Number(round.round_stats?.Rounds) || (our + enemy);

    // skład po naszej stronie: pełna piątka / core
    const ourPlayers = ourTeam.players || [];
    const rosterPresent = hasAllPlayers(ourPlayers, ACTIVE_ROSTER);
    const corePresent = hasAllPlayers(ourPlayers, CORE_PLAYERS);

    if (!levelEmojis) levelEmojis = await resolveLevelEmojis(client, channel);

    /* =========================
    ELO + LVL
    ========================= */
    let eloLines = '';
    const eloByNick = new Map();

    for (const nick of trackedPlayers) {
      try {
        const p = await faceit.getPlayer(nick, { forceRefresh: true, ctx: tickCtx });

        const elo = Number(p.games?.cs2?.faceit_elo ?? 0);
        const lvl = p.games?.cs2?.skill_level ?? '?';

        const prev = Number.isFinite(Number(eloCache[nick]))
          ? Number(eloCache[nick])
          : elo;

        eloLines += `- ${nick} ${levelLabel(levelEmojis, lvl)} ${eloCache[nick] ?? 'X'} → ${elo}\n`;

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
    STREAK (tylko gdy gra cała piątka – Active Roster)
    Mecze bez pełnego składu nie zmieniają streaka.
    ========================= */
    let streakLine = null;

    if (rosterPresent) {
      const streak = storage.updateStreak(ROSTER_STREAK_KEY, isWin ? 'win' : 'lose');
      streakLine = `🔥 STREAK ${streak.type.toUpperCase()} ${streak.count}`;
    }

    /* =========================
    ACHIEVEMENTS
    ========================= */
    const achievementLines = [];
    const badgesByNick = new Map();

    for (const p of activeTracked) {
      const nickLower = (p.nickname || '').toLowerCase();
      const displayNick = trackedMap.get(nickLower) || p.nickname || '?';

      const elo = eloByNick.get(nickLower) || { delta: 0 };

      const playerObj = {
        nickname: displayNick,
        kills: getStatNumber(p, 'Kills'),
        deaths: getStatNumber(p, 'Deaths'),
        assists: getStatNumber(p, 'Assists'),
        hs: getStatNumber(p, 'Headshots %'),
        kd: getStatNumber(p, 'K/D Ratio'),
        mvp: (mvp.nick || '').toLowerCase() === nickLower,
        adr: getAdr(p, roundsPlayed),
        quadro: getStatNumber(p, 'Quadro Kills'),
        penta: getStatNumber(p, 'Penta Kills'),
        elo_delta: elo.delta,
        result: isWin ? 'win' : 'loss'
      };

      const badges = getReportAchievements(playerObj);
      badgesByNick.set(nickLower, badges);

      if (badges.length) {
        achievementLines.push(`${displayNick} - ${badges.join(' • ')}`);
      }
    }

    /* =========================
    PING SYSTEM
    ========================= */
    const mentionOf = p =>
      getMention(trackedMap.get(lowerNick(p)) || p.nickname);

    const rosterRoleId = process.env.ACTIVE_ROSTER_ROLE_ID;
    const coreRoleId = process.env.CORE_ROLE_ID;

    let mentions;

    if (rosterPresent && rosterRoleId) {
      // cała piątka -> @Active Roster zamiast @core
      mentions = `<@&${rosterRoleId}>`;
    } else if (corePresent && coreRoleId) {
      // @core + pozostali śledzeni gracze spoza core (np. FazardRX / Foxer36)
      const extras = activeTracked
        .filter(p => !CORE_PLAYERS.includes(lowerNick(p)))
        .map(mentionOf);
      mentions = [`<@&${coreRoleId}>`, ...extras].join(' ');
    } else {
      mentions = activeTracked.map(mentionOf).join(' ');
    }

    const rawTs =
      lastMatches.find(m => m?.match_id === matchId)?.finished_at ||
      Math.floor(Date.now() / 1000);

    const dateText = toDateText(rawTs);
    const mapName = round.round_stats?.Map || '-';

    const message = [
      `📊 Raport ${mentions}`,
      `📅 Data: ${dateText}`,
      resultText,
      ...(streakLine ? [streakLine] : []),
      `🌍 Mapa: ${mapName}`,
      '',
      `🏅 ACHIEVEMENTS:`,
      achievementLines.length ? achievementLines.join('\n') : 'brak',
      '',
      `📈 ELO:`,
      eloLines.trimEnd()
    ].join('\n');

    const showAdr = [...(ourTeam.players || []), ...(enemyTeam.players || [])]
      .some(p => getAdr(p, roundsPlayed) > 0);

    const tableOpts = { mvpNick: mvp.nick, showAdr, roundsPlayed };

    const statsEmbed = new EmbedBuilder()
      .setColor(isWin ? 0x2ecc71 : 0xe74c3c)
      .setTitle('📋 Statystyki meczu')
      .addFields(
        { name: 'OUR', value: `\`\`\`\n${formatPlayerStats(ourTeam.players, tableOpts)}\n\`\`\`` },
        { name: 'ENEMY', value: `\`\`\`\n${formatPlayerStats(enemyTeam.players, { showAdr, roundsPlayed })}\n\`\`\`` },
        { name: 'MVP', value: mvp.nick || '?', inline: true }
      );

  /* =========================
  🔥 SAVE MATCH TO ACTIVE GRIND
  (przed wysyłką, żeby błąd Discorda nie zgubił statystyk)
  ========================= */
  storage.addMatchToGrind({
    id: matchId,
    finishedAt: rawTs * 1000,
    isWin,
    map: mapName,
    score: `${our}:${enemy}`,
    mvp: mvp.nick,

    players: (ourTeam.players || []).map(p => {
      const lower = (p.nickname || '').toLowerCase();
      const elo = eloByNick.get(lower);

      return {
        nickname: trackedMap.get(lower) || p.nickname || '?',
        playerId: p.player_id,
        tracked: trackedMap.has(lower),

        kills: getStatNumber(p, 'Kills'),
        deaths: getStatNumber(p, 'Deaths'),
        assists: getStatNumber(p, 'Assists'),
        hs: getStatNumber(p, 'Headshots %'),
        kd: getStatNumber(p, 'K/D Ratio'),
        kr: getStatNumber(p, 'K/R Ratio'),
        adr: getAdr(p, roundsPlayed),
        mvps: getStatNumber(p, 'MVPs'),
        triple: getStatNumber(p, 'Triple Kills'),
        quadro: getStatNumber(p, 'Quadro Kills'),
        penta: getStatNumber(p, 'Penta Kills'),

        eloDelta: elo ? elo.delta : 0,
        achievements: badgesByNick.get(lower) || []
      };
    })
  });

  await channel.send({ content: message, embeds: [statsEmbed] });

  const image = getRandomImage(isWin, lastImageRef);
  if (image) await channel.send({ files: [image] });

  storage.addMatch(matchId);
  }
}

module.exports = {
  processMatches,
  getMention,
  ACTIVE_ROSTER,
  ROSTER_NICKS
};
