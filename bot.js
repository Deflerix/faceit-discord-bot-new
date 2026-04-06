// ================= DEBUG ŚRODOWISKA =================
console.log("=== ROZPOCZYNAM URUCHOMIENIE BOTA NA RENDER ===");
console.log("Node version:", process.version);
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("PORT:", process.env.PORT);

const criticalVars = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN ? `✅ ISTNIEJE (${process.env.DISCORD_TOKEN.length} znaków)` : "❌ BRAK",
  FACEIT_API_KEY: process.env.FACEIT_API_KEY ? "✅ ISTNIEJE" : "❌ BRAK",
  CHANNEL_ID: process.env.CHANNEL_ID || "❌ BRAK",
  FACEIT_NICKS: process.env.FACEIT_NICKS || "❌ BRAK",
  GUILD_ID: process.env.GUILD_ID || "nie ustawione"
};
console.table(criticalVars);

if (!process.env.DISCORD_TOKEN) {
  console.error("❌ KRRYTYCZNY BŁĄD: Brak DISCORD_TOKEN!");
}

// Tylko lokalnie
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
  console.log("✅ dotenv wczytany lokalnie");
} else {
  console.log("Produkcja - dotenv pominięty");
}

// ================= IMPORTY =================
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const express = require('express');

// ================= KEEP ALIVE =================
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is alive!'));
app.listen(port, () => console.log(`✅ Server running on port ${port}`));

// ================= CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ]
});

console.log("✅ Client utworzony z intents: Guilds + GuildMembers + GuildMessages");

// ================= ZMIENNE ŚRODOWISKOWE =================
const { 
  DISCORD_TOKEN, 
  FACEIT_API_KEY, 
  CHANNEL_ID, 
  CHECK_INTERVAL, 
  FACEIT_NICKS, 
  GUILD_ID 
} = process.env;

const nicknames = (FACEIT_NICKS || '').split(',').map(n => n.trim()).filter(Boolean);

let checkedMatches = new Set();
let playerCache = {};
let eloCache = {};
let lastImage = null;
let leaderboard = {};

// ================= AXIOS =================
const api = axios.create({
  timeout: 5000,
  headers: { Authorization: `Bearer ${FACEIT_API_KEY}` }
});

// ================= FILE STORAGE =================
const saveMatches = () => fs.writeFileSync('matches.json', JSON.stringify([...checkedMatches].slice(-100)));
const loadMatches = () => {
  if (fs.existsSync('matches.json')) checkedMatches = new Set(JSON.parse(fs.readFileSync('matches.json')));
};
const saveLeaderboard = () => fs.writeFileSync('leaderboard.json', JSON.stringify(leaderboard));
const loadLeaderboard = () => {
  if (fs.existsSync('leaderboard.json')) leaderboard = JSON.parse(fs.readFileSync('leaderboard.json'));
};

// ================= FACEIT FUNCTIONS =================
async function getPlayer(nick, forceRefresh = false) {
  if (!forceRefresh && playerCache[nick]) return playerCache[nick];
  const res = await api.get(`https://open.faceit.com/data/v4/players?nickname=${encodeURIComponent(nick)}`);
  playerCache[nick] = res.data;
  return res.data;
}

async function getLastMatch(playerId) {
  const res = await api.get(`https://open.faceit.com/data/v4/players/${playerId}/history?game=cs2&limit=1`);
  return res.data.items?.[0];
}

async function getMatchStats(matchId) {
  const res = await api.get(`https://open.faceit.com/data/v4/matches/${matchId}/stats`);
  return res.data;
}

// ================= HELPERS =================
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
  const [s1, s2] = (round.round_stats?.Score || '0/0').split('/').map(v => Number(v) || 0);
  const [team1] = round.teams || [];
  return ourTeam === team1 ? { our: s1, enemy: s2 } : { our: s2, enemy: s1 };
}

function getTopFragger(players = []) {
  return players.reduce((best, p) => {
    const kills = Number(p.player_stats?.Kills ?? 0);
    return kills > best.kills ? { nick: p.nickname || '?', kills } : best;
  }, { nick: '?', kills: -1 });
}

function getElProfesore(players = []) {
  const target = ['deflerix', 'w4kky', 'pawik'];
  let filtered = players.filter(p => target.includes((p.nickname || '').toLowerCase()));
  if (!filtered.length) filtered = players;
  return filtered.reduce((worst, p) => {
    const kills = Number(p.player_stats?.Kills ?? 0);
    return kills < worst.kills ? { nick: p.nickname || '?', kills } : worst;
  }, { nick: '?', kills: Infinity });
}

function getRandomImage(isWin) {
  const images = isWin
    ? [process.env.IMAGE_WIN_1, process.env.IMAGE_WIN_2, process.env.IMAGE_WIN_3]
    : [process.env.IMAGE_LOSE_1, process.env.IMAGE_LOSE_2, process.env.IMAGE_LOSE_3];
  const allValid = images.filter(Boolean);
  const valid = allValid.filter(img => img !== lastImage);
  const pool = valid.length ? valid : allValid;
  if (!pool.length) return null;
  const selected = pool[Math.floor(Math.random() * pool.length)];
  lastImage = selected;
  return selected;
}

