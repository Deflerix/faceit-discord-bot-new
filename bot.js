require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const express = require("express");

// ================= KEEP ALIVE =================
const app = express();
const port = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Bot is alive!"));
app.listen(port, () => console.log(`[KEEP-ALIVE] Server running on port ${port}`));
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

console.log("=== ENV DEBUG START ===");
console.log("CHANNEL_ID:", CHANNEL_ID);
console.log("GUILD_ID:", GUILD_ID);
console.log("FACEIT_NICKS:", FACEIT_NICKS);
console.log("========================");

if (!FACEIT_NICKS) {
  console.error("❌ FACEIT_NICKS nie jest ustawione w ENV");
  process.exit(1);
}

const nicknames = FACEIT_NICKS.split(',').map(n => n.trim());
let checkedMatches = new Set();
let playerCache = {}; // zapisuje currentElo dla przyszłych porównań

const saveMatches = () => {
  fs.writeFileSync('matches.json', JSON.stringify([...checkedMatches]));
};

const loadMatches = () => {
  if (fs.existsSync('matches.json')) {
    checkedMatches = new Set(JSON.parse(fs.readFileSync('matches.json')));
  }
};

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

async function processMatch(nick, forceSend = false, interaction = null) {
  try {
    console.log(`\n[CHECK ${new Date().toLocaleTimeString()}] ${nick}`);

    const player = await getPlayer(nick);
    const lastMatch = await getLastMatch(player.player_id);
    if (!lastMatch) return;

    if (checkedMatches.has(lastMatch.match_id) && !forceSend) {
      console.log(`[INFO] Mecz ${lastMatch.match_id} już był wysłany.`);
      return;
    }

    const stats = await getMatchStats(lastMatch.match_id);
    if (!stats.rounds || !stats.rounds[0]) return;

    const round = stats.rounds[0];
    const map = round.round_stats.Map;
    const score = round.round_stats.Score;

    // ELO: previous = X jeśli nie było, current z API
    const trackedNicks = ["Deflerix", "W4KKY", "pawik100737"];
    let eloLines = trackedNicks.map(n => {
      const p = round.teams.flatMap(t => t.players).find(pl => pl.nickname === n);
      if (!p) return `-${n}: brak danych`;
      const current = p.games?.cs2?.faceit_elo || 0;
      const previous = playerCache[n] != null ? playerCache[n] : "X";
      playerCache[n] = current; // zapisz na przyszłość
      return `-${n} ${previous} → ${current}`;
    }).join("\n");

    // Drużyna naszego gracza
    const ourTeam = round.teams.find(t => t.players.some(p => p.nickname.toLowerCase() === nick.toLowerCase()));
    const enemyTeam = round.teams.find(t => t !== ourTeam);

    const ourTeamStats = formatPlayerStats(ourTeam.players);
    const enemyTeamStats = enemyTeam ? formatPlayerStats(enemyTeam.players) : "Brak przeciwników";

    // Czas wydarzenia
    const eventTimeRaw = lastMatch.finished_at || lastMatch.started_at || Date.now();
    const eventTime = new Date(eventTimeRaw * 1000).toLocaleString('pl-PL', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });

    const mentions = trackedNicks.map(getMention).join(' ');

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
      if (!channel) {
        console.log(`[ERROR] Nie znaleziono kanału o ID ${CHANNEL_ID}`);
        return;
      }
      await channel.send({ content: message });
      checkedMatches.add(lastMatch.match_id);
      saveMatches();
    }

    console.log(`[SUCCESS] Wysłano mecz ${lastMatch.match_id}`);

  } catch (err) {
    console.error("[ERROR] Błąd podczas przetwarzania meczu:", err.response?.data || err.message);
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

  // Komenda /checkmatch
  const checkMatchCommand = new SlashCommandBuilder()
    .setName('checkmatch')
    .setDescription('Sprawdza ostatni mecz gracza')
    .addStringOption(option =>
      option.setName('nick')
        .setDescription('Nick FACEIT')
        .setRequired(true)
    );

  // Komenda /zmeczZweiha
  const zmeczZweihaCommand = new SlashCommandBuilder()
    .setName('zmeczZweiha')
    .setDescription('Pinguje osobę i mówi, że zmęczyła Zweiha 🍆🤬');

  if (GUILD_ID) {
    await client.application.commands.create(checkMatchCommand, GUILD_ID);
    await client.application.commands.create(zmeczZweihaCommand, GUILD_ID);
  } else {
    await client.application.commands.create(checkMatchCommand);
    await client.application.commands.create(zmeczZweihaCommand);
  }

  const interval = Number(CHECK_INTERVAL) || 180000;
  await checkMatches();
  setInterval(checkMatches, interval);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'checkmatch') {
    const nick = interaction.options.getString('nick');
    await processMatch(nick, true, interaction);
  }

if (interaction.commandName === 'zmecz_zweiha') {
    const userMention = `<@${interaction.user.id}>`;
    await interaction.reply(`${userMention} zmeczył Zweiha🍆 🤬`);
  }
});

client.login(DISCORD_TOKEN);
