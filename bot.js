require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const express = require("express");

// ================= KEEP ALIVE =================
const app = express();
const port = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Bot is alive!"));
app.listen(port, () => console.log(`Server running on port ${port}`));
// =============================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const {
  DISCORD_TOKEN,
  FACEIT_API_KEY,
  CHANNEL_ID,
  CHECK_INTERVAL,
  FACEIT_NICKS,
  GUILD_ID
} = process.env;

if (!FACEIT_NICKS) {
  console.error("FACEIT_NICKS nie jest ustawione w ENV");
  process.exit(1);
}

const nicknames = FACEIT_NICKS.split(',').map(n => n.trim());

let checkedMatches = new Set();
let playerCache = {};
let zmeczStats = {};

// ================= FILE STORAGE =================
const saveMatches = () => {
  fs.writeFileSync('matches.json', JSON.stringify([...checkedMatches]));
};

const loadMatches = () => {
  if (fs.existsSync('matches.json')) {
    checkedMatches = new Set(JSON.parse(fs.readFileSync('matches.json')));
  }
};

const saveLeaderboard = () => {
  fs.writeFileSync('leaderboard.json', JSON.stringify(zmeczStats, null, 2));
};

const loadLeaderboard = () => {
  if (fs.existsSync('leaderboard.json')) {
    zmeczStats = JSON.parse(fs.readFileSync('leaderboard.json'));
  }
};

// ================= FACEIT API =================
async function getPlayer(nick) {
  const res = await axios.get(
    `https://open.faceit.com/data/v4/players?nickname=${nick}`,
    { headers: { Authorization: `Bearer ${FACEIT_API_KEY}` } }
  );
  return res.data;
}

async function getLastMatch(playerId) {
  const res = await axios.get(
    `https://open.faceit.com/data/v4/players/${playerId}/history?game=cs2&limit=1`,
    { headers: { Authorization: `Bearer ${FACEIT_API_KEY}` } }
  );
  return res.data.items[0];
}

async function getMatchStats(matchId) {
  const res = await axios.get(
    `https://open.faceit.com/data/v4/matches/${matchId}/stats`,
    { headers: { Authorization: `Bearer ${FACEIT_API_KEY}` } }
  );
  return res.data;
}

function getMention(nick) {
  const id = process.env[`MENTION_${nick}`];
  return id ? `<@${id}>` : nick;
}

function formatPlayerStats(players) {
  return players.map(p => {
    const s = p.player_stats || {};
    const kdRatio = Number(s["K/D Ratio"]) || 0;
    return `\`${p.nickname.padEnd(12)} | K/D: ${String(s.Kills||0).padStart(2,'0')}/${String(s.Deaths||0).padStart(2,'0')} | K/Dśr: ${kdRatio.toFixed(2)} | HS%: ${String(s["Headshots %"]||"-")}\``;
  }).join("\n");
}