// ================= PROCESS MATCH =================
async function processMatch(forceSend = false) {
  try {
    if (!nicknames.length) return;

    const lastMatches = await Promise.all(
      nicknames.map(async nick => {
        const player = await getPlayer(nick, forceSend);
        return getLastMatch(player.player_id);
      })
    );

    const uniqueMatchIds = [...new Set(lastMatches.map(m => m?.match_id).filter(Boolean))];
    if (!uniqueMatchIds.length) return;

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;

    for (const matchId of uniqueMatchIds) {
      if (checkedMatches.has(matchId) && !forceSend) continue;

      const stats = await getMatchStats(matchId);
      const round = stats?.rounds?.[0];
      if (!round) continue;

      const lowerNicks = nicknames.map(n => n.toLowerCase());
      const ourTeam = (round.teams || []).find(t =>
        (t.players || []).some(p => lowerNicks.includes((p.nickname || '').toLowerCase()))
      );
      if (!ourTeam) continue;

      const enemyTeam = (round.teams || []).find(t => t !== ourTeam) || { players: [] };
      const { our, enemy } = getTeamScore(round, ourTeam);
      const isWin = our > enemy;
      const resultText = `${isWin ? '🟢 WIN' : '🔴 LOSE'} | ${our}:${enemy}`;

      const top = getTopFragger(ourTeam.players || []);
      const profesore = getElProfesore(ourTeam.players || []);

      let eloLines = '';
      for (const n of nicknames) {
        try {
          const p = await getPlayer(n, true);
          const elo = Number(p.games?.cs2?.faceit_elo ?? 0);
          const prev = eloCache[n] ?? 'X';
          eloLines += `- ${n} ${prev} → ${elo}\n`;
          eloCache[n] = elo;
        } catch {
          eloLines += `- ${n} brak danych\n`;
        }
      }

      const mentions = nicknames.map(getMention).join(' ');
      const image = getRandomImage(isWin);
      const rawTs = lastMatches.find(m => m?.match_id === matchId)?.finished_at
        || lastMatches.find(m => m?.match_id === matchId)?.started_at
        || Math.floor(Date.now() / 1000);

      const dateText = new Date(rawTs * 1000).toLocaleString('pl-PL', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });

      const mapName = round.round_stats?.Map || '-';

      const message = `📊 Raport ${mentions}\n📅 Data: ${dateText}\n${resultText}\n🌍 Mapa: ${mapName}\n🐐 GOAT: ${top.nick} (${top.kills})\n🚑 PROFESORE: ${profesore.nick} (${profesore.kills})\n\n📈 ELO:\n${eloLines}`;

      const statsEmbed = new EmbedBuilder()
        .setColor(isWin ? 0x2ecc71 : 0xe74c3c)
        .setTitle('📋 Statystyki meczu')
        .addFields(
          { name: 'OUR', value: `\`\`\`\n${formatPlayerStats(ourTeam.players)}\n\`\`\`` },
          { name: 'ENEMY', value: `\`\`\`\n${formatPlayerStats(enemyTeam.players)}\n\`\`\`` }
        );

      await channel.send({ content: message, embeds: [statsEmbed] });
      if (image) await channel.send({ files: [image] });

      checkedMatches.add(matchId);
      saveMatches();
    }
  } catch (err) {
    console.error("Błąd w processMatch:", err.message);
  }
}

// ================= READY =================
client.once('ready', async () => {
  console.log(`✅ ZALOGOWANO JAKO ${client.user.tag} (${client.user.id})`);
  console.log(`Na serwerach: ${client.guilds.cache.size}`);

  loadMatches();
  loadLeaderboard();

  try {
    const commands = [
      new SlashCommandBuilder().setName('zmecz_zweiha').setDescription('Zlicza zmeczenie Zweiha'),
      new SlashCommandBuilder().setName('leaderboard').setDescription('Pokazuje ranking zmeczeń')
    ];

    for (const c of commands) {
      await client.application.commands.create(c, GUILD_ID);
      console.log(`✅ Komenda "${c.name}" zarejestrowana`);
    }
  } catch (err) {
    console.error("Błąd rejestracji komend:", err.message);
  }

  setInterval(() => processMatch(), Number(CHECK_INTERVAL) || 180000);
  console.log("✅ Interval do sprawdzania meczów uruchomiony");
});

// ================= INTERACTIONS =================
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const userId = interaction.user.id;

  if (interaction.commandName === 'zmecz_zweiha') {
    leaderboard[userId] = (leaderboard[userId] || 0) + 1;
    saveLeaderboard();
    await interaction.reply({ content: `<@${userId}> zmeczył Zweiha 🍆 🤬` });
  }

  if (interaction.commandName === 'leaderboard') {
    const sorted = Object.entries(leaderboard)
      .filter(([_, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);

    if (!sorted.length) return interaction.reply('Brak zmeczeń w tabeli.');

    let message = 'Leaderboard:\n';
    const emojis = ['🥇', '🥈', '🥉'];
    sorted.forEach(([id, count], i) => {
      const prefix = i < 3 ? emojis[i] : `${i + 1}️⃣`;
      message += `${prefix} <@${id}> ${count}\n`;
    });
    await interaction.reply({ content: message });
  }
});

// ================= ERROR HANDLERS =================
client.on('error', err => console.error('Discord Client Error:', err));
client.on('shardError', err => console.error('Shard Error:', err));

process.on('unhandledRejection', error => {
  console.error('❌ Nieobsłużony Rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('❌ Nieobsłużony Exception:', error);
});

// ================= LOGIN (NA SAMYM KOŃCU) =================
client.login(DISCORD_TOKEN)
  .then(() => console.log("✅ client.login() zakończone pomyślnie – czekam na ready..."))
  .catch(err => {
    console.error("❌ BŁĄD LOGOWANIA:", err.message);
    if (err.message.includes("401") || err.message.toLowerCase().includes("token")) {
      console.error("→ Token jest nieprawidłowy. Zresetuj go w Discord Developer Portal.");
    } else if (err.message.includes("disallowed intent")) {
      console.error("→ Włącz wszystkie Privileged Gateway Intents w portalu Discord!");
    }
  });
