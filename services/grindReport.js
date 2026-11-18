const { EmbedBuilder } = require('discord.js');
const { getGrindAwards } = require('./reportAchievements');

const TZ = 'Europe/Warsaw';
const FIELD_LIMIT = 1000; // limit Discorda to 1024 znaków na pole

/* =========================
   HELPERY
========================= */
const num = (v, fallback = 0) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
};

function fmtDateTime(ts) {
  return new Date(ts).toLocaleString('pl-PL', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('pl-PL', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit'
  });
}

function fmtDuration(ms) {
  const totalMin = Math.max(0, Math.round(num(ms) / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h}h ${m}min` : `${m}min`;
}

function signed(v) {
  return `${v >= 0 ? '+' : ''}${v}`;
}

// dzieli listę linii na kawałki mieszczące się w jednym polu embeda
function chunkLines(lines, limit = FIELD_LIMIT) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function parseScore(match) {
  const [our, enemy] = String(match.score || '0:0').split(':').map(v => num(v));
  return { our, enemy };
}

/* =========================
   SNAPSHOT ELO (start / koniec grindu)
========================= */
async function snapshotElo(faceit, nicks = []) {
  const out = {};

  await Promise.all(nicks.map(async nick => {
    try {
      const p = await faceit.getPlayer(nick, { forceRefresh: true });
      out[nick.toLowerCase()] = {
        nick: p.nickname || nick,
        elo: num(p.games?.cs2?.faceit_elo),
        level: p.games?.cs2?.skill_level ?? null
      };
    } catch (err) {
      console.error(`[GRIND] snapshot ELO failed for ${nick}: ${err.message}`);
    }
  }));

  return out;
}

/* =========================
   AGREGACJA SESJI
========================= */
function aggregateGrind(session) {
  const matches = [...(session.matches || [])]
    .sort((a, b) => num(a.finishedAt) - num(b.finishedAt));

  let wins = 0;
  let losses = 0;
  let curWin = 0;
  let curLose = 0;
  let longestWin = 0;
  let longestLose = 0;

  const maps = new Map();
  const players = new Map();
  let bestPerformance = null;

  for (const m of matches) {
    const { our, enemy } = parseScore(m);
    const rounds = our + enemy;
    const isWin = Boolean(m.isWin);

    if (isWin) {
      wins += 1;
      curWin += 1;
      curLose = 0;
    } else {
      losses += 1;
      curLose += 1;
      curWin = 0;
    }
    longestWin = Math.max(longestWin, curWin);
    longestLose = Math.max(longestLose, curLose);

    const mapName = m.map || '-';
    const mapRow = maps.get(mapName) || { wins: 0, losses: 0 };
    if (isWin) mapRow.wins += 1;
    else mapRow.losses += 1;
    maps.set(mapName, mapRow);

    const mvpLower = String(m.mvp || '').toLowerCase();

    for (const p of m.players || []) {
      if (p.tracked === false) continue; // pomijamy przypadkowych graczy z teamu

      const key = String(p.nickname || '?').toLowerCase();
      const kills = num(p.kills);
      const deaths = num(p.deaths);

      if (!players.has(key)) {
        players.set(key, {
          nick: p.nickname || '?',
          matches: 0,
          wins: 0,
          kills: 0,
          deaths: 0,
          assists: 0,
          hsWeighted: 0,
          damage: 0,
          adrRounds: 0,
          rounds: 0,
          roundMvps: 0,
          triple: 0,
          quadro: 0,
          penta: 0,
          topFrags: 0,
          achievements: new Map()
        });
      }

      const agg = players.get(key);
      agg.matches += 1;
      if (isWin) agg.wins += 1;
      agg.kills += kills;
      agg.deaths += deaths;
      agg.assists += num(p.assists);
      agg.hsWeighted += num(p.hs) * kills;
      agg.rounds += rounds;
      agg.roundMvps += num(p.mvps);
      agg.triple += num(p.triple);
      agg.quadro += num(p.quadro);
      agg.penta += num(p.penta);

      if (num(p.adr) > 0) {
        agg.damage += num(p.adr) * rounds;
        agg.adrRounds += rounds;
      }

      if (mvpLower && mvpLower === key) agg.topFrags += 1;

      for (const badge of p.achievements || []) {
        agg.achievements.set(badge, (agg.achievements.get(badge) || 0) + 1);
      }

      const kd = kills / Math.max(deaths, 1);
      if (
        !bestPerformance ||
        kills > bestPerformance.kills ||
        (kills === bestPerformance.kills && kd > bestPerformance.kd)
      ) {
        bestPerformance = { nick: agg.nick, kills, deaths, kd, map: mapName, isWin };
      }
    }
  }

  // wartości pochodne + ELO
  const startElo = session.startElo || {};
  const endElo = session.endElo || {};

  const playerList = [...players.entries()].map(([key, a]) => {
    const start = startElo[key];
    const end = endElo[key];
    const hasElo = Boolean(start && end);

    return {
      ...a,
      kd: a.kills / Math.max(a.deaths, 1),
      hs: a.kills ? a.hsWeighted / a.kills : 0,
      adr: a.adrRounds ? a.damage / a.adrRounds : null,
      kr: a.rounds ? a.kills / a.rounds : 0,
      eloStart: hasElo ? start.elo : null,
      eloEnd: hasElo ? end.elo : null,
      eloDelta: hasElo ? end.elo - start.elo : null
    };
  }).sort((a, b) => b.kd - a.kd);

  // średnie całej drużyny (tylko śledzeni gracze)
  const sum = (fn) => playerList.reduce((s, p) => s + fn(p), 0);
  const totalKills = sum(p => p.kills);
  const totalDeaths = sum(p => p.deaths);
  const totalRounds = sum(p => p.rounds);
  const adrPlayers = playerList.filter(p => p.adr !== null);
  const adrRounds = adrPlayers.reduce((s, p) => s + p.adrRounds, 0);

  const team = {
    kills: totalKills,
    deaths: totalDeaths,
    assists: sum(p => p.assists),
    kd: totalKills / Math.max(totalDeaths, 1),
    hs: totalKills ? sum(p => p.hsWeighted) / totalKills : 0,
    adr: adrRounds ? adrPlayers.reduce((s, p) => s + p.damage, 0) / adrRounds : null,
    kr: totalRounds ? totalKills / totalRounds : 0,
    eloDelta: playerList.some(p => p.eloDelta !== null)
      ? playerList.reduce((s, p) => s + (p.eloDelta || 0), 0)
      : null
  };

  return {
    matches,
    wins,
    losses,
    total: wins + losses,
    winrate: wins + losses ? (wins / (wins + losses)) * 100 : 0,
    longestWin,
    longestLose,
    maps,
    players: playerList,
    team,
    bestPerformance
  };
}

/* =========================
   BUDOWA RAPORTU (lista embedów)
========================= */
function statsRow(label, s) {
  const kad = `${s.kills}/${s.assists}/${s.deaths}`;
  const adr = s.adr === null ? '-' : s.adr.toFixed(1);
  const elo = s.eloDelta === null || s.eloDelta === undefined ? '-' : signed(s.eloDelta);

  return [
    String(label).slice(0, 11).padEnd(11),
    kad.padEnd(10),
    s.kd.toFixed(2).padStart(4),
    adr.padStart(5),
    s.hs.toFixed(0).padStart(4),
    s.kr.toFixed(2).padStart(4),
    elo.padStart(5)
  ].join(' ');
}

const STATS_HEADER = ['Gracz'.padEnd(11), 'K/A/D'.padEnd(10), 'KD'.padStart(4), 'ADR'.padStart(5), 'HS%'.padStart(4), 'K/R'.padStart(4), 'ELO'.padStart(5)].join(' ');

function buildGrindReport(session) {
  const data = aggregateGrind(session);
  const startedAt = num(session.startedAt);
  const endedAt = num(session.endedAt, Date.now());
  const color = data.winrate >= 50 ? 0x2ecc71 : 0xe74c3c;

  /* ---------- EMBED 1: PODSUMOWANIE ---------- */
  const summary = new EmbedBuilder()
    .setColor(color)
    .setTitle('🎮 FC Grind Report');

  const headerLines = [
    data.players.length ? `👥 **Skład:** ${data.players.map(p => p.nick).join(', ')}` : null,
    session.startedBy ? `🚀 **Start:** <@${session.startedBy}>` : null,
    `📅 **Data:** ${fmtDateTime(startedAt)} → ${fmtTime(endedAt)}`,
    `⏱️ **Czas:** ${fmtDuration(endedAt - startedAt)}`,
    `🎮 **Mecze:** ${data.total}`
  ].filter(Boolean);

  summary.setDescription(headerLines.join('\n'));

  if (!data.total) {
    summary.addFields({
      name: 'ℹ️ Brak meczów',
      value: 'W trakcie tego grindu bot nie zarejestrował żadnego meczu.'
    });
    return [summary];
  }

  summary.addFields(
    {
      name: '🏆 Wynik',
      value: `🟢 ${data.wins} W • 🔴 ${data.losses} L\nWinrate: **${data.winrate.toFixed(1)}%**`,
      inline: true
    },
    {
      name: '🔥 Serie',
      value: `Win streak: **${data.longestWin}**\nLose streak: **${data.longestLose}**`,
      inline: true
    },
    {
      name: '📈 ELO drużyny',
      value: data.team.eloDelta === null ? 'brak danych' : `**${signed(data.team.eloDelta)}**`,
      inline: true
    }
  );

  const awards = getGrindAwards(data.players);
  const mvpAward = awards[0];

  if (mvpAward) {
    summary.addFields({
      name: '👑 MVP Grindu',
      value: `**${mvpAward.nick}**\n${mvpAward.detail}`,
      inline: true
    });
  }

  if (data.bestPerformance) {
    const b = data.bestPerformance;
    summary.addFields({
      name: '⭐ Best Performance',
      value: `**${b.nick}** – ${b.kills}/${b.deaths} (K/D ${b.kd.toFixed(2)})\n${b.map} ${b.isWin ? '🟢' : '🔴'}`,
      inline: true
    });
  }

  summary.addFields({
    name: '📊 Średnie drużyny',
    value: [
      `⚔️ K/D: **${data.team.kd.toFixed(2)}**`,
      `🎯 HS: **${data.team.hs.toFixed(1)}%**`,
      `💣 ADR: **${data.team.adr === null ? '-' : data.team.adr.toFixed(1)}**`,
      `💥 K/R: **${data.team.kr.toFixed(2)}**`
    ].join('\n'),
    inline: true
  });

  /* ---------- EMBED 2: WYNIKI MAP ---------- */
  const mapsEmbed = new EmbedBuilder()
    .setColor(color)
    .setTitle('🗺️ Wyniki map');

  const matchLines = data.matches.map((m, i) => {
    const { our, enemy } = parseScore(m);
    const top = (m.players || []).find(p => String(p.nickname || '').toLowerCase() === String(m.mvp || '').toLowerCase());
    const topText = top ? ` — ⭐ ${top.nickname} (${num(top.kills)}/${num(top.deaths)})` : '';
    return `${i + 1}. ${m.isWin ? '🟢' : '🔴'} **${m.map || '-'}** ${our}:${enemy}${topText}`;
  });

  chunkLines(matchLines).forEach((chunk, i) => {
    mapsEmbed.addFields({ name: i === 0 ? 'Mecze po kolei' : '​', value: chunk });
  });

  const mapBalance = [...data.maps.entries()]
    .sort((a, b) => (b[1].wins + b[1].losses) - (a[1].wins + a[1].losses))
    .map(([name, r]) => `${name}: ${r.wins}W-${r.losses}L`);

  chunkLines(mapBalance).forEach((chunk, i) => {
    mapsEmbed.addFields({ name: i === 0 ? 'Bilans map' : '​', value: chunk });
  });

  /* ---------- EMBED 3: STATYSTYKI GRACZY ---------- */
  const statsEmbed = new EmbedBuilder()
    .setColor(color)
    .setTitle('📊 Statystyki graczy');

  const statLines = data.players.map(p => statsRow(p.nick, p));
  statLines.push('-'.repeat(STATS_HEADER.length));
  statLines.push(statsRow('TEAM', data.team));

  const tableChunks = chunkLines([STATS_HEADER, ...statLines], 950);
  tableChunks.forEach((chunk, i) => {
    statsEmbed.addFields({
      name: i === 0 ? 'Suma z całego grindu' : '​',
      value: `\`\`\`\n${chunk}\n\`\`\``
    });
  });

  const extraLines = data.players.map(p => {
    const bits = [`${p.wins}W-${p.matches - p.wins}L`];
    if (p.roundMvps) bits.push(`★ ${p.roundMvps} MVP rund`);
    if (p.triple) bits.push(`3K×${p.triple}`);
    if (p.quadro) bits.push(`4K×${p.quadro}`);
    if (p.penta) bits.push(`ACE×${p.penta}`);
    if (p.eloStart !== null) bits.push(`ELO ${p.eloStart} → ${p.eloEnd}`);
    return `**${p.nick}** – ${bits.join(' • ')}`;
  });

  chunkLines(extraLines).forEach((chunk, i) => {
    statsEmbed.addFields({ name: i === 0 ? 'Dodatkowo' : '​', value: chunk });
  });

  /* ---------- EMBED 4: ACHIEVEMENTS ---------- */
  const achEmbed = new EmbedBuilder()
    .setColor(color)
    .setTitle('🏅 Achievements');

  const awardLines = awards.map(a => `${a.label} — **${a.nick}** (${a.detail})`);
  chunkLines(awardLines).forEach((chunk, i) => {
    achEmbed.addFields({ name: i === 0 ? 'Nagrody grindu' : '​', value: chunk });
  });

  let totalBadges = 0;
  const badgeLines = data.players.map(p => {
    const entries = [...p.achievements.entries()];
    totalBadges += entries.reduce((s, [, c]) => s + c, 0);
    if (!entries.length) return `**${p.nick}** – brak`;
    return `**${p.nick}** – ${entries.map(([b, c]) => (c > 1 ? `${b} ×${c}` : b)).join(' • ')}`;
  });

  chunkLines(badgeLines).forEach((chunk, i) => {
    achEmbed.addFields({ name: i === 0 ? 'Zdobyte w meczach' : '​', value: chunk });
  });

  achEmbed.setFooter({ text: `🏆 Łącznie odznak: ${totalBadges} • Mecze: ${data.total}` });

  return [summary, mapsEmbed, statsEmbed, achEmbed];
}

/* =========================
   GRUPOWANIE EMBEDÓW W WIADOMOŚCI
   (Discord: max 10 embedów i 6000 znaków łącznie na wiadomość)
========================= */
function embedSize(embed) {
  const d = embed.data || {};
  return (d.title || '').length
    + (d.description || '').length
    + (d.footer?.text || '').length
    + (d.fields || []).reduce((s, f) => s + f.name.length + f.value.length, 0);
}

function groupEmbeds(embeds, maxChars = 5500) {
  const groups = [];
  let current = [];
  let size = 0;

  for (const e of embeds) {
    const s = embedSize(e);
    if (current.length && (size + s > maxChars || current.length >= 10)) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(e);
    size += s;
  }
  if (current.length) groups.push(current);

  return groups;
}

module.exports = {
  snapshotElo,
  aggregateGrind,
  buildGrindReport,
  groupEmbeds,
  fmtDateTime
};