// ================= MATCH LOGIC =================
async function processMatch(nick, forceSend = false, interaction = null) {
  try {
    const player = await getPlayer(nick);
    const lastMatch = await getLastMatch(player.player_id);
    if (!lastMatch) return;

    if (checkedMatches.has(lastMatch.match_id) && !forceSend) return;

    const stats = await getMatchStats(lastMatch.match_id);
    if (!stats.rounds || !stats.rounds[0]) return;

    const round = stats.rounds[0];
    const map = round.round_stats.Map;
    const score = round.round_stats.Score;

    let eloLines = "";
    for (const n of nicknames) {
      try {
        const playerData = await getPlayer(n);
        const currentElo = playerData.games?.cs2?.faceit_elo || 0;
        const previousElo = playerCache[n] != null ? playerCache[n] : "X";
        eloLines += `-${n} ${previousElo} → ${currentElo}\n`;
        playerCache[n] = currentElo;
      } catch {
        eloLines += `-${n} brak danych\n`;
      }
    }

    const ourTeam = round.teams.find(t =>
      t.players.some(p => p.nickname.toLowerCase() === nick.toLowerCase())
    );
    const enemyTeam = round.teams.find(t => t !== ourTeam);

    const ourTeamStats = formatPlayerStats(ourTeam.players);
    const enemyTeamStats = enemyTeam ? formatPlayerStats(enemyTeam.players) : "Brak przeciwników";

    const eventTimeRaw = lastMatch.finished_at || lastMatch.started_at || Date.now();
    const eventTime = new Date(eventTimeRaw * 1000).toLocaleString('pl-PL', {
      day:'2-digit', month:'2-digit', year:'numeric',
      hour:'2-digit', minute:'2-digit'
    });

    const mentions = nicknames.map(getMention).join(' ');

    const message = `📊 Raport z Faceit ${mentions}
📅 Data wydarzenia: ${eventTime}
🎯 Wynik: ${score}
🌍 Mapa: ${map}
📈 Zmiana ELO:
${eloLines}

📋 Statystyki graczy - OUR TEAM:
${ourTeamStats}

📋 Statystyki graczy - ENEMY TEAM:
${enemyTeamStats}`;

    if (interaction) {
      await interaction.reply({ content: message });
    } else {
      const channel = await client.channels.fetch(CHANNEL_ID);
      if (!channel) return;
      await channel.send({ content: message });
      checkedMatches.add(lastMatch.match_id);
      saveMatches();
    }

  } catch (err) {
    console.error("Błąd:", err.response?.data || err.message);
  }
}

// ================= AUTO CHECK =================
async function checkMatches() {
  for (const nick of nicknames) {
    await processMatch(nick);
  }
}

// ================= READY =================
client.once('ready', async () => {
  console.log(`Zalogowano jako ${client.user.tag}`);
  loadMatches();
  loadLeaderboard();

  const commands = [
    new SlashCommandBuilder()
      .setName('checkmatch')
      .setDescription('Sprawdza ostatni mecz gracza')
      .addStringOption(option =>
        option.setName('nick').setDescription('Nick FACEIT').setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('zmecz_zweiha')
      .setDescription('Oznacza, że ktoś zmeczył Zweiha 🍆'),

    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Pokazuje ranking zmeczenia Zweiha'),

    new SlashCommandBuilder()
      .setName('resetleaderboard')
      .setDescription('Resetuje leaderboard')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  ];

  for (const command of commands) {
    if (GUILD_ID) {
      await client.application.commands.create(command, GUILD_ID);
    } else {
      await client.application.commands.create(command);
    }
  }

  const interval = Number(CHECK_INTERVAL) || 180000;
  await checkMatches();
  setInterval(checkMatches, interval);
});

// ================= INTERACTIONS =================
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'checkmatch') {
    const nick = interaction.options.getString('nick');
    await processMatch(nick, true, interaction);
  }

  if (interaction.commandName === 'zmecz_zweiha') {
    const userId = interaction.user.id;
    if (!zmeczStats[userId]) zmeczStats[userId] = 0;
    zmeczStats[userId] += 1;
    saveLeaderboard();

    await interaction.reply({
      content: `<@${userId}> zmeczył Zweiha 🍆 🤬`
    });
  }

  if (interaction.commandName === 'leaderboard') {
    const sorted = Object.entries(zmeczStats)
      .filter(e => e[1] > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (sorted.length === 0) {
      return interaction.reply({ content: "Leaderboard:\nBrak danych." });
    }

    let text = "Leaderboard:\n";

    sorted.forEach((entry, index) => {
      const [userId, count] = entry;

      let pos;
      if (index === 0) pos = "🥇";
      else if (index === 1) pos = "🥈";
      else if (index === 2) pos = "🥉";
      else pos = `${index + 1}.`;

      text += `${pos} <@${userId}> ${count}\n`;
    });

    await interaction.reply({ content: text });
  }

  if (interaction.commandName === 'resetleaderboard') {
    zmeczStats = {};
    saveLeaderboard();
    await interaction.reply({ content: "Leaderboard został zresetowany." });
  }
});

client.login(DISCORD_TOKEN);
